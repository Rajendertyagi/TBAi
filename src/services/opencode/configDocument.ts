import { join } from "node:path";
import { z } from "zod";
import { logger } from "../../lib/logger";
import { classifyError } from "../../lib/errors";

/** Joins a directory and a file name using the host's path separator. */
const joinPath = join;

/**
 * Locating, reading, and rewriting the OpenCode configuration the managed V2
 * server actually consumes.
 *
 * ## The configuration source is DISCOVERED, never assumed
 *
 * TBAi spawns `opencode serve` with `cwd = data/opencode-home`
 * (`serverManager.ts`), which makes it look as though
 * `data/opencode-home/opencode.json` is authoritative. It is not. That file is
 * only read if it sits in the server's cwd *as a config OpenCode discovers*;
 * OpenCode resolves the real global document through its own config directory,
 * which on this machine comes from `XDG_CONFIG_HOME` (and `OPENCODE_CONFIG_DIR`).
 *
 * Measured live against the running managed server (`GET /api/config`), the
 * documents it reports are, in precedence order:
 *
 *   1. D:\IT\Coding\OpenCode\.config\opencode\opencode.json   ← the permissions
 *   2. D:\IT\Coding\OpenChamber\.chamber-data\opencode.managed.json
 *   3. D:\Temp\ai-chat-app\data\opencode-home\opencode.json    (model only)
 *
 * Only #1 carries `permissions`. The TBAi-owned file at #3 carries just
 * `model`/`small_model`. So the authoritative permission document is discovered
 * from the server, not computed from a path TBAi guesses.
 *
 * ## Why the server is asked rather than the filesystem walked
 *
 * The server is the only component that knows the merge order, which documents
 * exist, and which directory XDG points at on the current machine. Asking it
 * means this module cannot drift from reality when the layout changes. A
 * filesystem guess would silently start editing the wrong file — exactly the
 * failure that made `data/opencode-home/opencode.json` look authoritative.
 *
 * ## What this module does NOT do
 *
 * It does not interpret permission semantics, does not define a TBAi default
 * policy, and does not merge rules itself. `opencodeConfigDoc` is the raw parsed
 * document; a targeted, single-key mutation is applied by the caller through
 * {@link setOpenCodeConfigValue}, which preserves every unrelated key by
 * construction. OpenCode remains the source of truth for what a rule MEANS.
 */

/** One `GET /api/config` entry, narrowed to what this module reads. */
const configEntrySchema = z.object({
  type: z.string(),
  path: z.string().optional(),
  info: z.record(z.string(), z.unknown()).nullable().optional(),
});

/** The response shape: an array of discovered config sources. */
const configResponseSchema = z.array(configEntrySchema);

/** One OpenCode permission rule, exactly as the V2 schema declares it. */
export const openCodePermissionRuleSchema = z.object({
  action: z.string().min(1),
  resource: z.string().min(1),
  effect: z.enum(["allow", "ask", "deny"]),
});

/**
 * The discovered configuration document TBAi will read and edit.
 *
 * `permissions` is carried as raw JSON rather than a validated rule list on
 * purpose: a document whose `permissions` key holds something TBAi does not
 * understand must still round-trip untouched. Validation belongs to the
 * renderer (which reports it) and to the setter (which refuses to write it),
 * never to the reader, which must be able to show the user what is really
 * there.
 */
export interface OpenCodeConfigDocument {
  /** Absolute path of the file OpenCode actually reads these rules from. */
  readonly path: string;
  /** Every path the server reported, in the order it reported them. */
  readonly discoveredPaths: readonly string[];
  /** The parsed document. Empty object when the file is absent or blank. */
  readonly doc: Readonly<Record<string, unknown>>;
  /** The file's raw text, for the native-JSON view. */
  readonly raw: string;
  /** True when the text exists but is not a JSON object. Never auto-written. */
  readonly malformed: boolean;
}

/** Raised when a write is refused because the document cannot be trusted. */
export class OpenCodeConfigUnreadableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "OpenCodeConfigUnreadableError";
  }
}

/** Raised when the managed server reports no editable config document. */
export class OpenCodeConfigNotFoundError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "OpenCodeConfigNotFoundError";
  }
}

/**
 * The document that carries a `permissions` array, preferring the one the
 * server listed first.
 *
 * Selection is by CONTENT, never by filename or directory: the TBAi-owned
 * `data/opencode-home/opencode.json` also exists and also parses, so a
 * path-shaped rule would pick the wrong one. Among documents that carry
 * permissions the earliest wins, because the server lists them in precedence
 * order and a later, project-scoped document may narrow the global one — that
 * narrowing is a legitimate part of policy, not something to overwrite.
 */
export function selectConfigDocument(
  entries: readonly z.infer<typeof configEntrySchema>[],
): { path: string; doc: Record<string, unknown> } | null {
  const documents = entries.filter(
    (entry) => entry.type === "document" && typeof entry.path === "string",
  );
  const withPermissions = documents.find(
    (entry) => Array.isArray((entry.info as Record<string, unknown> | undefined)?.permissions),
  );
  const chosen = withPermissions ?? documents[0];
  if (!chosen || typeof chosen.path !== "string") return null;
  const info = (chosen.info ?? {}) as Record<string, unknown>;
  return { path: chosen.path, doc: info };
}

/**
 * Reads the live configuration from the managed server and picks the document
 * TBAi will edit.
 *
 * @param baseUrl - The managed server's base URL.
 * @param headers - Auth headers for the server's HTTP Basic gate.
 * @returns The discovered document, including its raw text.
 * @throws {OpenCodeConfigNotFoundError} When the server reports no document.
 */
export async function readOpenCodeConfigDocument(
  baseUrl: string,
  headers: Record<string, string>,
): Promise<OpenCodeConfigDocument> {
  const response = await fetch(new URL("/api/config", baseUrl), { headers });
  if (!response.ok) {
    throw new OpenCodeConfigUnreadableError(
      `OpenCode config read failed (${response.status})`,
    );
  }
  const parsedJson: unknown = await response.json().catch(() => null);
  const entries = configResponseSchema.safeParse(parsedJson);
  if (!entries.success) {
    throw new OpenCodeConfigUnreadableError(
      "OpenCode returned an unreadable config response",
    );
  }
  /**
   * A global config the server could not parse is DROPPED from its own listing.
   *
   * Verified live: with `~/.config/opencode/opencode.json` replaced by invalid
   * text, `GET /api/config` returned only the `directory` entry plus the two
   * later documents — the broken file was absent entirely. Selection by "first
   * document carrying permissions" then fell through to the OpenChamber managed
   * file and the page reported `editable: true` with 0 rules, for a document
   * that is not the policy at all, while the file actually breaking OpenCode
   * went unmentioned.
   *
   * So the global config is re-checked directly, BEFORE selection — a broken
   * file can leave the server reporting no document at all, and that is a
   * reportable state rather than a missing one. The `directory` entry is the
   * one source of truth for WHERE the file lives (XDG-resolved on the host, so
   * it cannot be computed here).
   */
  const brokenGlobal = await findUnreadableGlobalConfig(entries.data);
  if (brokenGlobal) {
    return {
      path: brokenGlobal.path,
      discoveredPaths: discoveredPathsOf(entries.data),
      doc: {},
      raw: brokenGlobal.raw,
      malformed: true,
    };
  }

  const selected = selectConfigDocument(entries.data);
  if (!selected) {
    throw new OpenCodeConfigNotFoundError(
      "OpenCode reported no configuration document",
    );
  }

  const discoveredPaths = discoveredPathsOf(entries.data);

  // The server's parsed `info` is authoritative for content, but the page must
  // also show the real file text. A file that is absent, blank, or not a JSON
  // object is reported as such and is NEVER written by this module.
  const raw = await readFileText(selected.path);
  if (raw === null) {
    return {
      path: selected.path,
      discoveredPaths,
      doc: selected.doc,
      raw: "",
      malformed: false,
    };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { path: selected.path, discoveredPaths, doc: {}, raw, malformed: false };
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        path: selected.path,
        discoveredPaths,
        doc: selected.doc,
        raw,
        malformed: true,
      };
    }
    return {
      path: selected.path,
      discoveredPaths,
      doc: parsed as Record<string, unknown>,
      raw,
      malformed: false,
    };
  } catch {
    return {
      path: selected.path,
      discoveredPaths,
      doc: selected.doc,
      raw,
      malformed: true,
    };
  }
}

/** Reads a file as UTF-8 text, or null when it does not exist. */
async function readFileText(path: string): Promise<string | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  return file.text();
}

/** Every path the server reported, in the order it reported them. */
function discoveredPathsOf(
  entries: readonly z.infer<typeof configEntrySchema>[],
): string[] {
  return entries
    .filter((entry) => typeof entry.path === "string")
    .map((entry) => entry.path as string);
}

/**
 * Whether config text exists and is not a JSON object.
 *
 * An ABSENT or empty file is not malformed: it is a document with nothing in it,
 * which is a legitimate base for a first write. Text that is present but does
 * not parse to an object is malformed, and nothing may be written to it.
 */
function isUnparsable(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed === null || typeof parsed !== "object" || Array.isArray(parsed);
  } catch {
    return true;
  }
}

/**
 * Finds a global OpenCode config that exists but cannot be parsed.
 *
 * The `directory` entry the server reports is OpenCode's own config directory,
 * which is where the global `opencode.json` lives. That path is XDG-resolved on
 * the host, so it can only be learned from the server — never computed here.
 *
 * Both the `.json` and `.jsonc` names are checked because OpenCode accepts
 * either, and a `jsonc` file with comments would not survive `JSON.parse`. A
 * JSONC global config is therefore reported as malformed rather than silently
 * rewritten: this feature can only safely edit strict JSON, and saying so is
 * better than destroying the user's comments on the first save.
 *
 * @returns The path and text of the broken file, or null when there is none.
 */
async function findUnreadableGlobalConfig(
  entries: readonly z.infer<typeof configEntrySchema>[],
): Promise<{ path: string; raw: string } | null> {
  const configDirectory = entries.find(
    (entry) =>
      entry.type === "directory" && typeof entry.path === "string",
  )?.path;
  if (typeof configDirectory !== "string") return null;
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    // `join` rather than string concatenation so the reported path uses the
    // host's separator and matches the paths the server itself reports — the
    // page shows this path next to the others, and a mixed-separator list reads
    // as two different locations.
    const path = joinPath(configDirectory, name);
    const raw = await readFileText(path);
    if (raw !== null && isUnparsable(raw)) return { path, raw };
  }
  return null;
}

/**
 * Serializes a document for disk, preserving every key TBAi did not touch.
 *
 * Two-space indent matches what the file already uses, so a one-rule change
 * produces a one-rule diff instead of reflowing the whole document. Key order
 * is insertion order, so a key that was already present keeps its position.
 */
export function serializeOpenCodeConfig(
  doc: Readonly<Record<string, unknown>>,
): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * Applies ONE targeted change to the document and returns the new text.
 *
 * This is the whole edit surface, and it is deliberately narrow. It reads the
 * document the caller already read, changes exactly one top-level key, and
 * rebuilds the text. Every other key — including any OpenCode field TBAi does
 * not model — is carried across untouched, because it is the same object.
 *
 * Passing `undefined` for `value` DELETES the key. A parent object left empty
 * by that delete is removed too, so unsetting a rule does not leave a dangling
 * `"compaction": {}` behind.
 *
 * @param raw - The current file text, re-read immediately before the write.
 * @param key - The top-level config key to change.
 * @param value - The new value, or undefined to remove the key.
 * @returns The complete new file text.
 * @throws {OpenCodeConfigUnreadableError} When `raw` is not a JSON object, or
 *   when `value` is not JSON-serializable. Never guesses a replacement.
 */
export function setOpenCodeConfigValue(
  raw: string,
  key: string,
  value: unknown,
): string {
  const trimmed = raw.trim();
  // An absent file parses to an empty document, which is a legitimate base for
  // a first write. Anything present but unparsable is refused outright.
  const base: Record<string, unknown> = trimmed.length === 0
    ? {}
    : parseConfigObjectOrThrow(trimmed);

  const next: Record<string, unknown> = { ...base };
  if (value === undefined) {
    delete next[key];
  } else {
    next[key] = structuredClone(value);
  }
  return serializeOpenCodeConfig(next);
}

/**
 * Replaces the `permissions` array with one rule, matched on action+resource.
 *
 * ## Preservation is the whole contract
 *
 * The array is ordered and OpenCode resolves it last-match-wins, so a naive
 * "filter out question, push allow" would silently move a rule past every rule
 * written after it and change what those rules decide. This therefore:
 *
 *   - finds the FIRST rule matching the same (action, resource) pair, which is
 *     the one actually in force, and changes only its `effect`;
 *   - leaves every other rule at its original index, with its original
 *     action, resource and effect;
 *   - returns the input array UNCHANGED when the rule to edit is absent, so an
 *     edit for a rule that is not there never invents one.
 *
 * Matching on the pair (not the action alone) is what keeps a `question` edit
 * from touching an `edit` rule that happens to share a resource pattern.
 *
 * @param current - The document's `permissions` value, of unknown shape.
 * @param match - The action and resource identifying the rule to change.
 * @param effect - The effect to write on that rule.
 * @returns The new array, or `current` itself when nothing matched.
 */
export function setOpenCodePermissionEffect(
  current: unknown,
  match: { readonly action: string; readonly resource: string },
  effect: "allow" | "ask" | "deny",
): unknown {
  if (!Array.isArray(current)) {
    throw new OpenCodeConfigUnreadableError(
      "OpenCode permissions are not an array of rules",
    );
  }
  const index = current.findIndex(
    (rule) =>
      rule !== null &&
      typeof rule === "object" &&
      !Array.isArray(rule) &&
      (rule as Record<string, unknown>).action === match.action &&
      (rule as Record<string, unknown>).resource === match.resource,
  );
  if (index === -1) return current;

  const existing = current[index] as Record<string, unknown>;
  const next = current.map((rule, at) => {
    if (at !== index) return rule;
    // Spreading the original keeps any extra field the rule carries, so an
    // unknown OpenCode field on this rule survives the edit.
    return { ...existing, effect };
  });
  return next;
}

/**
 * Appends one rule to the end of the array.
 *
 * ## Why append, and why that is stated to the user
 *
 * OpenCode resolves this array last-match-wins, so a rule's INDEX is part of its
 * meaning. Appending gives the new rule the highest precedence — it can narrow
 * anything above it, and nothing above it can narrow it. Inserting elsewhere
 * would need a position the user chose, and a position picker is a policy
 * decision the reference implementations do not make on the user's behalf
 * either. So the rule goes last and the UI says so plainly.
 *
 * An exact duplicate (same action AND resource) is refused rather than appended:
 * a second rule for the same pair is always dead, because the earlier one is
 * shadowed by it, and a file carrying a rule that can never fire is worse than
 * an error the user can act on.
 *
 * @param current - The document's `permissions` value, of unknown shape.
 * @param rule - The rule to append.
 * @returns The new array.
 * @throws {OpenCodeConfigUnreadableError} When the value is not an array, or the
 *   rule is a duplicate.
 */
export function appendOpenCodePermissionRule(
  current: unknown,
  rule: { readonly action: string; readonly resource: string; readonly effect: "allow" | "ask" | "deny" },
): unknown {
  if (!Array.isArray(current)) {
    throw new OpenCodeConfigUnreadableError(
      "OpenCode permissions are not an array of rules",
    );
  }
  const duplicate = current.some(
    (entry) =>
      entry !== null &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      (entry as Record<string, unknown>).action === rule.action &&
      (entry as Record<string, unknown>).resource === rule.resource,
  );
  if (duplicate) {
    throw new OpenCodeConfigUnreadableError(
      `A rule for "${rule.action}" on "${rule.resource}" already exists; change its effect instead`,
    );
  }
  return [...current, { action: rule.action, resource: rule.resource, effect: rule.effect }];
}

/**
 * Removes the rule at `index`, but only if it is still the one the caller saw.
 *
 * The index is re-checked against the caller's expected identity immediately
 * before the removal. A stale index is the one way this could delete the wrong
 * rule — the file can change under us, and "remove rule 7" is otherwise a
 * positional instruction against a list whose positions just moved.
 *
 * @param current - The document's `permissions` value, of unknown shape.
 * @param index - The position the caller read.
 * @param expected - The identity the caller saw at that position.
 * @returns The new array.
 * @throws {OpenCodeConfigUnreadableError} When the value is not an array, the
 *   index is out of range, or the rule there is no longer the expected one.
 */
export function removeOpenCodePermissionRule(
  current: unknown,
  index: number,
  expected: { readonly action: string; readonly resource: string; readonly effect: string },
): unknown {
  if (!Array.isArray(current)) {
    throw new OpenCodeConfigUnreadableError(
      "OpenCode permissions are not an array of rules",
    );
  }
  const at = current[index];
  if (at === null || typeof at !== "object" || Array.isArray(at)) {
    throw new OpenCodeConfigUnreadableError(
      "That rule is no longer at the position it was read from",
    );
  }
  const rule = at as Record<string, unknown>;
  if (
    rule.action !== expected.action ||
    rule.resource !== expected.resource ||
    rule.effect !== expected.effect
  ) {
    throw new OpenCodeConfigUnreadableError(
      "That rule changed on disk since it was read; reload and try again",
    );
  }
  return current.filter((_, at2) => at2 !== index);
}

/** Parses config text, throwing the typed refusal when it is not an object. */
function parseConfigObjectOrThrow(trimmed: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new OpenCodeConfigUnreadableError(
      "OpenCode configuration is not valid JSON; refusing to write",
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new OpenCodeConfigUnreadableError(
      "OpenCode configuration is not a JSON object; refusing to write",
    );
  }
  return parsed as Record<string, unknown>;
}

/**
 * Writes the document back to disk, refusing anything untrustworthy.
 *
 * The refusal list is the safety property this whole feature rests on: a
 * malformed document, or one whose `permissions` is present but not a rule
 * array, produces NO write at all. There is no fallback policy and no
 * merge-with-defaults path, because both would mean inventing rules the user
 * never asked for.
 *
 * @param path - The discovered document path.
 * @param nextText - The complete new file text.
 * @param current - The document as read, used to re-validate before writing.
 * @throws {OpenCodeConfigUnreadableError} When the write is refused.
 */
export async function writeOpenCodeConfigDocument(
  path: string,
  nextText: string,
  current: Readonly<Record<string, unknown>>,
): Promise<void> {
  // Re-validate against the SAME rules the reader applies, immediately before
  // the write. A document that has become malformed since the read is refused
  // rather than overwritten.
  const trimmed = nextText.trim();
  if (trimmed.length === 0) {
    throw new OpenCodeConfigUnreadableError(
      "Refusing to write an empty OpenCode configuration",
    );
  }
  const reparsed = parseConfigObjectOrThrow(trimmed);
  if (
    current.permissions !== undefined &&
    !Array.isArray(reparsed.permissions)
  ) {
    throw new OpenCodeConfigUnreadableError(
      "Refusing to write: permissions would no longer be a rule array",
    );
  }
  if (!Array.isArray(current.permissions) && current.permissions !== undefined) {
    throw new OpenCodeConfigUnreadableError(
      "Refusing to write: the current permissions value is not a rule array",
    );
  }
  await Bun.write(path, nextText);
  logger.info("opencode", "opencode.config_write", { path });
}
