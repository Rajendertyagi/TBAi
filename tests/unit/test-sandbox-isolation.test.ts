/**
 * Regression coverage for the per-test-file test sandbox.
 *
 * The bug this locks: `tests/setup.ts` used to point a whole `bun test` PROCESS
 * at one temp dir, so all collected files shared one `chat.db` and one module
 * registry. A file that closed the db, reconfigured the logger, or left a
 * request in flight decided the result of every later file.
 *
 * These cases assert observable behaviour only - resolved paths and real
 * `bun:sqlite` reads/writes. Removing the per-file directory, or dropping
 * `--isolate` from the `test` script, makes them fail (proved by the
 * negative control in "the probe files are sensitive to --isolate").
 */
import { describe, expect, it, afterAll, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "fs";
import os from "os";
import path from "path";

import {
  collectStaleSandboxes,
  resolveTestDataDir,
  resolveTestRunRoot,
  resolveTestSandbox,
  resolveTestWorkspaceDir,
  testFileSlug,
} from "../test-sandbox";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const SETUP_PRELOAD = path.join(REPO_ROOT, "tests", "setup.ts");

/**
 * A pid above the platform maximum, so a case that actually creates a sandbox
 * can never land inside a live process's sandbox. Cases that only compare paths
 * use {@link ARBITRARY_PID} and create nothing.
 */
const UNUSED_PID = 2_147_483_647;
const ARBITRARY_PID = 4242;

/** Temp dirs holding the synthetic test files; removed after the suite. */
const probeDirs: string[] = [];

/** A file that exists and looks like a collected test file. */
function fakeTestFile(relative: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-sandbox-probe-"));
  probeDirs.push(dir);
  const file = path.join(dir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "// probe\n");
  return file;
}

afterAll(() => {
  for (const dir of probeDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // Reclaim the sandboxes these cases created (UNUSED_PID is provably dead).
  collectStaleSandboxes();
});

describe("per-file sandbox resolution", () => {
  it("gives two different test files two different DATA_DIRs", () => {
    const alpha = resolveTestDataDir(fakeTestFile("alpha.test.ts"), ARBITRARY_PID);
    const beta = resolveTestDataDir(fakeTestFile("beta.test.ts"), ARBITRARY_PID);
    expect(alpha).not.toBe(beta);
  });

  it("gives the SAME test file the same DATA_DIR on every call", () => {
    // This is what preserves deliberate sharing within one file: the sandbox is
    // resolved once before the file's modules load, so its own it()s share
    // rows exactly as they did under the single per-process directory.
    const file = fakeTestFile("repeat.test.ts");
    expect(resolveTestDataDir(file, ARBITRARY_PID)).toBe(resolveTestDataDir(file, ARBITRARY_PID));
  });

  it("is independent of the order the files are resolved in", () => {
    const files = ["one.test.ts", "two.test.ts", "three.test.ts"].map(fakeTestFile);
    const forward = files.map((f) => resolveTestDataDir(f, ARBITRARY_PID));
    const reversed = [...files].reverse().map((f) => resolveTestDataDir(f, ARBITRARY_PID));
    expect(new Set(reversed)).toEqual(new Set(forward));
  });

  it("keeps concurrent resolution collision-free", () => {
    const files = Array.from({ length: 64 }, (_, i) => fakeTestFile(`bulk-${i}.test.ts`));
    const dirs = files.map((f) => resolveTestDataDir(f, ARBITRARY_PID));
    expect(new Set(dirs).size).toBe(dirs.length);
  });

  it("keys the sandbox by pid so two concurrent runs cannot collide", () => {
    const file = fakeTestFile("shared-name.test.ts");
    expect(resolveTestDataDir(file, 111)).not.toBe(resolveTestDataDir(file, 222));
  });

  it("places every sandbox under the OS temp dir, outside the repository", () => {
    const tmpRoot = path.resolve(os.tmpdir());
    const dir = resolveTestDataDir(fakeTestFile("safe.test.ts"), ARBITRARY_PID);
    expect(path.resolve(dir).startsWith(tmpRoot)).toBe(true);
    expect(path.resolve(dir).startsWith(REPO_ROOT + path.sep)).toBe(false);
    // Suites assert on this substring to prove they are not on a real install.
    expect(dir).toContain("tbai-test");
  });

  it("keeps WORKSPACE_DIR inside DATA_DIR", () => {
    const dataDir = resolveTestDataDir(fakeTestFile("workspace.test.ts"), ARBITRARY_PID);
    expect(resolveTestWorkspaceDir(dataDir).startsWith(dataDir + path.sep)).toBe(true);
  });

  it("falls back to the shared per-run root when the file identity is unusable", () => {
    const shared = path.join(os.tmpdir(), `tbai-test-${ARBITRARY_PID}`);
    expect(resolveTestDataDir(undefined, ARBITRARY_PID)).toBe(shared);
    expect(resolveTestDataDir("not-a-test-file.ts", ARBITRARY_PID)).toBe(shared);
    expect(resolveTestDataDir(path.join(os.tmpdir(), "absent.test.ts"), ARBITRARY_PID)).toBe(shared);
    expect(testFileSlug(undefined)).toBeNull();
  });

  it("REPORTS the fallback instead of degrading silently", () => {
    // A green run that quietly lost its isolation is the failure mode this
    // guards. The preload turns `isolated: false` into a loud stderr line, and
    // that is only defensible while the reason is actually reported.
    for (const bad of [undefined, "not-a-test-file.ts", path.join(os.tmpdir(), "absent.test.ts")]) {
      const sandbox = resolveTestSandbox(bad, ARBITRARY_PID);
      expect(sandbox.isolated).toBe(false);
      expect(sandbox.fallbackReason).toContain("argv[1]");
      expect(sandbox.dataDir).toBe(sandbox.runRoot);
    }
  });

  it("REPORTS isolation applied, with no fallback reason", () => {
    const file = fakeTestFile("reported.test.ts");
    const sandbox = resolveTestSandbox(file, ARBITRARY_PID);
    expect(sandbox.isolated).toBe(true);
    expect(sandbox.fallbackReason).toBeNull();
    expect(sandbox.runRoot).toBe(path.join(os.tmpdir(), `tbai-test-${ARBITRARY_PID}`));
    // dataDir is exactly this file's own directory, named by this file's slug.
    expect(path.dirname(sandbox.dataDir)).toBe(sandbox.runRoot);
    expect(path.basename(sandbox.dataDir)).toBe(testFileSlug(file));
  });
});

describe("per-file sandbox database separation", () => {
  /** Create a schema and a marker row in a fresh sandbox database. */
  function seed(dataDir: string, marker: string): void {
    fs.mkdirSync(dataDir, { recursive: true });
    const handle = new Database(path.join(dataDir, "chat.db"));
    handle.run("CREATE TABLE IF NOT EXISTS probe (marker TEXT PRIMARY KEY)");
    handle.run("INSERT OR REPLACE INTO probe (marker) VALUES (?)", [marker]);
    handle.close();
  }

  /** Markers visible in a sandbox database (empty when it has no schema). */
  function markers(dataDir: string): string[] {
    const file = path.join(dataDir, "chat.db");
    if (!fs.existsSync(file)) return [];
    const handle = new Database(file, { readonly: true });
    try {
      const rows = handle.query<{ marker: string }, []>("SELECT marker FROM probe").all();
      return rows.map((r) => r.marker);
    } catch {
      return [];
    } finally {
      handle.close();
    }
  }

  it("does not expose one test file's writes to another", () => {
    const alpha = resolveTestDataDir(fakeTestFile("db-alpha.test.ts"), UNUSED_PID);
    const beta = resolveTestDataDir(fakeTestFile("db-beta.test.ts"), UNUSED_PID);
    seed(alpha, "written-by-alpha");
    expect(markers(beta)).toEqual([]);
    expect(markers(alpha)).toEqual(["written-by-alpha"]);
  });

  it("still shares writes between two connections in the SAME file sandbox", () => {
    const shared = resolveTestDataDir(fakeTestFile("db-shared.test.ts"), UNUSED_PID);
    seed(shared, "written-by-alpha");
    // A second connection to the same sandbox - what a later it() in the same
    // file sees. Must still observe the earlier write.
    expect(markers(shared)).toEqual(["written-by-alpha"]);
  });
});

describe("stale sandbox reclamation", () => {
  /** An isolated fake temp root, so the sweep never sees real sandboxes. */
  function fakeTmpRoot(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-sweep-probe-"));
    probeDirs.push(dir);
    return dir;
  }

  function seed(root: string, name: string): void {
    fs.mkdirSync(path.join(root, name, "workspace"), { recursive: true });
    fs.writeFileSync(path.join(root, name, "chat.db"), "database");
  }

  it("reclaims a sandbox whose owning process is gone", () => {
    const root = fakeTmpRoot();
    seed(root, `tbai-test-${UNUSED_PID}`);
    collectStaleSandboxes(root);
    expect(fs.existsSync(path.join(root, `tbai-test-${UNUSED_PID}`))).toBe(false);
  });

  it("never touches a sandbox owned by a running process", () => {
    const root = fakeTmpRoot();
    // The sweep must never be able to delete a concurrent run's database.
    const live = `tbai-test-${process.pid}`;
    seed(root, live);
    collectStaleSandboxes(root);
    expect(fs.existsSync(path.join(root, live, "chat.db"))).toBe(true);
  });

  it("leaves unrelated directories in the temp root alone", () => {
    const root = fakeTmpRoot();
    for (const name of ["tbai-not-a-sandbox", "tbai-test-no-pid-here", "other-app"]) {
      seed(root, name);
    }
    collectStaleSandboxes(root);
    for (const name of ["tbai-not-a-sandbox", "tbai-test-no-pid-here", "other-app"]) {
      expect(fs.existsSync(path.join(root, name, "chat.db"))).toBe(true);
    }
  });
});

describe("the real bun test harness isolates files end to end", () => {
  const harnessRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-harness-probe-"));
  const report = path.join(harnessRoot, "data-dirs.json");

  /**
   * A collected test file that records its own sandbox and proves its sandbox
   * holds exactly the row it seeded - never a sibling file's.
   */
  function probeSource(ownMarker: string): string {
    return `
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "fs";
import path from "path";

const OWN = ${JSON.stringify(ownMarker)};

test("records its sandbox", () => {
  const report = ${JSON.stringify(report)};
  const seen = fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, "utf8")) : {};
  seen[OWN] = { dataDir: process.env.DATA_DIR, pid: process.pid, argv1: process.argv[1] };
  fs.writeFileSync(report, JSON.stringify(seen));
});

test("sees only its own row", () => {
  const file = path.join(process.env.DATA_DIR, "chat.db");
  expect(fs.existsSync(file)).toBe(true);
  const handle = new Database(file, { readonly: true });
  const rows = handle
    .query("SELECT marker FROM probe ORDER BY marker")
    .all()
    .map((r) => r.marker);
  handle.close();
  expect(rows).toEqual([OWN]);
});
`;
  }

  /** Seed the sandbox row the probe asserts on. Runs inside the child file. */
  function seedSource(marker: string): string {
    return `
import { Database } from "bun:sqlite";
import path from "path";
const handle = new Database(path.join(process.env.DATA_DIR, "chat.db"));
handle.run("CREATE TABLE IF NOT EXISTS probe (marker TEXT PRIMARY KEY)");
handle.run("INSERT OR REPLACE INTO probe (marker) VALUES (?)", [${JSON.stringify(marker)}]);
handle.close();
`;
  }

  /** What one probe file reports about the sandbox it was given. */
  interface ProbeReport {
    dataDir: string;
    pid: number;
    argv1: string;
  }

  /** Absolute path of a probe file, the identity the harness should have used. */
  function probeFile(name: string): string {
    return path.join(harnessRoot, `${name}.test.ts`);
  }

  /**
   * Run `bun test` over the probe files and return what each one reported.
   * `--isolate` is opt-in so the case can also prove the probe is sensitive to
   * the flag rather than passing for an unrelated reason.
   */
  function runHarness(isolate: boolean): { code: number; reports: Map<string, ProbeReport> } {
    fs.rmSync(report, { force: true });
    const flags = isolate ? ["--isolate"] : [];
    const proc = Bun.spawnSync({
      cmd: ["bun", "test", ...flags, "--timeout=20000"],
      cwd: harnessRoot,
      env: { ...process.env },
    });
    const seen: Record<string, ProbeReport> = fs.existsSync(report)
      ? (JSON.parse(fs.readFileSync(report, "utf8")) as Record<string, ProbeReport>)
      : {};
    return { code: proc.exitCode, reports: new Map(Object.entries(seen)) };
  }

  beforeAll(() => {
    fs.writeFileSync(
      path.join(harnessRoot, "bunfig.toml"),
      `[test]\npreload = [${JSON.stringify(SETUP_PRELOAD)}]\n`,
      "ascii",
    );
    for (const own of ["probe-alpha", "probe-beta"]) {
      fs.writeFileSync(probeFile(own), `${seedSource(own)}\n${probeSource(own)}`, "ascii");
    }
  });

  afterAll(() => {
    fs.rmSync(harnessRoot, { recursive: true, force: true });
    // Reclaim the sandbox roots the child processes left behind.
    collectStaleSandboxes();
  });

  it(
    "runs each file in its own sandbox with --isolate",
    () => {
      const { code, reports } = runHarness(true);
      expect(code).toBe(0);
      expect(reports.size).toBe(2);
      const dataDirs = [...reports.values()].map((r) => r.dataDir);
      expect(new Set(dataDirs).size).toBe(2);
      for (const dir of dataDirs) expect(dir).toContain("tbai-test");
    },
    120000,
  );

  it(
    "gives each file EXACTLY the sandbox its own path resolves to",
    () => {
      // Pins the identity contract itself, not just "the two differ". Each probe
      // file's DATA_DIR must equal resolveTestDataDir(<that file's absolute
      // path>, <that file's own pid>). If Bun ever stopped pointing argv[1] at
      // the collected file, this fails with the exact mismatch instead of the
      // suite quietly reverting to one shared database.
      const { code, reports } = runHarness(true);
      expect(code).toBe(0);
      for (const [name, observed] of reports) {
        expect(observed.argv1).toBe(probeFile(name));
        expect(observed.dataDir).toBe(resolveTestDataDir(probeFile(name), observed.pid));
        // Not the shared run root, which is what a refused identity returns.
        expect(observed.dataDir).not.toBe(resolveTestRunRoot(observed.pid));
      }
    },
    120000,
  );

  it(
    "the probe files ARE sensitive to --isolate (negative control)",
    () => {
      // Without the flag both files land in ONE sandbox, so the peer-row
      // assertion cannot hold. This is what makes the cases above meaningful:
      // they prove the isolation, rather than passing by accident.
      const { code, reports } = runHarness(false);
      expect(code).not.toBe(0);
      const dataDirs = [...reports.values()].map((r) => r.dataDir);
      expect(new Set(dataDirs).size).toBe(1);
    },
    120000,
  );
});