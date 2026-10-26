/**
 * Turn one leg's per-spec Playwright JSON reports into a single comparable record.
 *
 * ## Why identities, not counts
 *
 * A count says "41 tests ran". It cannot say WHICH. When a test disappears, the
 * counts move by one and every summary still looks healthy — which is exactly
 * how removing a failing test reads as a fix. So this aggregate keeps the stable
 * identity of every test (`<relative spec file>::<describe > describe > title>`)
 * and every spec file the runner enumerated, and the comparison works on those
 * sets. Durations, retry indices, worker ids, line numbers and stack text are
 * deliberately absent: they change between runs and would drown the signal.
 *
 * ## Why the inventory comes from the runner
 *
 * `inventory.json` is written by `scripts/run-e2e.ts` from the same list it
 * passes to Playwright. A spec that exists but produced no report is therefore
 * an explicit `specsWithoutReport` entry, not silence, and a spec that produced
 * no tests is an explicit zero. Nothing here re-discovers spec files.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type Unknown = Record<string, unknown>;

export type TestStatus = "passed" | "failed" | "flaky" | "skipped" | "unknown";

export interface AggregatedTest {
  /** Stable across runs: `<relative spec path>::<title path>`. */
  id: string;
  file: string;
  titlePath: string[];
  status: TestStatus;
}

export interface Aggregate {
  schemaVersion: 1;
  project: string;
  revision: string | null;
  live: boolean;
  explicitArgs: string[];
  /** Spec files the runner enumerated and executed. */
  specFiles: string[];
  /** Specs whose child report was missing/empty/unparseable. */
  specsWithoutReport: string[];
  /** Specs that produced at least one report but zero test identities. */
  specsWithoutTests: string[];
  /** Set when the report index and the inventory disagree. */
  inventoryMismatch: boolean;
  tests: AggregatedTest[];
  totals: {
    specFiles: number;
    tests: number;
    passed: number;
    failed: number;
    flaky: number;
    skipped: number;
    unknown: number;
    specsWithoutReport: number;
    specsWithoutTests: number;
  };
  settingsFile: string | null;
  settingsDigest: string | null;
}

/** Relative POSIX path for a report's file, so two worktrees compare equal. */
export function relativeSpecPath(file: string, e2eRoot: string): string {
  const rel = path.relative(e2eRoot, path.resolve(e2eRoot, file));
  return (rel.startsWith("..") ? path.resolve(file) : rel).split(path.sep).join("/");
}

function worstStatus(current: TestStatus | undefined, next: TestStatus): TestStatus {
  const rank: Record<TestStatus, number> = {
    failed: 4,
    flaky: 3,
    unknown: 2,
    skipped: 1,
    passed: 0,
  };
  if (!current) return next;
  return rank[next] > rank[current] ? next : current;
}

/** One Playwright spec's status, from its tests rather than from `ok` alone. */
export function specStatus(spec: Unknown): TestStatus {
  const tests = (spec.tests ?? []) as Unknown[];
  if (tests.length === 0) return spec.ok === false ? "failed" : "unknown";
  let status: TestStatus = "passed";
  for (const test of tests) {
    const value = test.status;
    if (value === "unexpected" || value === "timedOut") status = worstStatus(status, "failed");
    else if (value === "flaky") status = worstStatus(status, "flaky");
    else if (value === "skipped") status = worstStatus(status, "skipped");
  }
  return status;
}

/**
 * Walk the reporter's nested suites, collecting one entry per spec.
 *
 * The reporter nests `suites` inside `suites` and only the innermost level holds
 * `specs`, so a flat read of `report.suites[].specs` silently drops every test
 * inside a `test.describe`.
 */
export function collectSpecs(report: Unknown, e2eRoot: string): AggregatedTest[] {
  const found = new Map<string, AggregatedTest>();
  const walk = (suite: Unknown, parents: string[]): void => {
    const title = typeof suite.title === "string" && suite.title.length > 0 ? suite.title : null;
    const titles = title ? [...parents, title] : parents;
    for (const spec of (suite.specs ?? []) as Unknown[]) {
      const file = typeof spec.file === "string" ? spec.file : String(suite.file ?? "");
      if (!file) continue;
      const relative = relativeSpecPath(file, e2eRoot);
      const titlePath = [...titles, String(spec.title ?? "")];
      const id = `${relative}::${titlePath.join(" > ")}`;
      found.set(id, {
        id,
        file: relative,
        titlePath,
        status: worstStatus(found.get(id)?.status, specStatus(spec)),
      });
    }
    for (const child of (suite.suites ?? []) as Unknown[]) walk(child, titles);
  };
  for (const suite of (report.suites ?? []) as Unknown[]) walk(suite, []);
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Read the runner's inventory and report index from a leg's JSON directory. */
export function readLegArtifacts(jsonDir: string): {
  inventory: {
    project: string;
    live: boolean;
    explicitArgs: string[];
    specFiles: string[];
  };
  entries: { specFile: string; reportPath: string }[];
} {
  const inventory = JSON.parse(
    fs.readFileSync(path.join(jsonDir, "inventory.json"), "utf8"),
  ) as Unknown;
  const index = JSON.parse(
    fs.readFileSync(path.join(jsonDir, "reports", "index.json"), "utf8"),
  ) as { entries?: { specFile?: string; reportPath?: string }[] };
  return {
    inventory: {
      project: String(inventory.project ?? ""),
      live: inventory.live === true,
      explicitArgs: ((inventory.explicitArgs ?? []) as unknown[]).map(String),
      specFiles: ((inventory.specFiles ?? []) as unknown[]).map(String),
    },
    entries: (index.entries ?? []).map((entry) => ({
      specFile: String(entry.specFile ?? ""),
      reportPath: String(entry.reportPath ?? ""),
    })),
  };
}

/** Build the comparable aggregate for one leg. */
export function aggregateLeg(input: {
  jsonDir: string;
  e2eRoot?: string;
  revision?: string | null;
  settings?: { digest?: string; project?: string } | null;
  settingsFile?: string | null;
}): Aggregate {
  const e2eRoot = input.e2eRoot ?? path.join(REPO_ROOT, "tests", "e2e");
  const { inventory, entries } = readLegArtifacts(input.jsonDir);

  const byId = new Map<string, AggregatedTest>();
  const specsWithoutReport: string[] = [];
  const withTests = new Set<string>();

  for (const entry of entries) {
    let report: Unknown;
    try {
      const text = fs.readFileSync(entry.reportPath, "utf8");
      if (text.trim().length === 0) throw new Error("empty report");
      report = JSON.parse(text) as Unknown;
    } catch {
      specsWithoutReport.push(entry.specFile);
      continue;
    }
    for (const test of collectSpecs(report, e2eRoot)) {
      withTests.add(test.file);
      byId.set(test.id, {
        ...test,
        status: worstStatus(byId.get(test.id)?.status, test.status),
      });
    }
  }

  const inventorySet = new Set(inventory.specFiles);
  const indexSet = new Set(entries.map((e) => e.specFile));
  const inventoryMismatch =
    inventorySet.size !== indexSet.size || [...inventorySet].some((f) => !indexSet.has(f));

  const tests = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  const count = (status: TestStatus): number =>
    tests.filter((test) => test.status === status).length;

  return {
    schemaVersion: 1,
    project: inventory.project,
    revision: input.revision ?? null,
    live: inventory.live,
    explicitArgs: inventory.explicitArgs,
    specFiles: inventory.specFiles,
    specsWithoutReport,
    specsWithoutTests: inventory.specFiles.filter((file) => !withTests.has(file)),
    inventoryMismatch,
    tests,
    totals: {
      specFiles: inventory.specFiles.length,
      tests: tests.length,
      passed: count("passed"),
      failed: count("failed"),
      flaky: count("flaky"),
      skipped: count("skipped"),
      unknown: count("unknown"),
      specsWithoutReport: specsWithoutReport.length,
      specsWithoutTests: inventory.specFiles.filter((file) => !withTests.has(file)).length,
    },
    settingsFile: input.settingsFile ?? null,
    settingsDigest: input.settings?.digest ?? null,
  };
}

async function main(argv: readonly string[]): Promise<number> {
  const option = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(
      "Usage: bun scripts/aggregate-e2e-reports.ts --dir=<json dir> [--settings=<file>] " +
        "[--revision=<sha>] [--e2e-root=<dir>] [--out=<file>]",
    );
    return 0;
  }
  const dir = option("dir");
  if (!dir) {
    console.error("[aggregate] --dir is required");
    return 1;
  }

  const settingsFile = option("settings") ?? null;
  const settings = settingsFile
    ? (JSON.parse(fs.readFileSync(settingsFile, "utf8")) as { digest?: string; project?: string })
    : null;

  let aggregate: Aggregate;
  try {
    aggregate = aggregateLeg({
      jsonDir: path.resolve(dir),
      e2eRoot: option("e2e-root") ? path.resolve(option("e2e-root") as string) : undefined,
      revision: option("revision") ?? null,
      settings,
      settingsFile: settingsFile ? path.resolve(settingsFile) : null,
    });
  } catch (error) {
    console.error(`[aggregate] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (settings?.project && settings.project !== aggregate.project) {
    console.error(
      `[aggregate] settings are for project "${settings.project}", the leg ran ` +
        `"${aggregate.project}" — refusing to pair them`,
    );
    return 1;
  }

  const out = option("out");
  const text = `${JSON.stringify(aggregate, null, 2)}\n`;
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, text, "utf8");
  } else {
    process.stdout.write(text);
  }

  const t = aggregate.totals;
  console.log(
    `[aggregate] ${aggregate.project}: ${t.specFiles} spec files, ${t.tests} tests — ` +
      `${t.passed} passed, ${t.failed} failed, ${t.flaky} flaky, ${t.skipped} skipped` +
      (t.specsWithoutReport ? `, ${t.specsWithoutReport} without a report` : ""),
  );
  // A leg with no reports at all is not a clean leg; it is an unread leg.
  if (aggregate.inventoryMismatch || aggregate.specsWithoutReport.length > 0) return 1;
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
