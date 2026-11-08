/**
 * G5 harness contract: argument handling, report collection, comparison, and the
 * pinned-harness guard.
 *
 * Every case here is written against the failure it prevents. In particular the
 * comparison cases are NOT "does the happy path return ok" — the risks are:
 *
 *   - a removed failing test reading as a fix because the totals stayed level;
 *   - a missing child report being counted as zero failures;
 *   - two legs running different browser settings and being compared anyway;
 *   - a harness applied by `git checkout` (which stages) passing the injection
 *     guard because the guard only looked at the worktree column.
 *
 * The guard cases execute `verifyHarnessInjection` against REAL temporary git
 * repositories, because a guard that is only read is a comment.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  aggregateLeg,
  collectSpecs,
  relativeSpecPath,
  specStatus,
} from "../../../scripts/aggregate-e2e-reports.ts";
import {
  allowlistProblems,
  compareRuns,
  diffSettings,
  flatten,
  parsePorcelainZ,
  verifyHarnessInjection,
  type AggregateLike,
  type HarnessManifest,
  type RemovalAllowlist,
} from "../../../scripts/compare-e2e-reports.ts";
import {
  canonicalJson,
  normalizeProject,
  normalizeUse,
  settingsDigest,
} from "../../../scripts/dump-playwright-settings.ts";
import {
  buildInventory,
  planJsonReports,
  parseRunnerArgs,
  readReportFile,
  reportFileName,
  reporterConflict,
  resolveSpecFiles,
} from "../../../scripts/run-e2e.ts";
import { REPO_ROOT } from "../../helpers/repo-root";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function git(repo: string, args: string[], env: Record<string, string> = {}) {
  const result = spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** A real repository with one commit, so the guard can be executed, not read. */
function makeRepo(files: Record<string, string>): { dir: string; revision: string } {
  const dir = tempDir("tbai-harness-repo-");
  // Identity and signing go on the command line, never into a config file.
  const identity = {
    GIT_AUTHOR_NAME: "Harness Test",
    GIT_AUTHOR_EMAIL: "harness@example.invalid",
    GIT_COMMITTER_NAME: "Harness Test",
    GIT_COMMITTER_EMAIL: "harness@example.invalid",
  };
  git(dir, ["init", "-q"]);
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  git(dir, ["add", "-A"], identity);
  git(dir, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "base"], identity);
  return { dir, revision: git(dir, ["rev-parse", "HEAD"]) };
}

const manifestFor = (entries: Record<string, string>): HarnessManifest => ({
  schemaVersion: 1,
  allowlist: { path: "scripts/e2e-removal-allowlist.json" },
  files: Object.entries(entries).map(([file, content]) => ({
    path: file,
    sha256: sha256(content),
  })),
});

const EMPTY_ALLOWLIST: RemovalAllowlist = {
  schemaVersion: 1,
  removedTests: [],
  removedSpecs: [],
  settingsDivergence: [],
};

function aggregate(overrides: Partial<AggregateLike> = {}): AggregateLike {
  return {
    project: "chromium-headless",
    revision: "aaaaaaa",
    live: false,
    specFiles: ["core/a.spec.ts"],
    specsWithoutReport: [],
    inventoryMismatch: false,
    tests: [{ id: "core/a.spec.ts::passes", file: "core/a.spec.ts", status: "passed" }],
    settingsDigest: "digest-a",
    settingsFile: null,
    ...overrides,
  };
}

const VERIFIED: HarnessManifest = manifestFor({ "scripts/run-e2e.ts": "harness content" });
const VERIFICATION = {
  schemaVersion: 1 as const,
  revision: "aaaaaaa",
  ok: true,
  failures: [],
  files: Object.fromEntries(VERIFIED.files.map((file) => [file.path, file.sha256])),
};

function compare(overrides: {
  baseline?: AggregateLike;
  final?: AggregateLike;
  allowlist?: RemovalAllowlist;
  baselineSettings?: { settings?: unknown; env?: unknown } | null;
  finalSettings?: { settings?: unknown; env?: unknown } | null;
  baselineHarness?: typeof VERIFICATION | null;
  finalHarness?: typeof VERIFICATION | null;
  manifest?: HarnessManifest;
}) {
  return compareRuns({
    baseline: overrides.baseline ?? aggregate(),
    final: overrides.final ?? aggregate({ revision: "bbbbbbb" }),
    baselineSettings: overrides.baselineSettings ?? { settings: { a: 1 }, env: {} },
    finalSettings: overrides.finalSettings ?? { settings: { a: 1 }, env: {} },
    allowlist: overrides.allowlist ?? EMPTY_ALLOWLIST,
    // `null` is a case under test (a leg whose verification is missing), so it
    // must survive as null; only an omitted field takes the default.
    baselineHarness:
      overrides.baselineHarness === undefined ? VERIFICATION : overrides.baselineHarness,
    finalHarness: overrides.finalHarness === undefined ? VERIFICATION : overrides.finalHarness,
    manifest: overrides.manifest ?? VERIFIED,
  });
}

describe("runner argument contract", () => {
  it("defaults to the Chromium headless project and splits flags from positionals", () => {
    const args = parseRunnerArgs(["--grep=running dot", "history/newchat-flow.spec.ts"]);
    expect(args.project).toBe("chromium-headless");
    expect(args.explicit).toEqual(["history/newchat-flow.spec.ts"]);
    expect(args.forwarded).toEqual(["--grep=running dot"]);
    expect(args.jsonDir).toBeNull();
  });

  it("owns --project and never forwards it", () => {
    const args = parseRunnerArgs(["--project=edge-headed"]);
    expect(args.project).toBe("edge-headed");
    expect(args.forwarded).toEqual([]);
  });

  it("resolves a relative JSON directory against the repository root", () => {
    const args = parseRunnerArgs([], {
      repoRoot: "D:\\repo",
      jsonDirEnv: "tests/.artifacts/e2e/run",
    });
    expect(args.jsonDir).toBe(path.resolve("D:\\repo", "tests/.artifacts/e2e/run"));
  });

  it("refuses a caller-supplied reporter in JSON mode, and only in JSON mode", () => {
    const withJson = reporterConflict(["--reporter=json"], "D:\\out");
    expect(withJson).toContain("exactly one reporter mechanism");
    expect(reporterConflict(["--reporter"], "D:\\out")).toContain("exactly one reporter");
    expect(reporterConflict(["--reporter=line"], null)).toBeNull();
  });

  it("maps positionals to spec files without doubling the extension", () => {
    expect(resolveSpecFiles(["history/a", "core/b.spec.ts"])).toEqual([
      "history/a.spec.ts",
      "core/b.spec.ts",
    ]);
  });

  it("discovers specs recursively, sorted, and excludes live specs by default", () => {
    const root = tempDir("tbai-specs-");
    fs.mkdirSync(path.join(root, "history"), { recursive: true });
    fs.mkdirSync(path.join(root, "core"), { recursive: true });
    fs.writeFileSync(path.join(root, "core", "z.spec.ts"), "");
    fs.writeFileSync(path.join(root, "history", "a.spec.ts"), "");
    fs.writeFileSync(path.join(root, "history", "live-live.spec.ts"), "");

    expect(resolveSpecFiles([], { e2eDir: root })).toEqual(["core/z.spec.ts", "history/a.spec.ts"]);
    expect(resolveSpecFiles([], { e2eDir: root, runLive: true })).toEqual([
      "core/z.spec.ts",
      "history/a.spec.ts",
      "history/live-live.spec.ts",
    ]);
  });

  it("gives two specs that sanitise to the same name distinct report files", () => {
    expect(reportFileName("core/a/b.spec.ts")).not.toBe(reportFileName("core/a_b.spec.ts"));
  });

  it("refuses a spec list that names one file more than once", () => {
    // Case folding belongs to the filesystem: on Windows `A.spec.ts` and
    // `a.spec.ts` are one file, so running both would execute a spec twice and
    // write two reports for it. On a case-sensitive filesystem they are two.
    const caseVariant = planJsonReports(["core/A.spec.ts", "core/a.spec.ts"], "D:\\out");
    expect(caseVariant.duplicateSpecs).toEqual(
      process.platform === "win32" ? ["core/a.spec.ts"] : [],
    );

    // An exact repeat is a duplicate everywhere.
    const repeated = planJsonReports(["core/a.spec.ts", "core/a.spec.ts"], "D:\\out");
    expect(repeated.duplicateSpecs).toEqual(["core/a.spec.ts"]);

    // And distinct specs never share a report path, which is why a duplicate
    // spec is the only collision this plan has to detect.
    const distinct = planJsonReports(["core/a.spec.ts", "core/b.spec.ts"], "D:\\out");
    expect(distinct.duplicateSpecs).toEqual([]);
    expect(new Set(distinct.entries.map((entry) => entry.reportPath)).size).toBe(2);
  });

  it("records the inventory exactly as enumerated", () => {
    expect(
      buildInventory(["a.spec.ts", "b.spec.ts"], { project: "p", explicit: [] }, false),
    ).toEqual({
      project: "p",
      live: false,
      explicitArgs: [],
      specFiles: ["a.spec.ts", "b.spec.ts"],
      count: 2,
    });
  });

  it("distinguishes a missing, empty and unparseable report", () => {
    const dir = tempDir("tbai-reports-");
    const missing = path.join(dir, "missing.json");
    const empty = path.join(dir, "empty.json");
    const broken = path.join(dir, "broken.json");
    const valid = path.join(dir, "valid.json");
    fs.writeFileSync(empty, "  \n");
    fs.writeFileSync(broken, "{ not json");
    fs.writeFileSync(valid, '{"suites":[]}');

    expect(readReportFile(missing)).toEqual({ ok: false, problem: "report-missing" });
    expect(readReportFile(empty)).toEqual({ ok: false, problem: "report-empty" });
    expect(readReportFile(broken)).toEqual({ ok: false, problem: "report-unparseable" });
    expect(readReportFile(valid).ok).toBe(true);
  });

  it("keeps package.json's test:e2e target pointed at this runner", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    // A target change would silently bypass JSON mode and the build gate.
    expect(pkg.scripts["test:e2e"]).toBe("bun scripts/run-e2e.ts");
  });
});

describe("playwright settings normalization", () => {
  const config = {
    testDir: "../tests/e2e",
    outputDir: "/abs/playwright",
    fullyParallel: false,
    reporter: "line",
    use: { baseURL: "http://localhost:3101" },
    projects: [
      { name: "chromium-headless", use: { channel: "chromium", headless: true } },
      { name: "edge-headless", use: { channel: "msedge", headless: true } },
    ],
  };

  it("is stable but changes when the browser identity changes", () => {
    const chromium = settingsDigest(normalizeProject(config, "chromium-headless"));
    const edge = settingsDigest(normalizeProject(config, "edge-headless"));
    expect(settingsDigest(normalizeProject(config, "chromium-headless"))).toBe(chromium);
    expect(chromium).not.toBe(edge);
  });

  it("changes when headless changes, with the channel held constant", () => {
    const headed = {
      ...config,
      projects: [{ name: "edge-headed", use: { channel: "msedge", headless: false } }],
    };
    const headless = {
      ...config,
      projects: [{ name: "edge-headed", use: { channel: "msedge", headless: true } }],
    };
    expect(settingsDigest(normalizeProject(headed, "edge-headed"))).not.toBe(
      settingsDigest(normalizeProject(headless, "edge-headed")),
    );
  });

  it("omits the reporter and normalizes paths, executables and launch env", () => {
    const withReporter = {
      ...config,
      reporter: [["json", { outputFile: "/tmp/x.json" }]],
      projects: [
        {
          name: "p",
          use: { launchOptions: { executablePath: "C:\\browser.exe", env: { B: "2", A: "1" } } },
        },
      ],
    };
    const withoutReporter = {
      ...config,
      projects: [
        {
          name: "p",
          use: { launchOptions: { executablePath: "D:\\other.exe", env: { A: "9", B: "8" } } },
        },
      ],
    };
    // Reporter is harness-owned, so it must not affect the digest; the launch env
    // is recorded by KEY LIST only, so its values must not either.
    expect(settingsDigest(normalizeProject(withReporter, "p"))).toBe(
      settingsDigest(normalizeProject(withoutReporter, "p")),
    );
    const use = normalizeProject(withReporter, "p") as {
      top: { outputDir: string };
      project: { use: { launchOptions: unknown } };
    };
    expect(use.top.outputDir).toBe("<abs>");
    expect(use.project.use.launchOptions).toEqual({
      executablePathSet: true,
      envKeys: ["A", "B"],
    });
  });

  it("refuses an unknown project and names the ones that exist", () => {
    expect(() => normalizeProject(config, "firefox")).toThrow(/chromium-headless, edge-headless/);
  });

  it("canonicalises key order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("records a device descriptor as a flag, not as expanded contents", () => {
    expect(normalizeUse({ device: { viewport: { width: 1 } } })).toMatchObject({ device: true });
  });
});

describe("report aggregation", () => {
  const e2eRoot = path.join(REPO_ROOT, "tests", "e2e");

  it("walks nested suites so describe blocks are not dropped", () => {
    const report = {
      suites: [
        {
          title: "outer.spec.ts",
          specs: [],
          suites: [
            {
              title: "a describe",
              suites: [
                {
                  title: "inner describe",
                  specs: [
                    {
                      title: "does a thing",
                      file: path.join(e2eRoot, "core", "outer.spec.ts"),
                      ok: true,
                      tests: [{ status: "expected" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(collectSpecs(report, e2eRoot)).toEqual([
      {
        id: "core/outer.spec.ts::outer.spec.ts > a describe > inner describe > does a thing",
        file: "core/outer.spec.ts",
        titlePath: ["outer.spec.ts", "a describe", "inner describe", "does a thing"],
        status: "passed",
      },
    ]);
  });

  it("maps Playwright's status vocabulary and prefers the worst retry outcome", () => {
    expect(specStatus({ ok: true, tests: [{ status: "expected" }] })).toBe("passed");
    expect(specStatus({ ok: false, tests: [{ status: "unexpected" }] })).toBe("failed");
    expect(specStatus({ ok: true, tests: [{ status: "flaky" }] })).toBe("flaky");
    expect(specStatus({ ok: true, tests: [{ status: "skipped" }] })).toBe("skipped");
    expect(
      specStatus({ ok: false, tests: [{ status: "expected" }, { status: "unexpected" }] }),
    ).toBe("failed");
    expect(specStatus({ ok: false, tests: [{ status: "flaky" }, { status: "unexpected" }] })).toBe(
      "failed",
    );
  });

  it("relativizes report paths so two worktrees compare equal", () => {
    expect(relativeSpecPath(path.join(e2eRoot, "core", "a.spec.ts"), e2eRoot)).toBe(
      "core/a.spec.ts",
    );
    expect(relativeSpecPath("core/a.spec.ts", e2eRoot)).toBe("core/a.spec.ts");
  });

  function makeLeg(options: { specFiles: string[]; reports: Record<string, unknown> }): string {
    const dir = tempDir("tbai-leg-");
    fs.mkdirSync(path.join(dir, "reports"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "inventory.json"),
      JSON.stringify({
        project: "chromium-headless",
        live: false,
        explicitArgs: [],
        specFiles: options.specFiles,
        count: options.specFiles.length,
      }),
    );
    const entries = options.specFiles.map((specFile) => {
      const reportPath = path.join(dir, "reports", reportFileName(specFile));
      const report = options.reports[specFile];
      if (report !== undefined) fs.writeFileSync(reportPath, JSON.stringify(report));
      return { specFile, reportPath };
    });
    fs.writeFileSync(path.join(dir, "reports", "index.json"), JSON.stringify({ entries }));
    return dir;
  }

  it("names a spec whose report is missing instead of counting it as clean", () => {
    const dir = makeLeg({ specFiles: ["core/a.spec.ts", "core/b.spec.ts"], reports: {} });
    const result = aggregateLeg({ jsonDir: dir });
    expect(result.specsWithoutReport).toEqual(["core/a.spec.ts", "core/b.spec.ts"]);
    expect(result.totals.specsWithoutReport).toBe(2);
  });

  it("reports a spec that produced zero tests as a zero, not as silence", () => {
    const dir = makeLeg({
      specFiles: ["core/a.spec.ts", "core/empty.spec.ts"],
      reports: {
        "core/a.spec.ts": {
          suites: [
            {
              title: "a.spec.ts",
              specs: [
                {
                  title: "t",
                  file: path.join(e2eRoot, "core", "a.spec.ts"),
                  ok: true,
                  tests: [{ status: "expected" }],
                },
              ],
            },
          ],
        },
        "core/empty.spec.ts": { suites: [] },
      },
    });
    const result = aggregateLeg({ jsonDir: dir });
    expect(result.specFiles).toEqual(["core/a.spec.ts", "core/empty.spec.ts"]);
    expect(result.specsWithoutTests).toEqual(["core/empty.spec.ts"]);
    expect(result.totals.tests).toBe(1);
  });

  it("flags an inventory that disagrees with the report index", () => {
    const dir = makeLeg({ specFiles: ["core/a.spec.ts"], reports: {} });
    fs.writeFileSync(path.join(dir, "reports", "index.json"), JSON.stringify({ entries: [] }));
    expect(aggregateLeg({ jsonDir: dir }).inventoryMismatch).toBe(true);
  });
});

describe("two-revision comparison", () => {
  const failing = (id: string) => ({ id, file: id.split("::")[0], status: "failed" });
  const passing = (id: string) => ({ id, file: id.split("::")[0], status: "passed" });

  it("accepts two equivalent legs", () => {
    const result = compare({});
    expect(result.ok).toBe(true);
    expect(result.findings.invalid).toEqual([]);
  });

  it("rejects a new failure", () => {
    const result = compare({
      final: aggregate({ revision: "bbbbbbb", tests: [failing("core/a.spec.ts::passes")] }),
    });
    expect(result.ok).toBe(false);
    expect(result.findings.finalOnlyFailures).toEqual([{ id: "core/a.spec.ts::passes" }]);
  });

  it("rejects a removal that keeps the total level — the delete-a-failure pattern", () => {
    const baseline = aggregate({
      tests: [failing("core/a.spec.ts::broken"), passing("core/a.spec.ts::works")],
    });
    const final = aggregate({
      revision: "bbbbbbb",
      tests: [passing("core/a.spec.ts::works"), passing("core/a.spec.ts::new")],
    });
    const result = compare({ baseline, final });
    expect(result.ok).toBe(false);
    expect(result.findings.removedWhileFailing).toEqual([{ id: "core/a.spec.ts::broken" }]);
    expect(result.findings.unexplainedRemoval).toContainEqual({
      kind: "test",
      name: "core/a.spec.ts::broken",
    });
  });

  it("distinguishes a fixed test from a disappeared one", () => {
    const baseline = aggregate({ tests: [failing("core/a.spec.ts::was-broken")] });
    const fixed = compare({
      baseline,
      final: aggregate({ revision: "bbbbbbb", tests: [passing("core/a.spec.ts::was-broken")] }),
    });
    expect(fixed.findings.baselineOnlyFailures).toEqual([
      { id: "core/a.spec.ts::was-broken", finalStatus: "passed" },
    ]);

    const gone = compare({ baseline, final: aggregate({ revision: "bbbbbbb", tests: [] }) });
    expect(gone.findings.baselineOnlyFailures).toEqual([
      { id: "core/a.spec.ts::was-broken", finalStatus: "removed" },
    ]);
    expect(gone.ok).toBe(false);
  });

  it("clears an allowlisted removal, and only with a stated reason", () => {
    const baseline = aggregate({
      tests: [passing("core/a.spec.ts::obsolete"), passing("core/a.spec.ts::kept")],
    });
    const final = aggregate({
      revision: "bbbbbbb",
      tests: [passing("core/a.spec.ts::kept")],
    });
    const allowed = compare({
      baseline,
      final,
      allowlist: {
        ...EMPTY_ALLOWLIST,
        removedTests: [{ identity: "core/a.spec.ts::obsolete", reason: "feature removed" }],
      },
    });
    expect(allowed.ok).toBe(true);
    expect(allowed.findings.testsRemoved).toEqual([{ id: "core/a.spec.ts::obsolete" }]);

    const unstated = compare({
      baseline,
      final,
      allowlist: {
        ...EMPTY_ALLOWLIST,
        removedTests: [{ identity: "core/a.spec.ts::obsolete", reason: "" }],
      },
    });
    expect(unstated.ok).toBe(false);
    expect(unstated.findings.invalid.join(" ")).toContain("lacks identity or reason");
  });

  it("treats an allowlisted spec removal as covering that spec's tests", () => {
    const baseline = aggregate({
      specFiles: ["core/a.spec.ts", "core/gone.spec.ts"],
      tests: [passing("core/gone.spec.ts::t")],
    });
    const result = compare({
      baseline,
      final: aggregate({ revision: "bbbbbbb", specFiles: ["core/a.spec.ts"], tests: [] }),
      allowlist: {
        ...EMPTY_ALLOWLIST,
        removedSpecs: [{ specFile: "core/gone.spec.ts", reason: "suite retired" }],
      },
    });
    expect(result.findings.specsRemoved).toEqual([{ specFile: "core/gone.spec.ts" }]);
    expect(result.findings.unexplainedRemoval).toEqual([]);
  });

  it("blocks a settings divergence unless the exact field, values and reason are allowlisted", () => {
    const baselineSettings = { settings: { project: { use: { headless: true } } }, env: {} };
    const finalSettings = { settings: { project: { use: { headless: false } } }, env: {} };

    const blocked = compare({ baselineSettings, finalSettings });
    expect(blocked.ok).toBe(false);
    expect(blocked.findings.unexplainedDivergence).toEqual([
      { fieldPath: "settings.project.use.headless", baseline: true, final: false },
    ]);

    const exact = compare({
      baselineSettings,
      finalSettings,
      allowlist: {
        ...EMPTY_ALLOWLIST,
        settingsDivergence: [
          {
            fieldPath: "settings.project.use.headless",
            baseline: true,
            final: false,
            justification: "headed leg added deliberately",
          },
        ],
      },
    });
    expect(exact.ok).toBe(true);

    // Same path, different values: an approximate match is not a decision.
    const approximate = compare({
      baselineSettings,
      finalSettings,
      allowlist: {
        ...EMPTY_ALLOWLIST,
        settingsDivergence: [
          {
            fieldPath: "settings.project.use.headless",
            baseline: false,
            final: true,
            justification: "wrong direction",
          },
        ],
      },
    });
    expect(approximate.ok).toBe(false);
    expect(approximate.findings.unexplainedDivergence.length).toBe(1);
  });

  it("reports environment divergence separately from settings", () => {
    const diffs = diffSettings(
      { settings: { a: 1 }, env: { LIVE: null } },
      {
        settings: { a: 1 },
        env: { LIVE: "1" },
      },
    );
    expect(diffs).toEqual([{ fieldPath: "env.LIVE", baseline: null, final: "1" }]);
  });

  it("refuses to compare legs without a passing, manifest-equal harness verification", () => {
    const missing = compare({ baselineHarness: null });
    expect(missing.ok).toBe(false);
    expect(missing.findings.invalid.join(" ")).toContain("harness verification is missing");

    const tampered = compare({
      finalHarness: { ...VERIFICATION, files: { "scripts/run-e2e.ts": "0".repeat(64) } },
    });
    expect(tampered.ok).toBe(false);
    expect(tampered.findings.invalid.join(" ")).toContain("do not match the manifest");

    const failed = compare({
      baselineHarness: { ...VERIFICATION, ok: false, failures: ["hash-mismatch"] },
    });
    expect(failed.ok).toBe(false);
    expect(failed.findings.invalid.join(" ")).toContain("harness verification failed");
  });

  it("refuses a self-comparison: one revision is not a baseline", () => {
    const result = compare({ final: aggregate() });
    expect(result.ok).toBe(false);
    expect(result.findings.invalid.join(" ")).toContain("same revision");
  });

  it("refuses a leg that lost reports or mismatched its inventory", () => {
    const result = compare({
      final: aggregate({
        revision: "bbbbbbb",
        specsWithoutReport: ["core/a.spec.ts"],
        inventoryMismatch: true,
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.findings.invalid.join(" ")).toContain("without a report");
    expect(result.findings.invalid.join(" ")).toContain("inventory does not match");
  });

  it("does not treat a live-enabled leg as comparable evidence", () => {
    const result = compare({ final: aggregate({ revision: "bbbbbbb", live: true }) });
    expect(result.ok).toBe(false);
    expect(result.findings.invalid.join(" ")).toContain("live specs enabled");
  });

  it("flattens nested settings without losing leaf names", () => {
    expect(flatten({ a: { b: { c: 1 } }, d: [1, 2] })).toEqual({ "a.b.c": 1, d: [1, 2] });
  });

  it("rejects an allowlist entry that states no reason", () => {
    expect(
      allowlistProblems({
        schemaVersion: 1,
        removedTests: [{ identity: "x", reason: "  " }],
        removedSpecs: [],
        settingsDivergence: [{ fieldPath: "y", baseline: 1, final: 2, justification: "" }],
      }),
    ).toHaveLength(2);
  });
});

describe("pinned-harness guard, executed against real repositories", () => {
  const baseFiles = {
    "scripts/run-e2e.ts": "// baseline runner\n",
  };

  it("accepts a harness applied by git show: worktree changes plus expected untracked files", () => {
    const { dir, revision } = makeRepo(baseFiles);
    // `git show H:file > file` overwrites without touching the index.
    fs.writeFileSync(path.join(dir, "scripts", "run-e2e.ts"), "// harness runner\n");
    fs.writeFileSync(path.join(dir, "scripts", "new-harness.ts"), "// new harness\n");
    const manifest = manifestFor({
      "scripts/run-e2e.ts": "// harness runner\n",
      "scripts/new-harness.ts": "// new harness\n",
    });

    const result = verifyHarnessInjection({ repoRoot: dir, revision, manifest });
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(Object.keys(result.files)).toEqual(["scripts/run-e2e.ts", "scripts/new-harness.ts"]);
  });

  it("accepts a checkout's CRLF conversion, and still rejects a content change", () => {
    const { dir, revision } = makeRepo(baseFiles);
    // `git show` emits LF; `core.autocrlf=true` is what turns a checkout into
    // CRLF. The manifest pins content, so the conversion must not read as an
    // edit — while a genuine edit still must.
    fs.writeFileSync(
      path.join(dir, "scripts", "run-e2e.ts"),
      "// harness line one\r\n// line two\r\n",
    );
    const manifest = manifestFor({ "scripts/run-e2e.ts": "// harness line one\n// line two\n" });

    const accepted = verifyHarnessInjection({ repoRoot: dir, revision, manifest });
    expect(accepted.failures).toEqual([]);
    expect(accepted.ok).toBe(true);

    fs.writeFileSync(
      path.join(dir, "scripts", "run-e2e.ts"),
      "// harness line one\r\n// line TWO\r\n",
    );
    const rejected = verifyHarnessInjection({ repoRoot: dir, revision, manifest });
    expect(rejected.ok).toBe(false);
    expect(rejected.failures.join(" ")).toContain("hash-mismatch");
  });

  it("rejects a STAGED change — what `git checkout H -- file` would produce", () => {
    const { dir, revision } = makeRepo(baseFiles);
    fs.writeFileSync(path.join(dir, "scripts", "run-e2e.ts"), "// harness runner\n");
    git(dir, ["add", "scripts/run-e2e.ts"]);

    const result = verifyHarnessInjection({
      repoRoot: dir,
      revision,
      manifest: manifestFor({ "scripts/run-e2e.ts": "// harness runner\n" }),
    });
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toContain("staged: scripts/run-e2e.ts");
  });

  it("rejects an untracked file that is not in the manifest", () => {
    const { dir, revision } = makeRepo(baseFiles);
    fs.writeFileSync(path.join(dir, "scripts", "run-e2e.ts"), "// harness runner\n");
    fs.writeFileSync(path.join(dir, "scripts", "stray-artifact.json"), "{}\n");

    const result = verifyHarnessInjection({
      repoRoot: dir,
      revision,
      manifest: manifestFor({ "scripts/run-e2e.ts": "// harness runner\n" }),
    });
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toContain(
      "unexpected-untracked: scripts/stray-artifact.json",
    );
  });

  it("rejects a modified file the manifest does not pin", () => {
    const { dir, revision } = makeRepo({ ...baseFiles, "scripts/other.ts": "// other\n" });
    fs.writeFileSync(path.join(dir, "scripts", "run-e2e.ts"), "// harness runner\n");
    fs.writeFileSync(path.join(dir, "scripts", "other.ts"), "// edited\n");

    const result = verifyHarnessInjection({
      repoRoot: dir,
      revision,
      manifest: manifestFor({ "scripts/run-e2e.ts": "// harness runner\n" }),
    });
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toContain("unexpected-change: scripts/other.ts");
    expect(result.failures.join(" ")).toContain("unexpected-modification: scripts/other.ts");
  });

  it("rejects content that does not match the pinned hash", () => {
    const { dir, revision } = makeRepo(baseFiles);
    fs.writeFileSync(path.join(dir, "scripts", "run-e2e.ts"), "// tampered\n");

    const result = verifyHarnessInjection({
      repoRoot: dir,
      revision,
      manifest: manifestFor({ "scripts/run-e2e.ts": "// harness runner\n" }),
    });
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toContain("hash-mismatch: scripts/run-e2e.ts");
  });

  it("rejects a worktree that is not the revision under test", () => {
    const { dir } = makeRepo(baseFiles);
    fs.writeFileSync(path.join(dir, "scripts", "run-e2e.ts"), "// harness runner\n");

    const result = verifyHarnessInjection({
      repoRoot: dir,
      revision: "0".repeat(40),
      manifest: manifestFor({ "scripts/run-e2e.ts": "// harness runner\n" }),
    });
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toContain("worktree HEAD is");
  });

  it("rejects a deleted harness file", () => {
    const { dir, revision } = makeRepo(baseFiles);
    fs.rmSync(path.join(dir, "scripts", "run-e2e.ts"));

    const result = verifyHarnessInjection({
      repoRoot: dir,
      revision,
      manifest: manifestFor({ "scripts/run-e2e.ts": "// baseline runner\n" }),
    });
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toContain("forbidden-status: scripts/run-e2e.ts");
    expect(result.failures.join(" ")).toContain("missing: scripts/run-e2e.ts");
  });

  it("parses porcelain entries by their two independent columns", () => {
    expect(parsePorcelainZ(" M scripts/run-e2e.ts\0?? scripts/new.ts\0")).toEqual([
      { index: " ", worktree: "M", path: "scripts/run-e2e.ts" },
      { index: "?", worktree: "?", path: "scripts/new.ts" },
    ]);
  });
});

describe("the repository's harness files are pinned, not described", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "scripts", "e2e-harness.manifest.json"), "utf8"),
  ) as HarnessManifest;

  it("lists exactly the six harness files, and no others", () => {
    expect(manifest.files.map((file) => file.path).sort()).toEqual([
      "scripts/aggregate-e2e-reports.ts",
      "scripts/compare-e2e-reports.ts",
      "scripts/dump-playwright-settings.ts",
      "scripts/e2e-removal-allowlist.json",
      "scripts/run-e2e.ts",
      "web/playwright.json-reporter.config.ts",
    ]);
  });

  it("pins the hash that each file actually has", () => {
    for (const file of manifest.files) {
      // CRLF normalized: the manifest pins content, and `core.autocrlf=true`
      // checks these files out with CRLF while `git show` in CI emits LF.
      const actual = createHash("sha256")
        .update(fs.readFileSync(path.join(REPO_ROOT, file.path), "utf8").replace(/\r\n/g, "\n"))
        .digest("hex");
      expect(`${file.path}: ${actual}`).toBe(`${file.path}: ${file.sha256}`);
    }
  });

  it("points at an allowlist whose entries all state a reason", () => {
    const allowlistPath = path.join(REPO_ROOT, manifest.allowlist.path);
    const allowlist = JSON.parse(fs.readFileSync(allowlistPath, "utf8")) as RemovalAllowlist;
    expect(allowlist.schemaVersion).toBe(1);
    expect(allowlistProblems(allowlist)).toEqual([]);
  });
});

describe("the two-revision comparison is wired into CI", () => {
  const workflow = fs.readFileSync(
    path.join(REPO_ROOT, ".github", "workflows", "tests.yml"),
    "utf8",
  );

  function jobBlock(job: string): string {
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

  it("defines an e2e-full job that only runs on dispatch", () => {
    const job = jobBlock("e2e-full");
    expect(job).not.toBe("");
    expect(job).toContain("workflow_dispatch");
    expect(job).toContain("final_sha");
  });

  it("runs the non-live suite through the runner with no positional scope", () => {
    const job = jobBlock("e2e-full");
    expect(job).toContain("bun run test:e2e --project=");
    // A positional `tests/e2e` would become `tests/e2e.spec.ts` and match nothing.
    expect(job).not.toMatch(/test:e2e\s+tests\/e2e/);
    expect(job).toContain("TBAI_E2E_JSON_DIR");
  });

  it("verifies the harness, aggregates and compares, then uploads the evidence", () => {
    const job = jobBlock("e2e-full");
    expect(job).toContain("--verify-injection");
    expect(job).toContain("aggregate-e2e-reports.ts");
    expect(job).toContain("compare-e2e-reports.ts");
    expect(job).toContain("upload-artifact");
    expect(job).toContain("if: always()");
  });
});
