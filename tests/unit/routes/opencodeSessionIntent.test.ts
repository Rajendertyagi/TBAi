import { describe, it, expect, mock, beforeEach } from "bun:test";
import * as realStorage from "@/services/storage";
import * as realOrphans from "@/services/storage/opencodeSessionOrphans";
import * as realWorkspace from "@/services/workspace";
import * as realClient from "@/services/opencode/client";

/**
 * The HTTP boundary of the fail-closed create intent (RT-001).
 *
 * `ensureOpenCodeSession` is the REAL function here; only its four external
 * seams are stubbed (storage, journal, workspace, official client). That is
 * what makes "the browser was told 503 and the server never issued a create"
 * an observable fact rather than a claim about a mocked function.
 *
 * The error body must never carry the session id: the journal is the durable
 * handle, and the id is redacted from logs by policy. A browser response is
 * one more place it must not appear.
 */

let createCalls = 0;
let journalError: Error | null = null;
let journalReturnsOpen = true;
let updatedPointers: Array<{ id: string; pointer: string | null }> = [];
const CONVERSATION_DIRECTORY = "D:\\ws\\conv-1";

mock.module("@/services/storage", () => ({
  ...realStorage,
  conversationService: {
    ...realStorage.conversationService,
    get: async () => ({ engine: "opencode", opencodeSessionId: null, opencodeModel: null }),
    update: async (id: string, patch: { opencodeSessionId?: string | null }) => {
      updatedPointers.push({ id, pointer: patch.opencodeSessionId ?? null });
    },
  },
}));

mock.module("@/services/storage/opencodeSessionOrphans", () => ({
  ...realOrphans,
  opencodeOrphanService: {
    ...realOrphans.opencodeOrphanService,
    recordCreateIntent: async () => {
      if (journalError) throw journalError;
      return journalReturnsOpen;
    },
    deleteCreateIntent: async () => true,
    recordOrphanedSession: async () => true,
  },
}));

mock.module("@/services/workspace", () => ({
  ...realWorkspace,
  resolveConversationWorkspace: async () => ({ dir: CONVERSATION_DIRECTORY }),
}));

mock.module("@/services/opencode/client", () => ({
  ...realClient,
  createOpenCodeClient: () => ({
    session: {
      create: async (args: { id: string }) => {
        createCalls += 1;
        return { id: args.id, location: { directory: CONVERSATION_DIRECTORY } };
      },
    },
    // No catalogue: the session is created unbound, as in a bare environment.
    agent: { list: async () => ({ data: [] }) },
    model: { list: async () => ({ data: [] }) },
  }),
}));

const { openCodeServerManager } = await import("@/services/opencode/serverManager.ts");
(openCodeServerManager as unknown as { ensureBaseUrl: () => Promise<string> }).ensureBaseUrl =
  async () => "http://127.0.0.1:0";

const app = (await import("@/routes/opencode.ts")).default;

async function postSession(): Promise<Response> {
  return app.request("/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversationId: "conv-1" }),
  });
}

beforeEach(() => {
  createCalls = 0;
  journalError = null;
  journalReturnsOpen = true;
  updatedPointers = [];
});

describe("POST /api/opencode/session — fail-closed create intent", () => {
  it("answers 503 with an id-free body and never calls session.create when the journal throws", async () => {
    journalError = new Error("database is closed");

    const response = await postSession();
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(body)).toEqual({
      error: "OpenCode session recovery is unavailable; no session was created",
    });
    expect(body).not.toMatch(/ses_[A-Za-z0-9]{8,}/);
    expect(createCalls).toBe(0);
    expect(updatedPointers).toEqual([]);
  });

  it("answers 503 and creates nothing when the journal reports no open intent", async () => {
    journalReturnsOpen = false;

    const response = await postSession();

    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/ses_[A-Za-z0-9]{8,}/);
    expect(createCalls).toBe(0);
    expect(updatedPointers).toEqual([]);
  });

  it("creates, binds and returns the id once the intent is durable", async () => {
    const response = await postSession();
    const body = (await response.json()) as { sessionId: string; directory: string };

    expect(response.status).toBe(200);
    // On the success path the browser MUST receive the id: it addresses the
    // session it owns. The redaction rule is about logs and error bodies.
    expect(body.sessionId).toMatch(/^ses_/);
    expect(createCalls).toBe(1);
    expect(updatedPointers).toEqual([{ id: "conv-1", pointer: body.sessionId }]);
  });
});
