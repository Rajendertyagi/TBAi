# Logging Charter

The law for all logging in TBAi. Code follows this doc, not the reverse.

## 1. The funnel rule (hard architectural rule)

**Every operational event has exactly one owning funnel. Lower layers must not
re-log the same event.** A route handler, a `runX` tool function, and a storage
helper never emit lifecycle logs — their funnel does.

| Funnel | Owns | Lives in |
|---|---|---|
| HTTP edge | every request lifecycle + every failed response (`http.request_start`, `http.request`, `http.error`) | `src/routes/index.ts` middleware + `onError` |
| Client ingest | every browser event's admission into the pipeline (`plane: "client"`) | `src/routes/logs.ts` (`POST /api/logs/client`) |
| AI funnel | stream lifecycle (`ai.request`, `ai.response`, `ai.error`) | boundary emitters in the chat route (scheduler runs are covered by `scheduler.run`, which owns that lifecycle; a shared `streamChat` wrapper waits for a third `streamText` site) |
| Tool funnel | every tool call (`tool.start`, `tool.finish`, `tool.error`) | single wrapper at the `tool()` registration sites |
| Scheduler funnel | run lifecycle (`scheduler.run`) | `fireJob` |
| Credential funnel | credential failures (`credential.error`) | inside `CredentialStore` methods |
| MCP funnel | server operations (`mcp.operation`) | `mcpManager` connect/operate paths |

The **frontend plane** is not a second system: the browser logger batches into
the same pipeline through the client ingest funnel, so a browser line and a
backend line for the same operation sit in one timeline, ordered by `ts` and
joined by `operationId`. Browser events carry `plane: "client"`; `clientTs` is
the client clock and `ts` the server receipt time, so ordering never has to
guess which clock a field is on.

Unique domain information may still be logged at the site that owns it — but
never a duplicate lifecycle event. When in doubt, don't log: the edge and the
funnel already covered it.

## 2. Correlation identity

```ts
operationId     // ONE user action — minted by the FRONTEND, sent on
                // X-TBAI-Operation-ID, stable for the whole action. A single
                // action (send a prompt, open a Code session) fans out into
                // several requests: they share operationId, each keeps its own
                // requestId. Absent when no user action is behind the request.
requestId       // every request (middleware binds; echoes x-request-id)
conversationId  // chat + job conversations (route / fireJob bind)
threadId        // the runtime thread a chat line belongs to
clientRequestId // draft-materialization idempotency key (draft funnel binds)
streamId        // server-owned chat run (chat route binds)
sessionId       // OpenCode session
toolCallId      // tool funnel binds
jobId           // fireJob binds
providerId      // AI funnel / scheduler binds
modelId         // AI funnel / scheduler binds
```

Correlation only — never a dumping ground. `operationId` is the only id not
minted by this process; the rest are bound where they are known. New fields
require a demonstrated funnel need, recorded here first. `emit()` inherits all
of them from the ambient context (`CORRELATION_KEYS`), and explicit fields
always win.

### 2.1 Ordering

`ts` (epoch ms) is the machine-readable ordering key; `time` is the local human
string for the console, and the file sink writes a UTC ISO-8601 `time`. Use
`ts` — never `time` — to order or join entries across sinks. Client events
carry `clientTs` for their own clock; clock skew between browser and server is
not corrected, so cross-plane ordering is approximate by construction.

## 3. Event taxonomy

Small closed set. New events require a charter entry — subsystems do not invent
naming styles.

| Event | Scope | When | Key fields |
|---|---|---|---|
| `http.request_start` | `http` | a meaningful request begins (assets, health/metrics probes, high-frequency polls, and the log viewer's own stream are excluded) | method/path in `message` |
| `http.request` | `http` | request completes < 400 | method/path in `message`, `statusCode`, `durationMs` |
| `http.error` | `http` | response ≥ 400 or thrown error | `statusCode`, `category`, `retryable`, `message` |
| `ai.request` | `ai` | stream starts | `provider`, `model`, `endpointConfigured`, `protocol`, `maxRetries`, `streamRetries` |
| `ai.run_detached` | `ai` | client connection dropped, run continues | `streamId`, `threadId`, `reason`, `elapsedMs`, `chunkCount` |
| `ai.stream_recovered` | `ai` | boot settles resumable streams orphaned by a previous process | `signal`, `scanned`, `interrupted`, `streamIds` (ids only — never chunk bytes or provider text) |
| `ai.stream_cleanup` / `ai.stream_cleanup_failed` / `ai.stream_cleanup_stopped` | `ai` | periodic reclamation of expired terminal resumable streams | `signal`, `scanned`, `deleted`, `skippedStreaming`, `failures`, `deletedChunks` (counts only) |
| `ai.response` | `ai` | stream finishes successfully | `provider`, `model`, `outcome`, `runStatus`, `finishReason`, `durationMs`, `chunkCount`, `totalTokens` |
| `ai.error` | `ai` | stream/provider/test fails | classification fields + `provider`; never raw provider text |
| `ai.run_detached` | `ai` | connection dropped while the server run continues | `streamId`, `reason` (`connection-closed`/`read-error`), timings |
| `tool.start` | `tool` | tool call begins | `tool`, `conversationId`, + `mcpServer` for remote tools |
| `tool.finish` | `tool` | tool call succeeds | `tool`, `durationMs` |
| `tool.error` | `tool` | tool call fails | `tool`, `durationMs`, classification fields |
| `scheduler.run` | `scheduler` | run lifecycle | `outcome`: started/finished/failed/missed/skipped/cancelled/retried, `jobId`, `runId` |
| `scheduler.admin` | `scheduler` | job created/updated/deleted/enabled/disabled/cancel_requested | `action`, `jobId` |
| `scheduler.maintenance` | `scheduler` | boot recovery, GC | `phase`, report counters |
| `credential.error` | `credential` | decrypt/get/store failure (never key material) | classification fields |
| `mcp.operation` | `mcp` | connect/disconnect/reconnect/roots/sampling/elicitation/resource/prompt/test | `op`, `outcome`, `mcpServer` |
| `conversation.materialize` | `conversations` | a draft became a row (or an idempotent replay of one) | `conversationId`, `engine`, `workspaceMode`, `providerConfigured`, `modelConfigured`, `replayed` |
| `conversation.open` | `conversations` | a conversation row was read (debug — this route is also the existence probe every surface mounts with) | `conversationId`, `engine` |
| `conversation.update` | `conversations` | a PATCH landed | `conversationId`, `fields` (NAMES only, never values), `engine`, `status` |
| `conversation.delete` | `conversations` | a conversation was torn down | `conversationId`, `deleted` (whether a row existed), `engine` |
| `scope.throttled` | emitting scope | throttle engage/disengage (governance marker, never silent) | `engaged`, `dropped`, `budgetPerSec` |

### 3.1 Client lifecycle events (scope `chat` / `opencode` / `app` / `availability` / `approval`)

These exist so ONE user operation can be reconstructed end to end. They are
`info` (they reach the backend in production; `debug` never leaves the browser
there) and never carry prompt text, model output, or answer content.

| Event | Scope | When | Key fields |
|---|---|---|---|
| `send.start` / `send.stream_end` / `send.failed` | `chat` | a chat send opens / ends / errors | lifecycle fields plus `kind`/`errorType` on failure; never raw error text |
| `send.redirected_to_opencode` | `chat` | a first send is routed to the Code surface instead | `threadId` |
| `request_sent` / `request_completed` / `request_failed` | `chat` | browser half of the request pair | `path` (never the query string), `status`, `durationMs` |
| `chat_request_rejected` | `chat` | Direct envelope/message boundary rejects a request | `requestId`, `conversationId`, `reason`, safe classification fields |
| `draft.snapshot` / `draft.materialize_start` / `draft.materialized` / `draft.materialize_failed` | `chat` | engine decision → row created (or not) | `engine`, `workspaceMode`, `clientRequestId`, `conversationId` |
| `run.cancel_requested` / `run.cancel_rejected` | `chat` | explicit cancel of a server-owned run | `streamId`, `status` |
| `handoff.start` / `handoff.accepted` / `handoff.failed` / `handoff.not_bound` | `opencode` | first-prompt handoff lifecycle | `conversationId`, `sessionId`, `boundSessionId` |
| `command.feed_loaded` / `command.feed_failed` | `opencode` | the OpenCode command feed arrived / did not (the previous list is retained on failure) | `count`, `skills`, `status`, `retained` |
| `command.selected` | `opencode` | a `/` command was picked from the composer palette | `name`, `source` (NAMES only — never the template or arguments) |
| `command.compact_started` / `command.compact_completed` / `command.compact_failed` | `opencode` | built-in `/compact` summarize lifecycle (server confirms; failure never claims success) | `ocSession`, `provider`, `model`, `hasDirectory`, `status`, `elapsedMs` (ids/metadata only — never prompt text or message content) |
| `route.change` | `app` | the active surface changed | `from`, `to` (pathname only) |
| `runtime.mount` / `runtime.unmount` | `app` | a shell's runtime came up / went away | `shell` (`chat`/`code`) |
| `runtime.bind` | `app` | the runtime reported the thread it bound | `threadId` |
| `tab.open` / `tab.activate` / `tab.close` | `chat` | open-tab layout changed | `kind`, `threadId`/`conversationId`, `tabKey`, `nextActiveKey`, `closedCount` |
| `conversation.draft_resolved` | `chat` | a draft tab became a persisted conversation | `conversationId`, `engine` |
| `navigation.redirect` / `navigation.rejected` | `app` | a route→tab binding moved the surface / declined to act | `ref`, `to`, `pathname`, `reason` |
| `window_error` / `unhandled_rejection` / `boundary_error` | `app` | genuine browser/React failures | `message`, `errorType`, `stack` (bounded 500), `source`/`line`/`column`, `route` |
| `browser_layout_diagnostic` | `app` | the EXACT ResizeObserver delivery notice (see §3.2) | same fields, recorded at `warn` |
| `state.change` / `recovery` | `availability` | reachability transition / epoch bump | `from`, `to`, `reason`, `recoveryEpoch` |
| `decision.submitted` / `decision.accepted` / `decision.failed` | `approval` | a tool approval was answered | `tool`, `approved`, `optionId`, `automatic` |
| `question.submitted` / `question.accepted` / `question.failed` / `question.dismissed` | `approval` | a question form was answered / dismissed | `questionCount`, `answeredCount` (counts only) |

Reading the tab/navigation events:

- **`tab.close` has two shapes.** Closing by key (the user closing one tab)
  carries `tabKey`, plus `nextActiveKey` only when that tab was active. Closing
  by conversation (`closeByRef`, the delete path) carries `conversationId` and
  `closedCount` — one line per delete, covering every tab the conversation owned
  on both engine surfaces, not one line per tab.
- **`navigation.rejected` is not an error.** It records that an async completion
  (existence validation, engine reconciliation) landed after the route had moved
  on, so it declined to rewrite navigation. `reason` names the guard that fired:
  `stale-engine-reconciliation` or `stale-not-found`. `navigation.redirect`
  carries either `engine-surface-mismatch` (the row's engine disagreed with the
  route, so the surface follows the row) or `conversation-not-found` (confirmed
  404 → fall back to the draft).
- **`tab.activate` fires only on an actual change**, so re-selecting the active
  tab is silent — the caller skips navigation for it too, which is what keeps
  back/forward free of duplicate entries.
- **The invariants these events exist to prove:** a persisted conversation id
  names exactly one conversation; opening it repeatedly converges on one tab per
  surface (compared by conversation id, never by object identity); a draft is
  not a conversation until the backend's `conversation.materialize` or the
  client's `conversation.draft_resolved` says so; and a deleted conversation
  never becomes active again — a late validation cannot resurrect it.

### 3.2 The send operation's lifetime (why `send.stream_end` is guaranteed)

A send's `operationId` is bounded by the **response bodies the send causes**, not
by a variable nobody owns. Every chat-transport response passes through
`observeBodySettled`, and when a body settles — fully read, errored, or
cancelled — the operation it belonged to ends (`outcome=stream-settled`).

This is load-bearing. The stream markers the transport sniffs (`finish` /
`abort` / `error`) only appear if the body is read to the END, so a cancelled or
abandoned stream (a Stop, a route change, a replaced transport) never delivers
one. Before this guarantee, a finished send stayed "current" indefinitely and
its `operationId` was attached to unrelated later browser errors — observed live
as a ResizeObserver notice on `/logs` inheriting a send's id 27 seconds after
that send had completed.

Two further rules keep the id honest:
- a **continuation** (tool result / approval resend) re-opens the SAME id, so one
  logical send stays one operation across round trips;
- a **superseded** response settling late cannot end the operation that replaced
  it (the settle carries the id it was issued under).

### 3.3 Browser layout diagnostics

`browser_layout_diagnostic` exists for exactly one class of message: the
browser's own ResizeObserver delivery notice ("ResizeObserver loop completed with
undelivered notifications." / "ResizeObserver loop limit exceeded"). It is a
*timing* notice about the observer delivery cycle, not a thrown exception.

The match is **exact**, deliberately: `Uncaught Error: ResizeObserver loop…`, any
longer app-authored message, and every other error remain `window_error` /
`unhandled_rejection` at `error`. A blanket "ignore ResizeObserver" rule would
also hide a real feedback loop introduced later. Metadata (message, source,
line, column, route) is preserved so an unexpected layout problem stays
diagnosable.

Established one-off diagnostic events (`server.started`, `db.*`, `workspace.gc_*`,
`chat` prune lines) keep their names — they predate the taxonomy, don't collide
with any funnel, and renaming them buys nothing. Success audit lines live only
where the taxonomy allows (`scheduler.admin`); routine success is not logged.

## 4. Error classification (shared, once)

`src/lib/errors.ts#classifyError` is the single classifier. It produces
`{category, statusCode, provider, retryable, errorType, message}` from any
thrown value. Consumers:

- logging: log fields (redacted at the sink, never before — classification must
  see the raw text to categorize correctly);
- user copy: `sanitizeStreamError` switches on `category`, never re-regexes;
- retry policy: `isRetryableError` delegates, plus one documented divergence —
  raw transport aborts are retried by the scheduler while classification marks
  them `cancelled` (user cancellation is forced non-retryable by the caller's
  `aborted` flag instead).

Categories: `cancelled`, `auth`, `rate_limit`, `network`, `timeout`,
`validation`, `config`, `tool`, `provider`, `database`, `lifecycle`, `runtime`,
`transport`, `unknown`. Retryable: `rate_limit`, `network`, `timeout`, or any
5xx. Everything else is terminal.

**Widening the vocabulary must not move the policy.** `retryable` is computed
from the COARSE category (the pre-existing rule); the refined label is applied
afterwards and only to the two over-wide buckets (`config`, `unknown`). So
adding a category can never change retry behavior, and no consumer switch had to
gain a case: a refined category renders the same user copy it did before.

Provider billing/credit failures are deliberately a **flag**, not a category:
`billing: true` marks a credit/quota condition while the category and retry
policy stay exactly as they were. Reclassifying them would silently change retry
behavior, which is not an observability change.

## 5. Emission rules

- Levels: `debug` = engineer tracing (off by default in prod); `info` =
  operator-relevant state changes only; `warn` = degraded but working;
  `error` = needs attention. No `trace` level exists — use `debug`.
- Volume budgets (default per scope, sustained): `info` ≤ 1/sec. Enforcement is
  a token bucket in the logger (burst 100, refill 1/sec, `info`/`debug` only):
  over-budget scopes shed load with a drop counter and announce with
  `scope.throttled` markers; `warn`/`error` and the `http` audit scope never
  throttle. Anything hotter is demoted to `debug` — there is deliberately **no
  sampling**: a deterministic 1-in-N gate drops evidence unconditionally and
  silently, which is the opposite of what reconstruction needs.
- Never log: secrets/token material (defense in depth — sinks redact anyway),
  raw user text, full prompts, system prompts, provider endpoint URLs, raw
  provider error messages, approval signatures, or huge objects. Sanitized
  structural diagnostics (lengths, counts, schema keys, ids) are allowed. Fields
  carry ids + small scalars.
- One canonical line per request/poll-cycle (Stripe-style), not N lines per
  step. The one deliberate exception is `http.request_start` + the completion
  line: a request that hangs never emits its completion, so without a start
  line it would be invisible.
- **Every loss path is counted** (see §6): a dropped entry must be observable,
  or "nothing happened" cannot be told apart from "evidence was dropped".

## 6. Storage & retention (replaceable by design)

Ring buffer (live tail) + JSON-lines file sink (history) is the current
back-end. The boundary rule: **only `src/lib/logger.ts` knows the entry shape
and the file format.** Everything else — routes, UI, tests — consumes entries
through `getRecentEntries`/`subscribe`/`lastSeq`/`bootId`, and downloads files
as opaque bytes (the files endpoint never parses log content). Swapping the
sink (SQLite table, rotation scheme, remote shipper) touches `logger.ts` and
this doc, nothing else.

Current policy: 5 MB per file, 20 generations, 100 MB total cap, 24h age prune;
ring holds the last 5000 entries (client mirrors the cap; the viewer
virtualizes). SSE is the only live transport — the old polling fallback is
retired; `since`+`bootId` resume makes every redelivery idempotent. All four numbers are runtime-configurable via
`/api/logs/settings` (persisted) or env (`TBAI_LOG_MAX_MB`, `TBAI_LOG_KEEP`,
`TBAI_LOG_MAX_TOTAL_MB`, `TBAI_LOG_RETENTION_HOURS`); `TBAI_LOG_FILE=off` (dev
default) or `=path` locks the file toggle. The two in-memory caps are also
configurable (`TBAI_LOG_RING`, `TBAI_LOG_QUEUE`) — they are bounded storage, so
they follow the same rule as the file sink.
High-frequency poll paths (`/api/mcp/elicit/pending`) log routine 200s at
debug, not info — a pending elicitation itself is the info event at the MCP
funnel. Volume budgets apply per scope excluding audit (`http.request`) lines,
which stay complete by design.

### 6.1 Loss accounting

Four counters make loss visible instead of inferred. They are monotonic per
process (they reset with the process, exactly like the ring they describe):

| Counter | Path that discards | Visible via |
|---|---|---|
| `levelFiltered` | the capture level (including a scope pinned to `off`) | `/api/logs/files`, `/metrics` |
| `ringSpliced` | the live-tail ring cap | same |
| `fileQueueDropped` | the file-sink backlog cap | same |
| `ioFailures` | file write / rotate / prune errors | same |

Per-scope throttle drops stay in `throttle.throttled`
(`/api/logs/settings`). Nothing here throws, and no counter is allowed to
become the reason a log call fails.

## 7. Enforcement (tests, not tribal knowledge)

- Failure→event matrix: every 4xx/5xx path and every forced funnel failure
  (tool, AI, scheduler, credential) must produce exactly one ring entry with
  the taxonomy event, correct level, correlation id, and zero secrets.
- Budget test: replayed traffic asserts shedding engages (drops > 0, marker
  fires, survivors bounded) instead of failing — governance is verified
  working, not merely specified.
- Loss test: each of the four discard paths is driven directly and its counter
  asserted (`tests/unit/logger-loss.test.ts`).
- Correlation tests: the header contract, ALS propagation, and "one operation,
  several requestIds" (`tests/unit/operation-correlation.test.ts`), plus the
  browser side (`web/src/lib/operation.test.ts`).
- Ingest boundary tests: acceptance, per-event operation attribution, scope
  registry enforcement, payload shape, and hard bounds
  (`tests/integration/logs-client-ingest.test.ts`).
- Reconstruction guards: the lifecycle events each surface must emit
  (`web/src/lib/observability-coverage.test.ts`), mutation-checked.
- Scope registry: the authoritative lists are `BACKEND_LOG_SCOPES` /
  `CLIENT_LOG_SCOPES` in `src/lib/log-scopes.ts`; new scopes are added there
  first, and the client ingest boundary enforces the browser subset.

## 8. Scope registry

The authoritative list lives in code, not here: `BACKEND_LOG_SCOPES` and
`CLIENT_LOG_SCOPES` in `src/lib/log-scopes.ts` (with the frontend's own copy of
the client list in `web/src/lib/log-scopes.ts`). Add a scope there first; the
client ingest boundary rejects anything not registered for the browser plane, so
the two lists cannot drift silently.

Backend: `http`, `ai`, `chat`, `tool`, `mcp`, `scheduler`, `credential`,
`opencode`, `server`, `db`, `workspace`, `conversations`.

Client: `app`, `chat`, `composer`, `availability`, `opencode`, `approval`,
`quick-messages.ui`, `mcp.ui`, `folders.ui`.

Notes:
- `chat` and `opencode` appear on BOTH planes on purpose: one scope name means a
  single scope query returns the whole story for a subsystem in time order, and
  `plane: "client"` marks the origin.
- `approval` is client-only: approvals are answered in the browser.
- There are no dead entries: a scope that no production code emits is removed
  from the registry rather than kept "for later".
