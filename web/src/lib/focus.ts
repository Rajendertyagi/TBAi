/**
 * Focus helpers for surfaces that pull focus away from the composer.
 *
 * ## Why this exists
 *
 * The permission and question cards were reachable only with a mouse or by
 * tabbing from the top of the page. Worse, once you did reach one, dismissing it
 * dropped focus on `<body>` -- so the next keystroke went nowhere, because the
 * composer was no longer focused. Both halves are fixed here.
 *
 * ## Why a DOM query instead of a composer API
 *
 * `ComposerPrimitive.Input` is a `forwardRef`, but `Composer.tsx` keeps that ref
 * to itself and exposes nothing, so an outside card cannot reach it. The
 * library sets `name="input"` on the textarea it renders
 * (`ComposerPrimitiveInput.js`, `inputProps.name`), so that attribute is a
 * library-guaranteed handle rather than something this app invents. OpenChamber
 * reaches the composer the same way, with a selector helper.
 *
 * If a future library version drops the attribute, the failure is a lost focus
 * restore -- NOT a crash: every helper here returns a boolean and callers treat
 * "not found" as "carry on".
 */

import { useSyncExternalStore } from "react";

/** The element {@link focusComposerInput} restores focus to. */
const COMPOSER_INPUT_SELECTOR = 'textarea[name="input"]';

/**
 * A focused element that owns the keyboard: an open modal, or an alert dialog.
 *
 * A modal has its own focus trap, so anything outside it that calls `focus()`
 * starts a tug-of-war with the trap and the user lands in neither place.
 */
const MODAL_SELECTOR = '[role="dialog"], [role="alertdialog"]';

/** The bits of an element this module reads. Keeps the helpers testable without a DOM. */
type FocusableLike = {
  isContentEditable?: boolean;
  value?: unknown;
  textContent?: string | null;
  closest?: (selector: string) => unknown;
};

/**
 * Is the reader part-way through typing here?
 *
 * True only when a text-capable element is focused AND non-empty. An empty field
 * is not "someone is typing" -- it is the normal state of the composer after a
 * message is sent, and that is exactly the moment a card most wants focus.
 *
 * Deliberately not a timestamp. "Did they type recently?" gets the common case
 * wrong: submitting a message is typing, so a time window would refuse to move
 * focus on precisely the transition where the reader expects it. What matters
 * is whether there is unsent text at risk, and only the element knows that.
 */
export function isTypingInto(element: Element | null | undefined): boolean {
  if (!element) return false;
  const candidate = element as Element & FocusableLike;

  if (candidate.isContentEditable) {
    return (candidate.textContent ?? "").trim().length > 0;
  }
  if (typeof candidate.value === "string") {
    return candidate.value.trim().length > 0;
  }
  return false;
}

/**
 * May a newly-appeared card move focus to itself right now?
 *
 * Three cases, all of which happen in normal use:
 *
 *   - focus is in a field with text  -> NO. The reader is mid-sentence in their
 *     own message; yanking them into a button row loses their cursor position
 *     and invites a stray Enter to be read as a decision.
 *   - focus is inside a modal       -> NO. Its focus trap owns the keyboard, and
 *     the two would fight.
 *   - anything else (including the
 *     empty composer after a send) -> YES. This is the common case and the whole
 *     point: a decision appeared, so the decision should be actionable.
 *
 * @param element - Defaults to the currently focused element; injectable for tests.
 */
export function canTakeFocusSafely(
  element: Element | null | undefined = typeof document === "undefined" ? null : document.activeElement,
): boolean {
  if (!element) return true;
  if (isTypingInto(element)) return false;
  if (typeof element.closest === "function" && element.closest(MODAL_SELECTOR)) return false;
  return true;
}

/**
 * Put focus back in the composer.
 *
 * Called when a decision card unmounts. Without it, focus lands on `<body>` and
 * the reader's next keystroke goes nowhere -- the card solved "can I decide with
 * the keyboard" and created "can I type with the keyboard".
 *
 * `preventScroll` matches what `ComposerPrimitiveInput` does with its own focus
 * call, so restoring focus cannot yank the message list sideways.
 *
 * @returns True if a composer was found and focused.
 */
export function focusComposerInput(): boolean {
  if (typeof document === "undefined") return false;
  const input = document.querySelector<HTMLTextAreaElement>(COMPOSER_INPUT_SELECTOR);
  if (!input || input.disabled) return false;
  input.focus({ preventScroll: true });
  return true;
}

/**
 * ## Decision surfaces: who owns the keyboard
 *
 * A "decision surface" is anything the reader can settle with Enter -- a
 * permission card's button row, or a question dock. There is usually one. There
 * can be many: `OpenCodePermissions` deliberately renders a LIST
 * (`unlinked.map(...)`, and its own comment says "this surface is a LIST"), so
 * twenty stacked requests is a real, intended state, not an edge case.
 *
 * Two rules, and the second is the one that matters:
 *
 * 1. **The owner is the topmost surface in the DOM**, not the last one to mount.
 *    React runs sibling mount effects in tree order, so a naive "each card takes
 *    focus on mount" leaves focus on the BOTTOM card of a column that renders
 *    top-down. Enter then drains the list from the far end and the reader spends
 *    the whole list scrolling to see what changed. Draining from the top makes N
 *    cards N Enters, and the focused card is always the one already on screen.
 *
 * 2. **A newly-arrived surface NEVER takes focus from the current owner.** Only
 *    the owner's departure frees the keyboard. Without this, a second request
 *    arriving while the reader is halfway through answering the first would yank
 *    focus away mid-decision -- the same bug as rule 1, in a different shape.
 *
 * The composer also reads ownership. `ComposerPrimitive.Input` re-focuses its own
 * textarea on scroll-to-bottom (`unstable_focusOnScrollToBottom`) and on
 * `thread.runStart` (`unstable_focusOnRunStart`); both default to TRUE and TBAi
 * overrode neither, so either would pull focus off a card the reader was about
 * to answer. Ownership is its cue to stand down, and it resumes the moment the
 * last surface goes.
 */
type Surface = { readonly id: number; element: HTMLElement | null };

let surfaces: Surface[] = [];
let ownerId: number | null = null;
let nextSurfaceId = 1;
let pickScheduled = false;
let pickGeneration = 0;

const focusListeners = new Set<() => void>();

const notifyFocusListeners = () => {
  for (const listener of [...focusListeners]) listener();
};

/** A surface whose element is attached, which is the only kind that can be focused. */
type AttachedSurface = { readonly id: number; readonly element: HTMLElement };

/**
 * `Node.DOCUMENT_POSITION_FOLLOWING`, inlined.
 *
 * The value is fixed by the DOM spec, but the `Node` global does not exist
 * without a DOM, and reaching for it here would make this module impossible to
 * test in the suite that has none. A bitwise flag check does not need a global.
 */
const DOCUMENT_POSITION_FOLLOWING = 4;

/**
 * The surface earliest in the document.
 *
 * DOM order, not registration order. They coincide for siblings in one commit,
 * but a permission list and a question dock mount from different parents, and
 * "topmost" has to mean what the reader sees rather than which effect ran first.
 */
function topmostSurface(): AttachedSurface | undefined {
  return surfaces
    .filter((surface): surface is AttachedSurface => surface.element !== null)
    .sort((a, b) =>
      a.element.compareDocumentPosition(b.element) & DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    )[0];
}

/**
 * Decide who owns the keyboard, deferred to a microtask.
 *
 * Deferred because the answer depends on every surface that was mounting in the
 * same commit. Choosing synchronously inside the first card's mount effect would
 * see a count of one, claim the keyboard, and be wrong the moment a second card
 * registers a moment later. A microtask runs after the whole effect flush and
 * the DOM update, so by then the list is what the reader will actually see.
 */
function scheduleFocusPick(): void {
  if (pickScheduled) return;
  pickScheduled = true;
  const generation = ++pickGeneration;
  queueMicrotask(() => {
    pickScheduled = false;
    if (generation !== pickGeneration) return;
    // Rule 2: an owner who is still there keeps it. This is what stops a new
    // request from stealing focus mid-decision.
    if (ownerId !== null) return;
    const next = topmostSurface();
    if (!next) return;
    if (!canTakeFocusSafely()) return;
    ownerId = next.id;
    next.element.focus({ preventScroll: true });
    notifyFocusListeners();
  });
}

/**
 * Register a decision surface, and return an idempotent release function.
 *
 * The surface becomes the focus owner only if nothing else holds the keyboard;
 * see {@link scheduleFocusPick}. Release from a mount effect's cleanup.
 *
 * @param element - The focusable row. Null is tolerated (a ref not yet attached)
 *   so registration does not have to be deferred behind a state update.
 */
export function registerDecisionSurface(element: HTMLElement | null): () => void {
  const surface: Surface = { id: nextSurfaceId++, element };
  surfaces = [...surfaces, surface];
  notifyFocusListeners();
  scheduleFocusPick();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    surfaces = surfaces.filter((entry) => entry.id !== surface.id);
    const wasOwner = ownerId === surface.id;
    if (wasOwner) ownerId = null;
    notifyFocusListeners();
    // The owner left, so hand the keyboard to whoever is now topmost. That is
    // what makes Enter drain a list from the top.
    if (wasOwner) scheduleFocusPick();
  };
}

/** Test seam: how many decision surfaces are registered. */
export function decisionSurfaceCount(): number {
  return surfaces.length;
}

/** Test seam: the id of the focus owner, or null when the keyboard is free. */
export function decisionSurfaceOwner(): number | null {
  return ownerId;
}

/**
 * Whether this element owns the keyboard RIGHT NOW.
 *
 * Read live rather than captured, because it is needed in an effect cleanup --
 * where a value captured at effect-creation time is stale by definition. An
 * earlier version kept a `tookFocus` ref set at focus time and never actually
 * set it, so the restore silently never ran and dismissing the last card left
 * focus on `<body>`. Asking the registry cannot drift that way.
 */
export function isDecisionSurfaceOwner(element: HTMLElement | null): boolean {
  if (!element) return false;
  return surfaces.some((surface) => surface.id === ownerId && surface.element === element);
}

const subscribeFocus = (listener: () => void) => {
  focusListeners.add(listener);
  return () => focusListeners.delete(listener);
};

/**
 * Subscribe to focus ownership, for this surface's id.
 *
 * `useSyncExternalStore` with a primitive snapshot per field, so no amount of
 * re-rendering can loop on an unstable object identity.
 */
export function useDecisionSurfaceFocus(element: HTMLElement | null): { count: number; isOwner: boolean } {
  const count = useSyncExternalStore(subscribeFocus, decisionSurfaceCount, () => 0);
  const isOwner = useSyncExternalStore(
    subscribeFocus,
    () => isDecisionSurfaceOwner(element),
    () => false,
  );
  return { count, isOwner };
}

/**
 * True while some decision surface owns the keyboard.
 *
 * The composer's cue to stand down. Derived from ownership rather than a separate
 * counter so there is exactly one source of truth for "does a card have the
 * keyboard": a flag that could disagree with the actual owner would eventually
 * let the composer steal focus from a card mid-decision.
 */
export function useKeyboardClaimed(): boolean {
  return useSyncExternalStore(
    subscribeFocus,
    () => ownerId !== null,
    () => false,
  );
}
