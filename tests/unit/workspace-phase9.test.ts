/**
 * Phase 9 — Workspace / Project lifecycle correctness.
 *
 * Simple vs Project separation, canonical registration identity, explicit
 * unavailable states, and conversation↔workspace binding guards. Deterministic:
 * real tmp dirs (created/renamed/removed synchronously), controlled promise
 * barriers for races — no sleeps, no timing hacks.
 *
 * DB isolation via tests/setup.ts (tmp DATA_DIR per pid). Every case cleans
 * up its own folders/conversations so files sharing this process never see
 * each other's rows.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import fs from "fs";
import os from "os";
import path from "path";
import conversationsApp from "../../src/routes/conversations";
import foldersApp from "../../src/routes/folders";
import { folderService, FolderRegistrationError } from "../../src/services/folders";
import {
  resolveConversationWorkspace,
  WorkspaceError,
} from "../../src/services/workspace";
import { conversationService } from "../../src/services/storage";

const app = new Hono();
app.route("/", conversationsApp);
app.route("/api/folders", foldersApp);

async function appFetch(url: string, init: RequestInit = {}) {
  const res = await app.request(url, init);
  return { status: res.status, json: () => res.json() as Promise<any> };
}

function postJson(url: string, body: unknown) {
  return appFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patchJson(url: string, body: unknown) {
  return appFetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Fresh existing directory, owned by the case (removed in cleanup). */
function makeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tbai-p9-"));
}

const ownedDirs: string[] = [];
const ownedFolderIds: string[] = [];
const ownedConvIds: string[] = [];

function trackDir(dir: string): string {
  ownedDirs.push(dir);
  return dir;
}

async function cleanup(): Promise<void> {
  for (const id of ownedConvIds.splice(0)) {
    await conversationService.delete(id).catch(() => {});
  }
  for (const id of ownedFolderIds.splice(0)) {
    await folderService.remove(id).catch(() => {});
  }
  for (const dir of ownedDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // Belt-and-braces: nothing project-bound may leak between cases.
  for (const f of await folderService.listAll()) {
    if (f.kind !== "chat") await folderService.remove(f.id).catch(() => {});
  }
}

beforeEach(cleanup);

describe("canonical registration identity", () => {
  it("equivalent path spellings resolve to one row", async () => {
    const dir = trackDir(makeDir());
    const a = await folderService.openFolder({ path: dir });
    ownedFolderIds.push(a.id);
    const b = await folderService.openFolder({ path: dir + path.sep });
    const c = await folderService.openFolder({
      path: path.join(dir, ".", "sub", ".."),
    });
    expect(b.id).toBe(a.id);
    expect(c.id).toBe(a.id);
    expect((await folderService.listAll()).filter((f) => f.id === a.id)).toHaveLength(1);
  });

  it("duplicate concurrent registrations converge on one row", async () => {
    const dir = trackDir(makeDir());
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        folderService.openFolder({ path: dir + path.sep }),
      ),
    );
    ownedFolderIds.push(results[0]!.id);
    expect(new Set(results.map((f) => f.id)).size).toBe(1);
    expect(
      (await folderService.listAll()).filter((f) => f.path === results[0]!.path),
    ).toHaveLength(1);
  });

  it("re-opening an already registered project returns the same identity", async () => {
    const dir = trackDir(makeDir());
    const a = await folderService.openFolder({ path: dir, name: "P9" });
    ownedFolderIds.push(a.id);
    await folderService.close(a.id);
    const b = await folderService.openFolder({ path: dir });
    expect(b.id).toBe(a.id);
    expect((await folderService.get(b.id))?.isOpen).toBe(true);
  });
});

describe("registration validation", () => {
  it("rejects a nonexistent path with path_missing", async () => {
    const ghost = path.join(os.tmpdir(), `tbai-p9-ghost-${Date.now()}`);
    const err = await folderService
      .openFolder({ path: ghost })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(FolderRegistrationError);
    expect((err as FolderRegistrationError).code).toBe("path_missing");
  });

  it("rejects a file path with path_not_directory", async () => {
    const dir = trackDir(makeDir());
    const file = path.join(dir, "f.txt");
    fs.writeFileSync(file, "x");
    const err = await folderService
      .openFolder({ path: file })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(FolderRegistrationError);
    expect((err as FolderRegistrationError).code).toBe("path_not_directory");
  });

  it("rejects a blank path without touching the server cwd", async () => {
    const err = await folderService
      .openFolder({ path: "   " })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(FolderRegistrationError);
  });

  it("re-opening a registered row whose disk vanished still re-opens by identity", async () => {
    const dir = trackDir(makeDir());
    const a = await folderService.openFolder({ path: dir });
    ownedFolderIds.push(a.id);
    fs.rmSync(dir, { recursive: true, force: true });
    // Disk is gone but the ROW is the identity: re-open must not reject.
    const b = await folderService.openFolder({ path: dir });
    expect(b.id).toBe(a.id);
  });

  it("POST /api/folders maps missing dir to 404 and file to 400", async () => {
    const ghost = path.join(os.tmpdir(), `tbai-p9-ghost-${Date.now()}`);
    expect((await postJson("/api/folders", { path: ghost })).status).toBe(404);
    const dir = trackDir(makeDir());
    const file = path.join(dir, "f.txt");
    fs.writeFileSync(file, "x");
    expect((await postJson("/api/folders", { path: file })).status).toBe(400);
  });

  it("POST /api/folders equivalent spelling re-registers the same id", async () => {
    const dir = trackDir(makeDir());
    const first = await postJson("/api/folders", { path: dir, name: "P9" });
    expect(first.status).toBe(200);
    const second = await postJson("/api/folders", {
      path: dir + path.sep,
      name: "P9",
    });
    expect(second.status).toBe(200);
    const firstBody = await first.json();
    const secondBody = await second.json();
    expect(secondBody.id).toBe(firstBody.id);
    ownedFolderIds.push(firstBody.id);
  });
});

describe("project resolution and unavailable state", () => {
  it("disk-removed project resolves folder_unavailable and preserves the row", async () => {
    const dir = trackDir(makeDir());
    const folder = await folderService.openFolder({ path: dir });
    ownedFolderIds.push(folder.id);
    const conv = await conversationService.create({
      title: "P9",
      providerId: null,
      modelId: null,
      reasoningLevel: null,
      systemPrompt: null,
      workspaceMode: "project",
      workspaceFolderId: folder.id,
    });
    ownedConvIds.push(conv.id);
    fs.rmSync(dir, { recursive: true, force: true });

    const err = await resolveConversationWorkspace(conv.id).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(WorkspaceError);
    expect((err as WorkspaceError).code).toBe("folder_unavailable");
    // Nothing was switched or deleted: the binding survives for recovery.
    const reloaded = await conversationService.get(conv.id);
    expect(reloaded?.workspaceMode).toBe("project");
    expect(reloaded?.workspaceFolderId).toBe(folder.id);
    expect(await folderService.get(folder.id)).not.toBeNull();
  });

  it("removing a registration never deletes its conversations", async () => {
    const dir = trackDir(makeDir());
    const folder = await folderService.openFolder({ path: dir });
    ownedFolderIds.push(folder.id);
    const conv = await conversationService.create({
      title: "P9",
      providerId: null,
      modelId: null,
      reasoningLevel: null,
      systemPrompt: null,
      workspaceMode: "project",
      workspaceFolderId: folder.id,
    });
    ownedConvIds.push(conv.id);
    await folderService.remove(folder.id);
    // The conversation is untouched and distinguishable (still project-bound).
    const reloaded = await conversationService.get(conv.id);
    expect(reloaded?.workspaceMode).toBe("project");
    expect(reloaded?.workspaceFolderId).toBe(folder.id);
    // …and resolution fails explicitly instead of substituting another folder.
    const err = await resolveConversationWorkspace(conv.id).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as WorkspaceError).code).toBe("folder_missing");
  });
});

describe("conversation workspace binding guards", () => {
  it("POST project with a dead folder id is a truthful 400 (no row minted)", async () => {
    const before = (await conversationService.list()).threads.length;
    const res = await postJson("/api/conversations", {
      title: "P9",
      workspaceMode: "project",
      workspaceFolderId: "no-such-folder",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not available/i);
    expect((await conversationService.list()).threads.length).toBe(before);
  });

  it("POST project with a chat-kind folder id is a truthful 400", async () => {
    const conv = await conversationService.create({
      title: "simple",
      providerId: null,
      modelId: null,
      reasoningLevel: null,
      systemPrompt: null,
      workspaceMode: "simple",
      workspaceFolderId: null,
    });
    ownedConvIds.push(conv.id);
    const chatFolderId = (await conversationService.get(conv.id))!.workspaceFolderId!;
    const res = await postJson("/api/conversations", {
      title: "P9",
      workspaceMode: "project",
      workspaceFolderId: chatFolderId,
    });
    expect(res.status).toBe(400);
  });

  it("PATCH mode→project without a folder is rejected and the row is unchanged", async () => {
    const conv = await conversationService.create({
      title: "simple",
      providerId: null,
      modelId: null,
      reasoningLevel: null,
      systemPrompt: null,
      workspaceMode: "simple",
      workspaceFolderId: null,
    });
    ownedConvIds.push(conv.id);
    const res = await patchJson(`/api/conversations/${conv.id}`, {
      workspaceMode: "project",
    });
    expect(res.status).toBe(400);
    const reloaded = await conversationService.get(conv.id);
    expect(reloaded?.workspaceMode).toBe("simple");
  });

  it("PATCH engine-only on a project conversation leaves the workspace untouched", async () => {
    const dir = trackDir(makeDir());
    const folder = await folderService.openFolder({ path: dir });
    ownedFolderIds.push(folder.id);
    const conv = await conversationService.create({
      title: "P9",
      providerId: null,
      modelId: null,
      reasoningLevel: null,
      systemPrompt: null,
      workspaceMode: "project",
      workspaceFolderId: folder.id,
      engine: "direct",
    });
    ownedConvIds.push(conv.id);
    const res = await patchJson(`/api/conversations/${conv.id}`, {
      engine: "opencode",
    });
    expect(res.status).toBe(200);
    const reloaded = await conversationService.get(conv.id);
    expect(reloaded?.engine).toBe("opencode");
    expect(reloaded?.workspaceMode).toBe("project");
    expect(reloaded?.workspaceFolderId).toBe(folder.id);
    // …and the project workspace still resolves to the registered directory.
    const ws = await resolveConversationWorkspace(conv.id);
    expect(ws.mode).toBe("project");
    expect(ws.folderId).toBe(folder.id);
  });

  it("PATCH workspaceFolderId to a dead id is rejected (no silent switch)", async () => {
    const dirA = trackDir(makeDir());
    const dirB = trackDir(makeDir());
    const folderA = await folderService.openFolder({ path: dirA });
    const folderB = await folderService.openFolder({ path: dirB });
    ownedFolderIds.push(folderA.id, folderB.id);
    const conv = await conversationService.create({
      title: "P9",
      providerId: null,
      modelId: null,
      reasoningLevel: null,
      systemPrompt: null,
      workspaceMode: "project",
      workspaceFolderId: folderA.id,
    });
    ownedConvIds.push(conv.id);
    await folderService.remove(folderB.id);
    const res = await patchJson(`/api/conversations/${conv.id}`, {
      workspaceFolderId: folderB.id,
    });
    expect(res.status).toBe(400);
    expect((await conversationService.get(conv.id))?.workspaceFolderId).toBe(
      folderA.id,
    );
  });
});
