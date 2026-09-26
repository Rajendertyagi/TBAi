/**
 * TEMP SPIKE (§17a): can a fake Ollama SSE stub drive a real Direct
 * first-send end-to-end with visible assistant text? Route-level leg.
 * DELETE after verdict (or keep as the route-level streaming fallback).
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { Hono } from "hono";
import { logger } from "../../src/lib/logger";
import { db } from "../../src/db";
import { registry } from "../../src/config/providers";
import { conversationService } from "../../src/services/storage";
import { chatRuns } from "../../src/services/chat-runs";

const app = new Hono();
const { default: chatApp } = await import("../../src/routes/chat");
const { default: conversationsApp } = await import("../../src/routes/conversations");
app.route("/", chatApp);
app.route("/", conversationsApp);

const json = { "Content-Type": "application/json" };
beforeEach(() => {
  logger.configure({ level: "error", targets: [], file: null, fileEnabled: false });
});
afterEach(() => {
  logger.configure({ level: "error", targets: [], file: null, fileEnabled: false });
});

const PROVIDER_ID = "prov-spike-sse";
const MARKER = "SPIKE_SSE_HELLO_9f31";

let stub: ReturnType<typeof Bun.serve> | null = null;

afterAll(async () => {
  try {
    stub?.stop(true);
  } catch { /* closed */ }
  stub = null;
  db.run("DELETE FROM provider_configs WHERE id = 'prov-spike-sse'");
  await registry.loadFromDb(db);
});

describe("SPIKE — fake Ollama SSE stub drives /api/chat to visible text", () => {
  it("streams the stub text through the real route", async () => {
    stub = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname.endsWith("/chat/completions")) {
          const body =
            `data: ${JSON.stringify({ choices: [{ delta: { content: MARKER }, index: 0 }] })}\n\n` +
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop", index: 0 }] })}\n\n` +
            `data: [DONE]\n\n`;
          return new Response(body, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    stub.unref();
    const endpoint = `http://127.0.0.1:${stub.port}/v1`;
    db.run(
      `INSERT OR REPLACE INTO provider_configs
         (id, name, type, encrypted_api_key, credential_version, endpoint, model, models, thinking, is_active, created_at, updated_at)
       VALUES (?, ?, 'ollama', NULL, NULL, ?, 'void-model', '[]', 'off', 1, ?, ?)`,
      [PROVIDER_ID, "spike-sse", endpoint, Date.now(), Date.now()],
    );
    await registry.loadFromDb(db);

    const conv = await conversationService.create({
      title: "spike sse",
      providerId: PROVIDER_ID,
      modelId: null,
      reasoningLevel: null,
      systemPrompt: null,
      engine: "direct",
    });
    try {
      const res = await app.request("/api/chat", {
        method: "POST",
        headers: json,
        body: JSON.stringify({
          providerId: PROVIDER_ID,
          model: "void-model",
          id: conv.id,
          messages: [{ id: "msg-spike-sse", role: "user", parts: [{ type: "text", text: "hi" }] }],
        }),
      });
      expect(res.status).toBe(200);
      expect(res.body).not.toBeNull();
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let raw = "";
      const deadline = Date.now() + 15000;
      for (;;) {
        if (Date.now() > deadline) throw new Error("stream did not close in time");
        const { done, value } = await reader.read();
        if (done) break;
        raw += decoder.decode(value, { stream: true });
      }
      expect(raw).toContain(MARKER);
    } finally {
      for (const [, rec] of (chatRuns as unknown as { records?: Map<string, { status: string }> }).records ?? []) {
        void rec;
      }
      await conversationService.delete(conv.id);
    }
  }, 30000);
});
