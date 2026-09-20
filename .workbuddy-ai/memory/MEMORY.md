# ai-chat-app — project conventions

## Verification

- **Never trust an installed package's schema for a running server's shape.**
  Ask the running server. For OpenCode:
  - tool list: `GET /experimental/tool/ids`
  - per-tool arg schemas: `GET /experimental/tool?provider=<p>&model=<m>`
  - live spec: `GET /doc` (OpenAPI)
  `@opencode/schema@2.0.4` described a NEWER shape than the running 1.18.31
  server and led to a wrong "results never arrive" conclusion.
- **Find the managed OpenCode server port** by scanning loopback ports for
  `/config` returning `opencode.ai/config` (it was 63077). `POST /session/{id}/shell`
  creates a real COMPLETED tool part with **no model call** — use it to settle
  result shapes without spending tokens.
- **Browser checks:** `?cb=<n>` on the URL forces a fresh bundle (the plain URL
  serves a cached `index-*.js`). Verify with
  `performance.getEntriesByType('resource')`. Note `agent-browser screenshot`
  frames a smaller viewport (1088) than `agent-browser eval` (1264) — a card can
  be visible to `getBoundingClientRect` yet cropped out of the shot, so check the
  element's own rect before calling a render broken.
- **Never claim a visual result without the user seeing it.**

## Tests

- Full suite — `bun run test` (now green; the script carries `--timeout=30000`).
  Equivalent long form:
  `bun test ./tests ./src ./web/src ./web/tests --path-ignore-patterns "**/shutdown-lifecycle.test.ts" --timeout=30000`
  (repo root; **1343 pass / 2 skip / 0 fail**, 1345 tests / 131 files, 2026-09-20).
  **The `shutdown-lifecycle` ignore is load-bearing:** that test closes the
  shared SQLite handle, and without the ignore every later file fails with
  "Cannot use a closed database" — 194 bogus failures, not a real regression.
- **A `*.test.js` twin of a `*.test.ts` file is collected as a SECOND suite.**
  `bun test ./src` matches both, so every case runs twice; and because
  `tests/setup.ts` gives the whole process ONE SQLite file, a twin that writes
  rows under a fixed literal key (e.g. `todo-test-t1`) leaves them behind for
  the `.ts` file's count assertions → "expected length 1, received 2". 13 such
  twins were deleted on 2026-09-20 (backup: `/tmp/tbai-js-test-twins-backup`).
  If duplicates ever reappear, that is the first thing to check — NOT "load".
  Test-namespace constants must be unique per module instance, not a literal.
- **Test files share ONE process and ONE `globalThis`.** Stubbing `fetch` in a
  web test file races every other file (one file's restore clobbers another's
  stub mid-test). Add a module-level test seam instead of touching the global.
- The `logger` is a process-wide singleton: a test that changes `bufferSize` /
  `fileQueueLimit` / level MUST restore them in `afterEach`, or the caps leak
  into other files.
- `new Headers({...})` THROWS on non-ISO-8859-1 header values (an emoji in a
  test header value fails the test harness, not the code under test).
- **The default 5000ms per-test timeout is too small for this suite.**
  `tests/unit/terminal-runbash.test.ts` takes 2.6–3.4s per test ALONE (~1.5×
  margin) and crosses 5s under the suite's own parallel load. Fixed in the
  SCRIPT (`--timeout=30000` in the `test` script), never by editing tests.
- **Asserting a state machine's terminal state needs a WAIT, not an instant
  check.** `tests/integration/mcp-v2.test.ts` "reconnect cap" asserted
  `status === "error"` right after a window that ends exactly when the final
  (5th) reconnect timer fires — so the last `connect()` was still in flight
  ("connecting") and the test failed intermittently at ~27.5s. Use
  `waitForStatus(...)` before asserting; it is strictly stronger (it fails if
  the state never arrives).
- `web/` has no DOM and no jsdom. Use `renderToStaticMarkup` +
  `createElement` (repo convention: `createElement` in `.ts` files; JSX is NOT
  parsed in `.ts`).
- `renderToStaticMarkup` reads zustand's SERVER snapshot, so a test's
  `markStale` is invisible to the render — guard tests for zustand-backed
  approval state must assert pure functions or scoped source, not renders.
- Guard tests must be **mutation-checked**: break the code, confirm the test
  fails, revert, then `grep -rn "MUTATION"` to prove no probe was left behind.
- Use `web/src/testing/source-scope.ts` (`stripComments`, `functionBody`) for
  scoped source assertions, so a comment cannot satisfy a test for the code it
  describes.

## Architecture

- **The server** (`src/tools/index.ts` → `AISDKToolkit`) is the single authority
  for what the model may call. The client toolkit is **render-only**, so
  registering foreign renderer names (e.g. OpenCode's `read`) is safe.
- `AuiConfig` is scoped to the provider it is passed to. Code mode mounts its own
  `AssistantRuntimeProvider` — it needs its own config or `part.toolUI` resolves
  to nothing and every tool falls back to the generic card.
- Toolkit layout: `nativeToolkit` (15, invariant asserted) + `openCodeToolkit` +
  `appToolkit` (union, what gets registered).
- `display: "standalone"` keeps an approval-gated tool's card out of a collapsed
  group. Mirror the native convention: `write`/`edit`/`run_command` standalone,
  `read`/`search` inline.

## Models / providers (do NOT repeat the "no credit" mistake)

- `GET /config` default is `bai/hy3`, and **`bai` is out of credit**
  (`balance=0`). That is real — but it is **not** the model Code mode uses.
- `GET /provider` returns `{all, default, connected}`;
  `connected: ["google","opencode","openrouter","bai"]`. `opencode` has **free**
  models including `nemotron-3.5-lightning-free`, which is what Code mode
  actually selects.
- **The free model works** (verified: "Reply with exactly: PING" →
  `text="PING"`, `completed=true`). It is slow (~30s trivial reply).
  `mimo-v2.5-free` returns **429 rate limit** — free tier is throttled.
- **The ACTUAL wall (supersedes the tool-stall note below): OpenCode's message-
  creation endpoint `POST /session/{id}/message` is BROKEN in this environment.**
  It returns `500 Unexpected server error` (ref) on a normal payload, then HANGS
  (no response for 3+ min) on retry. `GET` on the same session still works, so the
  server is alive but this write path is wedged. Because no message can be
  created, **neither a real model run NOR a synthetic injection of a completed
  edit part is possible** — this is the true root cause of every "not verified
  live" item in the block-rendering plan.
- **Secondary (now moot unless the endpoint is fixed):** even via `prompt_async`,
  model-requested tool calls stall at `running` with `time:{start}`, no `end`, turn
  `completed=false` (text-only turns complete). `prompt_async` only does a single
  generation step — it does not pump OpenCode's multi-turn agent loop. The app's
  streaming runtime is what drives tool execution + approval; but the app's
  dispatch also fails now because it calls the same broken message endpoint.
- The app's model catalog only exposes `opencode`-free + `bai` models; the
  connected `google` provider is **not** selectable in the UI (so a tool-capable
  Gemini cannot be chosen there). To unblock: repair/restart the OpenCode server
  (or the backend that spawns it) so `POST /session/{id}/message` returns 2xx.
- When checking whether a tool call worked, check the **tool part's**
  `state.status`, not whether the model replied.
- **`POST /session/{id}/prompt_async`** is the prompt route (204 = accepted).
  `POST /session/{id}/prompt` returns SPA HTML — wrong route. Body requires
  `parts`; `model` is `{providerID, modelID}`.
- `POST /session/{id}/shell` creates a real **completed** tool part with no model
  call — the way to exercise completed-state rendering without a model.
- A session must be **linked to an app conversation** to render in the app:
  `GET localhost:3000/api/conversations` maps `id` → `opencodeSessionId`; open at
  `#/chat/<conversationId>`.

## OpenCode integration

- **The runtime projection drops `state.metadata`.** `mapToolState` returns only
  `{args, argsText, result, isError}` (`input`→args, `output`→result). So
  anything OpenCode records in `metadata` (diffs, exit codes, file paths) is
  invisible to a renderer *by the normal route*.
- **But the untouched parts survive as message metadata**
  (`metadata.custom.opencode.parts`), reachable from a renderer via
  `useAuiState((s) => s.message.metadata?.custom?.opencode?.parts)`. That is the
  route to `metadata` data. `ChatWindow` uses the same path for its chips.
- **`useAuiState` THROWS without an `AuiProvider`** ("requires an AuiProvider").
  So any renderer that needs message metadata must be split:
  a **pure view** (data as a prop → unit-testable with no provider) plus a
  **thin registered wrapper** that calls the hook and delegates. Putting the hook
  directly in the renderer breaks every direct-render test.
- **Best source for real OpenCode shapes is its own DB**, far richer than the
  HTTP API: `C:\Users\RTPC\.local\share\opencode\opencode.db` (read-only via
  `bun:sqlite`). `part.data` holds JSON; query with
  `json_extract(data,'$.tool')`, `'$.state.status'`, `'$.state.metadata'`.
  ~1400 sessions / ~2850 tool parts across all projects.
- Recorded facts: an `edit` result is the literal `"Edit applied successfully."`
  and the patch is in `metadata.diff` + `metadata.filediff.patch`. A `write`
  result is `"Wrote file successfully."` with **no patch at all**. `parse-diff`
  (the `DiffViewer` parser) handles OpenCode's `Index:`/`===` git-style header.

