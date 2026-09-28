import { beforeEach, describe, expect, it, mock } from "bun:test";

/**
 * Both session-model call sites, exercised through `ensureOpenCodeSession`.
 *
 * `sessionModel.test.ts` proves the DECISION. This proves the two SEAMS actually
 * call through it — which is the part a pure-function test cannot see, and the
 * part that actually broke. Before this change the adopt path returned a live
 * session without ever asking whether it had a model, so a session bound before
 * the default was consulted stayed model-less and no turn could run on it.
 *
 * Isolation: `./client` and the process-owning modules are mocked, so no server
 * is started and no network I/O happens. `tests/setup.ts` also redirects the data
 * and workspace roots to a per-process temp directory.
 */

/** Every `switchModel` call, and every `session.create` body. */
let switches: Array<{ sessionID: string; model: { id: string; providerID: string } }>;
let creates: Array<Record<string, unknown>>;
/** The model the stubbed server reports for an adopted session. */
let boundModel: { id: string } | null;
let storedConversation: Record<string, unknown>;

function install() {
  mock.module("../storage", () => ({
    conversationService: {
      get: async () => storedConversation,
      update: async () => undefined,
    },
  }));
  mock.module("../workspace", () => ({
    resolveConversationWorkspace: async () => ({
      mode: "simple",
      dir: "D:/tmp/does-not-need-to-exist",
      folderId: "f1",
      folderName: "Chat",
    }),
  }));
  mock.module("./serverManager", () => ({
    openCodeServerManager: { ensureBaseUrl: async () => "http://127.0.0.1:0" },
  }));
  mock.module("./capabilities", () => ({
    getOpenCodeCapabilities: async () => ({
      agents: [],
      models: [],
      defaultModel: { providerID: "openrouter", modelID: "perceptron/perceptron-mk1.5", name: "Perceptron Mk1.5" },
    }),
    // Resolves only a stored value that the catalogue knows; anything else is
    // "no choice", which is what lets the default apply.
    resolveOpenCodeModelRef: async (modelId: string) =>
      modelId === "agnes/agnes-3.0-flash" ? { providerID: "agnes", modelID: "agnes-3.0-flash" } : null,
  }));
  mock.module("./client", () => ({
    createOpenCodeClient: () => ({
      session: {
        get: async () => ({ id: "ses_bound", location: { directory: "D:/tmp/x" }, model: boundModel }),
        create: async (params: Record<string, unknown>) => {
          creates.push(params);
          return { id: "ses_new", location: { directory: "D:/tmp/x" } };
        },
        switchModel: async (input: { sessionID: string; model: { id: string; providerID: string } }) => {
          switches.push(input);
        },
      },
    }),
  }));
}

beforeEach(() => {
  switches = [];
  creates = [];
  boundModel = null;
  storedConversation = {
    id: "conv-1",
    engine: "opencode",
    opencodeSessionId: "ses_bound",
    opencodeModel: null,
    opencodeAgent: "build",
    opencodeVariant: null,
  };
  install();
});

const { ensureOpenCodeSession } = await import("./sessions");

describe("the adopt seam — a bound session with no model", () => {
  it("is given the server default", async () => {
    await ensureOpenCodeSession("conv-1");
    expect(switches).toHaveLength(1);
    expect(switches[0].sessionID).toBe("ses_bound");
    expect(switches[0].model).toEqual({ id: "perceptron/perceptron-mk1.5", providerID: "openrouter" });
  });

  it("is given the STORED model when one exists, never the default", async () => {
    storedConversation = { ...storedConversation, opencodeModel: "agnes/agnes-3.0-flash" };
    await ensureOpenCodeSession("conv-1");
    expect(switches[0].model).toEqual({ id: "agnes-3.0-flash", providerID: "agnes" });
  });

  it("is left completely alone when it already has a model", async () => {
    // The guard that makes the seam safe to run on every adopt.
    boundModel = { id: "agnes/agnes-3.0-flash" };
    await ensureOpenCodeSession("conv-1");
    expect(switches).toHaveLength(0);
  });

  it("is left alone when the stored value no longer resolves and there is no default", async () => {
    mock.module("./capabilities", () => ({
      getOpenCodeCapabilities: async () => ({ agents: [], models: [], defaultModel: null }),
      resolveOpenCodeModelRef: async () => null,
    }));
    storedConversation = { ...storedConversation, opencodeModel: "gone/vanished" };
    await ensureOpenCodeSession("conv-1");
    // Honest: unbound rather than pointed at a model the server no longer has.
    expect(switches).toHaveLength(0);
  });

  it("still hands the live session back when the assignment fails", async () => {
    // Adopting a live session must never be blocked by a model repair.
    mock.module("./client", () => ({
      createOpenCodeClient: () => ({
        session: {
          get: async () => ({ id: "ses_bound", location: { directory: "D:/tmp/x" }, model: null }),
          create: async () => ({ id: "ses_new" }),
          switchModel: async () => { throw new Error("server refused"); },
        },
      }),
    }));
    const binding = await ensureOpenCodeSession("conv-1");
    expect(binding.sessionId).toBe("ses_bound");
  });
});

describe("the create seam — a conversation with no stored choice", () => {
  it("is created with the server default", async () => {
    storedConversation = { ...storedConversation, opencodeSessionId: null };
    await ensureOpenCodeSession("conv-1");
    expect(creates).toHaveLength(1);
    expect(creates[0].model).toEqual({ id: "perceptron/perceptron-mk1.5", providerID: "openrouter" });
  });

  it("is created with the STORED model when one exists", async () => {
    storedConversation = { ...storedConversation, opencodeSessionId: null, opencodeModel: "agnes/agnes-3.0-flash" };
    await ensureOpenCodeSession("conv-1");
    expect(creates[0].model).toEqual({ id: "agnes-3.0-flash", providerID: "agnes" });
  });

  it("carries the stored variant on the created model", async () => {
    // The variant is baked in at create time; the default path must not
    // silently drop a reader's thinking level.
    storedConversation = {
      ...storedConversation,
      opencodeSessionId: null,
      opencodeModel: "agnes/agnes-3.0-flash",
      opencodeVariant: "high",
    };
    await ensureOpenCodeSession("conv-1");
    expect(creates[0].model).toEqual({ id: "agnes-3.0-flash", providerID: "agnes", variant: "high" });
  });

  it("is created with no model when there is neither a choice nor a default", async () => {
    mock.module("./capabilities", () => ({
      getOpenCodeCapabilities: async () => ({ agents: [], models: [], defaultModel: null }),
      resolveOpenCodeModelRef: async () => null,
    }));
    storedConversation = { ...storedConversation, opencodeSessionId: null };
    await ensureOpenCodeSession("conv-1");
    expect(creates[0].model).toBeUndefined();
  });

  it("never runs the default branch when a stored model was already set", async () => {
    // Non-vacuity for the `if (!params.model)` guard: with a stored model the
    // default lookup must not even be consulted.
    storedConversation = { ...storedConversation, opencodeSessionId: null, opencodeModel: "agnes/agnes-3.0-flash" };
    await ensureOpenCodeSession("conv-1");
    expect(switches).toHaveLength(0);
    expect(creates[0].model).toEqual({ id: "agnes-3.0-flash", providerID: "agnes" });
  });
});
