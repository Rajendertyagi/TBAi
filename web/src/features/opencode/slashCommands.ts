/**
 * OpenCode slash commands → assistant-ui composer entries.
 *
 * OpenCode is the authority for which commands exist: `GET /command` (reached
 * through the existing `/api/opencode/*` proxy) returns them, already merged
 * with the skills the server exposes as commands and tagged by `source`
 * (`"command"` for real commands, `"skill"` for skill-backed ones). Nothing
 * here hardcodes a command name — the feed is the only source of truth, so a
 * new `.opencode/commands/*.md` or skill appears without a code change.
 *
 * Pure and dependency-free (the library's command type is imported as a TYPE
 * only), so every edge below is directly unit-testable with no DOM.
 */

import type { Unstable_SlashCommand } from "@assistant-ui/react";

/**
 * One entry from OpenCode's command feed. Only `name` is guaranteed; the
 * server has already varied the rest across versions, so every other field is
 * optional and parsed defensively.
 */
export interface OpenCodeCommand {
  name: string;
  description?: string;
  /** `"command"` for a real command, `"skill"` for a skill exposed as one. */
  source?: string;
  /** Prompt template; may contain `$ARGUMENTS`. */
  template?: string;
  /** Free-form server hints (agent/model/subtask…); passed through untouched. */
  hints?: unknown;
  subtask?: unknown;
}

/** True for anything shaped enough to be a command entry. */
function isCommandLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Parse a raw `/command` payload into commands.
 *
 * Defensive by design: a malformed payload yields an EMPTY list rather than
 * throwing into a render, and a single bad entry is dropped rather than taking
 * the whole feed with it ("one failed entity must not erase unrelated
 * complete entities"). Names are de-duplicated case-insensitively — the server
 * merges commands and skills, so a name can legitimately appear twice — with
 * the first occurrence winning so the feed's own ordering is preserved.
 */
export function parseCommandFeed(raw: unknown): OpenCodeCommand[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const commands: OpenCodeCommand[] = [];
  for (const entry of raw) {
    if (!isCommandLike(entry)) continue;
    const name = optionalString(entry.name);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    commands.push({
      name,
      description: optionalString(entry.description),
      source: optionalString(entry.source),
      template: optionalString(entry.template),
      hints: entry.hints,
      subtask: entry.subtask,
    });
  }
  return commands;
}

/** The text a command is invoked by: `/name`. */
export function commandLabel(name: string): string {
  return `/${name}`;
}

/**
 * The trailing `/token` a selection should replace.
 *
 * Matches a sigil at the start of the text or after whitespace, with no
 * intervening whitespace before the caret — the same boundary rule the picker
 * uses, so what gets replaced is exactly what opened the popover. The token
 * itself may be empty: typing a bare `/` opens the palette, and selecting
 * from it must replace that sigil rather than appending a second one
 * (`//name`). Returns null when there is no such token (the caller then
 * appends rather than guessing).
 */
const TRAILING_TOKEN = /(^|\s)\/([A-Za-z0-9][A-Za-z0-9_-]*)?$/;

/**
 * Replace the trailing trigger token with the chosen command, preserving
 * everything the user typed before it. `insertCommand` is idempotent for text
 * that already ends in the same command.
 */
export function applyCommandSelection(text: string, name: string): string {
  const insertion = `${commandLabel(name)} `;
  const match = TRAILING_TOKEN.exec(text);
  if (!match) return text.length === 0 ? insertion : `${text}${insertion}`;
  const start = match.index + match[1].length;
  return `${text.slice(0, start)}${insertion}`;
}

/**
 * Map the feed to the composer's command entries.
 *
 * `execute` is injected rather than read off the command, so the same feed can
 * drive different behaviours (insert-and-edit today, invoke-and-send later)
 * without the data changing shape. The id is the command name: it is already
 * unique after parsing, and it is what the server needs when the command is
 * finally invoked.
 */
export function toSlashCommands(
  commands: readonly OpenCodeCommand[],
  execute: (command: OpenCodeCommand) => void,
): Unstable_SlashCommand[] {
  return commands.map((command) => ({
    id: command.name,
    label: commandLabel(command.name),
    // Palette rows are single-line-clamped: collapse server-side newlines and
    // runs of whitespace so a multi-sentence skill description renders as one
    // clean row instead of broken lines. The stored feed keeps the raw text.
    ...(command.description
      ? { description: command.description.replace(/\s+/g, " ").trim() }
      : {}),
    execute: () => execute(command),
  }));
}
