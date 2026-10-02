/**
 * Per-test-file sandbox resolution for the Bun preload (`tests/setup.ts`).
 *
 * Why this exists
 * ---------------
 * `bun test` runs every collected file in ONE process with ONE module
 * registry. Before this module, `tests/setup.ts` pointed the whole process at
 * `os.tmpdir()/tbai-test-<pid>`, so all test files shared a single `chat.db`
 * AND a single set of module singletons (`src/db`, the provider `registry`, the
 * `logger`). A file that closed the database, reconfigured the logger, or left
 * a request in flight therefore decided the outcome of every file that ran
 * after it.
 *
 * Bun fixes that itself: `bun test --isolate` gives each file a fresh global
 * object AND a fresh module registry, and re-runs the preload once per file
 * with `process.argv[1]` set to that file. This module turns that per-file
 * hook into a per-file `DATA_DIR`, so each file also gets its own SQLite file.
 *
 * Isolation unit: the test FILE. Sharing within one file is unchanged (a file
 * still sees its own writes across its `it()`s) because the directory is
 * resolved once, before the file's modules load.
 */
import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * Directory-name prefix. Suites assert `DATA_DIR` contains it
 * (`tests/unit/db.test.ts`, `tests/integration/mcp-v2.test.ts`), so it is a
 * contract, not decoration.
 */
const SANDBOX_DIR_PREFIX = "tbai-test";

/**
 * Hex characters of the path digest kept in the directory name. Two distinct
 * test files differing only after this many hex characters of SHA-256 would
 * collide; that is the same bar a content-addressed build cache uses.
 */
const SLUG_LENGTH = 16;

/**
 * Test-file extensions Bun collects. `argv[1]` is only trusted as a test-file
 * identity when it actually looks like one, so a preload invoked outside a test
 * run degrades to the shared per-process sandbox instead of guessing.
 */
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** `<prefix>-<pid>` (shared fallback) or `<prefix>-<pid>-<slug>` (per file). */
const SANDBOX_DIR_PATTERN = new RegExp(`^${SANDBOX_DIR_PREFIX}-(\\d+)(?:-[0-9a-f]+)?$`);

/** Subdirectory of the sandbox that holds the per-conversation workspace. */
const WORKSPACE_SUBDIR = "workspace";

/**
 * Stable, collision-resistant name for one test file.
 *
 * Derived from the absolute path only, so the same file always maps to the same
 * name regardless of run order, worker count, or machine. Returns `null` when
 * the argument is not a plausible test file that exists on disk.
 */
export function testFileSlug(testFilePath: string | undefined): string | null {
  if (!testFilePath) return null;
  const resolved = path.resolve(testFilePath);
  if (!TEST_FILE_PATTERN.test(resolved)) return null;
  if (!fs.existsSync(resolved)) return null;
  return createHash("sha256").update(resolved).digest("hex").slice(0, SLUG_LENGTH);
}

/** The per-RUN sandbox root for a process: `<tmpdir>/tbai-test-<pid>`. */
export function resolveTestRunRoot(pid: number): string {
  return path.join(os.tmpdir(), `${SANDBOX_DIR_PREFIX}-${pid}`);
}

/** A test file's resolved sandbox, and whether isolation actually applied. */
export interface TestSandbox {
  /** Absolute `DATA_DIR` this file's tests must use. */
  dataDir: string;
  /** Absolute `WORKSPACE_DIR`; always inside {@link dataDir}. */
  workspaceDir: string;
  /** Absolute per-run root. Equals `dataDir` only when isolation was refused. */
  runRoot: string;
  /**
   * Whether `dataDir` is this file's OWN sandbox. `false` means every collected
   * file in the run shares one SQLite database and one module registry - the
   * defect this module exists to remove.
   */
  isolated: boolean;
  /** Why isolation was refused; `null` when {@link isolated} is `true`. */
  fallbackReason: string | null;
}

/**
 * Settled identity contract.
 *
 * The single source of a file's identity is `process.argv[1]` as Bun sets it
 * for a preload under `bun test --isolate`. It is ACCEPTED only when it names a
 * path that exists and matches the collected-file extension pattern. Anything
 * else is REFUSED rather than guessed: a wrong guess would hand two files the
 * same directory and silently restore the cross-file contamination.
 *
 * Refusal is safe but not silent. It falls back to the per-run root - the
 * pre-isolation behaviour, which never touches a real install and never
 * crashes the suite - and it reports `isolated: false` plus a reason so the
 * caller can make the degradation visible instead of leaving a green run that
 * quietly lost its isolation.
 */
export function resolveTestSandbox(testFilePath: string | undefined, pid: number): TestSandbox {
  const runRoot = resolveTestRunRoot(pid);
  const slug = testFileSlug(testFilePath);
  if (slug === null) {
    return {
      dataDir: runRoot,
      workspaceDir: path.join(runRoot, WORKSPACE_SUBDIR),
      runRoot,
      isolated: false,
      fallbackReason:
        `argv[1] is not a collected test file (got ${JSON.stringify(testFilePath ?? null)})`,
    };
  }
  const dataDir = path.join(runRoot, slug);
  return {
    dataDir,
    workspaceDir: path.join(dataDir, WORKSPACE_SUBDIR),
    runRoot,
    isolated: true,
    fallbackReason: null,
  };
}

/**
 * Absolute `DATA_DIR` for one test file.
 *
 * Layout: `<tmpdir>/tbai-test-<pid>/<slug>` — a per-RUN root holding one
 * subdirectory per file. The pid keeps two concurrent `bun test` runs (two
 * shells, or a `--parallel` worker pool) from ever addressing the same SQLite
 * file; the slug keeps two files inside one run apart.
 *
 * @see resolveTestSandbox for the full identity contract and the fallback.
 */
export function resolveTestDataDir(testFilePath: string | undefined, pid: number): string {
  return resolveTestSandbox(testFilePath, pid).dataDir;
}

/** Absolute `WORKSPACE_DIR` for a sandbox. Always inside `dataDir`, by design. */
export function resolveTestWorkspaceDir(dataDir: string): string {
  return path.join(dataDir, WORKSPACE_SUBDIR);
}

/** The pid encoded in a sandbox directory name, or `null` if it is not one. */
function sandboxOwnerPid(name: string): number | null {
  const match = SANDBOX_DIR_PATTERN.exec(name);
  if (!match) return null;
  const pid = Number.parseInt(match[1] as string, 10);
  return Number.isSafeInteger(pid) ? pid : null;
}

/**
 * Whether a process is still running. Any error other than "no such process"
 * is treated as ALIVE, so a sandbox is never removed on ambiguous evidence.
 */
function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Delete sandboxes left behind by runs whose process is gone.
 *
 * Cleanup cannot hook the end of a single test file — Bun exposes no per-file
 * teardown to a preload — so it runs at the START of the next run instead of
 * on process exit. A sandbox is removed only when its owning pid is provably
 * dead, which is what keeps this from ever touching another live run's
 * database. Failures are swallowed: leftover temp files must never fail a run.
 */
export function collectStaleSandboxes(tmpRoot: string = os.tmpdir()): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(tmpRoot);
  } catch {
    return;
  }
  for (const name of entries) {
    const ownerPid = sandboxOwnerPid(name);
    if (ownerPid === null || isProcessAlive(ownerPid)) continue;
    try {
      fs.rmSync(path.join(tmpRoot, name), { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}