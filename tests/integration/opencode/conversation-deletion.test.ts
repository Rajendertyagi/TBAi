/**
 * RT-011: DELETE /api/conversations/:id for OpenCode rows.
 *
 * The route hands OpenCode rows to the deletion coordinator, which
 *   1. arms a durable `delete` marker from the REQUEST ENTRY snapshot before any
 *      decision read,
 *   2. terminates only that exact session,
 *   3. deletes the row only while no session is bound, and
 *   4. deletes anyway when the remote removal is unconfirmed (Option A) because
 *      the marker is the durable handle — but returns 503 and deletes nothing
 *      when the marker cannot be written.
 *
 * A pointer that changes after the request started is never overwritten: the
 * row is preserved and the route answers 409.
 *
 * The fake below emulates the OpenCode V2 endpoints at the
 * `openCodeServerManager.ensureBaseUrl` seam, so no real process is spawned.
 * Journal triggers are the race/failure injectors: SQLite lets a trigger clear
 * the pointer (or throw) at exactly the moment the coordinator arms its marker.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { db } from "@/db";
import { logger } from "@/lib/logger.ts";
import { applyOpenCodeOrphanSchema } from "@/db/schema/opencode-session-orphans.ts";
import { conversationService } from "@/services/storage";
import { ensureOpenCodeSession } from "@/services/opencode/sessions.ts";
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
  for (const trigger of [
    "rt011_drift_clear",
    "rt011_drift_engine",
    "rt011_arm_fail",
    "rt011_retain_fail",
  ]) {
    db.run(`DROP TRIGGER IF EXISTS ${trigger}`);
  }
  logger.configure({ level: "error", targets: [], file: null, fileEnabled: false });
});

interface FakeOptions {
  /** Non-2xx status for `session.remove`. */
  removeStatus?: number;
  /** `remove` answers 204 but the session is still present. */
  keepOnRemove?: boolean;
}

interface RemoveGate {
  reached: Promise<void>;
  release: () => void;
}

function startFake(options: FakeOptions = {}) {
  const sessions = new Set<string>();
  const calls: string[] = [];
  let gate: {
    sessionId: string;
    signalReached: () => void;
    wait: Promise<void>;
  } | null = null;

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === "POST" && url.pathname === "/api/session") {
        const body = (await req.json()) as {
          id?: string;
          location?: { directory?: string };
        };
        if (typeof body.id !== "string") {
          return Response.json({ data: null }, { status: 400 });
        }
        sessions.add(body.id);
        calls.push(`create:${body.id}`);
        return Response.json({ data: { id: body.id, location: body.location } });
      }

      const interrupt = url.pathname.match(/^\/api\/session\/([^/]+)\/interrupt$/);
      if (req.method === "POST" && interrupt) {
        calls.push(`interrupt:${interrupt[1]}`);
        return new Response(null, { status: 204 });
      }

      const one = url.pathname.match(/^\/api\/session\/([^/]+)$/);
      if (one && req.method === "DELETE") {
        const id = one[1];
        calls.push(`remove:${id}`);
        if (options.removeStatus !== undefined) {
          return new Response("failed", { status: options.removeStatus });
        }
        if (!options.keepOnRemove) sessions.delete(id);
        const pending = gate;
        if (pending?.sessionId === id) {
          gate = null;
          pending.signalReached();
          await pending.wait;
        }
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
    /** Deletes the session, then holds the remove response until released. */
    gateRemove(sessionId: string): RemoveGate {
      let signalReached!: () => void;
      const reached = new Promise<void>((resolve) => {
        signalReached = resolve;
      });
      let release!: () => void;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      gate = { sessionId, signalReached, wait };
      return { reached, release };
    },
    stop() {
      server.stop(true);
    },
  };
}

async function withFake<T>(
  options: FakeOptions,
  handler: (fake: ReturnType<typeof startFake>) => Promise<T>,
): Promise<T> {
  const fake = startFake(options);
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

function journalRow(conversationId: string, sessionId: string): Record<string, unknown> | null {
  return (
    (db
      .query(
        `SELECT * FROM opencode_session_orphans
          WHERE conversation_id = ? AND session_id = ?`,
      )
      .get(conversationId, sessionId) as Record<string, unknown> | null) ?? null
  );
}

describe("DELETE /api/conversations/:id — RT-011 deletion coordinator", () => {
  it("arms the marker before its first read, so a pre-read pointer clear cannot bypass cleanup", async () => {
    const convId = await createOpenCodeConversation("ses_rt011_drift");
    // The injector: the pointer is cleared AFTER the route's entry snapshot but
    // BEFORE the coordinator's first decision read (the trigger runs on arm).
    db.run(`
      CREATE TRIGGER rt011_drift_clear
      BEFORE INSERT ON opencode_session_orphans
      WHEN NEW.phase = 'delete'
      BEGIN
        UPDATE conversations
           SET opencode_session_id = NULL
         WHERE id = NEW.conversation_id;
      END;
    `);

    await withFake({}, async (fake) => {
      const res = await app.request(`/api/conversations/${convId}`, { method: "DELETE" });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        success: boolean;
        deleted: boolean;
        sessionCleanup: string;
      };
      expect(body).toEqual({ success: true, deleted: true, sessionCleanup: "retained" });
      // The snapshot was journaled before the decision read, so no remote call
      // was needed (and none may be invented for a pointer that is gone).
      expect(fake.calls).toEqual([]);
    });

    expect(await conversationService.get(convId)).toBeNull();
    const marker = journalRow(convId, "ses_rt011_drift");
    expect(marker?.phase).toBe("delete");
    expect(marker?.late_create_risk).not.toBe(0);
    expect(marker?.resolved_at).toBeNull();
  });

  it("leaves a Direct row on the existing deletion path even with a stale session pointer", async () => {
    const conv = await conversationService.create(conversationInput({ engine: "direct" }));
    await conversationService.update(conv.id, { opencodeSessionId: "ses_rt011_stale" });

    await withFake({}, async (fake) => {
      const res = await app.request(`/api/conversations/${conv.id}`, { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(fake.calls).toEqual([]);
    });

    expect(await conversationService.get(conv.id)).toBeNull();
    // Direct rows never enter the coordinator, so no delete marker is armed.
    expect(journalRow(conv.id, "ses_rt011_stale")).toBeNull();
  });

  it("answers 409 and preserves the row when the engine changes after the entry snapshot", async () => {
    const convId = await createOpenCodeConversation("ses_rt011_engine");
    db.run(`
      CREATE TRIGGER rt011_drift_engine
      BEFORE INSERT ON opencode_session_orphans
      WHEN NEW.phase = 'delete'
      BEGIN
        UPDATE conversations SET engine = 'direct' WHERE id = NEW.conversation_id;
      END;
    `);

    await withFake({}, async (fake) => {
      const res = await app.request(`/api/conversations/${convId}`, { method: "DELETE" });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "session_rebound" });
      expect(fake.calls).toEqual([]);
    });

    const preserved = await conversationService.get(convId);
    expect(preserved?.opencodeSessionId).toBe("ses_rt011_engine");
    // The marker survives: the request observed this session and may not drop
    // its obligation just because another actor changed the row.
    expect(journalRow(convId, "ses_rt011_engine")?.phase).toBe("delete");

    await conversationService.delete(convId);
  });

  it("returns 503 and deletes nothing when the durable marker cannot be written", async () => {
    const convId = await createOpenCodeConversation("ses_rt011_arm");
    db.run(`
      CREATE TRIGGER rt011_arm_fail
      BEFORE INSERT ON opencode_session_orphans
      BEGIN
        SELECT RAISE(ABORT, 'journal unavailable');
      END;
    `);

    await withFake({}, async (fake) => {
      const res = await app.request(`/api/conversations/${convId}`, { method: "DELETE" });

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "session_cleanup_unavailable" });
      // Preservation failure is structural: no remote call and no teardown.
      expect(fake.calls).toEqual([]);
    });

    const preserved = await conversationService.get(convId);
    expect(preserved?.opencodeSessionId).toBe("ses_rt011_arm");
    expect(journalRow(convId, "ses_rt011_arm")).toBeNull();

    await conversationService.delete(convId);
  });

  it("returns 503 and preserves the row when the marker cannot survive a failed removal", async () => {
    const convId = await createOpenCodeConversation("ses_rt011_retain");
    db.run(`
      CREATE TRIGGER rt011_retain_fail
      BEFORE UPDATE ON opencode_session_orphans
      BEGIN
        SELECT RAISE(ABORT, 'journal unavailable');
      END;
    `);

    await withFake({ removeStatus: 500 }, async (fake) => {
      const res = await app.request(`/api/conversations/${convId}`, { method: "DELETE" });

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "session_cleanup_unavailable" });
      expect(fake.calls).toContain("remove:ses_rt011_retain");
    });

    const preserved = await conversationService.get(convId);
    expect(preserved?.opencodeSessionId).toBe("ses_rt011_retain");
    const marker = journalRow(convId, "ses_rt011_retain");
    expect(marker?.phase).toBe("delete");
    expect(marker?.resolved_at).toBeNull();

    await conversationService.delete(convId);
  });

  it("answers 409 when a real create rebinds a new session while the removal is in flight", async () => {
    const convId = await createOpenCodeConversation("ses_rt011_first");
    const fake = startFake();
    fake.sessions.add("ses_rt011_first");
    const real = manager.ensureBaseUrl;
    manager.ensureBaseUrl = async () => fake.url;
    try {
      const gate = fake.gateRemove("ses_rt011_first");

      const deleting = app.request(`/api/conversations/${convId}`, { method: "DELETE" });
      await gate.reached;

      // The real creation flow observes the now-absent S1 and binds a new S2.
      const binding = await ensureOpenCodeSession(convId);
      expect(binding.sessionId).not.toBe("ses_rt011_first");
      expect((await conversationService.get(convId))?.opencodeSessionId).toBe(binding.sessionId);

      gate.release();
      const res = await deleting;

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "session_rebound" });

      const after = await conversationService.get(convId);
      expect(after?.opencodeSessionId).toBe(binding.sessionId);
      // S1's removal was confirmed, so its duty was preserved as an audit
      // marker; the request never touched S2.
      expect(fake.sessions.has(binding.sessionId)).toBe(true);
      expect(fake.calls).not.toContain(`remove:${binding.sessionId}`);
      expect(journalRow(convId, "ses_rt011_first")?.phase).toBe("delete");
    } finally {
      manager.ensureBaseUrl = real;
      fake.stop();
      await conversationService.delete(convId);
    }
  }, 30_000);
});
