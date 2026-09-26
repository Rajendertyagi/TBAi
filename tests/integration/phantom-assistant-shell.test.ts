/**
 * The phantom-blank-bubble fix, exercised through the REAL messages route.
 *
 * Root cause: the client persists an assistant row the moment a run starts,
 * holding only TBAi's UI-only progress part. If the run then dies, nothing updates
 * that row, and it renders as a blank bubble forever. The fix refuses to persist
 * a message with nothing renderable in it, so the phantom is never created.
 *
 * These cases drive `POST /api/conversations/:id/messages` and then read history
 * back through `messageService`, so they assert what a reload would actually show
 * rather than what the route claimed.
 *
 * DB isolation: tests/setup.ts (bunfig preload) redirects DATA_DIR to tmp.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { conversationService, messageService } from "../../src/services/storage";
import { logger } from "../../src/lib/logger";
import conversationsApp from "../../src/routes/conversations";

const app = new Hono();
app.route("/", conversationsApp);

const JSON_HEADERS = { "Content-Type": "application/json" };
const FORMAT = "ai-sdk/v6";

/** The exact shell the client posts when a run starts and has produced nothing. */
const SHELL_CONTENT = {
  metadata: { custom: { providerId: "p1", modelId: "m1" } },
  role: "assistant",
  parts: [{ type: "data-tbai-progress", id: "progress", data: { kind: "tbai-progress", version: 1, stages: [] } }],
};

const TEXT_CONTENT = {
  metadata: { custom: { providerId: "p1", modelId: "m1" } },
  role: "assistant",
  parts: [
    { type: "step-start" },
    { type: "data-tbai-progress", id: "progress", data: { kind: "tbai-progress", version: 1, stages: [] } },
    { type: "text", text: "the real answer", state: "done" },
  ],
};

async function conversation(title: string): Promise<string> {
  const conv = await conversationService.create({
    title,
    providerId: "p1",
    modelId: "m1",
    reasoningLevel: null,
    systemPrompt: null,
    engine: "direct",
  });
  return conv.id;
}

async function post(
  conversationId: string,
  entry: { id: string; parent_id: string | null; format: string; content: unknown },
): Promise<{ status: number; body: { success?: boolean; persisted?: boolean } }> {
  const res = await app.request(`/api/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ message: entry }),
  });
  return { status: res.status, body: (await res.json()) as { persisted?: boolean } };
}

async function history(conversationId: string): Promise<Array<{ id: string; content: unknown }>> {
  return messageService.listThreadMessages(conversationId);
}

const shellEntry = (id: string, parent: string) => ({
  id,
  parent_id: parent,
  format: FORMAT,
  content: SHELL_CONTENT,
});

const textEntry = (id: string, parent: string) => ({
  id,
  parent_id: parent,
  format: FORMAT,
  content: TEXT_CONTENT,
});

beforeEach(() => {
  logger.configure({ level: "error", targets: [], file: null, fileEnabled: false });
});

describe("phantom shell — an interrupted run leaves no blank bubble", () => {
  it("never persists the shell, so an interrupted run has no assistant row at all", async () => {
    const id = await conversation("phantom-shell");
    try {
      // The user turn is always real history and must survive.
      await post(id, {
        id: "u1",
        parent_id: null,
        format: FORMAT,
        content: { role: "user", parts: [{ type: "text", text: "build a bridge" }] },
      });
      expect((await post(id, shellEntry("a1", "u1"))).body.persisted).toBe(false);

      // What a reload shows: the question, and no blank reply.
      const rows = await history(id);
      expect(rows.map((r) => r.id)).toEqual(["u1"]);
    } finally {
      await conversationService.delete(id);
    }
  });

  it("is a no-op when the run never produced a shell (requirement: no shell → no-op)", async () => {
    const id = await conversation("phantom-no-shell");
    try {
      const rows = await history(id);
      expect(rows).toEqual([]);
    } finally {
      await conversationService.delete(id);
    }
  });

  it("is idempotent: repeated shell posts never create a row (requirement: idempotent)", async () => {
    const id = await conversation("phantom-idempotent");
    try {
      for (let i = 0; i < 5; i++) {
        const res = await post(id, shellEntry("a1", "u1"));
        expect(res.status).toBe(200);
        expect(res.body.persisted).toBe(false);
      }
      expect(await history(id)).toEqual([]);
    } finally {
      await conversationService.delete(id);
    }
  });

  it("cannot be recreated by a reconnect (requirement: reconnect does not resurrect it)", async () => {
    const id = await conversation("phantom-reconnect");
    try {
      await post(id, shellEntry("a1", "u1"));
      // A reconnect re-syncs whatever the client still holds — the same shell.
      await post(id, shellEntry("a1", "u1"));
      await post(id, shellEntry("a1", "u1"));
      expect(await history(id)).toEqual([]);
    } finally {
      await conversationService.delete(id);
    }
  });
});

describe("phantom shell — real replies are never touched", () => {
  it("preserves a completed assistant reply, including its progress part", async () => {
    const id = await conversation("phantom-completed");
    try {
      await post(id, {
        id: "u1",
        parent_id: null,
        format: FORMAT,
        content: { role: "user", parts: [{ type: "text", text: "hi" }] },
      });
      expect((await post(id, textEntry("a1", "u1"))).body.persisted).toBe(true);

      const rows = await history(id);
      expect(rows.map((r) => r.id)).toEqual(["u1", "a1"]);
      // Stored verbatim — the guard is a write-time decision, not a rewrite.
      expect(rows[1].content).toEqual(TEXT_CONTENT);
    } finally {
      await conversationService.delete(id);
    }
  });

  it("preserves a failed run's meaningful partial assistant content", async () => {
    const id = await conversation("phantom-failed-partial");
    try {
      const partial = {
        role: "assistant",
        parts: [
          { type: "data-tbai-progress", id: "progress", data: { kind: "tbai-progress", version: 1, stages: [] } },
          { type: "text", text: "I started to explain that", state: "streaming" },
        ],
      };
      await post(id, { id: "a1", parent_id: "u1", format: FORMAT, content: partial });
      const rows = await history(id);
      expect(rows.length).toBe(1);
      expect(rows[0].content).toEqual(partial);
    } finally {
      await conversationService.delete(id);
    }
  });

  it("keeps a progress panel that actually rendered something", async () => {
    const id = await conversation("phantom-progress-shown");
    try {
      const shown = {
        role: "assistant",
        parts: [
          {
            type: "data-tbai-progress",
            id: "progress",
            data: {
              kind: "tbai-progress",
              version: 1,
              stages: [{ id: "s1", label: "Reading files", status: "completed" }],
            },
          },
        ],
      };
      await post(id, { id: "a1", parent_id: "u1", format: FORMAT, content: shown });
      expect((await history(id)).length).toBe(1);
    } finally {
      await conversationService.delete(id);
    }
  });

  it("keeps a tool-only assistant reply", async () => {
    const id = await conversation("phantom-tool-only");
    try {
      const toolOnly = {
        role: "assistant",
        parts: [
          { type: "step-start" },
          { type: "tool-read_file", toolCallId: "c1", state: "output-available", output: "x" },
        ],
      };
      await post(id, { id: "a1", parent_id: "u1", format: FORMAT, content: toolOnly });
      expect((await history(id)).length).toBe(1);
    } finally {
      await conversationService.delete(id);
    }
  });

  it("never drops a user turn", async () => {
    const id = await conversation("phantom-user");
    try {
      await post(id, {
        id: "u1",
        parent_id: null,
        format: FORMAT,
        content: { role: "user", parts: [{ type: "file", url: "data:x" }] },
      });
      const rows = await history(id);
      expect(rows.length).toBe(1);
      expect((rows[0].content as { role: string }).role).toBe("user");
    } finally {
      await conversationService.delete(id);
    }
  });
});

describe("phantom shell — the shell/reply race converges", () => {
  it("keeps the shell out and the real reply in, in any interleaving", async () => {
    const id = await conversation("phantom-race");
    try {
      // Shell and the reply that supersedes it race for the same message id.
      await post(id, shellEntry("a1", "u1"));
      await post(id, textEntry("a1", "u1"));
      // A late duplicate of the shell must not erase the real reply.
      await post(id, shellEntry("a1", "u1"));

      const rows = await history(id);
      expect(rows.length).toBe(1);
      expect(rows[0].content).toEqual(TEXT_CONTENT);
    } finally {
      await conversationService.delete(id);
    }
  });

  it("is outcome-agnostic: contentless is not persisted, whatever the run did", async () => {
    // The guard cannot read a run's fate — the shell is written while the run is
    // still in flight — so it applies the same rule to interrupted, failed and
    // cancelled alike. A meaningful reply is kept in every case; a contentless
    // one is never a reply.
    const id = await conversation("phantom-outcome-agnostic");
    try {
      for (const [i, content] of [
        SHELL_CONTENT,
        { role: "assistant", parts: [{ type: "step-start" }] },
        { role: "assistant", parts: [] },
      ].entries()) {
        const res = await post(id, {
          id: `a${i}`,
          parent_id: "u1",
          format: FORMAT,
          content,
        });
        expect(res.body.persisted).toBe(false);
      }
      expect(await history(id)).toEqual([]);
    } finally {
      await conversationService.delete(id);
    }
  });

  it("leaves server-side writers alone: a direct service write still persists", async () => {
    // Detached-run finalization and the scheduler call `messageService` directly.
    // The guard lives at the client boundary precisely so those are unaffected.
    const id = await conversation("phantom-internal-writer");
    try {
      await messageService.upsertStored(id, {
        id: "a-server",
        parent_id: "u1",
        format: FORMAT,
        content: { role: "assistant", parts: [{ type: "text", text: "from the server" }] },
      });
      const rows = await history(id);
      expect(rows.map((r) => r.id)).toEqual(["a-server"]);
    } finally {
      await conversationService.delete(id);
    }
  });
});
