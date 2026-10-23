/**
 * Reads an OpenCode `/api/event` stream into a caller-owned array.
 *
 * ## Why a shared helper
 *
 * Three runtime suites need the same thing: subscribe with the server's auth
 * headers, split frames on the blank line, and record each event with the local
 * arrival time so ordering and "after this moment" assertions are possible. A
 * copy per suite drifts: one of them eventually stops handling multi-byte
 * chunk boundaries or keep-alive frames.
 *
 * ## Envelope
 *
 * A data frame is the event itself - `{ id, type, created, data, durable? }` -
 * NOT a legacy `{ event, properties }` wrapper. `type` is the discriminator and
 * is the only field required here; suites narrow `data` themselves.
 *
 * ## Lifecycle
 *
 * The returned promise resolves when the stream ends and rejects only on a
 * non-abort error. Teardown aborts the signal, which ends it quietly. A caller
 * that needs "connected" ordering can poll for the synthetic `server.connected`
 * event the server sends first.
 */

import type { RuntimeOpenCodeServer } from "./opencodeRuntimeHarness.ts";

/** One event as framed by the server, with the local arrival time. */
export interface RuntimeWireEvent {
  readonly type: string;
  /** Server-side epoch-ms of the event, when the event carries one. */
  readonly created?: number;
  /** Event payload; shape depends on `type`. */
  readonly data?: Record<string, unknown>;
  /** Local epoch-ms when this process received the frame. */
  readonly receivedAt: number;
}

/**
 * Consumes `/api/event` into `sink` until `signal` aborts.
 *
 * @param server Authenticated handle from the runtime harness.
 * @param signal Aborts the underlying fetch; aborting is not an error.
 * @param sink Receives every parsed event, in arrival order.
 */
export async function subscribeRuntimeEvents(
  server: RuntimeOpenCodeServer,
  signal: AbortSignal,
  sink: RuntimeWireEvent[],
): Promise<void> {
  try {
    const res = await fetch(`${server.baseUrl}/api/event`, {
      headers: server.headers,
      signal,
    });
    const stream = res.body;
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try {
            const parsed = JSON.parse(line.slice(5).trim()) as Omit<RuntimeWireEvent, "receivedAt">;
            if (parsed?.type) sink.push({ ...parsed, receivedAt: Date.now() });
          } catch {
            /* keep-alive or non-JSON frame */
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } catch {
    /* aborted on teardown, or the server stopped */
  }
}
