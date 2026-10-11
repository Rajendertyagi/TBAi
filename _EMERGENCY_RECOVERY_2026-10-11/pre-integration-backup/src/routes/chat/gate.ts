/**
 * Phase 3 — gate the assembled context, and publish the capabilities the stream
 * phase reuses.
 *
 * A MOVE out of the `POST /api/chat` handler. The guard order, the rejection
 * bodies, the log calls and the compaction payloads are the originals.
 *
 * ## Why this phase returns capabilities rather than a verdict
 *
 * `gateAssembledContext` looks like it answers one question — may this request
 * proceed? — but it also establishes four things the stream phase calls back
 * into:
 *
 *  - `chatLog`, the correlation logger for every remaining line;
 *  - `chatStartedAt`, the clock every duration is measured against;
 *  - `publishCompactionDivider`, which overflow recovery RE-ENTERS to record the
 *    compaction it forces;
 *  - `compactionPart` / `automaticPart`, the payload recovery reuses and the
 *    stream writes.
 *
 * So the phase returns those alongside its verdict. That is not incidental
 * coupling: `publishCompactionDivider` is deliberately a FUNCTION rather than a
 * value computed once, because recovery re-assembles AFTER the automatic
 * decision has already been made, and reading the flag eagerly "is exactly what
 * made recovery's compaction invisible". Hoisting it out of reach of the
 * recovery path would reintroduce the bug its own comment warns about.
 *
 * ## Why one shared function object
 *
 * Automatic compaction and overflow recovery must persist through the SAME
 * publisher, so two compactions in one turn can never collide and one compaction
 * can never write two rows. Extracting this phase therefore moves the function
 * itself, once — `gate.publishCompactionDivider` IS that same function object
 * the recovery path calls. It is not rebuilt per trigger, and the recovery call
 * site was deliberately left calling one binding rather than two.
 *
 * ## Why initialization order is preserved exactly
 *
 * `assemblyLog` is constructed before `chatLog`, both before the automatic
 * compaction publish, and the stream phase constructs `streamWriter` and
 * `terminalBatcher` after this phase returns. Nothing here was hoisted to make
 * the extraction easier. In particular `streamWriter` stays where it is, and
 * this module never touches it.
 */
import { logAssembly, logContextOverflow } from "../../context";
import { chatRuns } from "../../services/chat-runs";
import { logger } from "../../lib/logger";
import { persistCompactionDivider } from "../direct-compact-command";
import { ASSEMBLY_LIMIT_CODE } from "../../context";
import type { ChatContext, DirectRunSetup, PhaseResult } from "./types";
import type { DirectRunAssembly } from "./assemble-run";

/** The stream part announcing a compaction, as written to the UI stream. */
type CompactionPart = {
  type: "data-tbai-compact";
  id: string;
  data: {
    kind: "tbai-compact";
    version: 1;
    outcome: "compacted";
    reason: string;
    generation: number;
    spanLength: number;
    summaryTokens: number;
    reclaimedTokens: number;
    /**
     * The summary text, or null when compaction reclaimed space without
     * producing one. Mirrors the stored row's own type (`summary: string |
     * null` in `direct-compact-command.ts`) rather than narrowing it: the
     * divider must be able to say "compacted, nothing was written down".
     */
    summary: string | null;
    operationId: string;
    origin: "automatic" | "recovery";
  };
};

/**
 * What phase 3 establishes for the phases that follow.
 *
 * A runtime record, not a wire format. `publishCompactionDivider` and
 * `compactionPart` are function VALUES — the recovery path invokes the very
 * objects this phase created.
 */
export type DirectRunGate = {
  /** Correlation logger used for assembly-line diagnostics only. */
  readonly assemblyLog: ReturnType<typeof logger.child>;
  /** Correlation logger for every remaining line this request emits. */
  readonly chatLog: ReturnType<typeof logger.child>;
  /** Start of the request, for every `elapsedMs` the route reports. */
  readonly chatStartedAt: number;
  /**
   * Publish the divider for a compaction this turn performed.
   *
   * ONE function object shared by both triggers. See the module note.
   */
  readonly publishCompactionDivider: (
    origin: "automatic" | "recovery",
    operationId: string,
    log: DirectRunGate["assemblyLog"],
  ) => Promise<boolean>;
  /** The `data-tbai-compact` part for a compaction, or undefined if none applied. */
  readonly compactionPart: (
    origin: "automatic" | "recovery",
    operationId: string,
  ) => CompactionPart | undefined;
  /** The automatic trigger's part, written into the stream when present. */
  readonly automaticPart: CompactionPart | undefined;
};

/**
 * Gate the assembled context and publish the stream phase's capabilities.
 *
 * Rejects with the finished 400 when the request may not be sent — first for the
 * tier-2 assembly ceiling, then for a budget `reject`. The order is a contract:
 * a request that was never viable for any model must report the assembly limit
 * rather than a model-context overflow it did not actually hit.
 *
 * @param c Hono context, for the rejection responses.
 * @param setup Phase 1 output.
 * @param state Phase 2 output, mutated only by a later recovery re-assembly.
 * @returns The gate capabilities, or the finished rejection Response.
 * @throws Never directly; `chatRuns.markFailed` precedes every rejection.
 */
export async function gateAssembledContext(
  c: ChatContext,
  setup: DirectRunSetup,
  state: DirectRunAssembly,
): Promise<PhaseResult<DirectRunGate>> {
  const { requestId, threadId, provider, modelConfig } = setup;
  const { run } = state;

  // Narrow `state.assembled` once, here, for the whole phase.
  //
  // The type is `| undefined` because the record is built BEFORE assembly runs
  // — that is what makes it safe to construct and hand to `assembleForRequest`.
  // This phase, however, is only ever called after assembly completed, so the
  // field is populated by construction. Proving it once at the top is honest
  // (the claim is true) and keeps twelve `!` operators out of the guards below.
  const assembled = state.assembled;
  if (!assembled) {
    // Unreachable through the route: it gates immediately after assembly. Kept
    // as a real guard rather than an assertion so a future caller that skips
    // assembly gets a diagnosable error instead of a null dereference.
    throw new Error(`chat: gate reached with no assembled context (${requestId})`);
  }

  // `chatLog` is constructed further down, so the assembly line and any
  // pre-flight rejection are emitted through a correlation-bound child logger
  // built here. Same bindings, constructed once.
  const assemblyLog = logger.child({
    requestId,
    conversationId: threadId,
    provider: provider.type,
    model: modelConfig.model,
  });

  // ── Compaction dividers ──────────────────────────────────────────────────
  // ONE publisher for every compaction this route performs, whatever triggered it.
  //
  // Manual `/compact` goes through `runManualCompaction` and has its own stream; this
  // function serves the two triggers that happen INSIDE an ordinary turn:
  //
  //   - automatic: the engine crossed the trigger while assembling the turn;
  //   - recovery:  the provider rejected the request and overflow recovery forced a
  //     rebuild (see `recover()` in the route).
  //
  // Both re-enter the SAME `assembleForRequest` seam, so both read the SAME
  // `provenance.compaction` report and both persist through the SAME
  // `persistCompactionDivider`. The only per-trigger difference is `origin` and the
  // operation id, which is also the divider's identity — so two compactions in one
  // turn can never collide, and one compaction can never write two rows.
  //
  // It is a FUNCTION, not a value computed once, because recovery re-assembles
  // AFTER the automatic decision has already been made. Reading the flag eagerly is
  // exactly what made recovery's compaction invisible.
  const publishCompactionDivider = async (
    origin: "automatic" | "recovery",
    operationId: string,
    log: typeof assemblyLog,
  ): Promise<boolean> => {
    // The authoritative condition, and the same `applied` fact overflow recovery and
    // the manual command are gated on. Absent or false ⇒ nothing happened, so nothing
    // is written and nothing is claimed.
    const report = assembled.context.provenance.compaction;
    if (report?.applied !== true || !threadId) return false;

    // Every field below comes from the report of the assembly that ACTUALLY applied,
    // so generation, span and reason describe this compaction rather than an earlier
    // one. `requestFits` reads the same decision the budget enforced.
    const requestFits = assembled.decision.action !== "reject";
    const anchorMessageId = await persistCompactionDivider(
      threadId,
      {
        kind: "tbai-compact",
        version: 1,
        // `applied` is true, so the outcome IS `compacted`. The skipped/failed
        // vocabulary belongs to a command the user ran and could read the result of;
        // an automatic one has no reader to report to at the time it happens.
        outcome: "compacted",
        reason: report.reason,
        generation: report.generation,
        spanLength: report.spanLength,
        summaryTokens: report.summaryTokens,
        // An engine-triggered compaction is auditable on the same terms as a manual
        // one. The `applied` guard above has already proven this compaction happened,
        // so the summary is the one this operation actually produced.
        summary: report.summaryText,
        reclaimedTokens: report.reclaimedTokens,
        requestFits,
        operationId,
        anchorMessageId: null,
        origin,
      },
      log,
    );
    log.info("chat", `chat_compact_${origin}`, {
      operationId,
      compactionReason: report.reason,
      compactionGeneration: report.generation,
      compactionSpanMessages: report.spanLength,
      compactionReclaimedSize: report.reclaimedTokens,
      compactionSummarySize: report.summaryTokens,
      requestFits,
      anchorMessageId,
    });
    return true;
  };

  /**
   * The `data-tbai-compact` part for a compaction this turn performed.
   *
   * A part rather than a message of its own: the compaction already happened during
   * assembly, so the only thing left to say is that it did. Written before the reply
   * it applies to, which is where a reader expects to find it.
   *
   * Field-for-field the same payload the stored row carries, minus the fields the
   * renderer never reads — so a live divider and the same divider after a reload
   * cannot disagree.
   */
  const compactionPart = (
    origin: "automatic" | "recovery",
    operationId: string,
  ): CompactionPart | undefined => {
    const report = assembled.context.provenance.compaction;
    if (report?.applied !== true) return undefined;
    return {
      type: "data-tbai-compact" as const,
      id: "compact",
      data: {
        kind: "tbai-compact" as const,
        version: 1 as const,
        outcome: "compacted" as const,
        reason: report.reason,
        generation: report.generation,
        spanLength: report.spanLength,
        summaryTokens: report.summaryTokens,
        reclaimedTokens: report.reclaimedTokens,
        // Present in the live part for the same reason it is present in the stored
        // row: so a divider read on screen and the same divider after a reload
        // carry the identical payload. Both read the same `report`, so they cannot
        // disagree about what was kept.
        summary: report.summaryText,
        operationId,
        origin,
      },
    };
  };

  // ── Automatic compaction ────────────────────────────────────────────────
  // The engine compacts on its own when the conversation's real occupancy crosses
  // the trigger. No command, no run of its own, no second engine.
  const automaticOperationId = `${state.streamId}-auto`;
  const automaticDividerPublished = await publishCompactionDivider(
    "automatic",
    automaticOperationId,
    assemblyLog,
  );
  const automaticPart = automaticDividerPublished
    ? compactionPart("automatic", automaticOperationId)
    : undefined;

  // Tier 2 — universal assembly ceiling. Checked BEFORE the budget rejection so a
  // request that was never viable for any model reports the assembly limit rather
  // than a model-context overflow it did not actually hit.
  //
  // Terminal and deliberately NOT recoverable: it is outside overflow recovery's
  // contract (a size problem with a known remedy). Compaction has already run and
  // did not, or could not, bring the request under the ceiling; compacting again
  // would be the hang-with-extra-steps `recovery.ts` exists to prevent.
  if (assembled.tier2.outcome === "assembly_limit_exceeded") {
    chatRuns.markFailed(run.streamId);
    assemblyLog.error("context", "assembly_limit_exceeded", {
      requestId,
      conversationId: threadId,
      limitWasAdvisory: assembled.tier2.limitWasAdvisory,
      ...assembled.diagnostics,
    });
    return {
      ok: false,
      response: c.json(
        {
          error:
            "This conversation is too large to send to any model. Its history has grown past the assembly limit. Start a new chat to continue.",
          code: ASSEMBLY_LIMIT_CODE,
          requestId,
        },
        400,
      ),
    };
  }

  // Preflight rejection: cheaper than a provider round trip, and - because
  // DIRECT_MAX_RETRIES = 0 (chat.ts:54-55) - the only chance to avoid spending a
  // request that is known to be oversized. The user gets the overflow message,
  // not the generic generation failure Phase 1 recorded as F7.
  //
  // Only a `reject` reaches here. An `advisory` verdict (P-1) means the ceiling was
  // a stand-in rather than a stated limit, so the provider decides whether the
  // request fits and `observed` learns the answer.
  if (assembled.decision.action === "reject") {
    chatRuns.markFailed(run.streamId);
    logContextOverflow({
      log: assemblyLog,
      requestId,
      conversationId: threadId,
      diagnostics: assembled.diagnostics,
      overByTokens: assembled.decision.overBy,
      reason: assembled.decision.reason,
    });
    return {
      ok: false,
      response: c.json(
        {
          error:
            "This conversation is too long for the selected model's context window. Start a new chat, or switch to a model with a larger context limit.",
          code: "CONTEXT_OVERFLOW",
          requestId,
        },
        400,
      ),
    };
  }

  // P-1: the request exceeded a planning ceiling nobody stated. Record it so the
  // condition is observable, then continue to transport.
  if (assembled.decision.action === "advisory") {
    assemblyLog.info("context", "context_limit_advisory", {
      requestId,
      conversationId: threadId,
      ...assembled.diagnostics,
    });
  }

  logAssembly({
    log: assemblyLog,
    requestId,
    conversationId: threadId,
    diagnostics: assembled.diagnostics,
  });

  // Correlation bindings for every line this route emits: requestId (this
  // request) + conversationId (the thread) + provider/model. `operationId` is
  // inherited from the request context, so all of these lines join the user
  // action that caused them without being repeated per call site.
  const chatLog = logger.child({
    requestId,
    conversationId: threadId,
    provider: provider.type,
    model: modelConfig.model,
  });
  const chatStartedAt = Date.now();

  return {
    ok: true,
    value: {
      assemblyLog,
      chatLog,
      chatStartedAt,
      publishCompactionDivider,
      compactionPart,
      automaticPart,
    },
  };
}