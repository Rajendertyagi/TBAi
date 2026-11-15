import { describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { OpenCodeRuntimeStatus } from "@web/features/opencode/runtimeStatus.ts";

const BID = "backend-instance";
let runtimeStatus: OpenCodeRuntimeStatus | null = {
  mode: "unresolved",
  backendInstanceId: BID,
  targetRevision: 0,
  targetId: null,
};

let connection: { type: string; attempt?: number; serverVersion?: string | null } = {
  type: "failed",
  attempt: 3,
};
let load: { type: string; error?: { message: string } } = {
  type: "error",
  error: { message: "connect ECONNREFUSED 127.0.0.1:4096" },
};

mock.module("@web/features/opencode/v2RuntimeExtras.ts", () => ({
  useOptionalV2RuntimeExtras: () => ({
    kind: "tbai-opencode-v2",
    sessionId: "ses_h1",
    session: null,
    state: {
      connection,
      load,
      retry: null,
      activity: "unknown",
      activityRevision: 0,
      execution: { type: "idle" },
      revertRecovery: { type: "none" },
      auxiliary: null,
      session: null,
    },
    projection: {
      isLoading: false,
      isRunning: false,
      composerStopAvailable: false,
      composerStopOperation: { kind: "none" },
      hasActiveSessionWork: false,
      pendingLifecycle: { submissionPending: false, cancellationPending: false, reasons: [] },
      queuedPromptActions: [],
      isSendDisabled: false,
      primaryStatus: "idle",
      detail: "",
    },
    model: null,
    agent: null,
    desiredModel: null,
    desiredAgent: null,
    permissions: [],
    forms: [],
    setDesiredSelection: () => undefined,
    awaitReady: () => Promise.resolve(),
    refresh: () => Promise.resolve(),
    retry: () => Promise.resolve(),
    reconcileStagedRevert: () => Promise.resolve(),
    reconcilePendingPrompt: () => Promise.resolve("absent"),
    awaitPromptAdmission: () => Promise.resolve("disposed"),
    stopComposer: () => Promise.resolve(),
    cancelQueuedPrompt: () => Promise.resolve(),
    stopSession: () => Promise.resolve(),
    compact: () => Promise.resolve(),
    regenerate: () => Promise.resolve(),
    replyToPermission: () => Promise.resolve(),
    reconcileAutoApprove: () => Promise.resolve(0),
    replyToForm: () => Promise.resolve(),
    rejectForm: () => Promise.resolve(),
  }),
}));

mock.module("@web/features/opencode/useOpenCodeRuntimeStatus.ts", () => ({
  useOpenCodeRuntimeStatus: () => ({ status: runtimeStatus, error: null }),
}));

const { OpenCodeStatus } = await import("@web/features/opencode/OpenCodeStatus.tsx");

interface Mounted {
  readonly root: Root;
  readonly container: HTMLElement;
}

function mount(): Mounted {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(<OpenCodeStatus />);
  });
  return { root, container };
}

function unmount(mounted: Mounted): void {
  act(() => {
    mounted.root.unmount();
  });
  mounted.container.remove();
}

async function openPopover(container: HTMLElement): Promise<HTMLElement> {
  const trigger = container.querySelector(
    "button[aria-label^='OpenCode status']",
  ) as HTMLButtonElement | null;
  expect(trigger).not.toBeNull();
  await act(async () => {
    trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const content = document.querySelector("[data-slot='popover-content']");
  expect(content).not.toBeNull();
  return content as HTMLElement;
}

function runtimeLabel(content: HTMLElement): string | null {
  const term = [...content.querySelectorAll("dt")].find((node) => node.textContent === "Runtime");
  return term?.nextElementSibling?.textContent ?? null;
}

function alerts(content: HTMLElement): string[] {
  return [...content.querySelectorAll("[role='alert']")].map((node) => node.textContent ?? "");
}

function reset(): void {
  runtimeStatus = { mode: "unresolved", backendInstanceId: BID, targetRevision: 0, targetId: null };
  connection = { type: "failed", attempt: 3 };
  load = { type: "error", error: { message: "connect ECONNREFUSED 127.0.0.1:4096" } };
}

describe("OpenCode status runtime row (managed-only)", () => {
  it("names managed and unresolved modes", async () => {
    const cases: readonly (readonly [OpenCodeRuntimeStatus, string])[] = [
      [
        { mode: "managed", backendInstanceId: BID, targetRevision: 1, targetId: 1 },
        "Managed service",
      ],
      [
        { mode: "unresolved", backendInstanceId: BID, targetRevision: 0, targetId: null },
        "Not started",
      ],
    ];
    for (const [status, expected] of cases) {
      reset();
      runtimeStatus = status;
      const mounted = mount();
      const content = await openPopover(mounted.container);
      expect(runtimeLabel(content)).toBe(expected);
      unmount(mounted);
    }
  });

  it("presents one actionable sentence when unresolved and runtime failed", async () => {
    reset();
    const mounted = mount();
    const content = await openPopover(mounted.container);
    const [first] = alerts(content);
    expect(first).toContain("OpenCode is not available");
    expect(first).toContain("ECONNREFUSED");
    unmount(mounted);
  });

  it("does not call a lazily-started service unavailable before a request fails", async () => {
    reset();
    connection = { type: "connected", serverVersion: "2.3.1" };
    load = { type: "ready" };
    const mounted = mount();
    const content = await openPopover(mounted.container);
    expect(alerts(content).join(" ")).not.toContain("OpenCode is not available");
    expect(runtimeLabel(content)).toBe("Not started");
    unmount(mounted);
  });

  it("says nothing about a runtime it has not been told about", async () => {
    reset();
    runtimeStatus = null;
    const mounted = mount();
    const content = await openPopover(mounted.container);
    expect(runtimeLabel(content)).toBe("–");
    expect(alerts(content)).toEqual([]);
    unmount(mounted);
  });
});
