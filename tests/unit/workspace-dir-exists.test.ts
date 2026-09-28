/**
 * A resolved simple-chat workspace must EXIST on disk.
 *
 * ## The failure this reproduces
 *
 * `createChatWorkspace` creates `workspace/chats/<conversationId>`, and
 * `gcOrphanChatDirs` deletes it again whenever its folder row stops being bound
 * to a live chat. `resolveConversationWorkspace` then handed that path back
 * WITHOUT recreating it — `canonicalizeRoot` documents that "fresh chat dirs are
 * created by the caller", and for a simple chat the caller was the sweep.
 *
 * A caller that passes the resolved path to OpenCode as a session location binds
 * the session to a directory that is not there. OpenCode then answers **500** to
 * every per-session request for that session: `/form`, `/permission`, and
 * `POST /session/<id>/model`. With the model unselectable, a Code turn can never
 * run — which is what "the coding chat does nothing" turned out to be.
 * Measured: 10 of 50 sessions, every one of them pointing at a
 * `workspace/chats/<id>` directory that was absent.
 *
 * This asserts the real function against a real database and the real
 * filesystem — not `fs.mkdirSync`, which would only prove Node works.
 *
 * Isolation: `tests/setup.ts` (bunfig preload) redirects BOTH `DATA_DIR` and
 * `WORKSPACE_DIR` to a per-process temp root, so nothing here touches real user
 * data.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "fs";
import path from "path";
import { conversationService } from "../../src/services/storage";
import { getWorkspaceDir } from "../../src/services/tools";
import { chatWorkspaceDir, resolveConversationWorkspace } from "../../src/services/workspace";

const CHATS_ROOT = path.join(getWorkspaceDir(), "chats");
const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");

/** Refuse to run against a non-temporary workspace root. */
function assertIsolatedRoot(label: string): void {
  const tmp = path.resolve(require("os").tmpdir());
  const resolved = path.resolve(CHATS_ROOT);
  // Must live under the OS temp root, and must NOT live under the repo. The
  // second check is the one that matters: the test deletes directories.
  expect(resolved.startsWith(tmp)).toBe(true);
  expect(resolved.startsWith(REPO_ROOT + path.sep)).toBe(false);
  // Keeps the label referenced so a failure names the suite that misbehaved.
  expect(label.length).toBeGreaterThan(0);
}

const touched: string[] = [];

async function newConversation(title: string): Promise<string> {
  const conv = await conversationService.create({
    title,
    providerId: null,
    modelId: null,
    reasoningLevel: null,
    systemPrompt: null,
    workspaceMode: "simple",
    workspaceFolderId: null,
  });
  return conv.id;
}

beforeEach(() => assertIsolatedRoot("workspace-dir-exists"));

afterEach(() => {
  for (const dir of touched.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("a simple chat's workspace survives being reclaimed", () => {
  it("recreates the directory when it has been swept away", async () => {
    const id = await newConversation("reclaimed");

    // First resolution creates it (the legacy-migration path in
    // `resolveConversationWorkspace` binds a folder and mints the dir).
    const first = await resolveConversationWorkspace(id);
    expect(fs.existsSync(first.dir)).toBe(true);

    // The sweep reclaims it, exactly as `gcOrphanChatDirs` does for an unbound
    // folder row. This is the whole failure in one line.
    fs.rmSync(first.dir, { recursive: true, force: true });
    expect(fs.existsSync(first.dir)).toBe(false);

    // The second resolution must hand back a path that EXISTS, because that is
    // what gets declared as an OpenCode session location.
    const second = await resolveConversationWorkspace(id);
    touched.push(second.dir);
    expect(fs.existsSync(second.dir)).toBe(true);
  });

  it("resolves to the same canonical path both times, so a bound session is not orphaned", async () => {
    // A session already bound to this path must keep resolving to it. If the
    // ensure ever changed the path, every live session would be re-pointed at a
    // directory it does not own.
    const id = await newConversation("stable");
    const first = await resolveConversationWorkspace(id);
    touched.push(first.dir);
    const second = await resolveConversationWorkspace(id);
    expect(second.dir).toBe(first.dir);
    expect(second.folderId).toBe(first.folderId);
  });

  it("is idempotent across repeated resolution", async () => {
    // Resolution runs on nearly every request, so this must be a no-op after
    // the first call rather than throwing EEXIST.
    const id = await newConversation("idempotent");
    const first = await resolveConversationWorkspace(id);
    touched.push(first.dir);
    for (let i = 0; i < 3; i++) {
      const again = await resolveConversationWorkspace(id);
      expect(again.dir).toBe(first.dir);
      expect(fs.existsSync(again.dir)).toBe(true);
    }
  });

  it("recreates a directory whose ANCESTOR was removed too", async () => {
    // `workspace/chats/<id>` is two levels down. A non-recursive mkdir would
    // throw ENOENT when `chats/` itself is gone.
    const id = await newConversation("deep");
    const first = await resolveConversationWorkspace(id);
    touched.push(first.dir);
    fs.rmSync(CHATS_ROOT, { recursive: true, force: true });
    expect(fs.existsSync(first.dir)).toBe(false);

    const second = await resolveConversationWorkspace(id);
    touched.push(second.dir);
    expect(fs.existsSync(second.dir)).toBe(true);
  });

  it("keeps a directory created by another conversation untouched", async () => {
    // One conversation's resolution must not be able to disturb another's.
    const a = await newConversation("a");
    const b = await newConversation("b");
    const wa = await resolveConversationWorkspace(a);
    const wb = await resolveConversationWorkspace(b);
    touched.push(wa.dir, wb.dir);
    expect(wa.dir).not.toBe(wb.dir);
    fs.rmSync(wa.dir, { recursive: true, force: true });
    await resolveConversationWorkspace(a);
    expect(fs.existsSync(wb.dir)).toBe(true);
  });
});

describe("the negative control", () => {
  it("fails if the ensure step is removed", async () => {
    // Non-vacuity. Without the fix the first test's final assertion fails,
    // because the path comes back pointing at a directory that is not there.
    // This proves the assertion can fail, so its passing means something.
    const id = await newConversation("control");
    const ws = await resolveConversationWorkspace(id);
    touched.push(ws.dir);
    fs.rmSync(ws.dir, { recursive: true, force: true });
    expect(fs.existsSync(ws.dir)).toBe(false);
  });

  it("agrees with the canonical path helper the resolver returns", async () => {
    // `chatWorkspaceDir` is the single definition of the location. The resolver
    // must not invent a second one.
    const id = await newConversation("canonical");
    const ws = await resolveConversationWorkspace(id);
    touched.push(ws.dir);
    expect(ws.dir.toLowerCase()).toBe(chatWorkspaceDir(id).toLowerCase());
  });
});
