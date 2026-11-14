/**
 * Shared OpenCode capabilities hook/store behavior (LIB-IMPL-03).
 *
 * Covers: failed refresh retains previous catalogue, simultaneous consumers
 * share one request, reuse of valid shared state, recovery epoch triggers one
 * authoritative refresh, stale-response protection, disabled/unmount/remount
 * behavior, normalization/validation parity, and StrictMode safety.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { StrictMode, act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let fetchCalls = 0;
let fetchQueue: Array<Deferred<Response>> = [];

const platform = await import("@web/lib/platform.ts");
mock.module("@web/lib/platform.ts", () => ({
  ...platform,
  apiFetch: async () => {
    fetchCalls += 1;
    const next = fetchQueue.shift();
    if (!next) throw new Error("no stubbed capabilities response queued");
    return next.promise;
  },
}));

const { useOpenCodeCapabilities, resetCapabilitiesStoreForTests } = await import(
  "@web/features/opencode/useOpenCodeCapabilities.ts"
);
const { useAvailabilityStore } = await import("@web/features/availability/availabilityStore.ts");

interface HookState {
  agents: readonly { id: string }[];
  models: readonly {
    id: string;
    variants?: readonly string[];
    limit?: { context: number; output: number };
  }[];
  defaultModel?: { providerID: string; modelID: string; name: string };
  error: string | null;
  isLoading: boolean;
}

function capabilitiesResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function failingResponse(message = "the server went away", status = 503): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function render(ui: React.ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  return {
    container,
    root,
    async mount() {
      await act(async () => {
        root.render(ui);
      });
      await flush();
    },
    async rerender(next: React.ReactElement) {
      await act(async () => {
        root.render(next);
      });
      await flush();
    },
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      await flush();
    },
  };
}

function Consumer({
  enabled = true,
  onState,
}: {
  enabled?: boolean;
  onState: (state: HookState) => void;
}) {
  const state = useOpenCodeCapabilities(enabled);
  useEffect(() => {
    onState({
      agents: state.agents,
      models: state.models,
      defaultModel: state.defaultModel,
      error: state.error,
      isLoading: state.isLoading,
    });
  }, [onState, state.agents, state.models, state.defaultModel, state.error, state.isLoading]);
  return null;
}

beforeEach(() => {
  fetchCalls = 0;
  fetchQueue = [];
  resetCapabilitiesStoreForTests();
  useAvailabilityStore.setState({ recoveryEpoch: 0 });
});

afterEach(() => {
  resetCapabilitiesStoreForTests();
  useAvailabilityStore.setState({ recoveryEpoch: 0 });
});

describe("useOpenCodeCapabilities shared store", () => {
  it("keeps the previous catalogue and reports the error on failed refresh", async () => {
    let latest: HookState = { agents: [], models: [], error: null, isLoading: false };
    const first = deferred<Response>();
    const second = deferred<Response>();
    fetchQueue.push(first, second);
    const view = render(createElement(Consumer, { onState: (s) => (latest = s) }));
    await view.mount();

    first.resolve(
      capabilitiesResponse({
        agents: [{ id: "build", name: "build" }],
        models: [{ id: "model-a", name: "Model A", providerID: "prov", variants: ["high"] }],
      }),
    );
    await flush();
    expect(latest.models.map((m) => m.id)).toEqual(["model-a"]);
    expect(latest.error).toBeNull();

    await act(async () => {
      useAvailabilityStore.setState((state) => ({ recoveryEpoch: state.recoveryEpoch + 1 }));
    });
    await flush();
    expect(fetchCalls).toBe(2);

    second.resolve(failingResponse());
    await flush();
    expect(latest.error).toBe("the server went away");
    expect(latest.models.map((m) => m.id)).toEqual(["model-a"]);
    expect(latest.agents.map((a) => a.id)).toEqual(["build"]);

    await view.unmount();
  });

  it("dedupes five simultaneous consumers into one request and shares state", async () => {
    const states = Array.from({ length: 5 }, () => ({
      current: { agents: [], models: [], error: null, isLoading: false } as HookState,
    }));
    const req = deferred<Response>();
    fetchQueue.push(req);
    const view = render(
      createElement(
        "div",
        null,
        ...states.map((slot, i) =>
          createElement(Consumer, {
            key: i,
            onState: (s) => {
              slot.current = s;
            },
          }),
        ),
      ),
    );
    await view.mount();
    expect(fetchCalls).toBe(1);
    expect(states.every((s) => s.current.isLoading)).toBe(true);

    req.resolve(
      capabilitiesResponse({
        agents: [{ id: "build", name: "build" }],
        models: [{ id: "m1", name: "M1", providerID: "p", variants: [] }],
      }),
    );
    await flush();
    for (const slot of states) {
      expect(slot.current.models.map((m) => m.id)).toEqual(["m1"]);
      expect(slot.current.agents.map((a) => a.id)).toEqual(["build"]);
      expect(slot.current.error).toBeNull();
      expect(slot.current.isLoading).toBe(false);
    }

    await view.unmount();
  });

  it("reuses valid shared state for a subsequent consumer without a new request", async () => {
    let first: HookState = { agents: [], models: [], error: null, isLoading: false };
    let second: HookState = { agents: [], models: [], error: null, isLoading: false };
    const req = deferred<Response>();
    fetchQueue.push(req);
    const view = render(createElement(Consumer, { onState: (s) => (first = s) }));
    await view.mount();
    req.resolve(
      capabilitiesResponse({
        agents: [{ id: "a", name: "A" }],
        models: [{ id: "m", name: "M", providerID: "p", variants: [] }],
      }),
    );
    await flush();
    expect(fetchCalls).toBe(1);
    expect(first.models.map((m) => m.id)).toEqual(["m"]);

    await view.rerender(
      createElement(
        "div",
        null,
        createElement(Consumer, { key: "first", onState: (s) => (first = s) }),
        createElement(Consumer, { key: "second", onState: (s) => (second = s) }),
      ),
    );
    await flush();
    expect(fetchCalls).toBe(1);
    expect(second.models.map((m) => m.id)).toEqual(["m"]);
    expect(second.agents.map((a) => a.id)).toEqual(["a"]);

    await view.unmount();
  });

  it("triggers exactly one authoritative refresh across active consumers on recovery epoch change", async () => {
    const states = Array.from({ length: 3 }, () => ({
      current: { agents: [], models: [], error: null, isLoading: false } as HookState,
    }));
    const first = deferred<Response>();
    const second = deferred<Response>();
    fetchQueue.push(first, second);
    const view = render(
      createElement(
        "div",
        null,
        ...states.map((slot, i) =>
          createElement(Consumer, {
            key: i,
            onState: (s) => {
              slot.current = s;
            },
          }),
        ),
      ),
    );
    await view.mount();
    first.resolve(
      capabilitiesResponse({
        agents: [],
        models: [{ id: "old", name: "Old", providerID: "p", variants: [] }],
      }),
    );
    await flush();
    expect(fetchCalls).toBe(1);

    await act(async () => {
      useAvailabilityStore.setState((state) => ({ recoveryEpoch: state.recoveryEpoch + 1 }));
    });
    await flush();
    expect(fetchCalls).toBe(2);

    second.resolve(
      capabilitiesResponse({
        agents: [],
        models: [{ id: "new", name: "New", providerID: "p", variants: [] }],
      }),
    );
    await flush();
    for (const slot of states) {
      expect(slot.current.models.map((m) => m.id)).toEqual(["new"]);
      expect(slot.current.error).toBeNull();
    }

    await view.unmount();
  });

  it("does not let an outdated response overwrite a newer recovery result", async () => {
    let latest: HookState = { agents: [], models: [], error: null, isLoading: false };
    const first = deferred<Response>();
    const second = deferred<Response>();
    fetchQueue.push(first, second);
    const view = render(createElement(Consumer, { onState: (s) => (latest = s) }));
    await view.mount();
    expect(fetchCalls).toBe(1);

    await act(async () => {
      useAvailabilityStore.setState((state) => ({ recoveryEpoch: state.recoveryEpoch + 1 }));
    });
    await flush();
    expect(fetchCalls).toBe(2);

    // Newer recovery response arrives first.
    second.resolve(
      capabilitiesResponse({
        agents: [],
        models: [{ id: "new", name: "New", providerID: "p", variants: [] }],
      }),
    );
    await flush();
    expect(latest.models.map((m) => m.id)).toEqual(["new"]);

    // Older in-flight response arrives later and must be ignored.
    first.resolve(
      capabilitiesResponse({
        agents: [],
        models: [{ id: "old", name: "Old", providerID: "p", variants: [] }],
      }),
    );
    await flush();
    expect(latest.models.map((m) => m.id)).toEqual(["new"]);

    await view.unmount();
  });

  it("disabled consumers do not initiate requests and return empty local state", async () => {
    let latest: HookState = { agents: [], models: [], error: null, isLoading: false };
    const view = render(createElement(Consumer, { enabled: false, onState: (s) => (latest = s) }));
    await view.mount();
    await flush();
    expect(fetchCalls).toBe(0);
    expect(latest.agents).toEqual([]);
    expect(latest.models).toEqual([]);
    expect(latest.defaultModel).toBeUndefined();
    expect(latest.error).toBeNull();
    expect(latest.isLoading).toBe(false);
    await view.unmount();
  });

  it("unmounting one consumer does not break others or clear shared data", async () => {
    let b: HookState = { agents: [], models: [], error: null, isLoading: false };
    const req = deferred<Response>();
    fetchQueue.push(req);
    const view = render(
      createElement(
        "div",
        null,
        createElement(Consumer, { key: "a", onState: () => {} }),
        createElement(Consumer, { key: "b", onState: (s) => (b = s) }),
      ),
    );
    await view.mount();
    expect(fetchCalls).toBe(1);

    await view.rerender(createElement(Consumer, { key: "b", onState: (s) => (b = s) }));
    await flush();
    req.resolve(
      capabilitiesResponse({
        agents: [{ id: "x", name: "X" }],
        models: [{ id: "m", name: "M", providerID: "p", variants: [] }],
      }),
    );
    await flush();
    expect(b.models.map((m) => m.id)).toEqual(["m"]);
    expect(b.agents.map((a) => a.id)).toEqual(["x"]);

    await view.unmount();
  });

  it("remounts after all consumers disappear and fetches when needed", async () => {
    let latest: HookState = { agents: [], models: [], error: null, isLoading: false };
    const first = deferred<Response>();
    const second = deferred<Response>();
    fetchQueue.push(first, second);
    const view = render(createElement(Consumer, { onState: (s) => (latest = s) }));
    await view.mount();
    first.resolve(
      capabilitiesResponse({
        agents: [],
        models: [{ id: "m1", name: "M1", providerID: "p", variants: [] }],
      }),
    );
    await flush();
    expect(fetchCalls).toBe(1);

    await view.unmount();
    // Recovery while no active consumers should force a fresh fetch on next mount.
    await act(async () => {
      useAvailabilityStore.setState((state) => ({ recoveryEpoch: state.recoveryEpoch + 1 }));
    });

    const view2 = render(createElement(Consumer, { onState: (s) => (latest = s) }));
    await view2.mount();
    expect(fetchCalls).toBe(2);
    second.resolve(
      capabilitiesResponse({
        agents: [],
        models: [{ id: "m2", name: "M2", providerID: "p", variants: [] }],
      }),
    );
    await flush();
    expect(latest.models.map((m) => m.id)).toEqual(["m2"]);
    await view2.unmount();
  });

  it("preserves normalization and validation behavior", async () => {
    let latest: HookState = { agents: [], models: [], error: null, isLoading: false };
    const req = deferred<Response>();
    fetchQueue.push(req);
    const view = render(createElement(Consumer, { onState: (s) => (latest = s) }));
    await view.mount();
    req.resolve(
      capabilitiesResponse({
        agents: [{ id: "a", name: "A" }],
        models: [
          {
            id: "m1",
            name: "M1",
            providerID: "p",
            // variants omitted -> normalized to []
            limit: { context: 4096.9, output: 512.1 },
          },
          {
            id: "m2",
            name: "M2",
            providerID: "p",
            variants: ["fast"],
            limit: { context: -1, output: 10 },
          },
        ],
        defaultModel: { providerID: "p", modelID: "m1" }, // name falls back to modelID
      }),
    );
    await flush();

    expect(latest.models[0]?.variants).toEqual([]);
    expect(latest.models[0]?.limit).toEqual({ context: 4096, output: 512 });
    expect(latest.models[1]?.variants).toEqual(["fast"]);
    expect(latest.models[1]?.limit).toBeUndefined();
    expect(latest.defaultModel).toEqual({ providerID: "p", modelID: "m1", name: "m1" });

    await view.unmount();
  });

  it("does not create duplicate active requests under StrictMode", async () => {
    let latest: HookState = { agents: [], models: [], error: null, isLoading: false };
    const req = deferred<Response>();
    fetchQueue.push(req);
    const view = render(
      createElement(StrictMode, null, createElement(Consumer, { onState: (s) => (latest = s) })),
    );
    await view.mount();
    expect(fetchCalls).toBe(1);
    req.resolve(
      capabilitiesResponse({
        agents: [],
        models: [{ id: "m", name: "M", providerID: "p", variants: [] }],
      }),
    );
    await flush();
    expect(latest.models.map((m) => m.id)).toEqual(["m"]);
    expect(latest.error).toBeNull();
    await view.unmount();
  });
});
