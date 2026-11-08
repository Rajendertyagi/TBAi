/**
 * G5 — the pinned-harness guard and the two-revision comparison.
 *
 * ## Two jobs, one module, because they share one claim
 *
 * The comparison is only evidence if both legs ran the SAME harness. That is not
 * something a reader can check by eye across two worktrees, so it is checked by
 * this module before any result is compared:
 *
 *   1. `--verify-injection` proves the harness was applied to a worktree without
 *      touching the index, and that every file matches the manifest's pinned
 *      hash. It runs per leg and writes a verification record.
 *   2. `--baseline/--final` compares two legs, and REFUSES unless both
 *      verification records are present, `ok`, and map to exactly the manifest's
 *      files.
 *
 * ## What the comparison refuses to do
 *
 * It does not report a net count. Each project is compared on its own, and a
 * removed test is a finding even when the totals stay level — that is precisely
 * how deleting a failing test can look like a fix. `removedWhileFailing` and
 * `unexplainedRemoval` block acceptance; `baselineOnlyFailures` reports what the
 * disappeared test now does, so "fixed" and "gone" stay distinguishable.
 *
 * ## Harness injection guard
 *
 * The harness files are written into each revision's worktree with `git show
 * <harness>:<path> > <path>`, which never touches the index. The guard then
 * requires, for the checked-out revision:
 *
 *   - `HEAD` is the revision under test;
 *   - `git diff --name-only HEAD` is a subset of the manifest paths;
 *   - every `git status --porcelain` entry has a BLANK index column (a staged
 *     change means something other than `git show` wrote the tree), a worktree
 *     `M` only for a manifest path, and `??` only for a path the revision does
 *     not track;
 *   - every manifest file's worktree SHA-256 equals the pinned value.
 *
 * Files a revision does not track are expected to appear untracked after
 * injection; that set is computed from the revision, not assumed.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "./dump-playwright-settings";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MANIFEST = path.join(REPO_ROOT, "scripts", "e2e-harness.manifest.json");

type Unknown = Record<string, unknown>;

export interface HarnessManifest {
  schemaVersion: 1;
  allowlist: { path: string };
  files: { path: string; sha256: string }[];
}

export interface HarnessVerification {
  schemaVersion: 1;
  revision: string;
  ok: boolean;
  failures: string[];
  /** path -> worktree sha256, for every manifest file. */
  files: Record<string, string>;
}

/**
 * SHA-256 of a file's CONTENT, with CRLF normalized to LF.
 *
 * The harness is injected with `git show`, which emits the bytes git stores —
 * LF — while `core.autocrlf=true` checks the rest of a Windows worktree out as
 * CRLF. Hashing raw bytes would therefore compare a checkout's line endings
 * instead of the harness's content. Normalizing on both sides keeps the check
 * about content: a real edit still changes the digest.
 */
function sha256File(file: string): string {
  const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  return createHash("sha256").update(text).digest("hex");
}

function git(repoRoot: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/**
 * Parse `git status --porcelain=v1 -z` into `{ index, worktree, path }` entries.
 *
 * The two leading characters are separate columns. Collapsing them to one flag is
 * what lets a staged change look like a worktree edit, and that is the exact
 * distinction the guard depends on.
 */
export function parsePorcelainZ(
  output: string,
): { index: string; worktree: string; path: string }[] {
  return output
    .split("\0")
    .filter((entry) => entry.length > 3)
    .map((entry) => ({
      index: entry[0],
      worktree: entry[1],
      path: entry.slice(3),
    }));
}

/** Verify that a worktree carries exactly the manifest's harness, and nothing else. */
export function verifyHarnessInjection(input: {
  repoRoot: string;
  revision: string;
  manifest: HarnessManifest;
}): HarnessVerification {
  const { repoRoot, revision, manifest } = input;
  const failures: string[] = [];
  const manifestPaths = manifest.files.map((file) => file.path);

  const head = git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim();
  if (head !== revision) {
    failures.push(`worktree HEAD is ${head || "(unknown)"}, expected ${revision}`);
  }

  const tracked = new Set<string>();
  for (const file of manifestPaths) {
    if (git(repoRoot, ["cat-file", "-e", `${revision}:${file}`]).status === 0) tracked.add(file);
  }
  const expectedUntracked = new Set(manifestPaths.filter((file) => !tracked.has(file)));

  const changed = git(repoRoot, ["diff", "--name-only", "HEAD"])
    .stdout.split(/\r?\n/)
    .filter(Boolean);
  for (const file of changed) {
    if (!manifestPaths.includes(file)) failures.push(`unexpected-change: ${file}`);
  }

  const porcelain = parsePorcelainZ(
    git(repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).stdout,
  );
  for (const entry of porcelain) {
    // `??` is the ONLY entry whose index column is not a space; it is handled
    // first so an expected new harness file is not misread as a staged change.
    if (entry.index === "?" && entry.worktree === "?") {
      if (!expectedUntracked.has(entry.path)) failures.push(`unexpected-untracked: ${entry.path}`);
      continue;
    }
    if (entry.index !== " ") {
      failures.push(`staged: ${entry.path} (index column "${entry.index}")`);
      continue;
    }
    if (entry.worktree === "M") {
      if (!manifestPaths.includes(entry.path))
        failures.push(`unexpected-modification: ${entry.path}`);
      continue;
    }
    failures.push(`forbidden-status: ${entry.path} ("${entry.index}${entry.worktree}")`);
  }

  const files: Record<string, string> = {};
  for (const file of manifest.files) {
    const absolute = path.join(repoRoot, file.path);
    try {
      files[file.path] = sha256File(absolute);
    } catch {
      failures.push(`missing: ${file.path}`);
      continue;
    }
    if (files[file.path] !== file.sha256) {
      failures.push(`hash-mismatch: ${file.path}`);
    }
  }

  return {
    schemaVersion: 1,
    revision,
    ok: failures.length === 0,
    failures,
    files,
  };
}

/** Flatten a normalized settings/env object into `{ fieldPath: value }`. */
export function flatten(value: unknown, prefix = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value as Unknown)) {
      const next = prefix ? `${prefix}.${key}` : key;
      if (child && typeof child === "object" && !Array.isArray(child)) {
        Object.assign(out, flatten(child, next));
      } else {
        out[next] = child;
      }
    }
    return out;
  }
  out[prefix || "<root>"] = value;
  return out;
}

export interface FieldDiff {
  fieldPath: string;
  baseline: unknown;
  final: unknown;
}

/**
 * Field-level differences between two legs' settings and recorded environment.
 *
 * `settings.` and `env.` are both included: a harness setting and the environment
 * that selects it are equally capable of changing what runs, and the plan's
 * "recorded alongside" exists so the second is visible rather than silent.
 */
export function diffSettings(
  baseline: { settings?: unknown; env?: unknown } | null,
  final: { settings?: unknown; env?: unknown } | null,
): FieldDiff[] {
  const left = {
    ...prefixAll(flatten(baseline?.settings), "settings."),
    ...prefixAll(flatten(baseline?.env), "env."),
  };
  const right = {
    ...prefixAll(flatten(final?.settings), "settings."),
    ...prefixAll(flatten(final?.env), "env."),
  };
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  const diffs: FieldDiff[] = [];
  for (const key of keys) {
    if (canonicalJson(left[key]) !== canonicalJson(right[key])) {
      diffs.push({
        fieldPath: key,
        baseline: left[key] === undefined ? null : left[key],
        final: right[key] === undefined ? null : right[key],
      });
    }
  }
  return diffs;
}

function prefixAll(record: Record<string, unknown>, prefix: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) out[`${prefix}${key}`] = value;
  return out;
}

export interface RemovalAllowlist {
  schemaVersion: 1;
  removedTests: { identity: string; reason: string }[];
  removedSpecs: { specFile: string; reason: string }[];
  settingsDivergence: {
    fieldPath: string;
    baseline: unknown;
    final: unknown;
    justification: string;
  }[];
}

export interface AggregateLike {
  project: string;
  revision: string | null;
  live: boolean;
  specFiles: string[];
  specsWithoutReport: string[];
  inventoryMismatch: boolean;
  tests: { id: string; file: string; status: string }[];
  settingsDigest: string | null;
  settingsFile: string | null;
}

export interface Comparison {
  schemaVersion: 1;
  project: string;
  baseline: {
    revision: string | null;
    digest: string | null;
    totals: Record<string, number>;
  } | null;
  final: { revision: string | null; digest: string | null; totals: Record<string, number> } | null;
  findings: {
    baselineOnlyFailures: { id: string; finalStatus: string }[];
    finalOnlyFailures: { id: string }[];
    commonFailures: { id: string }[];
    removedWhileFailing: { id: string }[];
    specsRemoved: { specFile: string }[];
    testsRemoved: { id: string }[];
    unexplainedRemoval: { kind: "test" | "spec"; name: string }[];
    settingsDivergence: FieldDiff[];
    unexplainedDivergence: FieldDiff[];
    invalid: string[];
  };
  ok: boolean;
}

function failedIds(aggregate: AggregateLike): Set<string> {
  return new Set(aggregate.tests.filter((test) => test.status === "failed").map((test) => test.id));
}

/** Validate the allowlist itself: a bare entry without a reason is not a decision. */
export function allowlistProblems(allowlist: RemovalAllowlist): string[] {
  const problems: string[] = [];
  for (const entry of allowlist.removedTests ?? []) {
    if (!entry.identity || !entry.reason?.trim())
      problems.push("removedTests entry lacks identity or reason");
  }
  for (const entry of allowlist.removedSpecs ?? []) {
    if (!entry.specFile || !entry.reason?.trim())
      problems.push("removedSpecs entry lacks specFile or reason");
  }
  for (const entry of allowlist.settingsDivergence ?? []) {
    if (!entry.fieldPath || !entry.justification?.trim()) {
      problems.push("settingsDivergence entry lacks fieldPath or justification");
    }
  }
  return problems;
}

/** Compare two legs of the same project. Never a net count. */
export function compareRuns(input: {
  baseline: AggregateLike | null;
  final: AggregateLike | null;
  baselineSettings: { settings?: unknown; env?: unknown } | null;
  finalSettings: { settings?: unknown; env?: unknown } | null;
  allowlist: RemovalAllowlist;
  /** Verification records; the comparison refuses to proceed without them. */
  baselineHarness: HarnessVerification | null;
  finalHarness: HarnessVerification | null;
  manifest: HarnessManifest;
}): Comparison {
  const invalid: string[] = [];
  const { baseline, final, allowlist } = input;

  if (!baseline) invalid.push("baseline aggregate is missing");
  if (!final) invalid.push("final aggregate is missing");
  if (baseline && final && baseline.project !== final.project) {
    invalid.push(`project mismatch: ${baseline.project} vs ${final.project}`);
  }
  for (const [label, aggregate] of [
    ["baseline", baseline],
    ["final", final],
  ] as const) {
    if (!aggregate) continue;
    if (aggregate.live) invalid.push(`${label} leg ran with live specs enabled`);
    if (aggregate.inventoryMismatch)
      invalid.push(`${label} inventory does not match its report index`);
    if (aggregate.specsWithoutReport.length > 0) {
      invalid.push(`${label} has ${aggregate.specsWithoutReport.length} spec(s) without a report`);
    }
    if (!aggregate.revision) invalid.push(`${label} aggregate has no revision`);
  }
  if (baseline?.revision && final?.revision && baseline.revision === final.revision) {
    invalid.push(`both legs report the same revision (${final.revision})`);
  }
  // A missing settings document is not "no divergence": without it the field
  // diff would compare nothing against something and call the result equal.
  if (!input.baselineSettings) invalid.push("baseline settings document is missing");
  if (!input.finalSettings) invalid.push("final settings document is missing");

  const manifestMap = Object.fromEntries(input.manifest.files.map((f) => [f.path, f.sha256]));
  for (const [label, verification] of [
    ["baseline", input.baselineHarness],
    ["final", input.finalHarness],
  ] as const) {
    if (!verification) {
      invalid.push(
        `${label} harness verification is missing — refusing to compare unverified legs`,
      );
      continue;
    }
    if (!verification.ok) {
      invalid.push(`${label} harness verification failed: ${verification.failures.join("; ")}`);
    }
    if (canonicalJson(verification.files) !== canonicalJson(manifestMap)) {
      invalid.push(`${label} harness files do not match the manifest`);
    }
  }

  invalid.push(...allowlistProblems(allowlist));

  const empty = {
    baselineOnlyFailures: [],
    finalOnlyFailures: [],
    commonFailures: [],
    removedWhileFailing: [],
    specsRemoved: [],
    testsRemoved: [],
    unexplainedRemoval: [],
    settingsDivergence: [] as FieldDiff[],
    unexplainedDivergence: [] as FieldDiff[],
    invalid,
  };

  if (!baseline || !final || baseline.project !== final.project) {
    return {
      schemaVersion: 1,
      project: final?.project ?? baseline?.project ?? "",
      baseline: baseline ? summarise(baseline) : null,
      final: final ? summarise(final) : null,
      findings: empty,
      ok: false,
    };
  }

  const baselineFailed = failedIds(baseline);
  const finalFailed = failedIds(final);
  const finalStatus = new Map(final.tests.map((test) => [test.id, test.status]));
  const baselineStatus = new Map(baseline.tests.map((test) => [test.id, test.status]));
  const finalIds = new Set(finalStatus.keys());
  const baselineIds = new Set(baselineStatus.keys());

  const testsRemoved = [...baselineIds].filter((id) => !finalIds.has(id)).sort();
  const specsRemoved = baseline.specFiles.filter((file) => !final.specFiles.includes(file)).sort();
  const allowedSpecs = new Set(
    (allowlist.removedSpecs ?? []).map((entry) => entry.specFile).filter(Boolean),
  );
  const allowedTests = new Set(
    (allowlist.removedTests ?? []).map((entry) => entry.identity).filter(Boolean),
  );
  const unexplainedRemoval = [
    ...specsRemoved
      .filter((file) => !allowedSpecs.has(file))
      .map((file) => ({ kind: "spec" as const, name: file })),
    ...testsRemoved
      .filter((id) => !allowedTests.has(id) && !allowedSpecs.has(id.split("::")[0]))
      .map((id) => ({ kind: "test" as const, name: id })),
  ];

  const settingsDivergence = diffSettings(input.baselineSettings, input.finalSettings);
  const unexplainedDivergence = settingsDivergence.filter(
    (diff) =>
      !(allowlist.settingsDivergence ?? []).some(
        (entry) =>
          entry.fieldPath === diff.fieldPath &&
          canonicalJson(entry.baseline) === canonicalJson(diff.baseline) &&
          canonicalJson(entry.final) === canonicalJson(diff.final),
      ),
  );

  const findings = {
    baselineOnlyFailures: [...baselineFailed]
      .filter((id) => !finalFailed.has(id))
      .sort()
      .map((id) => {
        if (!finalIds.has(id)) return { id, finalStatus: "removed" };
        return { id, finalStatus: finalStatus.get(id) ?? "unknown" };
      }),
    finalOnlyFailures: [...finalFailed]
      .filter((id) => !baselineFailed.has(id))
      .sort()
      .map((id) => ({ id })),
    commonFailures: [...finalFailed]
      .filter((id) => baselineFailed.has(id))
      .sort()
      .map((id) => ({ id })),
    removedWhileFailing: testsRemoved.filter((id) => baselineFailed.has(id)).map((id) => ({ id })),
    specsRemoved: specsRemoved.map((specFile) => ({ specFile })),
    testsRemoved: testsRemoved.map((id) => ({ id })),
    unexplainedRemoval,
    settingsDivergence,
    unexplainedDivergence,
    invalid,
  };

  const ok =
    invalid.length === 0 &&
    findings.finalOnlyFailures.length === 0 &&
    findings.removedWhileFailing.length === 0 &&
    findings.unexplainedRemoval.length === 0 &&
    findings.unexplainedDivergence.length === 0;

  return {
    schemaVersion: 1,
    project: final.project,
    baseline: summarise(baseline),
    final: summarise(final),
    findings,
    ok,
  };
}

function summarise(aggregate: AggregateLike): {
  revision: string | null;
  digest: string | null;
  totals: Record<string, number>;
} {
  const totals: Record<string, number> = { tests: aggregate.tests.length };
  for (const status of ["passed", "failed", "flaky", "skipped"]) {
    totals[status] = aggregate.tests.filter((test) => test.status === status).length;
  }
  totals.specFiles = aggregate.specFiles.length;
  return { revision: aggregate.revision, digest: aggregate.settingsDigest, totals };
}

async function main(argv: readonly string[]): Promise<number> {
  const option = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(
      "Usage:\n" +
        "  bun scripts/compare-e2e-reports.ts --verify-injection --repo=<dir> --revision=<sha> " +
        "[--manifest=<file>] [--out=<file>]\n" +
        "  bun scripts/compare-e2e-reports.ts --baseline=<aggregate> --final=<aggregate> " +
        "--baseline-harness=<verify> --final-harness=<verify> [--manifest=<file>] [--out=<file>]",
    );
    return 0;
  }

  const manifestPath = path.resolve(option("manifest") ?? DEFAULT_MANIFEST);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as HarnessManifest;

  const repo = option("repo");
  const revision = option("revision");
  if (argv.includes("--verify-injection")) {
    if (!repo || !revision) {
      console.error("[compare] --verify-injection needs --repo and --revision");
      return 1;
    }
    const verification = verifyHarnessInjection({
      repoRoot: path.resolve(repo),
      revision,
      manifest,
    });
    const out = option("out");
    const text = `${JSON.stringify(verification, null, 2)}\n`;
    if (out) {
      fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
      fs.writeFileSync(out, text, "utf8");
    } else {
      process.stdout.write(text);
    }
    console.log(
      `[compare] harness ${verification.ok ? "OK" : "FAILED"} at ${revision}` +
        (verification.failures.length ? ` — ${verification.failures.join("; ")}` : ""),
    );
    return verification.ok ? 0 : 1;
  }

  const baselinePath = option("baseline");
  const finalPath = option("final");
  const baselineHarnessPath = option("baseline-harness");
  const finalHarnessPath = option("final-harness");
  if (!baselinePath || !finalPath) {
    console.error("[compare] --baseline and --final are required");
    return 1;
  }

  const readJson = <T>(file: string | undefined): T | null =>
    file ? (JSON.parse(fs.readFileSync(file, "utf8")) as T) : null;

  const allowlistPath = path.resolve(
    option("allowlist") ?? path.join(REPO_ROOT, manifest.allowlist.path),
  );
  const allowlist = JSON.parse(fs.readFileSync(allowlistPath, "utf8")) as RemovalAllowlist;

  const baseline = readJson<AggregateLike>(baselinePath);
  const final = readJson<AggregateLike>(finalPath);

  // Settings documents live beside each aggregate; they are what the field-level
  // divergence diff reads. A missing one is not "no difference".
  const settingsFor = (
    aggregate: AggregateLike | null,
  ): { settings?: unknown; env?: unknown } | null => {
    if (!aggregate?.settingsFile) return null;
    try {
      const doc = JSON.parse(fs.readFileSync(aggregate.settingsFile, "utf8")) as Unknown;
      return { settings: doc.settings, env: doc.env };
    } catch {
      return null;
    }
  };

  const comparison = compareRuns({
    baseline,
    final,
    baselineSettings: settingsFor(baseline),
    finalSettings: settingsFor(final),
    allowlist,
    baselineHarness: readJson<HarnessVerification>(baselineHarnessPath),
    finalHarness: readJson<HarnessVerification>(finalHarnessPath),
    manifest,
  });

  const out = option("out");
  const text = `${JSON.stringify(comparison, null, 2)}\n`;
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, text, "utf8");
  } else {
    process.stdout.write(text);
  }

  const f = comparison.findings;
  console.log(
    `[compare] ${comparison.project}: ${comparison.ok ? "ACCEPTED" : "REJECTED"} — ` +
      `${f.finalOnlyFailures.length} new failure(s), ` +
      `${f.removedWhileFailing.length} removed-while-failing, ` +
      `${f.unexplainedRemoval.length} unexplained removal(s), ` +
      `${f.unexplainedDivergence.length} unexplained divergence(s), ` +
      `${f.invalid.length} invalid`,
  );
  for (const entry of f.invalid) console.error(`[compare]   invalid: ${entry}`);
  for (const entry of f.finalOnlyFailures) console.error(`[compare]   new failure: ${entry.id}`);
  for (const entry of f.removedWhileFailing)
    console.error(`[compare]   removed while failing: ${entry.id}`);
  for (const entry of f.unexplainedRemoval) {
    console.error(`[compare]   unexplained ${entry.kind} removal: ${entry.name}`);
  }
  for (const entry of f.unexplainedDivergence) {
    console.error(`[compare]   unexplained divergence: ${entry.fieldPath}`);
  }
  return comparison.ok ? 0 : 1;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
