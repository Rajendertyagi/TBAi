import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

/**
 * The startup capabilities race.
 *
 * ## What happens live
 *
 * OpenCode answers `/api/info` the moment it is listening, but loads its provider
 * catalogue asynchronously. So for roughly a second after a fresh TBAi start:
 *
 *     opencode.capabilities  agents=0  models=0     <- the reader's first request
 *     opencode.capabilities  agents=7  models=399   <- ~80s later
 *
 * The old code returned the first, empty answer as final. The frontend held it
 * in state, nothing re-requested, so the model picker had no models, no server
 * default resolved, no `POST /session/<id>/model` was sent, and the Code chat had
 * no model at all — a turn to it does nothing.
 *
 * ## The rule under test
 *
 * An empty catalogue means "still loading" only while the managed process is
 * inside the window in which it has been reachable; after that it means exactly
 * what it says. The window is driven by the manager's own readiness signal, not a
 * private timer, so a genuinely model-less install is never made to wait.
 */

/** Each `model.list()` / `agent.list()` response, in call order. */
let responses: Array<{ agents: unknown[]; models: unknown[] }>;
let calls: { agentList: number; modelList: number };
/** Milliseconds the managed process has been reachable, or null when not ready. */
let sinceReadyMs: number | null;

const REAL_MODEL = {
  id: "perceptron/perceptron-mk1.5",
  name: "Perceptron Mk1.5",
  providerID: "openrouter",
};
const REAL_AGENT = { id: "build", name: "Build" };

function install() {
  mock.module("./client", () => ({
    createOpenCodeClient: () => {
      // One capabilities READ is `agent.list()` + `model.list()` together, so the
      // counter advances once per read — on the agent call, which the caller
      // issues first — and the model call answers from the same read index.
      // Counting both would make a single read look like two.
      const agentList = async () => {
        const index = Math.min(calls.modelList++, responses.length - 1);
        return { data: responses[index].agents };
      };
      const modelList = async () => {
        const index = Math.min(calls.modelList - 1, responses.length - 1);
        return { data: responses[index].models };
      };
      return {
        agent: { list: agentList },
        model: {
          list: modelList,
          default: async () => ({ data: (responses[responses.length - 1].models[0] as typeof REAL_MODEL) ?? null }),
        },
      };
    },
  }));
  mock.module("./serverManager", () => ({
    openCodeServerManager: {
      ensureBaseUrl: async () => "http://127.0.0.1:0",
      msSinceReady: () => sinceReadyMs,
    },
  }));
}

beforeEach(() => {
  responses = [{ agents: [], models: [] }];
  calls = { agentList: 0, modelList: 0 };
  sinceReadyMs = 500;
  install();
});

afterEach(() => mock.restore());

describe("the race: catalogue not ready yet", () => {
  it("does NOT settle on the first empty answer, and returns the populated one", async () => {
    // The exact observed sequence: empty first, then real.
    responses = [
      { agents: [], models: [] },
      { agents: [], models: [] },
      { agents: [REAL_AGENT], models: [REAL_MODEL] },
    ];
    sinceReadyMs = 400;
    const { getOpenCodeCapabilities } = await import("./capabilities");
    const caps = await getOpenCodeCapabilities();
    // The reader never sees the empty state at all.
    expect(caps.models).toHaveLength(1);
    expect(caps.agents).toHaveLength(1);
    expect(caps.models[0].id).toBe("perceptron/perceptron-mk1.5");
    // Non-vacuity: it really did re-probe rather than accept the first answer.
    expect(calls.modelList).toBeGreaterThan(1);
  });

  it("resolves a server default once the catalogue has populated", async () => {
    // Stage 2 depends on this: with no models and no default, no model is chosen
    // and the session stays model-less.
    responses = [
      { agents: [], models: [] },
      { agents: [REAL_AGENT], models: [REAL_MODEL] },
    ];
    sinceReadyMs = 100;
    const { getOpenCodeCapabilities } = await import("./capabilities");
    const caps = await getOpenCodeCapabilities();
    expect(caps.defaultModel).toEqual({
      providerID: "openrouter",
      modelID: "perceptron/perceptron-mk1.5",
      name: "Perceptron Mk1.5",
    });
  });
});

describe("a genuinely empty catalogue still fails honestly", () => {
  it("returns empty at once once the startup window has passed", async () => {
    // The install really has no providers. It must NOT be made to wait, and must
    // never be told something untrue.
    responses = [{ agents: [], models: [] }];
    sinceReadyMs = 60_000;
    const { getOpenCodeCapabilities } = await import("./capabilities");
    const caps = await getOpenCodeCapabilities();
    expect(caps.models).toEqual([]);
    expect(caps.agents).toEqual([]);
    expect(caps.defaultModel).toBeUndefined();
    // One read only — no pointless retry loop on a settled answer.
    expect(calls.modelList).toBe(1);
  });

  it("returns empty at once when no process is ready to have a window", async () => {
    responses = [{ agents: [], models: [] }];
    sinceReadyMs = null;
    const { getOpenCodeCapabilities } = await import("./capabilities");
    const caps = await getOpenCodeCapabilities();
    expect(caps.models).toEqual([]);
    expect(calls.modelList).toBe(1);
  });

  it("does not re-probe when the first read is already populated", async () => {
    // The common case must stay a single round trip — no added latency on a
    // healthy server.
    responses = [{ agents: [REAL_AGENT], models: [REAL_MODEL] }];
    sinceReadyMs = 100;
    const { getOpenCodeCapabilities } = await import("./capabilities");
    const caps = await getOpenCodeCapabilities();
    expect(caps.models).toHaveLength(1);
    expect(calls.modelList).toBe(1);
  });
});

describe("the readiness signal comes from the manager, not a local timer", () => {
  it("keys the window on msSinceReady", async () => {
    // A young server is re-probed; an old one is not. Proving it is the
    // manager's clock — rather than elapsed time inside this module — is what
    // stops a second, competing notion of "starting up" from appearing.
    const { getOpenCodeCapabilities } = await import("./capabilities");

    // Young: inside the window, and the catalogue arrives on the next probe.
    calls = { agentList: 0, modelList: 0 };
    responses = [
      { agents: [], models: [] },
      { agents: [REAL_AGENT], models: [REAL_MODEL] },
    ];
    sinceReadyMs = 50;
    const young = await getOpenCodeCapabilities();
    expect(young.models).toHaveLength(1);
    expect(calls.modelList).toBeGreaterThan(1);

    // Old: outside the window, so the same empty answer is taken at once.
    calls = { agentList: 0, modelList: 0 };
    responses = [{ agents: [], models: [] }];
    sinceReadyMs = 120_000;
    const old = await getOpenCodeCapabilities();
    expect(old.models).toEqual([]);
    expect(calls.modelList).toBe(1);
  });
});
