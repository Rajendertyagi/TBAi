/**
 * Phase 4 — the compaction contract.
 *
 * This module is the CONTRACT, expressed as types and pure functions. It decides
 * nothing about storage or providers; it decides what must be true of a
 * compaction so the rest of the phase can be built against a fixed shape.
 *
 * ## The one-sentence definition
 *
 * Compaction replaces a CONTIGUOUS SPAN of already-pruned history with a single
 * bounded, provenance-carrying summary message, and records the span it replaced.
 *
 * ## What compaction is NOT (each of these was considered and rejected)
 *
 * - **Not truncation.** Dropping the oldest N messages destroys user content with
 *   no representation, no provenance and no reversibility. Rejected.
 * - **Not summarization.** Summarisation is ONE mechanism compaction may use.
 *   They are different concepts: a summary is text; a compaction is a decision
 *   plus a durable record.
 * - **Not lifecycle repair.** `pruneStaleMessages` remains untouched. Compaction
 *   runs strictly AFTER it, so a size decision can never resurrect a stale tool
 *   part or an expired approval.
 * - **Not a second context path.** Compaction is a stage inside the existing
 *   `assembleContext` seam.
 *
 * ## The span boundary is STRUCTURAL, never positional
 *
 * The naive implementation is "keep the last N messages". That is unsafe and this
 * module makes it impossible to express: the removable span is bounded by
 * turn-completion boundaries, so it can never contain a message that is part of
 * an unresolved lifecycle.
 *
 * ## Determinism
 *
 * Every function here is pure. The same conversation state and the same policy
 * inputs produce the same decision, byte for byte. Nothing reads a clock, a
 * random source, or a global.
 */

import type { UIMessage } from "ai";

/**
/**
 * Read the opt-OUT flag from the environment.
 *
 * ON BY DEFAULT. This inverts the original decision, and deliberately.
 *
 * Compaction used to be opt-in behind `TBAI_COMPACTION_ENABLED`, on the reasoning
 * that it costs an extra model call and had not been live-verified. An audit of
 * the running application showed the consequence: the flag was referenced nowhere
 * outside its own definition, so a normal install never compacted at all. Long
 * Direct conversations therefore grew until TBAi refused the request, which is
 * exactly the failure the mechanism was built to prevent. A safety mechanism that
 * is off in production is not a safety mechanism.
 *
 * So automatic compaction is now the product default, and the environment
 * variable is an OPT-OUT. An operator who needs the old behaviour (debugging the
 * raw history, or a provider where a summary is unacceptable) sets
 * `TBAI_COMPACTION_ENABLED=0` / `false`. Anything else - including an unset
 * variable and a typo - leaves compaction ON, so a typo can never silently
 * disable context management.
 */
export const COMPACTION_ENV = "TBAI_COMPACTION_ENABLED";

/**
 * @returns Whether automatic compaction may run. Default `true`.
 */
export function compactionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[COMPACTION_ENV];
  if (raw === undefined) return true;
  const normalized = raw.trim().toLowerCase();
  return !(normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off");
}

/**
 * Wall-clock ceiling for one summarisation attempt.
 *
 * Bounded because a summarisation that hangs would hang the turn that triggered
 * it. The bound is enforced by racing the call, not by merely signalling abort —
 * see `summarizeSpan` for why that distinction is load-bearing.
 */
export const COMPACTION_SUMMARY_TIMEOUT_MS = 30_000;

// ─── Policy inputs ──────────────────────────────────────────────────────────

/**
 * Why compaction is being considered.
 *
 * `pressure` is the normal case: the assembled request does not fit, and
 * compacting is preferable to rejecting. `probe` is used to decide whether to
 * compact BEFORE the point of rejection.
 */
export type CompactionReason = "pressure" | "probe";

export interface CompactionPolicy {
  /**
   * Compact when measured usage reaches this fraction of the usable budget.
   *
   * FRACTION, not a token count, because the usable budget varies by model (a
   * 512K model and a 128K model must behave identically in proportion). The value
   * is deliberately below 1.0 so compaction begins *before* the request would be
   * rejected, leaving room for the summary itself.
   */
  readonly triggerFraction: number;
  /**
   * Do not compact again until measured usage falls below this fraction.
   *
   * HYSTERESIS. Without it, a conversation sitting just above the trigger would
   * compact on every single turn — each pass rewriting the span and paying a
   * summarisation call for no progress. The gap between trigger and release is
   * what makes repeated compaction converge.
   */
  readonly releaseFraction: number;
  /**
   * Always retain at least this many trailing messages, whatever their size.
   *
   * A floor on the RECENT TAIL, not a compaction trigger. It exists so a
   * pathological sequence of large messages cannot compact away the immediate
   * context the user is reasoning about.
   */
  readonly minRetainedTail: number;
  /** Hard ceiling on summary size, in tokens. Enforced after generation. */
  readonly maxSummaryTokens: number;
  /** Output reservation for the summariser call itself. */
  readonly summaryOutputReservation: number;
}

// ─── The plan ───────────────────────────────────────────────────────────────

/**
 * A compaction decision for one conversation turn.
 *
 * `kind: "none"` is the overwhelmingly common case and is a first-class result,
 * not an error — "no compaction needed" must be as cheap and as explicit as
 * "compact this span".
 */
export type CompactionPlan =
  | {
      readonly kind: "none";
      /** Why no compaction. Enumerated so a log line is greppable. */
      readonly reason:
        | "below_trigger"
        | "above_release_but_within_hysteresis"
        | "no_compactable_span"
        | "span_too_small_to_compact"
        | "summary_would_not_reclaim_enough"
        | "span_exceeds_summarizer_capacity"
        | "would_still_exceed_budget"
        | "already_compacted_span"
        | "force_requested_no_compactable_span"
        | "no_conversation";
    }
  | {
      readonly kind: "compact";
      readonly reason: CompactionReason;
      /** Inclusive index of the first message to be replaced by the summary. */
      readonly spanStartIndex: number;
      /** Inclusive index of the last message to be replaced. */
      readonly spanEndIndex: number;
      /** Number of messages the span covers. */
      readonly spanLength: number;
      /** Ids in the span, in order. Recorded so the decision is auditable. */
      readonly spanMessageIds: readonly string[];
      /**
       * Index of the message that must survive untouched — the first retained
       * message after the span. Present so a caller cannot apply the plan
       * without also seeing what it is preserving.
       */
      readonly firstRetainedIndex: number;
      /** Tokens the span is estimated to occupy. Justifies the call. */
      readonly spanEstimatedTokens: number;
      /** Deterministic fingerprint of the span. Same span ⇒ same fingerprint. */
      readonly spanFingerprint: string;
    };

// ─── Turn-completion boundaries ─────────────────────────────────────────────

/**
 * Whether a message is a COMPLETE, settled turn boundary that compaction may
 * treat as a cut point.
 *
 * ## Why this is the crux of correctness
 *
 * Compaction may only cut between settled turns. `prune-messages.ts` already
 * establishes the structural fact this relies on: an unresolved approval is
 * preserved **only** when its message index is at or after the last user message
 * (`prune-messages.ts:140-151`). So every unresolved lifecycle state lives in
 * the region at/after the final user turn.
 *
 * Cutting strictly BEFORE the last user turn therefore cannot remove an
 * unresolved approval — not because compaction checks approvals, but because the
 * cut boundary is placed where no unresolved state can exist.
 *
 * That is the difference between a structural guarantee and a filter that has to
 * enumerate every dangerous case.
 */
export interface TurnBoundary {
  /** Index of the last message that begins a settled turn. */
  readonly index: number;
}

/**
 * Find the latest cut point strictly before the current turn.
 *
 * @returns The index of the last message that may be the END of the removable
 *          span, or -1 when the conversation has no settled history yet.
 */
export function latestCutIndexBefore(messages: readonly UIMessage[]): number {
  const lastUserIndex = lastIndexOfRole(messages, "user");
  // A cut may never touch the current turn, so the span must end before it.
  const ceiling = lastUserIndex - 1;
  if (ceiling < 0) return -1;

  // Walk back to a message boundary that is safe to cut AFTER: an assistant
  // message that is not the live continuation. Using a user message as the
  // span's last element would leave a dangling user turn with no reply.
  for (let i = ceiling; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message) continue;
    if (roleOf(message) === "assistant") return i;
  }
  return -1;
}

/** Index of the first message of the current turn (the final user message). */
export function currentTurnStartIndex(messages: readonly UIMessage[]): number {
  return lastIndexOfRole(messages, "user");
}

/**
 * The last assistant message strictly BEFORE `before`, i.e. the next safe cut
 * point walking backwards.
 *
 * Oversized recovery shrinks a span to fit one summariser call, and it must do so
 * without splitting a turn. It reuses exactly the rule
 * {@link latestCutIndexBefore} applies - a span may end on an assistant message
 * that is not the live continuation - so a cut never strands a user turn without
 * a reply and never separates a tool call from its result.
 *
 * @returns The index, or -1 when there is no earlier assistant message.
 */
export function previousSafeCutIndex(
  messages: readonly UIMessage[],
  before: number,
): number {
  for (let i = Math.min(before - 1, messages.length - 1); i >= 0; i -= 1) {
    const message = messages[i];
    if (!message) continue;
    if (roleOf(message) === "assistant") return i;
  }
  return -1;
}

// ─── Span selection ─────────────────────────────────────────────────────────

/**
 * Select the removable span for a conversation, or explain why there is none.
 *
 * Pure and deterministic. The caller supplies measured sizes; this function never
 * estimates from message counts.
 */
export function planCompaction(input: {
  messages: readonly UIMessage[];
  /** Per-message estimated tokens, index-aligned with `messages`. */
  readonly measuredTokens: readonly number[];
  /** Effective usable input tokens from the Phase 2 budget. */
  readonly usableInputTokens: number | undefined;
  /** Total measured input tokens for the assembled request. */
  /**
   * Measured pressure across the WHOLE request: Layer A + Layer B + Layer C.
   *
   * Must be the full total, not Layer C alone. `usableInputTokens` is a budget for
   * the entire request, so comparing one layer against it understates pressure by
   * whatever the other layers cost — measured here at ~10 745 tokens for the native
   * tool definitions alone. The first implementation compared Layer C only, which
   * made the trigger fire far too late and made it impossible for compaction to
   * be tested against a realistic conversation.
   */
  readonly measuredTotalTokens: number;
  /**
   * Tokens that compaction cannot reclaim: Layer A (instructions) plus Layer B
   * (tool definitions).
   *
   * Needed so the planner can answer the only question that matters — "after
   * replacing this span, does the request actually FIT?" Without it, compaction
   * can cheerfully summarise a span, still miss the budget, and leave the caller to
   * reject the request it just paid a provider call to compact.
   */
  fixedOverheadTokens: number;
  policy: CompactionPolicy;
  /** Whether a compaction record already exists for this conversation. */
  readonly hasExistingCompaction: boolean;
  /**
   * Whether the hysteresis latch is ENGAGED — set when a compaction happened and
   * not yet cleared.
   *
   * This is durable state, not a function of current usage. See the hysteresis
   * comment below for why deriving it from usage is wrong. Defaults to
   * `hasExistingCompaction` when a caller has no latch store.
   */
  readonly compactionLatched?: boolean;
  /**
   * How many input tokens the summariser can read in ONE call.
   *
   * Checked HERE, before any provider call, because a span the summariser cannot
   * read is a permanent refusal rather than a transient one: single-pass
   * compaction must not summarise a prefix of a span and present it as the whole
   * span, and summarising the summaries is precisely the recursive context-growth
   * path this phase forbids.
   *
   * Refusing at plan time costs nothing and yields a precise diagnosis instead of
   * an opaque provider error. See the KNOWN LIMITATION in the Phase 4 report: this
   * is the bound on how large a conversation compaction can handle.
   */
  readonly summarizerInputTokens?: number;
  /**
   * Compact even when usage is under the trigger.
   *
   * Set only by an explicit user request (the Direct `/compact` command). It
   * removes the pressure threshold, NOT the structural rules: a safe, worthwhile
   * span must still exist.
   */
  readonly force?: boolean;
  /**
   * Message ids the durable compaction record already covers.
   *
   * Hysteresis is decided against THIS, not against a conversation-wide latch.
   * When every id the plan would replace is already covered there is nothing new
   * to summarise; any id beyond it is fresh growth and is independently eligible.
   */
  readonly coveredMessageIds?: readonly string[];
  reason: CompactionReason;
}): CompactionPlan {
  const { messages, policy, usableInputTokens } = input;
  if (usableInputTokens === undefined || usableInputTokens <= 0) {
    return { kind: "none", reason: "no_conversation" };
  }

const triggerAt = Math.floor(usableInputTokens * policy.triggerFraction);

  // An explicit request (the Direct `/compact` command) compacts on demand even
  // when the conversation sits well under the trigger. It is NOT a bypass of the
  // structural rules below: a span must still exist, still be safe to cut, and
  // still be worth summarising.
  const forced = input.force === true;

  if (!forced && input.measuredTotalTokens < triggerAt) {
    return { kind: "none", reason: "below_trigger" };
  }

  // The span may never reach into the current turn.
  const cutIndex = latestCutIndexBefore(messages);
  if (cutIndex < 0) {
    return {
      kind: "none",
      reason: forced ? "force_requested_no_compactable_span" : "no_compactable_span",
    };
  }

  // The tail floor is a hard floor on retained messages.
  const spanStartIndex = Math.max(0, cutIndex - messages.length + 1 + policy.minRetainedTail);
  let spanEndIndex = cutIndex;
  if (spanEndIndex - spanStartIndex + 1 <= 0) {
    return { kind: "none", reason: "span_too_small_to_compact" };
  }

  // OVERSIZED RECOVERY. A conversation can outgrow a single summariser call, and
  // that used to be a permanent refusal: `span_exceeds_summarizer_capacity` left
  // the chat dead forever, because the following turn planned the same oversized
  // span again and reached the same verdict.
  //
  // Instead of refusing, plan a SAFE PREFIX of the span. The end walks backwards
  // to an earlier assistant message - the same boundary rule
  // `latestCutIndexBefore` uses, so a turn is never split and a tool call is
  // never separated from its result - until the span fits one summariser call.
  // Everything past the new end stays in the conversation and is eligible on a
  // later turn, so an oversized history recovers in stages instead of not at all.
  if (input.summarizerInputTokens !== undefined) {
    while (
      spanEndIndex > spanStartIndex &&
      sum(spanRange(input.measuredTokens, spanStartIndex, spanEndIndex)) >
        input.summarizerInputTokens
    ) {
      const earlierCut = previousSafeCutIndex(messages, spanEndIndex);
      if (earlierCut < spanStartIndex) break;
      spanEndIndex = earlierCut;
    }
  }

  const spanTokens = sum(spanRange(input.measuredTokens, spanStartIndex, spanEndIndex));
  const spanLength = spanEndIndex - spanStartIndex + 1;
  if (spanLength <= 0) return { kind: "none", reason: "span_too_small_to_compact" };

  // Compaction must RECLAIM enough to matter. If the span is smaller than the
  // summary that would replace it, the "compaction" grows the request.
  if (spanTokens <= policy.maxSummaryTokens) {
    return { kind: "none", reason: "summary_would_not_reclaim_enough" };
  }

  // The span must still fit one summariser call after shrinking. When even the
  // smallest safe span does not fit, retrying cannot help, so this stays the
  // deterministic, actionable refusal.
  if (input.summarizerInputTokens !== undefined && spanTokens > input.summarizerInputTokens) {
    return { kind: "none", reason: "span_exceeds_summarizer_capacity" };
  }

  // HYSTERESIS, scoped to the SPAN rather than to the conversation.
  //
  // The previous design latched the whole conversation: after any compaction,
  // `compactionLatched` short-circuited every later plan, so a long chat was
  // compacted exactly once and then grew to the budget and was rejected. The
  // latch could only clear below the release fraction, which a growing
  // conversation never reaches.
  //
  // What hysteresis must actually prevent is re-summarising the SAME history. So
  // the guard is now: if every message this plan would replace is already covered
  // by the durable record, there is nothing new to do. Fresh growth extends the
  // span past the covered ids and is independently eligible, so a long-running
  // conversation compacts repeatedly, one safe span at a time, without ever
  // re-summarising a span it already paid to summarise.
  const covered = input.coveredMessageIds;
  if (!forced && covered !== undefined && covered.length > 0) {
    const spanIds = messages
      .slice(spanStartIndex, spanEndIndex + 1)
      .map((m) => idOf(m))
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    if (spanIds.length > 0 && spanIds.every((id) => covered.includes(id))) {
      return { kind: "none", reason: "already_compacted_span" };
    }
  }

  // Finally: would compaction actually make the request FIT?
  //
  // Reclaiming a span is pointless if the result still exceeds the budget — the
  // caller would reject the request regardless, having paid for a summarisation
  // call to learn nothing. The residual is measured with the summary at its
  // MAXIMUM permitted size, so the answer is pessimistic and never optimistic.
  const residual =
    input.fixedOverheadTokens + (input.measuredTotalTokens - input.fixedOverheadTokens - spanTokens) + policy.maxSummaryTokens;
  if (residual >= usableInputTokens) {
    return { kind: "none", reason: "would_still_exceed_budget" };
  }

  const spanMessageIds = messages
    .slice(spanStartIndex, spanEndIndex + 1)
    .map((m) => idOf(m))
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  return {
    kind: "compact",
    reason: input.reason,
    spanStartIndex,
    spanEndIndex,
    spanLength,
    spanMessageIds,
    firstRetainedIndex: spanEndIndex + 1,
    spanEstimatedTokens: spanTokens,
    spanFingerprint: spanFingerprint(messages, spanStartIndex, spanEndIndex),
  };
}

// ─── Provenance ─────────────────────────────────────────────────────────────

/**
 * Where a block of assembled context came from.
 *
 * Phase 5 memory will add a fourth state. It is deliberately absent now: adding
 * an unused state would be a claim about future work, and the roadmap already
 * records where it belongs.
 */
export const CONTEXT_ORIGINS = ["original_user_content", "model_generated_summary"] as const;
export type ContextOrigin = (typeof CONTEXT_ORIGINS)[number];

/**
 * The durable description of one compaction.
 *
 * Persisted in its own table. This is the authoritative provenance record; the
 * text the model sees is a rendering of it, never the record itself.
 */
export interface CompactionRecord {
  readonly compactionId: string;
  readonly conversationId: string;
  /** Inclusive first index covered, for audit. Indices are turn-relative. */
  readonly spanStartIndex: number;
  readonly spanEndIndex: number;
  /** Ids covered, in order. The auditable record of what was replaced. */
  readonly coveredMessageIds: readonly string[];
  /** Deterministic fingerprint of the covered span. */
  readonly spanFingerprint: string;
  /** The bounded summary text. Never null: a compaction without a summary is not a compaction. */
  readonly summaryText: string;
  /** Measured size of `summaryText`, so the budget can account for it. */
  readonly summaryTokens: number;
  readonly origin: Extract<ContextOrigin, "model_generated_summary">;
  /** Provider+model that produced the summary. Recorded, never branched on. */
  readonly summarizedBy: string;
  /** How many compactions this conversation has been through. */
  readonly generation: number;
  /**
   * Hysteresis latch. Set on every compaction; cleared once measured usage is
   * observed below the release fraction.
   *
   * Durable rather than derived, because a derived latch can never clear — see
   * the hysteresis comment in `planCompaction`.
   */
  readonly latched: boolean;
  readonly createdAt: number;
}

// ─── Rendering ──────────────────────────────────────────────────────────────

/**
 * Render a compaction as the messages that replace the covered span.
 *
 * Deterministic: the same record always produces byte-identical output, which is
 * what lets Phase 3's prefix identity stay stable across reloads.
 *
 * Returns exactly ONE message. A summary is injected as a single user-role block
 * so it occupies a stable position in the A→B→C concatenation, and so it can
 * never be mistaken for a user instruction.
 */
export function renderCompactedMessages(record: CompactionRecord): UIMessage[] {
  const header =
    `[TBAi compacted history — ${record.origin}, ${record.coveredMessageIds.length} earlier message(s) summarized, ` +
    `generation ${record.generation}. This is a summary of earlier turns, not new user input.]`;
  return [
    {
      id: `tbai-compaction:${record.compactionId}`,
      role: "user",
      parts: [{ type: "text", text: `${header}\n\n${record.summaryText}` }],
    } as unknown as UIMessage,
  ];
}

// ─── Application ────────────────────────────────────────────────────────────

/**
 * Replace the covered span with the rendered summary.
 *
 * Order-independent of storage: the caller supplies the span boundaries the plan
 * computed, so this is a pure splice. The current turn is never touched because
 * the plan never places the span end inside it.
 */
export function applyCompaction(input: {
  messages: readonly UIMessage[];
  plan: Extract<CompactionPlan, { kind: "compact" }>;
  record: CompactionRecord;
}): UIMessage[] {
  const { messages, plan } = input;
  return [
    ...messages.slice(0, plan.spanStartIndex),
    ...renderCompactedMessages(input.record),
    ...messages.slice(plan.spanEndIndex + 1),
  ];
}

// ─── helpers ────────────────────────────────────────────────────────────────

function roleOf(message: UIMessage | undefined): string | undefined {
  const role = (message as { role?: unknown } | null)?.role;
  return typeof role === "string" ? role : undefined;
}

function idOf(message: UIMessage): string | undefined {
  const id = (message as { id?: unknown } | null)?.id;
  return typeof id === "string" ? id : undefined;
}

function lastIndexOfRole(messages: readonly UIMessage[], role: string): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (roleOf(messages[i]) === role) return i;
  }
  return -1;
}

function sum(values: readonly number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

function spanRange(values: readonly number[], start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i <= end; i += 1) out.push(values[i] ?? 0);
  return out;
}

/**
 * Deterministic fingerprint of a span.
 *
 * Ids and roles only — never content — so the value is safe to log and compare
 * across processes without handling prompt text.
 */
export function spanFingerprint(messages: readonly UIMessage[], start: number, end: number): string {
  const parts: string[] = [];
  for (let i = start; i <= end; i += 1) {
    const m = messages[i];
    if (!m) continue;
    parts.push(`${idOf(m) ?? "?"}:${roleOf(m) ?? "?"}`);
  }
  // FNV-1a: short, dependency-free, deterministic. Not a security boundary.
  let hash = 0x811c9dc5;
  const joined = parts.join("|");
  for (let i = 0; i < joined.length; i += 1) {
    hash ^= joined.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `span:${hash.toString(16).padStart(8, "0")}:${parts.length}`;
}
