import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { V2RuntimeExtras } from "@web/features/opencode/v2RuntimeExtras.ts";
import type {
  V2LifecycleProjection,
  V2QueuedPromptAction,
} from "@web/features/opencode/sync/lifecycleProjection.ts";

let extras: V2RuntimeExtras | null = null;
const cancelQueuedPromptCalls: string[] = [];

mock.module("@web/features/opencode/v2RuntimeExtras.ts", () => ({
  useOptionalV2RuntimeExtras: () => extras,
}));

const { OpenCodeQueuedPrompts } = await import("@web/features/opencode/OpenCodeQueuedPrompts.tsx");

interface Mounted {
  root: Root;
  container: HTMLElement;
}
const mounted: Mounted[] = [];

function baseProjection(overrides: Partial<V2LifecycleProjection> = {}): V2LifecycleProjection {
  return {
    isLoading: false,
    isRunning: true,
    composerStopAvailable: true,
    composerStopOperation: {
      kind: "stop-current-execution",
      intentId: null,
      promptId: "msg_a",
      inboxId: "inbox_a",
      assistantMessageId: null,
      scope: "prompt-associated",
    },
    hasActiveSessionWork: true,
    pendingLifecycle: { submissionPending: false, cancellationPending: false, reasons: [] },
    queuedPromptActions: [],
    capacity: {
      size: 0,
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
    primaryStatus: "executing",
    detail: "",
    ...overrides,
  };
}

function makeExtras(
  actions: V2QueuedPromptAction[],
  projectionOverrides: Partial<V2LifecycleProjection> = {},
): V2RuntimeExtras {
  return {
    kind: "tbai-opencode-v2",
    sessionId: "ses_test",
    session: null,
    state: {} as any,
    projection: baseProjection({ queuedPromptActions: actions, ...projectionOverrides }),
    model: null,
    agent: null,
    desiredModel: null,
    desiredAgent: null,
    permissions: [],
    forms: [],
    setDesiredSelection: () => undefined,
    awaitReady: async () => undefined,
    refresh: async () => undefined,
    reconcileLifecycle: async () => undefined,
    retry: async () => undefined,
    reconcileStagedRevert: async () => undefined,
    reconcilePendingPrompt: async () => "absent",
    awaitPromptAdmission: async () => "disposed",
    stopComposer: async () => undefined,
    cancelQueuedPrompt: async (promptId: string) => {
      cancelQueuedPromptCalls.push(promptId);
    },
    stopSession: async () => undefined,
    compact: async () => undefined,
    regenerate: async () => undefined,
    replyToPermission: async () => undefined,
    reconcileAutoApprove: async () => 0,
    replyToForm: async () => undefined,
    rejectForm: async () => undefined,
  };
}

function mount(node: ReactElement = <OpenCodeQueuedPrompts />): Mounted {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  const entry = { root, container };
  mounted.push(entry);
  return entry;
}

function rerender(entry: Mounted, node: ReactElement = <OpenCodeQueuedPrompts />) {
  act(() => {
    entry.root.render(node);
  });
}

function buttons(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll("button")] as HTMLButtonElement[];
}

beforeEach(() => {
  extras = null;
  cancelQueuedPromptCalls.length = 0;
});

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

describe("OpenCodeQueuedPrompts", () => {
  it("shows Cancel for a queued prompt with a valid inbox target", () => {
    extras = makeExtras([
      {
        promptId: "msg_b",
        inboxId: "inbox_b",
        operation: "cancel-queued-prompt",
        intentId: null,
        state: "available",
        disabledReason: null,
      },
    ]);
    const { container } = mount();
    const btns = buttons(container);
    expect(btns).toHaveLength(1);
    expect(btns[0]?.textContent).toContain("Cancel");
    expect(btns[0]?.disabled).toBe(false);
    expect(btns[0]?.getAttribute("aria-label")).toBe("Cancel queued prompt msg_b");
  });

  it("invokes cancellation only for the clicked queued prompt", async () => {
    extras = makeExtras([
      {
        promptId: "msg_b",
        inboxId: "inbox_b",
        operation: "cancel-queued-prompt",
        intentId: null,
        state: "available",
        disabledReason: null,
      },
      {
        promptId: "msg_c",
        inboxId: "inbox_c",
        operation: "cancel-queued-prompt",
        intentId: null,
        state: "available",
        disabledReason: null,
      },
    ]);
    const { container } = mount();
    const btns = buttons(container);
    expect(btns).toHaveLength(2);
    await act(async () => {
      btns[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(cancelQueuedPromptCalls).toEqual(["msg_c"]);
  });

  it("shows dispatch/confirmation pending state as busy and disabled", () => {
    for (const state of ["requested", "dispatching", "pending-confirmation"] as const) {
      extras = makeExtras([
        {
          promptId: "msg_b",
          inboxId: "inbox_b",
          operation: "cancel-queued-prompt",
          intentId: "intent_b",
          state,
          disabledReason: null,
        },
      ]);
      const { container } = mount();
      const btns = buttons(container);
      expect(btns).toHaveLength(1);
      expect(btns[0]?.disabled).toBe(true);
      expect(btns[0]?.textContent).toContain("Cancelling");
      // cleanup for next iteration
      for (const entry of mounted.splice(0)) {
        act(() => entry.root.unmount());
        entry.container.remove();
      }
    }
  });

  it("shows confirmed cancellation as cancelled/terminal without actionable button", () => {
    extras = makeExtras([
      {
        promptId: "msg_b",
        inboxId: "inbox_b",
        operation: "cancel-queued-prompt",
        intentId: "intent_b",
        state: "confirmed",
        disabledReason: null,
      },
    ]);
    const { container } = mount();
    expect(buttons(container)).toHaveLength(0);
    expect(container.textContent).toContain("Queued prompt cancelled");
  });

  it("does not display a prompt as successfully cancelled when delivery wins the race (action removed)", () => {
    // Delivery wins: queued inbox item no longer present, so projection omits action.
    extras = makeExtras([]);
    const { container } = mount();
    expect(container.querySelector("[data-slot='opencode-queued-prompts']")).toBeNull();
    expect(container.textContent ?? "").not.toContain("cancelled");
  });

  it("shows unknown/reconnect state without misleading successful cancellation", () => {
    extras = makeExtras([
      {
        promptId: "msg_b",
        inboxId: "inbox_b",
        operation: "cancel-queued-prompt",
        intentId: "intent_b",
        state: "unknown",
        disabledReason: "Cancellation status unknown",
      },
    ]);
    const { container } = mount();
    expect(container.textContent).toContain("Queued prompt cancel status unknown");
    expect(container.textContent).not.toContain("Queued prompt cancelled");
    // Unknown is not terminal in component; button remains but not shown as success.
    const btns = buttons(container);
    expect(btns).toHaveLength(1);
  });

  it("shows no actionable queued-cancel button when no inbox ID / unavailable action is absent", () => {
    // Projection excludes prompts without safe inbox id; component renders nothing actionable.
    extras = makeExtras([]);
    const { container } = mount();
    expect(buttons(container)).toHaveLength(0);
  });

  it("prevents duplicate dispatch while busy (repeated clicks)", async () => {
    extras = makeExtras([
      {
        promptId: "msg_b",
        inboxId: "inbox_b",
        operation: "cancel-queued-prompt",
        intentId: null,
        state: "available",
        disabledReason: null,
      },
    ]);
    const entry = mount();
    const btn = buttons(entry.container)[0]!;
    await act(async () => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // Simulate projection moving to dispatching/pending after first click.
    extras = makeExtras([
      {
        promptId: "msg_b",
        inboxId: "inbox_b",
        operation: "cancel-queued-prompt",
        intentId: "intent_b",
        state: "dispatching",
        disabledReason: null,
      },
    ]);
    rerender(entry);
    const busyBtn = buttons(entry.container)[0]!;
    expect(busyBtn.disabled).toBe(true);
    await act(async () => {
      busyBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(cancelQueuedPromptCalls).toEqual(["msg_b"]);
  });

  it("cancelling queued prompt B does not affect active execution A or Composer Stop state", async () => {
    extras = makeExtras(
      [
        {
          promptId: "msg_b",
          inboxId: "inbox_b",
          operation: "cancel-queued-prompt",
          intentId: null,
          state: "available",
          disabledReason: null,
        },
      ],
      {
        isRunning: true,
        composerStopAvailable: true,
        hasActiveSessionWork: true,
        composerStopOperation: {
          kind: "stop-current-execution",
          intentId: null,
          promptId: "msg_a",
          inboxId: "inbox_a",
          assistantMessageId: null,
          scope: "prompt-associated",
        },
      },
    );

    function Harness() {
      const e = extras!;
      return (
        <div>
          <div data-testid="composer-stop">{String(e.projection.composerStopAvailable)}</div>
          <div data-testid="composer-stop-kind">{e.projection.composerStopOperation.kind}</div>
          <div data-testid="active-work">{String(e.projection.hasActiveSessionWork)}</div>
          <OpenCodeQueuedPrompts />
        </div>
      );
    }

    const entry = mount(<Harness />);
    expect(entry.container.querySelector("[data-testid='composer-stop']")?.textContent).toBe(
      "true",
    );
    expect(entry.container.querySelector("[data-testid='composer-stop-kind']")?.textContent).toBe(
      "stop-current-execution",
    );
    expect(entry.container.querySelector("[data-testid='active-work']")?.textContent).toBe("true");

    const btn = buttons(entry.container).find((b) =>
      b.getAttribute("aria-label")?.includes("msg_b"),
    )!;
    await act(async () => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(cancelQueuedPromptCalls).toEqual(["msg_b"]);
    // Composer Stop / active execution A remain unchanged in projection.
    expect(entry.container.querySelector("[data-testid='composer-stop']")?.textContent).toBe(
      "true",
    );
    expect(entry.container.querySelector("[data-testid='composer-stop-kind']")?.textContent).toBe(
      "stop-current-execution",
    );
    expect(entry.container.querySelector("[data-testid='active-work']")?.textContent).toBe("true");
  });
});
