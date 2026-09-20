/**
 * Conversation lifecycle correctness over the real route boundary.
 *
 * Pins the behaviours that were either wrong or unobservable before this phase:
 *   - a mutation against a MISSING row answers 404 (it used to be a 500 that
 *     read as "server fault, retry");
 *   - validation failures answer 400 with the issues returned STRUCTURALLY,
 *     not stringified into `error`;
 *   - the PATCH contract (omitted = preserve, null = clear, value = set) holds
 *     through route → validation → storage → readback;
 *   - delete reports whether a row actually existed (truthful teardown);
 *   - the lifecycle events (materialize / open / update / delete) exist, carry
 *     ids and enums, and NEVER carry user values such as the title.
 *
 * DB isolation: tests/setup.ts (bunfig preload) redirects DATA_DIR to tmp.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { logger } from "../../src/lib/logger";
import { ConversationNotFoundError, conversationService } from "../../src/services/storage";
import conversationsApp from "../../src/routes/conversations";

const app = new Hono();
app.route("/", conversationsApp);

const jsonHeaders = { "Content-Type": "application/json" };

async function call(path: string, init: RequestInit = {}) {
  const res = await app.request(path, init);
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, body };
}

const post = (body: unknown) =>
  call("/api/conversations", { method: "POST", headers: jsonHeaders, body: JSON.stringify(body) });
const patch = (id: string, body: unknown) =>
  call(`/api/conversations/${id}`, { method: "PATCH", headers: jsonHeaders, body: JSON.stringify(body) });
const del = (id: string) => call(`/api/conversations/${id}`, { method: "DELETE" });
const get = (id: string) => call(`/api/conversations/${id}`);

/** Lifecycle events emitted since a ring cursor. */
function eventsSince(since: number, event: string) {
  return logger.getRecentEntries(since).filter((e) => e.event === event);
}

const MISSING = "conversation_that_does_not_exist";

beforeEach(() => {
  // debug so the `conversation.open` probe line is captured too.
  logger.configure({ level: "debug", targets: [], file: null, fileEnabled: false });
});

afterEach(() => {
  // The logger is a process-wide singleton: restore the level or it leaks into
  // every other test file in this process.
  logger.configure({ level: "error", targets: [], file: null, fileEnabled: false });
});

describe("mutations against a missing conversation", () => {
  it("answers 404 (not a 500) and says so", async () => {
    const res = await patch(MISSING, { title: "x" });
    expect(res.status).toBe(404);
    // Same body shape as the GET 404 — one "not found" contract per module.
    expect(res.body).toEqual({ error: "Conversation not found" });
  });

  it("stays consistent with GET, which was already 404", async () => {
    expect((await get(MISSING)).status).toBe(404);
    expect((await patch(MISSING, { title: "x" })).status).toBe(404);
  });

  it("throws a typed error at the storage boundary", async () => {
    await expect(conversationService.update(MISSING, { title: "x" })).rejects.toBeInstanceOf(
      ConversationNotFoundError,
    );
  });
});

describe("validation failures are truthful and structural", () => {
  it("answers 400 with issues, not a stringified blob in `error`", async () => {
    const res = await patch(MISSING, { engine: "bogus" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request");
    expect(Array.isArray(res.body.issues)).toBe(true);
    expect(res.body.issues[0].path).toEqual(["engine"]);
  });

  it("validates before touching storage (a bad body on a missing id is 400)", async () => {
    expect((await patch(MISSING, { reasoningLevel: "extreme" })).status).toBe(400);
  });
});

describe("PATCH preserve / clear / set", () => {
  it("preserves omitted fields, clears explicit null, sets values", async () => {
    const created = (
      await post({ title: "Lifecycle", providerId: "lc-provider", modelId: "m1", reasoningLevel: "low" })
    ).body;

    // Omitted ⇒ preserved.
    const renamed = (await patch(created.id, { title: "Lifecycle renamed" })).body;
    expect(renamed.title).toBe("Lifecycle renamed");
    expect(renamed.modelId).toBe("m1");
    expect(renamed.reasoningLevel).toBe("low");
    expect(renamed.providerId).toBe("lc-provider");

    // Explicit null ⇒ cleared (and only that field).
    const cleared = (await patch(created.id, { modelId: null })).body;
    expect(cleared.modelId).toBeNull();
    expect(cleared.reasoningLevel).toBe("low");
    expect(cleared.providerId).toBe("lc-provider");

    // Value ⇒ set.
    const set = (await patch(created.id, { reasoningLevel: "high" })).body;
    expect(set.reasoningLevel).toBe("high");
    expect(cleared.modelId).toBeNull();
  });

  it("never reports success for a write that did not happen", async () => {
    const created = (await post({ title: "Truthful" })).body;
    await del(created.id);
    const res = await patch(created.id, { title: "after delete" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Conversation not found");
  });
});

describe("delete is truthful", () => {
  it("reports deleted:true for a real row and removes it authoritatively", async () => {
    const created = (await post({ title: "Doomed" })).body;
    const first = await del(created.id);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ success: true, deleted: true });
    expect((await get(created.id)).status).toBe(404);
  });

  it("reports deleted:false for a row that was already gone", async () => {
    const second = await del(MISSING);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ success: true, deleted: false });
  });
});

describe("materialization is single-row and observable", () => {
  it("replays one clientRequestId to the same row, marking the replay", async () => {
    const key = `lc-key-${Date.now()}`;
    const since = logger.lastSeq;

    const first = await post({
      title: "Idempotent",
      clientRequestId: key,
      engine: "opencode",
      opencodeAgent: "build",
    });
    const second = await post({
      title: "Idempotent",
      clientRequestId: key,
      engine: "opencode",
      opencodeAgent: "build",
    });

    expect(second.body.id).toBe(first.body.id);

    const events = eventsSince(since, "conversation.materialize");
    expect(events).toHaveLength(2);
    expect(events[0].replayed).toBe(false);
    expect(events[1].replayed).toBe(true);
    expect(events[0].engine).toBe("opencode");
    expect(events[0].conversationId).toBe(first.body.id);
  });

  it("does not resurrect a deleted row when the same key is replayed", async () => {
    const key = `lc-key-del-${Date.now()}`;
    const first = await post({ title: "Gone", clientRequestId: key });
    await del(first.body.id);
    const again = await post({ title: "Gone", clientRequestId: key });
    // A fresh identity, never the deleted one.
    expect(again.status).toBe(200);
    expect(again.body.id).not.toBe(first.body.id);
    expect((await get(first.body.id)).status).toBe(404);
  });
});

describe("lifecycle events carry ids and enums, never user values", () => {
  it("records open, update and delete with the right shape", async () => {
    const created = (await post({ title: "Observed" })).body;

    const sinceOpen = logger.lastSeq;
    await get(created.id);
    const opened = eventsSince(sinceOpen, "conversation.open");
    expect(opened).toHaveLength(1);
    expect(opened[0].conversationId).toBe(created.id);
    expect(opened[0].engine).toBe("direct");

    const sinceUpdate = logger.lastSeq;
    await patch(created.id, { title: "SECRET-TITLE-VALUE", status: "archived" });
    const updated = eventsSince(sinceUpdate, "conversation.update");
    expect(updated).toHaveLength(1);
    expect(String(updated[0].fields)).toContain("title");
    expect(String(updated[0].fields)).toContain("status");
    expect(updated[0].status).toBe("archived");
    // Field NAMES only — the title text must never reach the log.
    expect(JSON.stringify(updated[0])).not.toContain("SECRET-TITLE-VALUE");

    const sinceDelete = logger.lastSeq;
    await del(created.id);
    const deleted = eventsSince(sinceDelete, "conversation.delete");
    expect(deleted).toHaveLength(1);
    expect(deleted[0].deleted).toBe(true);
    expect(deleted[0].conversationId).toBe(created.id);
  });
});
