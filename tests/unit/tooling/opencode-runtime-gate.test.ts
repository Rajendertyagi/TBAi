/**
 * RT-007: the real-binary runtime-suite gate is itself guarded.
 *
 * `scripts/run-opencode-runtime-suites.ts` is the thing that decides which
 * OpenCode suites must pass on every PR, so a wrong answer there is a coverage
 * hole reported as green. Three ways that happens, each with a test below:
 *
 * 1. **A suite exists that the gate never heard of.** The register in
 *    `docs/opencode-runtime-audit-final.md` once said "eight suites" while nine
 *    existed on disk. The gate refuses to run when a real-binary suite is
 *    neither required nor excluded; this test fails at `bun run test` if that
 *    refusal is ever relaxed.
 * 2. **The CI job stops running the gate.** A step commented out, renamed, or
 *    pointed at a different command leaves the job exiting 0 having checked
 *    nothing — the exact defect `verify-script.test.ts` was written for, on the
 *    other job.
 * 3. **The counts are parsed wrong.** `pass`/`fail`/`skip` come from bun's own
 *    summary tail. A parser that reads nothing would make "0 pass" look like a
 *    green suite, and this gate treats a zero-pass required suite as a failure.
 *
 * Why this test imports the script instead of copying its lists
 * --------------------------------------------------------------
 * The lists and the validator live in the script and are exported. This file
 * asserts against those exports, so a suite added to disk but not classified
 * fails this test AND fails the gate for the same reason. A copy of the lists
 * here would let the two drift apart again.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { REPO_ROOT } from "../../helpers/repo-root.ts";
import {
  EXCLUDED_SUITES,
  extractFailureDiagnostics,
  MAX_FAILURE_DIAGNOSTICS_CHARS,
  parseCounts,
  REQUIRED_SUITES,
  runtimeSuiteNames,
  sanitizeDiagnostics,
  stripAnsi,
  validateRuntimeSuiteRegistry,
} from "../../../scripts/run-opencode-runtime-suites.ts";

describe("the runtime-suite gate (RT-007)", () => {
  it("classifies every real-binary runtime suite on disk as required or excluded", () => {
    const problems = validateRuntimeSuiteRegistry({
      discovered: runtimeSuiteNames(),
      required: REQUIRED_SUITES,
      excluded: EXCLUDED_SUITES,
    });
    expect(problems).toEqual([]);
  });

  it("refuses to run when a runtime suite on disk is unclassified", () => {
    const problems = validateRuntimeSuiteRegistry({
      discovered: ["audit-b7-opencode", "brand-new-runtime-suite"],
      required: ["audit-b7-opencode"],
      excluded: {},
    });
    expect(problems.map((problem) => problem.code)).toContain("unclassified");
    expect(problems.some((problem) => problem.message.includes("brand-new-runtime-suite"))).toBe(
      true,
    );
  });

  it("refuses to run when a classified suite is stale", () => {
    const problems = validateRuntimeSuiteRegistry({
      discovered: ["audit-b7-opencode"],
      required: ["audit-b7-opencode", "deleted-suite"],
      excluded: {},
    });
    expect(problems.map((problem) => problem.code)).toContain("stale");
    expect(problems.some((problem) => problem.message.includes("deleted-suite"))).toBe(true);
  });

  it("refuses to run when a suite is both required and excluded", () => {
    const problems = validateRuntimeSuiteRegistry({
      discovered: ["audit-b7-opencode"],
      required: ["audit-b7-opencode"],
      excluded: { "audit-b7-opencode": "reason" },
    });
    expect(problems.map((problem) => problem.code)).toContain("overlap");
  });

  it("refuses to run when nothing is required", () => {
    const problems = validateRuntimeSuiteRegistry({
      discovered: ["audit-b7-opencode"],
      required: [],
      excluded: { "audit-b7-opencode": "reason" },
    });
    expect(problems.map((problem) => problem.code)).toContain("empty-required");
  });

  it("the opencode-runtime CI job runs the gate", () => {
    const workflow = readFileSync(path.join(REPO_ROOT, ".github", "workflows", "tests.yml"), "utf8");
    // The job must exist and its step must invoke the gate script. A renamed
    // command or a deleted step would leave the job green having checked nothing.
    expect(workflow).toContain("opencode-runtime:");
    expect(workflow).toContain("bun run test:opencode-runtime");
  });

  it("parses bun's summary counts, including a skipped suite", () => {
    const output = [
      "bun test v1.4.2",
      "",
      "tests/integration/opencode/audit-b7-opencode.test.ts:",
      " 3 pass",
      " 0 fail",
      " 1 skip",
      "",
      " 3 pass",
      " 0 fail",
      " 1 skip",
      "Ran 4 tests across 1 file. [1.20s]",
    ].join("\n");
    expect(parseCounts(output)).toEqual({ pass: 3, fail: 0, skip: 1 });
  });

  it("reads a zero-pass summary as zero, never as success", () => {
    expect(parseCounts(" 0 pass\n 0 fail\n 0 skip\n")).toEqual({ pass: 0, fail: 0, skip: 0 });
  });

  it("strips ANSI codes before parsing counts", () => {
    const output = "\u001b[32m 7 pass\u001b[0m\n\u001b[31m 1 fail\u001b[0m\n 0 skip\n";
    expect(stripAnsi(output)).toContain("7 pass");
    expect(parseCounts(output)).toEqual({ pass: 7, fail: 1, skip: 0 });
  });

  it("extracts failing test diagnostics with assertion details", () => {
    const output = [
      "bun test v1.4.4",
      "",
      "tests/integration/opencode/opencode-stub-provider-spike.test.ts:",
      "(pass) first case [1ms]",
      "(fail) tool roundtrip returns expected value [12ms]",
      "  error: expect(received).toBe(expected)",
      "  Expected: 42",
      "  Received: 41",
      "      at <anonymous> (tests/integration/opencode/opencode-stub-provider-spike.test.ts:123:11)",
      "",
      " 7 pass",
      " 1 fail",
      " 0 skip",
    ].join("\n");
    const diagnostics = extractFailureDiagnostics(output);
    expect(diagnostics).toContain("(fail) tool roundtrip returns expected value");
    expect(diagnostics).toContain("Expected: 42");
    expect(diagnostics).toContain("Received: 41");
    expect(diagnostics).toContain("opencode-stub-provider-spike.test.ts:123:11");
  });

  it("extracts diagnostics for multiple failures", () => {
    const output = [
      "(fail) first failure [1ms]",
      "  error: boom one",
      "  Expected: A",
      "  Received: B",
      "(fail) second failure [2ms]",
      "  error: boom two",
      "  Expected: C",
      "  Received: D",
      " 0 pass",
      " 2 fail",
    ].join("\n");
    const diagnostics = extractFailureDiagnostics(output);
    expect(diagnostics).toContain("first failure");
    expect(diagnostics).toContain("second failure");
    expect(diagnostics).toContain("Expected: A");
    expect(diagnostics).toContain("Expected: C");
  });

  it("falls back when no structured failure markers are present", () => {
    const output = [
      "starting suite",
      "some setup line",
      "Error: process crashed unexpectedly",
      "    at run (scripts/x.ts:10:2)",
      "tail line",
    ].join("\n");
    const diagnostics = extractFailureDiagnostics(output);
    expect(diagnostics).toContain("process crashed unexpectedly");
    expect(diagnostics).toContain("scripts/x.ts:10:2");
  });

  it("returns a placeholder when diagnostic output is missing", () => {
    expect(extractFailureDiagnostics("   \n\n")).toBe("(no diagnostic output captured)");
  });

  it("bounds diagnostic length", () => {
    const output = `(fail) huge failure\n${"x".repeat(MAX_FAILURE_DIAGNOSTICS_CHARS + 500)}`;
    const diagnostics = extractFailureDiagnostics(output, 200);
    expect(diagnostics.length).toBeLessThanOrEqual(260);
    expect(diagnostics).toContain("[diagnostics truncated to 200 chars]");
  });

  it("sanitizes secret-like values from diagnostics", () => {
    const output = [
      "(fail) auth case",
      "Authorization: Bearer supersecrettokenvalue123456",
      "api_key=sk-abcdefghijklmnopqrstuvwxyz123456",
      'token: "my-very-secret-token-value"',
      "password=hunter2hunter2",
      "normal: visible",
    ].join("\n");
    const diagnostics = extractFailureDiagnostics(output);
    expect(diagnostics).not.toContain("supersecrettokenvalue123456");
    expect(diagnostics).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(diagnostics).not.toContain("my-very-secret-token-value");
    expect(diagnostics).not.toContain("hunter2hunter2");
    expect(diagnostics).toContain("[REDACTED]");
    expect(diagnostics).toContain("normal: visible");
  });
});
