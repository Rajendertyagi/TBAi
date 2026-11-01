/**
 * The chip's Runtime row and the unresolved notice, rendered for real.
 *
 * ## What this pins
 *
 * §4.1's adopted state must be visible on the EXISTING Code surface — no new
 * page, no new route — and unresolved must present ONE actionable sentence on
 * the existing error surface. The two facts are separate inputs:
 *
 *   - the backend's mode (`GET /api/opencode/status`), and
 *   - the runtime's own connection state.
 *
 * The notice requires BOTH to say failure. Unresolved alone is the managed
 * service's lazy-start window: the first Code request is what starts it, so a
 * chip that shouted "not available" before that request would be reporting a
 * test nobody ran.
 *
 * The runtime surface is a seam here for the same reason the neighbouring
 * recovery test gives: standing up a real assistant-ui runtime, controller and
 * OpenCode server to read one popover row would be an integration test at a
 * different cost. The chip itself is the real component.
 */

import { describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { OpenCodeRuntimeStatus } from "@web/features/opencode/runtimeStatus.ts";

// ── the mocked inputs ──────────────────────────────────────────────────────

/** The mode the mocked status read reports; `null` = the read has not answered. */
let runtimeStatus: OpenCodeRuntimeStatus | null = { mode: "unresolved" };

/** The runtime connection/load the chip reads. */
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
    awaitPromptAdmission: () => Promise.resolve({ kind: "absent" }),
    cancel: () => Promise.resolve(),
    compact: () => Promise.resolve(),
    regenerate: () => Promise.resolve(),
    replyToPermission: () => Promise.resolve(),
    reconcileAutoApprove: () => Promise.resolve(0),
    replyToForm: () => Promise.resolve(),
    rejectForm: () => Promise.resolve(),
  }),
}));

// The status hook is mocked as a module, so the chip never issues a request
// from a DOM test — and the test controls the mode directly.
mock.module("@web/features/opencode/useOpenCodeRuntimeStatus.ts", () => ({
  useOpenCodeRuntimeStatus: () => ({ status: runtimeStatus, error: null }),
}));

const { OpenCodeStatus } = await import("@web/features/opencode/OpenCodeStatus.tsx");

// ── helpers ────────────────────────────────────────────────────────────────

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

/** Opens the chip's popover and returns its content (Radix portals it). */
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

/** The value of the popover's Runtime row. */
function runtimeLabel(content: HTMLElement): string | null {
  const term = [...content.querySelectorAll("dt")].find((node) => node.textContent === "Runtime");
  return term?.nextElementSibling?.textContent ?? null;
}

/** The popover's alert paragraphs, in order. */
function alerts(content: HTMLElement): string[] {
  return [...content.querySelectorAll("[role='alert']")].map((node) => node.textContent ?? "");
}

/** Puts the chip back to its starting state for the next case. */
function reset(): void {
  runtimeStatus = { mode: "unresolved" };
  connection = { type: "failed", attempt: 3 };
  load = { type: "error", error: { message: "connect ECONNREFUSED 127.0.0.1:4096" } };
}

// ── the cases ──────────────────────────────────────────────────────────────

describe("the chip's runtime row and unresolved notice", () => {
  it("names the backend's selection for each mode", async () => {
    const cases: readonly (readonly [OpenCodeRuntimeStatus, string])[] = [
      [{ mode: "managed" }, "Managed service"],
      [{ mode: "adopted", capabilities: null }, "Adopted service"],
      [{ mode: "unresolved" }, "Not started"],
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

  it("presents ONE actionable sentence when no service is installed and the runtime failed", async () => {
    reset();
    const mounted = mount();
    const content = await openPopover(mounted.container);
    const [first] = alerts(content);
    expect(first).toContain("OpenCode is not available");
    // The specific failure is not thrown away — it follows the sentence.
    expect(first).toContain("ECONNREFUSED");
    unmount(mounted);
  });

  it("does NOT call a lazily-started service unavailable before a request fails", async () => {
    reset();
    connection = { type: "connected", serverVersion: "2.3.1" };
    load = { type: "ready" };
    const mounted = mount();
    const content = await openPopover(mounted.container);
    expect(alerts(content).join(" ")).not.toContain("OpenCode is not available");
    expect(runtimeLabel(content)).toBe("Not started");
    unmount(mounted);
  });

  it("does not claim unavailability for an adopted service", async () => {
    reset();
    runtimeStatus = { mode: "adopted", capabilities: null };
    const mounted = mount();
    const content = await openPopover(mounted.container);
    expect(alerts(content).join(" ")).not.toContain("OpenCode is not available");
    expect(runtimeLabel(content)).toBe("Adopted service");
    expect(content.textContent).toContain("already running");
    unmount(mounted);
  });

  it("says nothing about a runtime it has not been told about", async () => {
    reset();
    runtimeStatus = null;
    const mounted = mount();
    const content = await openPopover(mounted.container);
    expect(runtimeLabel(content)).toBe("–");
    // A terminal failure already presents as "Error" with its Reconnect
    // control; with no status there is nothing further to add.
    expect(alerts(content)).toEqual([]);
    unmount(mounted);
  });
});
