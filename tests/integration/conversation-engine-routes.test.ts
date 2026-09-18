/**
 * Conversation route pass-through for the dual-chat fields (`engine`,
 * `opencodeAgent`, `opencodeModel`) — end-to-end through the real Hono app:
 * POST /api/conversations accepts the fields and persists them; PATCH
 * /api/conversations/:id updates them; GET returns them on the response.
 *
 * DB isolation: tests/setup.ts (bunfig preload) redirects DATA_DIR to tmp.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { db } from "../../src/db";
import { registry } from "../../src/config/providers";
import { conversationService } from "../../src/services/storage";
import conversationsApp from "../../src/routes/conversations";

const app = new Hono();
app.route("/", conversationsApp);

async function appFetch(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; json: () => Promise<any> }> {
  const res = await app.request(path, init);
  return { status: res.status, json: () => res.json() };
}

async function seedActiveProvider(model: string, thinking: string | null) {
  const id = "prov-engine-route";
  db.run(
    `INSERT OR REPLACE INTO provider_configs
       (id, name, type, encrypted_api_key, credential_version, endpoint, model, models, thinking, is_active, created_at, updated_at)
     VALUES (?, ?, 'ollama', NULL, NULL, NULL, ?, '[]', ?, 1, ?, ?)`,
    [id, "engine-route", model, thinking, Date.now(), Date.now()],
  );
  await registry.loadFromDb(db);
  return id;
}

describe("conversation routes — engine / opencodeAgent / opencodeModel pass-through", () => {
  // This file seeds an active provider through the GLOBAL registry singleton
  // (shared by every test file in the process). Save nothing but the DB truth
  // and restore it afterwards: delete the seeded row, then rebuild the
  // registry from the database so later files see exactly what they would
  // have seen had this file never run. (Suite files run sequentially in one
  // process; without this, credentials/todo suites observe our active
  // provider and fail on UNIQUE/active-provider assumptions.)
  beforeAll(async () => {
    db.run("DELETE FROM provider_configs WHERE id = 'prov-engine-route'");
  });
  afterAll(async () => {
    db.run("DELETE FROM provider_configs WHERE id = 'prov-engine-route'");
    await registry.loadFromDb(db);
  });

  beforeEach(async () => {
    await seedActiveProvider("route-model", "medium");
  });

  it("POST /api/conversations persists engine + opencodeAgent + opencodeModel", async () => {
    const { status, json } = await appFetch("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "engine via POST",
        engine: "opencode",
        opencodeAgent: "coder",
        opencodeModel: "openai/gpt-4o",
      }),
    });
    expect(status).toBe(200);
    const conv = await json();
    expect(conv.engine).toBe("opencode");
    expect(conv.opencodeAgent).toBe("coder");
    expect(conv.opencodeModel).toBe("openai/gpt-4o");

    // Prove it reached SQLite, not just the response shape.
    const reloaded = await conversationService.get(conv.id);
    expect(reloaded?.engine).toBe("opencode");
    expect(reloaded?.opencodeAgent).toBe("coder");
    expect(reloaded?.opencodeModel).toBe("openai/gpt-4o");

    await conversationService.delete(conv.id);
  });

  it("POST /api/conversations without the fields defaults engine to 'direct' (edge case)", async () => {
    const { status, json } = await appFetch("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "default engine" }),
    });
    expect(status).toBe(200);
    const conv = await json();
    expect(conv.engine).toBe("direct");
    expect(conv.opencodeAgent).toBeNull();
    expect(conv.opencodeModel).toBeNull();

    await conversationService.delete(conv.id);
  });

  it("PATCH /api/conversations/:id updates engine + opencodeAgent + opencodeModel", async () => {
    const created = await conversationService.create({
      title: "patch target",
      providerId: "prov-engine-route",
      modelId: null,
      reasoningLevel: null,
      systemPrompt: null,
    });

    const { status, json } = await appFetch(`/api/conversations/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        engine: "opencode",
        opencodeAgent: "planner",
        opencodeModel: "anthropic/claude-sonnet-4",
      }),
    });
    expect(status).toBe(200);
    const updated = await json();
    expect(updated.engine).toBe("opencode");
    expect(updated.opencodeAgent).toBe("planner");
    expect(updated.opencodeModel).toBe("anthropic/claude-sonnet-4");

    const reloaded = await conversationService.get(created.id);
    expect(reloaded?.engine).toBe("opencode");
    expect(reloaded?.opencodeAgent).toBe("planner");

    await conversationService.delete(created.id);
  });

  it("PATCH rejects an invalid engine enum value with 400 (edge case)", async () => {
    const created = await conversationService.create({
      title: "bad enum probe",
      providerId: "prov-engine-route",
      modelId: null,
      reasoningLevel: null,
      systemPrompt: null,
    });

    const { status } = await appFetch(`/api/conversations/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ engine: "not-an-engine" }),
    });
    expect(status).toBe(400);

    // The rejected write must not have touched the row.
    expect((await conversationService.get(created.id))?.engine).toBe("direct");
    await conversationService.delete(created.id);
  });

  it("PATCH with null opencodeAgent/opencodeModel clears them while keeping engine", async () => {
    const created = await conversationService.create({
      title: "clear probe",
      providerId: "prov-engine-route",
      modelId: null,
      reasoningLevel: null,
      systemPrompt: null,
      engine: "opencode",
      opencodeAgent: "coder",
      opencodeModel: "openai/gpt-4o",
    });

    const { status, json } = await appFetch(`/api/conversations/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ opencodeAgent: null, opencodeModel: null }),
    });
    expect(status).toBe(200);
    const updated = await json();
    expect(updated.opencodeAgent).toBeNull();
    expect(updated.opencodeModel).toBeNull();
    expect(updated.engine).toBe("opencode");

    await conversationService.delete(created.id);
  });

  it("GET /api/conversations/:id returns the persisted fields", async () => {
    const created = await conversationService.create({
      title: "get probe",
      providerId: "prov-engine-route",
      modelId: null,
      reasoningLevel: null,
      systemPrompt: null,
      engine: "opencode",
      opencodeAgent: "coder",
      opencodeModel: "openai/gpt-4o",
    });

    const { status, json } = await appFetch(`/api/conversations/${created.id}`);
    expect(status).toBe(200);
    const fetched = await json();
    expect(fetched.engine).toBe("opencode");
    expect(fetched.opencodeAgent).toBe("coder");
    expect(fetched.opencodeModel).toBe("openai/gpt-4o");

    await conversationService.delete(created.id);
  });
});
