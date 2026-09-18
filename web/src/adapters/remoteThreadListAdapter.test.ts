import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createRemoteThreadListAdapter } from "./remoteThreadListAdapter";
import { useWelcomeScopeStore } from "../features/chat/state/welcomeScope";
import { useWelcomeEngineStore } from "../features/chat/state/welcomeEngine";

const realFetch = globalThis.fetch;

function stubFetch(
  handler: (url: string, init?: RequestInit) => unknown,
): void {
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const result = handler(String(url), init) as {
      ok?: boolean;
      json?: () => Promise<unknown>;
    };
    if (result !== null && typeof result === "object" && "ok" in result) {
      return result as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => result,
    } as Response;
  }) as typeof fetch;
}

function failure(status: number, error: string): Response {
  return {
    ok: false,
    status,
    json: async () => ({ error }),
  } as Response;
}

describe("adapter initialize() failure contract", () => {
  beforeEach(() => {
    useWelcomeScopeStore.getState().setScope({ mode: "simple", folderId: null });
    useWelcomeEngineStore.setState({ engine: "direct", agent: "", model: "" });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });


  it("resolves remoteId on success", async () => {
    stubFetch(() => ({ id: "c1" }));
    const adapter = createRemoteThreadListAdapter();
    await expect(adapter.initialize('__LOCALID_test')).resolves.toEqual({ remoteId: "c1" });
  });

  it("POST /api/conversations failure → initialize rejects (never undefined remoteId)", async () => {
    stubFetch((url) => {
      if (String(url).endsWith("/api/conversations")) {
        return failure(500, "CHECK constraint failed");
      }
      return {};
    });
    const adapter = createRemoteThreadListAdapter();
    let thrown: unknown;
    try {
      await adapter.initialize('__LOCALID_test');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    // Original backend error stays visible (not masked as conversation_missing).
    expect(String((thrown as Error).message)).toContain("CHECK constraint failed");
  });

  it("project fallback failure → initialize rejects", async () => {
    useWelcomeScopeStore
      .getState()
      .setScope({ mode: "project", folderId: "gone" });
    stubFetch((url) => {
      if (String(url).endsWith("/api/conversations")) {
        return failure(400, "workspaceFolderId is required for project chats");
      }
      return {};
    });
    const adapter = createRemoteThreadListAdapter();
    let thrown: unknown;
    try {
      await adapter.initialize('__LOCALID_test');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
  });
});

describe("adapter initialize() — welcome-engine snapshot pass-through", () => {
  beforeEach(() => {
    useWelcomeScopeStore.getState().setScope({ mode: "simple", folderId: null });
    useWelcomeEngineStore.setState({ engine: "direct", agent: "", model: "" });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("sends the engine + opencode agent/model from the draft store on create", async () => {
    useWelcomeEngineStore.setState({
      engine: "opencode",
      agent: "coder",
      model: "openai/gpt-4o",
    });
    const captured: { body?: unknown } = {};
    // Capture the POST body: wrap fetch to record it.
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith("/api/conversations") && init?.method === "POST") {
        captured.body = JSON.parse(String(init.body));
      }
      return { ok: true, status: 200, json: async () => ({ id: "c-engine" }) } as Response;
    }) as typeof fetch;

    const adapter = createRemoteThreadListAdapter();
    const result = await adapter.initialize("__LOCALID_engine");

    expect(result).toEqual({ remoteId: "c-engine" });
    const posted = captured.body as {
      engine: string;
      opencodeAgent: string | null;
      opencodeModel: string | null;
    };
    expect(posted.engine).toBe("opencode");
    expect(posted.opencodeAgent).toBe("coder");
    expect(posted.opencodeModel).toBe("openai/gpt-4o");

    globalThis.fetch = origFetch;
  });

  it("drops agent/model when the engine is Direct (no OpenCode fields on a Direct create)", async () => {
    // Edge: a stale opencode pick must not leak when the draft is Direct.
    useWelcomeEngineStore.setState({
      engine: "direct",
      agent: "",
      model: "",
    });
    const captured: { body?: unknown } = {};
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith("/api/conversations") && init?.method === "POST") {
        captured.body = JSON.parse(String(init.body));
      }
      return { ok: true, status: 200, json: async () => ({ id: "c-direct" }) } as Response;
    }) as typeof fetch;

    const adapter = createRemoteThreadListAdapter();
    const result = await adapter.initialize("__LOCALID_direct");

    expect(result).toEqual({ remoteId: "c-direct" });
    const posted = captured.body as {
      engine: string;
      opencodeAgent: unknown;
      opencodeModel: unknown;
    };
    expect(posted.engine).toBe("direct");
    expect(posted.opencodeAgent).toBeNull();
    expect(posted.opencodeModel).toBeNull();

    globalThis.fetch = origFetch;
  });
});

