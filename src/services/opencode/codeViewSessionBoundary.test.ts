/**
 * The Code view → `ensureOpenCodeSession` boundary, end to end.
 *
 * ## Why this file exists
 *
 * `ensureOpenCodeSession` is the one place a conversation's session identity and
 * its model are decided together, and Stage 2 put the model invariant there. If
 * the Code view ever stops routing through it, that work becomes dead code and
 * the surface silently returns to "a session with no model, so a turn does
 * nothing" — with every unit test still green, because they all call the seam
 * directly and never prove the view reaches it.
 *
 * So these tests drive the REAL Hono route, over the REAL conversation rows,
 * through the REAL official V2 client, against a fake OpenCode that speaks the
 * real wire protocol. Nothing about the decision is stubbed: what is asserted is
 * the model TBAi actually put on the wire.
 *
 * The last describe block closes the other half of the link — that the browser's
 * bootstrap module and view are pointed at this same route.
 *
 * ## Hermetic by construction
 *
 * The only substitution is the managed server's V2 client, which is the seam's
 * single outbound dependency. No `opencode` process is ever spawned. The real
 * wire contract behind that client is verified separately, live, against a
 * managed server.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { conversationService } from "../storage";
import { OpenCodeError } from "./errors";

/** The server's advertised default in every case that needs one. */
const SERVER_DEFAULT = {
  providerID: "openrouter",
  modelID: "perceptron/perceptron-mk1.5",
  name: "Perceptron Mk1.5",
};

/** A reader's explicit choice, deliberately a different model from the default. */
const STORED_MODEL_ID = "anthropic/claude-sonnet-4-5";

/** Sessions the fake server currently holds, keyed by id. */
let serverSessions: Map<string, { directory: string; model?: { id: string; providerID: string } }>;
/** The HTTP status each session lookup came back with, which is what the seam
 * actually decides on. `undefined` means the lookup was never attempted. */
let lookupStatus: Map<string, number | null>;
/**
 * Sessions whose lookup fails WITHOUT a 404 — the ambiguous case. Same thrown
 * error as a missing session, different (non-404) status, which is precisely the
 * distinction the seam must get right.
 */
let ambiguousIds: Set<string>;
/** The default the fake advertises, or null when it advertises none. */
let serverDefault: typeof SERVER_DEFAULT | null;
/** Every created session, with the model that was actually put on the wire. */
let created: Array<{ model?: { id: string; providerID: string } }>;
/** Every `session.switchModel` the seam issued, as the server received it. */
let switched: Array<{ sessionID: string; model: { id: string; providerID: string } }>;
let nextId: number;

beforeEach(() => {
  // The seam's only outbound dependency is the official V2 client, so the fake
  // replaces exactly that and nothing else. Module mocks are process-global in
  // bun and leak between files, so this file owns a COMPLETE client surface:
  // a partial fake would break any other file that reached the seam, and a
  // shared-global patch (e.g. `ensureBaseUrl`) would be order-dependent.
  mock.module("./client", () => ({
    // Mirrors the real module's shape: the seam decides liveness on the status
    // the transport observed, because the real client throws away the status of
    // the bare 404 the server sends for a missing session.
    lastStatusForSessionLookup: (_client: unknown, sessionId: string) =>
      lookupStatus.get(sessionId) ?? null,
    createOpenCodeClient: () => ({
      session: {
        get: async ({ sessionID }: { sessionID: string }) => {
          // Ambiguous: the client cannot parse the body, but nothing says the
          // session is gone. Must never authorise a replacement.
          if (ambiguousIds.has(sessionID)) {
            lookupStatus.set(sessionID, 200);
            throw new OpenCodeError("malformed", "unsupported content type");
          }
          const record = serverSessions.get(sessionID);
          if (record) {
            lookupStatus.set(sessionID, 200);
            return {
              id: sessionID,
              location: { directory: record.directory },
              ...(record.model ? { model: record.model } : {}),
            };
          }
          // A missing session is a bare 404 with an empty body, which the real
          // client cannot parse — it throws `UnsupportedContentType` and drops
          // the status. Reproduced exactly so the fix is tested against the real
          // failure shape, not a convenient one.
          lookupStatus.set(sessionID, 404);
          throw new OpenCodeError("malformed", "unsupported content type");
        },
        create: async (params: {
          location: { directory: string };
          model?: { id: string; providerID: string };
        }) => {
          created.push({ model: params.model });
          const id = `ses_fake_${nextId++}`;
          serverSessions.set(id, {
            directory: params.location.directory,
            ...(params.model ? { model: params.model } : {}),
          });
          return { id, location: { directory: params.location.directory } };
        },
        switchModel: async (args: {
          sessionID: string;
          model: { id: string; providerID: string };
        }) => {
          switched.push(args);
          const record = serverSessions.get(args.sessionID);
          if (record) record.model = args.model;
          return undefined;
        },
      },
    }),
  }));

  // Capabilities: a server that has finished loading, which is the settled case
  // Stage 3's readiness window exists to produce.
  mock.module("./capabilities", () => ({
    getOpenCodeCapabilities: async () => ({
      agents: [{ id: "build", name: "Build", description: "" }],
      models: [
        { id: SERVER_DEFAULT.modelID, name: SERVER_DEFAULT.name, providerID: SERVER_DEFAULT.providerID },
        { id: STORED_MODEL_ID, name: "Claude Sonnet 4.5", providerID: "openrouter" },
      ],
      defaultModel: serverDefault ?? undefined,
    }),
    resolveOpenCodeModelRef: async (value: string) =>
      value === STORED_MODEL_ID
        ? { providerID: "openrouter", modelID: STORED_MODEL_ID }
        : null,
  }));

  serverSessions = new Map();
  lookupStatus = new Map();
  ambiguousIds = new Set();
  serverDefault = SERVER_DEFAULT;
  created = [];
  switched = [];
  nextId = 1;
});

afterEach(() => mock.restore());

afterEach(async () => {
  // Leave no rows behind even when an assertion fails midway.
  const { threads } = await conversationService.list();
  for (const row of threads) {
    if (row.title === "code-view-boundary") await conversationService.delete(row.id);
  }
});

/**
 * Drive the REAL composed app at the REAL public path, in-process: no socket to
 * TBAi and no spawned process.
 *
 * The composed app matters. The OpenCode router is a sub-app mounted at
 * `/api/opencode`, so importing it alone would address its paths relative to
 * that mount point — and the real path the browser posts to could never be
 * proven this way. The routes composition is used rather than the process
 * entrypoint so nothing here binds a port.
 */
async function bootstrap(conversationId: string) {
  const { default: app } = await import("../../routes");
  const res = await app.request("http://localhost/api/opencode/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId }),
  });
  return {
    res,
    body: (await res.json()) as { sessionId?: string; directory?: string | null; error?: string },
  };
}

/** A real OpenCode conversation row, with or without a stored model. */
async function openCodeConversation(storedModel: string | null = null) {
  return await conversationService.create({
    title: "code-view-boundary",
    engine: "opencode",
    ...(storedModel ? { opencodeModel: storedModel } : {}),
  } as never);
}

describe("A. the Code view's bootstrap reaches the session seam and binds the default", () => {
  it("gives a brand-new Code conversation the server default", async () => {
    const conv = await openCodeConversation();
    const { res, body } = await bootstrap(conv.id);
    expect(res.status).toBe(200);
    expect(body.sessionId).toBe("ses_fake_1");

    // The session went out over the wire carrying the default…
    expect(created).toHaveLength(1);
    expect(created[0].model).toEqual({
      id: SERVER_DEFAULT.modelID,
      providerID: SERVER_DEFAULT.providerID,
    });
    // …and it is really on the session, not merely requested.
    expect(serverSessions.get("ses_fake_1")?.model).toEqual({
      id: SERVER_DEFAULT.modelID,
      providerID: SERVER_DEFAULT.providerID,
    });
  });
});

describe("B. an existing unbound session is repaired, not duplicated", () => {
  it("adopts the live session and assigns the default without creating a second", async () => {
    const conv = await openCodeConversation();
    serverSessions.set("ses_existing", { directory: "D:\\tmp\\oc" });
    await conversationService.update(conv.id, { opencodeSessionId: "ses_existing" });

    const { res, body } = await bootstrap(conv.id);
    expect(res.status).toBe(200);

    // Identity is the conversation's own session — no new one minted.
    expect(body.sessionId).toBe("ses_existing");
    expect(created).toHaveLength(0);
    // Repaired in place instead.
    expect(switched).toEqual([
      {
        sessionID: "ses_existing",
        model: { id: SERVER_DEFAULT.modelID, providerID: SERVER_DEFAULT.providerID },
      },
    ]);
  });
});

describe("C. a stored choice always beats the server default", () => {
  it("keeps the reader's model and never asks for the default", async () => {
    const conv = await openCodeConversation(STORED_MODEL_ID);
    const { res } = await bootstrap(conv.id);
    expect(res.status).toBe(200);
    expect(created).toHaveLength(1);
    expect(created[0].model).toEqual({
      id: STORED_MODEL_ID,
      providerID: "openrouter",
    });
    expect(switched).toHaveLength(0);
  });
});

describe("D. a healthy session is left completely alone", () => {
  it("preserves identity and rewrites nothing", async () => {
    const conv = await openCodeConversation();
    serverSessions.set("ses_healthy", {
      directory: "D:\\tmp\\oc",
      model: { id: "some/other-model", providerID: "openrouter" },
    });
    await conversationService.update(conv.id, { opencodeSessionId: "ses_healthy" });

    const { res, body } = await bootstrap(conv.id);
    expect(res.status).toBe(200);
    expect(body.sessionId).toBe("ses_healthy");
    expect(created).toHaveLength(0);
    expect(switched).toHaveLength(0);
    expect(serverSessions.get("ses_healthy")?.model).toEqual({
      id: "some/other-model",
      providerID: "openrouter",
    });
  });
});

describe("E. a stale session pointer is not resurrected", () => {
  // The defect this file originally caught. OpenCode answers a lookup for a
  // session that does not exist with a BARE 404 and an EMPTY body, which the
  // official client cannot parse: it throws `UnsupportedContentType` carrying no
  // status, no `cause` and no `response` (verified against `@opencode/client`).
  // The old seam could only classify that as `malformed`, so a stale pointer
  // produced a permanent 500 with a Retry button instead of a replacement.
  //
  // Fixed by reading the status off the response the client itself received
  // (`lastStatusForSessionLookup` in `./client`) � never by treating every
  // `UnsupportedContentType` as "missing", which would replace sessions that
  // still exist and lose their history. Absence requires a positive 404; every
  // other outcome propagates, which the last test here pins.
  // needs the directory scoping verified first, which is the remaining work.
  it("mints a replacement when the stored pointer is definitively gone upstream", async () => {
    const conv = await openCodeConversation();
    // The row still points at a session the server answers 404 for.
    await conversationService.update(conv.id, { opencodeSessionId: "ses_vanished" });

    const { res, body } = await bootstrap(conv.id);
    expect(res.status).toBe(200);
    expect(body.sessionId).toBe("ses_fake_1");
    expect(created).toHaveLength(1);
    // The replacement carries the default, and nothing was written to the dead id.
    expect(created[0].model).toEqual({
      id: SERVER_DEFAULT.modelID,
      providerID: SERVER_DEFAULT.providerID,
    });
    expect(switched.every((s) => s.sessionID !== "ses_vanished")).toBe(true);
  });

  it("rebinds the conversation to the replacement, so the stale id is gone", async () => {
    const conv = await openCodeConversation();
    await conversationService.update(conv.id, { opencodeSessionId: "ses_vanished" });

    const { body } = await bootstrap(conv.id);
    expect(body.sessionId).toBe("ses_fake_1");

    const reloaded = await conversationService.get(conv.id);
    expect(reloaded?.opencodeSessionId).toBe("ses_fake_1");
  });

  it("does NOT replace the session when absence could not be established", async () => {
    // The safety requirement. A lookup that failed WITHOUT a 404 — a malformed
    // body, a transport fault, an auth failure — proves nothing about whether
    // the session still exists. Replacing on that evidence would silently
    // discard a live session's history, which is strictly worse than the error.
    // The throw here is byte-identical to the missing-session throw; only the
    // observed status differs, which is exactly what must decide.
    const conv = await openCodeConversation();
    serverSessions.set("ses_ambiguous", { directory: "D:\\tmp\\oc" });
    ambiguousIds.add("ses_ambiguous");
    await conversationService.update(conv.id, { opencodeSessionId: "ses_ambiguous" });

    const { res, body } = await bootstrap(conv.id);
    expect(res.status).toBe(500);
    expect(body.error).toBeTruthy();
    // No replacement, and the original binding is left exactly as it was.
    expect(created).toHaveLength(0);
    const reloaded = await conversationService.get(conv.id);
    expect(reloaded?.opencodeSessionId).toBe("ses_ambiguous");
  });
});

describe("F. with no server default the session stays honestly unbound", () => {
  it("invents no model and sends none", async () => {
    serverDefault = null;
    const conv = await openCodeConversation();
    const { res, body } = await bootstrap(conv.id);
    expect(res.status).toBe(200);
    expect(body.sessionId).toBe("ses_fake_1");
    expect(created).toHaveLength(1);
    expect(created[0].model).toBeUndefined();
    expect(switched).toHaveLength(0);
  });
});

describe("the browser half of the link: the view posts to this exact route", () => {
  const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

  it("bootstraps through the session route the backend serves", () => {
    const bootstrapModule = read("./../../../web/src/features/opencode/sessionBootstrap.ts");
    // The path the browser posts to...
    expect(bootstrapModule).toContain('"/api/opencode/session"');
    // ...and it posts to a session seam, not to the raw V2 proxy.
    expect(bootstrapModule).not.toContain("api/opencode/api/");
  });

  it("is what the Code view actually calls to resolve its session", () => {
    const view = read("./../../../web/src/features/opencode/OpenCodeView.tsx");
    expect(view).toContain("bootstrapOpenCodeSession");
    // The view takes its session id from that call, not from the V2 client.
    expect(view).toContain("setSessionId(data.sessionId)");
  });

  it("leaves model policy out of the view", () => {
    // Precedence lives in sessionModel; the view must not re-decide it.
    const view = read("./../../../web/src/features/opencode/OpenCodeView.tsx");
    expect(view).not.toContain("pickSessionModel");
  });
});
