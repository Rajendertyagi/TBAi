import { create } from "zustand";

export const NEW_DRAFT_TAB_ID = "new";
const STORAGE_KEY = "tbai:openTabs";
const DEFAULT_GROUP_ID = "main";

/**
 * Unified tab model: chat threads AND settings pages live in one strip.
 * - Chat tab: `{ kind: "chat", ref: threadId | "new" }`, key `chat:<ref>`.
 * - Page tab: `{ kind: "page", ref: route }`, key `page:<route>`.
 * Message/streaming state is NOT here (assistant-ui runtime owns it);
 * this is open-tab layout only. `groupId` is split-screen future-proofing.
 */
export interface Tab {
  key: string;
  kind: "chat" | "page";
  /** threadId (or "new" draft) for chat tabs; route for page tabs. */
  ref: string;
}

export interface ChatTabsState {
  tabs: Tab[];
  activeKey: string | undefined;
  groupId: string;
  openChat: (threadId: string) => void;
  openPage: (route: string) => void;
  close: (key: string) => void;
  setActive: (key: string) => void;
  /** Reorder an open tab (drag-and-drop in the desktop tab strip). */
  reorder: (from: number, to: number) => void;
  /** Replace a draft/old thread id with the real one (first send, reload). */
  attachRealId: (oldId: string, realId: string) => void;
}

interface PersistedTabs {
  tabs: Tab[];
  activeKey: string | undefined;
}

function isTab(value: unknown): value is Tab {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.key === "string" &&
    (t.kind === "chat" || t.kind === "page") &&
    typeof t.ref === "string"
  );
}

function loadPersisted(): PersistedTabs {
  const loaded = loadRaw();
  // Tabs are conversations only (codeg parity): drop any page tabs persisted
  // by the interim unified-tab build; chat tabs carry over untouched.
  const tabs = loaded.tabs.filter((t) => t.kind === "chat");
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
      const tabs = unifiedShape.filter(isTab);
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
  return { key, kind: "chat", ref: key.slice(5) };
}

export const chatKey = (threadId: string): string => `chat:${threadId}`;
export const pageKey = (route: string): string => `page:${route}`;

/** URL a tab points at: chat tabs → thread route, page tabs → their route. */
export function urlForTab(tab: Tab): string {
  return tab.kind === "chat" ? `/chat/${tab.ref}` : tab.ref;
}

export const useChatTabsStore = create<ChatTabsState>((set) => ({
  tabs: initial.tabs,
  activeKey: initial.activeKey,
  groupId: DEFAULT_GROUP_ID,
  openChat: (threadId) =>
    set((state) => withActive(state.tabs, chatKey(threadId))),
  openPage: (route) =>
    set((state) => withActive(state.tabs, pageKey(route))),
  close: (key) =>
    set((state) => {
      const remaining = state.tabs.filter((t) => t.key !== key);
      // Never sit at zero tabs: closing the last one opens a fresh draft
      // (codeg parity — the workbench always has a conversation to type in).
      const tabs =
        remaining.length === 0
          ? [{ key: chatKey(NEW_DRAFT_TAB_ID), kind: "chat", ref: NEW_DRAFT_TAB_ID } as Tab]
          : remaining;
      const activeKey =
        state.activeKey === key ? tabs[tabs.length - 1]?.key : state.activeKey;
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
  attachRealId: (oldId, realId) =>
    set((state) => {
      if (oldId === realId) return state;
      const oldKey = chatKey(oldId);
      const newKey = chatKey(realId);
      // If the real thread is already open, just drop the draft.
      const tabs = state.tabs
        .map((t) => (t.key === oldKey ? { ...t, key: newKey, ref: realId } : t))
        .filter(
          (t, index, arr) => arr.findIndex((x) => x.key === t.key) === index,
        );
      const activeKey = state.activeKey === oldKey ? newKey : state.activeKey;
      persist(tabs, activeKey);
      return { tabs, activeKey };
    }),
}));

/** Active tab object (not just the key) for views that need kind/ref. */
export function activeTab(state: ChatTabsState): Tab | undefined {
  return state.tabs.find((t) => t.key === state.activeKey);
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
