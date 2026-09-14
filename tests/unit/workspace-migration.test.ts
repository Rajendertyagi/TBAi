/**
 * Simple-chat workspace migration: legacy `data/chat/<uuid>` rows move to
 * `workspace/chats/<conversationId>` on first filesystem use
 * (copy → verify → switch row → retain legacy for GC).
 *
 * DB + DATA_DIR/WORKSPACE_DIR isolation via tests/setup.ts (tmp per pid).
 */
import { describe, it, expect } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import {
  resolveConversationWorkspace,
  chatWorkspaceDir,
  gcOrphanChatDirs,
  verifyTreeCopy,
  WorkspaceError,
} from "../../src/services/workspace";
import { folderService } from "../../src/services/folders";
import { conversationService } from "../../src/services/storage";
import { getWorkspaceDir } from "../../src/services/tools";
import { db } from "../../src/db";
import { db } from "../../src/db";

const dataDir = process.env.DATA_DIR!;
const legacyRoot = path.join(dataDir, "chat");

async function seedSimpleConversation() {
  return conversationService.create({
    title: "mig-test",
    providerId: "x",
    modelId: null,
    reasoningLevel: null,
    systemPrompt: null,
    workspaceMode: "simple",
    workspaceFolderId: null,
  });
}

async function seedLegacyChat(files: Record<string, string> = { "notes.txt": "hello\n" }) {
  // New conversations auto-bind a (new-layout) folder; repoint that SAME row
  // at a legacy dir to simulate a pre-migration database (no duplicate rows,
  // ownership preserved — exactly what real legacy DBs look like).
  const conv = await seedSimpleConversation();
  const fresh = await conversationService.get(conv.id);
  const folderId = fresh!.workspaceFolderId!;
  const legacyDir = path.join(legacyRoot, `legacy-${conv.id}`);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(legacyDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  db.run("UPDATE folders SET path = ? WHERE id = ?", [legacyDir, folderId]);
  const folder = (await folderService.get(folderId))!;
  return { conv, folder, legacyDir };
}

async function cleanup(convId: string, folderId: string) {
  await conversationService.delete(convId).catch(() => {});
  await folderService.remove(folderId).catch(() => {});
}

async function rowPath(folderId: string): Promise<string | null> {
  const f = await folderService.get(folderId);
  return f?.path ?? null;
}

describe("new simple-chat workspaces", () => {
  it("creates workspace/chats/<conversationId>, canonical and existing", async () => {
    const conv = await seedSimpleConversation();
    const ws = await resolveConversationWorkspace(conv.id);
    expect(ws.mode).toBe("simple");
    expect(ws.dir).toBe(chatWorkspaceDir(conv.id));
    expect(path.isAbsolute(ws.dir)).toBe(true);
    expect(fs.realpathSync(ws.dir)).toBe(ws.dir);
    expect(fs.existsSync(ws.dir)).toBe(true);
    expect(ws.dir).not.toContain(legacyRoot);
    await cleanup(conv.id, ws.folderId);
  });

  it("resolves the same path repeatedly; distinct conversations differ", async () => {
    const a = await seedSimpleConversation();
    const b = await seedSimpleConversation();
    const ra = await resolveConversationWorkspace(a.id);
    const rb = await resolveConversationWorkspace(b.id);
    expect(ra.dir).toBe((await resolveConversationWorkspace(a.id)).dir);
    expect(ra.dir).not.toBe(rb.dir);
    await cleanup(a.id, ra.folderId);
    await cleanup(b.id, rb.folderId);
  });
});

describe("legacy migration", () => {
  it("copies, verifies, switches the row, and retains the legacy tree", async () => {
    const { conv, folder, legacyDir } = await seedLegacyChat({
      "notes.txt": "hello\n",
      "sub/tree.txt": "deep\n",
    });
    const ws = await resolveConversationWorkspace(conv.id);
    expect(ws.dir).toBe(chatWorkspaceDir(conv.id));
    expect(fs.readFileSync(path.join(ws.dir, "notes.txt"), "utf8")).toBe("hello\n");
    expect(fs.readFileSync(path.join(ws.dir, "sub", "tree.txt"), "utf8")).toBe("deep\n");
    expect(await rowPath(folder.id)).toBe(ws.dir);
    // Legacy retained for GC grace (never deleted by migration itself).
    expect(fs.existsSync(legacyDir)).toBe(true);
    expect(fs.existsSync(path.join(legacyDir, "notes.txt"))).toBe(true);
    await cleanup(conv.id, folder.id);
  });

  it("is idempotent: second resolve is a no-op returning the same path", async () => {
    const { conv, folder } = await seedLegacyChat();
    const first = await resolveConversationWorkspace(conv.id);
    const rowBefore = await rowPath(folder.id);
    const second = await resolveConversationWorkspace(conv.id);
    expect(second.dir).toBe(first.dir);
    expect(await rowPath(folder.id)).toBe(rowBefore);
    await cleanup(conv.id, folder.id);
  });

  it("resumes a partial copy to completion", async () => {
    const { conv, folder, legacyDir } = await seedLegacyChat({
      "a.txt": "a\n",
      "b.txt": "b\n",
      "sub/c.txt": "c\n",
    });
    // Simulate an interrupted migration: new dir exists with a subset.
    const next = chatWorkspaceDir(conv.id);
    fs.mkdirSync(path.join(next, "sub"), { recursive: true });
    fs.writeFileSync(path.join(next, "a.txt"), "a\n");
    const ws = await resolveConversationWorkspace(conv.id);
    expect(fs.readFileSync(path.join(ws.dir, "b.txt"), "utf8")).toBe("b\n");
    expect(fs.readFileSync(path.join(ws.dir, "sub", "c.txt"), "utf8")).toBe("c\n");
    expect(await rowPath(folder.id)).toBe(ws.dir);
    expect(fs.existsSync(legacyDir)).toBe(true);
    await cleanup(conv.id, folder.id);
  });

  it("copy failure keeps the legacy tree and the DB row", async () => {
    const { conv, folder, legacyDir } = await seedLegacyChat({ "notes.txt": "hello\n" });
    // Simulate a mid-migration crash (disk failure between mkdir and verify):
    // the row must not switch and the legacy tree must be intact.
    const origCp = fs.cpSync;
    (fs as unknown as { cpSync: unknown }).cpSync = () => {
      throw new Error("disk on fire");
    };
    let thrown: unknown;
    try {
      await resolveConversationWorkspace(conv.id);
    } catch (e) {
      thrown = e;
    } finally {
      (fs as unknown as { cpSync: unknown }).cpSync = origCp;
    }
    expect(thrown).toBeTruthy();
    expect(await rowPath(folder.id)).toBe(legacyDir);
    expect(fs.readFileSync(path.join(legacyDir, "notes.txt"), "utf8")).toBe("hello\n");
    await cleanup(conv.id, folder.id);
  });

  it("verifyTreeCopy passes identical trees, fails missing/divergent ones", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-verify-"));
    const src = path.join(base, "src");
    const good = path.join(base, "good");
    fs.mkdirSync(path.join(src, "sub"), { recursive: true });
    fs.writeFileSync(path.join(src, "a.txt"), "aaa\n");
    fs.writeFileSync(path.join(src, "sub", "b.txt"), "bb\n");
    fs.cpSync(src, good, { recursive: true });
    expect(() => verifyTreeCopy(src, good)).not.toThrow();

    const missing = path.join(base, "missing");
    fs.cpSync(src, missing, { recursive: true });
    fs.rmSync(path.join(missing, "sub", "b.txt"));
    expect(() => verifyTreeCopy(src, missing)).toThrow(WorkspaceError);

    const divergent = path.join(base, "divergent");
    fs.cpSync(src, divergent, { recursive: true });
    fs.writeFileSync(path.join(divergent, "a.txt"), "different length content here\n");
    expect(() => verifyTreeCopy(src, divergent)).toThrow(WorkspaceError);
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("missing legacy dir creates fresh without failing", async () => {
    const conv = await seedSimpleConversation();
    const fresh = await conversationService.get(conv.id);
    const folderId = fresh!.workspaceFolderId!;
    const ghost = path.join(legacyRoot, `ghost-${conv.id}`);
    db.run("UPDATE folders SET path = ? WHERE id = ?", [ghost, folderId]);
    const ws = await resolveConversationWorkspace(conv.id);
    expect(ws.dir).toBe(chatWorkspaceDir(conv.id));
    expect(fs.existsSync(ws.dir)).toBe(true);
    const folder = (await folderService.get(folderId))!;
    expect(folder.path).toBe(ws.dir);
    await cleanup(conv.id, folderId);
  });

  it("leaves project rows untouched", async () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-migproj-"));
    const folder = await folderService.openFolder({ path: proj, name: "P" });
    const conv = await conversationService.create({
      title: "mig-proj",
      providerId: "x",
      modelId: null,
      reasoningLevel: null,
      systemPrompt: null,
      workspaceMode: "project",
      workspaceFolderId: folder.id,
    });
    const ws = await resolveConversationWorkspace(conv.id);
    expect(ws.mode).toBe("project");
    expect(ws.dir).toBe(fs.realpathSync(proj));
    expect(await rowPath(folder.id)).toBe(proj);
    await cleanup(conv.id, folder.id);
  });
});

describe("gc across both layouts", () => {
  function oldDir(base: string, name: string): string {
    const dir = path.join(base, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "f.txt"), "x\n");
    const past = new Date(Date.now() - 30 * 60 * 1000);
    fs.utimesSync(dir, past, past);
    return dir;
  }

  it("reaps unbound stale dirs in both roots and keeps bound ones", async () => {
    const chatsRoot = path.join(getWorkspaceDir(), "chats");
    const orphanLegacy = oldDir(legacyRoot, `orphan-legacy-${Date.now()}`);
    const orphanNew = oldDir(chatsRoot, `orphan-new-${Date.now()}`);

    // Migrated conversation: new dir is bound (kept even when stale);
    // legacy dir is now unbound + stale, so GC reclaims it per policy.
    const { conv, folder, legacyDir } = await seedLegacyChat({ "k.txt": "k\n" });
    const ws = await resolveConversationWorkspace(conv.id);
    const past = new Date(Date.now() - 30 * 60 * 1000);
    fs.utimesSync(ws.dir, past, past);
    fs.utimesSync(legacyDir, past, past);

    // Pre-migration binding: row still points at legacy, stale but bound.
    const conv2 = await seedSimpleConversation();
    const fresh2 = await conversationService.get(conv2.id);
    const folderId2 = fresh2!.workspaceFolderId!;
    const legacyDir2 = path.join(legacyRoot, `legacy-${conv2.id}`);
    fs.mkdirSync(legacyDir2, { recursive: true });
    fs.writeFileSync(path.join(legacyDir2, "old.txt"), "old\n");
    db.run("UPDATE folders SET path = ? WHERE id = ?", [legacyDir2, folderId2]);
    fs.utimesSync(legacyDir2, past, past);

    gcOrphanChatDirs();
    expect(fs.existsSync(orphanLegacy)).toBe(false);
    expect(fs.existsSync(orphanNew)).toBe(false);
    expect(fs.existsSync(ws.dir)).toBe(true);
    expect(fs.existsSync(legacyDir)).toBe(false);
    expect(fs.existsSync(legacyDir2)).toBe(true);
    await cleanup(conv.id, folder.id);
    await cleanup(conv2.id, folderId2);
  });
});
