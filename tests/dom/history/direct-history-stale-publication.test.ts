/**
 * Defect S - stale publication after invalidation.
 *
 * The production path is `publishWindowUiFor`, not `publishWindowUi`: every caller
 * that holds a controller across an await routes through the guard, because only
 * the caller knows its controller may have been invalidated while it awaited.
 *
 * Two branches, and the difference is the whole point:
 *
 *  - SUPERSEDED - a different controller is registered for the conversation. The
 *    late completion is stale in the strict sense and must not publish, or it
 *    clobbers newer authoritative state.
 *  - ORPHANED - coordinated recovery dropped the controller and nothing replaced
 *    it. The window the load just fetched is the freshest thing that exists, and
 *    `useExternalHistory` latches `load()` per mount, so discarding it would leave
 *    the transcript populated but permanently unpageable. It is re-adopted.
 *
 * Reachability through the real lifecycle is proven separately in
 * `tests/e2e/history/p2-stale-publication-reachability.spec.ts`; this file pins the
 * guard's branch behaviour deterministically.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { WindowController } from "@web/features/chat/history/windowController.ts";
import {
  clearAllWindowControllers,
  ensureWindowController,
  publishWindowUiFor,
  useDirectHistoryWindowUi,
  windowControllerFor,
  type DirectHistoryWindowUi,
} from "@web/features/chat/history/useDirectHistoryWindow.ts";

type UiProbe = {
  readonly snapshots: DirectHistoryWindowUi[];
  readonly unmount: () => void;
};

/** Mount the real hook and record every distinct snapshot identity it returns. */
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

  return { snapshots, unmount: () => act(() => root.unmount()) };
}

/** A controller that never fetches: these tests are about publication, not loading. */
function idleController(): WindowController {
  return new WindowController({
    limit: 10,
    overscan: 2,
    fetchWindow: async () => {
      throw new Error("fetch is not part of this contract");
    },
  });
}

/** Register a real controller for the id without issuing any request. */
function registerController(conversationId: string): WindowController {
  return ensureWindowController(conversationId, (() => {
    throw new Error("decode is not called without a fetch");
  }) as never);
}

const freshId = (): string => `guard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe("Defect S - a superseded controller may not publish", () => {
  const probes: UiProbe[] = [];

  afterEach(() => {
    for (const probe of probes.splice(0)) probe.unmount();
    clearAllWindowControllers();
  });

  it("refuses to publish from a controller that has been superseded", () => {
    const id = freshId();
    const probe = mountUi(id);
    probes.push(probe);

    const current = registerController(id);
    const stale = idleController();

    let published = false;
    act(() => {
      published = publishWindowUiFor(id, stale);
    });

    expect(published).toBe(false);
    // The current controller is untouched and still owns the conversation.
    expect(windowControllerFor(id)).toBe(current);
    expect(probe.snapshots.at(-1)!.revision).toBe(0);
  });

  it("publishes from the controller that is still current", () => {
    const id = freshId();
    const probe = mountUi(id);
    probes.push(probe);

    const current = registerController(id);
    let published = false;
    act(() => {
      published = publishWindowUiFor(id, current);
    });

    expect(published).toBe(true);
    expect(probe.snapshots.at(-1)!.revision).toBeGreaterThan(0);
  });

  it("re-adopts an orphaned controller so the conversation stays pageable", () => {
    const id = freshId();
    const probe = mountUi(id);
    probes.push(probe);

    const registered = registerController(id);
    // Coordinated recovery drops it and nothing replaces it - the exact state the
    // reachability test drives through the browser.
    act(() => {
      clearAllWindowControllers();
    });
    expect(windowControllerFor(id)).toBeNull();

    let published = false;
    act(() => {
      published = publishWindowUiFor(id, registered);
    });

    // Not merely suppressed: the controller is back, so paging can resolve one.
    expect(published).toBe(true);
    expect(windowControllerFor(id)).toBe(registered);
    expect(probe.snapshots.at(-1)!.revision).toBeGreaterThan(0);
  });
});
