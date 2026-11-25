import { describe, it, expect, mock } from "bun:test";
import { Hono } from "hono";
import * as realStorage from "@/services/storage";
import * as realDeletion from "@/services/opencode/conversationDeletion";

/**
 * HTTP mapping of the local-only deletion coordinator. The coordinator is
 * stubbed to return a rebind conflict; the route must preserve the row and
 * answer 409. This is the boundary the service-level tests cannot cover.
 */
let outcome: unknown = { kind: "conflict", reason: "session_rebound" };

mock.module("@/services/opencode/conversationDeletion", () => ({
  ...realDeletion,
  deleteOpenCodeConversation: async () => outcome,
}));

mock.module("@/services/storage", () => ({
  ...realStorage,
  conversationService: {
    ...realStorage.conversationService,
    get: async () => ({
      id: "conv-1",
      engine: "opencode",
      opencodeSessionId: "ses_stale",
      workspaceFolderId: null,
    }),
  },
}));

const { default: conversationsApp } = await import("@/routes/conversations.ts");
const app = new Hono();
app.route("/", conversationsApp);

describe("DELETE /api/conversations/:id — rebind HTTP mapping", () => {
  it("maps a session_rebound outcome to HTTP 409", async () => {
    outcome = { kind: "conflict", reason: "session_rebound" };
    const res = await app.request("/api/conversations/conv-1", { method: "DELETE" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "session_rebound" });
  });

  it("maps a successful local deletion to HTTP 200 with sessionCleanup none", async () => {
    outcome = { kind: "deleted", sessionCleanup: "none" };
    const res = await app.request("/api/conversations/conv-1", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      deleted: true,
      sessionCleanup: "none",
    });
  });
});
