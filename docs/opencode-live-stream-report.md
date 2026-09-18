# OpenCode Code-mode: the reply now streams live (2026-09-16)

Investigation and permanent fix for the reported bug: *in Code mode an AI reply is not
visible live, and the completed reply only appears after refreshing the page twice.*

Scope note up front: **this was not caused by the phase-1 backend V2 migration.** The
symptom predates it, the evidence below localises it to the browser's event subscription,
and nothing in this fix reverts or bypasses the V2 backend work. The frontend library
(`@assistant-ui/react-opencode@0.2.23`) is untouched and still V1-shaped, as required.

---

## 1. Exact root cause

OpenCode keys its event stream on a **directory**. The runtime subscribed without one.

| Request | What the server returns |
| --- | --- |
| `GET /event` | a **stub**: `server.connected`, then `server.heartbeat` every ~10 s. No session events, ever. |
| `GET /event?directory=<session dir>` | the **real stream**: `session.updated`, `message.updated`, `message.part.updated`, `message.part.delta`, `session.status`, `session.diff`, `text`. |

The frozen library subscribes like this (`OpenCodeEventSource.run()`):

```ts
const subscription = await this.client.event.subscribe(undefined, { … });
```

`undefined` is the parameter object — so no `directory`. The SDK's own URL builder
(`dist/v2/gen/sdk.gen.js`) declares `directory` as a valid query parameter for that route,
so the scope was available and simply not supplied.

Consequence: the browser held a perfectly healthy, reconnecting SSE stream that carried
**zero session events**. Measured during a live generation: connected for **91 s**,
delivering 1 × `server.connected` + 9 × `server.heartbeat` and **0** session events.

Nothing downstream was broken. The reply was persisted server-side the whole time, the
normalizer was never handed anything to normalize, and the runtime's own self-heal path —
`stream.reconnected` → `refreshInBackground()` → `load(true)` — never fires, because a
stub stream never drops and therefore never reconnects.

## 2. Exact failing boundary

**Outcome B/C — the event stream delivered no session events because it was subscribed
unscoped.** Not the proxy (it faithfully forwards the frame it is given), not
normalization, not state application, not React rendering, not persistence.

The A/B proof, run against the managed server **in the same time window while a generation
was running**, using the exact percent-encoded URL shape the SDK produces:

```
GET /event?directory=D%3A%5CTemp%5C…%5Cchats%5C<conversation>
  → server.connected, session.updated, message.updated, message.part.updated, …

GET /event
  → server.connected                       (only)
```

And a cheap, content-free confirmation in a later window (a session-title change, no
generation): scoped → `server.connected` + `session.updated`; unscoped → `server.connected`
only.

## 3. Exact file / function

| Layer | File | Symbol |
| --- | --- | --- |
| the failing call | `web/node_modules/@assistant-ui/react-opencode/src/OpenCodeEventSource.ts` | `run()` → `client.event.subscribe(undefined, …)` (library — not modified) |
| backend seam | `src/services/opencode/sessions.ts` | `ensureOpenCodeSession`, `fetchOpenCodeSession` |
| backend route | `src/routes/opencode.ts` | `POST /session` |
| frontend client | `web/src/features/opencode/eventScope.ts` | `createScopedOpenCodeClient` (new) |
| frontend runtime | `web/src/features/opencode/useOpenCodeRuntime.ts` | `useOpenCodeRuntime` |
| frontend view | `web/src/features/opencode/OpenCodeView.tsx` | `OpenCodeView`, `AgentRuntime` |

## 4. Event-stream behaviour (measured, not assumed)

Before the fix, on the browser's own request:

- stream opened, `sse.first_byte` at 71 ms, `sse.first_event` = `server.connected`;
- stayed open for 91 s with heartbeats;
- **zero** session events for the entire generation;
- closed only when the page was torn down (`reason=cancelled`).

After the fix, on the same instrument, one generation produced:

```
server.connected → session.updated → message.updated → message.part.updated
→ session.updated → session.status → message.updated → session.updated
→ session.diff → message.updated → session.status → …
```

with `message.part.delta` frames streaming the answer text. The stream is the same single
subscription it always was — only its scope changed.

## 5. Runtime lifecycle behaviour

No churn, and none introduced.

- React **StrictMode is not enabled** in this app (verified by grep), so the
  mount/unmount/mount cycle that would stress the registry does not occur.
- The library caches controllers across cleanup/remount by design
  (`createRegistry` → *"Keep controllers cached across React StrictMode cleanup/remount"*);
  `dispose()` only detaches subscriptions.
- The controller attaches its subscription from `subscribe()` via
  `ensureEventSubscription()` and detaches it when the last listener leaves. One controller,
  one event source, **one subscription** — the fix does not add a second.
- No abort was observed on a healthy load: the event fetch was not aborted while the
  session was in use.

The one new element is the runtime client, which is `useMemo`'d **on the scope alone**.
This matters: the library keys its whole controller registry (and therefore the
subscription) on client identity, so a client rebuilt per render would tear the
subscription down continuously. That is precisely the class of churn the fix must not add.

## 6. Identity / session behaviour

Audited: `conversationId` (TBAi) → `sessionId` (OpenCode) → `threadId` (assistant-ui) →
route param → active tab id.

- `OpenCodeView` posts `{ conversationId: agentId }` where `agentId` is the route param, and
  renders `AgentRuntime` **only once a session id exists**, so `initialSessionId` is never
  stale on first mount.
- The event source filters by session: `if (event.sessionId !== this.sessionId) return`.
  The scoped stream carries `properties.sessionID` on every session event (verified in the
  raw frame), so this filter passes rather than silently dropping everything.
- **The id and its scope are now resolved together and returned together**, so the client
  can never hold a session id without knowing how to address its stream. This was the
  structural gap: the scope was derivable server-side but was not part of the contract.
- Engine/scope identity was **inspected only** — no redesign.

## 7. Why refresh #1 changed state

Because nothing had reached the live path, each refresh was a **history reload** — the only
way state could ever advance. Refresh #1 ran `load()` and pulled whatever the server had
persisted by that instant. OpenCode emits **several sequential assistant messages per
prompt** (one prompt was measured producing 5 chained generations), so at refresh #1 the
conversation could legitimately still be mid-flight — the in-flight generation has no
`completed` time yet and is not yet in the persisted list. Hence "incomplete after one
refresh".

## 8. Why refresh #2 changed state

Same mechanism, one generation later: by refresh #2 more had been persisted, so the
reload picked up more. The two-refresh symptom was never about caching or rendering — it
was the live path delivering nothing while the server kept writing.

**After the fix this question no longer has an answer, which is the point.** Measured
counts across the acceptance run:

| Moment | DOM bubbles | assistant bubbles |
| --- | --- | --- |
| initial (fresh conversation) | 2 | 1 |
| after send #1 (live) | 4 | 2 |
| after send #2 (live) | 6 | 3 |
| **refresh #1** | **6** | **3** |
| **refresh #2** | **6** | **3** |

Refresh #1 and refresh #2 change **nothing**. There is no longer any gap between the live
state and the refreshed state.

## 9. Exact fix

**Backend — the scope becomes part of the session contract.**

- `ensureOpenCodeSession` now returns `OpenCodeSessionBinding` = `{ sessionId, directory }`.
  The directory is read from the **server's own session record** — `location.directory`
  (the V2 shape `@opencode/client` types) with a top-level `directory` fallback (the shape
  1.18.x returns on its V1 route) — **not** re-derived from TBAi's folder table, so it stays
  correct after a workspace migration.
- The liveness probe was refactored into `fetchOpenCodeSession`, with
  `isOpenCodeSessionLive` kept as a thin predicate over it, so the documented OpenCode
  1.18.29 "500 = directory gone, session still live" rule lives in exactly one place and all
  existing liveness tests keep their exact semantics.
- `POST /api/opencode/session` returns `{ sessionId, directory }`.

**Frontend — the subscription gets its scope.**

- `createScopedOpenCodeClient(baseUrl, directory)` builds the runtime's client and overrides
  **only** `client.event.subscribe`, merging `directory` into the parameters the library
  passes. Same subscription, same lifecycle, same reconnects.
- Every other request is left **byte-identical**. Scoping the whole client through the SDK's
  `directory` option was rejected: its request interceptor would also rewrite history and
  permission calls, and that blast radius is not needed to fix the event stream.
- `directory: null` (server reported none) returns the client **unscoped** — the previous
  behaviour — rather than guessing a path.
- `directory` is a **documented parameter of that route in the OpenCode V2 SDK**, so this is
  the supported way to address one session's stream, not a workaround.

Explicitly **not** done: no second runtime, no library patch, no revert to V1, no proxy
change, and none of the forbidden masks — no `window.location.reload()`, no router refresh,
no automatic second fetch, no polling, no delayed forced re-render, no arbitrary timeout,
no duplicate subscription, no global cache invalidation.

## 10. Regression test

`web/src/features/opencode/liveStream.test.ts` — three deterministic tests, no browser, no
network, no model. They drive the **real** library chain (the app's own client wrapper, the
library's `OpenCodeEventSource`, `OpenCodeThreadController` and projection) against a fake
server that reproduces the measured stub/scoped split.

1. **scopes the event subscription, applies streamed events, and needs no history reload** —
   asserts the request carries `directory`, then streams `message.updated` +
   `message.part.updated` and asserts the assistant text reaches the projected thread state
   with `historyLoads() === 0`. This is the whole chain: *send → streamed event → runtime
   state updated → response visible*, with no refresh, no remount and no second history load.
2. **an unscoped subscription really is starved of session events** — pins down *why* the fix
   is the scope, so the fixture cannot silently become a tautology.
3. **scopes only the event stream** — asserts history and session requests carry no
   `directory` / `location[directory]`, i.e. the blast-radius guarantee.

**Mutation-checked:** with the scope disabled, test 1 fails — and it fails exactly at the
boundary (`server.scopedCount() > 0` never becomes true). A regression test that cannot fail
would have been worthless.

Supporting tests: `src/services/opencode/sessions.test.ts` gained six cases covering the new
binding (V2 shape, V1 shape, V2-preferred-when-both, no-scope-reported, the 1.18.29 500 case,
and recreate-when-genuinely-gone). `tests/integration/engine-guards.test.ts` now asserts the
directory travels with the id on the create path.

## 11. Test results

```
bun run test       604 pass, 2 skip, 0 fail  (606 tests across 66 files)
focused suites      63 pass, 0 fail           (src/services/opencode/ + engine-guards)
sessions.test.ts    21 pass, 0 fail
liveStream.test.ts   3 pass, 0 fail
```

The 2 skips are the pre-existing "no existing thread in this database" guards.

## 12. Typecheck

```
bun run typecheck   →  clean (backend tsc + web tsc), exit 0
```

Note: this initially failed with 64 syntax errors — **all** of them in an untracked scratch
file, `scripts/perf.ts`, which had been saved with assistant prose injected mid-file
(a truncated first copy, then a complete second copy behind a ` ```ts ` fence). Repaired by
keeping the complete copy; the corrupt original is preserved at
`D:/tmp/perf.ts.corrupt-backup`. **Zero errors in any file this fix touched.**

## 13. Build

```
bunx vite build --outDir <fresh dir>   →  ✓ built, 3516 modules transformed, exit 0
bun run build                          →  blocked by the sandbox, not by the code
```

`bun run build` runs `tsc` (clean) and then `vite build`, which transforms all **3516
modules successfully** and then fails while emptying `web/dist/assets`:

```
[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":320,"threshold":50,…}
  at checkBulkDeleteGuard (…/node-safe-delete-shim.cjs)
  at emptyDir (vite/dist/node/chunks/…)
```

This is this environment's bulk-delete guard refusing Vite's routine `emptyDir` of its own
output directory (320 files, threshold 50) — an environment constraint, not a compile
error. Building to a fresh output directory succeeds outright, and that is what the browser
verification was served from. **The user's own `bun run build` (outside this sandbox) is
expected to pass; it should be re-run to confirm.**

## 14. Browser verification (warm server, real generations, real UI)

Warm managed OpenCode server, real model (`opencode/nemotron-3.5-lightning-free`), real
browser (headless Edge via Playwright), fresh conversation, served from the fixed bundle.
Assertions read the **assistant** bubbles only — the marker also appears in the user's own
prompt text, which would otherwise be a false positive.

```
PHASE 1 — send "liveoned3e43", watch WITHOUT refreshing
  LIVE ✅ visible after 38 425 ms
PHASE 2 — send "livetwod3e43", watch WITHOUT refreshing
  LIVE ✅ visible after 31 246 ms
PHASE 3 — refresh #1: marker1=true marker2=true
PHASE 4 — refresh #2: marker1=true marker2=true

REQUEST TRAIL
  event requests: 3 (scoped=3 unscoped=0)
  GET /api/opencode/event?directory=D%3A%5CTemp%5Cai-chat-app%5Cworkspace%5Cchats%5Cahpmdzob56zjmkgl7r765mh6

RESULT live1=PASS live2=PASS refresh1=PASS refresh2=PASS
```

And on the backend's own instrument, the browser's subscription is now:

```
proxy.request method=GET pathname=/event sseOriented=true
  upstreamUrl=http://127.0.0.1:59864/event?directory=D%3A%5CTemp%5C…%5Cchats%5Cahpmdzob56zjmkgl7r765mh6
```

**All 3 event requests scoped, 0 unscoped.** The exact failing boundary is closed.

One caveat stated plainly: this is DOM-text evidence captured programmatically in headless
Edge, not a human looking at the screen. The rendered result should still be confirmed by
eye once.

---

## Incidental findings (not part of the fix)

- **A benign 400 on `POST /api/opencode/session`.** `OpenCodeView`'s effect aborts its
  in-flight init request on cleanup; the request still reaches the server, so
  `c.req.json()` rejects, the route's `.catch(() => ({}))` yields `{}`, and the schema
  answers 400. It is logged as `http.error` with `durationMs=1` and is harmless (the init is
  idempotent and re-runs), but it is noise worth silencing later.
- **`sse.error Invalid state: Controller is already closed`** at debug level when a page is
  torn down: the proxy's diagnostic body observer tries to enqueue after the consumer
  cancelled. Pre-existing, diagnostic-only, no effect on delivery.
- **Frontend debug logging is compiled out of production builds**
  (`web/src/lib/logger.ts`: `import.meta.env.DEV ? "debug" : "warn"`), so the frontend
  `opencode.history.*` / `opencode.runtime.*` diagnostics added for this investigation do not
  appear in a production bundle. The server-side `opencode.proxy.*` / `opencode.sse.*`
  instrument carried the proof instead.
- **The dev conversation used for probing** (`yo0ur84uz1v3ssvdfyb38mgw`) accumulated many
  probe messages and several chained assistant generations, and its OpenCode session title
  was changed to `scope-probe` during the A/B test. The acceptance run used a separate fresh
  conversation (`ahpmdzob56zjmkgl7r765mh6`).
- **A fresh OpenCode conversation has no model**, so its first prompt used the server default
  and failed with `credit insufficient balance`. Setting `opencodeModel` on the conversation
  is what makes Code mode usable — worth knowing when testing, unrelated to this bug.
