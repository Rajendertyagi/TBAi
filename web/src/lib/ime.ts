/**
 * Whether a keyboard event belongs to an IME composition.
 *
 * WHY THIS EXISTS. Pressing Enter to accept a candidate in an input method
 * (Japanese, Chinese, Korean) also fires a `keydown`. Any surface that treats
 * Enter as "advance" or "submit" would answer a question the reader was only
 * halfway through typing — and the submitted text would be the pinyin, not the
 * kanji they meant.
 *
 * Two signals are checked because they are not equivalent across engines:
 * `isComposing` is the standard flag, and `keyCode === 229` is what
 * WebKit/Blink report while a composition is open.
 *
 * @param event - A React or native keyboard event.
 * @returns True while an IME composition is active, so the caller must not
 *   advance or submit.
 */
export function isIMECompositionEvent(event: KeyboardEvent | React.KeyboardEvent): boolean {
  // CodeMirror keymaps hand out the native event; React handlers wrap it.
  const native = "nativeEvent" in event ? event.nativeEvent : event;
  return native.isComposing || native.keyCode === 229;
}
