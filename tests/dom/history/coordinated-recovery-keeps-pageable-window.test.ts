/**
 * Coordinated recovery must leave a COMMITTED Direct history window pageable.
 *
 * Regression for CI run 42334853949 (`history/p2-direct-history-window.spec.ts`).
 * The boot `/readyz` probe transitions `unknown -> online` and runs the single
 * coordinated recovery, which invalidated the history cache. That deleted the
 * conversation's already-committed window controller and reset the UI snapshot to
 * `hasEarlier: false`.
 *
 * `useExternalHistory` latches `load()` per mount, so the mounted transcript could
 * never build a replacement: it kept rendering from runtime memory while
 * "Load earlier" (derived from the controller) disappeared for good. Recovery is
 * documented to keep FUTURE mounts authoritative, not to unpage the current one.
 *
 * So a committed window is now KEPT and marked stale:
 *
 *  - the current mount still pages the window it is rendering;
 *  - the next `ensureWindowController` replaces the stale slot and re-reads
 *    SQLite authoritatively;
 *  - an UNCOMMITTED controller is still dropped, preserving orphan re-adoption.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { invalidateHistoryCache } from "@web/adapters/threadHistoryAdapter.ts";
import {
  dropWindowController,
  ensureWindowController,
  publishWindowUi,
  publishWindowUiFor,
  type DirectHistoryWindowUi,
  useDirectHistoryWindowUi,
  windowControllerFor,
} from "@web/features/chat/history/useDirectHistoryWindow.ts";

type Row = { id: string; parent_id: string | null };

let served: Row[] = [];
let windowCalls: string[] = [];
const realFetch = globalThis.fetch;

/** A window-route response that matches the backend's walk semantics. */
const respond = (url: string): Response => {
  windowCalls.push(url);
  const query = new URL(url, "http://local").searchParams;
  const direction = query.get("direction");
  const anchor = query.get("anchorId");
  const limit = Number(query.get("limit"));

  let slice: Row[] = [];
  let hasMoreBefore = false;

  if (direction === "newer") {
    const at = served.findIndex((r) => r.id === anchor);
    slice = at < 0 ? [] : served.slice(at, at + limit);
  } else if (anchor) {
    // The older walk includes the anchor, so the page overlaps the window and the
    // frozen core can merge on it.
    const at = served.findIndex((r) => r.id === anchor);
    const start = at < 0 ? Math.max(0, served.length - limit) : Math.max(0, at - limit);
    slice = served.slice(start, at < 0 ? served.length : at + 1);
    hasMoreBefore = start > 0;
  } else {
    slice = served.slice(Math.max(0, served.length - limit));
    hasMoreBefore = served.length > limit;
  }

  return {
    ok: true,
    status: 200,
    json: async () => ({
      messages: slice.map((r) => ({
        id: r.id,
        parent_id: r.parent_id,
        format: "ai-sdk/v6",
        content: { id: r.id, role: "user", parts: [{ type: "text", text: r.id }] },
      })),
      hasMoreBefore,
      hasMoreAfter: false,
      contiguous: true,
      complete: true,
    }),
  } as Response;
};

const decode = (stored: { id: string; parent_id: string | null }) => ({
  parentId: stored.parent_id,
  message: { id: stored.id },
});

type UiProbe = {
  readonly snapshots: DirectHistoryWindowUi[];
  readonly latest: () => DirectHistoryWindowUi;
  readonly unmount: () => void;
};

/** Mount the real UI hook: `hasEarlier` is what the Load earlier control reads. */
function mountUi(conversationId: string): UiProbe {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const snapshots: DirectHistoryWindowUi[] = [];

  const Probe = () => {
    const ui = useDirectHistoryWindowUi(conversationId);
    if (snapshots.length === 0 || snapshots[snapshots.length - 1] !== ui) snapshots.push(ui);
    return null;
  };

  act(() => {
    root.render(createElement(Probe));
  });

  return {
    snapshots,
    latest: () => {
      const last = snapshots.at(-1);
      if (!last) throw new Error("the UI hook did not render");
      return last;
    },
    unmount: () => act(() => root.unmount()),
  };
}

const freshId = (): string =>
  `recovery-window-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const chain = (count: number): Row[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `m${i + 1}`,
    parent_id: i === 0 ? null : `m${i}`,
  }));

describe("coordinated recovery keeps a committed window pageable", () => {
  const probes: UiProbe[] = [];
  const ids: string[] = [];

  beforeEach(() => {
    served = [];
    windowCalls = [];
    globalThis.fetch = (async (url: unknown) => respond(String(url))) as unknown as typeof fetch;
  });

  afterEach(() => {
    for (const probe of probes.splice(0)) probe.unmount();
    for (const id of ids.splice(0)) dropWindowController(id);
    globalThis.fetch = realFetch;
  });

  it("[R-1] keeps the committed window and its Load earlier state across invalidation", async () => {
    served = chain(150);
    const id = freshId();
    ids.push(id);
    const probe = mountUi(id);
    probes.push(probe);

    const controller = ensureWindowController(id, decode);
    await controller.loadTip();
    act(() => publishWindowUi(id, controller));

    expect(controller.hasMoreBefore).toBe(true);
    expect(controller.rows()).toHaveLength(100);
    expect(probe.latest().hasEarlier).toBe(true);

    const beforeCalls = windowCalls.length;
    act(() => invalidateHistoryCache());

    // The window the mounted consumer is rendering survives; only its authority
    // for the NEXT mount is dropped.
    expect(windowControllerFor(id)).toBe(controller);
    expect(probe.latest().hasEarlier).toBe(true);
    expect(controller.rows()).toHaveLength(100);

    // Paging still resolves the controller and issues a real window request.
    await act(async () => {
      await controller.loadOlder({ historical: true });
    });
    act(() => publishWindowUi(id, controller));

    expect(windowCalls.length).toBeGreaterThan(beforeCalls);
    expect(controller.rows().length).toBeGreaterThan(100);
    // After the oldest page arrives there is nothing earlier left, and the snapshot
    // must track the real controller rather than a frozen pre-recovery value.
    expect(controller.hasMoreBefore).toBe(false);
    expect(probe.latest().hasEarlier).toBe(false);
  });

  it("[R-2] replaces the stale slot on the next mount and re-reads authoritatively", async () => {
    served = chain(150);
    const id = freshId();
    ids.push(id);
    const probe = mountUi(id);
    probes.push(probe);

    const first = ensureWindowController(id, decode);
    await first.loadTip();
    act(() => publishWindowUi(id, first));
    expect(probe.latest().hasEarlier).toBe(true);

    act(() => invalidateHistoryCache());
    const callsBeforeRemount = windowCalls.length;

    // The next mount gets a NEW controller, so its initial load re-reads SQLite
    // instead of trusting the previously committed window.
    const second = ensureWindowController(id, decode);
    expect(second).not.toBe(first);
    expect(second.rows()).toHaveLength(0);

    await second.loadTip();
    expect(windowCalls.length).toBeGreaterThan(callsBeforeRemount);
    expect(second.rows().map((r) => r.id)).toEqual(served.slice(-100).map((r) => r.id));
    act(() => publishWindowUi(id, second));
    expect(probe.latest().hasEarlier).toBe(true);

    // A late publication from the replaced controller must not clobber it.
    expect(publishWindowUiFor(id, first)).toBe(false);
    expect(windowControllerFor(id)).toBe(second);
  });

  it("[R-3] still drops an uncommitted controller, so a late load can re-adopt it", async () => {
    served = chain(10);
    const id = freshId();
    ids.push(id);

    const controller = ensureWindowController(id, decode);
    expect(controller.rows()).toHaveLength(0);

    act(() => invalidateHistoryCache());

    expect(windowControllerFor(id)).toBeNull();
  });
  it("[R-4] leaves a conversation with no committed history untouched", async () => {
    served = chain(3);
    const id = freshId();
    ids.push(id);
    const probe = mountUi(id);
    probes.push(probe);

    const controller = ensureWindowController(id, decode);
    await controller.loadTip();
    act(() => publishWindowUi(id, controller));
    // Fewer rows than the limit: the whole conversation is the window.
    expect(controller.hasMoreBefore).toBe(false);
    expect(probe.latest().hasEarlier).toBe(false);

    act(() => invalidateHistoryCache());

    expect(windowControllerFor(id)).toBe(controller);
    expect(probe.latest().hasEarlier).toBe(false);
  });
});
