/**
 * Durable unsent-composer-text helpers (Phase 3: composer draft persistence).
 *
 * Same pattern as the tab/draft stores (`chatTabs.persist`,
 * `welcomeEngine.persist`): plain localStorage helpers, no new Zustand store,
 * no secrets — message text only, keyed per thread. The composer value itself
 * stays runtime-owned; these helpers are just the durable backup read on
 * mount and cleared when the box empties (send or manual clear).
 */

const DRAFT_PREFIX = "tbai:composer-draft:";

function keyFor(threadKey: string): string {
  return `${DRAFT_PREFIX}${threadKey}`;
}

export interface ComposerDraft {
  text: string;
  updatedAt: number;
}

/** Read the saved draft for a thread, or null when none/corrupt. */
export function readComposerDraft(threadKey: string | null | undefined): ComposerDraft | null {
  if (!threadKey) return null;
  try {
    const raw = localStorage.getItem(keyFor(threadKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ComposerDraft>;
    if (typeof parsed.text !== "string" || parsed.text.length === 0) return null;
    return { text: parsed.text, updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0 };
  } catch {
    return null;
  }
}

/** Persist non-empty text; empty text removes the key (sent or cleared). */
export function writeComposerDraft(threadKey: string | null | undefined, text: string): void {
  if (!threadKey) return;
  try {
    if (!text) {
      localStorage.removeItem(keyFor(threadKey));
      return;
    }
    localStorage.setItem(keyFor(threadKey), JSON.stringify({ text, updatedAt: Date.now() }));
  } catch {
    /* storage full/blocked — draft stays memory-only, never throws into render */
  }
}

/** Drop the saved draft for a thread (explicit discard). */
export function clearComposerDraft(threadKey: string | null | undefined): void {
  if (!threadKey) return;
  try {
    localStorage.removeItem(keyFor(threadKey));
  } catch {
    /* ignore */
  }
}
