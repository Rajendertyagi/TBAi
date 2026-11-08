/**
 * A failed run's error must survive the round trip to SQLite and back.
 *
 * The live stream shows a sanitized provider error through the message's
 * `status`. That status is NOT persistable: the assistant-ui AI SDK converter
 * drops an assistant status on the way in, so a status-only record would be gone
 * on the next load. The chat route therefore stores the very same text as
 * message metadata (`metadata.error`), and the browser reads it back as
 * `metadata.custom.error`.
 *
 * These cases assert the part that is easy to get subtly wrong: the string that
 * comes back out of the database is byte-for-byte the string
 * `sanitizeStreamError` produced — not a re-sanitized, re-worded, or empty copy.
 * They drive the real writer and the real storage functions, so the assertion is
 * about what a reload actually sees.
 *
 * DB isolation: tests/setup.ts (bunfig preload) redirects DATA_DIR to tmp.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { db } from "@/db";
import { sanitizeStreamError } from "@/lib/redact.ts";
import {
  buildFailedRunMessage,
  failedRunHistoryDeps,
  persistFailedRunMessage,
} from "@/services/chat-streams/historyFinalizer.ts";
import {
  conversationService,
  getStoredMessageSync,
  messageService,
  upsertStoredSync,
} from "@/services/storage";
import { pruneStaleMessages } from "@/lib/prune-messages.ts";
import conversationsApp from "@/routes/conversations.ts";
import { conversationInput } from "../../helpers/conversation-fixtures";

const app = new Hono();
app.route("/", conversationsApp);

const JSON_HEADERS = { "Content-Type": "application/json" };
const FORMAT = "ai-sdk/v6";
const TITLE = "failed-run-error";

/** A provider failure the classifier reads as billing exhaustion. */
const OUT_OF_CREDITS = new Error("Your credit balance is too low to access the model.");

/** The exact string the route stores — never re-derived in these tests. */
const ERROR_TEXT = sanitizeStreamError(OUT_OF_CREDITS);

async function conversation(title: string): Promise<string> {
  const conv = await conversationService.create(
    conversationInput({
      title,
      providerId: "p1",
      modelId: "m1",
      reasoningLevel: null,
      systemPrompt: null,
      engine: "direct",
    }),
  );
  return conv.id;
}

function seedUserMessage(conversationId: string, id = "u1"): void {
  upsertStoredSync(conversationId, {
    id,
    parent_id: null,
    format: FORMAT,
    content: { role: "user", parts: [{ type: "text", text: "hello" }] },
  });
}

function failedTurn(id: string, parts: unknown[] = []) {
  return buildFailedRunMessage({ id, role: "assistant", parts }, ERROR_TEXT);
}

async function postMessage(
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

describe("failed-run error persistence", () => {
  let conversationId = "";

  beforeEach(async () => {
    // The seeded ids are fixed, and a message id belongs to exactly one
    // conversation, so the previous test's row must go before the next seeds.
    for (const row of db
      .query<{ id: string }, [string]>("SELECT id FROM conversations WHERE title = ?")
      .all(TITLE)) {
      await conversationService.delete(row.id);
    }
    conversationId = await conversation(TITLE);
  });

  it("produces a billing copy, so the assertions below are about real sanitized output", () => {
    expect(ERROR_TEXT).toBe("Provider credit or quota exhausted. Check the provider's billing.");
  });

  it("stores the exact sanitized string and reads it back unchanged", () => {
    seedUserMessage(conversationId);

    const outcome = persistFailedRunMessage(failedRunHistoryDeps, {
      conversationId,
      message: failedTurn("a1"),
      isAborted: false,
      parentId: "u1",
    });

    expect(outcome).toBe("written");
    const stored = getStoredMessageSync(conversationId, "a1");
    expect(stored?.parentId).toBe("u1");
    expect(JSON.stringify(stored?.content)).toContain(ERROR_TEXT);
    const content = stored?.content as { metadata?: { error?: unknown } } | undefined;
    expect(content?.metadata?.error).toBe(ERROR_TEXT);
  });

  it("is visible in the history window a reload walks", async () => {
    seedUserMessage(conversationId);
    persistFailedRunMessage(failedRunHistoryDeps, {
      conversationId,
      message: failedTurn("a1"),
      isAborted: false,
      parentId: "u1",
    });

    const slice = await messageService.getWindowSlice(conversationId, {
      direction: "older",
      anchorId: null,
      limit: 10,
    });

    expect(slice.contiguous).toBe(true);
    const failed = slice.messages.find((m) => m.id === "a1");
    expect(failed?.parent_id).toBe("u1");
    const failedContent = failed?.content as { metadata?: { error?: unknown } } | undefined;
    expect(failedContent?.metadata?.error).toBe(ERROR_TEXT);
  });

  it("persists a turn that produced no parts at all (the out-of-credits case)", () => {
    seedUserMessage(conversationId);

    const outcome = persistFailedRunMessage(failedRunHistoryDeps, {
      conversationId,
      message: failedTurn("a1", []),
      isAborted: false,
      parentId: "u1",
    });

    expect(outcome).toBe("written");
    const content = getStoredMessageSync(conversationId, "a1")?.content as {
      parts?: unknown[];
      metadata?: { error?: unknown };
    };
    expect(content.parts).toEqual([]);
    expect(content.metadata?.error).toBe(ERROR_TEXT);
  });

  it("refuses a parent that does not resolve, so the chain cannot be truncated", () => {
    // Only the assistant turn exists; its parent was never stored.
    const outcome = persistFailedRunMessage(failedRunHistoryDeps, {
      conversationId,
      message: failedTurn("a1"),
      isAborted: false,
      parentId: "never_stored",
    });

    expect(outcome).toBe("conflicted");
    expect(getStoredMessageSync(conversationId, "a1")).toBeNull();
  });

  it("does not persist an aborted run", () => {
    seedUserMessage(conversationId);

    const outcome = persistFailedRunMessage(failedRunHistoryDeps, {
      conversationId,
      message: failedTurn("a1"),
      isAborted: true,
      parentId: "u1",
    });

    expect(outcome).toBe("skipped");
    expect(getStoredMessageSync(conversationId, "a1")).toBeNull();
  });

  it("refuses a client write that would erase the stored error", async () => {
    seedUserMessage(conversationId);
    persistFailedRunMessage(failedRunHistoryDeps, {
      conversationId,
      message: failedTurn("a1"),
      isAborted: false,
      parentId: "u1",
    });

    // Exactly what the browser posts for the message it streamed: the same id,
    // the same parent, and no error — the client never holds the text as data.
    const overwrite = await postMessage(conversationId, {
      id: "a1",
      parent_id: "u1",
      format: FORMAT,
      content: { role: "assistant", parts: [{ type: "text", text: "partial" }] },
    });

    expect(overwrite.status).toBe(200);
    expect(overwrite.body.persisted).toBe(false);
    const afterOverwrite = getStoredMessageSync(conversationId, "a1")?.content as
      | { metadata?: { error?: unknown } }
      | undefined;
    expect(afterOverwrite?.metadata?.error).toBe(ERROR_TEXT);
  });

  it("still accepts an ordinary client write, so the guard is not a blanket refusal", async () => {
    seedUserMessage(conversationId);

    const write = await postMessage(conversationId, {
      id: "a2",
      parent_id: "u1",
      format: FORMAT,
      content: { role: "assistant", parts: [{ type: "text", text: "a real answer" }] },
    });

    expect(write.status).toBe(200);
    expect(write.body.persisted).toBe(true);
  });

  it("keeps a zero-part failed turn out of model-visible history", () => {
    // An error is not a model turn: the pruner drops a contentless assistant
    // message, so a retry cannot resend the failure as context.
    const pruned = pruneStaleMessages([
      { id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] },
      failedTurn("a1", []),
    ] as never);

    expect(pruned.messages.map((m) => m.id)).toEqual(["u1"]);
    expect(pruned.stats.removedEmptyTurns).toBe(1);
  });
});
