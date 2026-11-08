/**
 * The browser's only window onto `session.active`, end to end.
 *
 * ## Why this file exists
 *
 * `session.active` answers with the managed process's **global** active-session
 * map. Forwarding it through the existing `/api/opencode/*` proxy would tell any
 * caller which sessions — in any conversation — are running right now. The
 * backend therefore owns the read and exposes exactly one fact: the activity of
 * a session the caller's conversation is already bound to.
 *
 * Three properties are load-bearing and none is provable from the route's source
 * text:
 *
 *   1. the conversation/session pair is verified **before** any OpenCode request,
 *      so the endpoint cannot be used to probe someone else's session;
 *   2. a failed read is `unknown`, never `not-running` (absence from this
 *      process's map is not evidence that no work exists);
 *   3. the response never contains the map, only `{ activity }`.
 *
 * ## Hermetic by construction
 *
 * The composed app is driven in-process (no socket, no port). The only
 * substitutions are the official client (which would need a live server) and the
 * server manager's `ensureBaseUrl`, which would otherwise spawn one. Storage and
 * workspace resolution are real, so the pairing guard is exercised against real
 * conversation rows rather than a mock that agrees with the test.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import * as realOpenCodeClient from "@/services/opencode/client.ts";
import {
  openCodeServerManager,
  type OpenCodeServerManager,
} from "@/services/opencode/serverManager.ts";
import { matchOpenCodeProxyRoute } from "@/services/opencode/proxyRoutes.ts";
import { conversationService } from "@/services/storage";
import { OpenCodeSessionMismatchError } from "@/services/opencode/sessions.ts";

const SESSION_ID = "ses_activity_binding";
const OTHER_SESSION_ID = "ses_activity_other";
const CONVERSATION_TITLE = "session-activity";

/** What the fake `session.active()` answers with, per case. */
let activeAnswer: Record<string, { readonly type: string }> | Error;
/** How many times the real service reached `session.active`. */
let activeCalls: number;

const originalEnsureBaseUrl = openCodeServerManager.ensureBaseUrl;

function installFakes(): void {
  mock.module("@/services/opencode/client", () => ({
    ...realOpenCodeClient,
    createOpenCodeClient: () => ({
      session: {
        active: async () => {
          activeCalls += 1;
          if (activeAnswer instanceof Error) throw activeAnswer;
          return activeAnswer;
        },
      },
    }),
  }));
}

beforeEach(() => {
  activeCalls = 0;
  activeAnswer = {};
  installFakes();
  // Process ownership is not under test here; answering with a stub URL keeps
  // the read from spawning (or connecting to) a real OpenCode server.
  (openCodeServerManager as OpenCodeServerManager).ensureBaseUrl = async () => "http://127.0.0.1:0";
});

afterEach(async () => {
  (openCodeServerManager as OpenCodeServerManager).ensureBaseUrl = originalEnsureBaseUrl;
  mock.restore();
  const { threads } = await conversationService.list();
  for (const row of threads) {
    if (row.title === CONVERSATION_TITLE) await conversationService.delete(row.id);
  }
});

/** A real OpenCode conversation row bound to `sessionId`. */
async function boundConversation(sessionId = SESSION_ID): Promise<string> {
  const conversation = await conversationService.create({
    title: CONVERSATION_TITLE,
    engine: "opencode",
  } as never);
  await conversationService.update(conversation.id, { opencodeSessionId: sessionId });
  return conversation.id;
}

async function postActivity(body: unknown) {
  const { default: app } = await import("@/routes");
  const res = await app.request("http://localhost/api/opencode/session/activity", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { res, body: (await res.json()) as Record<string, unknown> };
}

describe("session activity is a filtered read, not the active map", () => {
  it("reports running for the session this process owns", async () => {
    const conversationId = await boundConversation();
    activeAnswer = {
      [SESSION_ID]: { type: "running" },
      // Another conversation's session is running too. It must not appear.
      [OTHER_SESSION_ID]: { type: "running" },
    };

    const { res, body } = await postActivity({ conversationId, sessionId: SESSION_ID });

    expect(res.status).toBe(200);
    // Handled by TBAi, not forwarded by the catch-all: the response is TBAi's
    // shape (the proxy would refuse this path as an unknown upstream route).
    // Exactly one field: no `sessions`, no map, no other session's state.
    expect(Object.keys(body)).toEqual(["activity"]);
    expect(body.activity).toBe("running");
    expect(JSON.stringify(body)).not.toContain(OTHER_SESSION_ID);
    expect(activeCalls).toBe(1);
  });

  it("reports not-running only when the map was read and the session is absent", async () => {
    const conversationId = await boundConversation();
    activeAnswer = { [OTHER_SESSION_ID]: { type: "running" } };

    const { res, body } = await postActivity({ conversationId, sessionId: SESSION_ID });

    expect(res.status).toBe(200);
    expect(body).toEqual({ activity: "not-running" });
  });

  it("does not treat any other status as a live drain", async () => {
    const conversationId = await boundConversation();
    activeAnswer = { [SESSION_ID]: { type: "idle" } };

    const { body } = await postActivity({ conversationId, sessionId: SESSION_ID });

    expect(body).toEqual({ activity: "not-running" });
  });

  it("degrades a failed read to unknown, never to idle", async () => {
    const conversationId = await boundConversation();
    activeAnswer = new Error("session.active refused");

    const { res, body } = await postActivity({ conversationId, sessionId: SESSION_ID });

    // The read failed; the conversation load must not.
    expect(res.status).toBe(200);
    expect(body).toEqual({ activity: "unknown" });
  });

  it("degrades a transport failure before the read to unknown as well", async () => {
    const conversationId = await boundConversation();
    (openCodeServerManager as OpenCodeServerManager).ensureBaseUrl = async () => {
      throw new Error("managed server did not start");
    };

    const { res, body } = await postActivity({ conversationId, sessionId: SESSION_ID });

    expect(res.status).toBe(200);
    expect(body).toEqual({ activity: "unknown" });
    expect(activeCalls).toBe(0);
  });
});

describe("the pairing guard runs before the OpenCode call", () => {
  it("refuses a session that belongs to a different conversation", async () => {
    const conversationId = await boundConversation();
    const { res, body } = await postActivity({
      conversationId,
      sessionId: OTHER_SESSION_ID,
    });

    expect(res.status).toBe(404);
    expect(body).toEqual({ error: "Unknown conversation/session pair" });
    // No probe reached the server: the guard is not a filter on the answer.
    expect(activeCalls).toBe(0);
  });

  it("refuses an unknown conversation instead of answering for it", async () => {
    const { res, body } = await postActivity({
      conversationId: "conv_does_not_exist",
      sessionId: SESSION_ID,
    });

    expect(res.status).toBe(404);
    expect(body).toEqual({ error: "Unknown conversation/session pair" });
    expect(activeCalls).toBe(0);
  });

  it("refuses a Direct conversation that carries the id", async () => {
    const conversation = await conversationService.create({
      title: CONVERSATION_TITLE,
      engine: "direct",
    } as never);
    await conversationService.update(conversation.id, { opencodeSessionId: SESSION_ID });

    const { res } = await postActivity({
      conversationId: conversation.id,
      sessionId: SESSION_ID,
    });

    expect(res.status).toBe(404);
    expect(activeCalls).toBe(0);
  });

  it("validates the body before touching storage or the server", async () => {
    for (const body of [
      {},
      { conversationId: "c" },
      { sessionId: "s" },
      { conversationId: "", sessionId: "s" },
    ]) {
      const { res } = await postActivity(body);
      expect(res.status).toBe(400);
    }
    expect(activeCalls).toBe(0);
  });

  it("throws the typed mismatch error from the service, not a generic failure", async () => {
    const conversationId = await boundConversation();
    await expect(
      import("@/services/opencode/sessions.ts").then(({ getOpenCodeSessionActivity }) =>
        getOpenCodeSessionActivity(conversationId, OTHER_SESSION_ID),
      ),
    ).rejects.toBeInstanceOf(OpenCodeSessionMismatchError);
  });

  it("names a path the upstream allowlist does not carry", () => {
    expect(matchOpenCodeProxyRoute("POST", "/api/session/activity")).toBeNull();
  });
});
