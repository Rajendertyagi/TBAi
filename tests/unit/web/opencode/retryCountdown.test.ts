/**
 * The retry countdown's one formatter, and the cadence it is driven at.
 *
 * ## Why this file exists
 *
 * The banner must never print a made-up number: the seconds come from an
 * absolute server deadline, and this function only renders what is left. Two
 * mistakes are worth pinning behaviorally:
 *
 * - a floor/round that reports "1s" forever at the deadline, and
 * - a minute/hour boundary that drifts when the value is composed rather than
 *   matched (e.g. "60s" at the one-minute mark).
 *
 * The input is derived and clamped, so a negative value means "the deadline
 * passed while this frame was rendering" and must not render as "-1s".
 */

import { describe, expect, it } from "bun:test";
import {
  OPENCODE_RECOVERY_NOTICE_MS,
  OPENCODE_RETRY_TICK_MS,
  formatRetryCountdown,
} from "@web/features/opencode/config.ts";

describe("formatRetryCountdown", () => {
  it("renders seconds below one minute", () => {
    expect(formatRetryCountdown(0)).toBe("0s");
    expect(formatRetryCountdown(5)).toBe("5s");
    expect(formatRetryCountdown(59)).toBe("59s");
  });

  it("renders the minute boundary without a drifting second unit", () => {
    expect(formatRetryCountdown(60)).toBe("1m");
    expect(formatRetryCountdown(61)).toBe("1m 1s");
    expect(formatRetryCountdown(125)).toBe("2m 5s");
    expect(formatRetryCountdown(3599)).toBe("59m 59s");
  });

  it("renders the hour boundary without a drifting minute unit", () => {
    expect(formatRetryCountdown(3600)).toBe("1h");
    expect(formatRetryCountdown(3660)).toBe("1h 1m");
    expect(formatRetryCountdown(7325)).toBe("2h 2m");
  });

  it("clamps a passed or fractional deadline instead of inventing a second", () => {
    expect(formatRetryCountdown(-1)).toBe("0s");
    expect(formatRetryCountdown(-3600)).toBe("0s");
    expect(formatRetryCountdown(5.9)).toBe("5s");
    expect(formatRetryCountdown(Number.NaN)).toBe("0s");
  });
});

describe("the retry banner's timing constants", () => {
  it("repaints faster than the smallest displayed unit", () => {
    expect(OPENCODE_RETRY_TICK_MS).toBeGreaterThan(0);
    expect(OPENCODE_RETRY_TICK_MS).toBeLessThan(1000);
  });

  it("auto-hides the restoration notice after a bounded time", () => {
    expect(OPENCODE_RECOVERY_NOTICE_MS).toBeGreaterThan(0);
  });
});
