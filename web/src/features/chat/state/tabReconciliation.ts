/**
 * Boot reconciliation for the persisted tab mirror.
 *
 * `tbai:openTabs` (owned by `chatTabs.ts`) is a set of live references into
 * SQLite. It converges on write from exactly one producer — the in-app delete
 * flow — but `DELETE /api/conversations/:id` is a public REST contract also
 * called by the e2e suite's cleanup, the scheduler, and any other client. So a
 * conversation can be deleted with no TBAi UI involved, leaving a reference that
 * nothing will ever remove. Before this pass those references survived every
 * reload, each re-probing the server once per mount and failing forever.
 *
 * This module is the read-side half of convergence: at boot the client owns the
 * COMPLETE reference set, which is the one moment a single batch request can
 * cover the whole mirror. Steady-state deletion (while the app is open) is
 * covered separately by the per-tab probe in `TabStrip`, which costs no extra
 * request because it already fires.
 *
 * Design constraint that makes this safe rather than merely clever:
 *
 *   RECONCILIATION IS REMOVAL-ONLY. `exists` HAS NO WRITE PATH AT ALL.
 *
 * A stale or late `exists` therefore cannot resurrect a tab, because nothing in
 * this pass ever adds one, and `unknown` cannot erase anything because it has
 * no write path either. Both properties are structural, not lock-protected:
 *
 *   - boot says exists → row deleted → probe says gone: `exists` writes
 *     nothing, `gone` removes. Order is irrelevant.
 *   - probe says gone while another surface closes the same ref: `closeByRef`
 *     on an absent ref is a proven no-op.
 *   - server down at boot → recovery re-runs the pass, which was a no-op.
 *   - two concurrent passes: singleflighted below, and idempotent regardless.
 *
 * Retry-on-recovery is NOT implemented here. This registers a one-shot boot
 * pass; the retry is a step in the existing coordinated recovery sequence
 * (`features/availability/recovery.ts`), so this change adds no poller and no
 * second synchronization system.
 */

import { logger } from "../../../lib/logger";
import {
  ConversationNotFoundError,
  reconcileConversations,
  type ConversationExistence,
} from "./conversationExistence";
import { NEW_DRAFT_TAB_ID, useChatTabsStore } from "./chatTabs";

/** Single in-flight pass: concurrent callers await one request, not two. */
let inFlight: Promise<void> | null = null;

/**
 * Conversation ids the mirror currently references, deduplicated and with the
 * draft excluded.
 *
 * The draft is UI-only (it becomes a row at first send), so it has no server row
 * by construction and would always read as `gone` — reconciling it would evict
 * the empty conversation the user is about to type into.
 */
function referencedConversationIds(): string[] {
  const tabs = useChatTabsStore.getState().tabs;
  const ids = new Set<string>();
  for (const tab of tabs) {
    if (tab.ref === NEW_DRAFT_TAB_ID) continue;
    ids.add(tab.ref);
  }
  return Array.from(ids);
}

/**
 * Evict a conversation's tabs when — and only when — a probe confirmed the row
 * is gone.
 *
 * The single eviction path for the steady-state backstop. A network failure, a
 * 5xx, or an unreadable body arrives as `unknown` and retains the tab, which is
 * the whole point: only confirmed absence may destroy state.
 *
 * Idempotent and safe to call repeatedly for the same ref.
 *
 * @param conversationId - The conversation whose tabs may be closed.
 * @param status - Verdict from the shared existence contract.
 */
export function evictIfGone(
  conversationId: string,
  status: ConversationExistence,
): void {
  if (status !== "gone") return;
  const store = useChatTabsStore.getState();
  if (!store.tabs.some((tab) => tab.ref === conversationId)) return;
  store.closeByRef(conversationId);
  logger.info("chat", "tab.evicted", {
    conversationId,
    reason: "not_found",
  });
}

/**
 * True when a thrown error is the adapter's confirmed-absence signal. Lets a
 * caller keep assistant-ui's throwing `fetch` contract while routing the
 * destructive decision through the same rule as the batch pass.
 */
export function isConfirmedGone(err: unknown): boolean {
  return err instanceof ConversationNotFoundError;
}

/**
 * Reconcile the persisted tab mirror against authoritative SQLite state.
 *
 * Removes only refs the server reports as `gone`. Retains everything on
 * `unknown`, on a failed request, and on an empty mirror (which issues no
 * request at all). Idempotent: a second run with no intervening change evicts
 * nothing and logs nothing.
 *
 * @returns Resolves when the pass settles; never rejects.
 */
export async function reconcileTabMirror(): Promise<void> {
  if (inFlight) return inFlight;
  const run = (async () => {
    const ids = referencedConversationIds();
    if (ids.length === 0) return;

    const verdicts = await reconcileConversations(ids);
    let evicted = 0;
    for (const [id, status] of verdicts) {
      if (status !== "gone") continue;
      evictIfGone(id, status);
      evicted += 1;
    }
    // One line per completed pass, not per id: a normal boot evicts nothing and
    // must stay quiet in the log stream.
    if (evicted > 0) {
      logger.info("chat", "tab.reconciled", {
        checked: ids.length,
        evicted,
      });
    }
  })();
  inFlight = run;
  try {
    await run;
  } finally {
    if (inFlight === run) inFlight = null;
  }
}

/**
 * Run the boot reconciliation pass once.
 *
 * Idempotent singleton, registered from the shell next to the availability
 * poller, so a StrictMode double-mount cannot double-reconcile. Kept separate
 * from `reconcileTabMirror` because the recovery sequence calls the pass
 * directly on every offline→online transition and must not re-register a
 * listener each time.
 */
export function registerTabReconciliation(): () => void {
  void reconcileTabMirror();
  return () => {};
}
