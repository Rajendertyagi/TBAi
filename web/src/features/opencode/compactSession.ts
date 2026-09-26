import type { Unstable_SlashCommand } from "@assistant-ui/react";
import { logger } from "../../lib/logger";
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

/**
 * Correlation fields for a compact run; the session is what identifies it.
 *
 * A `type`, not an `interface`: the logger takes an index-signature record, and
 * only type aliases get the implicit index signature that makes them assignable.
 */
export type CompactRunFields = {
  sessionId?: string;
};

/**
 * Runs the built-in `/compact` summarize and records its lifecycle.
 *
 * The three events exist because a compaction is invisible from the UI: it is a
 * server-side summarization, so "the command never reached the server" and "the
 * server refused it" look identical on screen. `started` / `completed` /
 * `failed` is what makes the run reconstructable from logs alone.
 *
 * Rethrows so the caller's own error surface still runs — this function
 * observes, it does not decide what the user sees. `failed` is logged before the
 * rethrow so a rejected run is never silent.
 */
export async function runCompactSession(
  compact: () => Promise<void>,
  fields: CompactRunFields = {},
): Promise<void> {
  logger.info("opencode", "command.compact_started", fields);
  try {
    await compact();
  } catch (cause) {
    logger.warn("opencode", "command.compact_failed", {
      ...fields,
      error: cause instanceof Error ? cause.message : String(cause),
    });
    throw cause;
  }
  logger.info("opencode", "command.compact_completed", fields);
}
