/**
 * The status chip's manual recovery, asserted BEHAVIOURALLY.
 *
 * ## Why this file exists
 *
 * **M17** — `OpenCodeStatus.retry()` called `reconcileStagedRevert()` with no
 * `.catch`. `reconcileStagedRevert` rejects with a `V2ControllerError` when the
 * recovery fails, and the controller already dispatches that failure into the
 * store - so the state carried the error and the chip rendered it. Without the
 * catch, the SAME failure was ALSO an unhandled promise rejection, on every
 * failed "Retry recovery": two reports of one failure, one of them invisible
 * and uncatchable by the app.
 *
 * The guard here is the observable consequence: a failed recovery produces NO
 * unhandled rejection.
 *
 * ## Why the chip is mounted with a mocked extras surface
 *
 * `OpenCodeStatus` reads the runtime through `useOptionalV2RuntimeExtras()`,
 * which reads assistant-ui's `state.thread.extras`. Standing up the real
 * assistant-ui runtime, a real controller and a real OpenCode server to reach
 * one button would be a different test - an integration test, in a different
 * suite, at a different cost.
 *
 * What is under test is the CHIP'S OWN behaviour: what it does with the
 * rejection the controller hands it. So the runtime surface is a seam, and the
 * seam is mocked. The chip is the real component.
 *
 * The mock is registered with `mock.module` BEFORE the component is imported,
 * because a static import would be hoisted and evaluated first, bypassing the
 * mock (the same convention `tests/dom/mcp/McpPanel.test.tsx` uses).
 */

import { describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// ── the mocked runtime surface ─────────────────────────────────────────────

/** What the mocked `reconcileStagedRevert` does next. */
let recoveryOutcome: "resolve" | "reject" = "resolve";

/** How many times the mocked `reconcileStagedRevert` was called. */
let recoveryCalls = 0;

/** How many times the mocked `retry` was called. */
let _retryCalls = 0;

/**
 * The runtime state the chip reads. Mutable, so a case can change it.
 *
 * The types are the chip's own union members, widened to `string` for the
 * discriminant: the cases set `connection` to `"reconnecting"` and
 * `revertRecovery` to `"none"`, and a literal-typed field would reject them.
 */
const runtimeState: {
  connection: { type: string; attempt?: number; serverVersion?: string | null };
  load: { type: string; error?: { message: string } };
  execution: { type: string; error?: { message: string } };
  revertRecovery: { type: string; error?: { message: string } };
  session: {
    id: string;
    location: { directory: string };
    time: { created: number; updated: number; archived?: number };
  } | null;
} = {
  connection: { type: "failed", attempt: 3 },
  load: { type: "error", error: { message: "the server went away" } },
  execution: { type: "idle" },
  revertRecovery: { type: "blocked", error: { message: "a staged revert remains" } },
  session: null,
};

/**
 * The state the RECOVERY cases need: a staged revert is blocked, so the chip
 * offers "Retry recovery" rather than "Reconnect".
 *
 * The state is shared, so every case that changes it restores it. Without
 * that, the presentation cases would leave a `reconnecting` connection behind
 * and the recovery cases would find no "Retry recovery" button - a test
 * failing because of the test before it.
 */
const BLOCKED_REVERT = {
  connection: { type: "failed", attempt: 3 },
  load: { type: "error", error: { message: "the server went away" } },
  revertRecovery: { type: "blocked", error: { message: "a staged revert remains" } },
};

function restoreBlockedRevert(): void {
  runtimeState.connection = { ...BLOCKED_REVERT.connection };
  runtimeState.load = { ...BLOCKED_REVERT.load };
  runtimeState.revertRecovery = { ...BLOCKED_REVERT.revertRecovery };
}

/**
 * The mocked `useOptionalV2RuntimeExtras`.
 *
 * Only the members the chip reads are provided. The chip reads `state` for
 * the presentation and calls `reconcileStagedRevert` / `retry` for the
 * manual recovery.
 *
 * `useOptionalV2RuntimeExtras` returns `null` when the surrounding Code
 * provider is not mounted, and the chip renders nothing then. The mock can
 * be told to do that, so the case can prove the chip's behaviour when there
 * is no runtime to ask.
 */
let runtimeAvailable = true;

mock.module("@web/features/opencode/v2RuntimeExtras.ts", () => ({
  useOptionalV2RuntimeExtras: () =>
    runtimeAvailable
      ? {
          kind: "tbai-opencode-v2",
          sessionId: "ses_m17",
          session: null,
          state: runtimeState,
          model: null,
          agent: null,
          desiredModel: null,
          desiredAgent: null,
          permissions: [],
          forms: [],
          setDesiredSelection: () => undefined,
          awaitReady: () => Promise.resolve(),
          refresh: () => Promise.resolve(),
          retry: () => {
            _retryCalls += 1;
            return Promise.resolve();
          },
          reconcileStagedRevert: () => {
            recoveryCalls += 1;
            return recoveryOutcome === "reject"
              ? Promise.reject(new Error("OpenCode V2 staged recovery failed"))
              : Promise.resolve();
          },
          reconcilePendingPrompt: () => Promise.resolve("absent"),
          awaitPromptAdmission: () => Promise.resolve({ kind: "absent" }),
          cancel: () => Promise.resolve(),
          compact: () => Promise.resolve(),
          regenerate: () => Promise.resolve(),
          replyToPermission: () => Promise.resolve(),
          reconcileAutoApprove: () => Promise.resolve(0),
          replyToForm: () => Promise.resolve(),
          rejectForm: () => Promise.resolve(),
        }
      : null,
}));

// ── the component, imported AFTER the mock is registered ───────────────────

const { OpenCodeStatus } = await import("@web/features/opencode/OpenCodeStatus.tsx");

// ── helpers ────────────────────────────────────────────────────────────────

interface Mounted {
  readonly root: Root;
  readonly container: HTMLElement;
}

/** Mounts the chip and returns its container. */
function mount(props: { onReconnect?: () => void } = {}): Mounted {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(<OpenCodeStatus {...props} />);
  });
  return { root, container };
}

function unmount(mounted: Mounted): void {
  act(() => {
    mounted.root.unmount();
  });
  mounted.container.remove();
}

/** The chip's trigger: the heart button. */
function trigger(container: HTMLElement): HTMLButtonElement | null {
  return (container.querySelector("button[aria-label^='OpenCode status']") ??
    null) as HTMLButtonElement | null;
}

/** Opens the popover and returns its content, which Radix portals to the body. */
async function openPopover(container: HTMLElement): Promise<HTMLElement> {
  const button = trigger(container);
  expect(button).not.toBeNull();
  await act(async () => {
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const content = document.querySelector("[data-slot='popover-content']");
  expect(content).not.toBeNull();
  return content as HTMLElement;
}

/** The manual recovery button inside the popover. */
function recoveryButton(content: HTMLElement): HTMLButtonElement | null {
  return ([...content.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "Retry recovery",
  ) ?? null) as HTMLButtonElement | null;
}

/**
 * Runs `body` with an unhandled-rejection listener attached, and returns what
 * escaped.
 *
 * The listener is attached for the duration of the body and removed after, so
 * a rejection from ANOTHER test cannot land in this one's list - and a
 * rejection from THIS test cannot leak into another one's.
 */
async function withUnhandledRejectionSpy(body: () => Promise<void>): Promise<unknown[]> {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    await body();
    // Let the microtask queue drain, so a rejected promise that nobody
    // handled is REPORTED before the listener comes off.
    await new Promise((resolve) => setTimeout(resolve, 20));
    return unhandled;
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
}

describe("the status chip's manual recovery", () => {
  it("reads 'Reconnecting' with the attempt number during an automatic reconnect", async () => {
    // The chip's LABEL is what the reader sees, so the label is what is
    // asserted here - not the pure mapping, which the unit suite covers.
    //
    // The defect this pins: the runtime sets `load: error` while it waits for
    // its next attempt, so a chip that read the load state first showed a red
    // "Error" for a reconnect that was about to succeed.
    runtimeState.connection = { type: "reconnecting", attempt: 3 };
    runtimeState.load = { type: "error", error: { message: "stream failed" } };
    runtimeState.revertRecovery = { type: "none" };
    const mounted = mount();
    try {
      const content = await openPopover(mounted.container);

      const label = [...content.querySelectorAll("span")].find((span) =>
        span.textContent?.startsWith("Reconnecting"),
      );
      expect(label).toBeDefined();
      // The attempt number is on screen: the reader can see how far the runtime
      // is into its budget.
      expect(label?.textContent ?? "").toContain("3");
    } finally {
      unmount(mounted);
    }
  });

  it("still reads 'Error' and offers Reconnect in the terminal state", async () => {
    runtimeState.connection = { type: "failed", attempt: 10 };
    runtimeState.load = { type: "error", error: { message: "stream failed" } };
    runtimeState.revertRecovery = { type: "none" };
    const mounted = mount();
    try {
      const content = await openPopover(mounted.container);

      const label = [...content.querySelectorAll("span")].find(
        (span) => span.textContent === "Error",
      );
      expect(label).toBeDefined();

      // And the manual control is offered, because the terminal state is the
      // one where the reader is expected to act.
      const reconnect = [...content.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Reconnect",
      );
      expect(reconnect).toBeDefined();
      expect(reconnect?.hasAttribute("disabled")).toBe(false);
    } finally {
      unmount(mounted);
    }
  });

  it("keeps the heart Connected and omits execution errors from the popover", async () => {
    // Turn execution errors belong exclusively to the in-message chat error bubble,
    // not the connection heart.
    runtimeState.connection = { type: "connected", serverVersion: "2.1.2" };
    runtimeState.load = { type: "ready" };
    runtimeState.revertRecovery = { type: "none" };
    runtimeState.execution = {
      type: "error",
      error: { message: "Free usage limit reached. Please connect a provider." },
    };

    const mounted = mount();
    try {
      // 1. Assert heart button itself does NOT carry destructive error styling
      const button = mounted.container.querySelector("button");
      expect(button).not.toBeNull();
      const icon = button?.querySelector("svg");
      expect(icon?.classList.contains("text-destructive")).toBe(false);

      // 2. Open popover and assert label remains "Connected"
      const content = await openPopover(mounted.container);
      const label = [...content.querySelectorAll("span")].find(
        (span) => span.textContent === "Connected",
      );
      expect(label).toBeDefined();

      // 3. Execution error must not appear in the popover
      expect(content.textContent ?? "").not.toContain("Free usage limit reached");
      expect(content.querySelector('[role="alert"]')).toBeNull();
    } finally {
      runtimeState.execution = { type: "idle" };
      unmount(mounted);
    }
  });

  it("keeps the heart 'Connected' while an execution is cancelling", async () => {
    // Cancellation is TURN state, owned by the primary status. The heart reads
    // transport/recovery health only, so a connected transport stays Connected
    // while the turn is stopping - the coupling that rendered "Disconnected"
    // here was removed with S3.
    runtimeState.connection = { type: "connected", serverVersion: "2.2.0" };
    runtimeState.load = { type: "ready" };
    runtimeState.revertRecovery = { type: "none" };
    runtimeState.execution = { type: "cancelling" };

    const mounted = mount();
    try {
      const content = await openPopover(mounted.container);

      const label = [...content.querySelectorAll("span")].find(
        (span) => span.textContent === "Connected",
      );
      expect(label).toBeDefined();
      expect(content.textContent ?? "").not.toContain("Disconnected");
    } finally {
      restoreBlockedRevert();
      runtimeState.execution = { type: "idle" };
      unmount(mounted);
    }
  });

  it("reads 'Disconnected' when the server is not yet reached, even mid-cancel", async () => {
    // The `off` presentation is driven SOLELY by `connection.type !== "connected"`;
    // a cancellation cannot mask a transport that never connected.
    runtimeState.connection = { type: "waiting-for-server" };
    runtimeState.load = { type: "loading" };
    runtimeState.revertRecovery = { type: "none" };
    runtimeState.execution = { type: "cancelling" };

    const mounted = mount();
    try {
      const content = await openPopover(mounted.container);

      const label = [...content.querySelectorAll("span")].find(
        (span) => span.textContent === "Disconnected",
      );
      expect(label).toBeDefined();
    } finally {
      restoreBlockedRevert();
      runtimeState.execution = { type: "idle" };
      unmount(mounted);
    }
  });

  it("reads 'Disconnected' on a closed connection, even mid-cancel", async () => {
    runtimeState.connection = { type: "closed" };
    runtimeState.load = { type: "ready" };
    runtimeState.revertRecovery = { type: "none" };
    runtimeState.execution = { type: "cancelling" };

    const mounted = mount();
    try {
      const content = await openPopover(mounted.container);

      const label = [...content.querySelectorAll("span")].find(
        (span) => span.textContent === "Disconnected",
      );
      expect(label).toBeDefined();
    } finally {
      restoreBlockedRevert();
      runtimeState.execution = { type: "idle" };
      unmount(mounted);
    }
  });

  it("reports a session archived in OpenCode", async () => {
    // The archive arrives as `session.archived` and is carried on the session
    // as `time.archived`. This case proves the chip SAYS so, so a reader who
    // archived the session from OpenCode's own client is not left wondering
    // why it disappeared there and not here.
    runtimeState.connection = { type: "failed", attempt: 10 };
    runtimeState.load = { type: "error", error: { message: "stream failed" } };
    runtimeState.revertRecovery = { type: "none" };
    runtimeState.session = {
      id: "ses_archived",
      location: { directory: "D:\\workspace\\archived" },
      time: { created: 1, updated: 2, archived: 3_000 },
    };
    const mounted = mount();
    try {
      const content = await openPopover(mounted.container);

      expect(content.textContent ?? "").toContain("Archived in OpenCode");
    } finally {
      runtimeState.session = null;
      unmount(mounted);
    }
  });

  it("says nothing about archiving for a session the server did not archive", async () => {
    runtimeState.connection = { type: "failed", attempt: 10 };
    runtimeState.load = { type: "error", error: { message: "stream failed" } };
    runtimeState.revertRecovery = { type: "none" };
    runtimeState.session = {
      id: "ses_active",
      location: { directory: "D:\\workspace\\active" },
      time: { created: 1, updated: 2 },
    };
    const mounted = mount();
    try {
      const content = await openPopover(mounted.container);

      expect(content.textContent ?? "").not.toContain("Archived in OpenCode");
    } finally {
      runtimeState.session = null;
      unmount(mounted);
    }
  });

  it("uses the controller's own retry() as the PRIMARY manual recovery", async () => {
    // The chip's manual recovery has two paths, and the order matters:
    //
    // - the controller's own `retry()` replaces the failed attempt and starts
    //   a fresh one. It is the LIGHTER path - it reuses the client that is
    //   already there.
    // - the `onReconnect` prop rebuilds the whole client. It is the heavier
    //   fallback, for the case where there is no controller to ask.
    //
    // The order was the other way round, which made the controller's `retry()`
    // UNREACHABLE in production: the only production call site always
    // supplies `onReconnect`, so the branch that called `retry()` never ran.
    //
    // This case supplies BOTH, so it can tell which one was used.
    restoreBlockedRevert();
    runtimeState.connection = { type: "failed", attempt: 10 };
    runtimeState.load = { type: "error", error: { message: "stream failed" } };
    runtimeState.revertRecovery = { type: "none" };
    _retryCalls = 0;
    let reconnectCalls = 0;
    const mounted = mount({ onReconnect: () => (reconnectCalls += 1) });
    try {
      const content = await openPopover(mounted.container);
      const button = [...content.querySelectorAll("button")].find(
        (candidate) => candidate.textContent?.trim() === "Reconnect",
      );
      expect(button).toBeDefined();

      await act(async () => {
        button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      // The controller's retry() ran, and the heavier fallback did not.
      expect(_retryCalls).toBe(1);
      expect(reconnectCalls).toBe(0);
    } finally {
      unmount(mounted);
    }
  });

  it("falls back to the heavier rebuild when there is no controller to ask", async () => {
    // The `onReconnect` prop exists for the case where the chip is mounted
    // without a native runtime - so the fallback is not dead code, it is the
    // only path in that configuration.
    runtimeAvailable = false;
    _retryCalls = 0;
    let reconnectCalls = 0;
    const mounted = mount({ onReconnect: () => (reconnectCalls += 1) });
    try {
      // With no runtime, the chip still renders so the reader can trigger the
      // heavier rebuild.
      const content = await openPopover(mounted.container);
      const button = [...content.querySelectorAll("button")].find(
        (candidate) => candidate.textContent?.trim() === "Reconnect",
      );
      expect(button).toBeDefined();

      await act(async () => {
        button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      // The heavier fallback ran, and the controller's retry() did not.
      expect(reconnectCalls).toBe(1);
      expect(_retryCalls).toBe(0);
    } finally {
      unmount(mounted);
      runtimeAvailable = true;
    }
  });

  it("produces NO unhandled rejection when the recovery fails", async () => {
    restoreBlockedRevert();
    recoveryOutcome = "reject";
    recoveryCalls = 0;
    _retryCalls = 0;
    const mounted = mount();
    try {
      const content = await openPopover(mounted.container);
      const button = recoveryButton(content);
      expect(button).toBeDefined();

      const unhandled = await withUnhandledRejectionSpy(async () => {
        await act(async () => {
          button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      });

      // The recovery WAS attempted (so the case is not passing because
      // nothing happened).
      expect(recoveryCalls).toBe(1);
      // And it did not escape as an unhandled rejection.
      expect(unhandled).toEqual([]);
    } finally {
      unmount(mounted);
    }
  });

  it("produces NO unhandled rejection when the recovery succeeds", async () => {
    restoreBlockedRevert();
    recoveryOutcome = "resolve";
    recoveryCalls = 0;
    const mounted = mount();
    try {
      const content = await openPopover(mounted.container);
      const button = recoveryButton(content);

      const unhandled = await withUnhandledRejectionSpy(async () => {
        await act(async () => {
          button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      });

      expect(recoveryCalls).toBe(1);
      expect(unhandled).toEqual([]);
    } finally {
      unmount(mounted);
    }
  });
});
