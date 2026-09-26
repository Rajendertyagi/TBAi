/**
 * Fail-safe for the destructive orphan chat-directory sweep.
 *
 * Background: `gcOrphanChatDirs()` decides whether a directory is still bound
 * to a chat purely from the `folders` table. On a database with no conversation
 * rows, every directory is unbound *by definition*, so the sweep would authorise
 * deleting the whole workspace tree — and it does so with a hard `rmSync` that
 * has no trash. That is not hypothetical: a real boot probe pointed at a
 * scratch `DATA_DIR` while leaving `WORKSPACE_DIR` on the live workspace, and
 * the sweep hard-deleted 11 real per-conversation directories. This suite locks
 * the guard that now prevents it.
 *
 * Isolation: `tests/setup.ts` (bunfig preload) redirects BOTH `DATA_DIR` and
 * `WORKSPACE_DIR` to a per-process temp root, so this file never touches real
 * user data. `assertIsolatedRoot` below fails loudly if that ever stops being
 * true, rather than silently deleting something.
 *
 * Two guards are locked here, in the order the sweep applies them:
 *   1. `evaluateOrphanSweepSafety` — a relocated `DATA_DIR` paired with an
 *      unstated `WORKSPACE_DIR`. The database cannot vouch for a workspace it
 *      was never told about. This one fired again after the empty-database guard
 *      was already in place, because a scratch database seeded with conversations
 *      looks exactly like a healthy one.
 *   2. `hasEstablishedConversations` — an empty database.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "fs";
import path from "path";
import { evaluateOrphanSweepSafety, gcOrphanChatDirs } from "../../src/services/workspace";
import { conversationService } from "../../src/services/storage";
import { getWorkspaceDir } from "../../src/services/tools";
import { db } from "../../src/db";
import { logger } from "../../src/lib/logger";

const CHATS_ROOT = path.join(getWorkspaceDir(), "chats");
const LEGACY_ROOT = path.join(process.env.DATA_DIR!, "chat");
const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");

/** Refuse to run destructive-GC tests against a non-temporary root. */
function assertIsolatedRoot(label: string): void {
  for (const root of [CHATS_ROOT, LEGACY_ROOT]) {
    const resolved = path.resolve(root);
    expect(resolved.startsWith(os_tmpdir())).toBe(true);
    expect(resolved.startsWith(REPO_ROOT + path.sep)).toBe(false);
  }
  // Keeps the label referenced so a failure names the suite that misbehaved.
  expect(label.length).toBeGreaterThan(0);
}

function os_tmpdir(): string {
  return path.resolve(require("os").tmpdir());
}

function clearAll(): void {
  db.run("DELETE FROM folders");
  db.run("DELETE FROM conversations");
}

const created: string[] = [];

/** A directory that is old enough for the sweep to consider reclaiming. */
function staleDir(name: string): string {
  const dir = path.join(CHATS_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "note.txt"), "scratch\n");
  const past = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(dir, past, past);
  created.push(dir);
  return dir;
}

const conversationCount = (): number =>
  db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM conversations").get()!.c;

/**
 * Every test runs inside a transaction that is rolled back afterwards, so the
 * rows this suite deletes and creates are restored exactly — no column-by-column
 * snapshot to drift out of sync with the schema, and no interference with
 * sibling suites that share the per-process database.
 */
beforeEach(() => {
  assertIsolatedRoot("gc-guard");
  db.run("BEGIN");
  clearAll();
});

afterEach(() => {
  try {
    db.run("ROLLBACK");
  } catch {
    /* already rolled back by a failing statement */
  }
  while (created.length > 0) {
    const dir = created.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort on Windows */
    }
  }
});

describe("gcOrphanChatDirs — empty-database guard", () => {
  it("deletes nothing when the conversation table is empty", () => {
    const a = staleDir("empty_db_a");
    const b = staleDir("empty_db_b");
    expect(conversationCount()).toBe(0);

    const removed = gcOrphanChatDirs();

    expect(removed).toBe(0);
    expect(fs.existsSync(a)).toBe(true);
    expect(fs.existsSync(b)).toBe(true);
  });

  it("reproduces the destructive boot-probe scenario: fresh DB + populated workspace", () => {
    // The exact shape that caused the incident: a brand-new database, a
    // workspace full of chat directories, no conversations anywhere.
    const dirs = [
      staleDir("probe_like_1"),
      staleDir("probe_like_2"),
      staleDir("probe_like_3"),
      staleDir("probe_like_4"),
    ];
    // No folder rows either — every directory is unbound by definition.
    expect(conversationCount()).toBe(0);

    const removed = gcOrphanChatDirs();

    expect(removed).toBe(0);
    for (const dir of dirs) {
      expect(fs.existsSync(dir)).toBe(true);
      expect(fs.existsSync(path.join(dir, "note.txt"))).toBe(true);
    }
  });

  it("leaves every orphan untouched, not just the first", () => {
    const dirs = Array.from({ length: 6 }, (_, i) => staleDir(`many_${i}`));

    expect(gcOrphanChatDirs()).toBe(0);

    for (const dir of dirs) expect(fs.existsSync(dir)).toBe(true);
  });

  it("leaves a populated legacy root untouched too", () => {
    const legacy = path.join(LEGACY_ROOT, `legacy_empty_${Date.now()}`);
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "old.txt"), "old\n");
    const past = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(legacy, past, past);
    created.push(legacy);

    expect(gcOrphanChatDirs()).toBe(0);
    expect(fs.existsSync(legacy)).toBe(true);
  });

  it("emits a structured skip diagnostic and deletes nothing", () => {
    const dir = staleDir("logged_skip");
    const since = logger.lastSeq;
    logger.configure({ level: "debug", targets: [], file: null, fileEnabled: false });

    try {
      gcOrphanChatDirs();
    } finally {
      logger.configure({ level: "error", targets: [], file: null, fileEnabled: false });
    }

    const captured = logger.getRecentEntries(since);
    const skip = captured.find((e) => e.event === "gc_skipped");
    expect(skip).toBeDefined();
    expect(skip!.scope).toBe("workspace");
    expect(skip!.level).toBe("warn");
    // LogEntry extends LogFields, so structured fields are flattened.
    expect(skip!.reason).toBe("no_established_conversations");
    expect(skip!.conversationCount).toBe(0);
    expect(Array.isArray(skip!.roots)).toBe(true);
    // No user content: only the two known roots, never a file or dir name.
    expect(JSON.stringify(skip)).not.toContain("note.txt");
    expect(JSON.stringify(skip)).not.toContain("logged_skip");
    // And the destructive events never fired.
    expect(captured.find((e) => e.event === "gc_completed")).toBeUndefined();
    expect(captured.find((e) => e.event === "gc_remove_failed")).toBeUndefined();
    expect(fs.existsSync(dir)).toBe(true);
  });
});

describe("gcOrphanChatDirs — relocated-data-directory guard", () => {
  it("classifies every launch shape correctly (pure truth table)", () => {
    const DATA = "C:\\app\\data";
    const DEFAULT = "C:\\app\\data";

    // Normal install: neither path was chosen by the operator.
    expect(evaluateOrphanSweepSafety(DATA, DEFAULT, false)).toEqual({
      skip: false,
      reason: null,
      dataDirRelocated: false,
      workspaceDirExplicit: false,
    });

    // Deliberate co-located install: the operator said where both live.
    expect(evaluateOrphanSweepSafety("D:\\elsewhere\\data", DEFAULT, true)).toEqual({
      skip: false,
      reason: null,
      dataDirRelocated: true,
      workspaceDirExplicit: true,
    });

    // The destructive shape: foreign database, live workspace, one unstated.
    expect(evaluateOrphanSweepSafety("D:\\scratch\\data", DEFAULT, false)).toEqual({
      skip: true,
      reason: "relocated_data_dir",
      dataDirRelocated: true,
      workspaceDirExplicit: false,
    });
  });

  it("treats an equivalent spelling of the default directory as NOT relocated", () => {
    const defaultDir = path.join(process.cwd(), "data");
    // A redundant `..` segment resolves to the same directory on every platform,
    // and must not manufacture a relocation that would silently disable the sweep.
    const roundabout = path.join(defaultDir, "..", "data");
    expect(evaluateOrphanSweepSafety(roundabout, defaultDir, false).dataDirRelocated).toBe(false);

    if (process.platform === "win32") {
      // Windows paths are case-insensitive, so case drift is not a relocation.
      expect(
        evaluateOrphanSweepSafety(defaultDir.toUpperCase(), defaultDir, false).dataDirRelocated,
      ).toBe(false);
    }
  });

  it("reproduces the second incident: scratch DATA_DIR + unstated workspace", async () => {
    // This file's own DATA_DIR is a per-process temp root (assertIsolatedRoot),
    // i.e. already relocated from the repo default. Deleting WORKSPACE_DIR from
    // the environment is exactly the operator mistake that caused a real
    // directory to disappear: the sweep is left pairing a foreign database with
    // a workspace it was never told about.
    const conv = await conversationService.create({
      title: "relocated",
      providerId: null,
      modelId: null,
      reasoningLevel: null,
      systemPrompt: null,
      workspaceMode: "simple",
      workspaceFolderId: null,
    });
    // Old and unbound, so the pre-existing guard would have deleted it.
    const orphan = staleDir(`relocated_orphan_${conv.id}`);
    expect(conversationCount()).toBe(1);

    const previous = process.env.WORKSPACE_DIR;
    const since = logger.lastSeq;
    logger.configure({ level: "debug", targets: [], file: null, fileEnabled: false });
    let removed: number;
    try {
      delete process.env.WORKSPACE_DIR;
      removed = gcOrphanChatDirs();
    } finally {
      if (previous !== undefined) process.env.WORKSPACE_DIR = previous;
      logger.configure({ level: "error", targets: [], file: null, fileEnabled: false });
    }

    // An established database, a stale unbound directory, and still: nothing.
    expect(removed).toBe(0);
    expect(fs.existsSync(orphan)).toBe(true);

    const captured = logger.getRecentEntries(since);
    const skip = captured.find((e) => e.event === "gc_skipped");
    expect(skip).toBeDefined();
    expect(skip!.reason).toBe("relocated_data_dir");
    expect(skip!.dataDirRelocated).toBe(true);
    expect(skip!.workspaceDirExplicit).toBe(false);
    // No user content: paths and flags only, never a file or dir name.
    expect(JSON.stringify(skip)).not.toContain("note.txt");
    expect(JSON.stringify(skip)).not.toContain("relocated_orphan");
    // And the destructive events never fired.
    expect(captured.find((e) => e.event === "gc_completed")).toBeUndefined();
    expect(captured.find((e) => e.event === "gc_remove_failed")).toBeUndefined();
  });

  it("still sweeps when the operator states both locations", async () => {
    // The guard must not degrade a deliberate co-located install: with
    // WORKSPACE_DIR set, a genuinely orphaned directory is still reclaimed.
    const conv = await conversationService.create({
      title: "colocated",
      providerId: null,
      modelId: null,
      reasoningLevel: null,
      systemPrompt: null,
      workspaceMode: "simple",
      workspaceFolderId: null,
    });
    const orphan = staleDir(`colocated_orphan_${conv.id}`);

    expect(process.env.WORKSPACE_DIR).toBeString();
    expect(gcOrphanChatDirs()).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(orphan)).toBe(false);
  });
});

describe("gcOrphanChatDirs — established database keeps existing behaviour", () => {
  it("still deletes a genuinely orphaned directory", async () => {
    const conv = await conversationService.create({
      title: "established",
      providerId: null,
      modelId: null,
      reasoningLevel: null,
      systemPrompt: null,
      workspaceMode: "simple",
      workspaceFolderId: null,
    });
    const orphan = staleDir(`orphan_${conv.id}`);
    expect(conversationCount()).toBe(1);

    const removed = gcOrphanChatDirs();

    expect(removed).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(orphan)).toBe(false);
  });

  it("keeps a bound conversation directory", async () => {
    const { resolveConversationWorkspace } = await import("../../src/services/workspace");
    const conv = await conversationService.create({
      title: "bound",
      providerId: null,
      modelId: null,
      reasoningLevel: null,
      systemPrompt: null,
      workspaceMode: "simple",
      workspaceFolderId: null,
    });
    const ws = await resolveConversationWorkspace(conv.id);
    const past = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(ws.dir, past, past);
    created.push(ws.dir);

    gcOrphanChatDirs();

    expect(fs.existsSync(ws.dir)).toBe(true);
  });

  it("deletes the orphan but spares the bound directory in the same pass", async () => {
    const { resolveConversationWorkspace } = await import("../../src/services/workspace");
    const conv = await conversationService.create({
      title: "mixed",
      providerId: null,
      modelId: null,
      reasoningLevel: null,
      systemPrompt: null,
      workspaceMode: "simple",
      workspaceFolderId: null,
    });
    const bound = await resolveConversationWorkspace(conv.id);
    const past = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(bound.dir, past, past);
    created.push(bound.dir);
    const orphan = staleDir(`mixed_orphan_${conv.id}`);

    gcOrphanChatDirs();

    expect(fs.existsSync(bound.dir)).toBe(true);
    expect(fs.existsSync(orphan)).toBe(false);
  });

  it("counts an archived conversation as established state", async () => {
    const conv = await conversationService.create({
      title: "archived",
      providerId: null,
      modelId: null,
      reasoningLevel: null,
      systemPrompt: null,
      workspaceMode: "simple",
      workspaceFolderId: null,
    });
    await conversationService.update(conv.id, { status: "archived" });
    const orphan = staleDir(`archived_orphan_${conv.id}`);
    expect(conversationCount()).toBe(1);

    gcOrphanChatDirs();

    // Archived chats are still real chats: the sweep keeps working.
    expect(fs.existsSync(orphan)).toBe(false);
  });

  it("retains directories when every conversation was deleted (deliberate fail-safe)", async () => {
    const conv = await conversationService.create({
      title: "doomed",
      providerId: null,
      modelId: null,
      reasoningLevel: null,
      systemPrompt: null,
      workspaceMode: "simple",
      workspaceFolderId: null,
    });
    const { resolveConversationWorkspace } = await import("../../src/services/workspace");
    const bound = await resolveConversationWorkspace(conv.id);
    created.push(bound.dir);
    const orphan = staleDir(`doomed_orphan_${conv.id}`);

    // Conversations are hard-deleted, so an emptied table is indistinguishable
    // from a fresh database. The guard therefore retains both directories.
    // This leaks scratch space on purpose: leaking is recoverable, deleting a
    // user's workspace is not.
    await conversationService.delete(conv.id);
    expect(conversationCount()).toBe(0);

    expect(gcOrphanChatDirs()).toBe(0);
    expect(fs.existsSync(bound.dir)).toBe(true);
    expect(fs.existsSync(orphan)).toBe(true);
  });
});
