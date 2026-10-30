/**
 * Single source of truth for the assistant message action row (copy /
 * regenerate) and for the live-turn timer it sits beside. Components reference
 * this module — no user-facing literal lives in
 * `components/assistant-ui/elements/message-actions.tsx` or in `ChatWindow.tsx`.
 *
 * The strings match the ones the app already shipped before the row moved into
 * a vendored element, so the reader-facing vocabulary did not change with the
 * implementation.
 */
export const messageActionsConfig = {
  copy: {
    tooltip: "Copy message",
    copiedTooltip: "Copied!",
  },
  regenerate: {
    tooltip: "Regenerate response",
  },
  /**
   * How often the live-turn timer re-renders while a message is streaming.
   *
   * One second, because `formatDuration` writes tenths of a second below a
   * minute: a faster tick would repaint more often than the text can change,
   * and a slower one would make the tenths visibly skip.
   */
  liveTickMs: 1000,
  /**
   * Footer chrome. The separator joins the provenance segments (model, agent,
   * duration, sent-at) into one readable line, and the suffix says the count
   * beside it is TOKENS for this turn — without it, `39.2k` reads like a
   * conversation total.
   */
  footer: {
    separator: "·",
    tokenSuffix: "tok",
    /** Tooltip text that spells out the exact count and its scope. */
    tokensTitle: (total: number) => `${total} tokens in this turn`,
  },
} as const;
