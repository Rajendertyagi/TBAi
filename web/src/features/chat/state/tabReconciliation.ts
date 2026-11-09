/**
 * Confirmed-gone cleanup for conversation references.
 *
 * RECONCILIATION IS REMOVAL-ONLY. A reference is removed only when the server
 * confirms the conversation is gone (404). Unknown/transient failures never
 * destroy local state.
 */

import { logger } from "../../../lib/logger";
import { usePreferencesStore } from "../../preferences/state/preferencesStore";
import { agentKey, chatKey, type Tab, useChatTabsStore, visibleTabs } from "./chatTabs";
import {
  ConversationNotFoundError,
  type ConversationExistence,
  probeConversation,
} from "./conversationExistence";

export type { ConversationExistence } from "./conversationExistence";

/** True for a confirmed-gone verdict or the adapter's confirmed-absence error. */
export function isConfirmedGone(value: unknown): boolean {
  if (value === "gone") return true;
  return value instanceof ConversationNotFoundError;
}

/**
 * Removes every local presentation of a confirmed-gone conversation and cleans
 * up shared membership as deletion cleanup. No-op for any status but `gone`.
 */
export function evictIfGone(conversationId: string, status: ConversationExistence): void {
  if (status !== "gone") return;
  const state = useChatTabsStore.getState();
  state.closeLocal(chatKey(conversationId));
  state.closeLocal(agentKey(conversationId));
  void usePreferencesStore
    .getState()
    .closeSharedTab(conversationId)
    .catch(() => {});
}

/**
 * Boot reconciliation: probes shared tabs and evicts confirmed-gone refs.
 * With server-authoritative shared membership this is a safety net; it never
 * adds tabs and never acts on unknown/transient failures.
 */
export async function reconcilePersistedTabs(): Promise<void> {
  const shared = usePreferencesStore.getState().snapshot?.sharedTabs ?? [];
  const refs = Array.from(new Set(shared.map((t) => t.ref)));
  if (refs.length === 0) return;

  const settled = await Promise.allSettled(
    refs.map(async (id) => ({ id, status: await probeConversation(id) })),
  );

  let removed = 0;
  for (const outcome of settled) {
    if (outcome.status !== "fulfilled") continue;
    const { id, status } = outcome.value;
    if (status.status === "gone") {
      evictIfGone(id, "gone");
      removed += 1;
    }
  }
  if (removed > 0) {
    logger.info("chat", "tab_reconcile_boot", { probed: refs.length, removed });
  }
}

/** @internal exported for tests */
export function _visibleTabsForTest(): Tab[] {
  return visibleTabs(useChatTabsStore.getState());
}

/** @deprecated compatibility alias */
export const reconcileTabMirror = reconcilePersistedTabs;

/** Registers boot reconciliation (idempotent-safe). */
export function registerTabReconciliation(): () => void {
  void reconcilePersistedTabs();
  return () => {};
}
