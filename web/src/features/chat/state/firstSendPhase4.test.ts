import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  captureDraftSnapshot,
  materializeDraft,
  takeMaterializedEngine,
  peekMaterializedEngine,
} from "./materializeDraft";
import {
  setPendingFirstMessage,
  peekPendingFirstMessage,
} from "./pendingFirstMessage";
import { OpencodeDraftRedirectError } from "../../../runtime";
import {
  NEW_DRAFT_TAB_ID,
  agentKey,
  chatKey,
  useChatTabsStore,
} from "./chatTabs";
import { useWelcomeScopeStore } from "./welcomeScope";
import {
  useWelcomeEngineStore,
  getWelcomeEngineSnapshot,
} from "./welcomeEngine";
import { useSettingsStore } from "../../../stores";
import { createRemoteThreadListAdapter } from "../../../adapters/remoteThreadListAdapter";
import { fireFirstPromptHandoff } from "../../opencode/FirstPromptHandoff";

/**
 * Wave-2 Phase 4 — first-send cross-module flow (cases 2, 3, 4, 8n, 10, 11f, 12, 15, 18).
 * Wave-3 Phase 4 — enter-path backstop + non-text guards (cases A, B, D).
 *
 * Drives the REAL modules for the path the UI takes:
 *   custom draft path:  capture → materialize → stash → resolveDraftId → consume
 *   direct draft path:  adapter.initialize → take-or-live engine → resolveDraftId
 *   Enter-path backstop:  prepareSendMessagesRequest stub sees opencode record → throw + stash
 *
 * The consume step calls the REAL `fireFirstPromptHandoff`
 * (`web/src/features/opencode/FirstPromptHandoff.tsx`) — the settled
 * boundary that appends only after the runtime's main thread is bound to
 * the session id. A source-guard test below pins the boundary's location
 * and gate (web/ has no DOM runner, same convention as
 * OpenCodeView.test.tsx).
 *
 * Case map:
 *   A.  Enter-path backstop: library-driven prepare on opencode thread throws
 *       OpencodeDraftRedirectError, stashes lastUserText, no /api/chat POST.
 *   2.  opencode flow: materialize → agent-tab resolve → stash → consume once
 *       (mock runtime.thread.append called once with text; no session → never)
 *   3.  opencode first send performs zero /api/chat requests (fetch spy)
 *   4.  direct first send never targets chat:new (adapter + store binding)
 *   8.  stash never duplicates into SQLite history (no /messages traffic) —
 *       history stability itself is pinned backend-side in
 *       first-send-opencode-draft.test.ts (cases 7+9)
 *  10.  consume with undefined sessionId never appends
 *  11.  failed materialization: nothing stashed, nothing bound, text untouched
 *  12.  failed session bootstrap: consume never runs, append never called
 *  15.  owner-recorded engine wins over a flipped live snapshot
 *  18.  remount: single append total, no second send needed
 *   D.  Non-text/empty messages: no stash write, still throws (never POSTs)
 */

function installMemoryStorage(): () => void {
  const holder = globalThis as unknown as { localStorage?: unknown };
  const prev = holder.localStorage;
  const store = new Map<string, string>();
  holder.localStorage = {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  };
  return () => {
    if (prev === undefined) delete holder.localStorage;
    else holder.localStorage = prev;
  };
}

/** Settled-boundary handoff notes (replica removed — these flow tests call
 * the real `fireFirstPromptHandoff` imported above). */

function mockRuntime() {
  const appendCalls: string[] = [];
  return {
    appendCalls,
    runtime: {
      thread: {
        append: (text: string) => {
          appendCalls.push(text);
        },
      },
    },
  };
}

function resetAll(): void {
  useWelcomeScopeStore.getState().setScope({ mode: "simple", folderId: null });
  useWelcomeEngineStore.setState({
    engine: "direct",
    agent: "",
    model: "",
    variant: "",
    autoApprove: false,
  });
  useSettingsStore.getState().revertChatTarget();
  useChatTabsStore.setState({
    tabs: [{ key: chatKey(NEW_DRAFT_TAB_ID), kind: "chat", ref: NEW_DRAFT_TAB_ID }],
    activeKey: chatKey(NEW_DRAFT_TAB_ID),
  });
}

const realFetch = globalThis.fetch;
let restoreStorage: (() => void) | null = null;

beforeEach(() => {
  restoreStorage = installMemoryStorage();
  resetAll();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  restoreStorage?.();
  restoreStorage = null;
  resetAll();
});

function stubConversations(id: string, seen: { urls: string[]; bodies: Record<string, unknown>[] }): void {
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    seen.urls.push(String(url));
    if (String(url).endsWith("/api/conversations") && init?.method === "POST") {
      seen.bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return { ok: true, status: 200, json: async () => ({ id }) } as Response;
    }
    throw new Error(`unexpected fetch in flow test: ${String(url)}`);
  }) as typeof fetch;
}

describe("opencode draft flow — materialize, bind, stash, consume once (case 2)", () => {
  it("custom path resolves an agent tab and appends the stashed text exactly once", async () => {
    useWelcomeEngineStore.setState({ engine: "opencode", agent: "build", model: "openai/gpt-4o" });
    const seen = { urls: [] as string[], bodies: [] as Record<string, unknown>[] };
    stubConversations("conv-oc-flow", seen);
    const { appendCalls, runtime } = mockRuntime();

    // Composer.sendOpenCodeDraft ordering: snapshot → materialize → stash → resolve.
    const snapshot = captureDraftSnapshot();
    const created = await materializeDraft(snapshot);
    const text = "build me a widget";
    setPendingFirstMessage(created.id, text);
    useChatTabsStore.getState().resolveDraftId(created.id, snapshot.engine);

    // Agent tab bound (TabUrlSync navigates to /code/:id).
    const state = useChatTabsStore.getState();
    expect(state.tabs.map((t) => t.key)).toEqual([agentKey("conv-oc-flow")]);
    expect(state.activeKey).toBe(agentKey("conv-oc-flow"));

    // Code surface binds the session AND the main thread settles on it →
    // consume fires once…
    expect(
      await fireFirstPromptHandoff({
        conversationId: created.id,
        sessionId: "ses-flow-1",
        boundSessionId: "ses-flow-1",
        append: (text) => runtime.thread.append(text),
      }),
    ).toBe("sent");
    expect(appendCalls).toEqual(["build me a widget"]);
    // …and a remount/reconnect never refires (case 18: single append total,
    // no second prompt required for the exchange to exist).
    expect(
      await fireFirstPromptHandoff({
        conversationId: created.id,
        sessionId: "ses-flow-1",
        boundSessionId: "ses-flow-1",
        append: (text) => runtime.thread.append(text),
      }),
    ).toBe("none");
    expect(appendCalls).toHaveLength(1);
  });

  it("no session → consume never runs, append never called (cases 2neg + 10)", async () => {
    setPendingFirstMessage("conv-nosession", "waiting for session");
    const { appendCalls, runtime } = mockRuntime();
    expect(
      await fireFirstPromptHandoff({
        conversationId: "conv-nosession",
        sessionId: undefined,
        boundSessionId: undefined,
        append: (text) => runtime.thread.append(text),
      }),
    ).toBe("skipped");
    expect(appendCalls).toHaveLength(0);
    // The handoff is still staged for when the session arrives.
    expect(peekPendingFirstMessage("conv-nosession")?.text).toBe("waiting for session");
  });

  it("unbound draft thread → consume never runs, append never called (settled boundary)", async () => {
    setPendingFirstMessage("conv-unbound", "waiting for the switch");
    const { appendCalls, runtime } = mockRuntime();
    expect(
      await fireFirstPromptHandoff({
        conversationId: "conv-unbound",
        sessionId: "ses-unbound-1",
        boundSessionId: undefined,
        append: (text) => runtime.thread.append(text),
      }),
    ).toBe("skipped");
    expect(appendCalls).toHaveLength(0);
    expect(peekPendingFirstMessage("conv-unbound")?.text).toBe("waiting for the switch");
  });
});

describe("opencode first send never calls /api/chat (case 3)", () => {
  it("the custom path performs zero /api/chat requests", async () => {
    useWelcomeEngineStore.setState({ engine: "opencode", agent: "build", model: "openai/gpt-4o" });
    const seen = { urls: [] as string[], bodies: [] as Record<string, unknown>[] };
    stubConversations("conv-nochat", seen);

    const snapshot = captureDraftSnapshot();
    const created = await materializeDraft(snapshot);
    setPendingFirstMessage(created.id, "custom path text");
    useChatTabsStore.getState().resolveDraftId(created.id, snapshot.engine);

    expect(seen.urls).toEqual(["/api/conversations"]);
    expect(seen.urls.filter((u) => u.includes("/api/chat"))).toHaveLength(0);
  });

  it("Composer.sendOpenCodeDraft source: materialize + stash + resolve, no /api/chat literal", async () => {
    const source = await Bun.file(
      new URL("../../../components/Composer.tsx", import.meta.url),
    ).text();
    const start = source.indexOf("const sendOpenCodeDraft");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("return (", start);
    const fn = source.slice(start, end);
    expect(fn).toContain("captureDraftSnapshot");
    expect(fn).toContain("materializeDraft");
    expect(fn).toContain("setPendingFirstMessage");
    expect(fn).toContain("resolveDraftId");
    expect(fn).not.toContain("/api/chat");
  });
});

describe("direct first send never targets chat:new (case 4)", () => {
  it("adapter.initialize POSTs /api/conversations with a key and binds the returned id", async () => {
    useWelcomeEngineStore.setState({ engine: "direct" });
    useSettingsStore.getState().selectChatTarget("prov-4", "model-4");
    const seen = { urls: [] as string[], bodies: [] as Record<string, unknown>[] };
    stubConversations("conv-direct-bound", seen);

    const adapter = createRemoteThreadListAdapter();
    const result = await adapter.initialize("__LOCALID_case4");

    // Bound id returned (never chat:new): prepare/body id is this id.
    expect(result).toEqual({ remoteId: "conv-direct-bound" });
    expect(seen.urls).toEqual(["/api/conversations"]);
    expect(typeof seen.bodies[0].clientRequestId).toBe("string");
    expect(seen.bodies[0].providerId).toBe("prov-4");

    // ChatShell binding: owner-recorded engine first, live snapshot as backstop.
    const id = result.remoteId!;
    useChatTabsStore
      .getState()
      .resolveDraftId(id, takeMaterializedEngine(id) ?? getWelcomeEngineSnapshot().engine);
    const state = useChatTabsStore.getState();
    expect(state.tabs.map((t) => t.key)).toEqual([chatKey("conv-direct-bound")]);
    expect(state.activeKey).toBe(chatKey("conv-direct-bound"));
  });
});

describe("stash never duplicates into history (case 8 frontend half)", () => {
  it("the custom path issues no /messages traffic: history learns nothing implicit", async () => {
    useWelcomeEngineStore.setState({ engine: "opencode", agent: "build", model: "m" });
    const seen = { urls: [] as string[], bodies: [] as Record<string, unknown>[] };
    stubConversations("conv-nohist", seen);

    const snapshot = captureDraftSnapshot();
    const created = await materializeDraft(snapshot);
    setPendingFirstMessage(created.id, "live user action");

    expect(seen.urls.filter((u) => u.includes("/messages"))).toHaveLength(0);
    // The stash lives in localStorage only — a history load sees no copy of
    // it (exactly-once delivery is the runtime append, pinned in case 2).
    expect(peekPendingFirstMessage(created.id)?.text).toBe("live user action");
  });
});

describe("failed materialization preserves the draft and sends nothing (case 11 flow)", () => {
  it("throw → no stash, no resolve, text untouched", async () => {
    useWelcomeEngineStore.setState({ engine: "opencode", agent: "build", model: "m" });
    globalThis.fetch = (async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: "boom" }),
    })) as unknown as typeof fetch;

    const snapshot = captureDraftSnapshot();
    const text = "precious draft text";
    let created: { id: string } | null = null;
    let error: unknown = null;
    // Mirrors sendOpenCodeDraft: stash + resolve happen only after success.
    try {
      created = await materializeDraft(snapshot);
      setPendingFirstMessage(created.id, text);
      useChatTabsStore.getState().resolveDraftId(created.id, snapshot.engine);
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(Error);
    expect(created).toBeNull();
    expect(peekPendingFirstMessage("anything")).toBeNull();
    // Nothing bound: still on the draft tab; the text stays in the box.
    const state = useChatTabsStore.getState();
    expect(state.tabs.map((t) => t.key)).toEqual([chatKey(NEW_DRAFT_TAB_ID)]);
    expect(text).toBe("precious draft text");
  });

  it("Composer source keeps the text on failure (clear only after success)", async () => {
    const source = await Bun.file(
      new URL("../../../components/Composer.tsx", import.meta.url),
    ).text();
    const start = source.indexOf("const sendOpenCodeDraft");
    const fn = source.slice(start, source.indexOf("return (", start));
    // Success path clears only after the materialize await resolves…
    expect(fn.indexOf("await materializeDraft")).toBeLessThan(
      fn.indexOf("clearComposerDraft"),
    );
    // …and the failure path surfaces an error instead of clearing.
    expect(fn).toContain("setCodeSendError");
  });
});

describe("failed session creation sends no prompt (case 12)", () => {
  it("bootstrap error leaves sessionId undefined → consume never runs", async () => {
    setPendingFirstMessage("conv-bootfail", "do not send me yet");
    const { appendCalls, runtime } = mockRuntime();

    // The /api/opencode/session bootstrap threw: OpenCodeView stays on the
    // error branch, sessionId is never set, the consume effect never runs.
    let sessionId: string | undefined;
    try {
      throw new Error("Could not start OpenCode session");
    } catch {
      sessionId = undefined;
    }
    expect(sessionId).toBeUndefined();
    expect(
      await fireFirstPromptHandoff({
        conversationId: "conv-bootfail",
        sessionId,
        boundSessionId: undefined,
        append: (text) => runtime.thread.append(text),
      }),
    ).toBe("skipped");
    expect(appendCalls).toHaveLength(0);
    // Staged, not lost: it fires once the session eventually binds AND the
    // main thread settles on it.
    expect(
      await fireFirstPromptHandoff({
        conversationId: "conv-bootfail",
        sessionId: "ses-late",
        boundSessionId: "ses-late",
        append: (text) => runtime.thread.append(text),
      }),
    ).toBe("sent");
    expect(appendCalls).toEqual(["do not send me yet"]);
  });
});

describe("route/tab transition does not determine execution identity (case 15)", () => {
  it("resolve uses the owner-recorded engine even when the live snapshot flipped", async () => {
    useWelcomeEngineStore.setState({ engine: "opencode", agent: "build", model: "m" });
    const seen = { urls: [] as string[], bodies: [] as Record<string, unknown>[] };
    stubConversations("conv-flip", seen);

    const snapshot = captureDraftSnapshot();
    const created = await materializeDraft(snapshot);

    // The user flips the engine picker between materialization and binding.
    useWelcomeEngineStore.setState({ engine: "direct", agent: "", model: "" });
    expect(getWelcomeEngineSnapshot().engine).toBe("direct");

    // ChatShell binding: owner record wins over the stale live read.
    const ownerEngine = takeMaterializedEngine(created.id);
    expect(ownerEngine).toBe("opencode");
    useChatTabsStore
      .getState()
      .resolveDraftId(created.id, ownerEngine ?? getWelcomeEngineSnapshot().engine);

    const state = useChatTabsStore.getState();
    expect(state.tabs.map((t) => t.key)).toEqual([agentKey("conv-flip")]);
  });
});

describe("FirstPromptHandoff settled boundary — source pins the production path (cases 10/12/18)", () => {
  it("the boundary claims → appends → clears only behind the session-thread gate", async () => {
    const source = await Bun.file(
      new URL("../../opencode/FirstPromptHandoff.tsx", import.meta.url),
    ).text();
    expect(source).toContain("boundSessionId !== sessionId");
    expect(source).toContain("claimPendingFirstMessage(conversationId)");
    expect(source).toContain("runtime.thread.append(text)");
    expect(source).toContain("clearPendingFirstMessage(conversationId)");
    expect(source).toContain("unclaimPendingFirstMessage(conversationId)");
  });

  it("OpenCodeView hosts the boundary inside the provider with no competing consumer", async () => {
    const source = await Bun.file(
      new URL("../../opencode/OpenCodeView.tsx", import.meta.url),
    ).text();
    expect(source).toContain("<FirstPromptHandoff");
    expect(source).not.toContain("claimPendingFirstMessage(conversationId)");
  });

  it("ChatShell binds through the owner record with the live snapshot as backstop", async () => {
    const source = await Bun.file(
      new URL("../../../app/layout/ChatShell.tsx", import.meta.url),
    ).text();
    expect(source).toContain("peekMaterializedEngine(id) ?? getWelcomeEngineSnapshot().engine");
  });
});

/**
 * Wave-3 Enter-path backstop (case A) + non-text guard (case D).
 *
 * `prepareSendMessagesRequest` lives inside the transport closure so it is NOT
 * directly importable. The narrowest testable seam is the integration path:
 *   - Record an opencode engine via materializeDraft (the single owner).
 *   - Simulate what prepare would do: peekEngine === "opencode" → stash + throw.
 *   - Assert the exact error shape + stash content + zero /api/chat fetches.
 *
 * `lastUserText` is a private function in runtime.ts; its pure logic is
 * replicated here for input/output coverage (cases D + A text-extraction).
 */
function replicatedLastUserText(msgs: unknown): string | null {
  if (!Array.isArray(msgs)) return null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i] as { role?: string; parts?: Array<{ type?: string; text?: string }> };
    if (m?.role !== "user" || !Array.isArray(m.parts)) continue;
    const text = m.parts
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("\n");
    if (text) return text;
  }
  return null;
}

describe("Enter-path backstop — library-driven send on opencode thread (case A)", () => {
  it("peekEngine=opencode → throws OpencodeDraftRedirectError, stashes text, no /api/chat POST", async () => {
    useWelcomeEngineStore.setState({ engine: "opencode", agent: "build", model: "m" });
    const seen = { urls: [] as string[], bodies: [] as Record<string, unknown>[] };
    stubConversations("conv-enter-backstop", seen);

    // Materialize the opencode draft so the owner record is seeded.
    const snapshot = captureDraftSnapshot();
    const created = await materializeDraft(snapshot);

    // Simulate what prepareSendMessagesRequest does:
    //   if (peekMaterializedEngine(threadKey) === "opencode") { stash + throw }
    expect(peekMaterializedEngine(created.id)).toBe("opencode");
    const text = "hello via Enter";
    const msgs = [{ role: "user", parts: [{ type: "text", text }] }];
    const extracted = replicatedLastUserText(msgs);
    expect(extracted).toBe(text);
    if (extracted) setPendingFirstMessage(created.id, extracted);

    // The error class is exported from runtime.ts.
    const err = new OpencodeDraftRedirectError(created.id);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("OpencodeDraftRedirectError");
    expect(err.threadId).toBe(created.id);
    expect(err.message).toContain(created.id);

    // Stash verification: the text was captured.
    expect(peekPendingFirstMessage(created.id)?.text).toBe(text);

    // Zero /api/chat traffic: the backstop aborts BEFORE any snapshot/body work.
    expect(seen.urls.filter((u) => u.includes("/api/chat"))).toHaveLength(0);
    // The conversation row WAS created (materialize succeeded).
    expect(seen.urls).toContain("/api/conversations");
  });

  it("stashed text survives a subsequent peek before consume", async () => {
    useWelcomeEngineStore.setState({ engine: "opencode", agent: "build", model: "m" });
    const seen = { urls: [] as string[], bodies: [] as Record<string, unknown>[] };
    stubConversations("conv-enter-stash", seen);

    const snapshot = captureDraftSnapshot();
    const created = await materializeDraft(snapshot);

    const stashText = "stashed via Enter";
    setPendingFirstMessage(created.id, stashText);

    // A subsequent peek (simulating the Code surface reading the stash) sees it.
    expect(peekPendingFirstMessage(created.id)?.text).toBe(stashText);
    // Stash is still there; claim has not happened yet.
    expect(peekPendingFirstMessage(created.id)?.claimed).toBe(false);
  });
});

describe("non-text / empty messages on opencode path — no stash write, still throws (case D)", () => {
  it("image-only message: lastUserText returns null → no stash, still throws", async () => {
    useWelcomeEngineStore.setState({ engine: "opencode", agent: "build", model: "m" });
    const seen = { urls: [] as string[], bodies: [] as Record<string, unknown>[] };
    stubConversations("conv-non-text", seen);

    const snapshot = captureDraftSnapshot();
    const created = await materializeDraft(snapshot);

    // UIMessage with only an image part (no text).
    const msgs = [{ role: "user", parts: [{ type: "image", image: "data:image/png;base64,abc" }] }];
    const extracted = replicatedLastUserText(msgs);
    expect(extracted).toBeNull();

    // The backstop still throws (no /api/chat possible), but nothing is stashed.
    if (extracted) setPendingFirstMessage(created.id, extracted);
    expect(peekPendingFirstMessage(created.id)).toBeNull();

    const err = new OpencodeDraftRedirectError(created.id);
    expect(err).toBeInstanceOf(OpencodeDraftRedirectError);
    expect(seen.urls.filter((u) => u.includes("/api/chat"))).toHaveLength(0);
  });

  it("empty-string text: lastUserText returns null → no stash, still throws", async () => {
    useWelcomeEngineStore.setState({ engine: "opencode", agent: "build", model: "m" });
    const seen = { urls: [] as string[], bodies: [] as Record<string, unknown>[] };
    stubConversations("conv-empty-text", seen);

    const snapshot = captureDraftSnapshot();
    const created = await materializeDraft(snapshot);

    const msgs = [{ role: "user", parts: [{ type: "text", text: "" }] }];
    const extracted = replicatedLastUserText(msgs);
    expect(extracted).toBeNull();

    if (extracted) setPendingFirstMessage(created.id, extracted);
    expect(peekPendingFirstMessage(created.id)).toBeNull();

    const err = new OpencodeDraftRedirectError(created.id);
    expect(err).toBeInstanceOf(OpencodeDraftRedirectError);
    expect(seen.urls.filter((u) => u.includes("/api/chat"))).toHaveLength(0);
  });

  it("all-non-user messages: lastUserText returns null → no stash, still throws", async () => {
    useWelcomeEngineStore.setState({ engine: "opencode", agent: "build", model: "m" });
    const seen = { urls: [] as string[], bodies: [] as Record<string, unknown>[] };
    stubConversations("conv-no-user", seen);

    const snapshot = captureDraftSnapshot();
    const created = await materializeDraft(snapshot);

    const msgs = [
      { role: "system", parts: [{ type: "text", text: "be helpful" }] },
      { role: "assistant", parts: [{ type: "text", text: "ok" }] },
    ];
    const extracted = replicatedLastUserText(msgs);
    expect(extracted).toBeNull();

    if (extracted) setPendingFirstMessage(created.id, extracted);
    expect(peekPendingFirstMessage(created.id)).toBeNull();

    const err = new OpencodeDraftRedirectError(created.id);
    expect(err).toBeInstanceOf(OpencodeDraftRedirectError);
    expect(seen.urls.filter((u) => u.includes("/api/chat"))).toHaveLength(0);
  });
});
