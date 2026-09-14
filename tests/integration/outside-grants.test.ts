/**
 * Integration tests for one-shot outside-workspace authorization through the
 * real Hono app: check reports inside/canonical-outside, grant mints once for
 * outside targets and refuses inside ones, unknown conversations fail closed.
 *
 * DB isolation: tests/setup.ts redirects DATA_DIR to tmp.
 */
import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import fs from "fs";
import os from "os";
import path from "path";
import conversationsApp from "../../src/routes/conversations";
import toolsApp from "../../src/routes/tools";

const app = new Hono();
app.route("/", conversationsApp);
app.route("/", toolsApp);

const json = { "Content-Type": "application/json" };

async function seedConversation(): Promise<string> {
  const res = await app.request("/api/conversations", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ title: "Grant probe" }),
  });
  expect(res.status).toBe(200);
  const conv = (await res.json()) as { id: string };
  return conv.id;
}

describe("outside-workspace check/grant", () => {
  it("check reports inside for workspace paths with no side effects", async () => {
    const conversationId = await seedConversation();
    const res = await app.request("/api/tools/check", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ conversationId, tool: "read_file", path: "notes.txt" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { inside: boolean; resolvedTarget: string; root: string };
    expect(body.inside).toBe(true);
    expect(body.resolvedTarget).toContain("notes.txt");
    expect(body.root).toBeTruthy();
  });

  it("check reports outside with the canonical target; grant mints once", async () => {
    const conversationId = await seedConversation();
    const outsideFile = path.join(os.tmpdir(), `tbai-outside-${Date.now()}`, "x.txt");
    fs.mkdirSync(path.dirname(outsideFile), { recursive: true });
    fs.writeFileSync(outsideFile, "outside\n");

    const check = await app.request("/api/tools/check", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ conversationId, tool: "read_file", path: outsideFile }),
    });
    expect(check.status).toBe(200);
    const checked = (await check.json()) as { inside: boolean; resolvedTarget: string };
    expect(checked.inside).toBe(false);
    expect(checked.resolvedTarget).toBeTruthy();

    const grant = await app.request("/api/tools/grant", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ conversationId, tool: "read_file", path: outsideFile }),
    });
    expect(grant.status).toBe(200);
    const granted = (await grant.json()) as { ok: boolean; grantId: string; resolvedTarget: string };
    expect(granted.ok).toBe(true);
    expect(granted.grantId).toBeTruthy();
    expect(granted.resolvedTarget).toBe(checked.resolvedTarget);
  });

  it("grant refuses inside targets (no grant needed)", async () => {
    const conversationId = await seedConversation();
    const res = await app.request("/api/tools/grant", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ conversationId, tool: "read_file", path: "notes.txt" }),
    });
    expect(res.status).toBe(400);
  });

  it("unknown conversations fail closed on both endpoints", async () => {
    for (const route of ["/api/tools/check", "/api/tools/grant"]) {
      const res = await app.request(route, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ conversationId: "does-not-exist", tool: "read_file", path: "x.txt" }),
      });
      expect(res.status).toBe(400);
    }
  });

  it("rejects invalid bodies", async () => {
    const res = await app.request("/api/tools/grant", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ conversationId: "x" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("one-shot granted execution", () => {
  it("executes an outside read exactly once and persists nothing", async () => {
    const conversationId = await seedConversation();
    const outsideDir = path.join(os.tmpdir(), `tbai-granted-${Date.now()}`);
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, "secret.txt"), "granted-content\n");

    const { grantCounts } = await import("../../src/services/grants");
    const before = grantCounts().live;

    const run = await app.request("/api/tools/run-granted", {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        conversationId,
        tool: "list_dir",
        args: { path: outsideDir },
      }),
    });
    expect(run.status).toBe(200);
    const body = (await run.json()) as { ok: boolean; grantId: string; output: { entries: Array<{ name: string }> } };
    expect(body.ok).toBe(true);
    expect(body.grantId).toBeTruthy();
    expect(body.output.entries.map((e) => e.name)).toContain("secret.txt");

    // Nothing live survives: the grant is minted-and-spent atomically, so the
    // live count is unchanged by this request (other tests may hold grants).
    expect(grantCounts().live).toBe(before);
  });

  it("refuses inside targets, destructive tools, and unknown conversations", async () => {
    const conversationId = await seedConversation();
    const inside = await app.request("/api/tools/run-granted", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ conversationId, tool: "read_file", args: { path: "notes.txt" } }),
    });
    expect(inside.status).toBe(400);

    const destructive = await app.request("/api/tools/run-granted", {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        conversationId,
        tool: "write_file",
        args: { path: "/tmp/x.txt", content: "x" },
      }),
    });
    expect(destructive.status).toBe(400);

    const unknown = await app.request("/api/tools/run-granted", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ conversationId: "does-not-exist", tool: "list_dir", args: { path: "/tmp" } }),
    });
    expect(unknown.status).toBe(400);
  });

  it("outside execution failure surfaces as error, never as approval", async () => {
    const conversationId = await seedConversation();
    const { grantCounts } = await import("../../src/services/grants");
    const before = grantCounts().live;
    // list_dir on a missing outside dir: grant minted, execution throws,
    // grant revoked — error text preserved for the Failed card.
    const res = await app.request("/api/tools/run-granted", {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        conversationId,
        tool: "read_file",
        args: { path: path.join(os.tmpdir(), `tbai-missing-${Date.now()}`, "nope.txt") },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
    expect(grantCounts().live).toBe(before);
  });
});
