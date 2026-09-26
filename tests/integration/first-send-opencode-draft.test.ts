/**
 * Phase 4 first-send lifecycle — SUPERSEDES the Wave-1 422 characterization.
 *
 * Old (buggy) behavior pinned in Wave 1: a fresh `engine: "opencode"` draft
 * given its first Direct send via POST /api/chat was rejected with
 * 422 ENGINE_MISMATCH and the message was lost.
 *
 * New contract: the OpenCode draft first send NEVER reaches /api/chat. The
 * custom draft path (Composer.sendOpenCodeDraft) materializes the draft via
 * POST /api/conversations (idempotent on `clientRequestId`) and stashes the
 * text as a pending first prompt consumed once by the session-bound Code
 * surface. The 422 guard below is therefore retained but REFRAMED: it proves
 * the server-side backstop is still intact (the reason the custom path
 * exists), while the new-flow tests prove the reachable path.
 *
 * Wave-2 case map (backend legs):
 *   1. Direct draft → materialize → bound conversation → first message
 *      admitted (run minted; black-hole model leg, text not asserted).
 *   6. Concurrent materialization with the same clientRequestId → one row id.
 *   7. First message belongs to the created conversation (bound id).
 *   9. Hydration does not delete the first message (re-list keeps it).
 * Plus: replay-within-TTL resolves the same row; no key → old behavior.
 *
 * `providerId` is included on chat sends because `resolveChatModel` runs
 * BEFORE the engine guard: without a seeded active provider the request would
 * 400 ("No provider configured") instead of reaching the assertions.
 *
 * DB isolation: tests/setup.ts (bunfig preload) redirects DATA_DIR to tmp.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { Hono } from "hono";
import { logger } from "../../src/lib/logger";
import { db } from "../../src/db";
import { registry } from "../../src/config/providers";
import { conversationService, messageService } from "../../src/services/storage";
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

const PROVIDER_ID = "prov-first-send-p4";

// Black-hole model endpoint: accepts the request, never responds. Proves
// admission (guard passed, run minted) without needing a real model.
let blackhole: ReturnType<typeof Bun.serve> | null = null;
let blackholePort = 0;

async function startBlackhole(): Promise<number> {
  if (blackhole) return blackholePort;
  blackhole = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      return new Promise<Response>(() => {});
    },
  });
  blackhole.unref();
  blackholePort = blackhole.port;
  return blackholePort;
}

async function seedProvider(): Promise<void> {
  const port = await startBlackhole();
  db.run(
    `INSERT OR REPLACE INTO provider_configs
       (id, name, type, encrypted_api_key, credential_version, endpoint, model, models, thinking, is_active, created_at, updated_at)
     VALUES (?, ?, 'ollama', NULL, NULL, ?, 'void-model', '[]', 'off', 1, ?, ?)`,
    [PROVIDER_ID, "first-send-p4", `http://127.0.0.1:${port}`, Date.now(), Date.now()],
  );
  await registry.loadFromDb(db);
}

afterAll(async () => {
  try {
    blackhole?.stop(true);
  } catch {
    /* already closed */
  }
  blackhole = null;
  db.run("DELETE FROM provider_configs WHERE id = 'prov-first-send-p4'");
  await registry.loadFromDb(db);
});

function chatBody(id: string, text: string) {
  return JSON.stringify({
    providerId: PROVIDER_ID,
    id,
    messages: [{ id: "msg-first-send", role: "user", parts: [{ type: "text", text }] }],
  });
}

async function cancelRun(res: Response): Promise<void> {
  const streamId = res.headers.get("x-resumable-stream-id");
  if (streamId) await app.request(`/api/chat/cancel/${streamId}`, { method: "POST" });
}

describe("Phase 4 — Direct draft first send is admitted on the bound conversation (case 1)", () => {
  it("materialize(engine=direct) then POST /api/chat: 200, run minted, no ENGINE_MISMATCH", async () => {
    await seedProvider();

    const createRes = await app.request("/api/conversations", {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        title: "p4 direct draft",
        engine: "direct",
        providerId: PROVIDER_ID,
        modelId: "void-model",
        clientRequestId: `p4-direct-${Date.now()}-1`,
      }),
    });
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as { id: string; engine: string };
    expect(created.engine).toBe("direct");

    try {
      const countsBefore = chatRuns.counts();
      const chatRes = await app.request("/api/chat", {
        method: "POST",
        headers: json,
        body: chatBody(created.id, "hello direct"),
      });
      try {
        // Admitted: not 422. The model leg hangs (black-hole), so the run
        // stays open — admission is proven by the minted run record, not text.
        expect(chatRes.status).toBe(200);
        expect(chatRes.headers.get("x-resumable-stream-id")).toBeTruthy();
        const countsAfter = chatRuns.counts();
        expect(countsAfter.running).toBe(countsBefore.running + 1);
      } finally {
        await cancelRun(chatRes);
      }
    } finally {
      await conversationService.delete(created.id);
    }
  }, 30000);
});

describe("Phase 4 — opencode rows keep the /api/chat backstop (custom path never sends here)", () => {
  it("POST /api/chat to an opencode row: still 422 ENGINE_MISMATCH, no run, row survives", async () => {
    await seedProvider();

    const createRes = await app.request("/api/conversations", {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        title: "p4 opencode draft",
        engine: "opencode",
        clientRequestId: `p4-opencode-${Date.now()}-1`,
      }),
    });
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as { id: string; engine: string };
    expect(created.engine).toBe("opencode");

    try {
      const countsBefore = chatRuns.counts();
      const chatRes = await app.request("/api/chat", {
        method: "POST",
        headers: json,
        body: chatBody(created.id, "hello"),
      });
      expect(chatRes.status).toBe(422);
      const body = (await chatRes.json()) as { code?: string };
      expect(body.code).toBe("ENGINE_MISMATCH");

      const countsAfter = chatRuns.counts();
      expect(countsAfter.running).toBe(countsBefore.running);

      const reloaded = await conversationService.get(created.id);
      expect(reloaded).not.toBeNull();
      expect(reloaded?.engine).toBe("opencode");
      expect(reloaded?.opencodeSessionId).toBeNull();
    } finally {
      await conversationService.delete(created.id);
    }
  }, 30000);
});

describe("Phase 4 — materialization idempotency (case 6 + replay + no-key)", () => {
  it("concurrent POSTs with the same clientRequestId resolve to ONE conversation", async () => {
    const key = `p4-concurrent-${Date.now()}`;
    const payload = JSON.stringify({
      title: "p4 concurrent draft",
      engine: "direct",
      clientRequestId: key,
    });
    const [r1, r2] = await Promise.all([
      app.request("/api/conversations", { method: "POST", headers: json, body: payload }),
      app.request("/api/conversations", { method: "POST", headers: json, body: payload }),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const c1 = (await r1.json()) as { id: string };
    const c2 = (await r2.json()) as { id: string };
    try {
      expect(c1.id).toBe(c2.id);
    } finally {
      await conversationService.delete(c1.id);
    }
  }, 30000);

  it("replay after completion (same key, later request) resolves the same row", async () => {
    const key = `p4-replay-${Date.now()}`;
    const payload = JSON.stringify({
      title: "p4 replay draft",
      engine: "direct",
      clientRequestId: key,
    });
    const r1 = await app.request("/api/conversations", {
      method: "POST",
      headers: json,
      body: payload,
    });
    expect(r1.status).toBe(200);
    const c1 = (await r1.json()) as { id: string };
    try {
      const r2 = await app.request("/api/conversations", {
        method: "POST",
        headers: json,
        body: payload,
      });
      expect(r2.status).toBe(200);
      const c2 = (await r2.json()) as { id: string };
      expect(c2.id).toBe(c1.id);
    } finally {
      await conversationService.delete(c1.id);
    }
  }, 30000);

  it("no clientRequestId → old behavior: two POSTs mint two rows", async () => {
    const payload = JSON.stringify({ title: "p4 plain draft", engine: "direct" });
    const r1 = await app.request("/api/conversations", {
      method: "POST",
      headers: json,
      body: payload,
    });
    const r2 = await app.request("/api/conversations", {
      method: "POST",
      headers: json,
      body: payload,
    });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const c1 = (await r1.json()) as { id: string };
    const c2 = (await r2.json()) as { id: string };
    try {
      expect(c1.id).not.toBe(c2.id);
    } finally {
      await conversationService.delete(c1.id);
      await conversationService.delete(c2.id);
    }
  }, 30000);
});

describe("Phase 4 — first message ownership + hydration (cases 7 + 9)", () => {
  it("first message upsert targets the bound id; a sibling conversation stays empty", async () => {
    const a = await conversationService.create({
      title: "p4 bound",
      providerId: PROVIDER_ID,
      modelId: null,
      reasoningLevel: null,
      systemPrompt: null,
      engine: "direct",
    });
    const b = await conversationService.create({
      title: "p4 sibling",
      providerId: PROVIDER_ID,
      modelId: null,
      reasoningLevel: null,
      systemPrompt: null,
      engine: "direct",
    });
    try {
      const put = await app.request(`/api/conversations/${a.id}/messages`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({
          message: {
            id: "msg-first-p4",
            parent_id: null,
            format: "tbai/v1",
            content: [{ role: "user", content: [{ type: "text", text: "hello bound" }] }],
          },
        }),
      });
      expect(put.status).toBe(200);

      const listed = await messageService.listThreadMessages(a.id);
      expect(listed.map((m) => m.id)).toContain("msg-first-p4");
      const sibling = await messageService.listThreadMessages(b.id);
      expect(sibling).toHaveLength(0);
    } finally {
      await conversationService.delete(a.id);
      await conversationService.delete(b.id);
    }
  }, 30000);

  it("history refresh after send keeps the first message (exactly one copy)", async () => {
    const conv = await conversationService.create({
      title: "p4 hydration",
      providerId: PROVIDER_ID,
      modelId: null,
      reasoningLevel: null,
      systemPrompt: null,
      engine: "direct",
    });
    try {
      await messageService.upsertStored(conv.id, {
        id: "msg-hydra-p4",
        parent_id: null,
        format: "tbai/v1",
        content: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      });
      // Initial history load…
      const first = await app.request(`/api/conversations/${conv.id}/messages`);
      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as { messages: Array<{ id: string }> };
      expect(firstBody.messages.filter((m) => m.id === "msg-hydra-p4")).toHaveLength(1);
      // …and a refresh after the send: still exactly one copy, never deleted.
      const second = await app.request(`/api/conversations/${conv.id}/messages`);
      expect(second.status).toBe(200);
      const secondBody = (await second.json()) as { messages: Array<{ id: string }> };
      expect(secondBody.messages.filter((m) => m.id === "msg-hydra-p4")).toHaveLength(1);
    } finally {
      await conversationService.delete(conv.id);
    }
  }, 30000);
});
