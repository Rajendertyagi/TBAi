/**
 * The Code-mode primary status, asserted BEHAVIOURALLY.
 *
 * ## What this file proves
 *
 * One surface owns the ACTIVE TURN — cancellation ("Stopping…"), the live engine
 * retry countdown, approval waiting, the running tool, and thinking — and it
 * presents only while the transport/recovery state is healthy. The count is
 * `[data-primary-status]` (plan §7), so a second primary, or a silent loss of the
 * only one, is a failing assertion rather than a visual guess.
 *
 * It also carries the Code-mode half of the tool-label handoff: a running
 * `shell` row must come from `features/opencode/toolActivityLabel.ts` (S2), not
 * from the Direct resolver's former temporary `shell` entry, which S3 deletes.
 *
 * ## Why the runtime is real and only the extras are mocked
 *
 * `OpenCodePrimaryStatus` reads the thread through `useAuiState`, so the mount
 * uses the installed `useExternalStoreRuntime` with a real message list and
 * running flag. That is what makes the activity branches exercise the real
 * conversion — `fromThreadMessageLike`, via `convertMessage` — instead of a
 * hand-shaped object. The OpenCode controller is not stood up: the contract here
 * is what the component renders for a given state snapshot, and the snapshot is
 * the seam. Only the members the component reads are provided.
 *
 * ## Why the retry clock has its own cases
 *
 * The retry row is the one surface that promises TIME. Every mistake there is
 * invisible to a type check and plausible on screen: a countdown rebuilt from
 * nothing, a fabricated second, a screen reader announcing every repaint. These
 * cases drive the real component under a fake clock and assert the derived copy,
 * the single announcement per attempt, and the `aria-hidden` countdown. They
 * replace the deleted `OpenCodeRetryBanner.test.tsx` and keep its coverage.
 */

import { afterEach, beforeEach, describe, expect, it, jest, mock } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";

const BASE_TIME = 1_700_000_000_000;
const SESSION_ID = "ses_primary_test";

interface RetryState {
  attempt: number;
  next: number | null;
}

/** The runtime state the primary reads. Mutable, so a case can change it. */
const runtimeState: {
  connection: { type: string; attempt?: number; serverVersion?: string | null };
  load: { type: string; error?: { message: string } };
  retry: RetryState | null;
  execution: { type: string };
  revertRecovery: { type: string; error?: { message: string } };
  /** Read by the restoration notice's coexistence cases, never by the primary. */
  activity: "running" | "not-running" | "unknown";
  auxiliary: { inbox: "current" | "unavailable" };
  inboxById: Record<string, { type: string; delivery?: string }>;
} = {
  connection: { type: "connected", serverVersion: "2.2.0" },
  load: { type: "ready" },
  retry: null,
  execution: { type: "idle" },
  revertRecovery: { type: "none" },
  activity: "unknown",
  auxiliary: { inbox: "current" },
  inboxById: {},
};

/** The pending permission list the primary reads. Replaced per case. */
let permissions: Array<{ id: string }> = [];

/** Whether the surrounding Code provider is mounted. */
let runtimeAvailable = true;

mock.module("@web/features/opencode/v2RuntimeExtras.ts", () => ({
  useOptionalV2RuntimeExtras: () =>
    runtimeAvailable ? { state: runtimeState, permissions } : null,
}));

// ── the components, imported AFTER the mock is registered ────────────────────
const { OpenCodePrimaryStatus } = await import("@web/features/opencode/OpenCodePrimaryStatus.tsx");
const { OpenCodeRecoveryNotice } = await import(
  "@web/features/opencode/OpenCodeRecoveryNotice.tsx"
);

// ── message fixtures ─────────────────────────────────────────────────────────

/**
 * A running tool call: `result` is absent, exactly as the OpenCode projection
 * emits it while a call is in flight. The part carries no `requires-action`
 * status — the projection never produces one.
 */
function runningTool(toolName: string): ThreadMessageLike {
  return {
    id: `assistant_${toolName}`,
    role: "assistant",
    status: { type: "running" },
    content: [{ type: "tool-call", toolCallId: `call_${toolName}`, toolName }],
  };
}

/** A reasoning part still streaming: the "Thinking…" row. */
const THINKING: ThreadMessageLike = {
  id: "assistant_thinking",
  role: "assistant",
  status: { type: "running" },
  content: [{ type: "reasoning", text: "planning the change", status: { type: "running" } }],
};

/** A running reasoning part AND a newer tool call: the tool call must win. */
const TOOL_OVER_THINKING: ThreadMessageLike = {
  id: "assistant_precedence",
  role: "assistant",
  status: { type: "running" },
  content: [
    { type: "reasoning", text: "planning the change", status: { type: "running" } },
    { type: "tool-call", toolCallId: "call_precedence", toolName: "shell" },
  ],
};

// ── the harness ──────────────────────────────────────────────────────────────

interface SceneProps {
  readonly messages: ThreadMessageLike[];
  readonly isRunning: boolean;
  /** Mounts the restoration notice beside the primary for coexistence cases. */
  readonly notice?: boolean;
}

/**
 * The real assistant-ui runtime plus the components under test.
 *
 * `convertMessage` is passed so the real `fromThreadMessageLike` conversion runs;
 * without it the adapter type expects pre-converted `ThreadMessage` objects.
 */
function Scene({ messages, isRunning, notice = false }: SceneProps) {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    isRunning,
    convertMessage: (message) => message,
    onNew: async () => {},
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {notice ? <OpenCodeRecoveryNotice reusedExistingSession sessionId={SESSION_ID} /> : null}
      <OpenCodePrimaryStatus />
    </AssistantRuntimeProvider>
  );
}

interface Mounted {
  readonly root: Root;
  readonly container: HTMLElement;
  /** Re-renders the tree, so a case can change the adapter or the extras. */
  render(next?: Partial<SceneProps>): void;
  unmount(): void;
}

const mounted: Mounted[] = [];

/** Mounts the scene and returns its container. */
function mount(props: Partial<SceneProps> = {}): Mounted {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let current: SceneProps = {
    messages: props.messages ?? [],
    isRunning: props.isRunning ?? false,
    notice: props.notice ?? false,
  };
  const render = (next: Partial<SceneProps> = {}) => {
    current = { ...current, ...next };
    act(() => {
      root.render(<Scene {...current} />);
    });
  };
  const entry: Mounted = {
    root,
    container,
    render,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
  render();
  mounted.push(entry);
  return entry;
}

// ── selectors ────────────────────────────────────────────────────────────────

/** Every primary on screen, identified only by its dedicated marker. */
function primaries(container: HTMLElement): Element[] {
  return [...container.querySelectorAll("[data-primary-status]")];
}

/** The one primary, asserting there is exactly one. */
function singlePrimary(container: HTMLElement): Element {
  const found = primaries(container);
  expect(found).toHaveLength(1);
  return found[0]!;
}

/** Every restoration notice, identified only by its dedicated marker. */
function notices(container: HTMLElement): Element[] {
  return [...container.querySelectorAll("[data-restoration-notice]")];
}

/**
 * The pill's visible copy.
 *
 * `AgentStatus` renders an sr-only `{state}` word beside the label; it is
 * removed from a clone so the assertion reads the label a sighted reader sees.
 */
function labelOf(primary: Element): string {
  const clone = primary.cloneNode(true) as Element;
  for (const hidden of clone.querySelectorAll(".sr-only")) hidden.remove();
  return (clone.textContent ?? "").trim();
}

/** The retry row's polite announcement, a sibling of the aria-hidden pill. */
function announcementOf(primary: Element): string {
  return primary.parentElement?.querySelector('[role="status"]')?.textContent?.trim() ?? "";
}

// ── lifecycle ────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(BASE_TIME));
  runtimeState.connection = { type: "connected", serverVersion: "2.2.0" };
  runtimeState.load = { type: "ready" };
  runtimeState.retry = null;
  runtimeState.execution = { type: "idle" };
  runtimeState.revertRecovery = { type: "none" };
  runtimeState.activity = "unknown";
  runtimeState.auxiliary = { inbox: "current" };
  runtimeState.inboxById = {};
  permissions = [];
  runtimeAvailable = true;
});

afterEach(() => {
  for (const entry of mounted.splice(0)) entry.unmount();
  jest.useRealTimers();
});

// ── the active turn ──────────────────────────────────────────────────────────

describe("the primary owns the active turn while the transport is healthy", () => {
  it("shows 'Stopping…' while an execution is cancelling", () => {
    runtimeState.execution = { type: "cancelling" };
    const { container } = mount({ messages: [THINKING], isRunning: true });

    const primary = singlePrimary(container);
    // The marker rides on the vendored element's own root, which is what §7
    // defines for the Code-mode primary.
    expect(primary.getAttribute("data-slot")).toBe("agent-status");
    expect(labelOf(primary)).toBe("Stopping…");
  });

  it("shows the countdown for a live engine retry", () => {
    runtimeState.retry = { attempt: 2, next: BASE_TIME + 5_000 };
    const { container } = mount({ messages: [THINKING], isRunning: true });

    expect(labelOf(singlePrimary(container))).toBe("Retrying in 5s (attempt 2)");
  });

  it("waits for approval when the pending permission list is non-empty", () => {
    // The projection carries no `requires-action` part status, so the runtime's
    // permission list is the only confirmation that an approval is outstanding.
    permissions = [{ id: "perm_1" }];
    const { container } = mount({ messages: [THINKING], isRunning: true });

    expect(labelOf(singlePrimary(container))).toBe("Waiting for approval…");
  });

  it("labels a running shell through the OpenCode resolver, not the Direct one", () => {
    // S3 deletes the Direct resolver's temporary `shell` entry; this is the
    // Code-mode preservation guard for that label (plan §4).
    const { container } = mount({ messages: [runningTool("shell")], isRunning: true });

    const label = labelOf(singlePrimary(container));
    expect(label).toBe("Running…");
    // The Direct resolver's fallback would render the raw name instead.
    expect(label).not.toContain("shell");
  });

  it("shows 'Thinking…' while only reasoning is running", () => {
    const { container } = mount({ messages: [THINKING], isRunning: true });

    expect(labelOf(singlePrimary(container))).toBe("Thinking…");
  });

  it("renders none when the session is idle", () => {
    const { container } = mount();

    expect(primaries(container)).toHaveLength(0);
  });

  it("is not suppressed by a load in flight", () => {
    // `loading` / `reconciling` describe history, not turn health (plan §9).
    runtimeState.load = { type: "loading" };
    const { container } = mount({ messages: [runningTool("shell")], isRunning: true });

    expect(labelOf(singlePrimary(container))).toBe("Running…");
  });
});

// ── precedence ───────────────────────────────────────────────────────────────

describe("the primary's precedence on a healthy connection", () => {
  it("cancelling beats retry, approval, and a running tool", () => {
    runtimeState.execution = { type: "cancelling" };
    runtimeState.retry = { attempt: 2, next: BASE_TIME + 5_000 };
    permissions = [{ id: "perm_1" }];
    const { container } = mount({ messages: [runningTool("shell")], isRunning: true });

    expect(labelOf(singlePrimary(container))).toBe("Stopping…");
  });

  it("retry beats approval and a running tool", () => {
    runtimeState.retry = { attempt: 2, next: BASE_TIME + 5_000 };
    permissions = [{ id: "perm_1" }];
    const { container } = mount({ messages: [runningTool("shell")], isRunning: true });

    expect(labelOf(singlePrimary(container))).toBe("Retrying in 5s (attempt 2)");
  });

  it("approval beats a running tool", () => {
    permissions = [{ id: "perm_1" }];
    const { container } = mount({ messages: [runningTool("shell")], isRunning: true });

    expect(labelOf(singlePrimary(container))).toBe("Waiting for approval…");
  });

  it("a running tool beats running reasoning", () => {
    const { container } = mount({ messages: [TOOL_OVER_THINKING], isRunning: true });

    expect(labelOf(singlePrimary(container))).toBe("Running…");
  });
});

// ── cancellation row ─────────────────────────────────────────────────────────

describe("the cancellation row", () => {
  it("carries no elapsed time", () => {
    runtimeState.execution = { type: "cancelling" };
    const { container } = mount({ messages: [THINKING], isRunning: true });

    // The Direct pill owns the elapsed ticker. A turn that is stopping has no
    // fabricated seconds here.
    expect(singlePrimary(container).querySelector(".tabular-nums")).toBeNull();
  });

  it("disappears once the cancellation settles", () => {
    runtimeState.execution = { type: "cancelling" };
    const scene = mount({ messages: [THINKING], isRunning: true });
    expect(primaries(scene.container)).toHaveLength(1);

    runtimeState.execution = { type: "idle" };
    scene.render({ isRunning: false });

    expect(primaries(scene.container)).toHaveLength(0);
  });
});

// ── retry copy ───────────────────────────────────────────────────────────────

describe("the live retry's visible copy", () => {
  it("counts down from the server's absolute deadline", () => {
    runtimeState.retry = { attempt: 2, next: BASE_TIME + 5_000 };
    const { container } = mount();
    const primary = singlePrimary(container);

    expect(labelOf(primary)).toBe("Retrying in 5s (attempt 2)");
    expect(announcementOf(primary)).toBe("Retrying, attempt 2");
    // The countdown is decorative: the pill is aria-hidden and the announcement
    // is a separate live region, so a repaint cannot re-announce.
    expect(primary.getAttribute("aria-hidden")).toBe("true");
  });

  it("says only 'Retrying' when the deadline is unknown", () => {
    runtimeState.retry = { attempt: 3, next: null };
    const { container } = mount();
    const primary = singlePrimary(container);

    expect(labelOf(primary)).toBe("Retrying (attempt 3)");
    // "in" would promise a wait nobody scheduled.
    expect(labelOf(primary)).not.toContain(" in ");
    expect(announcementOf(primary)).toBe("Retrying, attempt 3");
  });

  it("drops the number when the deadline has already passed", () => {
    runtimeState.retry = { attempt: 4, next: BASE_TIME - 1_000 };
    const { container } = mount();

    expect(labelOf(singlePrimary(container))).toBe("Retrying (attempt 4)");
  });
});

// ── retry clock ──────────────────────────────────────────────────────────────

describe("the live retry's clock", () => {
  it("ticks the countdown while keeping the announcement stable", () => {
    runtimeState.retry = { attempt: 2, next: BASE_TIME + 5_000 };
    const { container } = mount();
    const before = announcementOf(singlePrimary(container));

    act(() => {
      jest.advanceTimersByTime(1_000);
    });

    const primary = singlePrimary(container);
    expect(labelOf(primary)).toBe("Retrying in 4s (attempt 2)");
    // One polite announcement per ATTEMPT: the seconds are aria-hidden and the
    // live region's text does not move with them.
    expect(announcementOf(primary)).toBe(before);
  });

  it("keeps the last number from going negative at the deadline", () => {
    runtimeState.retry = { attempt: 2, next: BASE_TIME + 1_000 };
    const { container } = mount();

    act(() => {
      jest.advanceTimersByTime(3_000);
    });

    expect(labelOf(singlePrimary(container))).toBe("Retrying (attempt 2)");
  });

  it("stops ticking when the deadline goes away", () => {
    runtimeState.retry = { attempt: 2, next: BASE_TIME + 5_000 };
    const scene = mount();

    runtimeState.retry = { attempt: 2, next: null };
    scene.render();
    act(() => {
      jest.advanceTimersByTime(10_000);
    });

    // The interval is cleared on the dependency change; the copy is stable and
    // no state update from a dead deadline keeps running.
    expect(labelOf(singlePrimary(scene.container))).toBe("Retrying (attempt 2)");
  });

  it("announces once per attempt, not once per repaint", () => {
    runtimeState.retry = { attempt: 2, next: BASE_TIME + 5_000 };
    const scene = mount();
    const seen = new Set<string>();

    for (let tick = 0; tick < 4; tick += 1) {
      act(() => {
        jest.advanceTimersByTime(500);
      });
      seen.add(announcementOf(singlePrimary(scene.container)));
    }
    expect([...seen]).toEqual(["Retrying, attempt 2"]);

    // A NEW attempt is a new announcement: exactly one per attempt.
    runtimeState.retry = { attempt: 3, next: BASE_TIME + 5_000 };
    scene.render();
    expect(announcementOf(singlePrimary(scene.container))).toBe("Retrying, attempt 3");
  });
});

// ── suppression ──────────────────────────────────────────────────────────────

describe("the primary is suppressed whenever transport or recovery is unwell", () => {
  /** The turn is maximally active; only the breaker differs between cases. */
  function arrangeActiveTurn(): void {
    runtimeState.execution = { type: "cancelling" };
    runtimeState.retry = { attempt: 2, next: BASE_TIME + 5_000 };
    permissions = [{ id: "perm_1" }];
  }

  const BREAKERS: ReadonlyArray<{ readonly name: string; readonly break: () => void }> = [
    {
      name: "an automatic reconnect",
      break: () => {
        runtimeState.connection = { type: "reconnecting", attempt: 1 };
      },
    },
    {
      name: "a terminal connection failure",
      break: () => {
        runtimeState.connection = { type: "failed", attempt: 10 };
      },
    },
    {
      name: "a blocked staged recovery",
      break: () => {
        runtimeState.revertRecovery = {
          type: "blocked",
          error: { message: "a staged revert remains" },
        };
      },
    },
    {
      name: "a failed history load",
      break: () => {
        runtimeState.load = { type: "error", error: { message: "history unavailable" } };
      },
    },
    {
      name: "the server not yet reached",
      break: () => {
        runtimeState.connection = { type: "waiting-for-server" };
      },
    },
    {
      name: "a closed connection",
      break: () => {
        runtimeState.connection = { type: "closed" };
      },
    },
  ];

  for (const breaker of BREAKERS) {
    it(`renders none during ${breaker.name}`, () => {
      arrangeActiveTurn();
      breaker.break();
      const { container } = mount({ messages: [runningTool("shell")], isRunning: true });

      // The heart owns this fact; a second presentation would report one unwell
      // state twice.
      expect(primaries(container)).toHaveLength(0);
    });
  }

  it("renders none without the native runtime", () => {
    runtimeAvailable = false;
    arrangeActiveTurn();
    const { container } = mount({ messages: [runningTool("shell")], isRunning: true });

    expect(primaries(container)).toHaveLength(0);
  });
});

// ── coexistence with the restoration notice ─────────────────────────────────

describe("the primary and the restoration notice", () => {
  it("coexist, each identified by its own marker", () => {
    runtimeState.retry = { attempt: 2, next: BASE_TIME + 5_000 };
    const { container } = mount({ notice: true });

    const primary = singlePrimary(container);
    expect(notices(container)).toHaveLength(1);
    const notice = notices(container)[0]!;

    // The markers are the identification contract: neither element borrows the
    // other's, so a selection cannot mistake one for the other.
    expect(primary.hasAttribute("data-restoration-notice")).toBe(false);
    expect(notice.hasAttribute("data-primary-status")).toBe(false);
    expect(notice.textContent ?? "").toContain("Previous session restored");
  });

  it("the notice never repeats the primary's label", () => {
    const fixtures: ReadonlyArray<{
      readonly name: string;
      readonly label: string;
      readonly messages: ThreadMessageLike[];
      readonly arrange: () => void;
    }> = [
      {
        name: "cancelling",
        label: "Stopping…",
        messages: [THINKING],
        arrange: () => {
          runtimeState.execution = { type: "cancelling" };
        },
      },
      {
        name: "retry",
        label: "Retrying in 5s (attempt 2)",
        messages: [THINKING],
        arrange: () => {
          runtimeState.retry = { attempt: 2, next: BASE_TIME + 5_000 };
        },
      },
      {
        name: "approval",
        label: "Waiting for approval…",
        messages: [THINKING],
        arrange: () => {
          permissions = [{ id: "perm_1" }];
        },
      },
      {
        name: "running tool",
        label: "Running…",
        messages: [runningTool("shell")],
        arrange: () => undefined,
      },
      {
        name: "thinking",
        label: "Thinking…",
        messages: [THINKING],
        arrange: () => undefined,
      },
    ];

    for (const fixture of fixtures) {
      runtimeState.execution = { type: "idle" };
      runtimeState.retry = null;
      permissions = [];
      fixture.arrange();
      // A confirmed run is what the notice is allowed to say; it must still not
      // borrow the primary's words.
      runtimeState.activity = "running";

      const { container } = mount({
        messages: fixture.messages,
        isRunning: true,
        notice: true,
      });

      expect(labelOf(singlePrimary(container))).toBe(fixture.label);
      const noticeText = notices(container)[0]?.textContent ?? "";
      expect(noticeText).toContain("Previous session restored");
      expect(noticeText).not.toContain(fixture.label);
    }
  });

  it("the notice does not create a primary when the turn is idle", () => {
    const { container } = mount({ notice: true });

    expect(notices(container)).toHaveLength(1);
    expect(primaries(container)).toHaveLength(0);
  });
});
