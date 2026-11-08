import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

type SetZoom = (zoom: number) => Promise<void>;

let setZoomImpl: SetZoom = async () => {};
const setZoomCalls: number[] = [];
let activeSetZoom = 0;
let maxActiveSetZoom = 0;

mock.module("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    setZoom: async (zoom: number) => {
      setZoomCalls.push(zoom);
      activeSetZoom++;
      maxActiveSetZoom = Math.max(maxActiveSetZoom, activeSetZoom);
      try {
        await setZoomImpl(zoom);
      } finally {
        activeSetZoom--;
      }
    },
  }),
}));

const platform = await import("@web/lib/platform");

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setTauri(enabled: boolean) {
  if (enabled) {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  } else {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  }
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

describe("window zoom queue (platform)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    setTauri(true);
    setZoomImpl = async () => {};
    setZoomCalls.length = 0;
    activeSetZoom = 0;
    maxActiveSetZoom = 0;
    platform.__resetZoomQueueForTests();
  });

  afterEach(() => {
    setTauri(false);
    window.localStorage.clear();
  });

  it("applies a single successful request and commits confirmed state", async () => {
    const result = await platform.requestWindowZoom(1.5);
    expect(result).toEqual({ status: "applied", zoom: 1.5 });
    expect(setZoomCalls).toEqual([1.5]);
    expect(platform.getConfirmedWindowZoom()).toBe(1.5);
    expect(platform.readWindowZoom()).toBe(1.5);
    expect(platform.getTargetWindowZoom()).toBe(1.5);
  });

  it("returns failed with requested target on native rejection and retains confirmed state", async () => {
    await platform.requestWindowZoom(1.25);
    setZoomImpl = async () => {
      throw new Error("boom");
    };
    const result = await platform.requestWindowZoom(1.75);
    expect(result).toEqual({ status: "failed", zoom: 1.75 });
    expect(platform.getConfirmedWindowZoom()).toBe(1.25);
    expect(platform.readWindowZoom()).toBe(1.25);
  });

  it("serializes native operations (no overlap)", async () => {
    const a = deferred();
    const b = deferred();
    setZoomImpl = async (zoom) => {
      if (zoom === 1.25) await a.promise;
      if (zoom === 1.5) await b.promise;
    };
    const p1 = platform.requestWindowZoom(1.25);
    const p2 = platform.requestWindowZoom(1.5);
    await flushMicrotasks();
    expect(setZoomCalls).toEqual([1.25]);
    a.resolve();
    await flushMicrotasks();
    expect(setZoomCalls).toEqual([1.25, 1.5]);
    b.resolve();
    expect(await p1).toEqual({ status: "superseded", zoom: 1.25 });
    expect(await p2).toEqual({ status: "applied", zoom: 1.5 });
    expect(maxActiveSetZoom).toBe(1);
    expect(platform.getConfirmedWindowZoom()).toBe(1.5);
  });

  it("replaces pending request: only latest pending executes and replaced caller is superseded", async () => {
    const a = deferred();
    const c = deferred();
    setZoomImpl = async (zoom) => {
      if (zoom === 1.25) await a.promise;
      if (zoom === 2) await c.promise;
    };
    const pA = platform.requestWindowZoom(1.25);
    const pB = platform.requestWindowZoom(1.5);
    const pC = platform.requestWindowZoom(2);
    await flushMicrotasks();
    expect(setZoomCalls).toEqual([1.25]);
    a.resolve();
    expect(await pB).toEqual({ status: "superseded", zoom: 1.5 });
    await flushMicrotasks();
    expect(setZoomCalls).toEqual([1.25, 2]);
    c.resolve();
    expect(await pA).toEqual({ status: "superseded", zoom: 1.25 });
    expect(await pC).toEqual({ status: "applied", zoom: 2 });
    expect(platform.getConfirmedWindowZoom()).toBe(2);
  });

  it("commits overtaken native success and resolves overtaken caller as superseded (F-1 core)", async () => {
    const a = deferred();
    const b = deferred();
    setZoomImpl = async (zoom) => {
      if (zoom === 1.5) await a.promise;
      if (zoom === 2) await b.promise;
    };
    const pA = platform.requestWindowZoom(1.5);
    await flushMicrotasks();
    const pB = platform.requestWindowZoom(2);
    a.resolve();
    expect(await pA).toEqual({ status: "superseded", zoom: 1.5 });
    expect(platform.getConfirmedWindowZoom()).toBe(1.5);
    expect(platform.readWindowZoom()).toBe(1.5);
    b.resolve();
    expect(await pB).toEqual({ status: "applied", zoom: 2 });
    expect(platform.getConfirmedWindowZoom()).toBe(2);
  });

  it("keeps last successful native zoom when latest fails after overtaken success (critical F-1)", async () => {
    window.localStorage.setItem(platform.WINDOW_ZOOM_STORAGE_KEY, "1");
    platform.__resetZoomQueueForTests();
    const a = deferred();
    setZoomImpl = async (zoom) => {
      if (zoom === 1.5) await a.promise;
      if (zoom === 2) throw new Error("latest failed");
    };
    const pA = platform.requestWindowZoom(1.5);
    await flushMicrotasks();
    const pB = platform.requestWindowZoom(2);
    a.resolve();
    expect(await pA).toEqual({ status: "superseded", zoom: 1.5 });
    expect(await pB).toEqual({ status: "failed", zoom: 2 });
    expect(setZoomCalls).toEqual([1.5, 2]);
    expect(platform.getConfirmedWindowZoom()).toBe(1.5);
    expect(platform.readWindowZoom()).toBe(1.5);
    expect(platform.getTargetWindowZoom()).toBe(1.5);
  });

  it("attempts already-pending latest after active native failure", async () => {
    const a = deferred();
    setZoomImpl = async (zoom) => {
      if (zoom === 1.25) {
        await a.promise;
        throw new Error("active failed");
      }
    };
    const pA = platform.requestWindowZoom(1.25);
    const pB = platform.requestWindowZoom(1.5);
    await flushMicrotasks();
    a.resolve();
    expect(await pA).toEqual({ status: "failed", zoom: 1.25 });
    expect(await pB).toEqual({ status: "applied", zoom: 1.5 });
    expect(setZoomCalls).toEqual([1.25, 1.5]);
    expect(platform.getConfirmedWindowZoom()).toBe(1.5);
  });

  it("settles every replaced pending caller exactly once", async () => {
    const a = deferred();
    const d = deferred();
    setZoomImpl = async (zoom) => {
      if (zoom === 1.25) await a.promise;
      if (zoom === 2.5) await d.promise;
    };
    const pA = platform.requestWindowZoom(1.25);
    const pB = platform.requestWindowZoom(1.5);
    const pC = platform.requestWindowZoom(1.75);
    const pD = platform.requestWindowZoom(2.5);
    a.resolve();
    d.resolve();
    const results = await Promise.all([pA, pB, pC, pD]);
    expect(results).toEqual([
      { status: "superseded", zoom: 1.25 },
      { status: "superseded", zoom: 1.5 },
      { status: "superseded", zoom: 1.75 },
      { status: "applied", zoom: 2.5 },
    ]);
    expect(platform.getConfirmedWindowZoom()).toBe(2.5);
  });

  it("uses latest requested target while active/pending and confirmed when idle", async () => {
    const a = deferred();
    setZoomImpl = async (zoom) => {
      if (zoom === 1.25) await a.promise;
    };
    const pA = platform.requestWindowZoom(1.25);
    await flushMicrotasks();
    const pB = platform.requestWindowZoom(1.75);
    expect(platform.getTargetWindowZoom()).toBe(1.75);
    a.resolve();
    await Promise.all([pA, pB]);
    expect(platform.getTargetWindowZoom()).toBe(1.75);
    expect(platform.getConfirmedWindowZoom()).toBe(1.75);
  });

  it("keeps in-memory confirmed state when localStorage write fails", async () => {
    const original = window.localStorage.setItem.bind(window.localStorage);
    window.localStorage.setItem = ((key: string, value: string) => {
      if (key === platform.WINDOW_ZOOM_STORAGE_KEY) throw new Error("quota");
      return original(key, value);
    }) as typeof window.localStorage.setItem;
    try {
      const result = await platform.requestWindowZoom(1.5);
      expect(result).toEqual({ status: "applied", zoom: 1.5 });
      expect(platform.getConfirmedWindowZoom()).toBe(1.5);
    } finally {
      window.localStorage.setItem = original;
    }
  });

  it("browser mode fails without native calls, persistence, or notifications", async () => {
    setTauri(false);
    platform.__resetZoomQueueForTests();
    const events: number[] = [];
    const off = platform.onWindowZoomChange((z) => events.push(z));
    const result = await platform.requestWindowZoom(1.5);
    off();
    expect(result).toEqual({ status: "failed", zoom: 1.5 });
    expect(setZoomCalls).toEqual([]);
    expect(window.localStorage.getItem(platform.WINDOW_ZOOM_STORAGE_KEY)).toBeNull();
    expect(events).toEqual([]);
  });

  it("getConfirmedWindowZoom reads persisted state dynamically in browser mode", async () => {
    setTauri(false);
    window.localStorage.setItem(platform.WINDOW_ZOOM_STORAGE_KEY, "1.75");
    platform.__resetZoomQueueForTests();
    expect(platform.getConfirmedWindowZoom()).toBe(1.75);
    window.localStorage.setItem(platform.WINDOW_ZOOM_STORAGE_KEY, "2");
    expect(platform.getConfirmedWindowZoom()).toBe(2);
  });

  it("notifies same-window listeners only for confirmed native success", async () => {
    const events: number[] = [];
    const off = platform.onWindowZoomChange((z) => events.push(z));
    await platform.requestWindowZoom(1.25);
    setZoomImpl = async () => {
      throw new Error("fail");
    };
    await platform.requestWindowZoom(1.5);
    off();
    expect(events).toEqual([1.25]);
  });
});
