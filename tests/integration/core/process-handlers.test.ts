/**
 * Process-level error handlers (V2): unhandledRejection and uncaughtException.
 *
 * The handlers in index.ts must catch process-integrity failures, log a
 * structured `lifecycle.*` line, and exit non-zero. Bun 1.4.3 does NOT crash
 * by default when a handler is installed (R1-R4 verified), so the handler
 * must explicitly exit(1).
 *
 * These tests run in isolated child processes because they terminate their
 * own process. The parent asserts the exit code and the log line.
 */
import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO_ROOT } from "../../helpers/repo-root";

describe("process-level error handlers", () => {
  it("unhandledRejection → lifecycle.unhandled_rejection, exit 1", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-unhandled-rejection-"));
    const marker = path.join(dir, "marker");
    const child = Bun.spawn(
      ["bun", path.join(REPO_ROOT, "tests/fixtures/unhandled-rejection-child.ts")],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          TBAI_LIFECYCLE_MARKER: marker,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code).toBe(1);
    expect(stderr).toContain("unhandled_rejection");
    expect(stderr).toContain("test-unhandled-rejection");
    fs.rmSync(dir, { recursive: true, force: true });
  }, 15000);

  it("uncaughtException → lifecycle.uncaught_exception, exit 1", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-uncaught-exception-"));
    const marker = path.join(dir, "marker");
    const child = Bun.spawn(
      ["bun", path.join(REPO_ROOT, "tests/fixtures/uncaught-exception-child.ts")],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          TBAI_LIFECYCLE_MARKER: marker,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code).toBe(1);
    expect(stderr).toContain("uncaught_exception");
    expect(stderr).toContain("test-uncaught-exception");
    fs.rmSync(dir, { recursive: true, force: true });
  }, 15000);

  it("contained error → handler does NOT fire, exit 0", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-contained-error-"));
    const child = Bun.spawn(
      ["bun", path.join(REPO_ROOT, "tests/fixtures/contained-error-child.ts")],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code).toBe(0);
    expect(stderr).not.toContain("unhandled_rejection");
    expect(stderr).toContain("CONTAINED_ERROR_DONE");
    fs.rmSync(dir, { recursive: true, force: true });
  }, 15000);

  it("handler that does NOT exit → process continues", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-no-exit-handler-"));
    const child = Bun.spawn(
      ["bun", path.join(REPO_ROOT, "tests/fixtures/no-exit-handler-child.ts")],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    // Wait a bit — if the handler doesn't exit, the process stays alive
    await Bun.sleep(2000);
    // The process should still be running (not exited)
    expect(child.exitCode).toBeNull();
    // Kill it to clean up
    child.kill();
    const code = await child.exited;
    // The process was killed, so exit code is non-zero (signal)
    // The key assertion is that it did NOT exit on its own with code 0
    expect(code).not.toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 15000);
});

/**
 * The agent that wrote these tests found the fixtures carrying a *copy* of the
 * handlers, annotated "Install the same handler as index.ts". A copy passes the
 * same assertions as the real thing, so the suite could stay green while
 * production regressed. These two guards close that hole: one implementation,
 * and the fixtures under test must call it.
 *
 * Both read source as an invariant (identifiers and normalized `process.on`
 * registrations), never as layout — a formatter re-wrap must not break them.
 */
describe("process handlers have exactly one implementation", () => {
  const SOURCE_ROOTS = ["src", "web/src", "tests/fixtures"];

  function walk(relativeRoot: string): string[] {
    const absoluteRoot = path.join(REPO_ROOT, relativeRoot);
    const found: string[] = [];
    const visit = (dir: string): void => {
      for (const entry of fs.readdirSync(dir)) {
        if (entry === "node_modules" || entry === ".artifacts" || entry === "dist") continue;
        const child = path.join(dir, entry);
        if (fs.statSync(child).isDirectory()) {
          visit(child);
          continue;
        }
        if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".d.ts")) found.push(child);
      }
    };
    if (fs.statSync(absoluteRoot, { throwIfNoEntry: false })?.isDirectory()) visit(absoluteRoot);
    return found;
  }

  const toRepoId = (absolute: string): string =>
    path.relative(REPO_ROOT, absolute).split(path.sep).join("/");

  /** Whitespace-insensitive: the formatter may re-wrap the call expression. */
  const hasRegistration = (text: string, event: string): boolean =>
    text.replace(/\s+/g, "").includes(`process.on("${event}"`);

  it("only the owning module registers process-level error handlers", () => {
    const scanned = SOURCE_ROOTS.flatMap((root) => walk(root));
    // Non-vacuity: if the walk broke, the allowlist assertion below would pass
    // having scanned nothing.
    expect(scanned.length).toBeGreaterThan(100);

    const registrars = scanned.filter((absolute) => {
      const text = fs.readFileSync(absolute, "utf8");
      return (
        hasRegistration(text, "unhandledRejection") || hasRegistration(text, "uncaughtException")
      );
    });

    expect(registrars.map(toRepoId).sort()).toEqual([
      // The single production implementation.
      "src/services/process-handlers.ts",
      // The deliberate counterfactual: a logging-only handler that must NOT
      // exit, to prove why the production handler has to (see its header).
      "tests/fixtures/no-exit-handler-child.ts",
    ]);
  });

  it("the entry point and the handler fixtures call the production installer", () => {
    const mustInstall = [
      "src/index.ts",
      "tests/fixtures/unhandled-rejection-child.ts",
      "tests/fixtures/uncaught-exception-child.ts",
      "tests/fixtures/contained-error-child.ts",
    ];
    for (const id of mustInstall) {
      const text = fs.readFileSync(path.join(REPO_ROOT, id), "utf8");
      expect(text).toContain("installProcessErrorHandlers");
      // ...and not a local registration of their own.
      expect(hasRegistration(text, "unhandledRejection")).toBe(false);
      expect(hasRegistration(text, "uncaughtException")).toBe(false);
    }
  });
});
