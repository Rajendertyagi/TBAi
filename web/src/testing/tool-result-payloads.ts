/**
 * REAL OpenCode tool-result payloads, captured verbatim.
 *
 * ## Where these come from
 *
 * `GET http://localhost:3001/api/opencode/session/<id>/message` — TBAi's
 * already-authenticated reverse proxy to the managed `opencode serve` process
 * (v2.0.15, pid 12664), read on 2026-09-28. Every session in the store was
 * walked; nothing here is invented or hand-shaped.
 *
 * ## What the whole store contained
 *
 * 1 707 tool parts across every session:
 *
 *   - **1 667 `completed`.** `state.content` was an array in EVERY one. The
 *     items were `{type:"text",text}` (1 808 of them) or
 *     `{type:"file",uri,mime,name}` (35 of them, every one a `read` of a
 *     binary image). No completed part had a missing, non-array, or EMPTY
 *     `content`; no text item was blank. So no genuinely-empty completed
 *     result exists in this store — the "No output." path is reachable only
 *     from the shapes asserted below, which is exactly why it needed a name.
 *   - **40 `error`.** EVERY one is `{ status, input, error: { type, message } }`
 *     with **no `content` key at all** (40 of 40). Three tools produced them:
 *     `edit` (18), `grep` (8), `webfetch` (5), `subagent` (3), `read` (2),
 *     `shell` (2), `execute` (1), `opencode` (1).
 *   - **2 `running`** — a live turn, no settled result.
 *
 * ## The two states these fixtures exist to pin
 *
 * `web/src/tools/opencode/adapt.ts` turns a failed part into the renderer's
 * `result` as `{ error, type }` (this is `v2History`/`v2Events`; see
 * `v2MessageProjection.ts`, which passes `output` through as `result` and sets
 * `isError: part.status === "error"`). That envelope has **no text field**, so
 * the previous text-only extractor returned `null` for it and `TextBody`
 * printed "No output." — a FAILED tool rendered as a successful empty one, with
 * no failure marker at all. That is the reported defect, and
 * `capturedErrorEnvelopeOutput` is the real payload behind it.
 */

/**
 * A completed `read` of a text file, verbatim: the native V2 content array
 * (NOT wrapped in `{ content }` — `v2History` sets `output` to the array and
 * the projection passes it straight through).
 */
export const capturedReadCompletedContent = [
  { type: "text", text: "Read file D:\\ws\\notes.txt, lines 1-3\n1: alpha\n2: beta\n3: gamma\n" },
] as const;

/**
 * A completed `read` of a BINARY file, verbatim except that the `uri` is
 * truncated here: the real value is a ~160 KB `data:image/jpeg;base64,…` string
 * and nothing downstream reads it (`toolContentText` takes the item's `name`).
 * Kept because this shape is the reason a binary read is NOT "unreadable" —
 * the card can name the file it got.
 */
export const capturedBinaryReadContent = [
  {
    type: "file",
    uri: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD<...truncated...>",
    mime: "image/jpeg",
    name: "D:\\Temp\\ai-chat-app\\docs\\tool-ui-atlas\\causeC-2-answer-on-card.jpg",
  },
] as const;

/**
 * A FAILED `edit`, exactly as the server sent it: `status: "error"`, an
 * `error` object, and NO `content` key. Captured from
 * `ses_f1bba25f6ffeli7WZzN4e1qI5D`.
 */
export const capturedEditErrorPart = {
  type: "tool",
  id: "call_function_w2fg68aa5pdc_1",
  name: "edit",
  executed: false,
  state: {
    status: "error",
    input: {
      path: "D:\\Temp\\ai-chat-app\\web\\src\\testing\\websearch-payloads.ts",
      newString: "To install a specific version, pass the git tag to the install script:",
      oldString: "To install a specific version, pass the git tag to the install script:",
    },
    error: {
      type: "tool.execution",
      message: "No changes to apply: oldString and newString are identical.",
    },
  },
} as const;

/**
 * A FAILED `read` of a missing file — the exact case in the bug report.
 * Captured from `ses_f1b13674cffeZM7gE7X7iVVncI` (one of 2 `read` errors).
 */
export const capturedReadErrorPart = {
  type: "tool",
  id: "call_function_read_missing",
  name: "read",
  executed: false,
  state: {
    status: "error",
    input: {
      path: "C:\\Users\\RTPC\\AppData\\Local\\Temp\\opencode\\col-study\\node_modules\\micromark-extension-directive\\lib\\index.js",
    },
    error: {
      type: "tool.execution",
      message:
        "File not found: C:\\Users\\RTPC\\AppData\\Local\\Temp\\opencode\\col-study\\node_modules\\micromark-extension-directive\\lib\\index.js",
    },
  },
} as const;

/**
 * A FAILED `webfetch` (a non-2xx status), verbatim. Its `error.type` is
 * `"unknown"` rather than `"tool.execution"`, which is why the type field can
 * never be used to tell one failure shape from another. Captured from
 * `ses_f1b13674cffeZM7gE7X7iVVncI` (one of 5 `webfetch` errors).
 */
export const capturedWebFetchErrorPart = {
  type: "tool",
  id: "call_function_o0ke5mz41mcb_1",
  name: "webfetch",
  executed: false,
  state: {
    status: "error",
    input: { url: "https://developer.chrome.com/docs/devtools/css/track-usage" },
    error: {
      type: "unknown",
      message:
        "StatusCode: non 2xx status code (404 GET https://developer.chrome.com/docs/devtools/css/track-usage)",
    },
  },
} as const;

/**
 * The renderer's `result` for a failed part: exactly what `v2History` /
 * `v2Events` build, and what `v2MessageProjection` then hands the card.
 *
 *   { error: <message>, type: <error.type>, ...(content ? { content } : {}) }
 *
 * The failed parts in this store carried no `content`, so the envelope is two
 * keys — and it has no `content`/`stdout` text field, which is the whole
 * reason a text-only extractor cannot see it.
 */
export const capturedErrorEnvelopeOutput = {
  error: capturedReadErrorPart.state.error.message,
  type: capturedReadErrorPart.state.error.type,
} as const;

/** Same envelope, from the `webfetch` failure. */
export const capturedWebFetchErrorOutput = {
  error: capturedWebFetchErrorPart.state.error.message,
  type: capturedWebFetchErrorPart.state.error.type,
} as const;

/** The part id used by the projection to derive an assistant-ui `toolCallId`. */
export const CAPTURED_ERROR_PART_ID = capturedReadErrorPart.id;
