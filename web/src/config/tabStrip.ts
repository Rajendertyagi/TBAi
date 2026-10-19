import type { KeyboardSensorOptions } from "@dnd-kit/dom";

/**
 * Single source of truth for the tab-strip chrome copy and drag behaviour.
 * Components reference this — no menu/tooltip literals and no drag tunables
 * live in `TabStrip.tsx`.
 */
export const tabStripConfig = {
  copy: {
    close: "Close",
    closeOthers: "Close Others",
    closeToRight: "Close to the Right",
    closeAll: "Close All",
    copyLink: "Copy Link",
    newChat: "New chat",
    closeTab: "Close tab",
    untitled: "Untitled",
    running: "Run in progress",
  },

  drag: {
    /**
     * Pointer travel required before a tab drag begins.
     *
     * The sensor's own default activates a mouse drag immediately on
     * pointerdown, which would open a drag operation on every plain click of a
     * tab. A small distance keeps a click a click.
     */
    activationDistancePx: 4,

    /**
     * Keyboard bindings for a keyboard drag, as `KeyboardEvent.key` values.
     *
     * `Enter` is deliberately absent from both ends: it stays tab ACTIVATION.
     * The sensor's default start/end keys include `Enter` and `Tab`, which
     * would swallow both. `up`/`down` stay empty because the strip is a single
     * row — a vertical key has nowhere to move to.
     */
    keyboardCodes: {
      start: ["Space"],
      end: ["Space"],
      cancel: ["Escape"],
      left: ["ArrowLeft"],
      right: ["ArrowRight"],
      up: [],
      down: [],
      // `KeyboardCodes` is used by the package's options but is not exported
      // from it, so the shape is taken from the option that consumes it.
    } satisfies NonNullable<KeyboardSensorOptions["keyboardCodes"]>,
  },
};
