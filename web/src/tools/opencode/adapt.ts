import type { ToolContent } from "@opencode/client";

/**
 * Explicit OpenCode → rich-UI normalization.
 *
 * WHY THIS EXISTS
 * OpenCode's tool arguments are NOT our native tool arguments, and the V2
 * message projection passes raw tool input through as `part.args`. So a rich UI
 * written against our own schema renders an empty title, an empty target path
 * and an empty body — strictly worse than the generic fallback, which at least
 * shows the raw JSON.
 *
 * FIELD NAMES ARE TAKEN FROM THE RUNNING SERVER, NOT ASSUMED
 *   - Arguments: `GET /experimental/tool?provider=<p>&model=<m>` on the
 *     OpenCode server returns each tool's JSON schema. That is the authority
 *     for the names in `OPENCODE_ARGS` below.
 *   - Result: native V2 completed tool state exposes `content` as an array of
 *     `{ type: "text", text }` parts. That V2 content array is normalized only
 *     at the renderer boundary for the shared rich-UI contracts.
 */

/**
 * Our rich UIs' argument names, per OpenCode tool.
 *
 * Read as `<opencode field> → <our field>`. Only aliases are listed; every
 * other field is passed through untouched, so nothing is silently dropped and
 * an unmapped tool renders exactly as before.
 */
export const OPENCODE_ARGS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  // OpenCode `read`  : { filePath, offset?, limit? }   -> read_file wants `path`
  read: { filePath: "path" },
  // OpenCode `write` : { content, filePath }           -> write_file wants `path`
  write: { filePath: "path" },
  // OpenCode `edit`  : { filePath, oldString, newString, replaceAll }
  //                                                    -> edit_file wants
  //                                                       `path`/`oldText`/`newText`
  edit: { filePath: "path", oldString: "oldText", newString: "newText" },
  // OpenCode `glob`/`grep` : { pattern, path?, include? }
  //                                                    -> search_files titles on `query`
  glob: { pattern: "query" },
  grep: { pattern: "query" },
  // OpenCode `bash`/`shell` : { command, timeout?, workdir? }
  //                                                        -> run_command wants `cwd`
  bash: { workdir: "cwd" },
  shell: { workdir: "cwd" },
};

/**
 * Add our argument names alongside OpenCode's.
 *
 * The OpenCode field is deliberately KEPT: the raw name is the truth about
 * what was actually requested, and keeping it means a mapping mistake shows up
 * as a redundant field rather than as missing data.
 *
 * An existing value always wins, so a genuine OpenCode field named `path`
 * (glob/grep have one) is never overwritten by an alias.
 */
export function normalizeOpenCodeArgs(
  tool: string,
  args: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (args == null) return args;
  const aliases = OPENCODE_ARGS[tool];
  if (aliases == null) return args;

  let out: Record<string, unknown> | undefined;
  for (const [from, to] of Object.entries(aliases)) {
    if (!(from in args) || args[to] !== undefined) continue;
    out ??= { ...args };
    out[to] = args[from];
  }
  return out ?? args;
}

function isToolContent(value: unknown): value is ToolContent {
  if (value === null || typeof value !== "object") return false;
  const record = value as { type?: unknown; text?: unknown; uri?: unknown; mime?: unknown; name?: unknown };
  if (record.type === "text") return typeof record.text === "string";
  if (record.type !== "file") return false;
  return (
    typeof record.uri === "string" &&
    typeof record.mime === "string" &&
    (record.name === undefined || record.name === null || typeof record.name === "string")
  );
}

function toolContentArray(value: unknown): ToolContent[] | null {
  const content = Array.isArray(value)
    ? value
    : value !== null && typeof value === "object" && "content" in value
      ? (value as { content: unknown }).content
      : null;
  if (!Array.isArray(content) || content.length === 0 || !content.every(isToolContent)) {
    return null;
  }
  return content;
}

/** Extracts display text from a native V2 tool content array. */
export function openCodeResultText(result: unknown): string | null {
  const content = toolContentArray(result);
  if (content === null) return null;
  const text = content
    .flatMap((item) => {
      if (item.type === "text") return [item.text];
      if (item.name && item.name.length > 0) return [item.name];
      return [item.uri];
    })
    .join("\n");
  return text.length > 0 ? text : null;
}

/**
 * Result normalization.
 *
 * Only needed where a rich UI reads a structured field out of the result.
 * Native V2 content arrays are normalized at this boundary; every other value
 * passes through so the generic renderer keeps the original structured value.
 */
export function normalizeOpenCodeResult(tool: string, result: unknown): unknown {
  if (result !== null && typeof result === "object" && !Array.isArray(result)) {
    const record = result as Readonly<Record<string, unknown>>;
    if (toolContentArray(record.content) !== null) return result;
  }
  const text = openCodeResultText(result);
  if (text === null) return result;
  // `ReadFileToolUI` summarizes `(r as any).content`, and OpenCode's `read`
  // returns the file text itself — so wrap it in the envelope the UI reads.
  if (tool === "read") return { content: text };
  // The terminal block renders from `{ stdout, stderr }` (`resultToLines`),
  // while OpenCode returns one combined string. Map it to stdout — OpenCode
  // does not separate the two, so splitting them here would be a guess.
  if (tool === "bash" || tool === "shell") return { stdout: text };
  return text;
}

/** True when this tool has any normalization at all (used by the guard test). */
export function isNormalizedOpenCodeTool(tool: string): boolean {
  return tool in OPENCODE_ARGS;
}

/**
 * Pull OpenCode's own patch out of the raw tool part for `callId`.
 *
 *   - the patch lives in native V2 `state.metadata.files[].patch`
 *   - **`write` has NO patch at all** (a whole-file write has nothing to diff
 *     against), so this returns null for `write` by data, not by special-case.
 *
 * The V2 projection preserves the official assistant content parts in
 * `metadata.custom.opencode.parts`, so the renderer reads the official V2 tool
 * state without accepting alternate metadata shapes.
 *
 * `callId` is the assistant-ui tool-call id derived from the native V2 tool
 * part's `id`; the suffix comparison recovers that official id.
 */
export function openCodePatchFromParts(
  rawParts: unknown,
  callId: string | undefined,
): string | null {
  if (!callId || !Array.isArray(rawParts)) return null;
  for (const part of rawParts) {
    if (part == null || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    const sourceId = typeof p.id === "string" ? p.id : null;
    const suffix = callId.startsWith("tbai-v2-tool:")
      ? decodeURIComponent(callId.slice(callId.lastIndexOf(":") + 1))
      : callId;
    if (sourceId !== suffix) continue;
    const state = p.state as Record<string, unknown> | undefined;
    const metadata = state?.metadata;
    if (metadata == null || typeof metadata !== "object") return null;
    const files = (metadata as { files?: unknown }).files;
    if (!Array.isArray(files)) return null;
    const file = files.find((entry): entry is { patch: string } =>
      entry !== null &&
      typeof entry === "object" &&
      typeof (entry as { patch?: unknown }).patch === "string",
    );
    return typeof file?.patch === "string" && file.patch.trim() ? file.patch : null;
  }
  return null;
}

/** One search hit, in the shape the official `WebSearch` element consumes. */
export interface OpenCodeWebSearchHit {
  title: string;
  domain: string;
}

/** The hostname of a URL without a leading `www.`; undefined when unparseable. */
function domainOf(url: string): string | undefined {
  try {
    const host = new URL(url).hostname.replace(/^www\./i, "");
    return host || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Projects OpenCode's `websearch` result onto the official `WebSearch`
 * element's `{ title, domain }` shape.
 *
 * **Observed V2 payload** — the tool `content` array contains a text part whose
 * `text` is a JSON **string**, not an object:
 *
 *   { "search_id": "search_…",
 *     "results": [ { "url": "https://…", "title": "…",
 *                    "publish_date": "2025-03-19" | null,
 *                    "excerpts": [ "…" ] } ] }
 *
 * `state.metadata` carries only `{ provider, truncated }` — **no hits**. (It
 * also never reaches a renderer through the normal projection; see
 * `openCodePatchFromParts`.)
 *
 * Only fields the payload actually has are used: `title` verbatim, and `domain`
 * read out of `url`. A hit missing a usable `title` or `url` is **dropped**
 * rather than given a placeholder — the element's avatar and domain label would
 * otherwise display invented text.
 *
 * @returns The hits; an empty array for a well-formed payload with none; and
 *   `null` when the result is not this shape at all, so the caller keeps the
 *   plain-text fallback.
 */
export function parseOpenCodeWebSearchHits(
  result: unknown,
): OpenCodeWebSearchHit[] | null {
  const text = openCodeResultText(result);
  if (text === null || !text.trim()) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;

  const { results } = parsed as { results?: unknown };
  if (!Array.isArray(results)) return null;

  const hits: OpenCodeWebSearchHit[] = [];
  for (const entry of results) {
    if (entry === null || typeof entry !== "object") continue;
    const { title, url } = entry as { title?: unknown; url?: unknown };
    if (typeof title !== "string" || !title.trim()) continue;
    if (typeof url !== "string") continue;
    const domain = domainOf(url);
    if (!domain) continue;
    hits.push({ title: title.trim(), domain });
  }
  return hits;
}
