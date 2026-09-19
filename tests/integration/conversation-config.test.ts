/**
 * Per-conversation AI config persistence — end-to-end through the real Hono
 * app + the chat model-resolution seam.
 *
 * Covers the Phase 2 resolution contract the docs describe:
 *   POST /api/conversations  → absent stays NULL (no baked defaults)
 *   PATCH /api/conversations/:id → persists providerId/modelId/reasoningLevel;
 *     omitted = preserved, explicit null = cleared
 *   resolveChatModel (the seam) → request provider wins outright (row model
 *   is NOT re-paired); conversation default → active provider default.
 *
 * DB isolation: tests/setup.ts (bunfig preload) redirects DATA_DIR to tmp, so
 * the developer database is never touched.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { db } from "../../src/db";
import { registry } from "../../src/config/providers";
import { conversationService } from "../../src/services/storage";
import conversationsApp from "../../src/routes/conversations";
import { resolveChatModel } from "../../src/routes/chat-model";

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
  const id = `prov-int-${model}`;
  db.run(
    `INSERT OR REPLACE INTO provider_configs
       (id, name, type, encrypted_api_key, credential_version, endpoint, model, models, thinking, is_active, created_at, updated_at)
     VALUES (?, ?, 'ollama', NULL, NULL, NULL, ?, '[]', ?, 1, ?, ?)`,
    [id, `int-${id}`, model, thinking, Date.now(), Date.now()],
  );
  await registry.loadFromDb(db);
  return id;
}

describe("per-conversation config — real Hono app", () => {
  beforeEach(async () => {
    // Start each test with a single deterministic active provider.
    await seedActiveProvider("conv-model", "medium");
  });

  it("POST /api/conversations leaves modelId + reasoningLevel NULL when no explicit selection", async () => {
    const { status, json } = await appFetch("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "created chat" }),
    });
    expect(status).toBe(200);
    const conv = await json();
    expect(conv.id).toBeTruthy();
    // Phase 2 contract (mirror P2-07): absent stays NULL — no baked
    // active-provider defaults. Resolution falls back at request time.
    expect(conv.providerId).toBeNull();
    expect(conv.modelId).toBeNull();
    expect(conv.reasoningLevel).toBeNull();

    const reloaded = await conversationService.get(conv.id);
    expect(reloaded?.providerId).toBeNull();
    expect(reloaded?.modelId).toBeNull();
    expect(reloaded?.reasoningLevel).toBeNull();

    await conversationService.delete(conv.id);
  });

  it("PATCH /api/conversations/:id persists providerId + modelId + reasoningLevel", async () => {
    const created = await conversationService.create({
      title: "patch target",
      providerId: "x",
      modelId: null,
      reasoningLevel: null,
      systemPrompt: null,
    });

    const { status, json } = await appFetch(`/api/conversations/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "prov-int-conv-model",
        modelId: "new-model",
        reasoningLevel: "high",
      }),
    });
    expect(status).toBe(200);
    const updated = await json();
    expect(updated.providerId).toBe("prov-int-conv-model");
    expect(updated.modelId).toBe("new-model");
    expect(updated.reasoningLevel).toBe("high");

    // Confirm it actually persisted (re-read from SQLite, not just the response).
    const reloaded = await conversationService.get(created.id);
    expect(reloaded?.modelId).toBe("new-model");
    expect(reloaded?.reasoningLevel).toBe("high");
    expect(reloaded?.providerId).toBe("prov-int-conv-model");

    await conversationService.delete(created.id);
  });

  it("PATCH explicit null modelId/reasoningLevel clears to NULL", async () => {
    const created = await conversationService.create({
      title: "null patch",
      providerId: "p",
      modelId: "keep-me",
      reasoningLevel: "keep-reasoning",
      systemPrompt: null,
    });

    // Phase 2 contract (mirror P2-03): explicit null clears the field to
    // NULL. Only omitted (undefined) fields preserve existing values.
    const { status, json } = await appFetch(`/api/conversations/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: null,
        modelId: null,
        reasoningLevel: null,
      }),
    });
    expect(status).toBe(200);
    const updated = await json();
    expect(updated.providerId).toBeNull();
    expect(updated.modelId).toBeNull();
    expect(updated.reasoningLevel).toBeNull();

    const reloaded = await conversationService.get(created.id);
    expect(reloaded?.providerId).toBeNull();
    expect(reloaded?.modelId).toBeNull();
    expect(reloaded?.reasoningLevel).toBeNull();

    await conversationService.delete(created.id);
  });
});

describe("per-conversation config — chat route fallback (resolveChatModel seam)", () => {
  it("a request-level provider wins outright without carrying the row model across", async () => {
    // Phase 2 contract (mirror P2-13/P2-12a): a request-level provider wins
    // outright against its own defaults — the conversation's modelId is NOT
    // re-paired onto the request provider, and the row is left untouched.
    await seedActiveProvider("conv-model", "medium");
    db.run(
      `INSERT OR REPLACE INTO provider_configs
         (id, name, type, encrypted_api_key, credential_version, endpoint, model, models, thinking, is_active, created_at, updated_at)
       VALUES (?, ?, 'ollama', NULL, NULL, NULL, ?, '[]', ?, 0, ?, ?)`,
      ["prov-int-second", "int-second", "second-model", "low", Date.now(), Date.now()],
    );
    await registry.loadFromDb(db);
    const conv = await conversationService.create({
      title: "fallback chat",
      providerId: "prov-int-conv-model",
      modelId: "persisted-conv-model",
      reasoningLevel: "high",
      systemPrompt: null,
    });

    // Request names a different provider and omits model/reasoning: resolves
    // against the request provider's own defaults, not the row's model.
    const resolved = await resolveChatModel({
      providerId: "prov-int-second",
      model: undefined,
      reasoningLevel: undefined,
      threadId: conv.id,
    });
    expect(resolved?.provider.id).toBe("prov-int-second");
    expect(resolved?.model).toBe("second-model");
    expect(resolved?.reasoning).toBe("low");

    // The persisted row is untouched by the one-shot use.
    const row = await conversationService.get(conv.id);
    expect(row?.providerId).toBe("prov-int-conv-model");
    expect(row?.modelId).toBe("persisted-conv-model");
    expect(row?.reasoningLevel).toBe("high");

    await conversationService.delete(conv.id);
    db.run("DELETE FROM provider_configs WHERE id = ?", ["prov-int-second"]);
    await registry.loadFromDb(db);
  });

  it("an explicit request model/reasoningLevel wins over the conversation default", async () => {
    await seedActiveProvider("conv-model", "medium");
    const conv = await conversationService.create({
      title: "override chat",
      providerId: "prov-int-conv-model",
      modelId: "persisted-conv-model",
      reasoningLevel: "high",
      systemPrompt: null,
    });

    // One-shot overrides (from the client's picker) take precedence.
    const resolved = await resolveChatModel({
      providerId: conv.providerId ?? undefined,
      model: "oneshot-model",
      reasoningLevel: "low",
      threadId: conv.id,
    });
    expect(resolved?.model).toBe("oneshot-model");
    expect(resolved?.reasoning).toBe("low");

    await conversationService.delete(conv.id);
  });

  it("no conversation + no request fields falls back to the active provider default", async () => {
    await seedActiveProvider("conv-model", "medium");
    const resolved = await resolveChatModel({
      providerId: undefined,
      model: undefined,
      reasoningLevel: undefined,
      threadId: undefined,
    });
    expect(resolved?.model).toBe("conv-model");
    expect(resolved?.reasoning).toBe("medium");
  });
});

describe("conversation status lifecycle (regular/archived)", () => {
  it("POST creates regular conversations", async () => {
    const { status, json } = await appFetch("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "status probe" }),
    });
    expect(status).toBe(200);
    const conv = await json();
    expect(conv.status).toBe("regular");
    await conversationService.delete(conv.id);
  });

  it("archive/unarchive round-trips through PATCH and persists", async () => {
    const created = await conversationService.create({
      title: "archive probe",
      providerId: "x",
      modelId: null,
      reasoningLevel: null,
      systemPrompt: null,
    });
    expect((await conversationService.get(created.id))?.status).toBe("regular");

    const archived = await appFetch(`/api/conversations/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "archived" }),
    });
    expect(archived.status).toBe(200);
    expect((await archived.json()).status).toBe("archived");
    expect((await conversationService.get(created.id))?.status).toBe("archived");

    const unarchived = await appFetch(`/api/conversations/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "regular" }),
    });
    expect(unarchived.status).toBe(200);
    expect((await unarchived.json()).status).toBe("regular");

    await conversationService.delete(created.id);
  });

  it("rejects the obsolete 4-state statuses", async () => {
    const created = await conversationService.create({
      title: "reject probe",
      providerId: "x",
      modelId: null,
      reasoningLevel: null,
      systemPrompt: null,
    });
    for (const status of ["in_progress", "pending_review", "completed", "cancelled"]) {
      const res = await appFetch(`/api/conversations/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      expect(res.status).toBe(400);
    }
    // Untouched by the rejected writes.
    expect((await conversationService.get(created.id))?.status).toBe("regular");
    await conversationService.delete(created.id);
  });

  it("narrows ?status= filtering to regular/archived", async () => {
    const list = await appFetch("/api/conversations?status=archived&limit=5");
    expect(list.status).toBe(200);
    const data = await list.json();
    for (const t of data.threads as Array<{ status: string }>) {
      expect(t.status).toBe("archived");
    }
    const unknown = await appFetch("/api/conversations?status=completed&limit=5");
    expect(unknown.status).toBe(200);
  });
});
