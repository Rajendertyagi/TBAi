/**
 * Explicit OpenCode → rich-UI normalization.
 *
 * WHY THIS EXISTS
 * OpenCode's tool arguments are NOT our native tool arguments, and the pinned
 * `@assistant-ui/react-opencode` runtime passes the raw OpenCode `state.input`
 * straight through as `part.args` (`openCodeMessageProjection.js`:
 * `const args = isRecord(state?.input) ? state.input : {}`). So a rich UI
 * written against our own schema renders an empty title, an empty target path
 * and an empty body — strictly worse than the generic fallback, which at least
 * shows the raw JSON.
 *
 * FIELD NAMES ARE TAKEN FROM THE RUNNING SERVER, NOT ASSUMED
 *   - Arguments: `GET /experimental/tool?provider=<p>&model=<m>` on the
 *     OpenCode server returns each tool's JSON schema. That is the authority
 *     for the names in `OPENCODE_ARGS` below.
 *   - Result: a completed part's `state` was observed live (a real `bash`
 *     completion) and is
 *     `{ status, input, output: string, title: string, metadata, time }`.
 *     `output` is a plain STRING. The runtime maps `result: state.output`, so
 *     `part.result` is that string.
 *
 * Version note: this deployment runs OpenCode **1.18.31**, whose
 * `ToolStateCompleted` declares `output` as a REQUIRED string. The installed
 * `@opencode/schema` package is 2.0.4 and describes a *newer, different* shape
 * (no `output` at all), so it must NOT be used as the reference here. Reading
 * it first produced a wrong conclusion; the live probe corrected it.
 *
 * Verified 2026-09-16 against OpenCode 1.18.31.
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
  // OpenCode `bash` : { command, timeout?, workdir? }
  //                                                    -> run_command wants `cwd`
  bash: { workdir: "cwd" },
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

/**
 * Result normalization.
 *
 * Only needed where a rich UI reads a structured field out of the result.
 * OpenCode returns a plain string for every tool observed, so a UI expecting
 * an envelope needs one built here; everything else passes through so the
 * generic string rendering stays intact.
 */
export function normalizeOpenCodeResult(tool: string, result: unknown): unknown {
  if (typeof result !== "string") return result;
  // `ReadFileToolUI` summarizes `(r as any).content`, and OpenCode's `read`
  // returns the file text itself — so wrap it in the envelope the UI reads.
  if (tool === "read") return { content: result };
  // The terminal block renders from `{ stdout, stderr }` (`resultToLines`),
  // while OpenCode's `bash` returns one combined string. Map it to stdout —
  // OpenCode does not separate the two, so splitting them here would be a
  // guess. `exitCode` is left absent on purpose: it lives in the part's
  // `metadata`, which the runtime drops before our UI sees it, and inventing
  // `0` would claim success for a command that failed.
  if (tool === "bash") return { stdout: result };
  return result;
}

/** True when this tool has any normalization at all (used by the guard test). */
export function isNormalizedOpenCodeTool(tool: string): boolean {
  return tool in OPENCODE_ARGS;
}

/**
 * Pull OpenCode's own patch out of the raw tool part for `callId`.
 *
 * WHY THIS READS METADATA, NOT THE RESULT. The plan assumed an `edit` result
 * carries a patch. It does not. Verified across every completed `edit`/`write`
 * part in the local OpenCode database (253 parts):
 *
 *   - `state.output` is ALWAYS one of two human strings —
 *     "Edit applied successfully." / "Wrote file successfully."
 *   - the patch lives in `state.metadata.diff` and `state.metadata.filediff.patch`
 *     (identical strings), alongside `filediff.{file,additions,deletions}`
 *   - **`write` has NO patch at all** (148/148 `edit` parts have one; 0/105
 *     `write` parts do). A whole-file write has nothing to diff against — it
 *     carries `metadata.filepath` + `exists` instead. So this returns null for
 *     `write` by data, not by special-casing.
 *
 * The runtime projection drops `state.metadata` (`mapToolState` maps only
 * `input`→args and `output`→result), but it forwards the untouched parts as
 * message metadata (`metadata.custom.opencode.parts`), so the patch is still
 * reachable from a renderer. `useOpenCodeEditPatch` is that reach.
 *
 * `callId` is the part's `toolCallId`, which the projection derives from
 * OpenCode's `callID` — hence the match on `callID` here.
 */
export function openCodePatchFromParts(
  rawParts: unknown,
  callId: string | undefined,
): string | null {
  if (!callId || !Array.isArray(rawParts)) return null;
  for (const part of rawParts) {
    if (part == null || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    if (p.callID !== callId) continue;
    const metadata = (p.state as Record<string, unknown> | undefined)?.metadata;
    if (metadata == null || typeof metadata !== "object") return null;
    const m = metadata as Record<string, unknown>;
    const filediff = m.filediff as Record<string, unknown> | undefined;
    // `filediff.patch` first: it is the same string as `diff` where both
    // exist, but it is the one that also carries `additions`/`deletions`.
    const patch = filediff?.patch ?? m.diff;
    return typeof patch === "string" && patch.trim() ? patch : null;
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
 * **PROVEN payload** — live probe 2026-09-19 against the managed 1.18.31
 * server. `state.output` is a JSON **string**, not an object:
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
  if (typeof result !== "string" || !result.trim()) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
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
