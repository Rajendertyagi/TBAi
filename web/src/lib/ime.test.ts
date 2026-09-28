import { describe, expect, it } from "bun:test";
import { isIMECompositionEvent } from "./ime";

/**
 * The IME guard, which decides whether Enter means "newline" or "submit".
 *
 * Composing an IME candidate fires a keydown for Enter. If that were treated as
 * a submit, a reader answering in Japanese, Chinese or Korean would have their
 * half-finished reading sent as their answer, and the pinyin would be stored
 * instead of the kanji they meant. Both signals are checked because engines
 * disagree about which one they set.
 */

function reactEvent(init: { isComposing?: boolean; keyCode?: number }): React.KeyboardEvent {
  return { nativeEvent: { isComposing: init.isComposing ?? false, keyCode: init.keyCode ?? 0 } } as never;
}

function nativeEvent(init: { isComposing?: boolean; keyCode?: number }): KeyboardEvent {
  return { isComposing: init.isComposing ?? false, keyCode: init.keyCode ?? 0 } as never;
}

describe("isIMECompositionEvent", () => {
  it("is true while a composition is open", () => {
    expect(isIMECompositionEvent(nativeEvent({ isComposing: true }))).toBe(true);
    expect(isIMECompositionEvent(reactEvent({ isComposing: true }))).toBe(true);
  });

  it("is true for the 229 keyCode, which some engines report instead", () => {
    // WebKit/Blink report keyCode 229 during composition while leaving
    // `isComposing` false, so either signal alone is not enough.
    expect(isIMECompositionEvent(nativeEvent({ keyCode: 229 }))).toBe(true);
    expect(isIMECompositionEvent(reactEvent({ keyCode: 229 }))).toBe(true);
  });

  it("is false for an ordinary keypress", () => {
    expect(isIMECompositionEvent(nativeEvent({}))).toBe(false);
    expect(isIMECompositionEvent(reactEvent({}))).toBe(false);
  });

  it("is false for an ordinary Enter, which is the case that must submit", () => {
    // Non-vacuity: without this, a guard that always returned true would pass
    // the composition cases and silently make the form unanswerable.
    expect(isIMECompositionEvent(nativeEvent({ isComposing: false, keyCode: 13 }))).toBe(false);
    expect(isIMECompositionEvent(reactEvent({ isComposing: false, keyCode: 13 }))).toBe(false);
  });

  it("unwraps a React event to its native event", () => {
    // The React handler's own object has no `isComposing`; only the wrapped
    // native event does. Reading the wrapper directly would always answer false.
    const event = { nativeEvent: { isComposing: true, keyCode: 229 } } as never;
    expect(isIMECompositionEvent(event)).toBe(true);
  });
});
