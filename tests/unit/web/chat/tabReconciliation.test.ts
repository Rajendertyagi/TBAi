/**
 * Confirmed-gone cleanup and boot reconciliation (shared workspace model).
 *
 * Reconciliation is REMOVAL-ONLY: `exists` has no write path, `unknown`
 * cannot erase anything. Only confirmed `gone` may evict local presentation
 * and clean up shared membership.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import path from "node:path";
import {
  evictIfGone,
  isConfirmedGone,
  reconcileTabMirror,
} from "@web/features/chat/state/tabReconciliation.ts";
import { ConversationNotFoundError } from "@web/features/chat/state/conversationExistence.ts";
import { usePreferencesStore } from "@web/features/preferences/state/preferencesStore";
import { chatKey, useChatTabsStore, visibleTabs } from "@web/features/chat/state/chatTabs.ts";
import { setClientTransportEnabled, setLogLevel } from "@web/lib/logger.ts";
import { REPO_ROOT } from "../../../helpers/repo-root";

const realFetch = globalThis.fetch;

setClientTransportEnabled(false);
setLogLevel("error");

const store = () => useChatTabsStore.getState();
const prefs = () => usePreferencesStore.getState();
const refs = () => (prefs().snapshot?.sharedTabs ?? []).map((t) => t.ref);

function reset() {
  useChatTabsStore.setState({
    localActiveKey: undefined,
    hasLocalDraft: false,
    detachedRefs: {},
    membershipFailures: {},
    suppressedDelayedAdds: {},
  });
  usePreferencesStore.setState({
    snapshot: {
      revision: 1,
      sharedTabs: [],
      preferences: {
        appearance: {
          themeMode: "system",
          lightTheme: "default",
          darkTheme: "default",
          typography: "default",
        },
        desktop: {
          sidebarVisible: true,
          statusBarVisible: true,
          chatWidth: "comfortable",
          sidebarSort: "updated",
          sectionOrder: [],
          sectionCollapsed: {},
          showCompleted: false,
          spellCheck: true,
        },
        welcome: {
          engine: "direct",
          quickActionTab: "coding",
          scopeMode: "simple",
          folderId: null,
        },
        navigation: { selectedFolderId: null, folderExpanded: {} },
      },
    },
    hydration: "ready",
    hydrationError: null,
    closeSharedTab: async (conversationId: string) => {
      const snap = usePreferencesStore.getState().snapshot!;
      const next = {
        ...snap,
        revision: snap.revision + 1,
        sharedTabs: snap.sharedTabs.filter((t) => t.ref !== conversationId),
      };
      usePreferencesStore.setState({ snapshot: next });
      return next;
    },
  } as any);
}

function setSharedTabs(tabs: Array<{ kind: "chat" | "agent"; ref: string }>) {
  prefs().applySnapshot({
    ...prefs().snapshot!,
    revision: (prefs().snapshot?.revision ?? 0) + 1,
    sharedTabs: tabs,
  });
}

function serveById(responder: (id: string) => Response): void {
  globalThis.fetch = (async (url: unknown) => {
    const s = String(url);
    const m = s.match(/\/api\/conversations\/([^/?#]+)$/);
    if (m) return responder(decodeURIComponent(m[1]!));
    // preferences close (deletion cleanup) - accept silently
    if (s.includes("/api/preferences/tabs/close")) {
      return { ok: true, status: 200, json: async () => prefs().snapshot } as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;
}

function okRow(id: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      id,
      title: id,
      status: "active",
      engine: "direct",
      workspaceMode: "simple",
    }),
  } as Response;
}

function gone(): Response {
  return { ok: false, status: 404, json: async () => ({ error: "not found" }) } as Response;
}

function unknown(): Response {
  return { ok: false, status: 503, json: async () => ({ error: "unavailable" }) } as Response;
}

beforeEach(() => {
  reset();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(() => {
  setClientTransportEnabled(true);
  setLogLevel("debug");
});

describe("reconcileTabMirror — what a pass may remove", () => {
  it("removes nothing when every conversation exists", async () => {
    setSharedTabs([
      { kind: "chat", ref: "a" },
      { kind: "chat", ref: "b" },
    ]);
    serveById(() => okRow("x"));
    await reconcileTabMirror();
    expect(refs().sort()).toEqual(["a", "b"]);
  });

  it("removes ONLY the conversations the server reports gone", async () => {
    setSharedTabs([
      { kind: "chat", ref: "keep" },
      { kind: "chat", ref: "doomed" },
    ]);
    serveById((id) => (id === "doomed" ? gone() : okRow(id)));
    await reconcileTabMirror();
    expect(refs()).toEqual(["keep"]);
  });

  it("issues NO request for an empty shared tab set", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return okRow("x");
    }) as unknown as typeof fetch;
    await reconcileTabMirror();
    expect(calls).toBe(0);
  });

  it("never reconciles the draft (no server row)", async () => {
    store().openNewDraft();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return okRow("x");
    }) as unknown as typeof fetch;
    await reconcileTabMirror();
    expect(calls).toBe(0);
    expect(store().hasLocalDraft).toBe(true);
  });
});

describe("reconcileTabMirror — unknown never erases", () => {
  it("removes nothing when the backend is unhealthy (5xx)", async () => {
    setSharedTabs([
      { kind: "chat", ref: "a" },
      { kind: "chat", ref: "b" },
    ]);
    serveById(() => unknown());
    await reconcileTabMirror();
    expect(refs().sort()).toEqual(["a", "b"]);
  });

  it("removes nothing on a network failure", async () => {
    setSharedTabs([{ kind: "chat", ref: "a" }]);
    serveById(() => {
      throw new TypeError("fetch failed");
    });
    await reconcileTabMirror();
    expect(refs()).toEqual(["a"]);
  });

  it("removes nothing on timeout/abort (unknown, preserve state)", async () => {
    setSharedTabs([{ kind: "chat", ref: "a" }]);
    serveById(() => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    });
    await reconcileTabMirror();
    expect(refs()).toEqual(["a"]);
  });
});

describe("evictIfGone — the single eviction rule", () => {
  it("evicts on gone", () => {
    store().presentChat("doomed");
    store().markDetached("doomed");
    evictIfGone("doomed", "gone");
    expect(visibleTabs(store()).some((t) => t.ref === "doomed")).toBe(false);
  });

  it("retains on exists", () => {
    store().presentChat("alive");
    evictIfGone("alive", "exists");
    expect(store().localActiveKey).toBe(chatKey("alive"));
  });

  it("retains on unknown", () => {
    store().presentChat("alive");
    evictIfGone("alive", "unknown");
    expect(store().localActiveKey).toBe(chatKey("alive"));
  });

  it("is harmless for a conversation with no open tab", () => {
    store().presentChat("alive");
    evictIfGone("never-opened", "gone");
    expect(store().localActiveKey).toBe(chatKey("alive"));
  });
});

describe("isConfirmedGone", () => {
  it("recognizes the contract's not-found error", () => {
    expect(isConfirmedGone(new ConversationNotFoundError("c1"))).toBe(true);
  });

  it("recognizes the gone verdict", () => {
    expect(isConfirmedGone("gone")).toBe(true);
  });

  it("rejects every other failure shape", () => {
    expect(isConfirmedGone(new Error("Thread status unknown: c1"))).toBe(false);
    expect(isConfirmedGone(new TypeError("fetch failed"))).toBe(false);
    expect(isConfirmedGone("unknown")).toBe(false);
    expect(isConfirmedGone("exists")).toBe(false);
    expect(isConfirmedGone(undefined)).toBe(false);
    expect(isConfirmedGone(null)).toBe(false);
  });
});

describe("architectural guard", () => {
  it("routes confirmed-gone cleanup through local close and shared membership cleanup", async () => {
    const source = await Bun.file(
      path.join(REPO_ROOT, "web/src/features/chat/state/tabReconciliation.ts"),
    ).text();
    expect(source).toContain("closeLocal");
    expect(source).toContain("closeSharedTab");
  });
});
