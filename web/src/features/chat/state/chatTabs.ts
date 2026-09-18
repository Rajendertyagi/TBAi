import { create } from "zustand";

export const NEW_DRAFT_TAB_ID = "new";
const STORAGE_KEY = "tbai:openTabs";
const DEFAULT_GROUP_ID = "main";

/**
 * Unified tab model: chat threads AND settings pages live in one strip.
 * - Chat tab: `{ kind: "chat", ref: threadId | "new" }`, key `chat:<ref>`.
 * - Agent tab (OpenCode Code mode): `{ kind: "agent", ref: conversationId }`, key `agent:<ref>`.
 * - Page tab: `{ kind: "page", ref: route }`, key `page:<route>`.
 * Message/streaming state is NOT here (assistant-ui runtime owns it);
 * this is open-tab layout only. `groupId` is split-screen future-proofing.
 */
export interface Tab {
  key: string;
  kind: "chat" | "page" | "agent";
  /** threadId (or "new" draft) for chat tabs; conversationId for agent tabs; route for page tabs. */
  ref: string;
}

export interface ChatTabsState {
  tabs: Tab[];
  activeKey: string | undefined;
  groupId: string;
  openChat: (threadId: string) => void;
  openPage: (route: string) => void;
  openAgent: (conversationId: string) => void;
  close: (key: string) => void;
  /**
   * Close every tab bound to a conversation id (both chat and agent
   * surfaces). Tabs only — never deletes server data. Consumed by the
   * deletion flow after authoritative teardown; route correction follows via
   * TabUrlSync reacting to the active-key change.
   */
  closeByRef: (ref: string) => void;
  setActive: (key: string) => void;
  /** Reorder an open tab (drag-and-drop in the desktop tab strip). */
  reorder: (from: number, to: number) => void;
  /**
   * First-send id binding keyed by the row's engine — the single home for
   * draft→real resolution. Direct keeps a chat tab (key rewrite); OpenCode
   * swaps the draft chat tab for an agent tab (which drives TabUrlSync to
   * the Code surface).
   */
  resolveDraftId: (realId: string, engine: string | null) => void;
}

interface PersistedTabs {
  tabs: Tab[];
  activeKey: string | undefined;
}

/**
 * Validates a persisted tab AND repairs the poisoned shape older builds
 * wrote (agent:<id> keys stored as kind:"chat" with ref:":<id>"). Returns
 * null for unrepairable entries (empty ref, colon-prefixed ref that maps to
 * no known prefix) so they are dropped instead of 404-looping.
 *
 * Exported pure (no store access) so the repair contract is unit-testable.
 */
export function healTab(value: unknown): Tab | null {
  if (typeof value !== "object" || value === null) return null;
  const t = value as Record<string, unknown>;
  if (typeof t.key !== "string") return null;
  const key: string = t.key;
  // Rebuild from the key prefix — the key is the source of truth, never the
  // stored kind/ref (those are what got poisoned).
  if (key.startsWith("page:")) {
    const ref = key.slice(5);
    return ref.length > 0 ? { key, kind: "page", ref } : null;
  }
  if (key.startsWith("agent:")) {
    const ref = key.slice(6);
    return ref.length > 0 && !ref.startsWith(":") ? { key, kind: "agent", ref } : null;
  }
  if (key.startsWith("chat:")) {
    const ref = key.slice(5);
    return ref.length > 0 && !ref.startsWith(":") ? { key, kind: "chat", ref } : null;
  }
  return null;
}

function loadPersisted(): PersistedTabs {
  const loaded = loadRaw();
  // Tabs are conversations only (codeg parity): drop any page tabs persisted
  // by the interim unified-tab build; chat tabs carry over untouched.
  // Tabs are conversations + agent (Code mode) only; drop any page tabs
  // persisted by the interim unified-tab build. Chat and agent tabs carry over.
  const tabs = loaded.tabs.filter((t) => t.kind !== "page");
  const activeKey =
    tabs.some((t) => t.key === loaded.activeKey)
      ? loaded.activeKey
      : tabs[0]?.key;
  return { tabs, activeKey };
}

function loadRaw(): PersistedTabs {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { tabs: [], activeKey: undefined };
    const parsed = JSON.parse(raw) as unknown;
    // Migrate the pre-unified shape { openIds, activeId }.
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      Array.isArray((parsed as { openIds?: unknown }).openIds)
    ) {
      const openIds = (parsed as { openIds: unknown[] }).openIds.filter(
        (id): id is string => typeof id === "string",
      );
      const tabs = openIds.map(
        (id): Tab => ({ key: `chat:${id}`, kind: "chat", ref: id }),
      );
      const legacy = parsed as { activeId?: unknown };
      const activeKey =
        typeof legacy.activeId === "string"
          ? `chat:${legacy.activeId}`
          : tabs[0]?.key;
      return {
        tabs: activeKey && !tabs.some((t) => t.key === activeKey)
          ? [...tabs, { key: activeKey, kind: "chat", ref: activeKey.slice(5) }]
          : tabs,
        activeKey,
      };
    }
    const unifiedShape =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { tabs?: unknown }).tabs
        : undefined;
    if (Array.isArray(unifiedShape)) {
      const tabs = unifiedShape
        .map(healTab)
        .filter((t): t is Tab => t !== null);
      const legacy = parsed as { activeKey?: unknown };
      const activeKey =
        typeof legacy.activeKey === "string" &&
        tabs.some((t) => t.key === legacy.activeKey)
          ? legacy.activeKey
          : tabs[0]?.key;
      return { tabs, activeKey };
    }
    return { tabs: [], activeKey: undefined };
  } catch {
    return { tabs: [], activeKey: undefined };
  }
}

function persist(tabs: Tab[], activeKey: string | undefined): void {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ tabs, activeKey } satisfies PersistedTabs),
    );
  } catch {
    /* storage unavailable — session-only */
  }
}

const initial = loadPersisted();

function withActive(tabs: Tab[], activeKey: string): { tabs: Tab[]; activeKey: string } {
  const next = tabs.some((t) => t.key === activeKey)
    ? tabs
    : [...tabs, tabForKey(activeKey)];
  persist(next, activeKey);
  return { tabs: next, activeKey };
}

function tabForKey(key: string): Tab {
  if (key.startsWith("page:")) {
    return { key, kind: "page", ref: key.slice(5) };
  }
  if (key.startsWith("agent:")) {
    return { key, kind: "agent", ref: key.slice(6) };
  }
  if (key.startsWith("chat:")) {
    return { key, kind: "chat", ref: key.slice(5) };
  }
  // Unknown prefix: never silently mangle (a wrong kind/colon-prefixed ref
  // once caused 404 loops on /api/conversations/:<id>). Treat as a chat id
  // verbatim so the failure, if any, is visible and debuggable.
  return { key: chatKey(key), kind: "chat", ref: key };
}

export const chatKey = (threadId: string): string => `chat:${threadId}`;
export const pageKey = (route: string): string => `page:${route}`;
export const agentKey = (conversationId: string): string => `agent:${conversationId}`;

/**
 * Fresh draft tab. The workbench never sits at zero tabs (codeg parity), so
 * closers fall back to exactly one of these instead of inventing ad-hoc
 * replacements in multiple places.
 */
function freshDraftTab(): Tab {
  return { key: chatKey(NEW_DRAFT_TAB_ID), kind: "chat", ref: NEW_DRAFT_TAB_ID };
}

/** URL a tab points at: chat tabs → thread route, agent tabs → code route, page tabs → their route. */
export function urlForTab(tab: Tab): string {
  if (tab.kind === "agent") return `/code/${tab.ref}`;
  return tab.kind === "chat" ? `/chat/${tab.ref}` : tab.ref;
}

/**
 * Route for opening an existing conversation by engine. Pure — the single
 * home for thread-opening URL rules (sidebar, folders, scheduler all use
 * this; ChatView/OpenCodeView open the matching tab on mount). Unknown or
 * absent engine opens the Direct surface: legacy conversations predate the
 * engine column and are all Direct.
 */
export function threadUrl(remoteId: string, engine?: string | null): string {
  return engine === "opencode" ? `/code/${remoteId}` : `/chat/${remoteId}`;
}

/**
 * Conversation id from a route path, for either engine surface. Inverse of
 * `threadUrl` — the single home for path→id rules so scope UI (folder
 * highlight, breadcrumbs) works on `/code/` routes exactly as on `/chat/`.
 * Returns null for non-conversation paths (draft hosts neither axis).
 */
export function conversationIdFromPath(pathname: string): string | null {
  if (pathname.startsWith("/chat/") || pathname.startsWith("/code/")) {
    return pathname.slice(6) || null;
  }
  return null;
}

export const useChatTabsStore = create<ChatTabsState>((set) => ({
  tabs: initial.tabs,
  activeKey: initial.activeKey,
  groupId: DEFAULT_GROUP_ID,
  openChat: (threadId) =>
    set((state) => withActive(state.tabs, chatKey(threadId))),
  openAgent: (conversationId) =>
    set((state) => withActive(state.tabs, agentKey(conversationId))),
  openPage: (route) =>
    set((state) => withActive(state.tabs, pageKey(route))),
  close: (key) =>
    set((state) => {
      const remaining = state.tabs.filter((t) => t.key !== key);
      // Never sit at zero tabs: closing the last one opens a fresh draft
      // (codeg parity — the workbench always has a conversation to type in).
      const tabs = remaining.length === 0 ? [freshDraftTab()] : remaining;
      // Canonical close behavior: the right neighbor takes over (browser tab
      // convention), falling back to the fresh draft. Single rule, no ad-hoc
      // fallbacks scattered across closers.
      const activeKey =
        state.activeKey === key
          ? (nextActiveAfterClose(state.tabs, key) ?? tabs[0]?.key)
          : state.activeKey;
      persist(tabs, activeKey);
      return { tabs, activeKey };
    }),
  closeByRef: (ref) =>
    set((state) => {
      const remaining = state.tabs.filter((t) => t.ref !== ref);
      const tabs = remaining.length === 0 ? [freshDraftTab()] : remaining;
      const activeGone = !tabs.some((t) => t.key === state.activeKey);
      const activeKey = activeGone
        ? tabs[tabs.length - 1]?.key
        : state.activeKey;
      persist(tabs, activeKey);
      return { tabs, activeKey };
    }),
  setActive: (key) =>
    set((state) => withActive(state.tabs, key)),
  reorder: (from, to) =>
    set((state) => {
      if (
        from < 0 ||
        to < 0 ||
        from >= state.tabs.length ||
        to >= state.tabs.length ||
        from === to
      ) {
        return state;
      }
      const tabs = state.tabs.slice();
      const [moved] = tabs.splice(from, 1);
      tabs.splice(to, 0, moved);
      persist(tabs, state.activeKey);
      return { tabs };
    }),
  resolveDraftId: (realId, engine) =>
    set((state) => {
      const draftKey = chatKey(NEW_DRAFT_TAB_ID);
      if (engine === "opencode") {
        const nextKey = agentKey(realId);
        const tabs = state.tabs
          .filter((t) => t.key !== draftKey)
          .filter(
            (t, index, arr) => arr.findIndex((x) => x.key === t.key) === index,
          );
        const next = tabs.some((t) => t.key === nextKey)
          ? tabs
          : [...tabs, tabForKey(nextKey)];
        persist(next, nextKey);
        return { tabs: next, activeKey: nextKey };
      }
      const newKey = chatKey(realId);
      const tabs = state.tabs
        .map((t) =>
          t.key === draftKey ? { ...t, key: newKey, ref: realId } : t,
        )
        .filter(
          (t, index, arr) => arr.findIndex((x) => x.key === t.key) === index,
        );
      const nextActiveKey =
        state.activeKey === draftKey ? newKey : state.activeKey;
      persist(tabs, nextActiveKey);
      return { tabs, activeKey: nextActiveKey };
    }),
}));

/** Active tab object (not just the key) for views that need kind/ref. */
export function activeTab(state: ChatTabsState): Tab | undefined {
  return state.tabs.find((t) => t.key === state.activeKey);
}

// Canonical concurrent-tab rule: each browser tab owns its in-memory state;
// the persisted mirror is the convergence bus, never a second authority.
// Storage events fire only in tabs OTHER than the writer, so converging to
// the latest write cannot loop. A tab that deletes converges its peers to
// the deleted state (loadPersisted heals the same way boot does); truly
// simultaneous edits resolve last-writer-wins, identical to today.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY) return;
    const next = loadPersisted();
    const current = useChatTabsStore.getState();
    const same =
      current.activeKey === next.activeKey &&
      current.tabs.length === next.tabs.length &&
      current.tabs.every((t, i) => t.key === next.tabs[i]?.key);
    if (!same) useChatTabsStore.setState({ tabs: next.tabs, activeKey: next.activeKey });
  });
}

/** Key to activate after closing `closedKey` (right neighbor preferred). */
export function nextActiveAfterClose(
  tabs: Tab[],
  closedKey: string,
): string | undefined {
  const remaining = tabs.filter((t) => t.key !== closedKey);
  if (remaining.length === 0) return undefined;
  const closedIndex = tabs.findIndex((t) => t.key === closedKey);
  return remaining[Math.min(Math.max(closedIndex, 0), remaining.length - 1)]?.key;
}
