/**
 * Workspace-mode guards on the conversation routes (b771f26).
 *
 * A project-scoped conversation must always reference a LIVE, non-chat folder.
 * Two guards enforce that, and neither had any test coverage:
 *
 *   CREATE — a project create without a usable folder fails truthfully (400)
 *            instead of minting a row that can never resolve its workspace.
 *   PATCH  — validated against the EFFECTIVE state (the patch merged with the
 *            existing row), so a mode flip that leaves no live folder is
 *            rejected rather than silently degrading the row to simple on its
 *            first filesystem use.
 *
 * The PATCH case is the subtle one: flipping a SIMPLE conversation to project
 * with no folder id would otherwise leave it project-scoped while still
 * pointing at its hidden `kind='chat'` folder — the exact state these guards
 * exist to prevent. Verified live before writing this test.
 *
 * DB isolation: tests/setup.ts (bunfig preload) redirects DATA_DIR to tmp.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import fs from "fs";
import os from "os";
import path from "path";
import { logger } from "../../src/lib/logger";
import { conversationService } from "../../src/services/storage";
import { folderService } from "../../src/services/folders";
import conversationsApp from "../../src/routes/conversations";

const app = new Hono();
app.route("/", conversationsApp);

const jsonHeaders = { "Content-Type": "application/json" };

async function call(pathname: string, init: RequestInit = {}) {
  const res = await app.request(pathname, init);
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, body };
}

const create = (body: unknown) =>
  call("/api/conversations", { method: "POST", headers: jsonHeaders, body: JSON.stringify(body) });
const patch = (id: string, body: unknown) =>
  call(`/api/conversations/${id}`, { method: "PATCH", headers: jsonHeaders, body: JSON.stringify(body) });
const get = (id: string) => call(`/api/conversations/${id}`);

/** A real registered project folder (kind='regular') on a temp dir. */
async function makeProjectFolder(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-proj-"));
  const folder = await folderService.openFolder({ path: dir, name: "Guard Project" });
  return folder.id;
}

/** A conversation row count, for "no row was created" assertions. */
async function rowCount(): Promise<number> {
  return (await conversationService.list({ limit: 1000 })).threads.length;
}

const REJECTED = "Project folder is not available";

beforeEach(() => {
  logger.configure({ level: "debug", targets: [], file: null, fileEnabled: false });
});

afterEach(() => {
  // Process-wide singleton: restore or the level leaks into other test files.
  logger.configure({ level: "error", targets: [], file: null, fileEnabled: false });
});

describe("CREATE guard: a project chat needs a live non-chat folder", () => {
  it("rejects a project create with no folder id, and creates no row", async () => {
    const before = await rowCount();
    const res = await create({ title: "No folder", workspaceMode: "project" });
    expect(res.status).toBe(400);
    // Two layers protect the create path, and this case is caught by the
    // FIRST one: `conversationCreateSchema.superRefine` requires the folder
    // outright, so the request never reaches the route's liveness guard.
    // (PATCH has no such schema rule — an omitted folder legitimately means
    // "keep the existing one" — so there the route guard is what fires.)
    expect(res.body.error).toBe("Invalid request");
    expect(
      (res.body.issues ?? []).some((i: { message?: string }) =>
        String(i.message ?? "").includes("workspaceFolderId"),
      ),
    ).toBe(true);
    expect(await rowCount()).toBe(before);
  });

  it("rejects a project create pointed at a chat-kind folder", async () => {
    // A simple conversation's own workspace folder IS a kind='chat' folder.
    const simple = (await create({ title: "Simple" })).body;
    expect(simple.workspaceFolderId).toBeTruthy();

    const before = await rowCount();
    const res = await create({
      title: "Chat folder as project",
      workspaceMode: "project",
      workspaceFolderId: simple.workspaceFolderId,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(REJECTED);
    expect(await rowCount()).toBe(before);
  });

  it("accepts a project create bound to a real folder", async () => {
    const folderId = await makeProjectFolder();
    const res = await create({
      title: "Real project",
      workspaceMode: "project",
      workspaceFolderId: folderId,
    });
    expect(res.status).toBe(200);
    expect(res.body.workspaceMode).toBe("project");
    expect(res.body.workspaceFolderId).toBe(folderId);
  });
});

describe("PATCH guard: validated against the EFFECTIVE state", () => {
  it("rejects flipping a simple chat to project with no folder (keeps the row unchanged)", async () => {
    const created = (await create({ title: "Flip me" })).body;
    const res = await patch(created.id, { workspaceMode: "project" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(REJECTED);
    // The row is untouched: still simple, still its own chat folder. Without
    // the guard this would read back as mode=project + a kind='chat' folder.
    const after = (await get(created.id)).body;
    expect(after.workspaceMode).toBe("simple");
    expect(after.workspaceFolderId).toBe(created.workspaceFolderId);
  });

  it("rejects flipping to project with an explicit chat-kind folder", async () => {
    const created = (await create({ title: "Flip with bad folder" })).body;
    const res = await patch(created.id, {
      workspaceMode: "project",
      workspaceFolderId: created.workspaceFolderId,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(REJECTED);
    expect((await get(created.id)).body.workspaceMode).toBe("simple");
  });

  it("accepts flipping to project with a real folder", async () => {
    const created = (await create({ title: "Flip properly" })).body;
    const folderId = await makeProjectFolder();
    const res = await patch(created.id, {
      workspaceMode: "project",
      workspaceFolderId: folderId,
    });
    expect(res.status).toBe(200);
    expect(res.body.workspaceMode).toBe("project");
    expect(res.body.workspaceFolderId).toBe(folderId);
  });

  it("rejects clearing the folder while the row stays project-scoped", async () => {
    const folderId = await makeProjectFolder();
    const project = (
      await create({ title: "P", workspaceMode: "project", workspaceFolderId: folderId })
    ).body;

    // effective mode stays "project" (not patched) and the folder becomes null.
    const res = await patch(project.id, { workspaceFolderId: null });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(REJECTED);
    expect((await get(project.id)).body.workspaceFolderId).toBe(folderId);
  });

  it("allows project → simple, and clears the folder", async () => {
    const folderId = await makeProjectFolder();
    const project = (
      await create({ title: "P2", workspaceMode: "project", workspaceFolderId: folderId })
    ).body;

    const res = await patch(project.id, { workspaceMode: "simple" });
    expect(res.status).toBe(200);
    expect(res.body.workspaceMode).toBe("simple");
    // A simple chat must not retain a folder.
    expect(res.body.workspaceFolderId).toBeNull();
  });

  it("still preserves unrelated fields when the guard rejects", async () => {
    const created = (
      await create({ title: "Keep", modelId: "m1", reasoningLevel: "low" })
    ).body;
    await patch(created.id, { workspaceMode: "project" });
    const after = (await get(created.id)).body;
    expect(after.title).toBe("Keep");
    expect(after.modelId).toBe("m1");
    expect(after.reasoningLevel).toBe("low");
  });
});

describe("the rejection is observable", () => {
  it("logs workspace.rejected with folder_not_available and the conversation id", async () => {
    const created = (await create({ title: "Observed" })).body;
    const since = logger.lastSeq;
    await patch(created.id, { workspaceMode: "project" });

    const rejected = logger
      .getRecentEntries(since)
      .filter((e) => e.event === "workspace.rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBe("folder_not_available");
    expect(rejected[0].conversationId).toBe(created.id);
  });
});
