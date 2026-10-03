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
import { assembleContext } from "../context/assemble";
import {
  COMPACTION_SUMMARY_TIMEOUT_MS,
  DEFAULT_COMPACTION_POLICY,
  compactionEnabled,
  describeCompactionOutcome,
} from "../context/compaction";
import type { AssembleContextInput, MechanismOutcome } from "../context/types";

/**
 * The single command string this route intercepts.
 *
 * One value, matched exactly. It is deliberately NOT a general slash-command
 * table: every unlisted string — `/compact now`, `explain /compact` — is ordinary
 * user text and must reach the model untouched.
 */
export const COMPACT_COMMAND = "/compact";

/**
 * What the command did.
 *
 * Three values, not a boolean, because "nothing was eligible" and "compaction
 * tried and broke" demand different user responses and different logs. `skipped`
 * is not a soft `true`: it means no checkpoint was fabricated.
 */
export type ManualCompactOutcome = "compacted" | "skipped" | "failed";

/** The status payload delivered to the UI. Contains no message text. */
export interface ManualCompactData {
  readonly kind: "tbai-compact";
  readonly version: 1;
  readonly outcome: ManualCompactOutcome;
  /** Raw compaction reason; never replaced by the outcome label. */
  readonly reason: string;
  readonly generation: number;
  readonly spanLength: number;
  readonly summaryTokens: number;
  readonly reclaimedTokens: number;
  /** Whether the assembled request fits after compaction. */
  readonly requestFits: boolean;
  readonly operationId: string;
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
    reclaimedTokens: 0,
    requestFits: true,
    operationId,
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
 * The LAST user message must equal `/compact` after trimming, so surrounding
 * whitespace is tolerated and any additional words are not. Assistant and system
 * messages are skipped rather than matched, so a `/compact` quoted inside the
 * transcript can never trigger the command. Returns `false` when there is no user
 * message at all.
 */
export function detectCompactCommand(messages: readonly UIMessage[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    return textOf(message).trim() === COMPACT_COMMAND;
  }
  return false;
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
        reclaimedTokens: 0,
        requestFits: assembled.decision.action !== "reject",
        operationId: input.operationId,
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

    log.info("chat", "chat_compact_command", {
      operationId: input.operationId,
      outcome,
      compactionReason: report.reason,
      compactionGeneration: report.generation,
      compactionSpanMessages: report.spanLength,
      compactionReclaimedSize: report.reclaimedTokens,
      compactionSummarySize: report.summaryTokens,
      requestFits: assembled.decision.action !== "reject",
      durationMs: Date.now() - startedAt,
    });

    return {
      kind: "tbai-compact",
      version: 1,
      outcome,
      reason: report.reason,
      mechanism,
      generation: report.generation,
      spanLength: report.spanLength,
      summaryTokens: report.summaryTokens,
      reclaimedTokens: report.reclaimedTokens,
      requestFits: assembled.decision.action !== "reject",
      operationId: input.operationId,
    };
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
      reclaimedTokens: 0,
      requestFits: true,
      operationId: input.operationId,
    };
  }
}
