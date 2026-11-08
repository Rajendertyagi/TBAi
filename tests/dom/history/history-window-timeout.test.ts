/**
 * Defect L - the history window request has no deadline.
 *
 * `readWindowSlice` used to call `apiFetch(url)` with no `init`, so a request that
 * never settles left the thread's `load()` pending forever. `markHistoryLoadFailed`
 * only runs on a settled outcome and the Retry control stays disabled while
 * `thread.isLoading` is true, so neither recovery nor Retry could proceed.
 *
 * These tests pin the bound at the fetcher, with `fetch` stubbed so the timing is
 * deterministic rather than wall-clock:
 *
 *   - a request that never resolves is abandoned at the deadline, as a
 *     DISTINGUISHABLE error rather than a transport failure;
 *   - the deadline is cleared on the success path and on the error path, so a
 *     fast response leaves no pending abort behind it;
 *   - one conversation timing out neither cancels nor corrupts another's request.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import type { WindowController } from "@web/features/chat/history/windowController.ts";
import {
  HistoryWindowTimeoutError,
  dropWindowController,
  ensureWindowController,
} from "@web/features/chat/history/useDirectHistoryWindow.ts";
import { HISTORY_WINDOW_FETCH_TIMEOUT_MS } from "@web/config/history.ts";

type Row = { id: string; parent_id: string | null; format: string; content: unknown };

const row = (id: string, parent: string | null): Row => ({
  id,
  parent_id: parent,
  format: "ai-sdk/v6",
  content: { role: "user", parts: [{ type: "text", text: id }] },
});

const decode = (stored: { id: string; parent_id: string | null; content: unknown }) => ({
  parentId: stored.parent_id,
  message: { id: stored.id, ...(stored.content as object) },
});

/** A fetch stub whose promise the test settles, and which honours the abort signal. */
function deferredFetch() {
  const calls: Array<{ url: string; signal: AbortSignal | undefined }> = [];
  const impl = (url: string, init?: RequestInit) => {
    const signal = init?.signal ?? undefined;
    calls.push({ url: String(url), signal });
    return new Promise<Response>((resolve, reject) => {
      if (signal) {
        if (signal.aborted) reject(new DOMException("Aborted", "AbortError"));
        else
          signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }
      (globalThis as unknown as { __resolveFetch?: (r: Response) => void }).__resolveFetch =
        resolve;
    });
  };
  return { impl, calls };
}

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const controllers: string[] = [];
function makeController(conversationId: string): WindowController {
  controllers.push(conversationId);
  return ensureWindowController(conversationId, decode as never);
}

describe("Defect L - the window request is bounded", () => {
  let restore: typeof globalThis.fetch;

  beforeEach(() => {
    restore = globalThis.fetch;
    jest.useFakeTimers();
  });

  afterEach(() => {
    globalThis.fetch = restore;
    jest.useRealTimers();
    for (const id of controllers.splice(0)) dropWindowController(id);
    delete (globalThis as unknown as { __resolveFetch?: unknown }).__resolveFetch;
  });

  it("abandons a request that never resolves, as a distinguishable timeout", async () => {
    const { impl } = deferredFetch();
    globalThis.fetch = impl as never;
    const controller = makeController("timeout-a");

    const pending = controller.loadTip();
    // The deadline arrives with the request still outstanding.
    jest.advanceTimersByTime(HISTORY_WINDOW_FETCH_TIMEOUT_MS);
    await tick();

    // Settles the load (so failure handling and Retry can proceed) AND is typed
    // distinctly from a transport error.
    await expect(pending).rejects.toBeInstanceOf(HistoryWindowTimeoutError);
  });

  it("settles at the deadline even when the request never rejects", async () => {
    // A request that has started but will never settle and never rejects, and
    // which only reacts to the abort AFTER the deadline has already fired.
    //
    // SCOPE, stated precisely: this exercises the fetch stage. It is NOT a
    // simulation of the apiFetch Tauri preflight, which awaits
    // `ensureApiBaseUrl()` BEFORE calling fetch and is not wired to the signal at
    // all; that path is not simulated here. It is covered by the same mechanism -
    // the deadline rejects a race rather than waiting for the request - but this
    // test is evidence for the never-settling request, not for that preflight.
    let observedAbort = false;
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      init?.signal?.addEventListener("abort", () => {
        observedAbort = true;
      });
      return new Promise<Response>(() => {
        /* never settles, never rejects */
      });
    }) as never;
    const controller = makeController("timeout-pending");

    const pending = controller.loadTip();
    jest.advanceTimersByTime(HISTORY_WINDOW_FETCH_TIMEOUT_MS);
    await tick();

    await expect(pending).rejects.toBeInstanceOf(HistoryWindowTimeoutError);
    // The abort is still issued, so a request that had reached fetch would be
    // genuinely cancelled rather than merely abandoned.
    expect(observedAbort).toBe(true);
  });

  it("clears the deadline on success, leaving no pending abort", async () => {
    const { impl, calls } = deferredFetch();
    globalThis.fetch = impl as never;
    const controller = makeController("timeout-b");

    const pending = controller.loadTip();
    await tick();
    (globalThis as unknown as { __resolveFetch?: (r: Response) => void }).__resolveFetch!(
      okResponse({
        messages: [row("b-0", null)],
        hasMoreBefore: false,
        hasMoreAfter: false,
        contiguous: true,
        complete: true,
      }),
    );
    await pending;

    // Past the deadline: the settled request must not be aborted afterwards.
    jest.advanceTimersByTime(HISTORY_WINDOW_FETCH_TIMEOUT_MS * 2);
    expect(calls[0]?.signal?.aborted).toBe(false);
  });

  it("clears the deadline on a transport error and reports it unchanged", async () => {
    const { impl, calls } = deferredFetch();
    globalThis.fetch = impl as never;
    const controller = makeController("timeout-c");

    const pending = controller.loadTip();
    await tick();
    (globalThis as unknown as { __resolveFetch?: (r: Response) => void }).__resolveFetch?.(
      new Response("nope", { status: 500 }),
    );
    await pending.catch(() => undefined);

    jest.advanceTimersByTime(HISTORY_WINDOW_FETCH_TIMEOUT_MS * 2);
    expect(calls[0]?.signal?.aborted).toBe(false);
  });

  it("one conversation timing out does not cancel or corrupt another's request", async () => {
    const { impl, calls } = deferredFetch();
    globalThis.fetch = impl as never;
    const stuck = makeController("timeout-stuck");
    const healthy = makeController("timeout-healthy");

    const stuckLoad = stuck.loadTip();
    const healthyLoad = healthy.loadTip();
    await tick();
    expect(calls.length).toBe(2);
    const stuckSignal = calls[0]?.signal;
    const healthySignal = calls[1]?.signal;

    // Answer only the healthy conversation.
    (globalThis as unknown as { __resolveFetch?: (r: Response) => void }).__resolveFetch?.(
      okResponse({
        messages: [row("h-0", null)],
        hasMoreBefore: false,
        hasMoreAfter: false,
        contiguous: true,
        complete: true,
      }),
    );
    await healthyLoad;

    // The other conversation's deadline still fires, and only for its own signal.
    jest.advanceTimersByTime(HISTORY_WINDOW_FETCH_TIMEOUT_MS);
    await tick();
    await expect(stuckLoad).rejects.toBeInstanceOf(HistoryWindowTimeoutError);
    expect(healthySignal?.aborted).toBe(false);
    expect(stuckSignal?.aborted).toBe(true);
  });
});

/** Let queued microtasks (the promise continuations) run under fake timers. */
async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
