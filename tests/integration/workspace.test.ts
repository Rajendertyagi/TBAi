/**
 * Integration tests for the two-mode workspace model through the real Hono app:
 * folder registration REST API, directory browse, and conversation workspace
 * field persistence (the contract the frontend Project Chat flow relies on).
 *
 * DB isolation: tests/setup.ts redirects DATA_DIR to tmp.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import fs from "fs";
import os from "os";
import path from "path";
import conversationsApp from "../../src/routes/conversations";
import foldersApp from "../../src/routes/folders";
import { folderService } from "../../src/services/folders";

const app = new Hono();
app.route("/", conversationsApp);
app.route("/api/folders", foldersApp);

const browseDir = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-browse-"));
fs.mkdirSync(path.join(browseDir, "subfolder"), { recursive: true });

async function appFetch(path: string, init: RequestInit = {}) {
  const res = await app.request(path, init);
  return { status: res.status, json: () => res.json(), text: () => res.text() };
}

describe("folders REST API", () => {
  let folderId: string;

  it("POST /api/folders registers a folder and returns its id", async () => {
    const { status, json } = await appFetch("/api/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: browseDir, name: "Proj", alias: "P" }),
    });
    expect(status).toBe(200);
    const f = await json();
    expect(f.id).toBeTruthy();
    expect(f.path).toBe(browseDir);
    expect(f.alias).toBe("P");
    folderId = f.id;
  });

  it("GET /api/folders lists registered folders", async () => {
    const created = await appFetch("/api/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: browseDir, name: "Listed" }),
    });
    const newId = (await created.json()).id;

    const { status, json } = await appFetch("/api/folders");
    expect(status).toBe(200);
    const list = await json();
    expect(Array.isArray(list)).toBe(true);
    expect(list.some((x: any) => x.id === newId)).toBe(true);
  });

  it("GET /api/folders/browse lists directories under a path", async () => {
    const { status, json } = await appFetch(
      `/api/folders/browse?path=${encodeURIComponent(browseDir)}`,
    );
    expect(status).toBe(200);
    const data = await json();
    expect(data.path).toBe(browseDir);
    expect(data.entries).toContain("subfolder");
  });

  it("folder link CRUD via REST", async () => {
    const create = await appFetch(`/api/folders/${folderId}/links`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "docs", targetPath: path.join(browseDir, "docs") }),
    });
    expect(create.status).toBe(200);
    const link = await create.json();

    const list = await appFetch(`/api/folders/${folderId}/links`);
    expect((await list.json()).length).toBe(1);

    const rename = await appFetch(`/api/folders/${folderId}/links/${link.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "documents" }),
    });
    expect((await rename.json()).name).toBe("documents");

    const del = await appFetch(`/api/folders/${folderId}/links/${link.id}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);
    expect((await appFetch(`/api/folders/${folderId}/links`)).json()).resolves;
  });

  it("folder group CRUD via REST", async () => {
    const g = await appFetch("/api/folders/groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Group" }),
    });
    expect(g.status).toBe(200);
    const group = await g.json();
    expect(group.id).toBeTruthy();

    const list = await appFetch("/api/folders/groups");
    expect((await list.json()).some((x: any) => x.id === group.id)).toBe(true);

    const del = await appFetch(`/api/folders/groups/${group.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
  });

  it("rejects invalid input with a 400", async () => {
    const res = await appFetch("/api/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "no-path" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("conversation workspace fields", () => {
  it("POST /api/conversations accepts workspaceMode=project + workspaceFolderId", async () => {
    const folder = await folderService.openFolder({ path: browseDir });
    const { status, json } = await appFetch("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Proj Chat",
        workspaceMode: "project",
        workspaceFolderId: folder.id,
      }),
    });
    expect(status).toBe(200);
    const conv = await json();
    expect(conv.workspaceMode).toBe("project");
    expect(conv.workspaceFolderId).toBe(folder.id);

    const got = await (await appFetch(`/api/conversations/${conv.id}`)).json();
    expect(got.workspaceMode).toBe("project");
    expect(got.workspaceFolderId).toBe(folder.id);

    await folderService.remove(folder.id);
  });

  it("PATCH to simple mode clears workspaceFolderId", async () => {
    const folder = await folderService.openFolder({ path: browseDir });
    const created = await (
      await appFetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Proj",
          workspaceMode: "project",
          workspaceFolderId: folder.id,
        }),
      })
    ).json();

    const patched = await (
      await appFetch(`/api/conversations/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceMode: "simple" }),
      })
    ).json();
    expect(patched.workspaceMode).toBe("simple");
    expect(patched.workspaceFolderId).toBeNull();

    await folderService.remove(folder.id);
  });

  it("defaults to simple mode when omitted", async () => {
    const created = await (
      await appFetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Simple" }),
      })
    ).json();
    expect(created.workspaceMode).toBe("simple");
    // Simple chats now get a hidden kind='chat' folder, so workspaceFolderId is set.
    expect(created.workspaceFolderId).toBeTruthy();
  });
});

beforeEach(async () => {
  for (const f of await folderService.listAll()) await folderService.remove(f.id);
});
