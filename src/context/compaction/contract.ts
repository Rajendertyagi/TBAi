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
 * Read the opt-in flag from the environment.
 *
 * OFF BY DEFAULT. Compaction costs an extra model call, makes a model-generated
 * summary part of the conversation's durable record, and is not yet live-verified
 * against a real provider — so enabling it is a deliberate act, not a default.
 * Follows the existing `TBAI_CHAT_STREAM_TTL_MS` env-flag precedent
 * (`src/services/chat-streams/schema.ts`).
 *
 * Anything other than an explicit `"1"` or `"true"` is off. A missing value,
 * `"0"`, `"false"` and arbitrary text are all off, so a typo can never enable
 * compaction by accident.
 */
export const COMPACTION_ENV = "TBAI_COMPACTION_ENABLED";

/** @returns Whether automatic compaction may run. */
export function compactionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[COMPACTION_ENV];
  return raw === "1" || raw === "true";
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
  readonly measuredTotalTokens: number;
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
  reason: CompactionReason;
}): CompactionPlan {
  const { messages, policy, usableInputTokens } = input;
  if (usableInputTokens === undefined || usableInputTokens <= 0) {
    return { kind: "none", reason: "no_conversation" };
  }

  const triggerAt = Math.floor(usableInputTokens * policy.triggerFraction);
  const releaseAt = Math.floor(usableInputTokens * policy.releaseFraction);

  if (input.measuredTotalTokens < triggerAt) {
    return { kind: "none", reason: "below_trigger" };
  }

  // HYSTERESIS, stated as a durable latch rather than derived from usage.
  //
  // The latch is a flag, not a comparison. Deriving it from the CURRENT usage
  // does not work, and the first implementation of this function proved it: the
  // condition can only clear below `releaseAt`, which is also below `triggerAt`,
  // so the "below trigger" branch always won and a conversation that had ever
  // been compacted could NEVER be compacted again. It would grow to the budget
  // and be rejected while a perfectly good span sat there uncompacted.
  //
  // So the latch is set on compaction and cleared only once usage is observed to
  // fall back below the release fraction — i.e. once the previous compaction has
  // demonstrably taken effect. See `clearCompactionLatch`.
  if (input.compactionLatched ?? input.hasExistingCompaction) {
    return { kind: "none", reason: "above_release_but_within_hysteresis" };
  }

  // The span may never reach into the current turn.
  const cutIndex = latestCutIndexBefore(messages);
  if (cutIndex < 0) return { kind: "none", reason: "no_compactable_span" };

  // The tail floor is a hard floor on retained messages.
  const spanEndIndex = cutIndex;
  const spanStartIndex = Math.max(0, spanEndIndex - messages.length + 1 + policy.minRetainedTail);
  const spanLength = spanEndIndex - spanStartIndex + 1;
  if (spanLength <= 0) return { kind: "none", reason: "span_too_small_to_compact" };

  const spanTokens = sum(spanRange(input.measuredTokens, spanStartIndex, spanEndIndex));
  // Compaction must RECLAIM enough to matter. If the span is smaller than the
  // summary that would replace it, the "compaction" grows the request.
  if (spanTokens <= policy.maxSummaryTokens) {
    return { kind: "none", reason: "summary_would_not_reclaim_enough" };
  }

  // The span must fit one summariser call. Compared against measured span tokens
  // rather than char counts, so the check uses the same estimator as the budget.
  if (
    input.summarizerInputTokens !== undefined &&
    spanTokens > input.summarizerInputTokens
  ) {
    return { kind: "none", reason: "span_exceeds_summarizer_capacity" };
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
