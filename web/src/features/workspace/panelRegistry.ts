/**
 * Duplicate-mount guard and canonical reconciliation for workspace panels.
 *
 * Dockview guarantees unique PANEL IDS, but two panels with different ids could
 * still carry the same canonical tab key and therefore mount two live runtimes
 * for one conversation. The registry claims by tab key (conversation identity),
 * so a second host for the same conversation is refused. The pure helpers below
 * compute the desired panel set from canonical chatTabs and the add/remove diff
 * used by the controller's idempotent reconciliation.
 */
import { parseTabKey } from "../chat/state/chatTabs";

export interface PanelRegistry {
  /** Claim a tab key. Returns false when another live panel already owns it. */
  claim(tabKey: string): boolean;
  /** Release a claim (on unmount). Idempotent. */
  release(tabKey: string): void;
  /** Whether a live panel currently owns this tab key. */
  has(tabKey: string): boolean;
  /** Currently claimed tab keys (snapshot). */
  readonly claimed: readonly string[];
}

/** Create an isolated claim registry (one per Dockview instance in tests). */
export function createPanelRegistry(): PanelRegistry {
  const owned = new Set<string>();
  return {
    claim: (tabKey) => {
      if (owned.has(tabKey)) return false;
      owned.add(tabKey);
      return true;
    },
    release: (tabKey) => {
      owned.delete(tabKey);
    },
    has: (tabKey) => owned.has(tabKey),
    get claimed() {
      return [...owned];
    },
  };
}

/** Process-wide registry used by the production panel components. */
export const panelRegistry = createPanelRegistry();

/**
 * Filter canonical tab keys to those that can host a panel. Drops malformed
 * keys and empty refs; the caller decides whether to exclude drafts.
 */
export function desiredPanelKeys(tabKeys: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const key of tabKeys) {
    const parsed = parseTabKey(key);
    if (!parsed || parsed.ref.length === 0 || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return result;
}

/** The add/remove diff between currently mounted ids and the desired set. */
export function diffPanelKeys(
  current: readonly string[],
  desired: readonly string[],
): { toAdd: string[]; toRemove: string[] } {
  const currentSet = new Set(current);
  const desiredSet = new Set(desired);
  return {
    toAdd: desired.filter((key) => !currentSet.has(key)),
    toRemove: current.filter((key) => !desiredSet.has(key)),
  };
}
