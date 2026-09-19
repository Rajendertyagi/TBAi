/**
 * Phase 2 "conversation config persistence contract" — deterministic tests over
 * the real boundaries (route → validation → persistence → readback → resolution).
 *
 * Contract under test:
 *   - PATCH: omitted = preserved, explicit value = set, explicit null = cleared.
 *   - POST: explicit values persisted as-given; absent stays NULL (no baked
 *     active-provider defaults — resolution falls back at request time).
 *   - resolveChatModel: one-shot request → row → active; explicitly named
 *     unknown providers throw UnknownProviderError (never substitute active);
 *     a request-level provider wins outright (row modelId is NOT re-paired);
 *     ""/whitespace counts as absent; active fallback only with no explicit
 *     config anywhere (null when nothing is configured at all).
 *
 * DB isolation: tests/setup.ts (bunfig preload) redirects DATA_DIR to tmp.
 * Registry hygiene: this file seeds its own `p2-*` providers and removes them
 * in afterAll, then rebuilds the registry from the DB (same pattern as
 * conversation-engine-routes.test.ts) so later suites see a clean slate.
 */
import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { Hono } from "hono";
import { db } from "../../src/db";
import { registry } from "../../src/config/providers";
import { conversationService } from "../../src/services/storage";
import conversationsApp from "../../src/routes/conversations";
import chatApp from "../../src/routes/chat";
import {
  resolveChatModel,
  UnknownProviderError,
} from "../../src/routes/chat-model";
import { conversationUpdateSchema } from "../../src/lib/validation";

const app = new Hono();
app.route("/", conversationsApp);

const chatRoute = new Hono();
chatRoute.route("/", chatApp);

async function appFetch(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; json: () => Promise<any> }> {
  const res = await app.request(path, init);
  return { status: res.status, json: () => res.json() };
}

const ACTIVE_ID = "p2-active";
const SECOND_ID = "p2-second";
const SHARED_A = "p2-shared-a";
const SHARED_B = "p2-shared-b";
const OWN_IDS = [ACTIVE_ID, SECOND_ID, SHARED_A, SHARED_B];

function seedRow(
  id: string,
  model: string,
  thinking: string | null,
  active: boolean,
) {
  db.run(
    `INSERT OR REPLACE INTO provider_configs
       (id, name, type, encrypted_api_key, credential_version, endpoint, model, models, thinking, is_active, created_at, updated_at)
     VALUES (?, ?, 'ollama', NULL, NULL, NULL, ?, '[]', ?, ?, ?, ?)`,
    [id, `p2-${id}`, model, thinking, active ? 1 : 0, Date.now(), Date.now()],
  );
}

async function seedPhase2Providers() {
  seedRow(ACTIVE_ID, "p2-active-model", "low", true);
  seedRow(SECOND_ID, "p2-second-model", "high", false);
  // Same model id registered under two providers (never-substitute probe).
  seedRow(SHARED_A, "shared-model", "off", false);
  seedRow(SHARED_B, "shared-model", "high", false);
  await registry.loadFromDb(db);
}

describe("phase 2 — PATCH persistence contract (real Hono app)", () => {
  beforeEach(async () => {
    await seedPhase2Providers();
  });

  it("[P2-01] bound conversation: explicit provider/model PATCH persists both", async () => {
    const created = await conversationService.create({
      title: "p2-01",
      providerId: null,
      modelId: null,
      reasoningLevel: null,
      systemPrompt: null,
    });
    const { status, json } = await appFetch(`/api/conversations/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: ACTIVE_ID, modelId: "exact-model" }),
    });
    expect(status).toBe(200);
    const updated = await json();
    expect(updated.providerId).toBe(ACTIVE_ID);
    expect(updated.modelId).toBe("exact-model");

    const reloaded = await conversationService.get(created.id);
    expect(reloaded?.providerId).toBe(ACTIVE_ID);
    expect(reloaded?.modelId).toBe("exact-model");

    await conversationService.delete(created.id);
  });

  it("[P2-02] explicit reasoningLevel PATCH persists", async () => {
    const created = await conversationService.create({
      title: "p2-02",
      providerId: ACTIVE_ID,
      modelId: "m",
      reasoningLevel: null,
      systemPrompt: null,
    });
    const { status, json } = await appFetch(`/api/conversations/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reasoningLevel: "high" }),
    });
    expect(status).toBe(200);
    expect((await json()).reasoningLevel).toBe("high");
    expect((await conversationService.get(created.id))?.reasoningLevel).toBe(
      "high",
    );

    await conversationService.delete(created.id);
  });

  it("[P2-03] explicit null clears previously persisted provider/model/reasoning", async () => {
    const created = await conversationService.create({
      title: "p2-03",
      providerId: ACTIVE_ID,
      modelId: "keep-model",
      reasoningLevel: "high",
      systemPrompt: null,
    });
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

  it("[P2-04] omitted PATCH fields preserve existing values", async () => {
    const created = await conversationService.create({
      title: "p2-04",
      providerId: ACTIVE_ID,
      modelId: "keep-model",
      reasoningLevel: "medium",
      systemPrompt: null,
    });
    const { status, json } = await appFetch(`/api/conversations/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "renamed only" }),
    });
    expect(status).toBe(200);
    const updated = await json();
    expect(updated.title).toBe("renamed only");
    expect(updated.providerId).toBe(ACTIVE_ID);
    expect(updated.modelId).toBe("keep-model");
    expect(updated.reasoningLevel).toBe("medium");

    await conversationService.delete(created.id);
  });

  it("[P2-04b] update schema: explicit null parses to null, omitted stays undefined", async () => {
    const parsed = conversationUpdateSchema.parse({
      providerId: null,
      modelId: null,
      reasoningLevel: null,
    });
    expect(parsed.providerId).toBeNull();
    expect(parsed.modelId).toBeNull();
    expect(parsed.reasoningLevel).toBeNull();

    const omitted = conversationUpdateSchema.parse({ title: "t" });
    expect(omitted.providerId).toBeUndefined();
    expect(omitted.modelId).toBeUndefined();
    expect(omitted.reasoningLevel).toBeUndefined();
  });
});

describe("phase 2 — POST materialization contract (real Hono app)", () => {
  beforeEach(async () => {
    await seedPhase2Providers();
  });

  it("[P2-06] draft materialization carries explicit provider/model/reasoning into the row", async () => {
    const { status, json } = await appFetch("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "draft explicit",
        providerId: ACTIVE_ID,
        modelId: "draft-model",
        reasoningLevel: "high",
      }),
    });
    expect(status).toBe(200);
    const conv = await json();
    expect(conv.providerId).toBe(ACTIVE_ID);
    expect(conv.modelId).toBe("draft-model");
    expect(conv.reasoningLevel).toBe("high");

    const reloaded = await conversationService.get(conv.id);
    expect(reloaded?.providerId).toBe(ACTIVE_ID);
    expect(reloaded?.modelId).toBe("draft-model");
    expect(reloaded?.reasoningLevel).toBe("high");

    await conversationService.delete(conv.id);
  });

  it("[P2-07] materialization without explicit selection leaves NULLs (no baked defaults)", async () => {
    const { status, json } = await appFetch("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "bare draft" }),
    });
    expect(status).toBe(200);
    const conv = await json();
    expect(conv.providerId).toBeNull();
    expect(conv.modelId).toBeNull();
    expect(conv.reasoningLevel).toBeNull();

    const reloaded = await conversationService.get(conv.id);
    expect(reloaded?.providerId).toBeNull();
    expect(reloaded?.modelId).toBeNull();
    expect(reloaded?.reasoningLevel).toBeNull();

    await conversationService.delete(conv.id);
  });

  it("[P2-08] reload (GET) returns the same config", async () => {
    const { json } = await appFetch("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "reload probe",
        providerId: ACTIVE_ID,
        modelId: "reload-model",
        reasoningLevel: "medium",
      }),
    });
    const created = await json();

    const patched = await appFetch(`/api/conversations/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId: "reloaded-model" }),
    });
    expect(patched.status).toBe(200);

    const fetched = await appFetch(`/api/conversations/${created.id}`);
    expect(fetched.status).toBe(200);
    const row = await fetched.json();
    expect(row.providerId).toBe(ACTIVE_ID);
    expect(row.modelId).toBe("reloaded-model");
    expect(row.reasoningLevel).toBe("medium");

    await conversationService.delete(created.id);
  });

  it("[P2-09] switch-away-and-back preserves each conversation's config", async () => {
    const a = await conversationService.create({
      title: "conv-a",
      providerId: ACTIVE_ID,
      modelId: "model-a",
      reasoningLevel: "low",
      systemPrompt: null,
    });
    const b = await conversationService.create({
      title: "conv-b",
      providerId: SECOND_ID,
      modelId: "model-b",
      reasoningLevel: "high",
      systemPrompt: null,
    });

    // Edit A, then "switch away" to B and back to A — all via readback.
    const patched = await appFetch(`/api/conversations/${a.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId: "model-a2" }),
    });
    expect(patched.status).toBe(200);

    const readB = await (await appFetch(`/api/conversations/${b.id}`)).json();
    expect(readB.providerId).toBe(SECOND_ID);
    expect(readB.modelId).toBe("model-b");
    expect(readB.reasoningLevel).toBe("high");

    const readABack = await (await appFetch(`/api/conversations/${a.id}`)).json();
    expect(readABack.providerId).toBe(ACTIVE_ID);
    expect(readABack.modelId).toBe("model-a2");
    expect(readABack.reasoningLevel).toBe("low");

    await conversationService.delete(a.id);
    await conversationService.delete(b.id);
  });

  it("[P2-16] opencode_* fields round-trip through PATCH/GET unmodified", async () => {
    const created = await conversationService.create({
      title: "p2-16",
      providerId: null,
      modelId: null,
      reasoningLevel: null,
      systemPrompt: null,
    });
    const { status } = await appFetch(`/api/conversations/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        engine: "opencode",
        opencodeAgent: "coder",
        opencodeModel: "openai/gpt-4o",
        opencodeVariant: "balanced",
        opencodeAutoApprove: true,
      }),
    });
    expect(status).toBe(200);

    const row = await (await appFetch(`/api/conversations/${created.id}`)).json();
    expect(row.engine).toBe("opencode");
    expect(row.opencodeAgent).toBe("coder");
    expect(row.opencodeModel).toBe("openai/gpt-4o");
    expect(row.opencodeVariant).toBe("balanced");
    expect(row.opencodeAutoApprove).toBe(true);

    await conversationService.delete(created.id);
  });
});

describe("phase 2 — resolveChatModel contract (seam)", () => {
  beforeEach(async () => {
    await seedPhase2Providers();
  });

  afterAll(async () => {
    for (const id of OWN_IDS) db.run("DELETE FROM provider_configs WHERE id = ?", [id]);
    await registry.loadFromDb(db);
  });

  it("[P2-10] honors the explicit row provider/model", async () => {
    const conv = await conversationService.create({
      title: "p2-10",
      providerId: SECOND_ID,
      modelId: "row-model",
      reasoningLevel: "high",
      systemPrompt: null,
    });
    const resolved = await resolveChatModel({ threadId: conv.id });
    expect(resolved?.provider.id).toBe(SECOND_ID);
    expect(resolved?.model).toBe("row-model");
    expect(resolved?.reasoning).toBe("high");

    await conversationService.delete(conv.id);
  });

  it("[P2-11a] unknown row provider throws UnknownProviderError (no active substitution)", async () => {
    const conv = await conversationService.create({
      title: "p2-11a",
      providerId: "p2-ghost-provider",
      modelId: "m",
      reasoningLevel: null,
      systemPrompt: null,
    });
    let thrown: unknown;
    try {
      await resolveChatModel({ threadId: conv.id });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(UnknownProviderError);
    expect((thrown as UnknownProviderError).code).toBe("UNKNOWN_PROVIDER");
    expect((thrown as UnknownProviderError).providerId).toBe("p2-ghost-provider");

    await conversationService.delete(conv.id);
  });

  it("[P2-11b] unknown request provider throws UnknownProviderError (no active substitution)", async () => {
    let thrown: unknown;
    try {
      await resolveChatModel({ providerId: "p2-ghost-request" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(UnknownProviderError);
    expect((thrown as UnknownProviderError).code).toBe("UNKNOWN_PROVIDER");
    expect((thrown as UnknownProviderError).providerId).toBe("p2-ghost-request");
  });

  it("[P2-11c] chat route maps UnknownProviderError to 400 { error, code, requestId }", async () => {
    const res = await chatRoute.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "p2-ghost-http",
        messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("UNKNOWN_PROVIDER");
    expect(typeof body.error).toBe("string");
    expect(String(body.error)).toContain("p2-ghost-http");
    expect(typeof body.requestId).toBe("string");
  });

  it("[P2-12a] falls back to active ONLY when neither request nor row names a provider", async () => {
    // Bare: no request fields, no thread → the seeded active provider.
    const bare = await resolveChatModel({});
    expect(bare?.provider.id).toBe(ACTIVE_ID);
    expect(bare?.model).toBe("p2-active-model");
    expect(bare?.reasoning).toBe("low");

    // NULL row (no explicit config) also falls back to active.
    const conv = await conversationService.create({
      title: "p2-12a",
      providerId: null,
      modelId: null,
      reasoningLevel: null,
      systemPrompt: null,
    });
    const rowless = await resolveChatModel({ threadId: conv.id });
    expect(rowless?.provider.id).toBe(ACTIVE_ID);

    // But an explicit row is honored verbatim — active is NOT substituted.
    await conversationService.update(conv.id, {
      providerId: SECOND_ID,
      modelId: "row-model",
      reasoningLevel: "high",
    });
    const explicit = await resolveChatModel({ threadId: conv.id });
    expect(explicit?.provider.id).toBe(SECOND_ID);
    expect(explicit?.model).toBe("row-model");

    await conversationService.delete(conv.id);
  });

  it("[P2-12b] resolves null when nothing is configured anywhere", async () => {
    const ids = registry.list().map((p) => p.id);
    for (const id of ids) registry.remove(id);
    try {
      expect(await resolveChatModel({})).toBeNull();
    } finally {
      await registry.loadFromDb(db);
    }
  });

  it("[P2-12c] blank/whitespace provider ids count as absent", async () => {
    for (const blank of ["", "   "]) {
      const resolved = await resolveChatModel({ providerId: blank });
      expect(resolved?.provider.id).toBe(ACTIVE_ID);
    }
    const conv = await conversationService.create({
      title: "p2-12c",
      providerId: "   ",
      modelId: "m",
      reasoningLevel: null,
      systemPrompt: null,
    });
    const resolved = await resolveChatModel({ threadId: conv.id });
    expect(resolved?.provider.id).toBe(ACTIVE_ID);
    await conversationService.delete(conv.id);
  });

  it("[P2-13] one-shot request values resolve without altering the persisted row", async () => {
    const conv = await conversationService.create({
      title: "p2-13",
      providerId: ACTIVE_ID,
      modelId: "persisted-model",
      reasoningLevel: "low",
      systemPrompt: null,
    });
    const resolved = await resolveChatModel({
      providerId: SECOND_ID,
      model: "oneshot-model",
      reasoningLevel: "high",
      threadId: conv.id,
    });
    // Request provider wins outright against its own values.
    expect(resolved?.provider.id).toBe(SECOND_ID);
    expect(resolved?.model).toBe("oneshot-model");
    expect(resolved?.reasoning).toBe("high");

    // The persisted row is untouched by the one-shot use.
    const row = await conversationService.get(conv.id);
    expect(row?.providerId).toBe(ACTIVE_ID);
    expect(row?.modelId).toBe("persisted-model");
    expect(row?.reasoningLevel).toBe("low");

    await conversationService.delete(conv.id);
  });

  it("[P2-14] after one-shot use, bare resolution returns the persisted values", async () => {
    const conv = await conversationService.create({
      title: "p2-14",
      providerId: SECOND_ID,
      modelId: "persisted-model",
      reasoningLevel: "medium",
      systemPrompt: null,
    });
    // One-shot against a different provider (must not leak into the row).
    await resolveChatModel({
      providerId: ACTIVE_ID,
      model: "throwaway",
      threadId: conv.id,
    });
    const row = await conversationService.get(conv.id);
    expect(row?.providerId).toBe(SECOND_ID);
    expect(row?.modelId).toBe("persisted-model");

    // Next bare resolution (no request fields) returns the persisted config.
    const next = await resolveChatModel({ threadId: conv.id });
    expect(next?.provider.id).toBe(SECOND_ID);
    expect(next?.model).toBe("persisted-model");
    expect(next?.reasoning).toBe("medium");

    await conversationService.delete(conv.id);
  });

  it("[P2-15] same model id under two providers resolves against the named provider", async () => {
    const viaA = await resolveChatModel({ providerId: SHARED_A });
    expect(viaA?.provider.id).toBe(SHARED_A);
    expect(viaA?.model).toBe("shared-model");

    const viaB = await resolveChatModel({ providerId: SHARED_B });
    expect(viaB?.provider.id).toBe(SHARED_B);
    expect(viaB?.model).toBe("shared-model");
    // The two registrations stay distinct (different saved reasoning).
    expect(viaB?.reasoning).toBe("high");

    // One-shot model override still honors the named provider, never a swap.
    const override = await resolveChatModel({
      providerId: SHARED_A,
      model: "other-model",
    });
    expect(override?.provider.id).toBe(SHARED_A);
    expect(override?.model).toBe("other-model");
  });
});

describe("phase 2 — full-chain integration", () => {
  beforeEach(async () => {
    await seedPhase2Providers();
  });

  it("[P2-A] select → PATCH → reload → resolve yields the exact provider + model", async () => {
    const created = await conversationService.create({
      title: "p2-a",
      providerId: null,
      modelId: null,
      reasoningLevel: null,
      systemPrompt: null,
    });
    // select: user picks provider + model in the composer → PATCH.
    const patched = await appFetch(`/api/conversations/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: SECOND_ID,
        modelId: "chain-model",
        reasoningLevel: "high",
      }),
    });
    expect(patched.status).toBe(200);

    // reload: fresh read returns the selection.
    const reloaded = await (await appFetch(`/api/conversations/${created.id}`)).json();
    expect(reloaded.providerId).toBe(SECOND_ID);
    expect(reloaded.modelId).toBe("chain-model");
    expect(reloaded.reasoningLevel).toBe("high");

    // resolve: the chat seam runs the exact provider + model.
    const resolved = await resolveChatModel({ threadId: created.id });
    expect(resolved?.provider.id).toBe(SECOND_ID);
    expect(resolved?.model).toBe("chain-model");
    expect(resolved?.reasoning).toBe("high");

    await conversationService.delete(created.id);
  });

  it("[P2-B] draft explicit → materialize (POST) → readback yields the exact config", async () => {
    // Draft explicit: the adapter POSTs the one-shot picks (provider/model/
    // reasoning) as-given; absent would stay absent (see P2-07).
    const { status, json } = await appFetch("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "draft chain",
        providerId: SECOND_ID,
        modelId: "draft-chain-model",
        reasoningLevel: "medium",
      }),
    });
    expect(status).toBe(200);
    const created = await json();

    // readback: the materialized row owns the exact config.
    const row = await (await appFetch(`/api/conversations/${created.id}`)).json();
    expect(row.providerId).toBe(SECOND_ID);
    expect(row.modelId).toBe("draft-chain-model");
    expect(row.reasoningLevel).toBe("medium");

    const resolved = await resolveChatModel({ threadId: created.id });
    expect(resolved?.provider.id).toBe(SECOND_ID);
    expect(resolved?.model).toBe("draft-chain-model");

    await conversationService.delete(created.id);
  });
});
