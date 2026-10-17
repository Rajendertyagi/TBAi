/**
 * SQLite close semantics with statements outstanding — the contract the
 * shutdown spine depends on.
 *
 * Written 2026-10-17 from measurement, not from the comment it replaces. That
 * comment claimed `db.close(true)` "finalizes outstanding .prepare() statements"
 * and "does NOT throw for .query() statements (those are finalized immediately by
 * either mode)". Measured on the installed Bun (1.4.3):
 *
 * - `close(true)` does NOT throw for statements that merely exist. It invalidates
 *   them: a later use throws `Error: Database has closed` (statement handle) or
 *   `RangeError: Cannot use a closed database` (new `db.query()`), and a prepared
 *   INSERT that is run after close throws instead of writing (row count
 *   unchanged on reopen). It is idempotent.
 * - `close(false)` — the default, and NOT what production uses — leaves a
 *   `.prepare()` handle live: its `run()` after close returned
 *   `{changes: 1}` and the row persisted. That is a real write-after-close.
 *
 * So the existing production contract (`db.close(true)` at both close sites) is
 * the safe one and needs no code change; the flag is load-bearing, and the
 * smallest thing that keeps it safe is the source guard below.
 *
 * These tests use their own temporary database files, never the application
 * singleton, so they cannot contaminate any other test file.
 */
import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { REPO_ROOT } from "../../helpers/repo-root";

/** A throwaway database with one table, in its own temp directory. */
function freshDatabase(label: string): { file: string; db: Database } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tbai-sqlite-close-${label}-`));
  const file = path.join(dir, "close-contract.db");
  const db = new Database(file);
  db.exec("CREATE TABLE t (a INTEGER)");
  return { file, db };
}

/** Rows visible to a brand new connection: the only honest observer of a write. */
function rowsOnDisk(file: string): number {
  const reader = new Database(file);
  try {
    return (reader.query("SELECT count(*) AS n FROM t").get() as { n: number }).n;
  } finally {
    reader.close();
  }
}

describe("SQLite close contract with statements outstanding", () => {
  it("close(true) does not throw for cached query handles or an outstanding prepare", () => {
    const { db } = freshDatabase("notthrow");
    db.query("INSERT INTO t VALUES (1)").run();
    const cached = db.query("SELECT count(*) AS n FROM t"); // cached handle, live
    const outstanding = db.prepare("INSERT INTO t VALUES (?)"); // never finalized

    expect(cached.get()).toEqual({ n: 1 });
    expect(() => db.close(true)).not.toThrow();
    expect(outstanding).toBeDefined(); // the handle existed across the close
  });

  it("after close(true) no statement can read or WRITE — every path throws", () => {
    const { db, file } = freshDatabase("nowrite");
    db.query("INSERT INTO t VALUES (1)").run();
    const cached = db.query("SELECT count(*) AS n FROM t");
    const insert = db.prepare("INSERT INTO t VALUES (?)");

    db.close(true);

    // Reads through a stale handle fail loudly rather than returning stale data.
    expect(() => cached.get()).toThrow(/Database has closed/);
    // The write is refused: this is the property the shutdown contract relies on.
    expect(() => insert.run(2)).toThrow(/Database has closed/);
    // And a fresh query on the closed connection is refused too.
    expect(() => db.query("SELECT 1").get()).toThrow(/closed database/);

    expect(rowsOnDisk(file)).toBe(1); // nothing landed after close
  });

  it("close(false) is unsafe: a prepared statement still writes AFTER close", () => {
    // This is the counterfactual that makes the flag load-bearing. If this case
    // ever stops reproducing, the runtime changed and the contract must be
    // re-derived before the source guard below can be trusted.
    const { db, file } = freshDatabase("unsafe");
    db.query("INSERT INTO t VALUES (1)").run();
    const insert = db.prepare("INSERT INTO t VALUES (?)");

    expect(() => db.close()).not.toThrow();
    const result = insert.run(2) as { changes: number };
    expect(result.changes).toBe(1);

    expect(rowsOnDisk(file)).toBe(2); // the write landed after the close
  });

  it("close(true) is idempotent — a second close is a no-op, not an error", () => {
    const { db } = freshDatabase("idempotent");
    db.query("INSERT INTO t VALUES (1)").run();
    expect(() => db.close(true)).not.toThrow();
    expect(() => db.close(true)).not.toThrow();
  });

  it("every production db.close() call passes the throw-on-error flag", () => {
    // The verified contract above only holds for the flag. This guard fails if a
    // close site drops it (or a new one is added without it), because that
    // silently restores the write-after-close behaviour.
    const files = walk("src");
    expect(files.length).toBeGreaterThan(100); // non-vacuity: the walk found the tree

    const offenders: string[] = [];
    let sites = 0;
    for (const absolute of files) {
      const code = fs
        .readFileSync(absolute, "utf8")
        .split("\n")
        // Comment lines would otherwise match the call shape in prose.
        .filter((line) => {
          const t = line.trim();
          return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
        })
        .join("\n");
      const calls = code.match(/db\.close\(/g) ?? [];
      const flagged = code.match(/db\.close\(\s*true\s*\)/g) ?? [];
      if (calls.length !== flagged.length) offenders.push(toRepoId(absolute));
      sites += calls.length;
    }

    expect(offenders).toEqual([]);
    expect(sites).toBeGreaterThan(0); // the guard is not vacuous
  });
});

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

function toRepoId(absolute: string): string {
  return path.relative(REPO_ROOT, absolute).split(path.sep).join("/");
}
