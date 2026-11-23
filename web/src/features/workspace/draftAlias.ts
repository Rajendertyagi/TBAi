/**
 * Draft-materialization alias for the persistent Dockview workspace.
 *
 * Dockview panel ids are immutable, but first send turns the canonical key of
 * the single draft from `chat:new` into `chat:<id>`. To keep the live runtime
 * mounted across that transition, the `chat:new` panel id is retained and the
 * materialized canonical key is aliased back to it. This module owns that
 * mapping as a small, testable state machine; `DockviewWorkspace` drives it
 * from React and uses it to canonicalize focus and close events.
 */
import { chatKey, NEW_DRAFT_TAB_ID } from "../chat/state/chatTabs";

/** Stable panel id of the single unsent draft. */
export const DRAFT_PANEL_ID = chatKey(NEW_DRAFT_TAB_ID);

export interface DraftAlias {
  /** The materialized canonical key currently aliased to `chat:new`, if any. */
  readonly materializedKey: string | undefined;
  /**
   * Observe the window-level active key. When it moves from `chat:new` to a
   * materialized `chat:<id>`, record the alias. Idempotent under StrictMode
   * double-render (same inputs produce the same state).
   */
  observeActiveKey(next: string | undefined): void;
  /** Map a canonical tab key to the panel id to focus/open. */
  panelIdFor(key: string): string;
  /** Map a panel id back to its canonical tab key. */
  canonicalKeyFor(panelId: string): string;
  /** Drop the alias (genuine close or fresh-draft replacement). */
  clear(): void;
}

/** Create an isolated alias state machine (one per Dockview instance in tests). */
export function createDraftAlias(): DraftAlias {
  let materialized: string | undefined;
  let previous: string | undefined;

  return {
    get materializedKey() {
      return materialized;
    },
    observeActiveKey(next) {
      if (
        previous === DRAFT_PANEL_ID &&
        next &&
        next !== DRAFT_PANEL_ID &&
        next.startsWith("chat:")
      ) {
        materialized = next;
      }
      previous = next;
    },
    panelIdFor(key) {
      return key === materialized ? DRAFT_PANEL_ID : key;
    },
    canonicalKeyFor(panelId) {
      return panelId === DRAFT_PANEL_ID && materialized ? materialized : panelId;
    },
    clear() {
      materialized = undefined;
    },
  };
}
