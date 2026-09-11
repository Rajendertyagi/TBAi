import { Hono } from "hono";
import { db } from "../db";
import type { SQLQueryBindings } from "bun:sqlite";
import { registry } from "../config/providers";
import { generateId } from "../lib/utils";
import { credentialStore } from "../services/credentials";
import { redact } from "../lib/redact";
import { logger } from "../lib/logger";
import { discoverModels } from "../services/modelDiscovery";
import { providerCreateSchema, providerUpdateSchema, providerTestSchema, providerDiscoverSchema } from "../lib/validation";
import { storageError } from "./shared";
import type { ProviderConfig } from "../types";

/** Protocol default per provider type (mirrors services/ai.ts DEFAULT_PROTOCOL). */
function defaultApiProtocol(type: ProviderConfig["type"]): ProviderConfig["apiProtocol"] {
  if (type === "openai") return "responses";
  if (type === "custom" || type === "ollama") return "chat-completions";
  return undefined;
}

const app = new Hono<{ Variables: { requestId: string } }>();

// ---- Credential store (locally encrypted secrets) ----
// Provider routes
app.get("/api/providers", async (c) => {
  await registry.loadFromDb(db);
  const list = registry.list().map((p) => ({
    ...p,
    credentialConfigured: credentialStore.has(p.id),
  }));
  return c.json(list);
});

app.post("/api/providers", async (c) => {
  const parsed = providerCreateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "Invalid provider", issues: parsed.error.issues }, 400);
  }
  const body = parsed.data;
  const id = generateId();
  const now = Date.now();
  const activeCount = (db.query("SELECT COUNT(*) as c FROM provider_configs WHERE is_active = 1").get() as { c: number }).c;
  const isActive = activeCount === 0 ? 1 : 0;
  const apiProtocol = body.apiProtocol ?? defaultApiProtocol(body.type);

  db.run(
    `INSERT INTO provider_configs (id, name, type, endpoint, model, models, thinking, api_protocol, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, body.name, body.type, body.endpoint || null, body.model, JSON.stringify(body.models ?? []), body.thinking ?? "off", apiProtocol ?? null, isActive, now, now],
  );

  let credentialConfigured = false;
  if (body.apiKey && body.apiKey.length > 0) {
    credentialStore.set(id, body.apiKey);
    credentialConfigured = true;
  }

  await registry.loadFromDb(db);
  const created = registry.get(id)!;
  const { apiKey: _omit, ...safe } = created;
  return c.json({ ...safe, credentialConfigured });
});

app.put("/api/providers/:id", async (c) => {
  const parsed = providerUpdateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "Invalid provider", issues: parsed.error.issues }, 400);
  }
  const id = c.req.param("id");
  const body = parsed.data;
  const now = Date.now();

  // Only update fields that were provided, so an edit that omits apiKey
  // (e.g. the UI not echoing the secret back) does not wipe the stored key.
  const sets: string[] = [];
  const values: SQLQueryBindings[] = [];
  if (body.name !== undefined) { sets.push("name = ?"); values.push(body.name); }
  if (body.type !== undefined) { sets.push("type = ?"); values.push(body.type); }
  if (body.endpoint !== undefined) { sets.push("endpoint = ?"); values.push(body.endpoint || null); }
  if (body.model !== undefined) { sets.push("model = ?"); values.push(body.model); }
  if (body.models !== undefined) { sets.push("models = ?"); values.push(JSON.stringify(body.models)); }
  if (body.thinking !== undefined) { sets.push("thinking = ?"); values.push(body.thinking); }
  if (body.apiProtocol !== undefined) { sets.push("api_protocol = ?"); values.push(body.apiProtocol); }
  sets.push("updated_at = ?");
  values.push(now, id);

  db.run(`UPDATE provider_configs SET ${sets.join(", ")} WHERE id = ?`, values);

  let credentialConfigured = credentialStore.has(id);
  if (body.apiKey !== undefined && body.apiKey !== "") {
    credentialStore.set(id, body.apiKey);
    credentialConfigured = true;
  }

  await registry.loadFromDb(db);
  const updated = registry.get(id);
  if (!updated) return c.json({ success: true });
  const { apiKey: _omit2, ...safe } = updated;
  return c.json({ ...safe, credentialConfigured });
});

app.delete("/api/providers/:id", async (c) => {
  try {
    const id = c.req.param("id");
    credentialStore.delete(id);
    db.run("DELETE FROM provider_configs WHERE id = ?", [id]);
    await registry.loadFromDb(db);
    return c.json({ success: true });
  } catch (e) {
    return storageError(c, e);
  }
});

app.post("/api/providers/:id/set-active", async (c) => {
  try {
    const id = c.req.param("id");
    db.run("UPDATE provider_configs SET is_active = 0");
    db.run("UPDATE provider_configs SET is_active = 1 WHERE id = ?", [id]);
    await registry.loadFromDb(db);
    return c.json({ success: true });
  } catch (e) {
    return storageError(c, e);
  }
});

app.post("/api/providers/test", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = providerTestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid provider", issues: parsed.error.issues }, 400);
  }
  const cfg = parsed.data;
  let apiKey = cfg.apiKey;
  if (!apiKey && cfg.id) {
    const provider = registry.get(cfg.id);
    if (provider && credentialStore.has(provider.id)) {
      apiKey = credentialStore.get(provider.id);
    }
  }
  if (cfg.type !== "ollama" && !apiKey) {
    return c.json({ ok: false, error: "No API key provided" }, 400);
  }
  try {
    const models = await discoverModels({ type: cfg.type, endpoint: cfg.endpoint, apiKey });
    return c.json({ ok: true, modelCount: models.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Connection failed";
    logger.warn("ai.provider", "provider_test_failed", {
      requestId: (c.get("requestId") as string | undefined),
      provider: cfg.type,
      message: redact(msg),
    });
    return c.json({ ok: false, error: redact(msg) }, 200);
  }
});

// Discover available models from a provider (built-in or custom). Works with an
// inline config (pre-save) or a saved provider id (post-save, reusing its
// stored credential). Returns discovered models only — nothing is persisted here;
// the client persists the user's selected/enabled subset on save.
app.post("/api/providers/discover", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = providerDiscoverSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: "Invalid provider", issues: parsed.error.issues }, 400);
  }
  const cfg = parsed.data;
  let apiKey = cfg.apiKey;
  if (!apiKey && cfg.id) {
    const provider = registry.get(cfg.id);
    if (provider && credentialStore.has(provider.id)) {
      apiKey = credentialStore.get(provider.id);
    }
  }
  if (cfg.type !== "ollama" && !apiKey) {
    return c.json({ ok: false, error: "No API key provided" }, 400);
  }
  try {
    const models = await discoverModels({ type: cfg.type, endpoint: cfg.endpoint, apiKey });
    return c.json({ ok: true, models });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Discovery failed";
    logger.warn("ai.provider", "model_discovery_failed", {
      requestId: (c.get("requestId") as string | undefined),
      provider: cfg.type,
      message: redact(msg),
    });
    return c.json({ ok: false, error: redact(msg) }, 200);
  }
});

export default app;
