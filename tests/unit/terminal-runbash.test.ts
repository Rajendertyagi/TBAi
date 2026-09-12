/**
 * runBash incremental-output tests: the optional onOutput callback receives
 * stream reads while the process runs; without it the result is unchanged.
 * Fast Windows-safe commands only (no timeout/kill waits — those paths are
 * untouched and covered by existing behavior).
 * Executed with `bun test`.
 */
import { describe, it, expect } from "bun:test";
import { runBash, type BashOutputEvent } from "../../src/services/tools";

describe("runBash onOutput", () => {
  it("emits incremental stdout events while running", async () => {
    const events: BashOutputEvent[] = [];
    const res = await runBash({
      command: "1..5 | ForEach-Object { $_; Start-Sleep -Milliseconds 150 }",
      onOutput: (e) => events.push(e),
    });
    expect(res.exitCode).toBe(0);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.stream === "stdout")).toBe(true);
    const joined = events.map((e) => e.chunk).join("");
    for (const n of ["1", "2", "3", "4", "5"]) {
      expect(joined).toContain(n);
    }
    // Durable result still complete.
    expect(res.stdout).toContain("5");
  });

  it("emits stderr with its stream label", async () => {
    const events: BashOutputEvent[] = [];
    const res = await runBash({
      command: "[Console]::Error.WriteLine('boom')",
      onOutput: (e) => events.push(e),
    });
    expect(events.some((e) => e.stream === "stderr")).toBe(true);
    expect(res.stderr).toContain("boom");
  });

  it("reports non-zero exit with output intact", async () => {
    const events: BashOutputEvent[] = [];
    const res = await runBash({
      command: "Write-Output 'before-fail'; exit 3",
      onOutput: (e) => events.push(e),
    });
    expect(res.exitCode).toBe(3);
    expect(res.stdout).toContain("before-fail");
  });

  it("without onOutput the result shape is unchanged", async () => {
    const res = await runBash({ command: "Write-Output 'hello'" });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("hello");
    expect(res.stderr).toBe("");
    expect(res.timedOut).toBe(false);
    expect(typeof res.cwd).toBe("string");
    expect(typeof res.command).toBe("string");
  });

  it("workspace restrictions still apply", async () => {
    let threw = false;
    try {
      await runBash({ command: "echo hi", cwd: "../../.." });
    } catch (e) {
      threw = true;
      expect(String(e)).toContain("outside the workspace");
    }
    expect(threw).toBe(true);
  });
});
