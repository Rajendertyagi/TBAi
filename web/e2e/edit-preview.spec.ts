import { test, expect, type APIRequestContext } from "@playwright/test";
import { toolsConfig } from "../src/config/tools";

/**
 * The Direct-chat edit-preview endpoint answers for a real file.
 *
 * The component that renders the answer is covered by unit tests with a stubbed
 * fetch; what only a running server can prove is that the endpoint produces a
 * usable patch for a file on disk, and that it refuses the same paths the edit
 * itself refuses. Both are asserted here against the real route.
 *
 * The live approval GATE is deliberately not driven from here: Direct chat's
 * gate is produced by the AI SDK's approval flow during a real model turn, so
 * opening one from a seeded message is not possible. That gap is recorded rather
 * than papered over.
 */

const BODY = [
  "const alpha = 1;",
  "const beta = 2;",
  "const target = 3;",
  "const gamma = 4;",
  "",
].join("\n");

let conversationId: string;
let created = false;

async function createConversation(request: import("@playwright/test").APIRequestContext) {
  const response = await request.post("/api/conversations", {
    data: { title: `edit preview ${Date.now()}`, workspaceMode: "simple", engine: "direct" },
  });
  const body = (await response.json()) as { id: string };
  conversationId = body.id;
  created = true;
  return conversationId;
}

test.beforeEach(async ({ request }) => {
  await createConversation(request);
  const write = await request.post("/api/tools/write", {
    data: { path: "preview-target.ts", content: BODY },
  });
  expect(write.ok(), `seeding the file must succeed: ${write.status()}`).toBe(true);
});

test.afterEach(async ({ request }) => {
  if (!created) return;
  await request.delete(`/api/conversations/${conversationId}`).catch(() => undefined);
});

test("the endpoint returns a patch describing the change", async ({ request }) => {
  const response = await request.post("/api/tools/edit-preview", {
    data: { path: "preview-target.ts", oldText: "const target = 3;", newText: "const target = 99;" },
  });
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { patch: string; occurrences: number };

  expect(body.occurrences).toBe(1);
  expect(body.patch).toContain("-const target = 3;");
  expect(body.patch).toContain("+const target = 99;");
  // The context either side — the part the find/replace pair cannot show, and
  // the reason this endpoint exists.
  expect(body.patch).toContain(" const beta = 2;");
  expect(body.patch).toContain(" const gamma = 4;");
  expect(body.patch).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/m);
});

test("the endpoint wrote nothing", async ({ request }) => {
  await request.post("/api/tools/edit-preview", {
    data: { path: "preview-target.ts", oldText: "const target = 3;", newText: "const target = 99;" },
  });
  const read = await request.post("/api/tools/read", {
    data: { path: "preview-target.ts" },
  });
  const body = (await read.json()) as { content?: string };
  expect(body.content).toContain("const target = 3;");
  expect(body.content).not.toContain("const target = 99;");
});

test("the endpoint refuses what the edit refuses", async ({ request }) => {
  const missingText = await request.post("/api/tools/edit-preview", {
    data: { path: "preview-target.ts", oldText: "not in the file", newText: "x" },
  });
  expect(missingText.status()).toBeGreaterThanOrEqual(400);

  const outside = await request.post("/api/tools/edit-preview", {
    data: { path: "../escape.ts", oldText: "a", newText: "b" },
  });
  expect(outside.status()).toBeGreaterThanOrEqual(400);

  const absent = await request.post("/api/tools/edit-preview", {
    data: { path: "no-such-file.ts", oldText: "a", newText: "b" },
  });
  expect(absent.status()).toBeGreaterThanOrEqual(400);
});

test("the endpoint validates its arguments like every other tool route", async ({
  request,
}) => {
  const bad = await request.post("/api/tools/edit-preview", {
    data: { path: "", oldText: "a", newText: "b" },
  });
  expect(bad.status()).toBe(400);
  const body = (await bad.json()) as { error?: string };
  expect(body.error).toContain("Invalid tool arguments");
});

test("a repeated match is counted, so the card can say so", async ({ request }) => {
  await request.post("/api/tools/write", {
    data: { path: "repeated.ts", content: "a\ndup\nb\ndup\nc\n" },
  });
  const response = await request.post("/api/tools/edit-preview", {
    data: { path: "repeated.ts", oldText: "dup", newText: "DUP" },
  });
  const body = (await response.json()) as { occurrences: number; patch: string };
  expect(body.occurrences).toBe(2);
  // One hunk, not two: later matches sit at line numbers that are only correct
  // after the earlier edits land, so the preview shows the first and counts.
  expect(body.patch.match(/^@@ /gm)?.length).toBe(1);
  expect(toolsConfig.limits.toolArgEditPreviewMaxChars).toBeGreaterThan(0);
});
