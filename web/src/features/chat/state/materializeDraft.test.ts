import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  captureDraftSnapshot,
  materializeDraft,
  takeMaterializedEngine,
  peekMaterializedEngine,
  currentDraftClientRequestId,
  type DraftSnapshot,
} from "./materializeDraft";
import { useWelcomeScopeStore } from "./welcomeScope";
import { useWelcomeEngineStore } from "./welcomeEngine";
import { useSettingsStore } from "../../../stores";

/**
 * Wave-2 Phase 4 — draft materialization owner (cases 4p, 5, 11p, 13, 14, 16p).
 *
 * `materializeDraft` is the single owner both first-send paths converge on
 * (Direct adapter.initialize + OpenCode custom send). These tests pin:
 *   - snapshot → POST body field pass-through (draft picks reach the request)
 *   - absent picks stay null, never global active values (case 14)
 *   - stable idempotency key per draft until success (cases 5 + 11)
 *   - project-fallback retry carries all fields with the SAME key
 *   - take-once engine record for tab binding (case 15 half)
 *   - failure throws visibly, never an undefined id (case 11)
 *   - no timer-based waits in this module (case 16)
 *
 * Store hygiene mirrors remoteThreadListAdapter.test.ts: scope/engine/one-shot
 * state is reset in beforeEach/afterEach so tests never leak picks.
 */

const realFetch = globalThis.fetch;

function okConversation(id: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ id }),
  } as Response;
}

function failure(status: number, error: string): Response {
  return {
    ok: false,
    status,
    json: async () => ({ error }),
  } as Response;
}

function resetDraftStores(): void {
  useWelcomeScopeStore.getState().setScope({ mode: "simple", folderId: null });
  useWelcomeEngineStore.setState({
    engine: "direct",
    agent: "",
    model: "",
    variant: "",
    autoApprove: false,
  });
  useSettingsStore.getState().revertChatTarget();
}

beforeEach(() => {
  resetDraftStores();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetDraftStores();
});

function stubPost(handler: (body: Record<string, unknown>, call: number) => Response | Promise<Response>, onCall?: (url: string) => void): { bodies: Record<string, unknown>[]; urls: string[] } {
  const bodies: Record<string, unknown>[] = [];
  const urls: string[] = [];
  let calls = 0;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    urls.push(String(url));
    onCall?.(String(url));
    if (String(url).endsWith("/api/conversations") && init?.method === "POST") {
      calls += 1;
      const parsed = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(parsed);
      return handler(parsed, calls);
    }
    return okConversation("unexpected");
  }) as typeof fetch;
  return { bodies, urls };
}

describe("materializeDraft — Direct snapshot reaches the first request (case 13 direct)", () => {
  it("carries one-shot provider/model/reasoning + clientRequestId into POST /api/conversations", async () => {
    useWelcomeEngineStore.setState({ engine: "direct" });
    useSettingsStore.getState().selectChatTarget("prov-draft", "model-draft");
    useSettingsStore.getState().setSelectedReasoningLevel("high");
    const { bodies, urls } = stubPost(() => okConversation("c-direct-p4"));

    const snapshot = captureDraftSnapshot();
    expect(snapshot.engine).toBe("direct");
    const created = await materializeDraft(snapshot);

    expect(created).toEqual({ id: "c-direct-p4" });
    expect(urls).toEqual(["/api/conversations"]);
    const posted = bodies[0];
    expect(posted.providerId).toBe("prov-draft");
    expect(posted.modelId).toBe("model-draft");
    expect(posted.reasoningLevel).toBe("high");
    expect(posted.engine).toBe("direct");
    expect(typeof posted.clientRequestId).toBe("string");
    expect((posted.clientRequestId as string).length).toBeGreaterThan(0);
    // OpenCode fields stay null on a Direct create (no leak across engines).
    expect(posted.opencodeAgent).toBeNull();
    expect(posted.opencodeModel).toBeNull();
  });
});

describe("materializeDraft — OpenCode snapshot reaches the first request (case 13 opencode)", () => {
  it("carries agent/model/variant/autoApprove + clientRequestId, Direct picks stay null", async () => {
    useWelcomeEngineStore.setState({
      engine: "opencode",
      agent: "coder",
      model: "openai/gpt-4o",
      variant: "high",
      autoApprove: true,
    });
    const { bodies } = stubPost(() => okConversation("c-oc-p4"));

    const snapshot = captureDraftSnapshot();
    expect(snapshot.engine).toBe("opencode");
    await materializeDraft(snapshot);

    const posted = bodies[0];
    expect(posted.engine).toBe("opencode");
    expect(posted.opencodeAgent).toBe("coder");
    expect(posted.opencodeModel).toBe("openai/gpt-4o");
    expect(posted.opencodeVariant).toBe("high");
    expect(posted.opencodeAutoApprove).toBe(true);
    expect(posted.providerId).toBeNull();
    expect(posted.modelId).toBeNull();
    expect(posted.reasoningLevel).toBeNull();
    expect(typeof posted.clientRequestId).toBe("string");
  });
});

describe("materializeDraft — global defaults never replace explicit draft picks (case 14)", () => {
  it("absent picks materialize as nulls even when a global active provider exists", async () => {
    // A global default is configured, but the draft picked nothing.
    useSettingsStore.getState().setActiveProvider("active-global");
    useWelcomeEngineStore.setState({ engine: "direct" });
    const { bodies } = stubPost(() => okConversation("c-bare-p4"));

    await materializeDraft(captureDraftSnapshot());

    const posted = bodies[0];
    expect(posted.providerId).toBeNull();
    expect(posted.modelId).toBeNull();
    expect(posted.reasoningLevel).toBeNull();
  });
});

describe("materializeDraft — exactly-once key discipline (cases 5 + 11)", () => {
  it("concurrent materializeDraft calls with one snapshot send the SAME key; same-key replays resolve one id", async () => {
    useWelcomeEngineStore.setState({ engine: "direct" });
    // Emulate the server singleflight: same key → same row id.
    const rows = new Map<string, string>();
    const seen = stubPost(async (body) => {
      await Bun.sleep(10);
      const key = body.clientRequestId as string;
      if (!rows.has(key)) rows.set(key, `row-for-${rows.size}`);
      return okConversation(rows.get(key)!);
    });

    const snapshot: DraftSnapshot = captureDraftSnapshot();
    const [first, second] = await Promise.all([
      materializeDraft(snapshot),
      materializeDraft(snapshot),
    ]);

    // The owner sends the stable draft identity on both attempts (two POSTs —
    // client dedup lives in the SDK task + server singleflight, pinned by the
    // backend case-6 test), so the server resolves both to one conversation.
    expect(seen.bodies).toHaveLength(2);
    expect(seen.bodies[0].clientRequestId).toBe(seen.bodies[1].clientRequestId);
    expect(first.id).toBe(second.id);
  });

  it("failed materialization throws visibly and RETAINS the key for retry (case 11)", async () => {
    useWelcomeEngineStore.setState({ engine: "direct" });
    stubPost(() => failure(500, "CHECK constraint failed"));
    const snapshot = captureDraftSnapshot();
    const keyBefore = snapshot.clientRequestId;

    let thrown: unknown;
    try {
      await materializeDraft(snapshot);
    } catch (err) {
      thrown = err;
    }
    // Never an undefined id: the failure is loud, the draft (text included)
    // is retained by the caller, nothing is stashed or bound.
    expect(thrown).toBeInstanceOf(Error);
    expect(String((thrown as Error).message)).toContain("500");
    expect(String((thrown as Error).message)).toContain("CHECK constraint failed");
    // Key retained: a retry replays the SAME identity so a commit the client
    // never saw still resolves to one row.
    expect(currentDraftClientRequestId()).toBe(keyBefore);
  });

  it("success rotates the key: the next draft gets a fresh identity", async () => {
    useWelcomeEngineStore.setState({ engine: "direct" });
    stubPost(() => okConversation("c-rotate-p4"));
    const keyBefore = currentDraftClientRequestId();
    await materializeDraft(captureDraftSnapshot());
    expect(currentDraftClientRequestId()).not.toBe(keyBefore);
  });

  it("project-fallback retry carries the same fields with the SAME key", async () => {
    useWelcomeScopeStore.getState().setScope({ mode: "project", folderId: "gone" });
    useSettingsStore.getState().selectChatTarget("prov-retry", "model-retry");
    useSettingsStore.getState().setSelectedReasoningLevel("low");
    const { bodies } = stubPost((_, call) =>
      call === 1 ? failure(400, "stale folder") : okConversation("c-fallback-p4"),
    );

    const created = await materializeDraft(captureDraftSnapshot());

    expect(created).toEqual({ id: "c-fallback-p4" });
    expect(bodies).toHaveLength(2);
    expect(bodies[0].workspaceMode).toBe("project");
    const retry = bodies[1];
    expect(retry.workspaceMode).toBe("simple");
    expect(retry.workspaceFolderId).toBeNull();
    expect(retry.providerId).toBe("prov-retry");
    expect(retry.modelId).toBe("model-retry");
    expect(retry.reasoningLevel).toBe("low");
    expect(retry.clientRequestId).toBe(bodies[0].clientRequestId);
  });
});

describe("materializeDraft — take-once engine record (case 15 owner half)", () => {
  it("records the materialized engine once; second take returns null", async () => {
    useWelcomeEngineStore.setState({ engine: "opencode", agent: "coder", model: "m", variant: "", autoApprove: false });
    stubPost(() => okConversation("c-engine-record"));
    const created = await materializeDraft(captureDraftSnapshot());
    expect(takeMaterializedEngine(created.id)).toBe("opencode");
    expect(takeMaterializedEngine(created.id)).toBeNull();
  });

  it("unknown ids take as null (rows the owner did not create fall back to the live snapshot)", () => {
    expect(takeMaterializedEngine("never-materialized")).toBeNull();
  });
});

describe("materializeDraft — peek is non-destructive (case B)", () => {
  it("double peek returns the same value; take-after-peek still takes", async () => {
    useWelcomeEngineStore.setState({ engine: "opencode", agent: "coder", model: "m", variant: "", autoApprove: false });
    stubPost(() => okConversation("c-peek"));
    const created = await materializeDraft(captureDraftSnapshot());

    // Peek is non-destructive: repeated reads are stable.
    expect(peekMaterializedEngine(created.id)).toBe("opencode");
    expect(peekMaterializedEngine(created.id)).toBe("opencode");
    // Take is still destructive: consumes the record.
    expect(takeMaterializedEngine(created.id)).toBe("opencode");
    expect(peekMaterializedEngine(created.id)).toBeNull();
  });

  it("peek on an unrecorded id returns null (no false positives)", () => {
    expect(peekMaterializedEngine("never-seen")).toBeNull();
  });
});

describe("materializeDraft — no timing sleeps (case 16)", () => {
  it("the module contains no timer-based waits", async () => {
    const source = await Bun.file(new URL("./materializeDraft.ts", import.meta.url)).text();
    expect(source).not.toContain("setTimeout");
    expect(source).not.toContain("setInterval");
    expect(source).not.toContain("Bun.sleep");
  });
});
