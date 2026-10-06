import { describe, expect, it } from "bun:test";
import {
  canTakeFocusSafely,
  decisionSurfaceCount,
  decisionSurfaceOwner,
  focusComposerInput,
  isTypingInto,
  registerDecisionSurface,
} from "./focus";

/**
 * The focus helpers behind the permission-card and question-dock keyboard work.
 *
 * These decide one thing: whether a card that has just appeared may pull the
 * keyboard away from wherever it currently is. Getting it wrong is not a subtle
 * degradation -- it either blocks the feature (never takes focus, so Enter goes
 * to the composer and sends an empty message instead of approving) or it
 * interrupts someone mid-sentence.
 *
 * `isTypingInto` and `canTakeFocusSafely` take the element as an argument, so the
 * whole decision is testable here even though the suite has no DOM.
 */

/** A stand-in for an element, carrying only what the helpers actually read. */
function fake(init: {
  value?: unknown;
  textContent?: string | null;
  isContentEditable?: boolean;
  inModal?: boolean;
}): Element {
  return {
    value: init.value,
    textContent: init.textContent ?? null,
    isContentEditable: init.isContentEditable,
    closest: (selector: string) =>
      init.inModal && selector.includes("dialog") ? ({ nodeName: "DIV" } as unknown) : null,
  } as unknown as Element;
}

describe("isTypingInto", () => {
  it("is true for a text field with unsent text", () => {
    // The case that must not be interrupted: a half-written message.
    expect(isTypingInto(fake({ value: "explain the auth flow" }))).toBe(true);
    expect(isTypingInto(fake({ value: "   " }))).toBe(false);
  });

  it("is true for a contentEditable region with text", () => {
    expect(isTypingInto(fake({ isContentEditable: true, textContent: "nijōhodo" }))).toBe(true);
  });

  it("is false for an empty field, which is the normal state after sending", () => {
    // This is the load-bearing case: after a message is sent the composer is
    // focused AND empty. Reading that as "the reader is typing" would leave the
    // new permission card unreachable by keyboard, which is the bug this whole
    // change set exists to fix.
    expect(isTypingInto(fake({ value: "" }))).toBe(false);
    expect(isTypingInto(fake({ isContentEditable: true, textContent: "" }))).toBe(false);
  });

  it("is false when nothing is focused", () => {
    expect(isTypingInto(null)).toBe(false);
    expect(isTypingInto(undefined)).toBe(false);
  });

  it("is false for a control that is not a text field", () => {
    // A focused button has a `value` of "" and must not read as typing.
    expect(isTypingInto(fake({ value: "" }))).toBe(false);
    expect(isTypingInto(fake({}))).toBe(false);
  });
});

describe("canTakeFocusSafely", () => {
  it("allows the take when nothing is focused", () => {
    expect(canTakeFocusSafely(null)).toBe(true);
  });

  it("allows the take when focus is on an empty composer", () => {
    expect(canTakeFocusSafely(fake({ value: "" }))).toBe(true);
  });

  it("refuses when the reader has unsent text", () => {
    expect(canTakeFocusSafely(fake({ value: "half a thought" }))).toBe(false);
  });

  it("refuses when focus is inside a modal, whose trap owns the keyboard", () => {
    // Otherwise the card and the dialog both call focus() and the reader lands in
    // neither.
    expect(canTakeFocusSafely(fake({ value: "", inModal: true }))).toBe(false);
    expect(canTakeFocusSafely(fake({ inModal: true }))).toBe(false);
  });
});

describe("focusComposerInput", () => {
  it("is a no-op, not a throw, when there is no composer", () => {
    // No DOM in this suite, so this is the real "composer not mounted" path.
    // A card unmounting must never be the thing that breaks the page.
    expect(focusComposerInput()).toBe(false);
  });
});

describe("registerDecisionSurface", () => {
  /**
   * A DOM-free stand-in for a focusable surface.
   *
   * `compareDocumentPosition` and `focus` are all the registry actually calls on
   * a surface element, and there is no DOM in this suite. `compareDocumentPosition`
   * is derived from an explicit ORDER, so these cases genuinely exercise the
   * "topmost, not last-mounted" rule rather than assuming array order.
   */
  function fakeSurface(order: number) {
    const element = {
      focused: false,
      focusCount: 0,
      compareDocumentPosition(other: { order: number }) {
        // DOCUMENT_POSITION_FOLLOWING === 4
        return other.order > order ? 4 : 2;
      },
      focus() {
        this.focused = true;
        this.focusCount += 1;
      },
    };
    return element as unknown as HTMLElement & { order: number; focusCount: number; focused: boolean };
  }

  /** The pick is deferred to a microtask, so let it run. */
  const settle = () => new Promise<void>((resolve) => queueMicrotask(() => resolve()));

  it("gives a lone card the keyboard", async () => {
    const before = decisionSurfaceCount();
    const card = fakeSurface(0);
    const release = registerDecisionSurface(card as unknown as HTMLElement);
    expect(decisionSurfaceCount()).toBe(before + 1);

    await settle();
    expect(card.focusCount).toBe(1);
    expect(decisionSurfaceOwner()).not.toBeNull();

    release();
    await settle();
    expect(decisionSurfaceCount()).toBe(before);
    expect(decisionSurfaceOwner()).toBeNull();
  });

  it("gives the TOPMOST card the keyboard, not the last one registered", async () => {
    // The bug this replaces: a list of cards each taking focus on mount left
    // focus on whichever React mounted last -- the bottom of a column that
    // renders top-down -- so Enter drained from the far end.
    const before = decisionSurfaceCount();
    const first = fakeSurface(0);
    const second = fakeSurface(1);
    const third = fakeSurface(2);
    const releases = [
      registerDecisionSurface(first as unknown as HTMLElement),
      registerDecisionSurface(second as unknown as HTMLElement),
      registerDecisionSurface(third as unknown as HTMLElement),
    ];

    await settle();
    expect(first.focusCount).toBe(1);
    expect(second.focusCount).toBe(0);
    expect(third.focusCount).toBe(0);

    for (const release of releases) release();
    await settle();
    expect(decisionSurfaceCount()).toBe(before);
  });

  it("hands the keyboard to the next card when the owner leaves", async () => {
    // This is what makes N cards N Enters: approving the top card focuses the
    // one below it, so the reader never hunts for where focus went.
    const before = decisionSurfaceCount();
    const first = fakeSurface(0);
    const second = fakeSurface(1);
    const releaseFirst = registerDecisionSurface(first as unknown as HTMLElement);
    const releaseSecond = registerDecisionSurface(second as unknown as HTMLElement);

    await settle();
    expect(first.focusCount).toBe(1);

    releaseFirst();
    await settle();
    expect(second.focusCount).toBe(1);

    releaseSecond();
    await settle();
    expect(decisionSurfaceCount()).toBe(before);
    expect(decisionSurfaceOwner()).toBeNull();
  });

  it("never lets a newly-arrived card steal focus from the current owner", async () => {
    // The other half of the rule. Without it, a second request arriving while the
    // reader is halfway through the first yanks focus away mid-decision.
    const before = decisionSurfaceCount();
    const first = fakeSurface(0);
    const releaseFirst = registerDecisionSurface(first as unknown as HTMLElement);
    await settle();
    expect(first.focusCount).toBe(1);

    const latecomer = fakeSurface(9);
    const releaseLate = registerDecisionSurface(latecomer as unknown as HTMLElement);
    await settle();
    expect(latecomer.focusCount).toBe(0);
    expect(first.focusCount).toBe(1);

    releaseLate();
    releaseFirst();
    await settle();
    expect(decisionSurfaceCount()).toBe(before);
  });

  it("ignores a second release, so a double unmount cannot free the keyboard", async () => {
    // React strict mode and remount races both release more than once. Without
    // the guard, an extra release would drop the owner and hand the keyboard to
    // a card the reader is still answering.
    const before = decisionSurfaceCount();
    const first = fakeSurface(0);
    const second = fakeSurface(1);
    const releaseFirst = registerDecisionSurface(first as unknown as HTMLElement);
    const releaseSecond = registerDecisionSurface(second as unknown as HTMLElement);
    await settle();

    releaseFirst();
    releaseFirst();
    releaseFirst();
    await settle();
    // The second card is now the owner, and a stray extra release must not have
    // taken the keyboard away from it.
    expect(second.focusCount).toBe(1);
    expect(decisionSurfaceOwner()).not.toBeNull();

    releaseSecond();
    await settle();
    expect(decisionSurfaceCount()).toBe(before);
  });

  it("ignores a surface with no element, so a detached ref cannot claim the keyboard", async () => {
    // A ref is null on the render before its element attaches. If that registered
    // as a focusable surface it would sit at the top of the list owning nothing.
    const before = decisionSurfaceCount();
    const release = registerDecisionSurface(null);
    await settle();
    expect(decisionSurfaceOwner()).toBeNull();
    release();
    expect(decisionSurfaceCount()).toBe(before);
  });
});
