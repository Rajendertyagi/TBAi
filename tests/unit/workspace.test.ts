/**
 * Unit tests for the two-mode workspace model:
 *   - resolveConversationWorkspace (canonical path resolver)
 *   - folderService / folderLinkService / folderGroupService
 *
 * DB isolation is handled by tests/setup.ts (redirects DATA_DIR to tmp).
 */
import { describe, it, expect, beforeEach } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import {
  resolveConversationWorkspace,
  WorkspaceError,
} from "../../src/services/workspace";
import {
  folderService,
  folderLinkService,
  folderGroupService,
  addChatFolder,
} from "../../src/services/folders";
import { conversationService } from "../../src/services/storage";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-ws-"));

function seedConversation(over: {
  workspaceMode: "simple" | "project";
  workspaceFolderId?: string | null;
}) {
  return conversationService.create({
    title: "ws-test",
    providerId: "x",
    modelId: null,
    reasoningLevel: null,
    systemPrompt: null,
    workspaceMode: over.workspaceMode,
    workspaceFolderId: over.workspaceFolderId ?? null,
  });
}

describe("resolveConversationWorkspace", () => {
  it("simple mode resolves to a hidden chat folder workspace", async () => {
    const conv = await seedConversation({ workspaceMode: "simple" });
    const ws = await resolveConversationWorkspace(conv.id);
    expect(ws.mode).toBe("simple");
    // Now uses a hidden chat folder under data/chat/<uuid>/
    expect(ws.dir).toContain(path.join("chat"));
    expect(ws.folderId).toBeTruthy();
    expect(ws.folderName).toBe("Chat");
    expect(fs.existsSync(ws.dir)).toBe(true);
    await conversationService.delete(conv.id);
  });

  it("project mode resolves to the registered folder path", async () => {
    const folder = await folderService.openFolder({ path: tmp, name: "proj" });
    const conv = await seedConversation({
      workspaceMode: "project",
      workspaceFolderId: folder.id,
    });
    const ws = await resolveConversationWorkspace(conv.id);
    expect(ws.mode).toBe("project");
    expect(ws.dir).toBe(tmp);
    expect(ws.folderId).toBe(folder.id);
    expect(ws.folderName).toBe("proj");
    await conversationService.delete(conv.id);
    await folderService.remove(folder.id);
  });

  it("project mode with a missing/deleted folder throws WorkspaceError(folder_missing)", async () => {
    const folder = await folderService.openFolder({ path: tmp });
    const conv = await seedConversation({
      workspaceMode: "project",
      workspaceFolderId: folder.id,
    });
    await folderService.remove(folder.id); // soft delete
    let thrown: unknown;
    try {
      await resolveConversationWorkspace(conv.id);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(WorkspaceError);
    expect((thrown as WorkspaceError).code).toBe("folder_missing");
    await conversationService.delete(conv.id);
  });

  it("unknown conversation id throws WorkspaceError(conversation_missing)", async () => {
    let thrown: unknown;
    try {
      await resolveConversationWorkspace("does-not-exist");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(WorkspaceError);
    expect((thrown as WorkspaceError).code).toBe("conversation_missing");
  });
});

describe("folderService", () => {
  it("openFolder upserts by path and re-opening returns the same id", async () => {
    const a = await folderService.openFolder({ path: tmp, name: "first" });
    const b = await folderService.openFolder({ path: tmp, alias: "alias" });
    expect(a.id).toBe(b.id);
    expect(b.alias).toBe("alias");
    await folderService.remove(a.id);
  });

  it("update changes alias/color/group; close toggles is_open; remove soft-deletes", async () => {
    const f = await folderService.openFolder({ path: tmp });
    await folderService.update(f.id, { alias: "renamed", color: "#fff", groupId: null });
    const updated = await folderService.get(f.id);
    expect(updated?.alias).toBe("renamed");
    expect(updated?.color).toBe("#fff");

    await folderService.close(f.id);
    const closed = await folderService.get(f.id);
    expect(closed?.isOpen).toBe(false);

    await folderService.remove(f.id);
    const gone = await folderService.get(f.id);
    expect(gone).toBeNull();
  });

  it("listAll excludes soft-deleted folders", async () => {
    const f = await folderService.openFolder({ path: tmp });
    expect((await folderService.listAll()).some((x) => x.id === f.id)).toBe(true);
    await folderService.remove(f.id);
    expect((await folderService.listAll()).some((x) => x.id === f.id)).toBe(false);
  });

  it("listOpen excludes chat folders", async () => {
    const regular = await folderService.openFolder({ path: tmp });
    const chat = await addChatFolder(path.join(tmp, "chat-scratch"));
    const openList = await folderService.listOpen();
    expect(openList.some((x) => x.id === regular.id)).toBe(true);
    expect(openList.some((x) => x.id === chat.id)).toBe(false);
    // listAll includes both
    const allList = await folderService.listAll();
    expect(allList.some((x) => x.id === regular.id)).toBe(true);
    expect(allList.some((x) => x.id === chat.id)).toBe(true);
    await folderService.remove(regular.id);
    await folderService.remove(chat.id);
  });

  it("cleanupChatFolder soft-deletes empty chat folders", async () => {
    const chat = await addChatFolder(path.join(tmp, "cleanup-test"));
    expect(chat.kind).toBe("chat");
    const cleaned = await folderService.cleanupChatFolder(chat.id);
    expect(cleaned).toBe(true);
    const gone = await folderService.get(chat.id);
    expect(gone).toBeNull();
  });

  it("cleanupChatFolder is idempotent for already-deleted folders", async () => {
    const chat = await addChatFolder(path.join(tmp, "idempotent-test"));
    await folderService.cleanupChatFolder(chat.id);
    // Second call should be a no-op (returns true = already gone).
    const again = await folderService.cleanupChatFolder(chat.id);
    expect(again).toBe(true);
  });

  it("cleanupChatFolder skips non-chat folders", async () => {
    const regular = await folderService.openFolder({ path: tmp });
    const cleaned = await folderService.cleanupChatFolder(regular.id);
    expect(cleaned).toBe(false);
    // Folder still exists.
    const still = await folderService.get(regular.id);
    expect(still).not.toBeNull();
    await folderService.remove(regular.id);
  });
});

describe("folderLinkService", () => {
  it("insert / listByFolder / rename / delete round-trips", async () => {
    const f = await folderService.openFolder({ path: tmp });
    const link = await folderLinkService.insert(f.id, "docs", path.join(tmp, "docs"));
    expect(link.name).toBe("docs");

    const list = await folderLinkService.listByFolder(f.id);
    expect(list.length).toBe(1);

    const renamed = await folderLinkService.rename(link.id, "documents");
    expect(renamed?.name).toBe("documents");

    await folderLinkService.delete(link.id);
    expect((await folderLinkService.listByFolder(f.id)).length).toBe(0);

    await folderService.remove(f.id);
  });

  it("preview returns a plan for the requested targets", async () => {
    const f = await folderService.openFolder({ path: tmp });
    const plan = await folderLinkService.preview(f.id, [
      { name: "a", targetPath: path.join(tmp, "a") },
      { name: "b", targetPath: path.join(tmp, "b") },
    ]);
    expect(plan.length).toBe(2);
    await folderService.remove(f.id);
  });
});

describe("folderGroupService", () => {
  it("create / list / update / delete", async () => {
    const g = await folderGroupService.create({ name: "Backend", color: "#ff0000" });
    expect((await folderGroupService.list()).some((x) => x.id === g.id)).toBe(true);
    const updated = await folderGroupService.update(g.id, { name: "Services" });
    expect(updated?.name).toBe("Services");
    await folderGroupService.delete(g.id);
    expect((await folderGroupService.list()).some((x) => x.id === g.id)).toBe(false);
  });

  it("setFolderGroup attaches a folder to a group", async () => {
    const g = await folderGroupService.create({ name: "G" });
    const f = await folderService.openFolder({ path: tmp });
    await folderGroupService.setFolderGroup(f.id, g.id);
    const got = await folderService.get(f.id);
    expect(got?.groupId).toBe(g.id);
    await folderService.remove(f.id);
    await folderGroupService.delete(g.id);
  });
});

beforeEach(async () => {
  // Cleanup between tests to keep the tmp DB tidy.
  // Include hidden chat folders (kind='chat') in the cleanup.
  for (const f of await folderService.listAll()) await folderService.remove(f.id);
  for (const g of await folderGroupService.list()) await folderGroupService.delete(g.id);
});
