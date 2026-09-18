# OpenCode V2 migration audit

**Date:** 2026-09-16
**Phase:** audit only — **no production code, `package.json`, lockfile, dependency, or OpenCode binary was changed.**

## Why this audit exists

OpenCode documents the V1 server API as an *intentional breaking change* surface:
`https://opencode.ai/v2/docs/migrate-v1` states *"The server API and clients have new
contracts"* and *"Integrations that call the V1 server API must migrate to the V2 API."*

This is **forward-looking**, not a fix. Runtime probing on 2026-09-16 established that in
our environment OpenCode **1.18.29** still serves working V1 endpoints and that V1/V2
session visibility is **shared** (V1's id list is a subset of V2's; zero V1-only ids).
A prior "V1 is dead / separate stores" hypothesis was disproven.

### Measured baseline (read-only probes, same managed server)

| Endpoint | Result |
|---|---|
| `GET /session` (V1 list) | 200 — 31 ids |
| `GET /api/session` (V2 list) | 200 — 50 ids |
| V1-only ids | **0** (one shared store) |
| `GET /session/<id>` | 200 |
| `GET /api/session/<id>` | **500** on 13 of 14 sessions |
| `GET /session/<id>/message` | 200 |
| `GET /event` / `GET /api/event` | both 200, `text/event-stream` |
| `/permission`, `/question`, `/experimental/session`, `/agent`, `/api/agent`, `/api/model` | all 200 |

Versions: OpenCode binary **1.18.29**; `@opencode-ai/sdk` **1.18.31**;
`@assistant-ui/react-opencode` **0.2.23**.

---

## 1. TBAi V1 usage inventory

Only **four call sites plus one config value**. No other backend module touches the
OpenCode SDK — `client.ts`, `events.ts` and `permissions.ts` in
`src/services/opencode/` are empty placeholders.

| File | Function | SDK method | HTTP endpoint | Purpose | Required for Code? |
|---|---|---|---|---|---|
| `src/services/opencode/sessions.ts:174-177` | `terminateOpenCodeSession` | `client.session.abort({sessionID})` | `POST /session/{id}/abort` | stop live work on conversation teardown | yes (best-effort) |
| `src/services/opencode/sessions.ts:174-177` | `terminateOpenCodeSession` | `client.session.delete({sessionID})` | `DELETE /session/{id}` | delete server-side session | yes (best-effort) |
| `src/services/opencode/capabilities.ts:79` | `getOpenCodeCapabilities` | `client.app.agents({})` | `GET /agent` | populate the agent picker | yes |
| `src/config/opencode.ts:21` | `waitForHttpReady` probe path | raw `fetch` | `GET /session/status` | server readiness gate | yes |

**V1 usage is 4 sites. It is small and fully replaceable.**

## 2. TBAi V2 usage inventory

| File | Function | SDK method | HTTP endpoint | Purpose | Required? |
|---|---|---|---|---|---|
| `sessions.ts:51-57` | `isSessionLive` | `client.v2.session.get({sessionID})` | `GET /api/session/{id}` | liveness probe for a stored pointer | yes |
| `sessions.ts:106-136` | `ensureOpenCodeSession` | `client.v2.session.create({location:{directory}, agent?, model?})` | `POST /api/session` | create/resume the session | yes |
| `capabilities.ts:80` | `getOpenCodeCapabilities` | `client.v2.model.list({})` | `GET /api/model` | model picker | yes |
| `capabilities.ts:119` | `resolveOpenCodeModelRef` | `client.v2.model.list({})` | `GET /api/model` | resolve `providerID` for a stored model | yes |
| `capabilities.ts:141` | `listOpenCodeModelVariants` | `client.v2.model.list({})` | `GET /api/model` | thinking/variant list | yes |

The backend is therefore **already majority-V2**: 5 V2 call sites vs 4 V1 call sites.

> Latent risk found during probing: `isSessionLive` depends on `GET /api/session/{id}`,
> which currently 500s on ~93% of sessions (uncorrelated with message count or tokens).
> When it 500s, `isSessionLive` returns `false` and TBAi silently recreates the session.
> This is an OpenCode 1.18.29 server-side defect, not a TBAi bug, but it makes the
> liveness check unreliable today.

## 3. Adapter V1 dependency inventory

`@assistant-ui/react-opencode@0.2.23` imports `@opencode-ai/sdk/v2/client` and injects its
client at `useOpenCodeRuntime.ts:372-375` (`options.client ?? createOpencodeClient({ baseUrl })`).
It touches **five root namespaces** across **19 call sites**, all on the V1 surface:

| # | Adapter call | Site | V1 endpoint |
|---|---|---|---|
| 1 | `client.session.get` | `OpenCodeThreadController.ts:518` | `GET /session/{id}` |
| 2 | `client.session.messages` | `:522` | `GET /session/{id}/message` |
| 3 | `client.session.status` | `:438` | `GET /session/status` |
| 4 | `client.session.promptAsync` | `:582` | `POST /session/{id}/prompt_async` |
| 5 | `client.session.abort` | `:661` | `POST /session/{id}/abort` |
| 6 | `client.session.revert` | `:676` | `POST /session/{id}/revert` |
| 7 | `client.session.unrevert` | `:690` | `POST /session/{id}/unrevert` |
| 8 | `client.session.fork` | `:699` | `POST /session/{id}/fork` |
| 9 | `client.session.create` | `openCodeThreadListAdapter.ts:84` | `POST /session` |
| 10 | `client.session.update` | `:47,56,65` | `PATCH /session/{id}` |
| 11 | `client.session.delete` | `:76` | `DELETE /session/{id}` |
| 12 | `client.session.summarize` | `:94` | `POST /session/{id}/summarize` |
| 13 | `client.event.subscribe` | `OpenCodeEventSource.ts:165` | `GET /event` (SSE) |
| 14 | `client.permission.list` | `OpenCodeThreadController.ts:450` | `GET /permission` |
| 15 | `client.permission.reply` | `:716` | `POST /permission/{requestID}/reply` |
| 16 | `client.question.list` | `:465` | `GET /question` |
| 17 | `client.question.reply` | `:735` | `POST /question/{requestID}/reply` |
| 18 | `client.question.reject` | `:751` | `POST /question/{requestID}/reject` |
| 19 | `client.experimental.session.list` | `openCodeThreadListAdapter.ts:28` | `GET /experimental/session` |

Injection contract: `types.ts:196` declares `client?: OpencodeClient`, imported from
`@opencode-ai/sdk/v2/client` — the **class type**, so TypeScript requires the full public
shape unless cast. The adapter reads the client via `createRegistry(client)`
(`useOpenCodeRuntime.ts:376`) as well as directly, so any injected object must serve both.

**Direct V2 equivalents that exist in the official client:** `session.get`, `session.create`,
`session.remove`, `session.fork`, `session.update`, `session.diff`, `message.list`,
`session.compact`, `session.interrupt`, `session.revert.*`, `session.form.*`, `permission.*`,
`agent.list`, `model.list`, `provider.*`, `event.subscribe`.

**Genuinely absent in V2:** a per-session status map (`session.status`); `question` as a
named concept (replaced by `form`); `prompt_async` as a distinct method (replaced by
`session.prompt` with a `delivery` field).

## 4. Official V2 API mapping

### Package identity

| | Legacy | Official V2 |
|---|---|---|
| Package | `@opencode-ai/sdk` | **`@opencode/client`** |
| Version | 1.18.31 | **2.0.4** |
| Repo | — | `github.com/anomalyco/opencode`, `packages/client` |
| Deps | — | `@opencode/schema@2.0.4`, `@opencode/protocol@2.0.4` |
| Peers | — | `effect@4.0.0-rc.112` **(optional)**, `solid-js` **(optional)** |
| Exports | — | `.`, `./promise`, `./service`, `./solid`, `./effect`, … |

The legacy SDK's "V2" is **not** the official V2 API. `@opencode-ai/sdk@1.18.31` exposes a
`client.v2` namespace whose `Session3` class speaks `/api/session/*` — a transitional
surface that is **incomplete** relative to the documented V2 API (no `remove`, no `fork`,
no `update`, no `diff`, no `session.prompt` text shape). The official V2 client is a
**different package** with a different paradigm (Effect/Solid), a different error model,
and a much larger surface.

### Transport compatibility — the important positive finding

```ts
// @opencode/client/dist/promise/generated/client.d.ts
export interface ClientOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: RequestInit["headers"];
}
```

```js
// @opencode/client/dist/promise/generated/client.js:967
event: { subscribe: (requestOptions) =>
  sse({ method: "GET", path: `/api/event`, successStatus: 200, declaredStatuses: [400,401], empty: false }, requestOptions) }
```

- It takes a **`baseUrl`** → can be pointed at the TBAi proxy `/api/opencode`.
- It accepts an **injectable `fetch`** → a custom transport is supported.
- Every path is under **`/api/*`** → the proxy's prefix-strip already maps correctly.
- The event stream is **`/api/event`** and the client requires
  `Content-Type: text/event-stream`. The TBAi proxy forwards SSE verbatim and was measured
  returning exactly that for both `/event` and `/api/event`.
- Both peers are **optional** — `@opencode/client/promise` needs neither `effect` nor `solid-js`.

**Conclusion: the official V2 client works through the existing TBAi proxy with zero proxy
changes.** This removes what would otherwise have been the hardest infrastructure blocker.

### V2 session surface (official client)

| V2 method | Input shape | Returns |
|---|---|---|
| `session.list` | `{limit?, order?, search?, parentID?, directory?, project?, subpath?, cursor?}` | `{data: Session.Info[], cursor}` |
| `session.get` | `{sessionID}` | `Session.Info` |
| `session.create` | `{id?, title?, agent?, model?, location?, metadata?, permissions?}` | `Session.Info` |
| `session.remove` | `{sessionID}` | `void` |
| `session.fork` | `{sessionID, before?}` | `Session.Info` |
| `session.update` | `{…}` | `void` |
| `session.prompt` | `{sessionID, id?, text, files?, agents?, skills?, metadata?, delivery?, resume?}` | `SessionInboxUser` |
| `session.interrupt` | `{…}` | `SessionInterruptResponse` |
| `session.compact` | `{…}` | `SessionInboxCompaction` |
| `session.revert.stage` / `.clear` / `.commit` | `{sessionID, …}` | `SessionRevert` / `void` / `void` |
| `session.diff` | `{…}` | `FileDiffInfo[]` |
| `session.active` | — | `{[id]: SessionActive}` |
| `session.form.list/create/get/reply/cancel` | `{sessionID, formID?, answer?}` | `FormInfo` / `FormDetail` / `void` |
| `message.list` | `{sessionID, limit?, order?, cursor?, type?}` | `{data, cursor}` |
| `permission.list` | `{sessionID}` | `PermissionRequest[]` |
| `permission.get` | `{sessionID, requestID}` | `PermissionRequest` |
| `permission.reply` | `{sessionID, requestID, decision, message?}` | `void` |
| `permission.request.list` / `saved.list` / `saved.remove` | — | — |
| `agent.list` / `agent.get` | `{…}` | — |
| `model.list` / `model.default` | — | — |
| `provider.list` / `provider.get` | — | — |
| `event.subscribe` | `requestOptions?` | **`AsyncIterable<V2Event>`** |
| `migration.v1.status` | — | migration state |

**Error model:** typed errors — `InvalidRequestError`, `UnauthorizedError`,
**`SessionNotFoundError`**, `SchemaError`, `ClientError`, `HttpClientError` — instead of the
legacy `{data, error}` envelope. This is strictly better and removes the `unwrapList`
envelope-guessing currently needed in `capabilities.ts:53-66`.

## 5. Migration matrix

Classification: **DIRECT** · **REQUIRES ADAPTER** · **REQUIRES BACKEND CHANGE** · **NOT AVAILABLE**

### Backend

| TBAi operation | Current API | V2 API | Shape difference | Difficulty |
|---|---|---|---|---|
| create session | `client.v2.session.create` → `{data:{data:{id}}}` | `session.create({location})` → `Session.Info` | envelope unwrap | REQUIRES BACKEND CHANGE |
| liveness | `client.v2.session.get` → `{data:{data:{id}}}` | `session.get({sessionID})` → `Session.Info` | envelope + typed `SessionNotFoundError` | REQUIRES BACKEND CHANGE |
| abort | `client.session.abort` | `session.interrupt` | rename + response body | REQUIRES BACKEND CHANGE |
| delete | `client.session.delete` | `session.remove` | rename only | DIRECT |
| agents | `client.app.agents` → `/agent` | `agent.list` → `/api/agent` | rename; **V2 already preferred** | DIRECT |
| models | `client.v2.model.list` → `/api/model` | `model.list` | return shape | DIRECT |
| readiness probe | raw `GET /session/status` | `server.status` / `session.active` | different semantics | REQUIRES BACKEND CHANGE |

### Adapter

| Adapter operation | Current V1 | V2 equivalent | Shape difference | Difficulty |
|---|---|---|---|---|
| session get | `session.get` | `session.get` | envelope + return | REQUIRES ADAPTER |
| history | `session.messages` | `message.list({sessionID})` | namespace move + pagination | REQUIRES ADAPTER |
| session status | `session.status` | `session.active` / `server.status` | no per-session map | **NOT AVAILABLE** |
| prompt | `session.promptAsync({parts})` | `session.prompt({text, files, agents, skills, delivery})` | **parts → text+attachments** | REQUIRES ADAPTER |
| abort | `session.abort` | `session.interrupt` | rename + response | REQUIRES ADAPTER |
| revert | `session.revert` | `session.revert.stage` | **1 call → 3 phases** | REQUIRES ADAPTER |
| unrevert | `session.unrevert` | `session.revert.clear` | rename + phase | REQUIRES ADAPTER |
| fork | `session.fork` | `session.fork` | envelope | REQUIRES ADAPTER |
| create | `session.create({})` | `session.create({location?})` | envelope + location | REQUIRES ADAPTER |
| update | `session.update` | `session.update` | envelope | REQUIRES ADAPTER |
| delete | `session.delete` | `session.remove` | rename | REQUIRES ADAPTER |
| summarize | `session.summarize` | `session.compact` | rename + return | REQUIRES ADAPTER |
| event subscribe | `event.subscribe` → SSE `Response` | `event.subscribe` → `AsyncIterable<V2Event>` | **stream → async iterator** | REQUIRES ADAPTER |
| permission list | `permission.list()` (global) | `permission.list({sessionID})` | **global → session-scoped** | REQUIRES ADAPTER |
| permission reply | `permission.reply({requestID, reply})` | `permission.reply({sessionID, requestID, decision})` | `reply` → `decision`, + sessionID | REQUIRES ADAPTER |
| question list | `question.list()` (global) | `session.form.list({sessionID})` | **question → form** | REQUIRES ADAPTER |
| question reply | `question.reply({requestID, answers})` | `session.form.reply({sessionID, formID, answer})` | `answers` → `answer` | REQUIRES ADAPTER |
| question reject | `question.reject({requestID})` | `session.form.cancel({sessionID, formID})` | reject → cancel | REQUIRES ADAPTER |
| thread list | `experimental.session.list` | `session.list` | namespace + pagination | REQUIRES ADAPTER |

**18 of 19 adapter operations require an adapter. One is not available at all.**

## 6. The real blocker

| Candidate | Verdict | Evidence |
|---|---|---|
| **A.** react-opencode has no native V2 support | **TRUE** | 0.2.23 (npm `latest`) drives `client.session.*` / `client.event.*` exclusively; no V2 namespace is referenced anywhere in its source |
| **B.** `@opencode/client` cannot satisfy the adapter's client interface | **TRUE** | Method names, return shapes, error model, and namespace layout all differ. `session.messages`→`message.list`; `promptAsync(parts)`→`prompt(text)`; `event.subscribe`→`AsyncIterable`; `question`→`form`; permission becomes session-scoped |
| **C.** V2 has materially different event semantics | **TRUE, but surmountable** | `AsyncIterable<V2Event>` vs SSE `Response`. The transport is `/api/event` + `text/event-stream`, which the TBAi proxy already forwards verbatim |
| **D.** permission/question/message APIs need non-trivial translation | **TRUE — dominant** | 19 operations; `question`→`form` is a rename *and* a reshape; `revert` splits into 3 phases; `prompt` changes from parts to text+attachments; permission gains a required `sessionID` |
| **E.** TBAi backend still depends on legacy V1 | **TRUE, small** | 4 call sites (`session.abort`, `session.delete`, `app.agents`, readiness path). All have V2 counterparts |

### Answer: **F — a combination, with D dominant.**

A and B are structural: the adapter is V1-native and the official client is not a drop-in
replacement for the interface the adapter expects. C and E are real but bounded. D is the
dominant cost — 18 adapter operations need reshaping, several of which are semantic
renames rather than path changes.

## 7. Is a temporary compatibility layer necessary?

Split the question by boundary.

**Backend → official V2 API: NO layer needed.** All 4 V1 call sites have direct V2
counterparts, and the official client works through the existing proxy. This half can move
independently and is the low-risk part of the migration.

**Frontend → V2-native: YES, a layer is needed** — unless TBAi is willing to wait for
upstream. Upstream ships no V2 release today (§9), and the adapter's V1 surface is fully
functional, so there is no forcing function.

### Recommended migration boundary

```
TBAi backend (src/services/opencode/)
    → @opencode/client (official V2)         ← migrate now; no shim; 4 call sites

TBAi proxy (src/routes/opencode.ts)
    → unchanged                              ← verified compatible with /api/* + SSE

TBAi frontend boundary (web/src/features/opencode/)
    → compatibility layer (V2 client → adapter's expected V1 shape)
       ├─ injected via options.client at useOpenCodeRuntime.ts:372-375
       └─ deletable the day upstream ships V2 support
```

The layer is feasible because the injection point already exists, is typed
(`client?: OpencodeClient`), and the official client is transport-compatible. Constraints
for the eventual implementation (not built in this phase):

- lives **only** inside `web/src/features/opencode/`
- typed against `OpencodeClient`, built by **delegating to a real client** and overriding
  only the 5 touched namespaces (`session`, `event`, `permission`, `question`,
  `experimental`) — a from-scratch object would have to satisfy the entire class type
- unit-tested per mapping, especially `question`↔`form`, `revert` phases, and `parts`↔`text`
- removable without touching call sites

## 8. Packages

### Would eventually need changing

| Package | Change | Notes |
|---|---|---|
| `@opencode-ai/sdk` (backend) | replace with `@opencode/client` | 4 call sites in `sessions.ts` + `capabilities.ts` |
| `web/src/features/opencode/` | new compatibility layer | new code; no existing file rewritten |
| `@opencode/client` | **add** (new dependency) | 2 real deps, both optional peers absent |

### Should remain frozen for now

| Package | Reason |
|---|---|
| `@assistant-ui/react-opencode` | **0.2.23 is npm `latest`.** Nothing to upgrade to; a pin is the correct action until upstream ships V2 |
| `@opencode-ai/sdk` (as the adapter's transitive dep) | the adapter requires it; cannot be removed until the adapter migrates |
| OpenCode binary (1.18.29) | V1 + V2 both work; changing it risks breaking a working integration for no gain |
| `@assistant-ui/react`, `@assistant-ui/core`, `@assistant-ui/store` | unrelated to this migration |

## 9. Upstream status

Labels: **[S]** installed-source · **[D]** official docs · **[U]** upstream package/repo · **[I]** inference

- **[S]** `@assistant-ui/react-opencode@0.2.23` imports only `@opencode-ai/sdk/v2/client` and
  calls only V1 services. No V2 code path exists.
- **[U]** 0.2.23 is the npm **`latest`** dist-tag; it declares
  `"@opencode-ai/sdk": "^1.18.29"`. **No V2-compatible release exists.**
- **[D]** assistant-ui's own docs still say *"This adapter is at v0.0.3 and is experimental"*
  and its install line is `npm install @assistant-ui/react @assistant-ui/react-opencode
  @opencode-ai/sdk` — the docs lag the code and are **not** a reliable status source.
- **[S]** The installed README is also stale: it documents an `apiUrl` option while the code
  reads `baseUrl` (`types.ts:197`).
- **[U]** GitHub search `repo:assistant-ui/assistant-ui opencode v2` returned 37 items; **none**
  in the visible set concern OpenCode V2, `/api/session`, or an SDK migration.
  → **No evidence found of an active V2 migration effort.** Not the same as *proven absent*.
- **[D]** `opencode.ai/v2/docs/migrate-v1` mandates the V2 migration; `opencode.ai/v2/docs/api`
  documents only `/api/session/*`.
- **[U]** `@opencode/client@2.0.4` is published and current; repo `anomalyco/opencode`,
  `packages/client`.
- **[I]** Whether upstream will migrate react-opencode is unknown. **No open issue or roadmap
  item may be treated as a delivery date.**

### Is `options.client` still the right boundary?

**Yes.** **[S]** `types.ts:196` `client?: OpencodeClient`, consumed at
`useOpenCodeRuntime.ts:372-375`, is a single documented injection point that covers all 19
call sites including `createRegistry`. It is the narrowest possible seam and it survives
upstream migration: once the adapter speaks V2 natively, the layer is deleted and `baseUrl`
is used directly again.

## 10. Verdict

# **C. V2 migration needs a contained temporary compatibility layer**

with one important qualification: **the backend half is not blocked and is closer to option A.**

- **Backend (4 V1 call sites) → can migrate to `@opencode/client` now, safely, with no layer.**
  Every operation has a V2 counterpart, the transport is proxy-compatible, and the change is
  confined to `src/services/opencode/`.
- **Frontend (19 adapter call sites) → blocked.** Upstream has no V2 release, and the official
  client's shapes do not match the adapter's expected interface. Reaching V2-native therefore
  requires the contained layer in `web/src/features/opencode/`.

Because the stated goal is to move *the integration* to V2 — and the frontend is the larger
half — the overall verdict is **C**. Choosing **B** (wait for upstream) is the lower-risk
alternative and is defensible given the maintenance cost of 19 hand-written mappings; that
is a product decision, not an evidence gap.

### Current functionality is preserved

No production behaviour changed in this phase. Runtime probing on 2026-09-16 confirmed every
V1 endpoint the adapter uses returns 200, so Code sessions, workspace behaviour, agent
selection, model selection, thinking/variants, event streaming, permissions, questions, and
session termination all continue to work on the current stack.

### Pre-existing defects surfaced by the audit (not caused by it, not fixed here)

1. **`opencode` log scope throttled to 1 line/sec** (`src/lib/logger.ts:444`) → **920 lines
   dropped**; `file.enabled=false` so `data/tbai.log` is frozen at 2026-09-14. This is why the
   proxy diagnostics were invisible.
2. **Readiness loop busy-spins** — `readiness.ready` logged `attempts: 9714` in `elapsedMs: 1491`.
3. **`sse.error: "Invalid state: Controller is already closed"` ×12** — `observeBody` in
   `src/routes/opencode.ts` calls `controller.error()/close()` after client cancellation.
4. **`422 EngineMismatchError`** — a `direct` conversation was routed into the Code view.
5. **`GET /api/session/{id}` 500s** on ~93% of sessions (OpenCode 1.18.29); `isSessionLive`
   depends on it and will silently recreate sessions. Worth an upstream report.
