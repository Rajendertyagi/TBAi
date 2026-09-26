import { describe, it, expect, mock, beforeEach } from "bun:test";
import { ClientError } from "@opencode/client";

/**
 * Tests for the OpenCode capability layer (getOpenCodeCapabilities +
 * resolveOpenCodeModelRef + resolveOpenCodeVariant) and the error translator.
 *
 * Isolation: the capability functions reach the managed server through two
 * seams — `openCodeServerManager.ensureBaseUrl` (process ownership) and
 * `createOpenCodeClient` (the official V2 client factory, `./client`). We mock
 * the factory and patch the server-manager instance, so no process is spawned
 * and no network I/O happens. `toOpenCodeError` is exercised against the real
 * `@opencode/client` error classes.
 */

interface FakeClient {
  agent: { list: () => Promise<{ data: unknown }> };
  model: { list: () => Promise<{ data: unknown }> };
}

let serverPayload: { agents: unknown; models: unknown } = { agents: [], models: [] };
let failWith: unknown = null;

/** Creates a stub official client answering from `serverPayload`. */
function makeStubClient(): FakeClient {
  const guard = () => {
    if (failWith) return Promise.reject(failWith);
    return null;
  };
  return {
    agent: {
      list: () => guard() ?? Promise.resolve({ data: serverPayload.agents }),
    },
    model: {
      list: () => guard() ?? Promise.resolve({ data: serverPayload.models }),
    },
  };
}

// Patch the client factory BEFORE capabilities.ts binds to it.
mock.module("./client", () => ({
  createOpenCodeClient: () => makeStubClient(),
}));

const { openCodeServerManager } = await import("./serverManager");
const {
  getOpenCodeCapabilities,
  resolveOpenCodeModelRef,
  resolveOpenCodeVariant,
} = await import("./capabilities");
const { toOpenCodeError, OpenCodeError } = await import("./errors");

// No real server process: ensureBaseUrl answers with a stub base URL.
(openCodeServerManager as unknown as { ensureBaseUrl: () => Promise<string> })
  .ensureBaseUrl = () => Promise.resolve("http://127.0.0.1:0");

function setServer(agents: unknown, models: unknown) {
  serverPayload = { agents, models };
  failWith = null;
}

beforeEach(() => {
  setServer([], []);
});

// Native V2 response: every agent row includes the required display name.
const liveAgents = [
  { id: "build", name: "Build", description: "The default agent." },
  { id: "plan", name: "Plan", description: "Planning agent." },
  { id: "compaction", name: "Compaction" },
];

const liveModels = [
  {
    id: "anthropic/claude-sonnet-4",
    name: "Claude Sonnet 4",
    providerID: "anthropic",
    variants: [{ id: "low" }, { id: "high" }],
  },
  {
    id: "openai/gpt-4o",
    name: "GPT-4o",
    providerID: "openai",
    family: "gpt",
    variants: [],
  },
  // Live servers also expose models whose id carries no provider prefix
  // (e.g. the real `union-alpha` under provider `opencode`).
  {
    id: "union-alpha",
    name: "Union Alpha Free",
    providerID: "opencode",
    variants: [],
  },
];

describe("getOpenCodeCapabilities", () => {
  it("maps the native V2 agent rows and keeps their required names", async () => {
    setServer(liveAgents, liveModels);
    const caps = await getOpenCodeCapabilities();
    expect(caps.agents).toEqual([
      { id: "build", name: "Build", description: "The default agent." },
      { id: "plan", name: "Plan", description: "Planning agent." },
      { id: "compaction", name: "Compaction", description: undefined },
    ]);
  });

  it("omits an agent row missing its required native V2 name", async () => {
    setServer([
      { id: "missing-name", description: "Must not be displayed." },
      { id: "valid", name: "Valid Agent", description: "Displayed." },
    ], []);
    const caps = await getOpenCodeCapabilities();
    expect(caps.agents).toEqual([
      { id: "valid", name: "Valid Agent", description: "Displayed." },
    ]);
  });

  it("prefers a real name when the server supplies one", async () => {
    setServer([{ id: "build", name: "Build Agent" }], []);
    const caps = await getOpenCodeCapabilities();
    expect(caps.agents).toEqual([
      { id: "build", name: "Build Agent", description: undefined },
    ]);
  });

  it("maps models and flattens variant objects to bare ids", async () => {
    setServer([], liveModels);
    const caps = await getOpenCodeCapabilities();
    expect(caps.models).toEqual([
      {
        id: "anthropic/claude-sonnet-4",
        name: "Claude Sonnet 4",
        providerID: "anthropic",
        family: undefined,
        variants: ["low", "high"],
      },
      {
        id: "openai/gpt-4o",
        name: "GPT-4o",
        providerID: "openai",
        family: "gpt",
        variants: [],
      },
      {
        id: "union-alpha",
        name: "Union Alpha Free",
        providerID: "opencode",
        family: undefined,
        variants: [],
      },
    ]);
  });

  it("returns empty lists when the server reports no data (edge case)", async () => {
    setServer(undefined, undefined);
    const caps = await getOpenCodeCapabilities();
    expect(caps.agents).toEqual([]);
    expect(caps.models).toEqual([]);
  });

  it("passes model limits through, omitting the field when absent or mangled", async () => {
    setServer(
      [],
      [
        {
          id: "a/m1",
          name: "M1",
          providerID: "a",
          variants: [],
          limit: { context: 200_000, output: 32_000 },
        },
        { id: "a/m2", name: "M2", providerID: "a", variants: [] },
        {
          id: "a/m3",
          name: "M3",
          providerID: "a",
          variants: [],
          limit: { context: "lots", output: -1 },
        },
      ],
    );
    const caps = await getOpenCodeCapabilities();
    expect(caps.models[0]?.limit).toEqual({ context: 200_000, output: 32_000 });
    expect("limit" in (caps.models[1] ?? {})).toBe(false);
    expect("limit" in (caps.models[2] ?? {})).toBe(false);
  });

  it("degrades to no variants when `variants` is not an array (edge case)", async () => {
    setServer([], [{ id: "m", name: "M", providerID: "p", variants: "nope" }]);
    const caps = await getOpenCodeCapabilities();
    expect(caps.models[0]?.variants).toEqual([]);
  });

  it("rethrows server failures as OpenCodeError (session/HTTP failures stay typed)", async () => {
    failWith = new ClientError("Transport", {
      cause: Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" }),
    });
    await expect(getOpenCodeCapabilities()).rejects.toBeInstanceOf(OpenCodeError);
  });
});

describe("resolveOpenCodeModelRef", () => {
  it("resolves a provider-qualified model id to its ref (happy path)", async () => {
    setServer([], liveModels);
    const ref = await resolveOpenCodeModelRef("openai/gpt-4o");
    expect(ref).toEqual({ providerID: "openai", modelID: "openai/gpt-4o" });
  });

  it("resolves a bare model id against a provider-qualified entry", async () => {
    setServer([], liveModels);
    const ref = await resolveOpenCodeModelRef("union-alpha");
    expect(ref).toEqual({ providerID: "opencode", modelID: "union-alpha" });
  });

  it("returns null for an unknown model id (edge case: caller falls back to defaults)", async () => {
    setServer([], liveModels);
    const ref = await resolveOpenCodeModelRef("provider/does-not-exist");
    expect(ref).toBeNull();
  });
});

describe("resolveOpenCodeVariant", () => {
  it("returns the variant id when the model still offers it", async () => {
    setServer([], liveModels);
    expect(await resolveOpenCodeVariant("union-alpha", "x")).toBeNull();
    expect(await resolveOpenCodeVariant("anthropic/claude-sonnet-4", "high")).toBe("high");
  });

  it("returns null for a stale variant (edge case: omit rather than poison the session)", async () => {
    setServer([], liveModels);
    expect(await resolveOpenCodeVariant("anthropic/claude-sonnet-4", "gone")).toBeNull();
  });
});

describe("toOpenCodeError", () => {
  it("maps a missing session to session_not_found with HTTP 404", () => {
    // The client throws this as a PLAIN OBJECT, not an Error (declared status).
    const thrown = {
      _tag: "SessionNotFoundError",
      sessionID: "ses_missing",
      message: "Session not found: ses_missing",
    };
    const err = toOpenCodeError(thrown);
    expect(err).toBeInstanceOf(OpenCodeError);
    expect(err.kind).toBe("session_not_found");
    expect(err.statusCode).toBe(404);
    expect(err.message).toContain("ses_missing");
  });

  it("maps a transport fault to connection and names the network cause", () => {
    const err = toOpenCodeError(
      new ClientError("Transport", {
        cause: Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" }),
      }),
    );
    expect(err.kind).toBe("connection");
    expect(err.statusCode).toBeUndefined();
    expect(err.message).toContain("network");
    expect(err.message).toContain("ConnectionRefused");
  });

  it("maps an undeclared HTTP status to http and preserves the status code", () => {
    // Preserve the status code when the official client rejects an undeclared HTTP status.
    const err = toOpenCodeError(
      new ClientError("UnexpectedStatus", { cause: { status: 204 } }),
    );
    expect(err.kind).toBe("http");
    expect(err.statusCode).toBe(204);
  });

  it("maps a non-JSON body to malformed", () => {
    const err = toOpenCodeError(new ClientError("UnsupportedContentType"));
    expect(err.kind).toBe("malformed");
  });

  it("is idempotent — an OpenCodeError passes through unchanged", () => {
    const original = new OpenCodeError("http", "already normalized", 500);
    expect(toOpenCodeError(original)).toBe(original);
  });
});
