/**
 * Detached completed-run history finalization.
 *
 * The connected client persists through the assistant-ui `ThreadHistoryAdapter`
 * (`web/src/adapters/threadHistoryAdapter.ts`), which stays the normal path and is
 * NOT reimplemented here. This suite covers only the durable fallback: a run that
 * completes with no browser attached has nobody to write the reply, so the server
 * must write it exactly once, in the SAME persisted shape the adapter uses, under
 * the SAME message id.
 *
 * What is asserted here is the TRIGGER (attached vs detached, completed vs failed
 * vs cancelled) driven through the real route with a controlled provider. The
 * idempotency and race guarantees are asserted against the same store and the
 * same `messageService` in the lower suites, because a browser/server write race
 * cannot be staged deterministically over HTTP — asserting it through the route
 * would only prove the test's own timing.
 *
 * Covered:
 *   1. an ATTACHED completion is left to the browser: the server writes nothing;
 *   2. a DETACHED completion is finalized server-side into exactly one row;
 *   3. the persisted row keeps the exact assistant message id the run produced;
 *   4. the persisted shape is the adapter's: `format='ai-sdk/v6'`, the id in the
 *      row and NOT inside `content`;
 *   5. `parent_id` is the user message the run continued;
 *   6. a detached FAILED run finalizes nothing (partial output is not a reply);
 *   7. a detached CANCELLED run finalizes nothing;
 *   8. the durable row records the finalization state honestly.
 *
 * DB isolation: tests/setup.ts (bunfig preload) redirects DATA_DIR to tmp.
 */
import { describe, it, expect, afterAll, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import type { SQLQueryBindings } from "bun:sqlite";
import { RESUMABLE_STREAM_ID_HEADER } from "assistant-stream/resumable";
import { db } from "../../src/db";
import { registry } from "../../src/config/providers";
import { conversationService, messageService } from "../../src/services/storage";
import { chatRuns } from "../../src/services/chat-runs";
import { chatStreamStore } from "../../src/lib/resumable";
import {
  chatHistoryFinalizerDeps,
  finalizeDetachedRunHistory,
} from "../../src/services/chat-streams/historyFinalizer";
import { logger, type LogEntry } from "../../src/lib/logger";
import chatApp from "../../src/routes/chat";

const app = new Hono();
app.route("/", chatApp);

const JSON_HEADERS = { "Content-Type": "application/json" };

// ── Markers ──────────────────────────────────────────────────────────────────
const USER_TEXT_MARKER = "DETACHED_HISTORY_USER_TEXT_MARKER";
const ANSWER_TEXT_MARKER = "DETACHED_HISTORY_ANSWER_TEXT_MARKER";
const PROVIDER_ERROR_MARKER = "DETACHED_HISTORY_PROVIDER_ERROR_MARKER";

const PROVIDER_ID = "prov-detached-history";
const MODEL_ID = "void-model";
const USER_MESSAGE_ID = "msg-detached-history-user-1";

// ── Controlled OpenAI-compatible provider ────────────────────────────────────
/** Park after the first delta so a test can detach the client mid-stream. */
type StreamBehavior = "gated-then-complete" | "gated-then-error";
let behavior: StreamBehavior = "gated-then-complete";
let gate: { promise: Promise<void>; open: () => void } | null = null;

function armGate(): Promise<void> {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  gate = { promise, open };
  return promise;
}

let captured: Array<{ path: string; body: Record<string, unknown> }> = [];
let controlled: ReturnType<typeof Bun.serve> | null = null;

function chatCompletionChunk(delta: unknown, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-detached-history",
    object: "chat.completion.chunk",
    created: 0,
    model: MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function controlledResponse(): Response {
  const encoder = new TextEncoder();
  let stage = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (stage === 0) {
        stage = 1;
        controller.enqueue(
          encoder.encode(
            chatCompletionChunk({ role: "assistant", content: ANSWER_TEXT_MARKER }),
          ),
        );
        return;
      }
      if (stage !== 1) return;
      stage = 2;
      await gate?.promise;
      if (behavior === "gated-then-error") {
        controller.error(new Error(PROVIDER_ERROR_MARKER));
        return;
      }
      controller.enqueue(encoder.encode(chatCompletionChunk({}, "stop")));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

function startControlledProvider(): string {
  captured = [];
  controlled = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      captured.push({ path: url.pathname, body });
      return controlledResponse();
    },
  });
  controlled.unref();
  return `http://127.0.0.1:${controlled.port}`;
}

async function seedControlledProvider(): Promise<void> {
  const endpoint = startControlledProvider();
  db.run(
    `INSERT OR REPLACE INTO provider_configs
       (id, name, type, encrypted_api_key, credential_version, endpoint, model, models, thinking, api_protocol, is_active, created_at, updated_at)
     VALUES (?, 'detached-history', 'ollama', NULL, NULL, ?, ?, '[]', 'off', 'chat-completions', 1, ?, ?)`,
    [PROVIDER_ID, endpoint, MODEL_ID, Date.now(), Date.now()],
  );
  await registry.loadFromDb(db);
}

function stopControlledProvider(): void {
  try {
    controlled?.stop(true);
  } catch {
    /* already closed */
  }
  controlled = null;
  captured = [];
  gate = null;
}

afterAll(async () => {
  stopControlledProvider();
  db.run("DELETE FROM provider_configs WHERE id = ?", [PROVIDER_ID]);
  await registry.loadFromDb(db);
});

// ── Per-test isolation ───────────────────────────────────────────────────────
beforeEach(() => {
  captured = [];
  behavior = "gated-then-complete";
  gate = null;
  logger.configure({ level: "debug", targets: [], file: null, fileEnabled: false });
});
afterEach(() => {
  stopControlledProvider();
  logger.configure({ level: "error", targets: [], file: null, fileEnabled: false });
});

// ── Helpers ──────────────────────────────────────────────────────────────────
function userMessage(text: string): Record<string, unknown> {
  return { id: USER_MESSAGE_ID, role: "user", parts: [{ type: "text", text }] };
}

async function createDirectConversation(title: string): Promise<string> {
  const conv = await conversationService.create({
    title,
    providerId: PROVIDER_ID,
    modelId: MODEL_ID,
    reasoningLevel: null,
    systemPrompt: null,
    engine: "direct",
  });
  return conv.id;
}

async function postChat(body: Record<string, unknown>): Promise<Response> {
  return app.request("/api/chat", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

function streamIdOf(res: Response): string {
  const id = res.headers.get(RESUMABLE_STREAM_ID_HEADER);
  if (!id) throw new Error("response carried no resumable stream id");
  return id;
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function awaitRunSettled(streamId: string, timeoutMs = 10000): Promise<string> {
  const record = chatRuns.get(streamId);
  if (!record) throw new Error(`no run record for ${streamId}`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<"timeout">((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  (timer as unknown as { unref?: () => void }).unref?.();
  const winner = await Promise.race([record.settled.then(() => "settled" as const), bound]);
  if (timer) clearTimeout(timer);
  if (winner !== "settled") throw new Error(`run ${streamId} never settled`);
  return chatRuns.get(streamId)?.status ?? "missing";
}

function logEntriesSince(since: number): LogEntry[] {
  return logger.getRecentEntries(since);
}

interface StoredRow {
  id: string;
  parent_id: string | null;
  format: string;
  content: unknown;
}

async function storedRows(conversationId: string): Promise<StoredRow[]> {
  return messageService.listThreadMessages(conversationId);
}

/** The assistant row a server finalization produced, or null. */
async function assistantRow(
  conversationId: string,
): Promise<(StoredRow & { content: { role?: string } }) | null> {
  const rows = await storedRows(conversationId);
  const found = rows.find((r) => (r.content as { role?: string })?.role === "assistant");
  return (found as (StoredRow & { content: { role?: string } }) | undefined) ?? null;
}

function historyStateOf(streamId: string): string {
  return chatStreamStore.getRunContext(streamId)?.historyState ?? "absent";
}

/** The row's position in the thread, so a second write can be shown not to move it. */
function orderSeqOf(conversationId: string, messageId: string): number | null {
  const row = db
    .query<{ order_seq: number }, SQLQueryBindings[]>(
      "SELECT order_seq FROM messages WHERE conversation_id = ? AND id = ?",
    )
    .get(conversationId, messageId);
  return row?.order_seq ?? null;
}

/**
 * Run one request to completion with the client ATTACHED and the whole body
 * consumed, which is what a real browser does.
 */
async function runAttached(conversationId: string): Promise<{ streamId: string; body: string }> {
  armGate();
  const res = await postChat({
    providerId: PROVIDER_ID,
    model: MODEL_ID,
    id: conversationId,
    messages: [userMessage(USER_TEXT_MARKER)],
  });
  expect(res.status).toBe(200);
  const streamId = streamIdOf(res);
  await waitFor(() => captured.length >= 1, "the provider request");
  gate?.open();
  const body = await res.text();
  await awaitRunSettled(streamId);
  return { streamId, body };
}

/**
 * Run one request to completion with the client DETACHED mid-stream, which is
 * the only window in which "the connection went away and the run kept going" is
 * a real observation rather than a race.
 */
async function runDetached(
  conversationId: string,
  runBehavior: StreamBehavior,
): Promise<{ streamId: string; assistantMessageId: string | null }> {
  armGate();
  behavior = runBehavior;
  const res = await postChat({
    providerId: PROVIDER_ID,
    model: MODEL_ID,
    id: conversationId,
    messages: [userMessage(USER_TEXT_MARKER)],
  });
  expect(res.status).toBe(200);
  const streamId = streamIdOf(res);

  await waitFor(() => captured.length >= 1, "the provider request");
  // Read the first frames so the assistant message id is observed from the wire
  // (the `start` part carries it), exactly as a browser would learn it.
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  let assistantMessageId: string | null = null;
  while (assistantMessageId === null && seen.length < 8192) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += decoder.decode(value, { stream: true });
    for (const line of seen.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice("data:".length).trim();
      if (!raw || raw === "[DONE]") continue;
      try {
        const frame = JSON.parse(raw) as { type?: string; messageId?: string };
        if (frame.type === "start" && typeof frame.messageId === "string") {
          assistantMessageId = frame.messageId;
        }
      } catch {
        /* partial frame; the next read completes it */
      }
    }
  }

  await reader.cancel();
  await waitFor(() => chatRuns.get(streamId)?.detachedAt !== null, "the run's detached mark");
  expect(chatRuns.get(streamId)?.status).toBe("running");

  gate?.open();
  await awaitRunSettled(streamId);
  return { streamId, assistantMessageId };
}

// ── 1. An attached completion stays the browser's job ─────────────────────────
describe("Detached history finalization — attached completion", () => {
  it("writes no assistant message server-side: the connected client owns persistence", async () => {
    await seedControlledProvider();
    const conversationId = await createDirectConversation("detached-history-attached");

    try {
      const { streamId, body } = await runAttached(conversationId);

      // The run really did complete, and the client really did consume it.
      expect(chatRuns.get(streamId)?.status).toBe("completed");
      expect(body).toContain(ANSWER_TEXT_MARKER);
      expect(chatRuns.get(streamId)?.detachedAt).toBeNull();

      // Nothing was written server-side, and the row is still `pending`: this
      // finalization path is only for runs nobody was there to persist.
      expect(await assistantRow(conversationId)).toBeNull();
      expect(historyStateOf(streamId)).toBe("pending");
    } finally {
      await conversationService.delete(conversationId);
    }
  }, 30000);
});

// ── 2. A detached completion is finalized server-side ─────────────────────────
describe("Detached history finalization — detached completion", () => {
  it("persists the completed assistant message exactly once when no browser was attached", async () => {
    await seedControlledProvider();
    const conversationId = await createDirectConversation("detached-history-detached");
    const since = logger.lastSeq;

    try {
      const { streamId } = await runDetached(conversationId, "gated-then-complete");
      expect(chatRuns.get(streamId)?.status).toBe("completed");

      const row = await assistantRow(conversationId);
      expect(row).not.toBeNull();
      // Exactly one row, not an append per part or per callback.
      const assistantRows = (await storedRows(conversationId)).filter(
        (r) => (r.content as { role?: string })?.role === "assistant",
      );
      expect(assistantRows.length).toBe(1);
      expect(historyStateOf(streamId)).toBe("done");

      const finalized = logEntriesSince(since).filter((e) => e.event === "chat_history_finalized");
      expect(finalized.length).toBe(1);
    } finally {
      await conversationService.delete(conversationId);
    }
  }, 30000);

  it("keeps the exact assistant message id the run produced, under the adapter's shape", async () => {
    await seedControlledProvider();
    const conversationId = await createDirectConversation("detached-history-identity");

    try {
      const { streamId, assistantMessageId } = await runDetached(
        conversationId,
        "gated-then-complete",
      );
      expect(assistantMessageId).toBeTruthy();

      const row = await assistantRow(conversationId);
      expect(row).not.toBeNull();
      // The id the run minted is the id the row carries: it is the durable
      // idempotency key both writers share.
      expect(row!.id).toBe(assistantMessageId);
      expect(chatStreamStore.getRunContext(streamId)?.historyMessageId).toBe(assistantMessageId);

      // The adapter's persisted shape: the format string it writes, the id in the
      // row, and the message body WITHOUT the id (aiSDKV6FormatAdapter.encode).
      expect(row!.format).toBe("ai-sdk/v6");
      const content = row!.content as Record<string, unknown>;
      expect(content.id).toBeUndefined();
      expect(content.role).toBe("assistant");
      expect(Array.isArray(content.parts)).toBe(true);
      const text = (content.parts as Array<{ type: string; text?: string }>)
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("");
      expect(text).toContain(ANSWER_TEXT_MARKER);

      // The reply chains onto the user message the run continued.
      expect(row!.parent_id).toBe(USER_MESSAGE_ID);
    } finally {
      await conversationService.delete(conversationId);
    }
  }, 30000);

  it("records the run's own metadata on the stream row so finalization never depends on memory", async () => {
    await seedControlledProvider();
    const conversationId = await createDirectConversation("detached-history-binding");

    try {
      const { streamId } = await runDetached(conversationId, "gated-then-complete");
      const context = chatStreamStore.getRunContext(streamId);
      expect(context?.conversationId).toBe(conversationId);
      expect(context?.providerId).toBe(PROVIDER_ID);
      expect(context?.modelId).toBe(MODEL_ID);
      expect(context?.requestId).toBeTruthy();
    } finally {
      await conversationService.delete(conversationId);
    }
  }, 30000);
});

// ── 6. Resume: unchanged protocol, honest observability ──────────────────────
describe("Resume endpoint — contract and observability", () => {
  it("replays a finished run and records ai.resume with both axes, without changing the response", async () => {
    await seedControlledProvider();
    const conversationId = await createDirectConversation("detached-history-resume");
    const since = logger.lastSeq;

    try {
      const { streamId } = await runAttached(conversationId);

      const res = await app.request(`/api/chat/resume/${streamId}`);
      // The protocol is untouched: 200, the UI-stream headers, and the stream id.
      expect(res.status).toBe(200);
      expect(res.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
      expect(res.headers.get(RESUMABLE_STREAM_ID_HEADER)).toBe(streamId);
      const body = await res.text();
      expect(body).toContain(ANSWER_TEXT_MARKER);

      const entries = logEntriesSince(since).filter((e) => e.event === "ai.resume");
      expect(entries.length).toBe(1);
      const entry = entries[0];
      expect(entry.streamId).toBe(streamId);
      expect(entry.outcome).toBe("replayed");
      expect(entry.status).toBe("done");
      expect(entry.terminalKind).toBe("completed");
      expect(entry.restarted).toBe(false);
      expect(typeof entry.chunkCount).toBe("number");
    } finally {
      await conversationService.delete(conversationId);
    }
  }, 30000);

  it("still answers 404 for an unknown stream, and says so", async () => {
    const since = logger.lastSeq;
    const res = await app.request("/api/chat/resume/stream_that_never_existed");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("stream not found");

    const entries = logEntriesSince(since).filter((e) => e.event === "ai.resume");
    expect(entries.length).toBe(1);
    expect(entries[0].outcome).toBe("missing");
    expect(entries[0].status).toBe("missing");
  }, 30000);

  it("re-attaching a detached run clears the detached mark", async () => {
    await seedControlledProvider();
    const conversationId = await createDirectConversation("detached-history-reattach");

    try {
      armGate();
      const res = await postChat({
        providerId: PROVIDER_ID,
        model: MODEL_ID,
        id: conversationId,
        messages: [userMessage(USER_TEXT_MARKER)],
      });
      expect(res.status).toBe(200);
      const streamId = streamIdOf(res);
      await waitFor(() => captured.length >= 1, "the provider request");

      await res.body!.cancel();
      await waitFor(() => chatRuns.get(streamId)?.detachedAt !== null, "the detached mark");

      // The client comes back before the run finishes, so the reply it is waiting
      // for WILL be persisted by the browser: re-attaching must suppress the
      // server-side fallback. The resumed body is left unread — it stays open
      // until the producer finishes, so consuming it here would deadlock on the
      // gate this test has not opened yet.
      const resumed = await app.request(`/api/chat/resume/${streamId}`);
      expect(resumed.status).toBe(200);
      expect(chatRuns.get(streamId)?.detachedAt).toBeNull();
      await resumed.body?.cancel();

      gate?.open();
      expect(await awaitRunSettled(streamId)).toBe("completed");
      expect(await assistantRow(conversationId)).toBeNull();
      expect(historyStateOf(streamId)).toBe("pending");
    } finally {
      gate = null;
      await conversationService.delete(conversationId);
    }
  }, 30000);
});

// ── 7. Durable stream status (the client's only safe Retry gate) ──────────────
describe("Stream status endpoint — the client's durable question", () => {
  interface StatusRun {
    streamId: string;
    status: string;
    terminalKind: string | null;
    restarted: boolean;
    historyState: string | null;
    chunkCount: number;
  }
  const readByConversation = async (conversationId: string) => {
    const res = await app.request(
      `/api/chat/stream-status?conversationId=${encodeURIComponent(conversationId)}`,
    );
    return { status: res.status, body: (await res.json()) as { run: StatusRun | null } };
  };
  const readByStream = async (streamId: string) => {
    const res = await app.request(
      `/api/chat/stream-status?streamId=${encodeURIComponent(streamId)}`,
    );
    return { status: res.status, body: (await res.json()) as { run: StatusRun | null } };
  };

  it("answers by CONVERSATION, which is how a client with no pointer recovers", async () => {
    await seedControlledProvider();
    const conversationId = await createDirectConversation("status-by-conversation");
    try {
      const { streamId } = await runAttached(conversationId);
      const { status, body } = await readByConversation(conversationId);
      expect(status).toBe(200);
      // The client asked only about the conversation and still learned the run.
      expect(body.run).not.toBeNull();
      expect(body.run!.streamId).toBe(streamId);
      expect(body.run!.status).toBe("done");
      expect(body.run!.terminalKind).toBe("completed");
      expect(body.run!.restarted).toBe(false);
      expect(body.run!.historyState).toBe("pending");
      expect(typeof body.run!.chunkCount).toBe("number");
    } finally {
      await conversationService.delete(conversationId);
    }
  }, 30000);

  it("reports a detached completed run with its history state", async () => {
    await seedControlledProvider();
    const conversationId = await createDirectConversation("status-detached-done");
    try {
      await runDetached(conversationId, "gated-then-complete");
      const { body } = await readByConversation(conversationId);
      expect(body.run!.terminalKind).toBe("completed");
      expect(body.run!.historyState).toBe("done");
    } finally {
      await conversationService.delete(conversationId);
    }
  }, 30000);

  it("reports a failed run as failed, never as interrupted", async () => {
    await seedControlledProvider();
    const conversationId = await createDirectConversation("status-failed");
    try {
      await runDetached(conversationId, "gated-then-error");
      const { body } = await readByConversation(conversationId);
      expect(body.run!.terminalKind).toBe("failed");
    } finally {
      await conversationService.delete(conversationId);
    }
  }, 30000);

  it("still answers by stream id for a caller that holds one", async () => {
    await seedControlledProvider();
    const conversationId = await createDirectConversation("status-by-stream");
    try {
      const { streamId } = await runAttached(conversationId);
      const { body } = await readByStream(streamId);
      expect(body.run!.streamId).toBe(streamId);
    } finally {
      await conversationService.delete(conversationId);
    }
  }, 30000);

  it("reports no run as a 200 with a null run, not an error", async () => {
    // A thread that was never answered is normal, and a client must be able to
    // tell it apart from a run it failed to read.
    const conversationId = await createDirectConversation("status-never-ran");
    try {
      const { status, body } = await readByConversation(conversationId);
      expect(status).toBe(200);
      expect(body.run).toBeNull();
    } finally {
      await conversationService.delete(conversationId);
    }
  }, 30000);

  it("rejects a missing, doubled, or malformed selector", async () => {
    const none = await app.request("/api/chat/stream-status");
    expect(none.status).toBe(400);
    // Exactly one: two selectors would make "which run?" ambiguous, and a client
    // deciding on a Retry must never be guessing.
    const both = await app.request("/api/chat/stream-status?streamId=a&conversationId=b");
    expect(both.status).toBe(400);
    const malformed = await app.request("/api/chat/stream-status?streamId=");
    expect(malformed.status).toBe(400);
  }, 30000);
});

// ── 4. Browser and server writes converge on one row ─────────────────────────
// A browser/server write race cannot be staged deterministically over HTTP — it
// would only prove the test's own timing — so these cases drive the real store
// and the real `messageService` directly, which is exactly what both writers use.
describe("History finalization — browser/server convergence", () => {
  /**
   * A durable row in the state a completed run leaves behind: verdict recorded,
   * conversation bound, history still pending. `streamId` is server-minted.
   */
  async function completedStreamRow(
    conversationId: string,
    messageId: string,
  ): Promise<string> {
    const streamId = `stream_conv_${messageId}`;
    await chatStreamStore.acquireLease(streamId);
    await chatStreamStore.append(streamId, new TextEncoder().encode('{"type":"finish"}'));
    chatStreamStore.recordRunVerdict(streamId, "completed", { finishReason: "stop" });
    chatStreamStore.bindRunContext(streamId, { conversationId, requestId: "req_test" });
    return streamId;
  }

  const browserWrite = async (
    conversationId: string,
    messageId: string,
    parentId: string,
  ) => {
    // Exactly what the assistant-ui adapter posts: the id in the entry, the
    // message body without it.
    await messageService.upsertStored(conversationId, {
      id: messageId,
      parent_id: parentId,
      format: "ai-sdk/v6",
      content: { role: "assistant", parts: [{ type: "text", text: ANSWER_TEXT_MARKER, state: "done" }] },
    });
  };

  const finalize = (streamId: string, messageId: string, conversationId: string) =>
    finalizeDetachedRunHistory(chatHistoryFinalizerDeps, {
      streamId,
      responseMessage: {
        id: messageId,
        role: "assistant",
        parts: [{ type: "text", text: ANSWER_TEXT_MARKER, state: "done" }],
      },
      isAborted: false,
      parentId: USER_MESSAGE_ID,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    }).then((outcome) => ({ outcome, conversationId }));

  it("converges to one row when the browser persisted first", async () => {
    const conversationId = await createDirectConversation("detached-history-browser-first");
    const messageId = "msg_assistant_browser_first";
    try {
      const streamId = await completedStreamRow(conversationId, messageId);
      await browserWrite(conversationId, messageId, USER_MESSAGE_ID);
      const orderSeqBefore = orderSeqOf(conversationId, messageId);

      expect((await finalize(streamId, messageId, conversationId)).outcome).toBe("written");

      const rows = (await storedRows(conversationId)).filter((r) => r.id === messageId);
      expect(rows.length).toBe(1);
      // `ON CONFLICT(id) DO UPDATE` preserves order_seq, so the server's later
      // write cannot reorder a thread the browser already placed.
      expect(orderSeqOf(conversationId, messageId)).toBe(orderSeqBefore);
    } finally {
      await conversationService.delete(conversationId);
    }
  }, 30000);

  it("converges to one row when the server persisted first and the browser follows", async () => {
    const conversationId = await createDirectConversation("detached-history-server-first");
    const messageId = "msg_assistant_server_first";
    try {
      const streamId = await completedStreamRow(conversationId, messageId);
      expect((await finalize(streamId, messageId, conversationId)).outcome).toBe("written");
      const orderSeqAfterServer = orderSeqOf(conversationId, messageId);

      // The browser now catches up — e.g. the user reconnected and the runtime
      // re-persisted the message it holds.
      await browserWrite(conversationId, messageId, USER_MESSAGE_ID);

      const rows = (await storedRows(conversationId)).filter((r) => r.id === messageId);
      expect(rows.length).toBe(1);
      expect(orderSeqOf(conversationId, messageId)).toBe(orderSeqAfterServer);
    } finally {
      await conversationService.delete(conversationId);
    }
  }, 30000);

  it("stays at one row when the same run is finalized repeatedly and concurrently", async () => {
    const conversationId = await createDirectConversation("detached-history-repeat");
    const messageId = "msg_assistant_repeat";
    try {
      const streamId = await completedStreamRow(conversationId, messageId);

      const outcomes = await Promise.all([
        finalize(streamId, messageId, conversationId),
        finalize(streamId, messageId, conversationId),
        finalize(streamId, messageId, conversationId),
      ]);
      // Then again, sequentially — a duplicate callback or a lifecycle hook that
      // fires twice must change nothing.
      outcomes.push(await finalize(streamId, messageId, conversationId));
      outcomes.push(await finalize(streamId, messageId, conversationId));

      expect(outcomes.filter((o) => o.outcome === "written").length).toBe(1);
      expect(outcomes.filter((o) => o.outcome === "not_claimed").length).toBe(4);
      const rows = (await storedRows(conversationId)).filter((r) => r.id === messageId);
      expect(rows.length).toBe(1);
      expect(historyStateOf(streamId)).toBe("done");
    } finally {
      await conversationService.delete(conversationId);
    }
  }, 30000);

  it("finalizes a completed run observed durably, without a live run record", async () => {
    const conversationId = await createDirectConversation("detached-history-no-run-record");
    const messageId = "msg_assistant_durable_only";
    try {
      // No chatRuns entry exists for this stream: finalization depends on the
      // durable row alone, which is what survives a process restart.
      const streamId = await completedStreamRow(conversationId, messageId);
      expect(chatRuns.get(streamId)).toBeUndefined();

      expect((await finalize(streamId, messageId, conversationId)).outcome).toBe("written");
      const row = (await storedRows(conversationId)).find((r) => r.id === messageId);
      expect(row).toBeDefined();
      expect(row?.parent_id).toBe(USER_MESSAGE_ID);
      expect((row?.content as { id?: unknown }).id).toBeUndefined();
      expect(row?.format).toBe("ai-sdk/v6");
    } finally {
      await conversationService.delete(conversationId);
    }
  }, 30000);
});

// ── 5. Only a completed run is ever finalized ────────────────────────────────
describe("Detached history finalization — non-completed runs", () => {
  it("writes nothing for a detached run that FAILED after the client left", async () => {
    await seedControlledProvider();
    const conversationId = await createDirectConversation("detached-history-failed");
    const since = logger.lastSeq;

    try {
      const { streamId } = await runDetached(conversationId, "gated-then-error");
      expect(chatRuns.get(streamId)?.status).toBe("failed");

      // Partial output is not a reply the user asked to keep, and the run's own
      // verdict must agree: no finalization, no message row.
      expect(await assistantRow(conversationId)).toBeNull();
      expect(historyStateOf(streamId)).toBe("pending");
      expect(logEntriesSince(since).filter((e) => e.event === "chat_history_finalized").length).toBe(
        0,
      );
    } finally {
      await conversationService.delete(conversationId);
    }
  }, 30000);

  it("writes nothing for a run cancelled through the cancel endpoint", async () => {
    await seedControlledProvider();
    const conversationId = await createDirectConversation("detached-history-cancelled");

    try {
      armGate();
      const res = await postChat({
        providerId: PROVIDER_ID,
        model: MODEL_ID,
        id: conversationId,
        messages: [userMessage(USER_TEXT_MARKER)],
      });
      expect(res.status).toBe(200);
      const streamId = streamIdOf(res);
      await waitFor(() => captured.length >= 1, "the provider request");

      // Detach, then cancel explicitly — the other terminal verdict a detached run
      // can reach. `onAbort` cannot finalize either: the endpoint settles the run
      // first, so the abort handler observes a terminal record and no-ops.
      await res.body!.cancel();
      await waitFor(() => chatRuns.get(streamId)?.detachedAt !== null, "the detached mark");
      const cancelled = await app.request(`/api/chat/cancel/${streamId}`, { method: "POST" });
      expect(cancelled.status).toBe(200);
      gate?.open();
      expect(await awaitRunSettled(streamId)).toBe("cancelled");

      expect(await assistantRow(conversationId)).toBeNull();
    } finally {
      await conversationService.delete(conversationId);
    }
  }, 30000);
});
