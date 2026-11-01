/**
 * The runtime-status read: when it happens, and what a failure does to it.
 *
 * ## What this pins
 *
 * The status is a SNAPSHOT of an install. Mode changes only when the backend
 * adopts at startup or falls back to managed, and the browser's one cheap
 * signal that something changed is the runtime's own connection: a runtime
 * that just CONNECTED proves a target was installed (the managed service starts
 * lazily, on the first Code request), so the read taken at mount is stale.
 * That is why `refreshKey` exists — and why a timer does not.
 *
 * A failed read KEEPS the previous mode. Erasing it would make every surface
 * fall back to "unknown" during a blip after a reconnect that demonstrably
 * worked.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useOpenCodeRuntimeStatus } from "@web/features/opencode/useOpenCodeRuntimeStatus.ts";

/** The response the stubbed backend gives, or a failure sentinel. */
let nextResponse: { kind: "json"; body: unknown } | { kind: "fail"; message: string } = {
  kind: "json",
  body: { mode: "managed" },
};
let requests: string[] = [];

const nativeFetch = globalThis.fetch;

function stubFetch(): void {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push(url);
    if (nextResponse.kind === "fail") throw new Error(nextResponse.message);
    return Response.json(nextResponse.body);
  }) as typeof fetch;
}

/** A probe that renders the hook's result as data attributes. */
function Probe({ refreshKey, enabled }: { refreshKey: string; enabled?: boolean }) {
  const { status, error } = useOpenCodeRuntimeStatus(enabled, refreshKey);
  return (
    <div
      data-status={status?.mode ?? "none"}
      data-capabilities={status?.mode === "adopted" && status.capabilities ? "yes" : "no"}
      data-error={error ?? ""}
    />
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
  requests = [];
  nextResponse = { kind: "json", body: { mode: "managed" } };
});

describe("useOpenCodeRuntimeStatus", () => {
  it("reads the status once on mount", async () => {
    stubFetch();
    const mounted = await mount({ refreshKey: "connecting" });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("/api/opencode/status");
    expect(statusOf(mounted.container)).toBe("managed");
    unmount(mounted);
  });

  it("carries the adopted capability snapshot through the parser", async () => {
    stubFetch();
    nextResponse = {
      kind: "json",
      body: {
        mode: "adopted",
        capabilities: {
          version: "2.3.1",
          supported: {
            session: true,
            events: true,
            config: false,
            agent: true,
            model: true,
            command: true,
          },
        },
      },
    };
    const mounted = await mount({ refreshKey: "connected" });
    expect(statusOf(mounted.container)).toBe("adopted");
    expect(
      mounted.container.querySelector("[data-capabilities]")?.getAttribute("data-capabilities"),
    ).toBe("yes");
    unmount(mounted);
  });

  it("re-reads when the refresh key changes, and not before", async () => {
    stubFetch();
    const mounted = await mount({ refreshKey: "connecting" });
    expect(requests).toHaveLength(1);
    // Same key (including a plain re-render) is not a reason to ask again.
    await rerender(mounted, { refreshKey: "connecting" });
    expect(requests).toHaveLength(1);
    // A connected runtime proves a target was installed since the mount read.
    await rerender(mounted, { refreshKey: "connected" });
    expect(requests).toHaveLength(2);
    unmount(mounted);
  });

  it("keeps the last mode when a read fails, and exposes the failure", async () => {
    stubFetch();
    nextResponse = { kind: "json", body: { mode: "adopted", capabilities: null } };
    const mounted = await mount({ refreshKey: "connected" });
    expect(statusOf(mounted.container)).toBe("adopted");
    nextResponse = { kind: "fail", message: "backend went away" };
    await rerender(mounted, { refreshKey: "reconnecting" });
    expect(statusOf(mounted.container)).toBe("adopted");
    expect(errorOf(mounted.container)).toBe("backend went away");
    unmount(mounted);
  });

  it("issues no request and clears the mode when disabled", async () => {
    stubFetch();
    const mounted = await mount({ refreshKey: "connected", enabled: false });
    expect(requests).toHaveLength(0);
    expect(statusOf(mounted.container)).toBe("none");
    unmount(mounted);
  });
});
