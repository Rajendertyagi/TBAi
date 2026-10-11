/**
 * Direct-run settlement vocabulary and the durable-stream mirror.
 *
 * These are module-scope constants and helpers that used to sit at the top of
 * `src/routes/chat.ts`. They moved here when the route's execution phase became
 * `chat/execute-direct-stream.ts`, because BOTH that phase and the cancel
 * endpoint need them: a run's outcome is mirrored onto its durable stream row
 * wherever the run is settled, not only where it streams.
 *
 * Keeping this separate from the execution phase is what lets both import it
 * without a cycle.
 */
import { errorLogFields } from "../../lib/errors";
import type { logger } from "../../lib/logger";
import { chatStreamStore } from "../../lib/resumable";
import type { ChatStreamTerminalKind } from "../../services/chat-streams/schema";

/** A run's terminal state, matching the registry's settlement vocabulary. */
export type DirectRunSettlement = "completed" | "failed" | "cancelled";

// Direct output is not replay-safe after the first chunk: a provider retry can
// duplicate text and charge the same conversation again. The UI exposes an
// explicit user retry instead.
export const DIRECT_MAX_RETRIES = 0;
export const DIRECT_STREAM_RETRIES = 0;

const DIRECT_SUCCESS_FINISH_REASONS: ReadonlySet<string> = new Set([
  "stop",
  "length",
  "content-filter",
  "tool-calls",
]);

/** Whether a provider finish reason means this run produced a usable answer. */
export function isSuccessfulDirectFinishReason(reason: string | undefined): boolean {
  return reason !== undefined && DIRECT_SUCCESS_FINISH_REASONS.has(reason);
}

/** What the composed UI stream reported when it finished. */
export type UiStreamOutcome = {
  status: "completed" | "failed" | "aborted" | "unknown";
  error?: unknown;
};

/** The logging surface the durable mirror needs; `logger` and `logger.child()` both satisfy it. */
type StreamLog = Pick<ReturnType<typeof logger.child>, "warn" | "error">;

/**
 * Direct-run outcome -> durable stream verdict. The official `ResumableStreamStore`
 * only knows `streaming | done | error`; TBAi's finer run semantics ride on
 * `terminal_kind` (design A4). This map is the single place that translation
 * happens, so the route can never invent a fifth kind.
 */
const DURABLE_VERDICTS: Record<DirectRunSettlement, ChatStreamTerminalKind> = {
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
};

interface DurableMirrorOptions {
  log: StreamLog;
  providerType?: string;
  finishReason?: string | null;
  /** Sanitized classification source; the message itself is never persisted. */
  failureError?: unknown;
  runStatus?: string;
}

/**
 * Record this run's authoritative in-process outcome on the durable stream row.
 *
 * `chatRuns` remains the process-local single-winner latch; this keeps
 * `chat_streams` in agreement with it rather than creating a second source of
 * truth. Only the VERDICT is written: the byte-stream `status` belongs to the
 * official `finalize`, and closing the row here would make the producer's next
 * `append` throw — costing the client the structured `error` part it needs.
 * A run can honestly be `status='done'` with `terminal_kind='failed'` (see
 * `docs/2026-09-25-phase2-durability-design.md` A4).
 *
 * Only classification fields are persisted — never the provider message.
 */
export function mirrorRunToDurableStream(
  streamId: string,
  status: DirectRunSettlement,
  options: DurableMirrorOptions,
): void {
  const settlement = DURABLE_VERDICTS[status];
  const errorCategory =
    status === "failed"
      ? errorLogFields(options.failureError ?? new Error("Direct stream failed"), {
          provider: options.providerType,
        }).category
      : status === "cancelled"
        ? "cancelled"
        : null;
  try {
    chatStreamStore.recordRunVerdict(streamId, settlement, {
      errorCategory,
      finishReason: options.finishReason ?? null,
    });
  } catch (err) {
    // The in-process verdict is still authoritative and already logged by the AI
    // funnel; a failed bookkeeping write must not change the run's outcome.
    options.log.error("chat", "chat_stream_verdict_failed", {
      streamId,
      runStatus: options.runStatus ?? "unknown",
      ...errorLogFields(err, { provider: options.providerType }),
    });
  }
}
