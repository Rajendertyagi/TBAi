/**
 * The session-restoration notice, asserted BEHAVIOURALLY against every copy row.
 *
 * ## Why this file exists
 *
 * The notice is an honesty contract, not a decoration. `reusedExistingSession`
 * proves that the backend verified and adopted a live session — nothing more. It
 * does not prove a crash, a restart, or that history loaded. So the notice:
 *
 * - appears on every verified reuse, including ordinary navigation;
 * - is not suppressed by a live retry;
 * - reports activity only as far as it was confirmed;
 * - never turns a failed inbox read into "a prompt is waiting";
 * - never says "crash", "restarted", or "reopened".
 *
 * Each row of the product decision is one case below, because copy that drifts
 * from the evidence is the defect this file exists to catch.
 *
 * ## Why the assertion reads two strings, not one
 *
 * S5 presents the notice on the vendored `AgentStatus`, whose label truncates at
 * `max-w-44`. The pill therefore shows a short label and the confirmed sentence
 * lives in the notice's own `role="status"` region. The two are asserted
 * separately: `visibleLabelOf` is what a sighted reader sees, `announcementOf`
 * is what assistive technology is told. Asserting a single concatenated string
 * would let a regression move the sentence into the clipped label and still pass.
 *
 * ## Why the extras surface is mocked
 *
 * The notice reads activity and the inbox from the runtime extras. Standing up a
 * real controller and OpenCode server to render one line would test a different
 * thing; the contract here is the copy the evidence produces. Only the members
 * the component reads are provided.
 */

import { afterEach, beforeEach, describe, expect, it, jest, mock } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { OPENCODE_RECOVERY_NOTICE_MS } from "@web/features/opencode/config.ts";

const BASE_TIME = 1_700_000_000_000;
const SESSION_ID = "ses_notice_test";

/** The short label the pill renders; it must fit the vendored truncation. */
const VISIBLE_LABEL = "Session restored";

/** The runtime evidence the notice reads. Mutable, so a case can change it. */
const runtimeState: {
  activity: "running" | "not-running" | "unknown";
  auxiliary: { inbox: "current" | "unavailable" };
  inboxById: Record<string, { type: string; delivery?: string }>;
  retry: { attempt: number; next: number | null } | null;
  connection: { type: string };
  /** Read by the Code-mode primary in the coexistence case. */
  load: { type: string };
  revertRecovery: { type: string };
  execution: { type: string };
} = {
  activity: "unknown",
  auxiliary: { inbox: "unavailable" },
  inboxById: {},
  retry: null,
  connection: { type: "connected" },
  load: { type: "ready" },
  revertRecovery: { type: "none" },
  execution: { type: "idle" },
};

mock.module("@web/features/opencode/v2RuntimeExtras.ts", () => ({
  useOptionalV2RuntimeExtras: () => ({ state: runtimeState, permissions: [] }),
}));

// ── the components, imported AFTER the mock is registered ────────────────────
const { OpenCodeRecoveryNotice } = await import(
  "@web/features/opencode/OpenCodeRecoveryNotice.tsx"
);
const { OpenCodePrimaryStatus } = await import("@web/features/opencode/OpenCodePrimaryStatus.tsx");

const RUN_AND_QUEUED =
  "Previous session restored — a run is still in progress, and a prompt is waiting to run.";
const RUN_ONLY = "Previous session restored — a run is still in progress.";
const QUEUED_ONLY = "Previous session restored — a prompt is waiting to run.";
const PLAIN = "Previous session restored.";

const COPY_ROWS: ReadonlyArray<{
  readonly label: string;
  readonly activity: "running" | "not-running" | "unknown";
  readonly queued: boolean;
  readonly expected: string;
}> = [
  { label: "running + queued", activity: "running", queued: true, expected: RUN_AND_QUEUED },
  { label: "running, no queue", activity: "running", queued: false, expected: RUN_ONLY },
  {
    label: "not-running + queued",
    activity: "not-running",
    queued: true,
    expected: QUEUED_ONLY,
  },
  { label: "not-running, no queue", activity: "not-running", queued: false, expected: PLAIN },
  { label: "unknown + queued", activity: "unknown", queued: true, expected: QUEUED_ONLY },
  { label: "unknown, no queue", activity: "unknown", queued: false, expected: PLAIN },
];

interface Mounted {
  readonly root: Root;
  readonly container: HTMLElement;
}

const mounted: Mounted[] = [];

/** Mounts the notice for a verified reuse and returns its container. */
function mount(reused = true): Mounted {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(<OpenCodeRecoveryNotice reusedExistingSession={reused} sessionId={SESSION_ID} />);
  });
  const entry = { root, container };
  mounted.push(entry);
  return entry;
}

// ── selectors ────────────────────────────────────────────────────────────────

/** The one notice, identified only by its dedicated marker. */
function noticeOf(container: HTMLElement): Element {
  const found = container.querySelectorAll("[data-restoration-notice]");
  expect(found).toHaveLength(1);
  return found[0]!;
}

/** The `AgentStatus` pill the notice renders. */
function pillOf(notice: Element): Element {
  const pill = notice.querySelector('[data-slot="agent-status"]');
  expect(pill).not.toBeNull();
  return pill!;
}

/**
 * The pill's visible copy.
 *
 * `AgentStatus` renders an sr-only `{state}` word, and the notice renders its
 * announcement in a second sr-only node; both are removed from a clone so the
 * assertion reads the label a sighted reader sees.
 */
function visibleLabelOf(notice: Element): string {
  const clone = notice.cloneNode(true) as Element;
  for (const hidden of clone.querySelectorAll(".sr-only")) hidden.remove();
  return (clone.textContent ?? "").trim();
}

/** The notice's own polite announcement. */
function announcementOf(notice: Element): string {
  const region = notice.querySelector('[role="status"]');
  expect(region).not.toBeNull();
  return (region!.textContent ?? "").trim();
}

/** The dismiss control, located by the accessible name it must carry. */
function dismissButtonOf(notice: Element): HTMLElement {
  const button = notice.querySelector<HTMLElement>('button[aria-label="Dismiss session notice"]');
  expect(button).not.toBeNull();
  return button!;
}

/** True when any ancestor of `node` is hidden from assistive technology. */
function hasHiddenAncestor(node: Element): boolean {
  for (let current = node.parentElement; current !== null; current = current.parentElement) {
    if (current.getAttribute("aria-hidden") === "true") return true;
  }
  return false;
}

// ── lifecycle ────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(BASE_TIME));
  runtimeState.activity = "unknown";
  runtimeState.auxiliary = { inbox: "unavailable" };
  runtimeState.inboxById = {};
  runtimeState.retry = null;
  runtimeState.connection = { type: "connected" };
  runtimeState.load = { type: "ready" };
  runtimeState.revertRecovery = { type: "none" };
  runtimeState.execution = { type: "idle" };
});

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
  jest.useRealTimers();
});

// ── presence ────────────────────────────────────────────────────────────────

describe("the notice appears only for verified reuse", () => {
  it("renders nothing for a newly created session", () => {
    const { container } = mount(false);

    expect(container.querySelectorAll("[data-restoration-notice]")).toHaveLength(0);
    expect(container.textContent).toBe("");
  });

  it("renders the vendored pill and one live region for a verified reuse", () => {
    const { container } = mount();
    const notice = noticeOf(container);

    expect(pillOf(notice)).not.toBeNull();
    expect(visibleLabelOf(notice)).toBe(VISIBLE_LABEL);
    expect(notice.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(announcementOf(notice)).toBe(PLAIN);
  });
});

// ── evidence-driven copy ────────────────────────────────────────────────────

describe("the notice's copy follows the confirmed evidence", () => {
  for (const row of COPY_ROWS) {
    it(`${row.label} → the matching sentence`, () => {
      runtimeState.activity = row.activity;
      runtimeState.auxiliary = { inbox: "current" };
      runtimeState.inboxById = row.queued
        ? { inbox_1: { type: "user", delivery: "queue" } }
        : { inbox_1: { type: "user", delivery: "steer" } };
      const { container } = mount();
      const notice = noticeOf(container);

      // The visible label never carries the evidence; the announcement does.
      expect(visibleLabelOf(notice)).toBe(VISIBLE_LABEL);
      expect(announcementOf(notice)).toBe(row.expected);
    });
  }

  it("never treats a failed inbox read as a confirmed queue, even with stale records", () => {
    runtimeState.activity = "not-running";
    // `unavailable` is a failed read. A record left over from an earlier read is
    // not evidence that the prompt is still waiting.
    runtimeState.auxiliary = { inbox: "unavailable" };
    runtimeState.inboxById = { inbox_stale: { type: "user", delivery: "queue" } };
    const { container } = mount();

    expect(announcementOf(noticeOf(container))).toBe(PLAIN);
  });

  it("does not treat a steer item as a waiting prompt", () => {
    runtimeState.activity = "not-running";
    runtimeState.auxiliary = { inbox: "current" };
    runtimeState.inboxById = { inbox_steer: { type: "user", delivery: "steer" } };
    const { container } = mount();

    expect(announcementOf(noticeOf(container))).toBe(PLAIN);
  });

  it("does not treat an assistant inbox row as a waiting prompt", () => {
    runtimeState.activity = "not-running";
    runtimeState.auxiliary = { inbox: "current" };
    runtimeState.inboxById = { inbox_assistant: { type: "assistant", delivery: "queue" } };
    const { container } = mount();

    expect(announcementOf(noticeOf(container))).toBe(PLAIN);
  });

  it("never claims idle or health from unknown activity", () => {
    runtimeState.activity = "unknown";
    const { container } = mount();
    const notice = noticeOf(container);
    const text = (notice.textContent ?? "").toLowerCase();

    expect(text).not.toContain("not running");
    expect(text).not.toContain("idle");
    expect(announcementOf(notice)).toBe(PLAIN);
  });
});

// ── the shared pill and its trailing control ────────────────────────────────

describe("the notice is the shared AgentStatus with an accessible dismiss", () => {
  it("hides the pill's default decorative trailing and exposes the caller's button", () => {
    const { container } = mount();
    const notice = noticeOf(container);
    const trailing = notice.querySelector('[data-slot="agent-status-trailing"]');

    expect(trailing).not.toBeNull();
    // The vendored default icon is decorative; a caller-supplied node is not.
    expect(trailing!.hasAttribute("aria-hidden")).toBe(false);

    const button = dismissButtonOf(notice);
    expect(hasHiddenAncestor(button)).toBe(false);
    expect(trailing!.contains(button)).toBe(true);
  });

  it("the dismiss button can be reached and activated", () => {
    const { container } = mount();
    const button = dismissButtonOf(noticeOf(container));

    // A native button with an explicit type is keyboard-operable by the
    // platform. happy-dom does not synthesize a click from Enter/Space, so the
    // contract asserted here is reachability (focus) plus the click it triggers.
    expect(button.getAttribute("type")).toBe("button");
    act(() => {
      button.focus();
    });
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("tabindex")).not.toBe("-1");

    // The visible focus indicator is declared, not left to the browser default.
    expect(button.className).toContain("focus-visible:ring-2");
    expect(button.className).toContain("focus-visible:ring-ring");

    act(() => {
      button.click();
    });
    expect(container.querySelectorAll("[data-restoration-notice]")).toHaveLength(0);
  });
});

// ── lifetime ────────────────────────────────────────────────────────────────

describe("the notice's lifetime and dismissal", () => {
  it("is dismissible", () => {
    const { container } = mount();
    const button = dismissButtonOf(noticeOf(container));

    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.querySelectorAll("[data-restoration-notice]")).toHaveLength(0);
    expect(container.textContent).toBe("");
  });

  it("auto-hides after the configured duration and not before", () => {
    const { container } = mount();
    expect(announcementOf(noticeOf(container))).toBe(PLAIN);

    act(() => {
      jest.advanceTimersByTime(OPENCODE_RECOVERY_NOTICE_MS - 1);
    });
    expect(container.querySelectorAll("[data-restoration-notice]")).toHaveLength(1);

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(container.querySelectorAll("[data-restoration-notice]")).toHaveLength(0);
  });

  it("shows again after a remount: dismissal is not persisted", () => {
    const first = mount();
    const button = dismissButtonOf(noticeOf(first.container));
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(first.container.querySelectorAll("[data-restoration-notice]")).toHaveLength(0);

    // A second mount is a new navigation, and the documented product decision
    // is that the notice may show again.
    const second = mount();
    expect(announcementOf(noticeOf(second.container))).toBe(PLAIN);
  });
});

// ── coexistence ─────────────────────────────────────────────────────────────

describe("the notice and the Code-mode primary coexist", () => {
  it("a live retry does not suppress the restoration notice", () => {
    runtimeState.retry = { attempt: 2, next: BASE_TIME + 5_000 };

    // The primary reads the thread through `useAuiState`, so the coexistence
    // mount needs the real runtime; the notice does not, but both are mounted
    // together because that is the surface the reader sees.
    function Scene() {
      const runtime = useExternalStoreRuntime<ThreadMessageLike>({
        messages: [],
        isRunning: false,
        convertMessage: (message) => message,
        onNew: async () => {},
      });
      return (
        <AssistantRuntimeProvider runtime={runtime}>
          <OpenCodeRecoveryNotice reusedExistingSession={true} sessionId={SESSION_ID} />
          <OpenCodePrimaryStatus />
        </AssistantRuntimeProvider>
      );
    }

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => {
      root.render(<Scene />);
    });
    mounted.push({ root, container });

    // Both surfaces present, each identified by its own dedicated marker.
    const notices = container.querySelectorAll("[data-restoration-notice]");
    const primaries = container.querySelectorAll("[data-primary-status]");
    expect(notices).toHaveLength(1);
    expect(primaries).toHaveLength(1);

    const notice = notices[0]!;
    const primary = primaries[0]!;

    // The notice announces the recovery; the primary announces the attempt.
    // Each announcement is its own node, and neither borrows the other's copy.
    expect(announcementOf(notice)).toBe(PLAIN);
    const primaryRegion = primary.parentElement?.querySelector('[role="status"]');
    expect(primaryRegion).not.toBeNull();
    expect(primaryRegion).not.toBe(notice.querySelector('[role="status"]'));
    expect(primaryRegion!.textContent).toContain("Retrying, attempt 2");

    // No duplicate active label: the notice never repeats the primary's words.
    expect(visibleLabelOf(notice)).toBe(VISIBLE_LABEL);
    expect(primary.textContent).toContain("Retrying in 5s (attempt 2)");
    expect(notice.textContent).not.toContain("Retrying in 5s (attempt 2)");
  });
});

// ── honesty ─────────────────────────────────────────────────────────────────

describe("the notice never claims a fact the reuse flag cannot establish", () => {
  it("renders none of the forbidden words for any evidence row", () => {
    // Assert the RENDERED copy, not a test-local list: a component that starts
    // saying "recovered after a restart" must fail here.
    const forbidden = ["crash", "restart", "reopen", "recovered", "history", "loaded"];
    for (const row of COPY_ROWS) {
      runtimeState.activity = row.activity;
      runtimeState.auxiliary = { inbox: "current" };
      runtimeState.inboxById = row.queued ? { inbox_1: { type: "user", delivery: "queue" } } : {};
      const { container } = mount();
      const notice = noticeOf(container);
      const rendered = (notice.textContent ?? "").toLowerCase();

      // The announced sentence is the documented one...
      expect(announcementOf(notice)).toBe(row.expected);
      // ...and nothing in the rendered surface asserts more than verified reuse.
      for (const word of forbidden) {
        expect(rendered).not.toContain(word);
      }
    }
  });
});
