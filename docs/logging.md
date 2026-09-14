# Logging Charter

The law for all logging in TBAi. Code follows this doc, not the reverse.

## 1. The funnel rule (hard architectural rule)

**Every operational event has exactly one owning funnel. Lower layers must not
re-log the same event.** A route handler, a `runX` tool function, and a storage
helper never emit lifecycle logs — their funnel does.

| Funnel | Owns | Lives in |
|---|---|---|
| HTTP edge | every request lifecycle + every failed response (`http.request`, `http.error`) | `src/routes/index.ts` middleware + `onError` |
| AI funnel | stream lifecycle (`ai.request`, `ai.response`, `ai.error`) | boundary emitters in the chat route (scheduler runs are covered by `scheduler.run`, which owns that lifecycle; a shared `streamChat` wrapper waits for a third `streamText` site) |
| Tool funnel | every tool call (`tool.start`, `tool.finish`, `tool.error`) | single wrapper at the `tool()` registration sites |
| Scheduler funnel | run lifecycle (`scheduler.run`) | `fireJob` |
| Credential funnel | credential failures (`credential.error`) | inside `CredentialStore` methods |
| MCP funnel | server operations (`mcp.operation`) | `mcpManager` connect/operate paths |

Unique domain information may still be logged at the site that owns it — but
never a duplicate lifecycle event. When in doubt, don't log: the edge and the
funnel already covered it.

## 2. RequestContext (minimal correlation identity)

```ts
requestId       // every request (middleware binds)
conversationId  // chat + job conversations (route / fireJob bind)
toolCallId      // tool funnel binds
jobId           // fireJob binds
providerId      // AI funnel binds
modelId         // AI funnel binds
```

Correlation only — never a dumping ground. New fields require a demonstrated
funnel need, recorded here first.

## 3. Event taxonomy

Small closed set. New events require a charter entry — subsystems do not invent
naming styles.

| Event | Scope | When | Key fields |
|---|---|---|---|
| `http.request` | `http` | request completes < 400 | method/path in `message`, `statusCode`, `durationMs` |
| `http.error` | `http` | response ≥ 400 or thrown error | `statusCode`, `category`, `retryable`, `message` |
| `ai.request` | `ai` | stream starts | `provider`, `model` |
| `ai.response` | `ai` | stream finishes | `provider`, `model`, `durationMs` |
| `ai.error` | `ai` | stream/provider/test fails | classification fields + `provider` |
| `ai.run_detached` | `ai` | connection dropped while the server run continues | `streamId`, `reason` (`connection-closed`/`read-error`), timings |
| `tool.start` | `tool` | tool call begins | `tool`, + `mcpServer` for remote tools |
| `tool.finish` | `tool` | tool call succeeds | `tool`, `durationMs` |
| `tool.error` | `tool` | tool call fails | `tool`, `durationMs`, classification fields |
| `scheduler.run` | `scheduler` | run lifecycle | `outcome`: started/finished/failed/missed/skipped/cancelled/retried, `jobId`, `runId` |
| `scheduler.admin` | `scheduler` | job created/updated/deleted/enabled/disabled/cancel_requested | `action`, `jobId` |
| `scheduler.maintenance` | `scheduler` | boot recovery, GC | `phase`, report counters |
| `credential.error` | `credential` | decrypt/get/store failure (never key material) | classification fields |
| `mcp.operation` | `mcp` | connect/disconnect/reconnect/roots/sampling/elicitation/resource/prompt/test | `op`, `outcome`, `mcpServer` |
| `scope.throttled` | emitting scope | throttle engage/disengage (governance marker, never silent) | `engaged`, `dropped`, `budgetPerSec` |

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

Categories: `cancelled`, `auth`, `rate_limit`, `network`, `timeout`, `config`,
`tool`, `provider`, `unknown`. Retryable: `rate_limit`, `network`, `timeout`,
or any 5xx. Everything else is terminal.

## 5. Emission rules

- Levels: `debug` = engineer tracing (off by default in prod); `info` =
  operator-relevant state changes only; `warn` = degraded but working;
  `error` = needs attention. No `trace` level exists — use `debug`.
- Volume budgets (default per scope, sustained): `info` ≤ 1/sec. Enforcement is
  a token bucket in the logger (burst 100, refill 1/sec, `info`/`debug` only):
  over-budget scopes shed load with a drop counter and announce with
  `scope.throttled` markers; `warn`/`error` and the `http` audit scope never
  throttle. Anything hotter is demoted or sampled — see §7.
- Never log: secrets/token material (defense in depth — sinks redact anyway),
  raw user text, full prompts, huge objects. Fields carry ids + small scalars.
- One canonical line per request/poll-cycle (Stripe-style), not N lines per step.

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
default) or `=path` locks the file toggle.
High-frequency poll paths (`/api/mcp/elicit/pending`) log routine 200s at
debug, not info — a pending elicitation itself is the info event at the MCP
funnel. Volume budgets apply per scope excluding audit (`http.request`) lines,
which stay complete by design.

## 7. Enforcement (tests, not tribal knowledge)

- Failure→event matrix: every 4xx/5xx path and every forced funnel failure
  (tool, AI, scheduler, credential) must produce exactly one ring entry with
  the taxonomy event, correct level, correlation id, and zero secrets.
- Budget test: replayed traffic asserts shedding engages (drops > 0, marker
  fires, survivors bounded) instead of failing — governance is verified
  working, not merely specified.
- Scope registry: every scope below must exist in code; new scopes are added
  here first.

## 8. Scope registry (seed)

`http`, `ai`, `tool`, `chat`, `mcp`, `scheduler`, `credential`, `storage`,
`server`, `db`, `workspace`, `memory`, `tools`, `conversations`, `ai.provider`
(legacy, migrate to `ai` on touch).
