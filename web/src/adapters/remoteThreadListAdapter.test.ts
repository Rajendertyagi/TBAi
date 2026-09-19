import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createRemoteThreadListAdapter } from "./remoteThreadListAdapter";
import { useWelcomeScopeStore } from "../features/chat/state/welcomeScope";
import { useWelcomeEngineStore } from "../features/chat/state/welcomeEngine";
import { useSettingsStore } from "../stores";

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

  it("materializes the draft Auto shield into the create payload", async () => {
    useWelcomeEngineStore.setState({
      engine: "opencode",
      agent: "coder",
      model: "openai/gpt-4o",
      autoApprove: true,
    });
    const captured: { body?: unknown } = {};
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith("/api/conversations") && init?.method === "POST") {
        captured.body = JSON.parse(String(init.body));
      }
      return { ok: true, status: 200, json: async () => ({ id: "c-auto" }) } as Response;
    }) as typeof fetch;

    const adapter = createRemoteThreadListAdapter();
    await adapter.initialize("__LOCALID_auto");

    const posted = captured.body as { opencodeAutoApprove?: unknown };
    expect(posted.opencodeAutoApprove).toBe(true);

    globalThis.fetch = origFetch;
  });

  it("a draft with Auto off materializes as manual (fail closed)", async () => {
    useWelcomeEngineStore.setState({
      engine: "opencode",
      agent: "coder",
      model: "openai/gpt-4o",
      autoApprove: false,
    });
    const captured: { body?: unknown } = {};
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith("/api/conversations") && init?.method === "POST") {
        captured.body = JSON.parse(String(init.body));
      }
      return { ok: true, status: 200, json: async () => ({ id: "c-manual" }) } as Response;
    }) as typeof fetch;

    const adapter = createRemoteThreadListAdapter();
    await adapter.initialize("__LOCALID_manual");

    const posted = captured.body as { opencodeAutoApprove?: unknown };
    expect(posted.opencodeAutoApprove).toBe(false);

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

describe("adapter updateCustom() — Phase 2 authoritative persistence", () => {
  beforeEach(() => {
    useWelcomeScopeStore.getState().setScope({ mode: "simple", folderId: null });
    useWelcomeEngineStore.setState({ engine: "direct", agent: "", model: "" });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function patchStub(
    echo: Record<string, string | null>,
    captured?: { body?: unknown },
  ): void {
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "PATCH" && captured) {
        captured.body = JSON.parse(String(init.body));
      }
      return { ok: true, status: 200, json: async () => echo } as Response;
    }) as typeof fetch;
  }

  it("[P2-05a] resolves when the server echoes the requested config", async () => {
    patchStub({ providerId: "p", modelId: "m", reasoningLevel: "high" });
    const adapter = createRemoteThreadListAdapter();
    await expect(
      adapter.updateCustom!("c1", {
        providerId: "p",
        modelId: "m",
        reasoningLevel: "high",
      }),
    ).resolves.toBeUndefined();
  });

  it("[P2-05b] rejected PATCH (500) throws — never a successful local state", async () => {
    stubFetch(() => failure(500, "boom"));
    const adapter = createRemoteThreadListAdapter();
    let thrown: unknown;
    try {
      await adapter.updateCustom!("c1", { providerId: "p", modelId: "m" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(String((thrown as Error).message)).toContain(
      "Failed to persist conversation config",
    );
  });

  it("[P2-05c] rejected PATCH (400) throws", async () => {
    stubFetch(() => failure(400, "Invalid request"));
    const adapter = createRemoteThreadListAdapter();
    await expect(
      adapter.updateCustom!("c1", { reasoningLevel: "high" }),
    ).rejects.toThrow("Failed to persist conversation config (400)");
  });

  it("[P2-05d] network failure throws instead of resolving", async () => {
    globalThis.fetch = (async (_url: unknown, _init?: RequestInit) => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const adapter = createRemoteThreadListAdapter();
    await expect(
      adapter.updateCustom!("c1", { providerId: "p" }),
    ).rejects.toThrow("network error");
  });

  it("[P2-05e] echo mismatch throws — the write was not reflected", async () => {
    patchStub({ providerId: "other", modelId: "m", reasoningLevel: "high" });
    const adapter = createRemoteThreadListAdapter();
    await expect(
      adapter.updateCustom!("c1", {
        providerId: "p",
        modelId: "m",
        reasoningLevel: "high",
      }),
    ).rejects.toThrow("not reflected by server: providerId");
  });

  it("[P2-05f] passes explicit nulls through so clears persist", async () => {
    const captured: { body?: unknown } = {};
    patchStub(
      { providerId: null, modelId: null, reasoningLevel: null },
      captured,
    );
    const adapter = createRemoteThreadListAdapter();
    await expect(
      adapter.updateCustom!("c1", {
        providerId: null,
        modelId: null,
        reasoningLevel: null,
      }),
    ).resolves.toBeUndefined();
    expect(captured.body).toEqual({
      providerId: null,
      modelId: null,
      reasoningLevel: null,
    });
  });
});

describe("adapter initialize() — Phase 2 one-shot draft carry", () => {
  beforeEach(() => {
    useWelcomeScopeStore.getState().setScope({ mode: "simple", folderId: null });
    useWelcomeEngineStore.setState({ engine: "direct", agent: "", model: "" });
    useSettingsStore.getState().revertChatTarget();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    useWelcomeScopeStore.getState().setScope({ mode: "simple", folderId: null });
    useWelcomeEngineStore.setState({ engine: "direct", agent: "", model: "" });
    useSettingsStore.getState().revertChatTarget();
  });

  function capturePosts(): { bodies: unknown[] } {
    const captured: { bodies: unknown[] } = { bodies: [] };
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith("/api/conversations") && init?.method === "POST") {
        captured.bodies.push(JSON.parse(String(init.body)));
      }
      return { ok: true, status: 200, json: async () => ({ id: "c-p2" }) } as Response;
    }) as typeof fetch;
    return captured;
  }

  it("[P2-06] Direct draft carries one-shot provider/model/reasoning into POST", async () => {
    useSettingsStore.getState().selectChatTarget("prov-one", "model-one");
    useSettingsStore.getState().setSelectedReasoningLevel("high");
    const captured = capturePosts();

    const adapter = createRemoteThreadListAdapter();
    await expect(adapter.initialize("__LOCALID_p2")).resolves.toEqual({
      remoteId: "c-p2",
    });
    const posted = captured.bodies[0] as Record<string, unknown>;
    expect(posted.providerId).toBe("prov-one");
    expect(posted.modelId).toBe("model-one");
    expect(posted.reasoningLevel).toBe("high");
    expect(posted.engine).toBe("direct");
  });

  it("[P2-07] no selection sends nulls — absent stays absent, never baked defaults", async () => {
    const captured = capturePosts();

    const adapter = createRemoteThreadListAdapter();
    await adapter.initialize("__LOCALID_p2bare");

    const posted = captured.bodies[0] as Record<string, unknown>;
    expect(posted.providerId).toBeNull();
    expect(posted.modelId).toBeNull();
    expect(posted.reasoningLevel).toBeNull();
  });

  it("[P2-06b] project fallback retry carries the same fields + opencodeAutoApprove", async () => {
    useWelcomeScopeStore
      .getState()
      .setScope({ mode: "project", folderId: "gone" });
    useSettingsStore.getState().selectChatTarget("prov-retry", "model-retry");
    useSettingsStore.getState().setSelectedReasoningLevel("low");
    const bodies: unknown[] = [];
    let calls = 0;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith("/api/conversations") && init?.method === "POST") {
        calls += 1;
        bodies.push(JSON.parse(String(init.body)));
        if (calls === 1) return failure(400, "stale folder");
      }
      return { ok: true, status: 200, json: async () => ({ id: "c-retry" }) } as Response;
    }) as typeof fetch;

    const adapter = createRemoteThreadListAdapter();
    await expect(adapter.initialize("__LOCALID_retry")).resolves.toEqual({
      remoteId: "c-retry",
    });
    expect(bodies).toHaveLength(2);
    const retry = bodies[1] as Record<string, unknown>;
    expect(retry.workspaceMode).toBe("simple");
    expect(retry.providerId).toBe("prov-retry");
    expect(retry.modelId).toBe("model-retry");
    expect(retry.reasoningLevel).toBe("low");
    expect(retry.opencodeAutoApprove).toBe(false);
  });
});

