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
 *   - Result: a native V2 completed tool state exposes `content` as an array of
 *     `{ type: "text", text }` parts, and that array is what a renderer
 *     receives: `v2History`/`v2Events` store it as the part's `output` and the
 *     message projection passes `output` through as the tool part's `result`.
 *     It is normalized only at the renderer boundary, for the shared rich-UI
 *     contracts.
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

/** Display text of a native V2 content array, or `null` when it carries none. */
function toolContentText(content: readonly ToolContent[]): string | null {
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
 * Object fields a tool result may carry its text in.
 *
 * `content` is both the native V2 envelope and `read`'s normalized shape;
 * `stdout` is `bash`/`shell`'s (the terminal block reads it). A renderer only
 * ever sees the NORMALIZED result, so the shared extractor — not each
 * renderer — has to know how to read every shape this module produces.
 */
const RESULT_TEXT_FIELDS = ["content", "stdout"] as const;

/**
 * What a settled tool result actually IS, once decoded.
 *
 * This type exists because "no text" was two different facts sharing one
 * `null`, and a renderer could not tell them apart:
 *
 *   - `empty`      the tool ran and produced nothing. "No output." is the
 *                  honest label for this.
 *   - `unreadable` the tool produced something this module cannot decode into
 *                  text. "No output." would then be a false claim about the
 *                  tool AND a silent failure about the card.
 *
 * WHAT THE LIVE SERVER ACTUALLY SENDS (v2.0.15,
 * `GET /api/session/<id>/message` over every session in the store on
 * 2026-09-28; 1 707 tool parts, none invented):
 *
 *   - 1 667 `completed` parts. Their `content` is ALWAYS an array of
 *     `{type:"text",text}` (1 808 items) or `{type:"file",uri,mime,name}`
 *     (35 items, all `read` of a binary). No completed part in the store had
 *     a missing, non-array, or empty `content`, and no text item was blank, so
 *     every observed completed result decodes to `text`.
 *   - 40 `error` parts. EVERY one is exactly
 *     `{ status:"error", input, error:{type,message} }` with NO `content` key
 *     at all — 40 of 40, so "a failed tool also returns partial output" has
 *     never happened here. `v2History`/`v2Events` turn that into
 *     `output = { error, type }`, which is what a renderer receives. That
 *     envelope carries no text field, so the previous text-only extractor
 *     returned `null` for it — the exact mechanism behind a FAILED tool being
 *     labelled "No output." with no failure marker.
 *   - A `read` of a binary file returns a `file` item, and `toolContentText`
 *     reads its `name` (the path), so it decodes to `text`, not `unreadable`.
 */
export type OpenCodeResultBody =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "empty" }
  | { readonly kind: "unreadable" };

/** The content array of a result, or `undefined` when it carries none. */
function contentArrayOf(result: unknown): readonly unknown[] | undefined {
  if (Array.isArray(result)) return result;
  if (result !== null && typeof result === "object") {
    const content = (result as Readonly<Record<string, unknown>>).content;
    if (Array.isArray(content)) return content;
  }
  return undefined;
}

/**
 * Decodes a settled tool result into what it IS: text, genuinely empty, or
 * present-but-undecodable.
 *
 * ONE decoder, so the two meanings of "no text" cannot collapse back into a
 * single `null` in a caller. {@link openCodeResultText} is the text-only
 * projection of it.
 *
 * `empty` is reserved for shapes that are well-formed and carry nothing: an
 * absent result, an empty string, an empty content array, a content array
 * whose every part is blank text, and a `{ content: "" }` / `{ stdout: "" }`
 * envelope. Everything else that is not decodable text — a non-string in a
 * text field, a content array holding something that is not a text or file
 * part, the `{ error, type }` envelope — is `unreadable`.
 *
 * @returns The classification. Total: never throws, for any input.
 */
export function classifyOpenCodeResultBody(result: unknown): OpenCodeResultBody {
  if (result === null || result === undefined) return { kind: "empty" };
  if (typeof result === "string") {
    return result.trim() === "" ? { kind: "empty" } : { kind: "text", text: result };
  }
  if (typeof result !== "object") return { kind: "unreadable" };

  // The server's own envelope: a native content array, bare or wrapped.
  const content = contentArrayOf(result);
  if (content !== undefined) {
    if (content.length === 0) return { kind: "empty" };
    const decoded = toolContentArray(content);
    if (decoded === null) return { kind: "unreadable" };
    const text = toolContentText(decoded);
    return text === null ? { kind: "empty" } : { kind: "text", text };
  }

  // A plain object. A text field is either the text, an empty result, or a
  // shape this module has no reader for.
  const record = result as Readonly<Record<string, unknown>>;
  for (const field of RESULT_TEXT_FIELDS) {
    if (!(field in record)) continue;
    const value = record[field];
    if (typeof value === "string") {
      return value.trim() === "" ? { kind: "empty" } : { kind: "text", text: value };
    }
    if (value !== undefined && value !== null) return { kind: "unreadable" };
  }
  // No text field at all: the `{ error, type }` envelope, and every other
  // structured payload this module has no reader for.
  return { kind: "unreadable" };
}

/**
 * Extracts the display text of a tool result, in any encoding it can arrive in.
 *
 * Accepts the native V2 content array (bare or inside a `{ content }`
 * envelope), the plain string `normalizeOpenCodeResult` returns for most
 * tools, and the `{ content }` / `{ stdout }` shapes it returns for `read` and
 * `bash`/`shell`. That makes normalization lossless for text:
 * `openCodeResultText(normalizeOpenCodeResult(tool, result))` equals
 * `openCodeResultText(result)` for every tool, which is what each renderer
 * relies on when it reads the body of a settled result.
 *
 * @returns The text, or `null` when the result carries none. Callers that must
 *   distinguish "the tool returned nothing" from "this card cannot read the
 *   result" use {@link classifyOpenCodeResultBody} instead — a card must never
 *   present an undecodable result as "no output".
 */
export function openCodeResultText(result: unknown): string | null {
  const body = classifyOpenCodeResultBody(result);
  return body.kind === "text" ? body.text : null;
}

/** True when a result object already carries a native V2 content array. */
function isNativeContentEnvelope(result: unknown): boolean {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return false;
  return toolContentArray((result as Readonly<Record<string, unknown>>).content) !== null;
}

/**
 * Result normalization.
 *
 * Only needed where a rich UI reads a structured field out of the result.
 * A native V2 content array is normalized at this boundary; every other value
 * passes through so the generic renderer keeps the original structured value.
 *
 * Reads text from the content array only — never from a plain string or a
 * `{ content: string }` envelope — so a non-native value is never re-wrapped
 * and calling this twice on the same value is a no-op.
 */
export function normalizeOpenCodeResult(tool: string, result: unknown): unknown {
  // An object that already holds a native content array IS the rich UI's own
  // envelope; leave it (and its other fields) alone.
  if (isNativeContentEnvelope(result)) return result;
  const content = toolContentArray(result);
  if (content === null) return result;
  const text = toolContentText(content);
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
 * Prefix of the assistant-ui tool-call id the V2 projection derives
 * (`deriveV2ToolCallId`). A call id carrying it is that prefix followed by a
 * URL-encoded `"<messageId>:<toolId>"`, so the official part id is the last
 * `:`-segment of it. Named here rather than inlined because two readers in
 * this module recover the same id from the same string.
 */
const DERIVED_CALL_ID_PREFIX = "tbai-v2-tool:";

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
 * part's `id`; `rawPartForCallId` recovers that official id.
 */
export function openCodePatchFromParts(
  rawParts: unknown,
  callId: string | undefined,
): string | null {
  const metadata = rawPartMetadata(rawPartForCallId(rawParts, callId));
  if (metadata === null) return null;
  const files = metadata.files;
  if (!Array.isArray(files)) return null;
  const file = files.find((entry): entry is { patch: string } =>
    entry !== null &&
    typeof entry === "object" &&
    typeof (entry as { patch?: unknown }).patch === "string",
  );
  return typeof file?.patch === "string" && file.patch.trim() ? file.patch : null;
}

/**
 * The one raw V2 tool part a given assistant-ui `callId` refers to.
 *
 * The id match is the join key every parts reader in this module needs — the
 * patch and the web-search provider are each read out of the part THIS call
 * produced, out of a message that holds many. It lives in one function so a
 * second reader cannot drift from the first on how that id is recovered.
 *
 * @returns The matching part, or `null` when there is no `callId`, no part
 *   array, or no part carrying that id. Non-object entries are skipped rather
 *   than thrown on.
 */
function rawPartForCallId(
  rawParts: unknown,
  callId: string | undefined,
): Record<string, unknown> | null {
  if (!callId || !Array.isArray(rawParts)) return null;
  const suffix = callId.startsWith(DERIVED_CALL_ID_PREFIX)
    ? decodeURIComponent(callId.slice(callId.lastIndexOf(":") + 1))
    : callId;
  for (const part of rawParts) {
    if (part == null || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    if (p.id === suffix) return p;
  }
  return null;
}

/** A raw tool part's own `state.metadata`, or `null` when it carries none. */
function rawPartMetadata(
  part: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (part === null) return null;
  const state = part.state as Record<string, unknown> | undefined;
  const metadata = state?.metadata;
  if (metadata == null || typeof metadata !== "object") return null;
  return metadata as Record<string, unknown>;
}

/**
 * The search provider that answered an OpenCode `websearch` call, or `null`.
 *
 * WHAT THE SERVER SENDS. `state.metadata` of a completed `websearch` part is
 * exactly two keys, read from all 8 `websearch` calls in the live store on
 * 2026-09-28 — 3 of them here, the other two in
 * `@/testing/websearch-payloads`:
 *
 *   {"provider":"exa","truncated":false}
 *   {"provider":"parallel","truncated":false}
 *   {"provider":"tinyfish","truncated":false}
 *
 * `provider` was present on 8 of 8, but one store is not a promise, so absence
 * is a `null` the caller degrades on — never an empty or "unknown" label. The
 * result document itself carries no trace of who answered and the official
 * `WebSearch` element has no field for it, so `state.metadata.provider` is the
 * only place this answer exists and this is the only place that reads it.
 *
 * `truncated` is the other key and is deliberately NOT rendered: it was `false`
 * on 8 of 8, so no capture in this app has ever seen a truncated search, and a
 * flag nobody has watched flip is not yet a fact worth showing.
 *
 * @returns The provider name exactly as the server wrote it, or `null` when
 *   there is no part for `callId`, no `state.metadata`, or no non-blank string
 *   `provider` (absent, or of another type).
 */
export function openCodeWebSearchProviderFromParts(
  rawParts: unknown,
  callId: string | undefined,
): string | null {
  const provider = rawPartMetadata(rawPartForCallId(rawParts, callId))?.provider;
  if (typeof provider !== "string") return null;
  const name = provider.trim();
  return name.length > 0 ? name : null;
}

/**
 * What the reader answered an OpenCode `question` call, per question.
 *
 * WHERE THIS COMES FROM — a real capture, not a guess. Read back from
 * `GET /api/session/<id>/message` on the live server (v2.0.15) AFTER the reply
 * was accepted, a completed `question` part carries exactly two metadata keys:
 *
 *   {"answers":[["Postgres"]],"truncated":false}
 *
 * The sibling `state.content` text is a natural-language echo
 * (`User has answered your questions: "…?"="Postgres". You can now continue…`),
 * which would have to be parsed to recover a value; `answers` is already the
 * keyed structure, so it is the only place this is read from.
 *
 * WHY THIS ROUTE AND NOT THE FORM ENDPOINT. `GET /api/session/<id>/form/<fid>`
 * also returns `{ status:"answered", answer:{…} }` (`Form.State`), but the card
 * has no form id: the answered form is dropped from the thread's form list, and
 * nothing links a settled card back to one. `state.metadata.answers` is on the
 * tool part itself, which is exactly what the history read restores — so the
 * answer is on the card after a reload, not only while the session is live.
 *
 * @returns The answers, outer array indexed by question; `null` when the part
 *   is not an answered `question` call or carries no well-formed `answers`.
 */
export function openCodeQuestionAnswersFromParts(
  rawParts: unknown,
  callId: string | undefined,
): readonly (readonly string[])[] | null {
  const metadata = rawPartMetadata(rawPartForCallId(rawParts, callId));
  if (metadata === null) return null;
  const answers = metadata.answers;
  if (!Array.isArray(answers)) return null;
  // A non-string, or a non-array entry, means the shape is not what the capture
  // shows — so it is dropped rather than rendered as `undefined`.
  if (!answers.every((entry) => Array.isArray(entry) && entry.every((item) => typeof item === "string"))) {
    return null;
  }
  return answers as readonly (readonly string[])[];
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
 * One search hit as the OpenCode document writes it: an ATX heading that is a
 * markdown link, `## [title](url)`.
 *
 * Keyed on the LINK, not on `##` alone, because a provider's snippet can
 * contain markdown headings of its own (a captured `tavily` snippet contains
 * both `## 1000+ packages found` and `### codemirror-spell-checker`). The title
 * is matched greedily up to the LAST `](` so a title that itself contains
 * brackets survives — a captured `exa` hit is
 * `## [[Feature]: Add option to change spellchecking method · Issue #4840 · …]`.
 *
 * Known limit: a snippet that quotes a whole `## [text](https://…)` line would
 * still read as a hit. No capture does that, and the document carries nothing
 * that tells the two apart, so the ambiguity is recorded rather than guessed at.
 */
const HIT_HEADING = /^##\s+\[(.*)\]\((.*)\)\s*$/;

/**
 * Projects an OpenCode `websearch` result onto the official `WebSearch`
 * element's `{ title, domain }` shape.
 *
 * **Observed V2 payload — a MARKDOWN DOCUMENT, not JSON.** A completed tool
 * state carries `content: [{ type: "text", text }]`, and that text is a list of
 * hits, each an ATX heading followed by the provider's own snippet lines:
 *
 *   ## [Bun — A fast all-in-one JavaScript runtime](https://bun.com/)
 *
 *   NEWBun v1.4.2 released→ Bun is a fast JavaScript runtime & toolkit. …
 *
 * `JSON.parse` on that document throws, which is how this function used to
 * report "no hits" for every real search.
 *
 * The number of snippet lines per hit is PROVIDER-DEPENDENT and is not parsed
 * at all: a hit runs from its heading to the next hit heading, so the document
 * is one flat scan for headings and everything between them is skipped. Nothing
 * is lost by skipping — the element renders `title` + `domain` only, and the
 * untouched document is shown beneath it.
 *
 * Captured shapes (verbatim fixtures + session ids in
 * `@/testing/websearch-payloads`):
 *   - `tinyfish`  heading, blank line, one snippet line
 *   - `parallel`  heading, blank line, several snippet lines
 *   - `exa`       heading, `Published: <ISO timestamp>`, blank line, snippets
 *   - `tavily`    heading, blank line, snippets containing their own headings
 *   - `firecrawl` no document at all — the single line
 *                 `No search results found. Please try a different query.`
 *
 * `domain` is read from the hit's own `url`, so a hit whose link is not a URL is
 * **dropped** rather than given a placeholder — the element's avatar and domain
 * label would otherwise display invented text. Dropping it also means a
 * snippet's own relative markdown link cannot become a row.
 *
 * @returns The hits; `[]` when the document IS this shape but no hit is
 *   usable; and `null` when it is not this shape at all, so the caller keeps
 *   the plain-text fallback instead of reporting a source count it never read.
 */
export function parseOpenCodeWebSearchHits(
  result: unknown,
): OpenCodeWebSearchHit[] | null {
  const text = openCodeResultText(result);
  if (text === null || !text.trim()) return null;

  const hits: OpenCodeWebSearchHit[] = [];
  let sawHeading = false;
  for (const line of text.split("\n")) {
    const heading = HIT_HEADING.exec(line.trim());
    if (heading === null) continue;
    sawHeading = true;
    const [, rawTitle, rawUrl] = heading;
    const title = rawTitle.trim();
    if (!title) continue;
    const domain = domainOf(rawUrl.trim());
    if (!domain) continue;
    hits.push({ title, domain });
  }
  return sawHeading ? hits : null;
}
