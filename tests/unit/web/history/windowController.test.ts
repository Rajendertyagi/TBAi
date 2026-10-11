/**
 * P2 Direct History Window — production controller tests.
 *
 * The controller is exercised against a fake `WindowFetcher` that models the
 * backend contract (`getWindowSlice`: contiguity on the selected chain,
 * `hasMoreBefore/hasMoreAfter`, and the `complete` fail-closed signal), and the
 * real frozen `historyWindow` core decides every commit.
 */

import { describe, expect, it } from "bun:test";
import { bindExternalStoreMessage } from "@assistant-ui/react";
import {
  WindowController,
  WindowControllerError,
  type PersistedRow,
  type WindowRequest,
  type WindowSliceResponse,
} from "@web/features/chat/history/windowController.ts";

const TOTAL = 500;
const row = (n: number): PersistedRow => ({
  id: `m${n}`,
  parentId: n === 1 ? null : `m${n - 1}`,
  format: "ai-sdk/v6",
  content: { id: `m${n}`, parts: [{ type: "text", text: `body m${n}` }] },
  message: {
    id: `m${n}`,
    role: n % 2 === 1 ? "user" : "assistant",
    parts: [{ type: "text", text: `body m${n}` }],
  },
});

/** The persisted chain: a single branch m1..m500 (P1' authority). */
const CHAIN: PersistedRow[] = Array.from({ length: TOTAL }, (_, i) => row(i + 1));

/** A faithful stand-in for `messageService.getWindowSlice`. */
const sliceOf = (request: WindowRequest, limit: number): WindowSliceResponse => {
  const ids = CHAIN.map((r) => r.id);
  if (request.direction === "older") {
    const end = request.anchorId === null ? TOTAL : ids.indexOf(request.anchorId) + 1;
    const start = Math.max(0, end - limit);
    const run = CHAIN.slice(start, end);
    return {
      messages: run,
      hasMoreBefore: start > 0,
      hasMoreAfter: end < TOTAL,
      contiguous: true,
    };
  }
  const startId = request.anchorId === null ? TOTAL - 1 : ids.indexOf(request.anchorId);
  if (startId < 0)
    return { messages: [], hasMoreBefore: false, hasMoreAfter: false, contiguous: true };
  const end = Math.min(TOTAL, startId + limit);
  return {
    messages: CHAIN.slice(startId, end),
    hasMoreBefore: startId > 0,
    hasMoreAfter: end < TOTAL,
    contiguous: true,
  };
};

/**
 * A MEASURED active region, movable the way a viewport moves. The window layer
 * never invents one: eviction is only meaningful against what the user can see,
 * and the older-direction policy deliberately keeps the measured span and drops
 * the far side — so a load-older test must first move the viewport into the older
 * region, exactly as the user does (see the §10 Chromium proofs).
 */
const makeMeasuredRegion = () => {
  let focus = "m500";
  return {
    focus: (id: string) => {
      focus = id;
    },
    read: () => {
      const n = Number(focus.slice(1));
      const top = `m${Math.max(1, n - 2)}`;
      const bottom = `m${Math.min(TOTAL, n + 2)}`;
      return { top: { messageId: top, offset: 0 }, bottom: { messageId: bottom, offset: 0 } };
    },
  };
};

const makeController = (options: { incomplete?: boolean } = {}) => {
  const requests: WindowRequest[] = [];
  const measured = makeMeasuredRegion();
  const controller = new WindowController({
    limit: 50,
    overscan: 2,
    anchors: measured.read,
    fetchWindow: async (request) => {
      requests.push(request);
      const slice = sliceOf(request, 50);
      return options.incomplete ? { ...slice, contiguous: false } : slice;
    },
  });
  return { controller, requests, measured };
};

describe("P2 controller — merged-window integrity", () => {
  /**
   * A page that is INTERNALLY sound can still fail to line up with the window
   * already held.
   *
   * `slice.contiguous` is the backend's claim about the page it just sent, and
   * `buildCandidateWindow` joins page-to-window by index offset from the first
   * shared id. Neither of those verifies the interior links of the MERGED
   * window. This is the shape that reaches the client when the branch under a
   * retained window changes — the overlap id still exists, so the join succeeds,
   * but the page no longer links back to the window it is being prepended to.
   *
   * The controller must refuse the commit rather than render a window with a
   * hole: a hole reads as "this message does not exist" and silently drops a
   * turn from the transcript.
   */
  it("refuses a page whose overlap survives but whose join leaves a hole", async () => {
    const controller = new WindowController({
      limit: 50,
      fetchWindow: async (request) => {
        const base = sliceOf(request, 50);
        // Prepend m449 then the anchor m451. Both rows are real and the page is
        // internally consistent as a set, but m450 is missing, so the join to
        // the held window's first row (m451, whose parent is m450) breaks.
        if (request.direction === "older" && request.anchorId === "m451") {
          return { ...base, messages: [row(449), row(451)] };
        }
        return base;
      },
    });

    await controller.loadTip();
    expect(controller.windowIds()).toHaveLength(50);

    await expect(controller.loadOlder()).rejects.toBeInstanceOf(WindowControllerError);

    // Fail-closed: the previously valid window is untouched.
    expect(controller.windowIds()).toHaveLength(50);
    expect(controller.windowIds()[0]).toBe("m451");
  });

  it("still accepts a normal contiguous prepend", async () => {
    const controller = new WindowController({
      limit: 50,
      fetchWindow: async (request) => sliceOf(request, 50),
    });

    await controller.loadTip();
    await controller.loadOlder();

    // The page is `limit` rows INCLUDING the anchor, so the window widens by
    // limit-1: m451..m500 plus m402..m450.
    expect(controller.windowIds()).toHaveLength(99);
    expect(controller.windowIds()[0]).toBe("m402");
    expect(controller.windowIds().at(-1)).toBe("m500");
  });
});

describe("P2 controller — window lifecycle", () => {
  it("A. initial load establishes the bounded authoritative tip window", async () => {
    const { controller, requests } = makeController();
    await controller.loadTip();

    expect(requests[0]).toEqual({ direction: "older", anchorId: null, limit: 50 });
    expect(controller.windowIds()).toHaveLength(50);
    expect(controller.windowIds()[0]).toBe("m451");
    expect(controller.authoritativeTip).toBe("m500");
    expect(controller.hasMoreBefore).toBe(true);
    expect(controller.hasMoreAfter).toBe(false);
    expect(controller.isActive).toBe(true);

    // The seed carries every message with persisted parents, root clipped.
    const seed = controller.repositorySeed();
    expect(seed.messages).toHaveLength(50);
    expect(seed.messages[0]!.parentId).toBeNull();
    expect(seed.messages[1]!.parentId).toBe("m451");
    expect(seed.headId).toBe("m500");
    // The seed hands upstream the DECODED message, never the raw envelope.
    expect((seed.messages[0]!.message as { parts?: unknown[] }).parts).toBeDefined();
  });

  it("Q. widening twice produces no duplicate ids and never drops a requested page", async () => {
    const { controller, measured } = makeController();
    await controller.loadTip();
    const tip = controller.windowIds().length;

    // The user scrolls into the older region, then asks for more.
    measured.focus("m451");
    await controller.loadOlder();
    const afterFirst = controller.windowIds();
    measured.focus("m401");
    await controller.loadOlder();

    const ids = controller.windowIds();
    // The buffer is APPEND-ONLY (P2 rebase): unique ids, monotonically growing,
    // and every page the user asked for is still present. There is deliberately
    // no upper bound here any more — the old one evicted the page just loaded,
    // which is why the bound moved to virtualization's mounted row count.
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(tip);
    expect(ids.length).toBeGreaterThanOrEqual(afterFirst.length);
    // The page loaded the first time round is still there after the second.
    for (const id of afterFirst) expect(ids).toContain(id);
    expect(ids.some((id) => Number(id.slice(1)) < 451)).toBe(true);
    expect(controller.repositorySeed().messages).toHaveLength(ids.length);
  });

  it("B/C. historical navigation is non-submittable and restores the active tip", async () => {
    const { controller } = makeController();
    await controller.loadTip();

    await controller.goHistorical("m120");
    expect(controller.historical).toBe(true);
    expect(controller.isActive).toBe(false);
    expect(controller.windowIds()).toContain("m120");
    // The authoritative tip is PRESERVED across historical navigation.
    expect(controller.authoritativeTip).toBe("m500");
    // The historical window is NOT rebased onto the tip.
    expect(controller.windowIds()).not.toContain("m500");

    await controller.restoreTip();
    expect(controller.historical).toBe(false);
    expect(controller.isActive).toBe(true);
    expect(controller.authoritativeTip).toBe("m500");
  });

  it("F/G/H. an out-of-window target resolves and repositions the window", async () => {
    const { controller } = makeController();
    await controller.loadTip();
    expect(controller.windowIds()).not.toContain("m120");

    const resolved = await controller.resolveTarget("m120");
    expect(resolved).toBe("m120");
    expect(controller.windowIds()).toContain("m120");
  });

  it("never reports a missing target as the current tip", async () => {
    const { controller } = makeController();
    await controller.loadTip();
    let error: WindowControllerError | null = null;
    try {
      await controller.resolveTarget("does-not-exist");
    } catch (e) {
      error = e as WindowControllerError;
    }
    expect(error?.failure).toBe("not-found");
    // The window is untouched — no silent fallback to the tip.
    expect(controller.windowIds()[0]).toBe("m451");
  });

  it("P. an incomplete slice keeps the last valid window", async () => {
    const { controller } = makeController();
    await controller.loadTip();
    const before = controller.windowIds();

    const broken = new WindowController({
      limit: 50,
      anchors: () => ({
        top: { messageId: "m498", offset: 0 },
        bottom: { messageId: "m500", offset: 0 },
      }),
      fetchWindow: async () => ({
        messages: [],
        hasMoreBefore: false,
        hasMoreAfter: false,
        contiguous: false,
      }),
    });
    let error: WindowControllerError | null = null;
    try {
      await broken.loadTip();
    } catch (e) {
      error = e as WindowControllerError;
    }
    expect(error?.failure).toBe("incomplete-slice");

    // And a failed NAVIGATION on a controller that already holds a valid window
    // keeps that window — the incomplete walk never replaces it.
    const failing = new WindowController({
      limit: 50,
      anchors: () => ({
        top: { messageId: "m498", offset: 0 },
        bottom: { messageId: "m500", offset: 0 },
      }),
      fetchWindow: async (request) => {
        const slice = sliceOf(request, 50);
        return request.anchorId === null ? slice : { ...slice, contiguous: false };
      },
    });
    await failing.loadTip();
    const live = failing.windowIds();
    await failing.loadOlder().catch(() => {});
    expect(failing.windowIds()).toEqual(live);
    expect(before[0]).toBe("m451");
  });

  it("O. concurrent navigation keeps the window self-consistent", async () => {
    const { controller } = makeController();
    await controller.loadTip();
    await Promise.allSettled([controller.loadOlder(), controller.goHistorical("m200")]);
    const ids = controller.windowIds();
    expect(new Set(ids).size).toBe(ids.length);
    expect(controller.repositorySeed().messages).toHaveLength(ids.length);
  });
});

/**
 * An empty conversation is a VALID state, and it is a different state from a
 * failed load.
 *
 * The backend answers a zero-message conversation with
 * `{ messages: [], contiguous: true, complete: false }`. `contiguous` is the
 * integrity signal ("did the walk hold together?"), and no walk starts when the
 * conversation holds nothing — so the empty set is the truth, not a hole.
 *
 * The bug this pins: while the backend reported that same empty answer as
 * `contiguous: false`, `#commit` rejected it BEFORE reaching its empty-slice
 * branch, `loadTip()` threw `incomplete-slice`, and the adapter recorded a
 * FAILED history load for a thread that had never held anything. The controller
 * already had an `allowEmpty` branch written for exactly this case; it was
 * unreachable behind the integrity guard.
 */
describe("P2 controller — an empty conversation is a valid state", () => {
  const emptyController = (over: Partial<WindowSliceResponse> = {}) =>
    new WindowController({
      limit: 50,
      fetchWindow: async () => ({
        messages: [],
        hasMoreBefore: false,
        hasMoreAfter: false,
        contiguous: true,
        complete: false,
        ...over,
      }),
    });

  it("loadTip() resolves with zero rows instead of throwing", async () => {
    const controller = emptyController();
    await expect(controller.loadTip()).resolves.toBeUndefined();

    expect(controller.rows()).toEqual([]);
    expect(controller.windowIds()).toEqual([]);
    expect(controller.hasMoreBefore).toBe(false);
    expect(controller.hasMoreAfter).toBe(false);
  });

  it("an empty tip is the ACTIVE window, not a historical one", async () => {
    const controller = emptyController();
    await controller.loadTip();
    expect(controller.historical).toBe(false);
    expect(controller.isActive).toBe(true);
  });

  it("repeated loads stay successful — the state is idempotent, not a latch", async () => {
    const controller = emptyController();
    for (let i = 0; i < 5; i += 1) {
      await expect(controller.loadTip()).resolves.toBeUndefined();
      expect(controller.rows()).toEqual([]);
    }
  });

  it("restoreTip() on an empty conversation is a successful no-op, not a failure", async () => {
    const controller = emptyController();
    await controller.loadTip();
    await expect(controller.restoreTip()).resolves.toBeUndefined();
    expect(controller.rows()).toEqual([]);
  });

  it("a genuine integrity failure is STILL rejected on an empty slice", async () => {
    // Fail-closed must survive the fix: `contiguous: false` means "do not
    // trust this", whatever the row count is. Only a PROVEN empty answer changed.
    const controller = emptyController({ contiguous: false });
    await expect(controller.loadTip()).rejects.toThrow(WindowControllerError);
  });
});

describe("P2 controller — write-back boundary", () => {
  it("J. write-back recovers every persisted message from bound runtime rows", async () => {
    const { controller } = makeController();
    await controller.loadTip();

    // The rows the runtime hands back are its own CONVERTED messages — bound by
    // upstream. Binding them here stands in for that upstream step, using the
    // public API so the module-local symbol is the shared one.
    const boundRow = (id: string, parentId: string | null) => {
      const message = { id, role: "assistant", content: [] } as unknown as Record<string, unknown>;
      bindExternalStoreMessage(
        message as never,
        {
          id,
          role: "assistant",
          parts: [{ type: "text", text: `body ${id}` }],
        } as never,
      );
      return { message, parentId };
    };

    // The first row handed to write-back is the window root, so its parent is
    // null (its real parent lies outside the bounded window) — exactly what the
    // repository seed hands upstream.
    const window = controller.writeBack([
      boundRow("m498", null),
      boundRow("m499", "m498"),
      boundRow("m500", "m499"),
    ]);

    expect(window.messages.map((m) => m.id)).toEqual(["m498", "m499", "m500"]);
    expect(Object.fromEntries(window.messages.map((m) => [m.id, m.parentId]))).toEqual({
      m498: null,
      m499: "m498",
      m500: "m499",
    });
    expect(window.headId).toBe("m500");
  });

  it("K. unbound rows fail closed instead of writing an empty window", async () => {
    const { controller } = makeController();
    await controller.loadTip();

    let error: WindowControllerError | null = null;
    try {
      controller.writeBack([{ message: { id: "m500" }, parentId: null }]);
    } catch (e) {
      error = e as WindowControllerError;
    }
    expect(error?.failure).toBe("write-back-unrecoverable");
    // The window survives a refused write-back.
    expect(controller.windowIds()).toHaveLength(50);
  });
});
