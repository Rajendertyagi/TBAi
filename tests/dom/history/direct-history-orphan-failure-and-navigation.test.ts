/**
 * Defect S, third round - the two paths review round 2 and 3 left open.
 *
 * 1. ORPHANED FAILURE. The adapter's failure branch classified only `superseded` as
 *    stale, so an ORPHANED controller - dropped, with nothing put back - reached
 *    the normal branch, which published UI state through the RAW publish. That put
 *    a snapshot on screen for a controller that was not registered: the exact
 *    ownership inconsistency the supersession guard exists to prevent. The branch
 *    now uses the guarded publish, which re-adopts the orphan, so the failure state
 *    and the controller that owns it stay consistent and Retry still resolves one.
 *
 * 2. NAVIGATION SUPERSESSION. `goHistorical` and `restoreTip` both await the
 *    controller and then install its window as the live message list. That install
 *    is `applyWindowToChat`, and it refuses a superseded controller - a write no
 *    later publish guard can undo.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applyWindowToChat, type WindowInstaller } from "@web/features/chat/history/useDirectHistoryWindow.ts";
import { createThreadHistoryAdapter } from "@web/adapters/threadHistoryAdapter.ts";
import {
  clearAllWindowControllers,
  ensureWindowController,
  isHistoryLoadFailed,
  windowControllerFor,
} from "@web/features/chat/history/useDirectHistoryWindow.ts";

type StoredRow = { id: string; parent_id: string | null; format: string; content: unknown };

const row = (id: string, parent: string | null): StoredRow => ({
  id,
  parent_id: parent,
  format: "ai-sdk/v6",
  content: { role: "user", parts: [{ type: "text", text: id }] },
});

const decodeRow = (stored: StoredRow) => ({
  parentId: stored.parent_id,
  message: { id: stored.id },
});

const jsonResponse = (messages: StoredRow[], status = 200): Response =>
  new Response(
    JSON.stringify({
      messages,
      hasMoreBefore: false,
      hasMoreAfter: false,
      contiguous: true,
      complete: true,
    }),
    { status, headers: { "content-type": "application/json" } },
  );

const formatAdapter = {
  encode: (item: unknown) => item,
  decode: decodeRow,
} as never;

const adapterFor = (remoteId: string) =>
  createThreadHistoryAdapter(() => ({
    threadListItem: {
      getState: () => ({ remoteId }),
      initialize: async () => ({ remoteId }),
    },
  })) as unknown as {
    withFormat: (a: unknown) => { load: () => Promise<unknown> };
  };
/** A recording installer, standing in for the live feed. */
function recordingInstaller(): { install: WindowInstaller; readonly installed: Array<{ id: string }> } {
  const installed: Array<{ id: string }> = [];
  return {
    installed,
    install: (messages) => {
      installed.push(...(messages as Array<{ id: string }>));
    },
  };
}

describe("Defect S - orphaned failure keeps state and ownership consistent", () => {
  let restore: typeof globalThis.fetch;

  beforeEach(() => {
    restore = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = restore;
    clearAllWindowControllers();
  });

  it("re-adopts an orphaned controller on the failure path, so Retry still resolves one", async () => {
    const remoteId = `orphan-fail-${Date.now()}`;

    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      await gate;
      if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      // A server refusal, so the adapter takes its failure branch.
      return new Response("nope", { status: 500 });
    }) as unknown as typeof fetch;

    const adapter = adapterFor(remoteId);
    const inflight = adapter.withFormat(formatAdapter).load();
    await Promise.resolve();

    // Recovery drops the controller and NOTHING replaces it: it is orphaned.
    clearAllWindowControllers();
    expect(windowControllerFor(remoteId)).toBeNull();

    release!();
    await inflight;

    // The failure is recorded...
    expect(isHistoryLoadFailed(remoteId)).toBe(true);
    // ...and the controller that owns that state exists, so Retry can recover.
    expect(
      windowControllerFor(remoteId),
      "an orphaned failure must re-adopt its controller, not publish for a missing one",
    ).not.toBeNull();
  });
});

describe("Defect S - navigation cannot overwrite a replacement's live messages", () => {
  let restore: typeof globalThis.fetch;

  beforeEach(() => {
    restore = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = restore;
    clearAllWindowControllers();
  });

  it("refuses to install a superseded controller's window", async () => {
    const remoteId = `nav-superseded-${Date.now()}`;
    globalThis.fetch = (async () => jsonResponse([row("nav-0", null)])) as unknown as typeof fetch;

    const c1 = ensureWindowController(remoteId, decodeRow as never);
    await c1.loadTip();

    // C1 navigates (goHistorical / restoreTip both route through applyWindowToChat)
    // while C2 replaces it.
    clearAllWindowControllers();
    globalThis.fetch = (async () => jsonResponse([row("replacement-0", null)])) as unknown as typeof fetch;
    const c2 = ensureWindowController(remoteId, decodeRow as never);
    await c2.loadTip();

    const chat = recordingInstaller();
    const wrote = applyWindowToChat(remoteId, chat.install, c1);

    expect(wrote, "a superseded controller must not write live state").toBe(false);
    expect(chat.installed, "C1's window must never reach the live feed").toEqual([]);
    // The replacement is untouched and still owns the conversation.
    expect(windowControllerFor(remoteId)).toBe(c2);
  });

  it("still installs the window when the controller is current or merely orphaned", async () => {
    const remoteId = `nav-current-${Date.now()}`;
    globalThis.fetch = (async () => jsonResponse([row("live-0", null)])) as unknown as typeof fetch;

    const current = ensureWindowController(remoteId, decodeRow as never);
    await current.loadTip();

    const chatCurrent = recordingInstaller();
    expect(applyWindowToChat(remoteId, chatCurrent.install, current)).toBe(true);
    expect(chatCurrent.installed.map((m) => m.id)).toEqual(["live-0"]);

    // Orphaned - dropped with no replacement - must still be usable, matching the
    // accepted orphan policy rather than being over-blocked.
    clearAllWindowControllers();
    const chatOrphan = recordingInstaller();
    expect(applyWindowToChat(remoteId, chatOrphan.install, current)).toBe(true);
    expect(chatOrphan.installed.map((m) => m.id)).toEqual(["live-0"]);
  });
});
