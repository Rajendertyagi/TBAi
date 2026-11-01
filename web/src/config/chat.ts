/**
 * Width of the centred chat column.
 *
 * One number drives three surfaces — the transcript, the composer dock and the
 * welcome column — so message text, the input box and the empty state all share
 * the same left and right edges at every setting. Before this existed only the
 * composer was capped, which is why the text and the box it was typed into
 * started at different x positions.
 *
 * The values are the column's OUTER width; each surface keeps its own inner
 * padding, so switching width never changes the gutter, only the column.
 */
export type ChatWidth = "narrow" | "comfortable" | "wide";

export const CHAT_WIDTHS: Record<ChatWidth, { px: number; label: string }> = {
  narrow: { px: 640, label: "Narrow" },
  // The width the composer has always used (`max-w-3xl`). Keeping it as the
  // default means the setting ships without moving anyone's layout.
  comfortable: { px: 768, label: "Comfortable" },
  wide: { px: 1024, label: "Wide" },
};

export const CHAT_WIDTH_ORDER: readonly ChatWidth[] = ["narrow", "comfortable", "wide"];

export const DEFAULT_CHAT_WIDTH: ChatWidth = "comfortable";

/** Type guard for persisted payloads and UI input. */
export function isChatWidth(value: unknown): value is ChatWidth {
  return value === "narrow" || value === "comfortable" || value === "wide";
}

/** Column width in px for a setting value. */
export function chatColumnWidth(chatWidth: ChatWidth): number {
  return CHAT_WIDTHS[chatWidth].px;
}
