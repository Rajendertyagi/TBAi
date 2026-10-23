/**
 * The live retry banner, asserted BEHAVIOURALLY.
 *
 * ## Why this file exists
 *
 * The banner is the one surface that makes a promise about time. Every mistake
 * here is invisible in a type check and plausible on screen:
 *
 * - a countdown rebuilt from history (there is no scheduled wait to count),
 * - a fabricated "5s" when the deadline is missing or already passed,
 * - a countdown shown while the status chip says Reconnecting,
 * - a screen reader announcing every tick.
 *
 * The component derives the countdown from the server's absolute deadline, so
 * these cases drive the real component under a fake clock and assert the exact
 * copy, the `aria-hidden` countdown, and the stable announced text.
 *
 * ## Why the extras surface is mocked
 *
 * The banner reads the runtime through `useOptionalV2RuntimeExtras()`, which
 * reads assistant-ui's `state.thread.extras`. Standing up a real runtime, a real
 * controller and a real OpenCode server to reach one `<div>` would be a
 * different test; the contract under test is the banner's rendering, not the
 * runtime's. The mock provides only the members the component reads.
 */

import { afterEach, beforeEach, describe, expect, it, jest, mock } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

const BASE_TIME = 1_700_000_000_000;

/** The runtime state the banner reads. Mutable, so a case can change it. */
const runtimeState: {
  retry: { attempt: number; next: number | null } | null;
  /** The chip's own union, widened: the "left connected" case carries an attempt. */
  connection: { type: string; attempt?: number };
} = {
  retry: null,
  connection: { type: "connected" },
};

mock.module("@web/features/opencode/v2RuntimeExtras.ts", () => ({
  useOptionalV2RuntimeExtras: () => ({ state: runtimeState }),
}));

// ── the component, imported AFTER the mock is registered ─────────────────────
const { OpenCodeRetryBanner } = await import("@web/features/opencode/OpenCodeRetryBanner.tsx");

interface Mounted {
  readonly root: Root;
  readonly container: HTMLElement;
}

const mounted: Mounted[] = [];

/** Mounts the banner and returns its container. */
function mount(): Mounted {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(<OpenCodeRetryBanner />);
  });
  const entry = { root, container };
  mounted.push(entry);
  return entry;
}

/** The text a screen reader hears from the live region. */
function announced(container: HTMLElement): string {
  return container.querySelector('[role="status"]')?.textContent ?? "";
}

/** The visible, aria-hidden countdown line. */
function visibleText(container: HTMLElement): string {
  return container.querySelector('[aria-hidden="true"]')?.textContent ?? "";
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(BASE_TIME));
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

describe("the retry banner's visible copy", () => {
  it("counts down from the server's absolute deadline", () => {
    runtimeState.retry = { attempt: 2, next: BASE_TIME + 5_000 };
    const { container } = mount();

    expect(visibleText(container)).toBe("Retrying in 5s (attempt 2)");
    expect(announced(container)).toBe("Retrying, attempt 2");
  });

  it("says only 'Retrying' when the deadline is unknown", () => {
    runtimeState.retry = { attempt: 3, next: null };
    const { container } = mount();

    // No invented number: "in" would promise a wait nobody scheduled.
    expect(visibleText(container)).toBe("Retrying (attempt 3)");
    expect(visibleText(container)).not.toContain(" in ");
    expect(announced(container)).toBe("Retrying, attempt 3");
  });

  it("drops the number when the deadline has already passed", () => {
    runtimeState.retry = { attempt: 4, next: BASE_TIME - 1_000 };
    const { container } = mount();

    expect(visibleText(container)).toBe("Retrying (attempt 4)");
  });

  it("renders nothing with no live retry", () => {
    const { container } = mount();

    expect(container.childNodes).toHaveLength(0);
  });

  it("renders nothing once the connection has left connected", () => {
    runtimeState.retry = { attempt: 2, next: BASE_TIME + 5_000 };
    runtimeState.connection = { type: "reconnecting", attempt: 1 };
    const { container } = mount();

    // A countdown during a transport retry would contradict the status chip.
    expect(container.childNodes).toHaveLength(0);
  });
});

describe("the retry banner's clock", () => {
  it("ticks the countdown while keeping the announcement stable", () => {
    runtimeState.retry = { attempt: 2, next: BASE_TIME + 5_000 };
    const { container } = mount();
    const announcementBefore = announced(container);

    act(() => {
      jest.advanceTimersByTime(1_000);
    });

    expect(visibleText(container)).toBe("Retrying in 4s (attempt 2)");
    // One polite announcement per ATTEMPT: the seconds are aria-hidden and the
    // live region's text does not move with them.
    expect(announced(container)).toBe(announcementBefore);
  });

  it("keeps the last number from going negative at the deadline", () => {
    runtimeState.retry = { attempt: 2, next: BASE_TIME + 1_000 };
    const { container } = mount();

    act(() => {
      jest.advanceTimersByTime(3_000);
    });

    expect(visibleText(container)).toBe("Retrying (attempt 2)");
  });

  it("stops ticking when the deadline goes away", () => {
    runtimeState.retry = { attempt: 2, next: BASE_TIME + 5_000 };
    const { root, container } = mount();

    act(() => {
      runtimeState.retry = { attempt: 2, next: null };
      root.render(<OpenCodeRetryBanner />);
    });
    act(() => {
      jest.advanceTimersByTime(10_000);
    });

    // The interval is cleared on the dependency change; the copy is stable and
    // no state update from a dead deadline keeps running.
    expect(visibleText(container)).toBe("Retrying (attempt 2)");
  });
});
