import type { Unstable_SlashCommand } from "@assistant-ui/react";
import type { OpenCodeRuntimeContextValue } from "./opencodeRuntimeContext";

/** The one built-in compact name; the label is always `/${name}`. */
export const COMPACT_COMMAND_NAME = "compact";
export const COMPACT_COMMAND_DESCRIPTION = "Compress session history using AI to reduce context size";
export const COMPACT_ENTRY_ID = "opencode:compact";

/** True only when the composer contains a whole `/compact` invocation. */
export function isCompactCommandText(text: string): boolean {
  return /^\/compact(?=\s|$)/.test(text.trimStart());
}

/** Whether the native compact admission callback is available on this surface. */
export function shouldOfferCompact(
  isCodeSurface: boolean,
  context: OpenCodeRuntimeContextValue | null | undefined,
): boolean {
  return isCodeSurface && typeof context?.sessionId === "string" && context.sessionId.trim().length > 0 && context.compact !== undefined;
}

/** Builds the built-in palette entry; selection only inserts the command text. */
export function buildCompactEntry(onSelect: (name: string) => void): Unstable_SlashCommand {
  return {
    id: COMPACT_ENTRY_ID,
    label: `/${COMPACT_COMMAND_NAME}`,
    description: COMPACT_COMMAND_DESCRIPTION,
    execute: () => onSelect(COMPACT_COMMAND_NAME),
  };
}
