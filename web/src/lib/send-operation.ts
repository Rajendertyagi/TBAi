/**
 * The chat-send operation: its lifetime, its lifecycle events, and the
 * guaranteed release.
 *
 * A send is the canonical multi-request user action — it can materialize a
 * conversation, dispatch a prompt and then continue through tool calls. All of
 * those requests share ONE operationId, which is what makes the turn
 * reconstructable.
 *
 * LIFETIME. The operation is bounded by the response bodies the send causes,
 * not by a module variable nobody owns. Every chat-transport response passes
 * through `observeBodySettled`, and when a body settles — fully read, errored,
 * or cancelled — the operation it belonged to ends. That is the only signal
 * present on EVERY terminal path: a cancelled or abandoned stream never
 * delivers a `finish` marker, which is exactly how a finished operation used to
 * stay "current" indefinitely and leak its operationId into unrelated later
 * browser errors.
 *
 * Extracted from `runtime.ts` so the lifetime rules are directly testable
 * without a DOM or a React runtime.
 */

import { logger } from "./logger";
import { currentOperationId, endOperation, startOperation } from "./operation";

/**
 * Direct sends are tracked by conversation/thread id, never by one global
 * slot. Two chats sending concurrently keep independent operation ids; a late
 * settle from chat A cannot end chat B's operation. The scope registry lives
 * in `operation.ts`; this module owns the send-specific semantics and logging.
 */

/** Mint the operation for a fresh logical send in `threadId`. Returns its id. */
export function beginSendOperation(threadId: string, fields: Record<string, unknown>): string {
  endOperation(threadId, "superseded");
  const op = startOperation("chat.send", threadId);
  logger.info("chat", "send.start", { threadId, operationId: op.id, ...fields });
  return op.id;
}

/**
 * Re-open the SAME operation for a continuation of one logical send (a tool
 * result or an approval resend) in `threadId`. Without this the id would be
 * lost as soon as the first response settled, leaving the tool/approval half
 * of the turn uncorrelated.
 */
export function attachSendOperation(threadId: string, operationId: string): void {
  if (currentOperationId(threadId) === operationId) return;
  endOperation(threadId, "superseded");
  startOperation("chat.send", threadId, operationId);
}

/**
 * End the send operation for `threadId`. `expectedId` guards the race that
 * matters: a SUPERSEDED response settling late must not end the operation that
 * replaced it. Only the matching scope's operation is ended.
 */
export function endSendOperation(threadId: string, outcome: string, expectedId?: string): void {
  const id = endOperation(threadId, outcome, expectedId);
  if (id) logger.info("chat", "send.stream_end", { threadId, operationId: id, outcome });
}

/** The active send's id for a thread, or undefined. Diagnostics and tests. */
export function activeSendOperationId(threadId?: string): string | undefined {
  return currentOperationId(threadId);
}

/** Test-only reset (the scope registry is cleared by resetOperationsForTests). */
export function resetSendOperationForTests(): void {
  // No module-local send state remains; operation.ts owns the scope registry.
}

/**
 * Pass a response body through byte-for-byte, invoking `onSettled` exactly once
 * when it finishes: read to the end, errored, or cancelled. Never buffers and
 * never alters a chunk.
 */
export function observeBodySettled(
  body: ReadableStream<Uint8Array>,
  onSettled: () => void,
): ReadableStream<Uint8Array> {
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    onSettled();
  };
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          settle();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        settle();
        try {
          controller.error(err);
        } catch {
          /* already closed */
        }
      }
    },
    cancel(reason) {
      settle();
      reader.cancel(reason).catch(() => {});
    },
  });
}
