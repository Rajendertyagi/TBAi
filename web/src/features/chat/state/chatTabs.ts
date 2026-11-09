import { create } from "zustand";
import { logger } from "../../../lib/logger";
import { ROUTES } from "../../../config/routes";
import { usePreferencesStore } from "../../preferences/state/preferencesStore";
import { PreferencesConflictError } from "../../preferences/api/preferences";
import type { SharedTabRef } from "../../preferences/state/types";

export const NEW_DRAFT_TAB_ID = "new";
const DEFAULT_GROUP_ID = "main";

/**
 * Unified tab model: chat threads and Code conversations live in one strip.
 * - Chat tab: `{ kind: "chat", ref: threadId | "new" }`, key `chat:<ref>`.
 * - Agent tab (OpenCode Code mode): `{ kind: "agent", ref: conversationId }`, key `agent:<ref>`.
 *
 * Shared workspace state (SQLite authoritative): ordered real-conversation
 * membership only (`sharedTabs` in preferences snapshot). No global active
 * pointer. Each window owns local active selection/route and local draft state.
 */
export interface Tab {
  key: string;
  kind: "chat" | "agent";
  /** threadId (or "new" draft) for chat tabs; conversationId for agent tabs. */
  ref: string;
  /** Local presentation of a real conversation not in shared membership. */
  detached?: boolean;
}

export interface MembershipFailure {
  message: string;
  at: number;
}

export interface ChatTabsState {
  /** Per-window local active tab key (URL-authoritative via TabUrlSync). */
  localActiveKey: string | undefined;
  /** Local draft tab is per-window and never shared. */
  hasLocalDraft: boolean;
  /** Real conversations presented locally but not in shared membership. */
  detachedRefs: Record<string, true>;
  /** Transient per-window shared-membership failures (survives navigation). */
  membershipFailures: Record<string, MembershipFailure>;
  /** Explicit closes suppress delayed/non-awaited shared adds (race protection). */
  suppressedDelayedAdds: Record<string, number>;
  groupId: string;

  /** Presentation-only: select/open locally. Never mutates shared membership. */
  presentChat: (threadId: string) => void;
  /** Presentation-only: select/open locally. Never mutates shared membership. */
  presentAgent: (conversationId: string) => void;
  /** Local selection only. */
  selectLocal: (key: string) => void;
  /** Local draft open/select. */
  openNewDraft: () => void;
  /** Local draft resolution after materialization. No shared mutation. */
  resolveDraftId: (id: string, engine?: "direct" | "opencode") => void;
  /** Explicit user close: shared membership removal (CAS) + local behavior. */
  requestSharedClose: (conversationId: string) => Promise<void>;
  /** Explicit user batch close: atomic shared mutation + local behavior. */
  requestSharedCloseBatch: (input: {
    mode: "others" | "right" | "all";
    anchorConversationId?: string;
  }) => Promise<void>;
  /** Explicit user reorder: shared mutation (CAS). */
  requestSharedReorder: (conversationId: string, toIndex: number) => Promise<void>;
  /** Explicit user open/add: shared mutation (CAS), then local selection. */
  requestSharedOpen: (conversationId: string, kind: "chat" | "agent") => Promise<void>;
  /**
   * Delayed/non-awaited shared add after materialization. Failure-isolated,
   * never recreates/resends. Stale 409 must NOT auto-retry with fresh revision.
   * Suppressed if user explicitly closed before commit.
   */
  requestDelayedSharedOpen: (conversationId: string, kind: "chat" | "agent") => void;
  /** Explicit retry of shared membership only (never materialize/resend). */
  retrySharedOpen: (conversationId: string, kind: "chat" | "agent") => Promise<void>;
  /** Clear a transient membership failure after success or explicit dismiss. */
  clearMembershipFailure: (conversationId: string) => void;
  /** Mark a conversation detached locally (remote close / not in shared membership). */
  markDetached: (conversationId: string) => void;
  /** Remove local detached marker (e.g. after explicit shared open). */
  clearDetached: (conversationId: string) => void;
  /** Local-only close for draft or detached presentation cleanup. */
  closeLocal: (key: string) => void;

  /** Backward-compatible aliases (presentation-only). */
  openChat: (threadId: string) => void;
  openAgent: (conversationId: string) => void;
  /** Backward-compatible: explicit close by key (draft local, real => shared close). */
  close: (key: string) => void;
}

export function chatKey(ref: string): string {
  return `chat:${ref}`;
}

export function agentKey(ref: string): string {
  return `agent:${ref}`;
}

export function tabKey(kind: "chat" | "agent", ref: string): string {
  return kind === "agent" ? agentKey(ref) : chatKey(ref);
}

export function parseTabKey(key: string): { kind: "chat" | "agent"; ref: string } | null {
  if (key.startsWith("chat:")) return { kind: "chat", ref: key.slice(5) };
  if (key.startsWith("agent:")) return { kind: "agent", ref: key.slice(6) };
  return null;
}

export function sharedTabsToTabs(sharedTabs: SharedTabRef[]): Tab[] {
  return sharedTabs.map((t) => ({
    key: tabKey(t.kind, t.ref),
    kind: t.kind,
    ref: t.ref,
  }));
}

/** Visible tabs for this window: shared tabs + local draft + detached active tab if needed. */
export function visibleTabs(
  state: Pick<ChatTabsState, "localActiveKey" | "hasLocalDraft" | "detachedRefs"> & {
    sharedTabs?: SharedTabRef[];
  },
): Tab[] {
  const shared = sharedTabsToTabs(
    state.sharedTabs ?? usePreferencesStore.getState().snapshot?.sharedTabs ?? [],
  );
  const tabs: Tab[] = [];
  if (state.hasLocalDraft) {
    tabs.push({ key: chatKey(NEW_DRAFT_TAB_ID), kind: "chat", ref: NEW_DRAFT_TAB_ID });
  }
  tabs.push(...shared);
  const active = state.localActiveKey;
  if (active) {
    const parsed = parseTabKey(active);
    if (parsed && parsed.ref !== NEW_DRAFT_TAB_ID && !tabs.some((t) => t.key === active)) {
      tabs.push({ key: active, kind: parsed.kind, ref: parsed.ref, detached: true });
    }
  }
  return tabs;
}

export function activeTab(state: ChatTabsState): Tab | undefined {
  const tabs = visibleTabs(state);
  if (!state.localActiveKey) return tabs[0];
  return tabs.find((t) => t.key === state.localActiveKey) ?? tabs[0];
}

export function urlForTab(tab: Tab): string {
  if (tab.kind === "agent") return ROUTES.code(tab.ref);
  return ROUTES.chat(tab.ref);
}

export function threadUrl(remoteId: string, engine?: string | null): string {
  return engine === "opencode" ? ROUTES.code(remoteId) : ROUTES.chat(remoteId);
}

export function shouldNavigateToThread(
  pathname: string,
  remoteId: string,
  engine?: string | null,
): boolean {
  return pathname !== threadUrl(remoteId, engine);
}

export function routeStillReferencesRef(pathname: string, ref: string): boolean {
  if (!ref || ref === NEW_DRAFT_TAB_ID) return pathname === ROUTES.CHAT_NEW;
  return pathname === ROUTES.chat(ref) || pathname === ROUTES.code(ref);
}

function isSuppressed(state: ChatTabsState, conversationId: string): boolean {
  return Boolean(state.suppressedDelayedAdds[conversationId]);
}

export const useChatTabsStore = create<ChatTabsState>((set, get) => ({
  localActiveKey: undefined,
  hasLocalDraft: false,
  detachedRefs: {},
  membershipFailures: {},
  suppressedDelayedAdds: {},
  groupId: DEFAULT_GROUP_ID,

  presentChat: (threadId) => {
    const key = chatKey(threadId);
    set(() => {
      const next: Partial<ChatTabsState> = { localActiveKey: key };
      if (threadId === NEW_DRAFT_TAB_ID) next.hasLocalDraft = true;
      return next;
    });
  },

  presentAgent: (conversationId) => {
    set({ localActiveKey: agentKey(conversationId) });
  },

  selectLocal: (key) => set({ localActiveKey: key }),

  openNewDraft: () => set({ hasLocalDraft: true, localActiveKey: chatKey(NEW_DRAFT_TAB_ID) }),

  resolveDraftId: (id, engine) => {
    const key = engine === "opencode" ? agentKey(id) : chatKey(id);
    set((s) => ({
      hasLocalDraft: false,
      localActiveKey: s.localActiveKey === chatKey(NEW_DRAFT_TAB_ID) ? key : s.localActiveKey,
    }));
  },

  requestSharedClose: async (conversationId) => {
    set((s) => ({
      suppressedDelayedAdds: { ...s.suppressedDelayedAdds, [conversationId]: Date.now() },
    }));
    const keyChat = chatKey(conversationId);
    const keyAgent = agentKey(conversationId);
    const wasActive = get().localActiveKey === keyChat || get().localActiveKey === keyAgent;
    const sharedBefore = usePreferencesStore.getState().snapshot?.sharedTabs ?? [];
    const closedIndex = sharedBefore.findIndex((t) => t.ref === conversationId);
    try {
      await usePreferencesStore.getState().closeSharedTab(conversationId);
    } catch (err) {
      logger.debug("chat", "shared_tab_close_failed", {
        conversationId,
        errorType: err instanceof Error ? err.name : typeof err,
      });
      return;
    }
    if (wasActive) {
      // Local close behavior: select right neighbor (or last), else fresh local draft.
      const shared = usePreferencesStore.getState().snapshot?.sharedTabs ?? [];
      const remaining = shared.filter((t) => t.ref !== conversationId);
      if (remaining.length > 0) {
        const nextIndex = Math.min(Math.max(closedIndex, 0), remaining.length - 1);
        const next = remaining[nextIndex] ?? remaining[remaining.length - 1]!;
        set({ localActiveKey: tabKey(next.kind, next.ref) });
      } else {
        set({ hasLocalDraft: true, localActiveKey: chatKey(NEW_DRAFT_TAB_ID) });
      }
    }
  },

  requestSharedCloseBatch: async (input) => {
    try {
      await usePreferencesStore.getState().closeSharedTabsBatch(input);
    } catch (err) {
      logger.debug("chat", "shared_tab_close_batch_failed", {
        mode: input.mode,
        errorType: err instanceof Error ? err.name : typeof err,
      });
      return;
    }
    const shared = usePreferencesStore.getState().snapshot?.sharedTabs ?? [];
    const active = get().localActiveKey;
    const parsed = active ? parseTabKey(active) : null;
    const activeRef = parsed?.ref;
    const stillMember = activeRef ? shared.some((t) => t.ref === activeRef) : false;
    if (activeRef && activeRef !== NEW_DRAFT_TAB_ID && !stillMember) {
      // If this window was viewing an affected conversation, it becomes detached (preserve route/view).
      if (
        input.mode === "all" ||
        (input.anchorConversationId && input.anchorConversationId !== activeRef)
      ) {
        set((s) => ({ detachedRefs: { ...s.detachedRefs, [activeRef]: true } }));
      } else if (input.anchorConversationId === activeRef && input.mode === "others") {
        // kept
      } else if (shared[0]) {
        set({ localActiveKey: tabKey(shared[0].kind, shared[0].ref) });
      } else {
        set({ hasLocalDraft: true, localActiveKey: chatKey(NEW_DRAFT_TAB_ID) });
      }
    }
  },

  requestSharedReorder: async (conversationId, toIndex) => {
    try {
      await usePreferencesStore.getState().reorderSharedTab(conversationId, toIndex);
    } catch (err) {
      logger.debug("chat", "shared_tab_reorder_failed", {
        conversationId,
        errorType: err instanceof Error ? err.name : typeof err,
      });
    }
  },

  requestSharedOpen: async (conversationId, kind) => {
    set((s) => {
      const next = { ...s.suppressedDelayedAdds };
      delete next[conversationId];
      return { suppressedDelayedAdds: next };
    });
    try {
      await usePreferencesStore.getState().openSharedTab(conversationId, kind);
    } catch (err) {
      if (err instanceof PreferencesConflictError) {
        // Stale 409: authoritative snapshot applied by store; no auto-retry.
        // Select locally; conversation remains accessible (may be detached).
        set({ localActiveKey: tabKey(kind, conversationId) });
        return;
      }
      set({ localActiveKey: tabKey(kind, conversationId) });
      set((s) => ({
        membershipFailures: {
          ...s.membershipFailures,
          [conversationId]: {
            message: err instanceof Error ? err.message : "Failed to add to shared workspace",
            at: Date.now(),
          },
        },
      }));
      return;
    }
    set((s) => {
      const next = { ...s.detachedRefs };
      delete next[conversationId];
      const failures = { ...s.membershipFailures };
      delete failures[conversationId];
      return {
        detachedRefs: next,
        localActiveKey: tabKey(kind, conversationId),
        membershipFailures: failures,
      };
    });
  },

  requestDelayedSharedOpen: (conversationId, kind) => {
    void (async () => {
      if (isSuppressed(get(), conversationId)) return;
      try {
        await usePreferencesStore.getState().openSharedTab(conversationId, kind);
        if (isSuppressed(get(), conversationId)) {
          // User explicitly closed before/around commit; preserve close.
          try {
            await usePreferencesStore.getState().closeSharedTab(conversationId);
          } catch {
            await usePreferencesStore.getState().refresh();
          }
          return;
        }
        set((s) => {
          const failures = { ...s.membershipFailures };
          delete failures[conversationId];
          const detached = { ...s.detachedRefs };
          delete detached[conversationId];
          return { membershipFailures: failures, detachedRefs: detached };
        });
      } catch (err) {
        if (err instanceof PreferencesConflictError) {
          // Stale 409 from delayed add: MUST NOT auto-retry with fresh revision.
          // Refresh authoritative state, preserve close, require explicit action.
          await usePreferencesStore.getState().refresh();
          if (isSuppressed(get(), conversationId)) return;
          set((s) => ({
            membershipFailures: {
              ...s.membershipFailures,
              [conversationId]: {
                message:
                  "Workspace changed. Retry adding to shared workspace if you still want it open.",
                at: Date.now(),
              },
            },
          }));
          return;
        }
        if (isSuppressed(get(), conversationId)) return;
        set((s) => ({
          membershipFailures: {
            ...s.membershipFailures,
            [conversationId]: {
              message: err instanceof Error ? err.message : "Failed to add to shared workspace",
              at: Date.now(),
            },
          },
        }));
      }
    })();
  },

  retrySharedOpen: async (conversationId, kind) => {
    set((s) => {
      const next = { ...s.suppressedDelayedAdds };
      delete next[conversationId];
      return { suppressedDelayedAdds: next };
    });
    try {
      await usePreferencesStore.getState().openSharedTab(conversationId, kind);
      set((s) => {
        const failures = { ...s.membershipFailures };
        delete failures[conversationId];
        const detached = { ...s.detachedRefs };
        delete detached[conversationId];
        return {
          membershipFailures: failures,
          detachedRefs: detached,
          localActiveKey: tabKey(kind, conversationId),
        };
      });
    } catch (err) {
      if (err instanceof PreferencesConflictError) {
        await usePreferencesStore.getState().refresh();
      }
      set((s) => ({
        membershipFailures: {
          ...s.membershipFailures,
          [conversationId]: {
            message: err instanceof Error ? err.message : "Failed to add to shared workspace",
            at: Date.now(),
          },
        },
      }));
    }
  },

  clearMembershipFailure: (conversationId) =>
    set((s) => {
      const failures = { ...s.membershipFailures };
      delete failures[conversationId];
      return { membershipFailures: failures };
    }),

  markDetached: (conversationId) =>
    set((s) => ({ detachedRefs: { ...s.detachedRefs, [conversationId]: true } })),

  clearDetached: (conversationId) =>
    set((s) => {
      const detached = { ...s.detachedRefs };
      delete detached[conversationId];
      return { detachedRefs: detached };
    }),

  closeLocal: (key) => {
    const parsed = parseTabKey(key);
    set((s) => {
      const next: Partial<ChatTabsState> = {};
      if (key === chatKey(NEW_DRAFT_TAB_ID)) next.hasLocalDraft = false;
      if (parsed && parsed.ref !== NEW_DRAFT_TAB_ID) {
        const detached = { ...s.detachedRefs };
        delete detached[parsed.ref];
        next.detachedRefs = detached;
      }
      if (s.localActiveKey === key) {
        const shared = usePreferencesStore.getState().snapshot?.sharedTabs ?? [];
        if (shared[0]) next.localActiveKey = tabKey(shared[0].kind, shared[0].ref);
        else next.localActiveKey = undefined;
      }
      return next;
    });
  },

  openChat: (threadId) => get().presentChat(threadId),
  openAgent: (conversationId) => get().presentAgent(conversationId),
  close: (key) => {
    if (key === chatKey(NEW_DRAFT_TAB_ID)) {
      get().closeLocal(key);
      return;
    }
    const parsed = parseTabKey(key);
    if (!parsed) return;
    void get().requestSharedClose(parsed.ref);
  },
}));

/** Path→conversation id extraction (compatibility). */
export function conversationIdFromPath(pathname: string): string | null {
  return ROUTES.parseConversationId(pathname);
}
