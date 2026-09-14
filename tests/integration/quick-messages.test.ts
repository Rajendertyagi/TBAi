/**
 * Quick Messages REST round-trip through the real Hono app.
 *
 * DB isolation: tests/setup.ts (bunfig preload) redirects DATA_DIR to tmp.
 */
import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { quickMessageService } from "../../src/services/quick-messages";
import quickMessagesApp from "../../src/routes/quick-messages";

const app = new Hono();
app.route("/", quickMessagesApp);

async function appFetch(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; json: () => Promise<any> }> {
  const res = await app.request(path, init);
  return { status: res.status, json: () => res.json() };
}

const json = { "Content-Type": "application/json" };

describe("quick messages REST", () => {
  it("full CRUD round-trip", async () => {
    const created = await appFetch("/api/quick-messages", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ title: "Greet", content: "Hello!" }),
    });
    expect(created.status).toBe(200);
    const c1 = await created.json();
    expect(c1.id).toBeTruthy();

    const listed = await (await appFetch("/api/quick-messages")).json();
    expect(listed.map((m: { id: string }) => m.id)).toContain(c1.id);

    const patched = await appFetch(`/api/quick-messages/${c1.id}`, {
      method: "PATCH",
      headers: json,
      body: JSON.stringify({ content: "Hi!" }),
    });
    expect(patched.status).toBe(200);
    expect((await patched.json()).content).toBe("Hi!");

    const reordered = await appFetch("/api/quick-messages/reorder", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ ids: [c1.id] }),
    });
    expect(reordered.status).toBe(200);

    const deleted = await appFetch(`/api/quick-messages/${c1.id}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);
    const listedAfter = await (await appFetch("/api/quick-messages")).json();
    expect(listedAfter.map((m: { id: string }) => m.id)).not.toContain(c1.id);
  });

  it("returns 404 for unknown ids", async () => {
    const patched = await appFetch("/api/quick-messages/ghost", {
      method: "PATCH",
      headers: json,
      body: JSON.stringify({ title: "x" }),
    });
    expect(patched.status).toBe(404);
    const deleted = await appFetch("/api/quick-messages/ghost", {
      method: "DELETE",
    });
    expect(deleted.status).toBe(404);
  });

  it("rejects oversized payloads", async () => {
    const res = await appFetch("/api/quick-messages", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ title: "x".repeat(201) }),
    });
    expect(res.status).toBe(400);
  });

  it("cleanup leaves an empty table", async () => {
    for (const m of await quickMessageService.list()) {
      await quickMessageService.remove(m.id);
    }
    await expect(quickMessageService.list()).resolves.toEqual([]);
  });
});
