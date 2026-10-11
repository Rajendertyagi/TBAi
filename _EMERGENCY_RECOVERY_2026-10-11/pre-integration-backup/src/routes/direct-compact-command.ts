/**
 * Manual `/compact` for the Direct route: detection, command lifecycle, the forced
 * compaction call, and the three-valued outcome.
 *
 * ## One context path, not two
 *
 * The only assembly this module performs is `assembleContext` with
 * `forceCompaction: true` — the same seam, and the same flag, that
 * provider-overflow recovery uses (see `direct-overflow-gate.ts`). There is no
 * compaction engine here, no second summariser, and no independent "did it
 * shrink?" judgement.
 *
 * ## Why this does not reuse the route's `assembleForRequest`
 *
 * `assembleForRequest` closes over the record returned by `chatRuns.create`: it
 * passes `run.streamId` as the assembly `runId` and `run.controller.signal` as the
 * tool and compaction signal, and it assigns the route's `tools`, `toolsContext`,
 * `modelMessages` and cache bindings. It is run-scoped BY CONSTRUCTION. Calling it
 * for a command that must not create a run would either force the run into
 * existence — leaking a record that nothing ever settles, because no stream is
 * produced to settle it — or require a second assembly wrapper. The seam it wraps
 * is `assembleContext`; this module calls that seam directly with the identical
 * compaction input, so the Direct engine still has exactly one context path.
 *
 * ## Why the command owns no durable run row
 *
 * A chat run exists to own a streaming response's lifetime and its settlement in
 * `chat_runs` + `chat_streams`. A compaction command produces neither: it emits no
 * message parts and must not persist a conversational row. Its durable artefact is
 * the compaction checkpoint the seam writes, and its terminal state is the returned
 * outcome. So it creates NO `chatRuns` record at all. Placing the intercept above
 * `chatRuns.create` is what makes that true; placing it below would be the bug.
 *
 * Cancellation is not lost by this. The command's own controller follows the HTTP
 * request signal, so an abort during summarisation is observed through the seam's
 * `signal` and reported as a terminal `failed` outcome rather than as a silent
 * success or a hung request.
 *
 * ## Why success is `compactionApplied`, never a proxy
 *
 * A summariser call that ran, an assembly that did not throw, and a checkpoint that
 * may or may not have been written are all compatible with "nothing was compacted".
 * Only `assembled.diagnostics.compactionApplied === true` — the same authoritative
 * condition provider-overflow recovery is gated on — is accepted as proof. Every
 * other outcome is reported honestly as `skipped` or `failed`.
 */

import type { UIMessage } from "ai";
import { generateId } from "../lib/utils";
import { logger } from "../lib/logger";
import { errorLogFields } from "../lib/errors";
import { compactionStore } from "../services/compaction";
import { messageService } from "../services/storage";
import { assembleContext } from "../context/assemble";
import {
  COMPACTION_SUMMARY_TIMEOUT_MS,
  DEFAULT_COMPACTION_POLICY,
  compactionEnabled,
  describeCompactionOutcome,
} from "../context/compaction";
import type { AssembleContextInput, MechanismOutcome } from "../context/types";

/**
 * The canonical command string this route intercepts.
 *
 * It is the spelling used in the request body the client builds and in logs, so
 * the answer to "what was typed" stays stable even if more spellings are accepted.
 */
export const COMPACT_COMMAND = "/compact";

/**
 * Accepted spellings of the same command.
 *
 * Deliberately a closed list, not a general slash-command table. Every unlisted
 * string — `/compact now`, `explain /compact` — is ordinary user text and must
 * reach the model untouched. Each alias is a whole-token alternative, so no alias
 * can swallow trailing words.
 */
export const COMPACT_COMMAND_ALIASES: readonly string[] = ["/compress"];

/** Every accepted spelling, canonical first. The single source of truth for matching. */
export const COMPACT_COMMANDS: readonly string[] = [
  COMPACT_COMMAND,
  ...COMPACT_COMMAND_ALIASES,
];

/**
 * A parsed `/compact` invocation.
 *
 * `instructions` is everything after the command word, or `undefined` when the user
 * typed none. Kept as its own field rather than a boolean so "compact with these
 * words" and "compact plainly" cannot be confused — the second must stay the
 * byte-identical behaviour it was before instructions existed.
 */
export interface CompactCommandMatch {
  /** The spelling the user actually typed, for logs and provenance. */
  readonly command: string;
  readonly instructions: string | undefined;
}

/**
 * Parse composer text as a compaction command, or return `undefined`.
 *
 * ## Why trailing words are instructions and not a different command
 *
 * `/compact keep the API decisions` is one command with a narrowing instruction, the
 * same grammar ZCode documents (`/compact [instructions]`). Matching the command
 * word as a whole token — never as a string prefix — is what keeps `/compactx` and
 * `/compressed` ordinary user text while letting `/compact now` compact.
 *
 * The whole-token rule is why the previous "exact match only" behaviour is gone:
 * `now` used to mean "this is not a command". It means an instruction, and the
 * instruction is the user's to give.
 */
export function parseCompactCommand(text: string): CompactCommandMatch | undefined {
  const trimmed = text.trim();
  const [head, ...rest] = trimmed.split(/\s+/);
  if (head === undefined || !COMPACT_COMMANDS.includes(head)) return undefined;
  const instructions = rest.join(" ").trim();
  return { command: head, instructions: instructions.length > 0 ? instructions : undefined };
}

/** Whether one already-trimmed token sequence is a compaction command. */
export function isCompactCommandText(text: string): boolean {
  return parseCompactCommand(text) !== undefined;
}

/**
 * What the command did.
 *
 * Three values, not a boolean, because "nothing was eligible" and "compaction
 * tried and broke" demand different user responses and different logs. `skipped`
 * is not a soft `true`: it means no checkpoint was fabricated.
 */
export type ManualCompactOutcome = "compacted" | "skipped" | "failed";

/**
 * The status payload delivered to the UI.
 *
 * Carries the summary text, which is conversation content by definition. That is a
 * deliberate reversal of an earlier "contains no message text" rule: the payload
 * exists so the user can read what compaction kept, and a summary that cannot be
 * read makes a destructive operation unauditable.
 *
 * The bound is that this is the ONLY place compaction content is allowed to leave
 * the server, and it is never logged — see `publishCompactionDivider`, whose log
 * fields carry counts only.
 */
export interface ManualCompactData {
  readonly kind: "tbai-compact";
  readonly version: 1;
  readonly outcome: ManualCompactOutcome;
  /** Raw compaction reason; never replaced by the outcome label. */
  readonly reason: string;
  readonly generation: number;
  readonly spanLength: number;
  readonly summaryTokens: number;
  /**
   * What compaction kept, or null when nothing was kept.
   *
   * Non-null only for a `compacted` outcome. A `skipped` or `failed` compaction
   * replaced nothing, so there is no summary to show and the divider must not
   * imply one exists.
   */
  readonly summary: string | null;
  readonly reclaimedTokens: number;
  /** Whether the assembled request fits after compaction. */
  readonly requestFits: boolean;
  readonly operationId: string;
  /**
   * The transcript row this compaction left behind, or `null` when it could not be
   * written. Carried so the client can tell "the divider is durable" from "the
   * divider is only on screen" — the compaction itself already happened either way.
   */
  readonly anchorMessageId: string | null;
  /**
   * What compaction this was.
   *
   * - `manual` — the user ran `/compact` and could read the result.
   * - `automatic` — the engine crossed its trigger while assembling an ordinary turn.
   * - `recovery` — the provider rejected the request and overflow recovery forced a
   *   rebuild; the conversation was shortened without the user asking.
   *
   * All three are the SAME durable compaction and the SAME divider. The origin is what
   * lets the transcript say *why* the context was compacted, instead of leaving three
   * identical dividers that look like the user pressed a button three times.
   */
  readonly origin: CompactionOrigin;
  readonly instructions?: string;
}

/** Which trigger produced a compaction. One vocabulary for every producer. */
export type CompactionOrigin = "manual" | "automatic" | "recovery";

/**
 * The wire part type the transcript divider is stored as.
 *
 * The AI SDK's on-the-wire form, matching every other stored row: `data-tbai-*`
 * rather than assistant-ui's internal `{ type: "data", name }`.
 */
export const COMPACT_DIVIDER_PART_TYPE = "data-tbai-compact";

/** The storage format every assistant-ui row in this database uses. */
const DIVIDER_STORAGE_FORMAT = "ai-sdk/v6";

/**
 * The stored row's `content`: exactly the envelope the runtime's own transport
 * writes, so the loader replays it like any other message.
 *
 * Exported for tests because this shape IS the feature: the divider is reload-
 * durable only if the stored payload matches what the thread loader expects, and
 * that cannot be asserted from the renderer.
 */
export function buildDividerStoredContent(
  id: string,
  data: ManualCompactData,
): Record<string, unknown> {
  return {
    role: "assistant",
    parts: [
      {
        type: COMPACT_DIVIDER_PART_TYPE,
        id,
        data: {
          kind: data.kind,
          version: data.version,
          outcome: data.outcome,
          reason: data.reason,
          spanLength: data.spanLength,
          generation: data.generation,
          operationId: data.operationId,
          origin: data.origin,
          // The summary is stored WITH the divider, not looked up on click.
          //
          // `conversation_compactions` is a single rolling row keyed by
          // `conversation_id`, so it only ever holds the LATEST summary. An older
          // divider that fetched on click would display the newest summary against
          // older history. Embedding at write time makes each divider carry its own,
          // which is correct by construction and needs no second read path.
          //
          // OMITTED when null rather than stored as `null`, so a payload with no
          // summary is byte-identical to what the pre-summary build wrote and old
          // rows stay readable.
          ...(data.summary ? { summary: data.summary } : {}),
          // OMITTED when absent rather than stored as `undefined`: the field is the
          // record of something the user typed, so a compaction with no
          // instructions has no such record.
          ...(data.instructions ? { instructions: data.instructions } : {}),
        },
      },
    ],
    metadata: { custom: {} },
  };
}

/**
 * Build the divider payload for a compaction the ENGINE decided on, not the user.
 *
 * Same shape, same part, same row — the one difference is `origin`, so the
 * transcript can distinguish "I asked for this" from "the context filled up and the
 * engine compacted on its own". Automatic and manual compaction are the same
 * mechanism; only the trigger and this label differ.
 */
export function buildAutomaticDividerData(
  provenance: NonNullable<ManualCompactData> & { readonly reason: string },
): ManualCompactData {
  return {
    kind: "tbai-compact",
    version: 1,
    outcome: provenance.outcome,
    reason: provenance.reason,
    generation: provenance.generation,
    spanLength: provenance.spanLength,
    summaryTokens: provenance.summaryTokens,
    // An engine-triggered compaction is auditable on exactly the same terms as a
    // manual one. If the user cannot read what the engine removed, they cannot
    // consent to it.
    summary: provenance.summary,
    reclaimedTokens: provenance.reclaimedTokens,
    requestFits: provenance.requestFits,
    operationId: provenance.operationId,
    anchorMessageId: null,
    origin: "automatic",
  };
}

/**
 * Write the divider the conversation will show after a reload.
 *
 * ## Why the SERVER writes this row
 *
 * `thread().append()` is not a persistence path in this runtime: `adapters.history`
 * is not configured, so the library only persists messages the transport streams
 * (its `onNew` / `onUpdate` hooks). Measured, not assumed — an appended message
 * rendered in the thread and left no row in SQLite, and vanished on reload.
 *
 * So the durable artefact is written here, through the same `messageService` the
 * scheduler and the detached-run finalizer use. SQLite stays the single source of
 * truth, and the client renders the returned `anchorMessageId` optimistically
 * rather than owning a second store.
 *
 * ## Why one row, anchored to the thread tip
 *
 * The divider is appended after the last settled message, so it occupies the tail
 * of the transcript. `parent_id` is the tip, which is what makes the thread a
 * linear chain the loader can replay.
 *
 * Returns the new row's id, or `null` when the write failed: a persistence fault
 * must not turn a compaction that DID happen into a reported failure, and must not
 * be silently swallowed either.
 */
/**
 * Write the divider row, for manual AND automatic compaction alike.
 *
 * Exported so `chat.ts` records an automatic compaction through this exact
 * function: one writer, one payload, one part type. A second writer for the
 * automatic path is exactly the duplicate persistence mechanism this design
 * exists to avoid.
 */
export async function persistCompactionDivider(
  conversationId: string,
  data: ManualCompactData,
  log: ReturnType<typeof logger.child>,
): Promise<string | null> {
  const id = `${COMPACT_DIVIDER_PART_TYPE}-${data.operationId}`;
  try {
    const tip = await messageService.getThreadTip(conversationId);
    await messageService.upsertStored(conversationId, {
      id,
      parent_id: tip,
      format: DIVIDER_STORAGE_FORMAT,
      content: buildDividerStoredContent(id, data),
    });
    return id;
  } catch (err) {
    log.error("chat", "chat_compact_divider_persist_failed", {
      operationId: data.operationId,
      ...errorLogFields(err),
    });
    return null;
  }
}

/** Server-side result of a manual compaction, including non-wire diagnostics. */
export interface ManualCompactResult extends ManualCompactData {
  /** The existing budget-gate vocabulary for the same fact, not a second one. */
  readonly mechanism: MechanismOutcome;
}

type AssemblerProvider = AssembleContextInput["provider"];
type AssemblerCompaction = NonNullable<AssembleContextInput["compaction"]>;
type SummarizerModel = AssemblerCompaction["summarizerModel"];

/** Neutral fields for a result that never reached the compaction seam. */
function unattemptedResult(
  operationId: string,
  reason: string,
): ManualCompactResult {
  return {
    kind: "tbai-compact",
    version: 1,
    outcome: "skipped",
    reason,
    mechanism: describeUnattempted(reason),
    generation: 0,
    spanLength: 0,
    summaryTokens: 0,
    // A refusal replaced nothing, so there is nothing to show. Not an empty string:
    // "no summary" must be distinguishable from "a summary that happens to be blank".
    summary: null,
    reclaimedTokens: 0,
    requestFits: true,
    operationId,
    anchorMessageId: null,
    origin: "manual" as const,
  };
}

/**
 * The mechanism vocabulary for a request that never offered compaction.
 *
 * `describeCompactionOutcome` is the owner of that vocabulary, but it takes a
 * `CompactionReport`. Reconstructing a whole report to describe a request that
 * produced none would fabricate the very fields the caller must not invent, so the
 * two documented pre-seam refusals are named here against the same closed set.
 */
function describeUnattempted(reason: string): MechanismOutcome {
  return reason === "no_conversation"
    ? { kind: "withheld", reason: "not_eligible" }
    : { kind: "exhausted", reason: "disabled" };
}

/** Text content of one UI message, ignoring non-text parts. */
function textOf(message: UIMessage): string {
  return message.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/**
 * Whether this request is a manual compaction command.
 *
 * The LAST user message must parse as one of `COMPACT_COMMANDS` (optionally
 * followed by instructions), so surrounding whitespace is tolerated and a longer
 * slash-word is not. Assistant and system messages are skipped rather than
 * matched, so a `/compact` quoted inside the transcript can never trigger the
 * command. Returns `undefined` when there is no user message at all.
 */
export function detectCompactCommand(
  messages: readonly UIMessage[],
): CompactCommandMatch | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    return parseCompactCommand(textOf(message));
  }
  return undefined;
}

/** The command's own cancellable lifetime, independent of any chat run. */
export interface ManualCompactCommand {
  readonly operationId: string;
  readonly controller: AbortController;
}

/**
 * Open a compaction command that follows the HTTP request's lifetime.
 *
 * No `chatRuns` record is created: the command settles through its returned
 * outcome, and creating a run here would leave a row nothing settles. The
 * operation id doubles as the assembly `runId`, which `assembleContext` requires
 * for its run-scoped tool closures and never reads.
 */
export function beginCompactCommand(requestSignal: AbortSignal): ManualCompactCommand {
  const controller = new AbortController();
  const cancel = (): void => {
    if (!controller.signal.aborted) controller.abort();
  };
  if (requestSignal.aborted) cancel();
  else requestSignal.addEventListener("abort", cancel, { once: true });
  return { operationId: generateId(), controller };
}

export interface ManualCompactInput {
  readonly operationId: string;
  readonly requestId: string;
  readonly conversationId: string | undefined;
  readonly submittedMessages: UIMessage[];
  readonly provider: AssemblerProvider;
  readonly modelId: string;
  readonly systemPrompt: string | undefined;
  readonly summarizerModel: SummarizerModel;
  /**
   * The user's narrowing words, from `/compact <instructions>`.
   *
   * `undefined` when the user typed none, which leaves the summariser prompt
   * byte-identical to the behaviour from before instructions existed.
   */
  readonly instructions: string | undefined;
  readonly signal: AbortSignal;
}

/**
 * Force one compaction for a conversation and report what actually happened.
 *
 * Never throws: this command has exactly one exit, because a thrown error is a
 * transport fault rather than a compaction outcome and the caller has no status to
 * render for it. Assembly, summariser and persistence faults are all reported as
 * `failed` with the underlying reason preserved in the log.
 */
export async function runManualCompaction(
  input: ManualCompactInput,
): Promise<ManualCompactResult> {
  const log = logger.child({
    requestId: input.requestId,
    conversationId: input.conversationId,
    provider: input.provider.type,
    model: input.modelId,
    operation: "compact_command",
  });

  // The same two preconditions the ordinary turn applies. Both are honest
  // `skipped`s: compaction was never offered, so no checkpoint can exist.
  if (!input.conversationId) {
    return unattemptedResult(input.operationId, "no_conversation");
  }
  if (!compactionEnabled()) {
    return unattemptedResult(input.operationId, "not_attempted");
  }

  const startedAt = Date.now();
  try {
    const assembled = await assembleContext({
      forceCompaction: true,
      conversationId: input.conversationId,
      submittedMessages: input.submittedMessages,
      runId: input.operationId,
      provider: input.provider,
      modelId: input.modelId,
      systemPrompt: input.systemPrompt,
      toolSignal: input.signal,
      compaction: {
        policy: DEFAULT_COMPACTION_POLICY,
        existingRecord: compactionStore.get(input.conversationId),
        persist: (record) => compactionStore.record(record),
        releaseLatch: () => compactionStore.releaseLatch(input.conversationId),
        // The SAME model the next turn will read the summary with. Summarising
        // with a different model would make the summary a translation rather than
        // a record of this conversation.
        summarizerModel: input.summarizerModel,
        summarizedBy: `${input.provider.type}/${input.modelId}`,
        // The user's own narrowing words, when they typed any. `undefined` leaves
        // the summariser prompt byte-identical to the pre-instructions behaviour.
        instructions: input.instructions,
        nextCompactionId: (generation) => `${generateId()}_${generation}`,
        now: () => Date.now(),
        signal: input.signal,
        timeoutMs: COMPACTION_SUMMARY_TIMEOUT_MS,
      },
    });

    // `diagnostics.compactionApplied` is the authoritative success condition and
    // the one recovery is gated on. A missing report therefore cannot read as
    // success: it is reported as an error rather than as "nothing to do".
    const report = assembled.context.provenance.compaction;
    if (report === undefined) {
      log.error("chat", "chat_compact_failed", {
        operationId: input.operationId,
        reason: "compaction_report_missing",
        durationMs: Date.now() - startedAt,
      });
      return {
        kind: "tbai-compact",
        version: 1,
        outcome: "failed",
        reason: "compaction_error",
        mechanism: { kind: "withheld", reason: "failed" },
        generation: 0,
        spanLength: 0,
        summaryTokens: 0,
        summary: null,
        reclaimedTokens: 0,
        requestFits: assembled.decision.action !== "reject",
        operationId: input.operationId,
        anchorMessageId: null,
        origin: "manual" as const,
      };
    }

    const applied = assembled.diagnostics.compactionApplied === true;
    const mechanism = describeCompactionOutcome(report);
    // `failed` is the only mechanism reason that means a helpful mechanism broke.
    // Everything else — nothing eligible, no conversation, capacity ceilings,
    // hysteresis, an unrecognised reason — is a genuine `skipped`, never a
    // fabricated success.
    const outcome: ManualCompactOutcome = applied
      ? "compacted"
      : mechanism.reason === "failed"
        ? "failed"
        : "skipped";

    const data: ManualCompactData = {
      kind: "tbai-compact",
      version: 1,
      outcome,
      reason: report.reason,
      generation: report.generation,
      spanLength: report.spanLength,
      summaryTokens: report.summaryTokens,
      // Only a compaction that APPLIED has anything to show. `outcome` is
      // `"compacted"` exactly when `applied` is true, so this gate cannot report a
      // summary for a refusal or a failure.
      summary: outcome === "compacted" ? report.summaryText : null,
      reclaimedTokens: report.reclaimedTokens,
      requestFits: assembled.decision.action !== "reject",
      operationId: input.operationId,
      anchorMessageId: null,
      origin: "manual",
      // Only recorded when the user actually typed something, so the stored divider
      // distinguishes "no instructions given" from "instructions given".
      ...(input.instructions ? { instructions: input.instructions } : {}),
    };
    // Every outcome leaves a divider, including a `skipped`: "the context was
    // already compact" is itself something the user asked to find out, and it is
    // the answer to that question. Only the row id is added here, so the log line
    // below reports the same numbers whether or not the write succeeded.
    const anchorMessageId = await persistCompactionDivider(input.conversationId, data, log);

    log.info("chat", "chat_compact_command", {
      operationId: input.operationId,
      outcome,
      compactionReason: report.reason,
      compactionGeneration: report.generation,
      compactionSpanMessages: report.spanLength,
      compactionReclaimedSize: report.reclaimedTokens,
      compactionSummarySize: report.summaryTokens,
      requestFits: data.requestFits,
      anchorMessageId,
      durationMs: Date.now() - startedAt,
    });

    return { ...data, mechanism, anchorMessageId };
  } catch (err) {
    log.error("chat", "chat_compact_failed", {
      operationId: input.operationId,
      reason: "compaction_error",
      aborted: input.signal.aborted,
      durationMs: Date.now() - startedAt,
      ...errorLogFields(err),
    });
    return {
      kind: "tbai-compact",
      version: 1,
      outcome: "failed",
      reason: "compaction_error",
      mechanism: { kind: "withheld", reason: "failed" },
      generation: 0,
      spanLength: 0,
      summaryTokens: 0,
      summary: null,
      reclaimedTokens: 0,
      requestFits: true,
      operationId: input.operationId,
      anchorMessageId: null,
      origin: "manual" as const,
    };
  }
}
