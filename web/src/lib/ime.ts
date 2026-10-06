/**
 * IME composition guards.
 *
 * WHY THIS EXISTS. Pressing Enter to accept a candidate in an input method
 * (Japanese, Chinese, Korean) also fires a `keydown`. Any surface that treats
 * Enter as "advance" or "submit" would answer a question the reader was only
 * halfway through typing — and the submitted text would be the pinyin, not the
 * kanji they meant. Escape is worse in some ways: it belongs to the IME too, so a
 * handler bound to it can dismiss a dialog the reader was still typing into.
 */

/**
 * Whether a keyboard event carries an IME signal *by itself*.
 *
 * Kept as a secondary check, not the primary mechanism. Both signals are checked
 * because they are not equivalent across engines: `isComposing` is the standard
 * flag, and `keyCode === 229` is what WebKit/Blink report while a composition is
 * open. `keyCode` is deprecated, but 229 remains a practical fallback.
 *
 * This cannot be trusted alone — see {@link createCompositionTracker} for why.
 *
 * @param event - A React or native keyboard event.
 * @returns True if this event itself reports an active composition.
 */
export function isIMECompositionEvent(event: KeyboardEvent | React.KeyboardEvent): boolean {
  // CodeMirror keymaps hand out the native event; React handlers wrap it.
  const native = "nativeEvent" in event ? event.nativeEvent : event;
  return native.isComposing || native.keyCode === 229;
}

/** The minimum surface a composition tracker needs. Keeps it testable without a DOM. */
export type CompositionTarget = {
  addEventListener(type: string, listener: () => void, capture?: boolean): void;
  removeEventListener(type: string, listener: () => void, capture?: boolean): void;
};

/**
 * Tracks whether an IME composition is currently open, as STATE rather than by
 * inspecting each key event.
 *
 * Per-event inspection is the common shortcut and it is not sufficient. Two
 * reasons, both observed in real engines:
 *
 * 1. **Safari fires `compositionend` BEFORE the final `keydown`.** By the time
 *    that keydown arrives, `event.isComposing` is already `false` and its
 *    `keyCode` is a normal `13`. The Enter that *ended* the composition therefore
 *    looks like an ordinary Enter and runs the handler — the exact failure this
 *    module exists to prevent. See Square's "Understanding Composition Browser
 *    Events" for the full sequence.
 *
 * 2. **There is no `input` event with `isComposing === false`** ahead of
 *    `compositionend`, so an app cannot decide "am I composing?" from input
 *    events at all. The platform guidance is to listen for `compositionstart` and
 *    `compositionend` directly.
 *
 * The fix for (1) is to defer clearing the flag past the current task. The
 * keydown and the deferred reset then always resolve in that order regardless of
 * which the engine emitted first.
 *
 * @param target - Where to listen. `document` in an app; a fake in tests.
 * @param schedule - Deferred-callback scheduler. Injectable so the ordering case
 *   can be asserted synchronously.
 */
export function createCompositionTracker(
  target: CompositionTarget,
  schedule: (fn: () => void) => void = queueMicrotask,
) {
  let composing = false;

  const onStart = () => {
    composing = true;
  };
  const onEnd = () => {
    // Deferred, and deliberately NOT synchronous. See (1) above.
    schedule(() => {
      composing = false;
    });
  };

  target.addEventListener("compositionstart", onStart, true);
  target.addEventListener("compositionend", onEnd, true);

  return {
    /** True while a composition is open. */
    isComposing: () => composing,
    /** Detach both listeners. */
    dispose: () => {
      target.removeEventListener("compositionstart", onStart, true);
      target.removeEventListener("compositionend", onEnd, true);
    },
  };
}

let shared: ReturnType<typeof createCompositionTracker> | null = null;

/**
 * Attach the shared tracker. Safe to call repeatedly.
 *
 * ## Why this is NOT lazy
 *
 * An earlier version installed the tracker on the first `isComposing()` call —
 * that is, on the first keydown. That is too late, and silently so: with an IME
 * active, `compositionstart` fires BEFORE the keydown for the first keystroke. A
 * lazily-attached listener therefore misses the opening of every first
 * composition and reports "not composing" for all of it, which is precisely the
 * bug this module exists to prevent. Nothing would throw; the guard would just
 * quietly stop guarding.
 *
 * So the tracker is installed at module load. It cannot be forgotten, because
 * nothing has to remember to call it.
 */
function ensureSharedTracker(): ReturnType<typeof createCompositionTracker> | null {
  if (typeof document === "undefined") return null;
  shared ??= createCompositionTracker(document);
  return shared;
}

// Installed on import, before any component mounts and long before any keydown.
ensureSharedTracker();

/**
 * True when an IME owns the keyboard right now.
 *
 * ORs the shared state with the event's own signal, so a keydown that arrives
 * before the tracker exists — or on a target with no document — is still judged
 * on its own merits rather than assumed safe.
 *
 * @param event - Optional; the event being considered.
 */
export function isComposing(event?: KeyboardEvent | React.KeyboardEvent): boolean {
  if (event && isIMECompositionEvent(event)) return true;
  return ensureSharedTracker()?.isComposing() ?? false;
}

/**
 * Enter pressed as a command — not as "accept this IME candidate".
 *
 * Shift is excluded deliberately: a modified Enter is almost always a deliberate
 * chord, never "confirm what I just typed". Callers that want Shift+Enter for
 * something else should test for it before calling this.
 */
export function isPlainEnter(event: KeyboardEvent | React.KeyboardEvent): boolean {
  const key = "key" in event ? event.key : (event as KeyboardEvent).key;
  return key === "Enter" && !event.shiftKey && !isComposing(event);
}

/** Escape pressed as a command — not as "cancel this IME composition". */
export function isPlainEscape(event: KeyboardEvent | React.KeyboardEvent): boolean {
  const key = "key" in event ? event.key : (event as KeyboardEvent).key;
  return key === "Escape" && !isComposing(event);
}