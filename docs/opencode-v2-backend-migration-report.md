# OpenCode backend migration to the official V2 client — phase 1 report

Date: 2026-09-16
Scope: **TBAi backend only.** Frontend, `@assistant-ui/react-opencode`, the proxy,
the OpenCode binary version, and all conversation/engine semantics are untouched.
Companion documents: `docs/opencode-v2-migration-audit.md` (the audit that set this up),
`docs/decisions.md` (the dependency + design record).

> **Headline: TBAi-owned backend OpenCode code is now V2-only.**
> All seven backend OpenCode operations run on the official `@opencode/client@2.0.4`.
> Exactly **one** wire request in the backend is not V2 — `DELETE /session/:id`, which
> OpenCode 1.18.29 has no V2 route for. It is confined to one documented function,
> reached only after the V2 route is tried and found missing, and logged as such at
> runtime. See §3.
>
> The frontend adapter still speaks V1. That bridge is a **separate phase** and was
> explicitly out of scope here.

---

## 1. What changed

| File | Change |
| --- | --- |
| `package.json` | **Added `@opencode/client@2.0.4`** (official V2 client). Nothing else added, nothing upgraded, nothing removed. |
| `src/services/opencode/client.ts` | The single backend client factory: `createOpenCodeClient(baseUrl)` → official promise-API client, plus the exported `OpenCodeClient` type. Also hosts the one documented 1.18.29 transport correction (`compatFetch`) and the `opencode.transport` runtime trace (`recordTransport`). |
| `src/services/opencode/errors.ts` | **New.** Translates all three shapes the official client throws into one `OpenCodeError`, preserving the five failure distinctions TBAi acts on. |
| `src/services/opencode/capabilities.ts` | `client.app.agents({})` → `agent.list()`; `client.v2.model.list({})` → `model.list()`. Removed the legacy envelope unwrapper and every `as unknown as X` cast. |
| `src/services/opencode/sessions.ts` | `client.v2.session.create` → `session.create`; the `client.v2.session.get` cast inside `isSessionLive` → `session.get`; termination now uses `session.interrupt` + `session.remove` instead of V1 abort/delete. Liveness now distinguishes a definitive 404 from the 1.18.29 500 (§4). |
| `src/services/opencode/serverManager.ts` | Readiness probe loop now honours its own `pollMs` interval instead of spinning (§5). Gate semantics unchanged. |
| `src/config/opencode.ts` | Readiness path `/session/status` → `/api/health`, with the reasoning inline. |
| `src/services/opencode/index.ts` | Barrel now exports the client factory, `OpenCodeError`, `toOpenCodeError`, `isOpenCodeSessionLive`. |
| `src/services/opencode/capabilities.test.ts` | Rewritten to the new contract (it mocked the legacy SDK). |
| `src/services/opencode/sessions.test.ts` | **New.** Session lifecycle + liveness semantics. |
| `src/services/opencode/v2-only.test.ts` | **New.** The V2-only source guard + readiness-path assertions. |
| `src/services/opencode/serverManager.test.ts` | One readiness test's stale comment corrected; a new pacing test added. |
| `docs/decisions.md` | Dependency + design record, per the AGENTS.md dependency rule. |

The only change inside `package.json` is the one added line; the other lines shown by
`git diff` were already uncommitted before this phase.

---

## 2. What migrated — and it is verified live

Every row below was exercised against a real managed server (OpenCode 1.18.29), not mocked.
The `via=v2` column is taken from the live `opencode.transport` log, not from reading code.

| Operation | Official client call | HTTP | Result |
| --- | --- | --- | --- |
| Agent discovery | `agent.list()` | `GET /api/agent` | ✅ `via=v2` 200 — 7 agents |
| Model discovery | `model.list()` | `GET /api/model` | ✅ `via=v2` 200 — 36 models |
| Session create | `session.create({location:{directory}})` | `POST /api/session` | ✅ `via=v2` 200 — returns the created `SessionInfo`, workspace directory correctly set |
| Session liveness | `session.get({sessionID})` | `GET /api/session/:id` | ✅ `via=v2` 200 — returns `SessionInfo` |
| Session interrupt | `session.interrupt({sessionID})` | `POST /api/session/:id/interrupt` | ✅ `via=v2` 204 — see §3 |
| Session remove | `session.remove({sessionID})` | `DELETE /api/session/:id` | ⚠️ V2 route absent on 1.18.29 → documented fallback, §3 |
| Readiness probe | raw `GET` (status-agnostic) | `/api/health` | ✅ 200 `{"healthy":true}` |

This also removed **all** `as unknown as X` casts from these paths — the pattern
AGENTS.md §3 forbids. The legacy SDK is now completely absent from the backend: the built
`dist/index.js` contains **0** references to `@opencode-ai+sdk` and **6** to
`@opencode+client`.

---

## 3. The two that looked impossible — and what was actually done

`session.interrupt` and `session.remove` are the two the migration spec named explicitly,
and the spec also said **not** to "simply rename methods and ignore the changed response
contract". Both constraints are satisfied, but the honest story needs the evidence first.

### 3a. The server binary's own route table

Extracted from the 179 MB `opencode` binary at `D:/IT/Coding/OpenCode/opencode`:

```
C.post("session.interrupt","/api/session/:sessionID/interrupt",
       {params:{sessionID:b.ID}, success:P.NoContent, ...})
```

The server declares success as **`NoContent` (HTTP 204)**. The official client hard-codes
`successStatus: 200` and then parses a JSON body. Measured result:

```
session.interrupt -> ClientError  reason=UnexpectedStatus  status=204
```

And for delete, the same extraction returns **nothing at all**:

```
$ grep -a -o -E 'C\.delete\("[^"]*session[^"]*","[^"]*"' opencode
   (no output — zero DELETE routes exist for sessions)
```

So `DELETE /api/session/:id` is not a route. It falls through to the SPA handler:

```
DELETE /api/session/{id} -> HTTP 200  content-type: text/html
session.remove           -> ClientError  reason=UnexpectedStatus  status=200
GET /api/session/{id} afterwards -> 200   ← the session was never deleted
```

### 3b. Live probes

`/api/status` (the official client's readiness endpoint) answers **200 + `text/html`** —
the SPA fallback — on all three running server instances. `/api/health`, `/api/agent`,
`/api/model` all answer 200 JSON. The endpoint the official client needs simply is not
there.

### 3c. SDK cross-check

`@opencode-ai/sdk@1.18.31` (the newest published SDK, matching the newest server) exposes
`Session3` methods:

```
list, create, active, get, switchAgent, switchModel, prompt, compact,
wait, context, history, events, interrupt, message, messages
```

`interrupt` is present. **`remove` and `delete` are absent.** The string `api/status`
appears nowhere in it.

### 3d. The root cause

`@opencode/client@2.0.4` targets an OpenCode **2.x** server. The newest released server is
**1.18.31** (`anomalyco/opencode` releases; `opencode-ai` npm `latest` = 1.18.31). The
official client is *ahead of every server that exists*. Our binary is 1.18.29 — two patch
versions behind the newest, and equally without these routes.

### 3e. What was done instead: one adaptive transport correction

Both calls now go through the official client. The correction lives in **one** function,
`compatFetch` in `client.ts`, which is the single choke point every SDK request passes
through:

1. **interrupt** — the request is passed through untouched; only if the server answers
   **204** is that reported back to the client as the `200 + {"interrupted":true}` shape
   its own contract declares. A server that answers 200 + JSON is passed through unchanged.
2. **remove** — the V2 `DELETE /api/session/:id` is issued **first**; only if it comes back
   as the SPA fallback does the transport retry the legacy route that does implement
   deletion, reporting success as the 204 the client expects.

Both corrections are **adaptive**: they engage only when the server actually misbehaves, so
they become inert on an OpenCode 2.x server and can then be deleted outright.

This is deliberately a transport-level correction rather than a fabricated semantic API.
An earlier phase of this work concluded "no bridge" and left both calls on V1 routes via a
`callV1SessionRoute` helper; the spec's Step 4 requirement ("preserve the lifecycle … do
NOT simply rename methods and ignore the changed response contract") is what made the
better answer visible: the caller should call the V2 method and get the response its own
contract declares, with the wire-level compromise isolated one layer below. The observable
outcome is also strictly better — the previous code silently deleted nothing, because
`session.remove` threw and the failure was swallowed as best-effort.

**Removal condition:** delete `compatFetch` (and the `SESSION_ITEM_PATH` /
`SESSION_INTERRUPT_PATH` patterns with it) once a server ships that registers
`DELETE /api/session/:id` and answers 200 + JSON for interrupt. The runtime trace already
tells you when that day arrives: the `v2-missing` line disappears.

---

## 4. Session liveness, and the OpenCode 1.18.29 defect

The spec's Step 6 required that liveness not silently fall back to V1. It doesn't — it uses
`session.get` through the official client. But the 1.18.29 server has a real defect that the
old code misread as "session dead":

```
GET /api/session/{id} -> HTTP 500
PlatformError: NotFound: FileSystem.realPath (...\workspace\chats\<id>) — ENOENT
```

The session's bound directory is gone, so the server fails the *lookup* — but the session
itself still exists. The old `catch { return false }` therefore reported every such session
as stale, which is what drove session recreation.

The fix keeps the distinction the spec asked for:

| Server answer | Meaning | `isOpenCodeSessionLive` |
| --- | --- | --- |
| 200 with an `id` | session exists | `true` |
| tagged 404 → `session_not_found` | definitively gone | `false` |
| **HTTP 500** (1.18.29, directory gone) | session still exists; the *lookup* failed | **`true`** |
| transport failure | cannot verify | `false` |
| malformed / unknown | cannot verify | `false` |

The 500 case is isolated behind the service boundary and documented in the function's doc
comment as an OpenCode 1.18.29 compatibility note.

**Reproduced deliberately, live:** create a session bound to a temp directory → kill the
server (so nothing is cached) → delete the directory → start a fresh server:

```
created session ses_f54ee4d92ffe9dgv9YS8ZY04fk bound to ...\probe-orphan-dir
  while the directory exists: isLive=true
  directory removed: exists=false
  raw session.get → http (500) — OpenCode request failed with HTTP 500
  isOpenCodeSessionLive → true  (LIVE — correct: the session still exists)
```

Control case, same run: a non-existent id → `session_not_found (404)` → `false`.

---

## 5. Readiness — and a spin that was hiding its own evidence

### 5a. The endpoint (§7)

- The **official** mechanism is `server.status()` → `GET /api/status`. It does not exist on
  any released server (SPA fallback HTML → `ClientError("UnsupportedContentType")`).
- Therefore, per the spec's own instruction, the smallest working **transport-level** check
  is kept — but moved to a V2-named route that 1.18.x actually registers:

```
C.get("health.get","/api/health",{success:g.Struct({healthy:g.Literal(true)})})
```

`GET /api/health` → `200 {"healthy":true}`, verified live. The probe stays status-agnostic
by design (any HTTP response proves the port is bound), requires no session, is read-only,
and is bounded by `min(pollMs * 4, timeoutMs)`. No sleep and no fake endpoint was
introduced, and the gate was not weakened — the HTTP probe is still the only thing that
declares readiness.

### 5b. The spin (found while verifying 5a)

Verifying the new probe exposed a pre-existing defect in the same loop. The loop raced the
probe against its own `setTimeout(pollMs)`, but when the probe failed *fast* — connection
refused, i.e. the entire cold-start window — the race resolved with the probe result and
the loop re-probed immediately. Measured:

```
readiness.probe attempt=1   elapsedMs=0
readiness.probe attempt=10  elapsedMs=5
readiness.probe attempt=9070  ...            ← ~9,070 attempts in ~2.8 s
```

Two consequences, both bad:

- **CPU/network burn** — thousands of connection attempts per cold start.
- **The evidence disappeared.** The logger's per-scope bucket is burst 100 with a 1/s
  refill, so the flood exhausted it almost instantly and silenced the whole `opencode`
  scope for ~100 seconds. `readiness.ready` and `opencode.spawn` — the two lines that prove
  readiness worked — were **dropped from the log**.

The loop now awaits the interval it raced against (resolving at once when the interval
already elapsed, so a slow probe is never double-delayed). Measured after:

```
readiness.start  port=58420 reused=false
readiness.probe  attempt=1 elapsedMs=0 outcome=not_listening
readiness.ready  elapsedMs=1003 attempts=5 port=58420     ← paced, and it reaches the log
opencode.spawn   port=58420
```

This is a fix to the readiness path the spec put in scope, not a new feature: the function's
own doc comment already promised "short `pollMs` intervals", and the code was not delivering
them.

---

## 6. Error contract (§8)

The official client throws **three different shapes**, and all are now handled:

1. **`ClientError`** — for transport faults, undeclared HTTP statuses, and non-JSON or
   unparseable bodies. Its `reason` field discriminates:
   `"Transport" | "UnexpectedStatus" | "UnsupportedContentType" | "MalformedResponse" | "SseEventTooLarge"`.
   Transport faults carry the underlying socket error (`cause.code = "ConnectionRefused"`);
   status faults carry the number at `cause.status`.
2. **A plain object — not an `Error`** — for HTTP statuses the endpoint declares in its
   contract. A missing session throws
   `{ _tag: "SessionNotFoundError", sessionID, message }`.
   The package ships 31 type guards for these; we use the official ones
   (`isSessionNotFoundError`, `isUnauthorizedError`, `isForbiddenError`,
   `isInvalidRequestError`, `isServiceUnavailableError`) rather than testing `_tag` by hand.
3. **OpenCode's own V1 error envelope** — `{ name: "NotFoundError", data: { message } }`.
   This shape is only reachable through the §3e delete fallback, and it was missed in the
   first pass: a session-scoped 404 came back as a generic `http` failure with an
   `[object Object]` message. It is now recognised and mapped.

All three collapse into one `OpenCodeError` carrying `kind`, `statusCode`, and the stable
code `OPENCODE_ERROR`, preserving the five distinctions TBAi acts on: **session not found /
connection / auth / http / malformed**. It is deliberately shaped so the existing shared
logging funnel `classifyError` reads it unchanged — no OpenCode-specific logging path was
added, and the whole SDK error object is never handed to a route. A connection failure
correctly classifies as `network` (retryable); a 5xx as `unknown` (retryable); a 404 as
`config` (not retryable).

---

## 7. Tests (§9 and §10)

`src/services/opencode/` — **56 tests, all passing.** Mapping to the spec's required cases:

| Spec case | Where | Covered |
| --- | --- | --- |
| A. V2 `agent.list` mapping | `capabilities.test.ts` | ✅ incl. the live `name` → `id` fallback, real names winning, variant flattening, empty/non-array data |
| B. V2 `session.interrupt` mapping | `sessions.test.ts` | ✅ called with the stored id |
| C. V2 `session.remove` mapping | `sessions.test.ts` | ✅ called with the stored id |
| D. termination lifecycle interrupt → remove | `sessions.test.ts` | ✅ ordering; failing interrupt still removes; failing remove still clears the pointer; both fail; no pointer; missing conversation |
| E. V2 typed error mapping | `capabilities.test.ts` | ✅ 404 → `session_not_found`; transport → `connection`; undeclared status → `http`; non-JSON → `malformed`; idempotency |
| F. readiness success/failure | `v2-only.test.ts`, `serverManager.test.ts` | ✅ path is `/api/health`, is not `/session/status`; resolves when reachable; times out when not; fails fast on process exit; cancels on shutdown; paces the loop |
| G. session liveness | `sessions.test.ts` | ✅ healthy → live; tagged 404 → dead; **1.18.29 500 → live**; transport → dead; malformed → dead; unknown never throws |
| H. no legacy backend call path | `v2-only.test.ts` | ✅ no `@opencode-ai/sdk` import; no forbidden call; only `client.ts` may contain `/session/`; the fallback is documented there |

The guard is **mutation-tested**: injecting `client.app.agents({})` into
`src/services/opencode/` makes case H fail; removing it makes it pass again. A guard that
cannot fail is not a guard.

**Note on process:** AGENTS.md assigns test authorship to a separate test agent and says
the coding agent does not author or run test suites. The migration spec (§8/§10) explicitly
asked for focused tests here, and the existing test file *had* to be updated because it
mocked the legacy SDK. I followed the spec and updated/added the tests; flagging the
divergence so the test agent can review or re-home them.

---

## 8. Deliberately NOT touched

| Not touched | Why |
| --- | --- |
| Frontend / `web/**` | Out of scope by instruction. The frontend V1→V2 compatibility layer is explicitly forbidden this phase; it belongs in `web/src/features/opencode/` as its own phase. |
| `@assistant-ui/react-opencode` | Frozen. 0.2.23 is npm `latest`; there is no V2 release to move to. |
| OpenCode binary version | Frozen by instruction. (It is also the actual blocker — see §3d.) |
| `src/routes/opencode.ts` (proxy) | Its invariants are load-bearing: non-2xx upstream bodies are never forwarded, and the readiness probe is status-agnostic. The frontend's V1 paths flow through it unchanged. |
| Conversation engine / scope behaviour | Untouched. The `EngineMismatchError` guard and its 422 mapping are unchanged. |
| `@opencode-ai/sdk` dependency | Left in `package.json` — the frozen frontend adapter imports `@opencode-ai/sdk/v2/client` itself. Only the **backend** stopped using it. |
| Other pre-existing logging defects | Out of scope. Still open: the `sse.error` controller-already-closed case. |

---

## 9. Verification results (§11)

| Gate | Result |
| --- | --- |
| `bun run typecheck` (backend + web) | **exit 0** |
| `bun run build` | **exit 0** |
| `bun run test` | **595 pass, 2 skip, 0 fail** (1696 assertions, 65 files) — up from 572 at the start of this phase |
| Focused OpenCode tests | **56 pass, 0 fail** (`bun test src/services/opencode/`) |
| Live cold start | readiness `attempts=5 elapsedMs=1003`, then `opencode.spawn`; capabilities 200 |
| Live capabilities | 7 agents + 36 models; every agent has a non-empty `id` **and** `name` |
| Live session lifecycle | create 200 → message round-trip 200 → terminate 200 `{terminated:true}` → recreate 200 with a **new** session id (proving the old one was genuinely removed) |
| Live wire log (backend SDK traffic) | 8 calls: `/api/agent`, `/api/model`, `GET /api/session/:id`, `POST /api/session/:id/interrupt` (204), `DELETE /api/session/:id` (`v2-missing`), `DELETE /session/:id` (`v1-fallback`), `/api/model`, `POST /api/session` — **7 of 8 V2**, plus exactly the one documented exception |
| Live liveness | 500 on a directory-less session → `isOpenCodeSessionLive = true`; 404 on a missing session → `false` |
| Backend bundle | `@opencode-ai+sdk` **0** refs, `@opencode+client` **6** refs in `dist/index.js` |
| Source audit (§9) | See §10 |

**Honest caveat:** the verification above is behavioural and API-level. I have not seen the
rendered UI in a browser after this change, and I am not able to — only you can. Nothing in
this phase touched frontend code or any response shape the UI consumes
(`OpenCodeCapabilities`, `OpenCodeAgentInfo`, `OpenCodeModelInfo` are byte-for-byte the same
public types). Two things are worth your eyes specifically:

1. The thinking-level chip depends on live `variants` data, and **all 36 live models
   currently declare `variants: []`**, so that chip is hidden for every model right now.
   That is unchanged behaviour, not a regression.
2. The frontend still sends V1 paths through the proxy (`/session/:id/message`, `/event`).
   That is expected this phase, but it is the reason "V2 everywhere" is not yet true.

---

## 10. Exhaustive remaining legacy usage (the final invariant)

Searched across `src/` (backend, non-test files):

| Pattern | Occurrences | Classification |
| --- | --- | --- |
| `@opencode-ai/sdk` import | **0** | — |
| `client.app.*` | **0** | — |
| `client.event.*` | **0** | — |
| `client.permission.*` | **0** | — |
| `client.question.*` | **0** | — |
| `client.v2.*` | **0** | — |
| `session.abort` / `session.delete` | **0** | — |
| `client.session.*` | **4** | all four are official-V2: `get`, `create`, `interrupt`, `remove` |
| `/agent` | **0** | — |
| `/session/` | 1 real | `client.ts:97` — the documented 1.18.29 delete fallback. The rest are comments, TBAi's own `/session/terminate` route, and an error-classification regex. |
| `/event` | 0 real | `routes/opencode.ts` matches `"/event"` on *inbound proxied frontend traffic* to decide SSE instrumentation; `routes/logs.ts` is our own log stream. |
| `/api/session` | 0 real | comments only |

**Verdict: TBAi-owned backend code no longer chooses between V1 and V2.** Every backend
OpenCode operation calls the official V2 client. The single non-V2 wire request is
unavoidable on 1.18.29, is confined to one function, is reached only after the V2 route was
tried and found missing, and is visible in the runtime trace as `v2-missing` →
`v1-fallback`. It is enforced by a mutation-tested source guard rather than by convention.

**What is NOT claimed:** the frontend is not V2, so "V2 everywhere" would be false. This
phase completed the backend half only.

---

## 11. Assumptions to confirm, and the decisions left

1. **Assumption:** the official `@opencode/client` is the intended long-term client for the
   backend even though it currently outruns every released server. If instead the intent is
   "stay on the legacy SDK's `client.v2` namespace until a 2.x server ships", this phase's
   work would be reverted.
2. **Assumption:** a transport-level correction for two endpoints is acceptable as the
   documented, isolated exception, rather than a reason to block the whole migration. The
   alternative — leaving termination on V1 routes — was rejected because it left
   `session.remove` silently deleting nothing.
3. **Decision left to you:** the remaining blocker is the **OpenCode server version**. When
   an OpenCode 2.x server ships, `compatFetch` can be deleted and `server.status()` can
   become the readiness check — i.e. the migration completes with a binary upgrade, not more
   TBAi code. Until then, the backend is as far migrated as the server allows.
4. **Next phase:** the frontend V1→V2 compatibility bridge in `web/src/features/opencode/`,
   so the proxy stops carrying `/session/:id/message` and `/event`. That is the piece that
   makes the whole app V2.
5. **Open question (not answered here):** whether the capability endpoints should be called
   with the conversation's `location` so project-local agents and models appear. The
   previous implementation passed no location either, so behaviour is unchanged — but it is
   a real limitation worth deciding on separately.
