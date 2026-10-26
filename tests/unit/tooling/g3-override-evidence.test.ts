/**
 * G3 tooling: the pieces that decide whether an override-evidence run is
 * evidence at all.
 *
 * The run itself is a live acceptance test (`tests/e2e/opencode/
 * opencode-config-override-live.spec.ts`, driven by
 * `scripts/run-g3-override-evidence.ts`). What is checked HERE is the part that
 * must be right before any server is started:
 *
 *   1. each case's rule order really produces the override relation it claims;
 *   2. the expected copy is the PRODUCT copy, so the tooling cannot quietly
 *      assert a sentence the page does not render;
 *   3. the failure matrix fails for every reason it names — a run whose fixture
 *      changed, whose server read another document, or whose process tree
 *      survived is not allowed to report success;
 *   4. cleanup failures are ADDED to a test failure, never substituted for it.
 *
 * The hash and process-table helpers are exercised directly: this file proves
 * the "bytes unchanged" check can fail by mutating a real file, rather than
 * asserting that the comparison appears in the source.
 */
import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  G3_CASES,
  G3_CASE_NAMES,
  type G3AssessmentInput,
  assessG3Evidence,
  fixtureDocument,
  hashBytes,
  hashFile,
  pathsReferToSameFile,
  restoreFileBytes,
  serializeFixture,
  specEnvironment,
} from "../../../scripts/run-g3-override-evidence";
import {
  descendantsOf,
  parsePsProcessTable,
  parseWindowsProcessTable,
} from "../../../scripts/lib/process";
import { openCodePermissionRuleSchema } from "../../../src/services/opencode/configDocument";
import { openCodeConfigCopy } from "@web/features/opencode/configCopy.ts";
import { findPermissionOverride } from "@web/features/opencode/permissionOverrides.ts";
import { REPO_ROOT } from "../../helpers/repo-root";

const SPEC_PATH = path.join(
  REPO_ROOT,
  "tests",
  "e2e",
  "opencode",
  "opencode-config-override-live.spec.ts",
);

describe("G3 case definitions", () => {
  it("each case's rule order produces the override relation it claims", () => {
    for (const name of G3_CASE_NAMES) {
      const definition = G3_CASES[name];
      expect(definition.rules).toHaveLength(2);
      // Row 1 is the overridden rule; row 2 is the rule that wins.
      expect(findPermissionOverride(definition.rules, 0)).toEqual({
        kind: definition.expectedKind,
        byIndex: 1,
      });
      expect(findPermissionOverride(definition.rules, 1)).toEqual({ kind: "none" });
    }
  });

  it("each case's expected copy is the product's copy for that relation", () => {
    for (const name of G3_CASE_NAMES) {
      const definition = G3_CASES[name];
      expect(definition.expectedNotice).toBe(
        openCodeConfigCopy.permissions.override(definition.expectedKind, 2),
      );
      expect(definition.expectedTitle).toBe(
        openCodeConfigCopy.permissions.overrideTitle(definition.expectedKind, 2),
      );
    }
  });

  it("the two cases expect different notices", () => {
    expect(G3_CASES.full.expectedNotice).not.toBe(G3_CASES.partial.expectedNotice);
    expect(G3_CASES.full.expectedKind).toBe("full");
    expect(G3_CASES.partial.expectedKind).toBe("partial");
  });

  it("each fixture is a valid two-rule permission document for the shell action", () => {
    for (const name of G3_CASE_NAMES) {
      const document = fixtureDocument(name);
      expect(document.permissions).toHaveLength(2);
      for (const rule of document.permissions) {
        expect(openCodePermissionRuleSchema.safeParse(rule).success).toBe(true);
        expect(rule.action).toBe("shell");
      }
      // The serialized fixture must round-trip to the same document: the spec
      // reads the file, so the file is the oracle.
      expect(JSON.parse(serializeFixture(name))).toEqual(document);
    }
  });
});

describe("G3 environment contract", () => {
  it("every G3 variable handed to the spec is read by the spec", () => {
    const environment = specEnvironment({
      caseName: "full",
      definition: G3_CASES.full,
      fixturePath: "C:\\tmp\\g3\\opencode.json",
      baseUrl: "http://127.0.0.1:1234",
      observationPath: "C:\\tmp\\out\\observation.json",
      runId: "run-1",
    });
    const specSource = fs.readFileSync(SPEC_PATH, "utf8");
    const g3Names = Object.keys(environment).filter((key) => key.startsWith("G3_"));
    expect(g3Names.length).toBeGreaterThan(0);
    for (const name of g3Names) {
      expect(specSource).toContain(`process.env.${name}`);
    }
  });
});

describe("fixture hashing and restoration", () => {
  it("observes a changed file as changed and a restored file as restored", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "g3-unit-"));
    try {
      const file = path.join(directory, "opencode.json");
      const original = Buffer.from(serializeFixture("full"), "utf8");
      fs.writeFileSync(file, original);

      const originalHash = hashFile(file);
      expect(originalHash).toBe(hashBytes(original));

      // A second write of DIFFERENT bytes must be detected: this is the check
      // that a server rewriting the fixture during a run cannot pass unnoticed.
      fs.writeFileSync(file, '{"permissions":[]}\n');
      expect(hashFile(file)).not.toBe(originalHash);

      restoreFileBytes(file, original);
      expect(hashFile(file)).toBe(originalHash);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("path comparison", () => {
  it("is case-insensitive on Windows and case-sensitive elsewhere", () => {
    expect(
      pathsReferToSameFile("C:\\Temp\\G3\\opencode.json", "c:\\temp\\g3\\opencode.json", "win32"),
    ).toBe(true);
    expect(pathsReferToSameFile("/tmp/G3/opencode.json", "/tmp/g3/opencode.json", "linux")).toBe(
      false,
    );
  });
});

describe("process tree", () => {
  it("finds every descendant and stops at a cycle", () => {
    const table = [
      { pid: 10, parentPid: 1 },
      { pid: 11, parentPid: 10 },
      { pid: 12, parentPid: 11 },
      { pid: 13, parentPid: 10 },
      // A malformed table can contain a cycle; the walk must terminate.
      { pid: 10, parentPid: 12 },
      { pid: 20, parentPid: 1 },
    ];
    expect(descendantsOf(10, table).sort((a, b) => a - b)).toEqual([11, 12, 13]);
    expect(descendantsOf(20, table)).toEqual([]);
  });

  it("parses the single-object and array forms PowerShell emits", () => {
    expect(parseWindowsProcessTable('{"ProcessId":1,"ParentProcessId":0}')).toEqual([
      { pid: 1, parentPid: 0 },
    ]);
    expect(
      parseWindowsProcessTable(
        '[{"ProcessId":1,"ParentProcessId":0},{"ProcessId":2,"ParentProcessId":1}]',
      ),
    ).toEqual([
      { pid: 1, parentPid: 0 },
      { pid: 2, parentPid: 1 },
    ]);
    // A null pid is what PowerShell emits for a protected process; it must be
    // skipped rather than coerced to 0.
    expect(parseWindowsProcessTable('[{"ProcessId":null,"ParentProcessId":0}]')).toEqual([]);
  });

  it("parses ps output and ignores blank or malformed lines", () => {
    expect(parsePsProcessTable("  1     0\n 42     1\n\nnonsense\n")).toEqual([
      { pid: 1, parentPid: 0 },
      { pid: 42, parentPid: 1 },
    ]);
  });
});

const HASH = "a".repeat(64);

function baseInput(overrides: Partial<G3AssessmentInput> = {}): G3AssessmentInput {
  return {
    runId: "run-1",
    caseName: "full",
    fixturePath: "C:\\tmp\\g3\\opencode.json",
    readinessFailure: null,
    playwright: { exitCode: 0, spawnError: null, timedOut: false },
    observation: {
      runId: "run-1",
      case: "full",
      reportedPath: "C:\\tmp\\g3\\opencode.json",
    },
    notices: {
      row1: G3_CASES.full.expectedNotice,
      row1Title: G3_CASES.full.expectedTitle,
      row2: null,
    },
    hashes: { original: HASH, observed: HASH, restored: HASH },
    appStop: { attempted: true, confirmed: true },
    cleanup: { logPreserved: true, tempRootRemoved: true, errors: [] },
    ...overrides,
  };
}

describe("assessG3Evidence", () => {
  it("passes a run in which every fact holds", () => {
    expect(assessG3Evidence(baseInput())).toEqual({ ok: true, failures: [] });
  });

  it("fails when the Playwright child failed, timed out, or never started", () => {
    expect(
      assessG3Evidence(
        baseInput({ playwright: { exitCode: 1, spawnError: null, timedOut: false } }),
      ).failures,
    ).toContain("Playwright exited with 1");
    expect(
      assessG3Evidence(
        baseInput({ playwright: { exitCode: null, spawnError: null, timedOut: false } }),
      ).failures,
    ).toContain("Playwright produced no exit code");
    expect(
      assessG3Evidence(
        baseInput({ playwright: { exitCode: null, spawnError: null, timedOut: true } }),
      ).failures.some((failure) => failure.includes("did not exit within")),
    ).toBe(true);
    expect(
      assessG3Evidence(
        baseInput({
          playwright: { exitCode: null, spawnError: "spawn failed", timedOut: false },
        }),
      ).failures.some((failure) => failure.includes("could not be started")),
    ).toBe(true);
  });

  it("fails when the app never became ready", () => {
    expect(
      assessG3Evidence(baseInput({ readinessFailure: "the app did not answer" })).failures,
    ).toContain("the app did not answer");
  });

  it("fails without an observation that belongs to this run and case", () => {
    expect(assessG3Evidence(baseInput({ observation: null })).failures).toContain(
      "the spec wrote no observation file",
    );
    expect(
      assessG3Evidence(
        baseInput({
          observation: {
            runId: "older-run",
            case: "full",
            reportedPath: "C:\\tmp\\g3\\opencode.json",
          },
        }),
      ).failures,
    ).toContain("the observation belongs to a different run");
    expect(
      assessG3Evidence(
        baseInput({
          observation: {
            runId: "run-1",
            case: "partial",
            reportedPath: "C:\\tmp\\g3\\opencode.json",
          },
        }),
      ).failures.some((failure) => failure.includes('records case "partial"')),
    ).toBe(true);
  });

  it("fails when the server read a different document", () => {
    const failures = assessG3Evidence(
      baseInput({
        observation: {
          runId: "run-1",
          case: "full",
          reportedPath: "C:\\Users\\someone\\.config\\opencode\\opencode.json",
        },
      }),
    ).failures;
    expect(failures.some((failure) => failure.includes("not the fixture"))).toBe(true);
  });

  it("fails when the rendered notice is not the expected one", () => {
    expect(
      assessG3Evidence(
        baseInput({
          notices: {
            row1: "something else",
            row1Title: G3_CASES.full.expectedTitle,
            row2: null,
          },
        }),
      ).failures.some((failure) => failure.startsWith("row 1 rendered")),
    ).toBe(true);
    // The other case's notice is still the wrong notice for this case.
    expect(
      assessG3Evidence(
        baseInput({
          notices: {
            row1: G3_CASES.partial.expectedNotice,
            row1Title: G3_CASES.full.expectedTitle,
            row2: null,
          },
        }),
      ).failures.some((failure) => failure.startsWith("row 1 rendered")),
    ).toBe(true);
    // Row 2 is the rule that wins; a notice there is a defect.
    expect(
      assessG3Evidence(
        baseInput({
          notices: {
            row1: G3_CASES.full.expectedNotice,
            row1Title: G3_CASES.full.expectedTitle,
            row2: "unexpected",
          },
        }),
      ).failures.some((failure) => failure.startsWith("row 2 rendered a notice")),
    ).toBe(true);
    // A missing title is a missing explanation, not a cosmetic detail.
    expect(
      assessG3Evidence(
        baseInput({
          notices: {
            row1: G3_CASES.full.expectedNotice,
            row1Title: null,
            row2: null,
          },
        }),
      ).failures,
    ).toContain("row 1 does not carry the notice's explanatory title");
    expect(assessG3Evidence(baseInput({ notices: null })).failures).toContain(
      "the observation does not record the rendered notices",
    );
  });

  it("fails when the fixture changed during the run", () => {
    const failures = assessG3Evidence(
      baseInput({ hashes: { original: HASH, observed: "b".repeat(64), restored: HASH } }),
    ).failures;
    expect(failures).toContain("the fixture's bytes changed during the run");
  });

  it("fails when restoration did not reproduce the original bytes", () => {
    const failures = assessG3Evidence(
      baseInput({
        hashes: { original: HASH, observed: HASH, restored: "c".repeat(64) },
      }),
    ).failures;
    expect(failures).toContain("restoring the original bytes did not reproduce the original hash");
  });

  it("fails when a hash could not be captured", () => {
    const failures = assessG3Evidence(
      baseInput({ hashes: { original: null, observed: null, restored: null } }),
    ).failures;
    expect(failures).toContain("the original fixture hash could not be captured");
    expect(failures).toContain("the fixture's bytes could not be hashed after the run");
    expect(failures).toContain("the restored fixture could not be hashed");
  });

  it("fails when the process tree survived, the log was lost, or the root remains", () => {
    expect(
      assessG3Evidence(baseInput({ appStop: { attempted: true, confirmed: false } })).failures,
    ).toContain("the TBAi process tree did not terminate");
    expect(
      assessG3Evidence(
        baseInput({
          cleanup: { logPreserved: false, tempRootRemoved: true, errors: [] },
        }),
      ).failures,
    ).toContain("the application log was not preserved");
    expect(
      assessG3Evidence(
        baseInput({
          cleanup: { logPreserved: true, tempRootRemoved: false, errors: [] },
        }),
      ).failures,
    ).toContain("the temporary root was not removed");
  });

  it("does not require a stop when the app never started", () => {
    expect(
      assessG3Evidence(baseInput({ appStop: { attempted: false, confirmed: false } })).failures,
    ).not.toContain("the TBAi process tree did not terminate");
  });

  it("appends cleanup failures instead of masking the test failure", () => {
    const failures = assessG3Evidence(
      baseInput({
        playwright: { exitCode: 1, spawnError: null, timedOut: false },
        cleanup: {
          logPreserved: false,
          tempRootRemoved: false,
          errors: ["removing the temporary root failed: EBUSY"],
        },
      }),
    ).failures;
    expect(failures[0]).toBe("Playwright exited with 1");
    expect(failures).toContain("the application log was not preserved");
    expect(failures).toContain("the temporary root was not removed");
    expect(failures).toContain("cleanup: removing the temporary root failed: EBUSY");
  });
});

/** One job's lines from the workflow, so a commented-out step cannot match. */
function jobBlock(workflow: string, job: string): string {
  const lines = workflow.split(/\r?\n/);
  const start = lines.indexOf(`  ${job}:`);
  if (start === -1) return "";
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^ {2}[A-Za-z0-9_-]+:/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

describe("the G3 run is actually wired into CI", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const workflow = fs.readFileSync(
    path.join(REPO_ROOT, ".github", "workflows", "tests.yml"),
    "utf8",
  );

  it("exposes the evidence run as a repository script", () => {
    expect(packageJson.scripts["test:opencode-g3"]).toBe("bun scripts/run-g3-override-evidence.ts");
  });

  it("runs that script in its own CI job and uploads the evidence", () => {
    const block = jobBlock(workflow, "opencode-g3");
    expect(block).not.toBe("");
    const steps = block.split(/\r?\n/).map((line) => line.trim());
    expect(steps).toContain("run: bun run test:opencode-g3");
    expect(block).toContain("tests/.artifacts/g3");
    // A failed run must still carry the evidence that explains it.
    expect(block).toContain("if: always()");
  });
});
