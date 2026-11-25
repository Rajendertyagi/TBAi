/**
 * DELETE /api/conversations/:id for OpenCode rows — local-only teardown.
 *
 * Deleting a TBAi conversation removes only TBAi's local conversation and
 * messages. It never issues a remote OpenCode request: the shared session and
 * its children remain in OpenCode for the user to manage there.
 *
 * The request-entry snapshot is authoritative. A pointer that changes after
 * the request started is never overwritten: the row is preserved and the
 * route answers 409.
 *
 * The fake below emulates the OpenCode V2 endpoints at the
 * `openCodeServerManager.ensureBaseUrl` seam so the test can prove that no
 * remote mutation is issued. No real process is spawned.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { db } from "@/db";
import { logger } from "@/lib/logger.ts";
import { applyOpenCodeOrphanSchema } from "@/db/schema/opencode-session-orphans.ts";
import { conversationService } from "@/services/storage";
import { deleteOpenCodeConversation } from "@/services/opencode/conversationDeletion.ts";
import { openCodeServerManager } from "@/services/opencode/serverManager.ts";
import { conversationInput } from "../../helpers/conversation-fixtures";

const app = new Hono();
const { default: conversationsApp } = await import("@/routes/conversations.ts");
app.route("/", conversationsApp);

type EnsureBaseUrl = () => Promise<string>;
const manager = openCodeServerManager as unknown as { ensureBaseUrl: EnsureBaseUrl };

beforeEach(() => {
  applyOpenCodeOrphanSchema(db);
  db.run("DELETE FROM opencode_session_orphans");
  logger.configure({ level: "error", targets: [], file: null, fileEnabled: false });
});

afterEach(() => {
  logger.configure({ level: "error", targets: [], file: null, fileEnabled: false });
});

interface Fake {
  url: string;
  calls: string[];
  sessions: Set<string>;
  stop: () => void;
}

function startFake(): Fake {
  const sessions = new Set<string>();
  const calls: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/api/session") {
        const body = (await req.json()) as { id?: string; location?: { directory?: string } };
        if (typeof body.id !== "string") return Response.json({ data: null }, { status: 400 });
        sessions.add(body.id);
        calls.push(`create:${body.id}`);
        return Response.json({ data: { id: body.id, location: body.location } });
      }
      const one = url.pathname.match(/^\/api\/session\/([^/]+)$/);
      if (one && req.method === "DELETE") {
        calls.push(`remove:${one[1]}`);
        sessions.delete(one[1]);
        return new Response(null, { status: 204 });
      }
      if (one && req.method === "GET") {
        const id = one[1];
        calls.push(`get:${id}`);
        if (!sessions.has(id)) return Response.json({ data: null }, { status: 404 });
        return Response.json({ data: { id, location: { directory: process.cwd() } } });
      }
      if (url.pathname === "/api/model" || url.pathname === "/api/config") {
        return Response.json({ data: [] });
      }
      return Response.json({ data: null }, { status: 404 });
    },
  });
  server.unref();
  return {
    url: `http://127.0.0.1:${server.port}`,
    calls,
    sessions,
    stop: () => server.stop(true),
  };
}

async function withFake<T>(handler: (fake: Fake) => Promise<T>): Promise<T> {
  const fake = startFake();
  const real = manager.ensureBaseUrl;
  manager.ensureBaseUrl = async () => fake.url;
  try {
    return await handler(fake);
  } finally {
    manager.ensureBaseUrl = real;
    fake.stop();
  }
}

async function createOpenCodeConversation(sessionId: string | null): Promise<string> {
  const conv = await conversationService.create(conversationInput({ engine: "opencode" }));
  if (sessionId !== null) {
    await conversationService.update(conv.id, { opencodeSessionId: sessionId });
  }
  return conv.id;
}

function journalRows(conversationId: string): number {
  return (
    (db
      .query("SELECT COUNT(*) AS n FROM opencode_session_orphans WHERE conversation_id = ?")
      .get(conversationId) as { n: number } | null)?.n ?? 0
  );
}

describe("DELETE /api/conversations/:id — local-only teardown", () => {
  it("deletes the local row and messages without any remote OpenCode request", async () => {
    const convId = await createOpenCodeConversation("ses_local_only");
    await withFake(async (fake) => {
      fake.sessions.add("ses_local_only");
      const res = await app.request(`/api/conversations/${convId}`, { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        success: true,
        deleted: true,
        sessionCleanup: "none",
      });
      // No remote mutation and no remote probe: deletion is purely local.
      expect(fake.calls).toEqual([]);
      expect(fake.sessions.has("ses_local_only")).toBe(true);
    });
    expect(await conversationService.get(convId)).toBeNull();
    expect(journalRows(convId)).toBe(0);
  });

  it("preserves the row when the pointer changes after the entry snapshot", async () => {
    const convId = await createOpenCodeConversation("ses_rebind_s1");
    // A stale entry snapshot is the deterministic form of the rebind race:
    // the row now points at s2, so the request must not delete it.
    await conversationService.update(convId, { opencodeSessionId: "ses_rebind_s2" });
    await withFake(async (fake) => {
      const outcome = await deleteOpenCodeConversation({
        conversationId: convId,
        entry: { engine: "opencode", opencodeSessionId: "ses_rebind_s1" },
      });
      expect(outcome).toEqual({ kind: "conflict", reason: "session_rebound" });
      expect(fake.calls).toEqual([]);
    });
    const preserved = await conversationService.get(convId);
    expect(preserved?.opencodeSessionId).toBe("ses_rebind_s2");
  });

  it("deletes a conversation with no session pointer without any remote request", async () => {
    const convId = await createOpenCodeConversation(null);
    await withFake(async (fake) => {
      const res = await app.request(`/api/conversations/${convId}`, { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(fake.calls).toEqual([]);
    });
    expect(await conversationService.get(convId)).toBeNull();
  });

  it("leaves a Direct row on the existing deletion path", async () => {
    const conv = await conversationService.create(conversationInput({ engine: "direct" }));
    await conversationService.update(conv.id, { opencodeSessionId: "ses_stale_direct" });
    await withFake(async (fake) => {
      const res = await app.request(`/api/conversations/${conv.id}`, { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(fake.calls).toEqual([]);
    });
    expect(await conversationService.get(conv.id)).toBeNull();
  });
});
