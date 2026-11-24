import { afterEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useAvailabilityStore } from "@web/features/availability/availabilityStore.ts";
import {
  resetRuntimeTargetStoreForTests,
  useRuntimeTargetStore,
} from "@web/features/opencode/runtimeStatus.ts";
import { resetRuntimeTargetEventsForTests } from "@web/features/opencode/runtimeTargetEvents.ts";
import { resetStatusResourceForTests } from "@web/features/opencode/statusResource.ts";
import { useOpenCodeRuntimeStatus } from "@web/features/opencode/useOpenCodeRuntimeStatus.ts";

const BID = "backend-instance";
let nextResponse: { kind: "json"; body: unknown } | { kind: "fail"; message: string } = {
  kind: "json",
  body: { mode: "managed", backendInstanceId: BID, targetRevision: 1, targetId: 1 },
};
let requests: string[] = [];

const nativeFetch = globalThis.fetch;
const nativeEventSource = globalThis.EventSource;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly url: string;
  readyState = FakeEventSource.OPEN;
  onerror: ((event: Event) => void) | null = null;
  private listeners = new Map<string, Set<(event: MessageEvent) => void>>();

  constructor(url: string | URL) {
    this.url = String(url);
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, data: unknown): void {
    const event = { data: JSON.stringify(data) } as MessageEvent;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }
}

function stubFetch(): void {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push(url);
    if (nextResponse.kind === "fail") throw new Error(nextResponse.message);
    return Response.json(nextResponse.body);
  }) as typeof fetch;
}

function stubEventSource(): void {
  FakeEventSource.instances = [];
  (globalThis as unknown as { EventSource: typeof EventSource }).EventSource =
    FakeEventSource as unknown as typeof EventSource;
}

function Probe({ refreshKey, enabled }: { refreshKey: string; enabled?: boolean }) {
  const { status, error } = useOpenCodeRuntimeStatus(enabled, refreshKey);
  return <div data-status={status?.mode ?? "none"} data-error={error ?? ""} />;
}

function MultiProbe({ keys }: { keys: readonly string[] }) {
  return (
    <>
      {keys.map((key, index) => (
        <Probe key={index} refreshKey={key} />
      ))}
    </>
  );
}

interface Mounted {
  readonly root: Root;
  readonly container: HTMLElement;
}

async function mount(props: { refreshKey: string; enabled?: boolean }): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Probe {...props} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { root, container };
}

async function mountMany(keys: readonly string[]): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<MultiProbe keys={keys} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { root, container };
}

async function rerender(mounted: Mounted, props: { refreshKey: string; enabled?: boolean }) {
  await act(async () => {
    mounted.root.render(<Probe {...props} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function unmount(mounted: Mounted): void {
  act(() => {
    mounted.root.unmount();
  });
  mounted.container.remove();
}

function statusOf(container: HTMLElement): string | null {
  return container.querySelector("[data-status]")?.getAttribute("data-status") ?? null;
}

function errorOf(container: HTMLElement): string | null {
  return container.querySelector("[data-error]")?.getAttribute("data-error") ?? null;
}

afterEach(() => {
  globalThis.fetch = nativeFetch;
  (globalThis as unknown as { EventSource: typeof EventSource }).EventSource = nativeEventSource;
  requests = [];
  nextResponse = {
    kind: "json",
    body: { mode: "managed", backendInstanceId: BID, targetRevision: 1, targetId: 1 },
  };
  resetStatusResourceForTests();
  resetRuntimeTargetEventsForTests();
  resetRuntimeTargetStoreForTests();
  useAvailabilityStore.setState({ recoveryEpoch: 0 });
});

describe("useOpenCodeRuntimeStatus (managed-only)", () => {
  it("reads the status once on mount", async () => {
    stubFetch();
    stubEventSource();
    const mounted = await mount({ refreshKey: "connecting" });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("/api/opencode/status");
    expect(statusOf(mounted.container)).toBe("managed");
    unmount(mounted);
  });

  it("re-reads when the refresh key changes, and not before", async () => {
    stubFetch();
    stubEventSource();
    const mounted = await mount({ refreshKey: "connecting" });
    expect(requests).toHaveLength(1);
    await rerender(mounted, { refreshKey: "connecting" });
    expect(requests).toHaveLength(1);
    await rerender(mounted, { refreshKey: "connected" });
    expect(requests).toHaveLength(2);
    unmount(mounted);
  });

  it("keeps the last mode when a read fails, and exposes the failure", async () => {
    stubFetch();
    stubEventSource();
    nextResponse = {
      kind: "json",
      body: { mode: "managed", backendInstanceId: BID, targetRevision: 2, targetId: 2 },
    };
    const mounted = await mount({ refreshKey: "connecting" });
    expect(statusOf(mounted.container)).toBe("managed");
    nextResponse = { kind: "fail", message: "backend went away" };
    // The no-connected → connected transition is the coalesced shared trigger.
    await rerender(mounted, { refreshKey: "connected" });
    expect(statusOf(mounted.container)).toBe("managed");
    expect(errorOf(mounted.container)).toBe("backend went away");
    unmount(mounted);
  });

  it("issues no request and clears the mode when disabled", async () => {
    stubFetch();
    stubEventSource();
    const mounted = await mount({ refreshKey: "connected", enabled: false });
    expect(requests).toHaveLength(0);
    expect(statusOf(mounted.container)).toBe("none");
    unmount(mounted);
  });

  it("refetches authoritative status when a runtime target lifecycle event arrives", async () => {
    stubFetch();
    stubEventSource();
    nextResponse = {
      kind: "json",
      body: { mode: "managed", backendInstanceId: BID, targetRevision: 1, targetId: 1 },
    };
    const mounted = await mount({ refreshKey: "connected" });
    expect(requests.filter((u) => u.includes("/api/opencode/status"))).toHaveLength(1);

    nextResponse = {
      kind: "json",
      body: { mode: "managed", backendInstanceId: BID, targetRevision: 2, targetId: 2 },
    };
    await act(async () => {
      FakeEventSource.instances[0]?.emit("opencode.runtime_target", {
        backendInstanceId: BID,
        mode: "managed",
        targetRevision: 2,
        targetId: 2,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(
      requests.filter((u) => u.includes("/api/opencode/status")).length,
    ).toBeGreaterThanOrEqual(2);
    expect(statusOf(mounted.container)).toBe("managed");
    unmount(mounted);
  });

  it("does not let an older HTTP status response overwrite a newer target notification", async () => {
    stubEventSource();
    let resolveOld!: (value: Response) => void;
    let resolveNew!: (value: Response) => void;
    let call = 0;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requests.push(url);
      call += 1;
      if (call === 1) {
        return await new Promise<Response>((resolve) => {
          resolveOld = resolve;
        });
      }
      return await new Promise<Response>((resolve) => {
        resolveNew = resolve;
      });
    }) as typeof fetch;

    const mounted = await mount({ refreshKey: "connected" });
    expect(requests.filter((u) => u.includes("/api/opencode/status"))).toHaveLength(1);

    await act(async () => {
      FakeEventSource.instances[0]?.emit("opencode.runtime_target", {
        backendInstanceId: BID,
        mode: "managed",
        targetRevision: 2,
        targetId: 2,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(requests.filter((u) => u.includes("/api/opencode/status"))).toHaveLength(2);

    await act(async () => {
      resolveNew(
        Response.json({
          mode: "managed",
          backendInstanceId: BID,
          targetRevision: 2,
          targetId: 2,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(statusOf(mounted.container)).toBe("managed");

    await act(async () => {
      resolveOld(
        Response.json({
          mode: "managed",
          backendInstanceId: BID,
          targetRevision: 1,
          targetId: 1,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(statusOf(mounted.container)).toBe("managed");
    unmount(mounted);
  });

  it("shares one read across multiple consumers with different connection types", async () => {
    stubFetch();
    stubEventSource();
    const a = await mount({ refreshKey: "absent" });
    const b = await mount({ refreshKey: "connecting" });
    const c = await mount({ refreshKey: "reconnecting" });
    expect(requests.filter((u) => u.includes("/api/opencode/status"))).toHaveLength(1);

    // A non-connected → non-connected change is not the aggregate transition.
    await rerender(b, { refreshKey: "failed" });
    expect(requests.filter((u) => u.includes("/api/opencode/status"))).toHaveLength(1);

    // First connected consumer: false → true, exactly one additional request.
    await rerender(a, { refreshKey: "connected" });
    expect(requests.filter((u) => u.includes("/api/opencode/status"))).toHaveLength(2);

    // Another consumer connecting is true → true: no additional request.
    await rerender(b, { refreshKey: "connected" });
    expect(requests.filter((u) => u.includes("/api/opencode/status"))).toHaveLength(2);

    unmount(a);
    unmount(b);
    unmount(c);
  });

  it("coalesces a batch of consumers, including a connected one, into one read", async () => {
    stubFetch();
    stubEventSource();
    const mounted = await mountMany(["absent", "connected", "reconnecting"]);
    expect(requests.filter((u) => u.includes("/api/opencode/status"))).toHaveLength(1);
    unmount(mounted);
  });

  it("publishes read errors to the shared store, keeps status, and clears on success", async () => {
    stubFetch();
    stubEventSource();
    const mounted = await mount({ refreshKey: "connected" });
    expect(statusOf(mounted.container)).toBe("managed");
    expect(errorOf(mounted.container)).toBe("");
    expect(useRuntimeTargetStore.getState().error).toBeNull();

    nextResponse = { kind: "fail", message: "backend went away" };
    await act(async () => {
      useAvailabilityStore.setState({ recoveryEpoch: 1 });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(statusOf(mounted.container)).toBe("managed");
    expect(errorOf(mounted.container)).toBe("backend went away");
    expect(useRuntimeTargetStore.getState().error).toBe("backend went away");

    // A second consumer reads the same shared error without issuing a request.
    const before = requests.length;
    const second = await mount({ refreshKey: "connected" });
    expect(requests.length).toBe(before);
    expect(errorOf(second.container)).toBe("backend went away");

    nextResponse = {
      kind: "json",
      body: { mode: "managed", backendInstanceId: BID, targetRevision: 1, targetId: 1 },
    };
    await act(async () => {
      useAvailabilityStore.setState({ recoveryEpoch: 2 });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(errorOf(mounted.container)).toBe("");
    expect(errorOf(second.container)).toBe("");
    expect(useRuntimeTargetStore.getState().error).toBeNull();

    unmount(mounted);
    unmount(second);
  });
});
