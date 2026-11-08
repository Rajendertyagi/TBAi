/**
 * Coordinated (availability) recovery must not clobber the per-conversation
 * failure record or the recovery latch.
 *
 * Regression for the blank-transcript defect: an availability recovery that
 * fired while a history load was failing called `invalidateHistoryCache()` with
 * no argument, which dropped every controller AND cleared `loadFailures` and
 * `recoveryAttempted`. The failure row then vanished and the re-arm never
 * fired, so the conversation rendered as empty with no way back.
 *
 * The failure record is cleared only by a successful load
 * (`clearHistoryLoadFailed`) or by deleting the conversation
 * (`dropWindowController`). Coordinated recovery drops the window projection
 * (controllers / ui snapshots) but keeps the failure + recovery state.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  clearAllWindowControllers,
  clearHistoryLoadFailed,
  dropWindowController,
  hasAttemptedHistoryRecovery,
  isHistoryLoadFailed,
  markHistoryLoadFailed,
  markHistoryRecoveryAttempted,
  resetHistoryVisit,
} from "@web/features/chat/history/useDirectHistoryWindow.ts";

describe("coordinated recovery preserves the failure record", () => {
  const id = "conv-recovery-preserve";

  beforeEach(() => {
    resetHistoryVisit();
  });

  afterEach(() => {
    dropWindowController(id);
    resetHistoryVisit();
  });

  it("keeps isHistoryLoadFailed true across clearAllWindowControllers", () => {
    markHistoryLoadFailed(id);
    expect(isHistoryLoadFailed(id)).toBe(true);

    clearAllWindowControllers();

    expect(isHistoryLoadFailed(id)).toBe(true);
  });

  it("keeps the recovery latch set across clearAllWindowControllers", () => {
    markHistoryLoadFailed(id);
    markHistoryRecoveryAttempted(id);
    expect(hasAttemptedHistoryRecovery(id)).toBe(true);

    clearAllWindowControllers();

    expect(hasAttemptedHistoryRecovery(id)).toBe(true);
  });

  it("still clears the failure record on a successful load", () => {
    markHistoryLoadFailed(id);
    expect(isHistoryLoadFailed(id)).toBe(true);

    clearHistoryLoadFailed(id);

    expect(isHistoryLoadFailed(id)).toBe(false);
  });

  it("still clears everything when a single conversation is dropped (deletion path)", () => {
    markHistoryLoadFailed(id);
    markHistoryRecoveryAttempted(id);
    expect(isHistoryLoadFailed(id)).toBe(true);

    dropWindowController(id);

    expect(isHistoryLoadFailed(id)).toBe(false);
    expect(hasAttemptedHistoryRecovery(id)).toBe(false);
  });
});
