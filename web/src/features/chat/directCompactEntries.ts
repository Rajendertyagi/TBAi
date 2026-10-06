/**
 * The Direct palette's compact entries.
 *
 * Extracted out of `Composer.tsx` for one reason: the wiring between a command
 * TOKEN and the sigil-less NAME the palette API expects is precisely where
 * `/compact` became `//compact `, and a source-string assertion over the composer
 * passed happily while the feature was broken. Building the entries in one pure
 * function makes that wiring executable, and therefore testable — the entry's
 * `execute` can be run against real composer text and the resulting string
 * asserted, instead of grepping for a call shape.
 *
 * The shape mirrors the two existing builders exactly (`toSlashCommands` for the
 * feed, `buildCompactEntry` for the built-in), so all three agree:
 *
 *   id      sigil-less name, unique across the palette
 *   label   sigil-bearing, because this is what the user reads
 *   execute receives the sigil-less NAME and lets the caller apply it
 */

import { commandLabel } from "../opencode/slashCommands";
import { DIRECT_COMPACT_COMMANDS, commandNameOf } from "./compactCommand";

/** One palette row. Structurally the slice of assistant-ui's entry type we use. */
export interface DirectCompactEntry {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly execute: () => void;
}

/** Prefix keeping these ids distinct from the feed's and the built-in's. */
const DIRECT_ENTRY_ID_PREFIX = "direct-";

/**
 * Build one palette row per accepted Direct compaction spelling.
 *
 * `select` receives the sigil-less NAME, never the token: the caller's insertion
 * helper adds the sigil, and passing a token that already has one is what produced
 * `//compact `. `description` is supplied by the caller because the copy belongs to
 * the composer's configuration, not to this command module.
 */
export function buildDirectCompactEntries(
  description: string,
  select: (name: string) => void,
): DirectCompactEntry[] {
  return DIRECT_COMPACT_COMMANDS.map((token) => {
    const name = commandNameOf(token);
    return {
      id: `${DIRECT_ENTRY_ID_PREFIX}${name}`,
      label: commandLabel(name),
      description,
      // Selection only INSERTS the text, exactly as the feed's and the built-in's
      // rows do. The command runs on submit through the interception in
      // `compactCommand.ts`, so the palette and a typed command stay one execution
      // path, arguments stay editable, and selecting a row never compacts by itself.
      execute: () => select(name),
    };
  });
}