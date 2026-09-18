/**
 * Shutdown spine: startServer + shutdownServer over the real process.
 *
 * DB isolation: tests/setup.ts (bunfig preload) redirects DATA_DIR to tmp.
 *
 * CRITICAL ORDERING CONSTRAINT:
 * Bun test runs all files in ONE process, in alphabetical path order.
 * This file closes the shared db singleton, which poisons every subsequent
 * test file that touches the DB. It is excluded from `bun test` via
 * package.json's --path-ignore-patterns and only runs through `bun run
 * test:shutdown`. If it is ever added to the default suite, any test file
 * that sorts AFTER it and needs the DB will see "Cannot use a closed
 * database".
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { startServer, shutdownServer } from "../../src/server";
import { db } from "../../src/db";
import { logger } from "../../src/lib/logger";

// Logger level is global singleton state shared across test files.
beforeEach(() => {
  logger.configure({ level: "debug", targets: [], file: null, fileEnabled: false });
});

afterEach(() => {
  logger.configure({ level: "error", targets: [], file: null, fileEnabled: false });
});

describe("shutdown lifecycle", () => {
  it("serves a real request, then shuts down cleanly and closes the DB", async () => {
    const server = await startServer(0);
    expect(server.port).toBeGreaterThan(0);

    // One real HTTP request to prove the server is live.
    const res = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");

    // Graceful shutdown: resolves without throwing.
    await shutdownServer(server, "test");

    // The shared db singleton is now closed: a query must throw.
    let threw = false;
    try {
      db.query("SELECT 1").get();
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  }, 30000);
});
