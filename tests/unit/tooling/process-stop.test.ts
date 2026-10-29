/**
 * `taskkill` exit semantics for a pid that is already gone.
 *
 * The `tauri` job failed at cleanup in run 40869474036 after its observation had
 * succeeded: Windows Server 2025 answered `taskkill /F /PID 1868` with exit 1
 * and `Reason: There is no running instance of the task.`, while only exit 128
 * ("process not found") was tolerated. Both statements describe the same fact —
 * the pid is not running — and the stop is confirmed independently against a
 * fresh process table, so this classifier only decides whether taskkill's own
 * complaint is an error to report.
 */
import { describe, expect, it } from "bun:test";

import { isTaskkillAlreadyGone } from "../../../scripts/lib/process";

describe("taskkill on a pid that already exited", () => {
  it("accepts 128, the documented not-found status", () => {
    expect(isTaskkillAlreadyGone(128, 'ERROR: The process "13788" not found.')).toBe(true);
  });

  it("accepts the newer builds' exit 1 with 'no running instance'", () => {
    expect(
      isTaskkillAlreadyGone(
        1,
        "ERROR: The process with PID 1868 could not be terminated.\r\n" +
          "Reason: There is no running instance of the task.",
      ),
    ).toBe(true);
  });

  it("does not report a real refusal as success", () => {
    expect(isTaskkillAlreadyGone(1, "ERROR: Access is denied.")).toBe(false);
    expect(isTaskkillAlreadyGone(2, "ERROR: The process with PID 5 could not be terminated.")).toBe(
      false,
    );
    // A transport-level failure carries no exit status at all.
    expect(isTaskkillAlreadyGone(null, "")).toBe(false);
  });
});
