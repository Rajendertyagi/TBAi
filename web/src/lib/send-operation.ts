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
import { startOperation, type OperationHandle } from "./operation";

/** The send whose responses are currently in flight, if any. */
let activeSendOperation: OperationHandle | null = null;

/** Mint the operation for a fresh logical send. Returns its id. */
export function beginSendOperation(fields: Record<string, unknown>): string {
  activeSendOperation?.end("superseded");
  const op = startOperation("chat.send");
  activeSendOperation = op;
  logger.info("chat", "send.start", fields);
  return op.id;
}

/**
 * Re-open the SAME operation for a continuation of one logical send (a tool
 * result or an approval resend). Without this the id would be lost as soon as
 * the first response settled, leaving the tool/approval half of the turn
 * uncorrelated.
 */
export function attachSendOperation(operationId: string): void {
  if (activeSendOperation?.id === operationId) return;
  activeSendOperation?.end("superseded");
  activeSendOperation = startOperation("chat.send", operationId);
}

/**
 * End the send operation. `expectedId` guards the race that matters: a
 * SUPERSEDED response settling late must not end the operation that replaced
 * it. Omit it only for a caller that means "end whatever is current".
 */
export function endSendOperation(outcome: string, expectedId?: string): void {
  const op = activeSendOperation;
  if (!op) return;
  if (expectedId !== undefined && op.id !== expectedId) return;
  activeSendOperation = null;
  // Logged BEFORE end() so the line still inherits the operation id.
  logger.info("chat", "send.stream_end", { outcome });
  op.end(outcome);
}

/** The active send's id, or undefined. Diagnostics and tests. */
export function activeSendOperationId(): string | undefined {
  return activeSendOperation?.id;
}

/** Test-only reset. */
export function resetSendOperationForTests(): void {
  activeSendOperation = null;
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
