/**
 * Workspace activation contract — "has this panel's runtime been started".
 *
 * This is deliberately SEPARATE from the Direct history-recovery activation
 * (`activateHistoryConversation` in `useDirectHistoryWindow.ts`). That mechanism
 * signals a new history visit; this one owns the lifetime of a panel's started
 * runtime, keyed by canonical tab key (`chat:<ref>` / `agent:<ref>`).
 *
 * Lifecycle:
 *  - first activation marks the panel started and bumps its generation;
 *  - repeated activation of an already-started panel is a no-op;
 *  - hiding or moving a panel does NOT clear started state (hidden panels stay
 *    mounted via `renderer:"always"`, and a Dockview move does not unmount);
 *  - a genuine panel disposal clears started state, so reopening starts dormant
 *    until activated again. Re-activation then yields a NEW generation.
 *
 * Cleanup is tied to the panel component's unmount, NOT to `onPanelClose`:
 * `dockviewController.ts:296` deliberately skips that callback when a panel is
 * removed by canonical reconciliation (conversation closed elsewhere). The
 * unmount fires on every genuine removal regardless of the close-callback path.
 *
 * A materialized draft keeps the immutable Dockview id `chat:new` while its
 * canonical key becomes `chat:<id>`. `registerPanelCanonicalKey` records that
 * mapping when activation happens; `disposeWorkspacePanelById` resolves it at
 * unmount. The mapping is independent of the draft alias, so it survives the
 * `alias.clear()` that precedes a fresh-draft `replacePanel` — every genuine
 * removal of the draft panel clears the materialized conversation's state.
 *
 * The new-draft tab (`chat:new`) is never activatable — it is a transient host
 * whose runtime is materialized in place, not a conversation visit.
 */
import { useEffect, useSyncExternalStore } from "react";
import { NEW_DRAFT_TAB_ID, parseTabKey } from "../../chat/state/chatTabs";

/** Canonical tab keys whose runtime has been started. */
const startedPanels = new Set<string>();
/** Per-key activation generation; retained across dispose so re-activation bumps it. */
const activationGenerations = new Map<string, number>();
/**
 * Dockview panel id -> canonical key, for aliased panels only (a materialized
 * draft's id stays `chat:new` while its canonical key is `chat:<id>`). Written
 * on activation, consumed once on genuine disposal. Independent of the draft
 * alias so it survives `alias.clear()` before a fresh-draft replacement.
 */
const panelCanonicalKeys = new Map<string, string>();
const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of listeners) listener();
}

/** True for a canonical conversation key that may own a started runtime. */
function isActivatableKey(tabKey: string): boolean {
  const parsed = parseTabKey(tabKey);
  return parsed !== null && !(parsed.kind === "chat" && parsed.ref === NEW_DRAFT_TAB_ID);
}

/**
 * Mark a panel as started. Idempotent: activating an already-started panel does
 * nothing (no generation bump, no notification). Malformed keys and the draft
 * tab are ignored.
 */
export function activateWorkspacePanel(tabKey: string): void {
  if (!isActivatableKey(tabKey)) return;
  if (startedPanels.has(tabKey)) return;
  startedPanels.add(tabKey);
  activationGenerations.set(tabKey, (activationGenerations.get(tabKey) ?? 0) + 1);
  emitChange();
}

/** Whether this panel's runtime has been started. */
export function isWorkspacePanelStarted(tabKey: string): boolean {
  return startedPanels.has(tabKey);
}

/** Current activation generation for a panel (0 if never activated). */
export function getWorkspaceActivationGeneration(tabKey: string): number {
  return activationGenerations.get(tabKey) ?? 0;
}

/**
 * Clear a panel's started state on genuine disposal. Idempotent. The generation
 * is retained so a later re-activation produces a new one.
 */
export function disposeWorkspacePanel(tabKey: string): void {
  if (!startedPanels.delete(tabKey)) return;
  emitChange();
}

/**
 * Remember that Dockview panel `panelId` hosts canonical key `canonicalKey`.
 * Only aliased panels need a mapping (draft materialization); ordinary panels
 * have `panelId === canonicalKey` and the draft itself is never activatable.
 * Idempotent and safe to call from every activation path.
 */
export function registerPanelCanonicalKey(panelId: string, canonicalKey: string): void {
  if (panelId === canonicalKey) return;
  if (!isActivatableKey(canonicalKey)) return;
  panelCanonicalKeys.set(panelId, canonicalKey);
}

/**
 * Dispose the activation state for a genuinely removed Dockview panel.
 *
 * Resolves the canonical key through the alias mapping when present, so a
 * materialized draft clears its `chat:<id>` state even when the draft alias was
 * already cleared (fresh-draft `replacePanel`). Falls back to the raw id for
 * ordinary panels. The mapping is consumed once, on disposal.
 */
export function disposeWorkspacePanelById(panelId: string): void {
  const canonicalKey = panelCanonicalKeys.get(panelId) ?? panelId;
  panelCanonicalKeys.delete(panelId);
  disposeWorkspacePanel(canonicalKey);
}

/** Subscribe to activation changes (for `useSyncExternalStore`). */
export function subscribeWorkspaceActivation(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React hook: whether this panel's runtime has been started. */
export function useIsWorkspacePanelStarted(tabKey: string): boolean {
  return useSyncExternalStore(
    subscribeWorkspaceActivation,
    () => isWorkspacePanelStarted(tabKey),
    () => false,
  );
}

/** React hook: the current activation generation for a panel. */
export function useWorkspaceActivationGeneration(tabKey: string): number {
  return useSyncExternalStore(
    subscribeWorkspaceActivation,
    () => getWorkspaceActivationGeneration(tabKey),
    () => 0,
  );
}

/**
 * Dispose a panel's activation state when its component genuinely unmounts.
 *
 * Hidden panels stay mounted (`renderer:"always"`) and a Dockview move does not
 * unmount, so this cleanup fires only on real removal — including canonical
 * reconciliation removals that skip `onPanelClose`. Both runtime-bearing panel
 * components pass their immutable Dockview panel id; the resolver maps a
 * materialized draft's `chat:new` back to its canonical `chat:<id>`.
 */
export function useDisposeWorkspacePanelOnUnmount(panelId: string): void {
  useEffect(() => {
    return () => {
      disposeWorkspacePanelById(panelId);
    };
  }, [panelId]);
}

/** Reset all activation state (tests only). */
export function resetWorkspaceActivationForTests(): void {
  startedPanels.clear();
  activationGenerations.clear();
  panelCanonicalKeys.clear();
  emitChange();
}
