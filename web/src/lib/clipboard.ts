/**
 * Clipboard helpers for the composer's own context menu.
 *
 * Copy-first discipline (Codeg `clipboard-actions` parity): the Radix menu
 * traps focus until it closes, so writes are deferred and may fail (notably
 * the async Clipboard API in non-secure contexts, plus the legacy
 * `execCommand` fallback). Every remover therefore copies first and mutates
 * the textarea only on a confirmed write — never delete-then-hope.
 */

export interface TextareaLike {
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  focus: () => void;
  setRangeText: (
    replacement: string,
    start?: number,
    end?: number,
    selectionMode?: "select" | "start" | "end" | "preserve",
  ) => void;
  dispatchEvent: (event: Event) => boolean;
}

/** Deferred clipboard write. Resolves `false` when every path fails. */
export async function copyTextFromMenu(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    const clipboard = (
      globalThis as { navigator?: { clipboard?: { writeText?: (t: string) => Promise<void> } } }
    ).navigator?.clipboard;
    if (clipboard?.writeText) {
      await clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    if (typeof document === "undefined") return false;
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

function selectedText(ta: TextareaLike): {
  text: string;
  start: number;
  end: number;
} {
  const start = ta.selectionStart ?? 0;
  const end = ta.selectionEnd ?? ta.value.length;
  return { text: ta.value.slice(start, end), start, end };
}

/** Notify React-controlled inputs that the value changed programmatically. */
function notifyInput(ta: TextareaLike): void {
  try {
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  } catch {
    /* non-DOM test doubles ignore this */
  }
}

/**
 * Atomic cut: copy first, remove only on a confirmed write. Returns `true`
 * when text was copied and removed; calls `onWriteFailed` and keeps the
 * text intact otherwise.
 */
export async function cutTextareaSelection(
  ta: TextareaLike,
  onWriteFailed: () => void,
): Promise<boolean> {
  const { text, start, end } = selectedText(ta);
  if (!text) return false;
  const copied = await copyTextFromMenu(text);
  if (!copied) {
    onWriteFailed();
    return false;
  }
  ta.setRangeText("", start, end, "start");
  ta.focus();
  notifyInput(ta);
  return true;
}

/** Insert clipboard plain text at the cursor (replacing any selection). */
export async function pastePlainTextInto(
  ta: TextareaLike,
  onWriteFailed: () => void,
): Promise<boolean> {
  try {
    const clipboard = (
      globalThis as { navigator?: { clipboard?: { readText?: () => Promise<string> } } }
    ).navigator?.clipboard;
    if (!clipboard?.readText) {
      onWriteFailed();
      return false;
    }
    const text = await clipboard.readText();
    if (!text) return false;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? ta.value.length;
    ta.setRangeText(text, start, end, "end");
    ta.focus();
    notifyInput(ta);
    return true;
  } catch {
    onWriteFailed();
    return false;
  }
}

/**
 * Insert text at the cursor (replacing any selection), preserving the
 * surrounding draft — snippet insertion must never clobber in-progress text.
 */
export function insertTextAtCursor(ta: TextareaLike, text: string): boolean {
  if (!text) return false;
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? ta.value.length;
  ta.setRangeText(text, start, end, "end");
  ta.focus();
  notifyInput(ta);
  return true;
}

/** Select the whole composer text. */
export function selectAllTextareaText(ta: TextareaLike): void {
  ta.focus();
  ta.setRangeText(ta.value, 0, ta.value.length, "select");
  notifyInput(ta);
}
