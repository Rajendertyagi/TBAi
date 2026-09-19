import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { computeBackoffDelay } from "../../lib/backoff";
import {
  useAvailabilityStore,
  resetAvailabilityForTests,
} from "./availabilityStore";
import { registerAvailabilityRecovery } from "./recovery";
import {
  createRemoteThreadListAdapter,
  invalidateThreadListCache,
} from "../../adapters/remoteThreadListAdapter";
import {
  createThreadHistoryAdapter,
  invalidateHistoryCache,
} from "../../adapters/threadHistoryAdapter";
import { useSettingsStore } from "../../stores";
import { statusBarConfig } from "../../config/statusBar";
import {
  readComposerDraft,
  writeComposerDraft,
} from "../chat/state/composerDraft";
import type { ProviderConfig } from "../../types";

const realFetch = globalThis.fetch;

function okJson(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function errJson(status: number): Response {
  return { ok: false, status, json: async () => ({ error: "x" }) } as Response;
}

function networkDown(): typeof fetch {
  return (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
}

/** Flush pending microtasks deterministically (no timers, no sleeps). */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function makeProvider(id: string, isActive: boolean): ProviderConfig {
  return {
    id,
    name: id,
    type: "openai",
    model: `model-${id}`,
    isActive,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function installMemoryStorage(): () => void {
  const holder = globalThis as unknown as { localStorage?: unknown };
  const prev = holder.localStorage;
  const store = new Map<string, string>();
  holder.localStorage = {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  };
  return () => {
    if (prev === undefined) delete holder.localStorage;
    else holder.localStorage = prev;
  };
}

beforeEach(() => {
  resetAvailabilityForTests();
  invalidateThreadListCache();
  invalidateHistoryCache();
  useSettingsStore.setState({
    providers: [],
    activeProviderId: null,
    selectedProviderId: null,
    selectedModelId: null,
    selectedReasoningLevel: null,
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetAvailabilityForTests();
  invalidateThreadListCache();
  invalidateHistoryCache();
});

describe("computeBackoffDelay bounds (Phase 3.2)", () => {
  const realRandom = Math.random;

  afterEach(() => {
    Math.random = realRandom;
  });

  it("[P3-backoff-a] attempt 0 caps at baseMs (jitter range [0, base])", () => {
    Math.random = () => 0.999999;
    expect(computeBackoffDelay(0, { baseMs: 1000, maxMs: 30000 })).toBe(1000);
    Math.random = () => 0;
    expect(computeBackoffDelay(0, { baseMs: 1000, maxMs: 30000 })).toBe(0);
  });

  it("[P3-backoff-b] grows exponentially until the maxMs ceiling", () => {
    Math.random = () => 0.999999;
    expect(computeBackoffDelay(1, { baseMs: 1000, maxMs: 30000 })).toBe(2000);
    expect(computeBackoffDelay(2, { baseMs: 1000, maxMs: 30000 })).toBe(4000);
    expect(computeBackoffDelay(10, { baseMs: 1000, maxMs: 30000 })).toBe(30000);
    expect(computeBackoffDelay(100, { baseMs: 1000, maxMs: 30000 })).toBe(30000);
  });

  it("[P3-backoff-c] honors a custom factor and clamps negative attempts to 0", () => {
    Math.random = () => 0.999999;
    expect(
      computeBackoffDelay(2, { baseMs: 100, maxMs: 10000, factor: 3 }),
    ).toBe(900);
    expect(computeBackoffDelay(-5, { baseMs: 1000, maxMs: 30000 })).toBe(1000);
  });

  it("[P3-backoff-d] unmocked samples stay within [0, cap]", () => {
    Math.random = realRandom;
    for (let i = 0; i < 100; i++) {
      const d = computeBackoffDelay(2, { baseMs: 1000, maxMs: 30000 });
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(4000);
    }
  });
});

describe("availability poller — /readyz mapping (Phase 3.1/3.2)", () => {
  it("[P3-01] healthy /readyz (200 + ready:true) → online", async () => {
    globalThis.fetch = (async () =>
      okJson(200, { ready: true })) as unknown as typeof fetch;
    await useAvailabilityStore.getState().probeNow();
    const s = useAvailabilityStore.getState();
    expect(s.status).toBe("online");
    expect(s.consecutiveFailures).toBe(0);
    expect(s.reason).toBeNull();
    expect(typeof s.checkedAt).toBe("number");
  });

  it("[P3-01b] reachable-but-not-ready (200 + ready:false) → degraded, never offline", async () => {
    globalThis.fetch = (async () =>
      okJson(200, { ready: false })) as unknown as typeof fetch;
    await useAvailabilityStore.getState().probeNow();
    await useAvailabilityStore.getState().probeNow();
    const s = useAvailabilityStore.getState();
    expect(s.status).toBe("degraded");
    expect(s.reason).toBe("readyz-not-ready");
    expect(s.consecutiveFailures).toBe(0);
    expect(s.recoveryEpoch).toBe(0);
  });

  it("[P3-02] network failure ×1 → degraded, ×2 consecutive → offline", async () => {
    globalThis.fetch = networkDown();
    await useAvailabilityStore.getState().probeNow();
    let s = useAvailabilityStore.getState();
    expect(s.status).toBe("degraded");
    expect(s.consecutiveFailures).toBe(1);
    expect(s.reason).toBe("network-failure-once");
    expect(s.recoveryEpoch).toBe(0);

    await useAvailabilityStore.getState().probeNow();
    s = useAvailabilityStore.getState();
    expect(s.status).toBe("offline");
    expect(s.consecutiveFailures).toBe(2);
    expect(s.reason).toBe("network-failure");
    expect(s.recoveryEpoch).toBe(0);
  });

  it("[P3-03] 400/404/409/422/5xx on /readyz → degraded, NEVER offline", async () => {
    for (const status of [400, 404, 409, 422, 500, 503]) {
      resetAvailabilityForTests();
      globalThis.fetch = (async () => errJson(status)) as unknown as typeof fetch;
      // Two consecutive probes: an app-level status must never escalate.
      await useAvailabilityStore.getState().probeNow();
      await useAvailabilityStore.getState().probeNow();
      const s = useAvailabilityStore.getState();
      expect(s.status).toBe("degraded");
      expect(s.consecutiveFailures).toBe(0);
      expect(s.recoveryEpoch).toBe(0);
    }
  });
});

describe("availability recovery transitions (Phase 3.8)", () => {
  it("[P3-09] degraded→online bumps recoveryEpoch and runs recovery listeners", async () => {
    globalThis.fetch = networkDown();
    await useAvailabilityStore.getState().probeNow();
    expect(useAvailabilityStore.getState().status).toBe("degraded");

    let calls = 0;
    const unsub = useAvailabilityStore
      .getState()
      .onRecovered(() => {
        calls += 1;
      });
    globalThis.fetch = (async () =>
      okJson(200, { ready: true })) as unknown as typeof fetch;
    await useAvailabilityStore.getState().probeNow();

    expect(useAvailabilityStore.getState().status).toBe("online");
    expect(useAvailabilityStore.getState().recoveryEpoch).toBe(1);
    expect(calls).toBe(1);
    unsub();
  });

  it("[P3-09b] a throwing listener is isolated — remaining listeners still run", async () => {
    globalThis.fetch = networkDown();
    await useAvailabilityStore.getState().probeNow();

    let survivorCalls = 0;
    const unsub1 = useAvailabilityStore.getState().onRecovered(() => {
      throw new Error("listener boom");
    });
    const unsub2 = useAvailabilityStore
      .getState()
      .onRecovered(() => {
        survivorCalls += 1;
      });
    globalThis.fetch = (async () =>
      okJson(200, { ready: true })) as unknown as typeof fetch;
    await useAvailabilityStore.getState().probeNow();

    expect(useAvailabilityStore.getState().status).toBe("online");
    expect(survivorCalls).toBe(1);
    unsub1();
    unsub2();
  });

  it("[P3-10] concurrent recoveries coalesce — singleflight runs the listener once", async () => {
    // Settle online first (boot transition consumes epoch 1, no listeners).
    globalThis.fetch = (async () =>
      okJson(200, { ready: true })) as unknown as typeof fetch;
    await useAvailabilityStore.getState().probeNow();
    expect(useAvailabilityStore.getState().recoveryEpoch).toBe(1);

    useAvailabilityStore.setState({ status: "degraded", consecutiveFailures: 1 });

    // Deferred /readyz so the two probes can overlap inside one recovery.
    const resolvers: Array<(res: Response) => void> = [];
    globalThis.fetch = ((url: unknown) => {
      if (String(url) === "/readyz") {
        return new Promise<Response>((resolve) => {
          resolvers.push(resolve);
        });
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    }) as unknown as typeof fetch;

    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const unsub = useAvailabilityStore.getState().onRecovered(async () => {
      runs += 1;
      await gate;
    });

    const p1 = useAvailabilityStore.getState().probeNow();
    expect(resolvers.length).toBe(1);
    resolvers[0](okJson(200, { ready: true }));
    await flush();
    expect(runs).toBe(1);

    // A second offline→online transition starts while the first recovery is
    // still in flight: it must await the running recovery, not re-run it.
    useAvailabilityStore.setState({
      status: "degraded",
      consecutiveFailures: 1,
    });
    const p2 = useAvailabilityStore.getState().probeNow();
    expect(resolvers.length).toBe(2);
    resolvers[1](okJson(200, { ready: true }));
    await flush();

    release();
    await p1;
    await p2;
    expect(runs).toBe(1);
    expect(useAvailabilityStore.getState().recoveryEpoch).toBe(3);
    unsub();
  });
});

describe("availability copy presence (Phase 3.3)", () => {
  it("[P3-copy] status-bar availability copy never presents cache as authoritative", () => {
    expect(statusBarConfig.copy.availabilityOnline.length).toBeGreaterThan(0);
    expect(statusBarConfig.copy.availabilityDegraded).toContain("…");
    expect(statusBarConfig.copy.availabilityDegradedTitle).toContain(
      "last known",
    );
    expect(statusBarConfig.copy.availabilityOffline).toBe("Offline");
    expect(statusBarConfig.copy.availabilityOfflineTitle).toContain(
      "last known",
    );
  });
});

describe("outage integration — stale retained, restore refreshes (e2e-equivalent path)", () => {
  it("[P3-int] down → stale list/history/providers + draft kept → restore → authoritative refresh, no resend", async () => {
    const restoreStorage = installMemoryStorage();
    try {
      const dto = (id: string, title: string) => ({
        id,
        title,
        status: "regular",
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-02T00:00:00.000Z",
      });
      const storedMessage = {
        id: "m1",
        parent_id: null,
        format: "raw",
        content: { kind: "text", text: "hello" },
      };
      let down = false;
      let providers: ProviderConfig[] = [makeProvider("p1", true)];
      let threads: unknown[] = [dto("c1", "T1")];
      let messages: unknown[] = [storedMessage];
      const calls: string[] = [];
      globalThis.fetch = (async (url: unknown) => {
        const u = String(url);
        calls.push(u);
        if (down) throw new TypeError("fetch failed");
        if (u === "/readyz") return okJson(200, { ready: true });
        if (u === "/api/providers") return okJson(200, providers);
        if (u === "/api/conversations/c1/messages")
          return okJson(200, { messages });
        if (u.startsWith("/api/conversations?"))
          return okJson(200, { threads, nextCursor: null });
        throw new Error(`unexpected fetch ${u}`);
      }) as unknown as typeof fetch;

      const listAdapter = createRemoteThreadListAdapter();
      const historyAdapter = createThreadHistoryAdapter(() => ({
        threadListItem: {
          getState: () => ({ remoteId: "c1" }),
          initialize: async () => ({ remoteId: "c1" }),
        },
      }));

      // Seed last-good caches + providers while healthy.
      useSettingsStore.getState().setProviders(providers);
      const seeded = await listAdapter.list();
      expect(seeded.threads.map((t) => t.remoteId)).toEqual(["c1"]);
      const seededHistory = await historyAdapter.load();
      expect(seededHistory.messages).toHaveLength(1);
      writeComposerDraft("c1", "unsent hello");

      const unsubRecovery = registerAvailabilityRecovery();

      // Backend goes down: degraded then offline, everything retained.
      down = true;
      await useAvailabilityStore.getState().probeNow();
      expect(useAvailabilityStore.getState().status).toBe("degraded");
      await useAvailabilityStore.getState().probeNow();
      expect(useAvailabilityStore.getState().status).toBe("offline");

      const staleList = await listAdapter.list();
      expect(staleList.threads.map((t) => t.remoteId)).toEqual(["c1"]);
      const staleHistory = await historyAdapter.load();
      expect(staleHistory.messages).toHaveLength(1);
      await useSettingsStore.getState().loadProviders();
      expect(
        useSettingsStore.getState().providers.map((p) => p.id),
      ).toEqual(["p1"]);
      expect(readComposerDraft("c1")?.text).toBe("unsent hello");

      // Backend returns with NEW authoritative state (empty + new provider).
      down = false;
      providers = [makeProvider("p2", true)];
      threads = [];
      messages = [];
      await useAvailabilityStore.getState().probeNow();

      const s = useAvailabilityStore.getState();
      expect(s.status).toBe("online");
      expect(s.recoveryEpoch).toBe(1);
      // Coordinated recovery reloaded providers (failure-tolerant, ran here).
      expect(
        useSettingsStore.getState().providers.map((p) => p.id),
      ).toEqual(["p2"]);
      // Fresh reads are authoritative: stale cache was replaced, not merged.
      expect((await listAdapter.list()).threads).toEqual([]);
      expect((await historyAdapter.load()).messages).toEqual([]);

      // Invalidation proof: with the backend down again, there is no stale
      // projection left to serve — recovery cleared the last-good caches.
      down = true;
      expect((await listAdapter.list()).threads).toEqual([]);
      expect((await historyAdapter.load()).messages).toEqual([]);

      // [P3-19] recovery never auto-resends: no chat/transport fetch happened.
      expect(
        calls.some((u) => u.includes("/api/chat")),
      ).toBe(false);
      // [P3-20] the saved composer draft survived the whole sequence untouched.
      expect(readComposerDraft("c1")?.text).toBe("unsent hello");

      unsubRecovery();
    } finally {
      restoreStorage();
    }
  });
});
