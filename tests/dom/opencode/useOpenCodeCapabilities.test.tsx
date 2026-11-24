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
const { publishRuntimeStatus, resetRuntimeTargetStoreForTests } = await import(
  "@web/features/opencode/runtimeStatus.ts"
);

const BID = "backend-instance";

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
  resetRuntimeTargetStoreForTests();
  useAvailabilityStore.setState({ recoveryEpoch: 0 });
});

afterEach(() => {
  resetCapabilitiesStoreForTests();
  resetRuntimeTargetStoreForTests();
  useAvailabilityStore.setState({ recoveryEpoch: 0 });
});

describe("useOpenCodeCapabilities shared store (managed-only)", () => {
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

  it("dedupes simultaneous consumers into one request and shares state", async () => {
    const states = Array.from({ length: 3 }, () => ({
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

    req.resolve(
      capabilitiesResponse({
        agents: [{ id: "build", name: "build" }],
        models: [{ id: "m1", name: "M1", providerID: "p", variants: [] }],
      }),
    );
    await flush();
    for (const slot of states) {
      expect(slot.current.models.map((m) => m.id)).toEqual(["m1"]);
      expect(slot.current.error).toBeNull();
    }
    await view.unmount();
  });

  it("dedupes many simultaneous consumers into one request when a target is known, then refreshes on a genuine target change", async () => {
    const consumerCount = 20;
    const states = Array.from({ length: consumerCount }, () => ({
      current: { agents: [], models: [], error: null, isLoading: false } as HookState,
    }));
    const first = deferred<Response>();
    const second = deferred<Response>();
    fetchQueue.push(first, second);
    publishRuntimeStatus({
      mode: "managed",
      backendInstanceId: BID,
      targetRevision: 1,
      targetId: 1,
    });
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

    first.resolve(
      capabilitiesResponse({
        agents: [],
        models: [{ id: "first", name: "First", providerID: "p", variants: [] }],
        target: { backendInstanceId: BID, targetRevision: 1, targetId: 1, mode: "managed" },
      }),
    );
    await flush();
    for (const slot of states) {
      expect(slot.current.models.map((m) => m.id)).toEqual(["first"]);
    }

    await act(async () => {
      publishRuntimeStatus({
        mode: "managed",
        backendInstanceId: BID,
        targetRevision: 2,
        targetId: 2,
      });
    });
    await flush();
    expect(fetchCalls).toBe(2);

    second.resolve(
      capabilitiesResponse({
        agents: [],
        models: [{ id: "second", name: "Second", providerID: "p", variants: [] }],
        target: { backendInstanceId: BID, targetRevision: 2, targetId: 2, mode: "managed" },
      }),
    );
    await flush();
    for (const slot of states) {
      expect(slot.current.models.map((m) => m.id)).toEqual(["second"]);
    }
    await view.unmount();
  });

  it("refreshes active consumers when target revision changes without recovery epoch change", async () => {
    let latest: HookState = { agents: [], models: [], error: null, isLoading: false };
    const first = deferred<Response>();
    const second = deferred<Response>();
    fetchQueue.push(first, second);
    publishRuntimeStatus({
      mode: "managed",
      backendInstanceId: BID,
      targetRevision: 1,
      targetId: 1,
    });
    const view = render(createElement(Consumer, { onState: (s) => (latest = s) }));
    await view.mount();
    first.resolve(
      capabilitiesResponse({
        agents: [],
        models: [{ id: "old", name: "Old", providerID: "p", variants: [] }],
        target: { backendInstanceId: BID, targetRevision: 1, targetId: 1, mode: "managed" },
      }),
    );
    await flush();
    expect(fetchCalls).toBe(1);

    await act(async () => {
      publishRuntimeStatus({
        mode: "managed",
        backendInstanceId: BID,
        targetRevision: 2,
        targetId: 2,
      });
    });
    await flush();
    expect(fetchCalls).toBe(2);
    expect(latest.models).toEqual([]);

    second.resolve(
      capabilitiesResponse({
        agents: [],
        models: [{ id: "new", name: "New", providerID: "p", variants: [] }],
        target: { backendInstanceId: BID, targetRevision: 2, targetId: 2, mode: "managed" },
      }),
    );
    await flush();
    expect(latest.models.map((m) => m.id)).toEqual(["new"]);
    await view.unmount();
  });

  it("does not let an old target response overwrite a newer target after replacement during in-flight request", async () => {
    let latest: HookState = { agents: [], models: [], error: null, isLoading: false };
    const oldReq = deferred<Response>();
    const newReq = deferred<Response>();
    fetchQueue.push(oldReq, newReq);
    publishRuntimeStatus({
      mode: "managed",
      backendInstanceId: BID,
      targetRevision: 1,
      targetId: 1,
    });
    const view = render(createElement(Consumer, { onState: (s) => (latest = s) }));
    await view.mount();
    expect(fetchCalls).toBe(1);

    await act(async () => {
      publishRuntimeStatus({
        mode: "managed",
        backendInstanceId: BID,
        targetRevision: 2,
        targetId: 2,
      });
    });
    await flush();
    expect(fetchCalls).toBe(2);

    newReq.resolve(
      capabilitiesResponse({
        agents: [],
        models: [{ id: "new-target", name: "New", providerID: "p", variants: [] }],
        target: { backendInstanceId: BID, targetRevision: 2, targetId: 2, mode: "managed" },
      }),
    );
    await flush();
    expect(latest.models.map((m) => m.id)).toEqual(["new-target"]);

    oldReq.resolve(
      capabilitiesResponse({
        agents: [],
        models: [{ id: "old-target", name: "Old", providerID: "p", variants: [] }],
        target: { backendInstanceId: BID, targetRevision: 1, targetId: 1, mode: "managed" },
      }),
    );
    await flush();
    expect(latest.models.map((m) => m.id)).toEqual(["new-target"]);
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
    await view.unmount();
  });
});
