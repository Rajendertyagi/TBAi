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
import { OPENCODE_RECOVERY_NOTICE_MS } from "@web/features/opencode/config.ts";

const SESSION_ID = "ses_notice_test";

/** The runtime evidence the notice reads. Mutable, so a case can change it. */
const runtimeState: {
  activity: "running" | "not-running" | "unknown";
  auxiliary: { inbox: "current" | "unavailable" };
  inboxById: Record<string, { type: string; delivery?: string }>;
  retry: { attempt: number; next: number | null } | null;
  connection: { type: string };
} = {
  activity: "unknown",
  auxiliary: { inbox: "unavailable" },
  inboxById: {},
  retry: null,
  connection: { type: "connected" },
};

mock.module("@web/features/opencode/v2RuntimeExtras.ts", () => ({
  useOptionalV2RuntimeExtras: () => ({ state: runtimeState }),
}));

// ── the components, imported AFTER the mock is registered ────────────────────
const { OpenCodeRecoveryNotice } = await import(
  "@web/features/opencode/OpenCodeRecoveryNotice.tsx"
);
const { OpenCodeRetryBanner } = await import("@web/features/opencode/OpenCodeRetryBanner.tsx");

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

function textOf(container: HTMLElement): string {
  return container.textContent ?? "";
}

beforeEach(() => {
  jest.useFakeTimers();
  runtimeState.activity = "unknown";
  runtimeState.auxiliary = { inbox: "unavailable" };
  runtimeState.inboxById = {};
  runtimeState.retry = null;
  runtimeState.connection = { type: "connected" };
});

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
  jest.useRealTimers();
});

describe("the notice appears only for verified reuse", () => {
  it("renders nothing for a newly created session", () => {
    const { container } = mount(false);

    expect(textOf(container)).toBe("");
  });

  it("renders for a verified reuse", () => {
    const { container } = mount();

    expect(textOf(container)).toBe(PLAIN);
    expect(container.querySelector('[role="status"]')).not.toBeNull();
  });
});

describe("the notice's copy follows the confirmed evidence", () => {
  for (const row of COPY_ROWS) {
    it(`${row.label} → the matching sentence`, () => {
      runtimeState.activity = row.activity;
      runtimeState.auxiliary = { inbox: "current" };
      runtimeState.inboxById = row.queued
        ? { inbox_1: { type: "user", delivery: "queue" } }
        : { inbox_1: { type: "user", delivery: "steer" } };
      const { container } = mount();

      expect(textOf(container)).toBe(row.expected);
    });
  }

  it("never treats a failed inbox read as a confirmed queue, even with stale records", () => {
    runtimeState.activity = "not-running";
    // `unavailable` is a failed read. A record left over from an earlier read is
    // not evidence that the prompt is still waiting.
    runtimeState.auxiliary = { inbox: "unavailable" };
    runtimeState.inboxById = { inbox_stale: { type: "user", delivery: "queue" } };
    const { container } = mount();

    expect(textOf(container)).toBe(PLAIN);
  });

  it("does not treat a steer item as a waiting prompt", () => {
    runtimeState.activity = "not-running";
    runtimeState.auxiliary = { inbox: "current" };
    runtimeState.inboxById = { inbox_steer: { type: "user", delivery: "steer" } };
    const { container } = mount();

    expect(textOf(container)).toBe(PLAIN);
  });

  it("does not treat an assistant inbox row as a waiting prompt", () => {
    runtimeState.activity = "not-running";
    runtimeState.auxiliary = { inbox: "current" };
    runtimeState.inboxById = { inbox_assistant: { type: "assistant", delivery: "queue" } };
    const { container } = mount();

    expect(textOf(container)).toBe(PLAIN);
  });

  it("never claims idle or health from unknown activity", () => {
    runtimeState.activity = "unknown";
    const { container } = mount();
    const text = textOf(container);

    expect(text).not.toContain("not running");
    expect(text).not.toContain("idle");
    expect(text).toBe(PLAIN);
  });
});

describe("the notice's lifetime and dismissal", () => {
  it("is dismissible", () => {
    const { container } = mount();
    const button = container.querySelector('button[aria-label="Dismiss session notice"]');
    expect(button).not.toBeNull();

    act(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(textOf(container)).toBe("");
  });

  it("auto-hides after the configured duration", () => {
    const { container } = mount();
    expect(textOf(container)).toBe(PLAIN);

    act(() => {
      jest.advanceTimersByTime(OPENCODE_RECOVERY_NOTICE_MS);
    });

    expect(textOf(container)).toBe("");
  });

  it("shows again after a remount: dismissal is not persisted", () => {
    const first = mount();
    const button = first.container.querySelector('button[aria-label="Dismiss session notice"]');
    act(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(textOf(first.container)).toBe("");

    // A second mount is a new navigation, and the documented product decision
    // is that the notice may show again.
    const second = mount();
    expect(textOf(second.container)).toBe(PLAIN);
  });
});

describe("the notice and the retry banner coexist", () => {
  it("a live retry does not suppress the restoration notice", () => {
    runtimeState.retry = { attempt: 2, next: Date.now() + 5_000 };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <>
          <OpenCodeRecoveryNotice reusedExistingSession={true} sessionId={SESSION_ID} />
          <OpenCodeRetryBanner />
        </>,
      );
    });
    mounted.push({ root, container });

    const text = textOf(container);
    expect(text).toContain(PLAIN);
    expect(text).toContain("Retrying");
  });
});

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
      const rendered = textOf(container).toLowerCase();

      // The rendered sentence is the documented one...
      expect(textOf(container)).toBe(row.expected);
      // ...and it asserts nothing beyond verified reuse.
      for (const word of forbidden) {
        expect(rendered).not.toContain(word);
      }
    }
  });
});
