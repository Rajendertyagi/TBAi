/**
 * The recoverable lifecycle notice: degraded and capacity states are stated
 * plainly, and both clear on their own.
 *
 * What this file proves is the PRESENTATION the reader gets: the two states are
 * distinguishable, neither reads as a network/server error, the degraded state
 * is announced as recoverable, and a recovered projection removes the notice.
 * The projection itself is covered by `lifecycleProjection.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { V2LifecycleProjection } from "@web/features/opencode/sync/lifecycleProjection.ts";

let projection: V2LifecycleProjection | null = null;

mock.module("@web/features/opencode/v2RuntimeExtras.ts", () => ({
  useOptionalV2RuntimeExtras: () => (projection === null ? null : { projection }),
}));

const { OpenCodeLifecycleNotice } = await import(
  "@web/features/opencode/OpenCodeLifecycleNotice.tsx"
);

interface Mounted {
  readonly root: Root;
  readonly container: HTMLElement;
}
const mounted: Mounted[] = [];

function baseProjection(overrides: Partial<V2LifecycleProjection> = {}): V2LifecycleProjection {
  return {
    isLoading: false,
    isRunning: false,
    composerStopAvailable: false,
    composerStopOperation: { kind: "none" },
    hasActiveSessionWork: false,
    pendingLifecycle: { submissionPending: false, cancellationPending: false, reasons: [] },
    queuedPromptActions: [],
    capacity: {
      size: 1,
      softCap: 256,
      protectedCap: 512,
      hardCap: 1024,
      protectedCount: 0,
      evictableCount: 0,
      atSoftCap: false,
      atProtectedCap: false,
      atHardCap: false,
      backpressure: false,
    },
    health: { degraded: false, reason: null, recoveryAttempts: 0, recovering: false },
    isSendDisabled: false,
    primaryStatus: "idle",
    detail: "",
    ...overrides,
  };
}

function mount(): Mounted {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(<OpenCodeLifecycleNotice />);
  });
  const entry = { root, container };
  mounted.push(entry);
  return entry;
}

function rerender(entry: Mounted): void {
  act(() => {
    entry.root.render(<OpenCodeLifecycleNotice />);
  });
}

function announcement(container: HTMLElement): string {
  return container.querySelector("[role='status']")?.textContent ?? "";
}

beforeEach(() => {
  projection = null;
});

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

describe("OpenCodeLifecycleNotice", () => {
  it("renders nothing when the lifecycle is healthy and capacity is available", () => {
    projection = baseProjection();
    const { container } = mount();
    expect(container.querySelector("[data-lifecycle-notice]")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("renders nothing when there is no OpenCode runtime", () => {
    projection = null;
    const { container } = mount();
    expect(container.textContent).toBe("");
  });

  it("states that a degraded lifecycle is being reconciled, not that the server failed", () => {
    projection = baseProjection({
      health: { degraded: true, reason: "Error", recoveryAttempts: 1, recovering: true },
      isSendDisabled: true,
      primaryStatus: "reconciling",
    });
    const { container } = mount();

    expect(container.querySelector("[data-lifecycle-notice='degraded']")).not.toBeNull();
    expect(container.textContent).toContain("Reconciling session");
    expect(announcement(container)).toContain("resume automatically");
    expect(container.textContent ?? "").not.toContain("disconnected");
    expect(container.textContent ?? "").not.toContain("network");
  });

  it("tells the reader how to recover when bounded reconciliation gave up", () => {
    projection = baseProjection({
      health: { degraded: true, reason: "Error", recoveryAttempts: 3, recovering: false },
      isSendDisabled: true,
      primaryStatus: "reconciling",
    });
    const { container } = mount();
    expect(announcement(container)).toContain("Reconnect");
    expect(announcement(container)).not.toContain("resume automatically");
  });

  it("reports capacity backpressure as a wait that clears, not as a failed send", () => {
    projection = baseProjection({
      capacity: {
        size: 1024,
        softCap: 256,
        protectedCap: 512,
        hardCap: 1024,
        protectedCount: 512,
        evictableCount: 0,
        atSoftCap: true,
        atProtectedCap: true,
        atHardCap: true,
        backpressure: true,
      },
      isSendDisabled: true,
      primaryStatus: "capacity",
    });
    const { container } = mount();

    expect(container.querySelector("[data-lifecycle-notice='capacity']")).not.toBeNull();
    expect(container.textContent).toContain("Prompt capacity full");
    expect(announcement(container)).toContain("clears automatically");
    expect(container.textContent ?? "").not.toContain("failed");
  });

  it("prefers the degraded state when both are true", () => {
    projection = baseProjection({
      health: { degraded: true, reason: "Error", recoveryAttempts: 0, recovering: true },
      capacity: {
        size: 1,
        softCap: 1,
        protectedCap: 1,
        hardCap: 1,
        protectedCount: 1,
        evictableCount: 0,
        atSoftCap: true,
        atProtectedCap: true,
        atHardCap: true,
        backpressure: true,
      },
      isSendDisabled: true,
      primaryStatus: "reconciling",
    });
    const { container } = mount();
    expect(container.querySelector("[data-lifecycle-notice='degraded']")).not.toBeNull();
    expect(container.querySelector("[data-lifecycle-notice='capacity']")).toBeNull();
  });

  it("removes itself once capacity recovers", () => {
    projection = baseProjection({
      capacity: {
        size: 1,
        softCap: 1,
        protectedCap: 1,
        hardCap: 1,
        protectedCount: 1,
        evictableCount: 0,
        atSoftCap: true,
        atProtectedCap: true,
        atHardCap: true,
        backpressure: true,
      },
      isSendDisabled: true,
      primaryStatus: "capacity",
    });
    const entry = mount();
    expect(entry.container.querySelector("[data-lifecycle-notice='capacity']")).not.toBeNull();

    projection = baseProjection();
    rerender(entry);
    expect(entry.container.querySelector("[data-lifecycle-notice]")).toBeNull();
  });
});
