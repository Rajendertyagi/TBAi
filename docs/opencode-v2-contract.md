# The OpenCode V2 integration contract

What TBAi relies on when it talks to OpenCode, and where each fact comes from.

## The authority is the installed type surface, not the published prose

**The authoritative surface is the installed `@opencode/client` type
contract.** The published OpenCode prose describes **V1** - it names routes and
environment variables that V2 renamed or re-scoped - so it is not evidence about
V2 behaviour.

This is not a preference. Two concrete cases:

| Surface | The published prose says | The installed V2 contract does |
|---|---|---|
| Auth password env var | `OPENCODE_SERVER_PASSWORD` | `OPENCODE_PASSWORD` first, `OPENCODE_SERVER_PASSWORD` as the legacy fallback (`packages/cli/src/env.ts`) |
| Route list | The V1 route set | The V2 route set, which differs (39 routes gained a DECLARED 404 in the 2.1 client) |

Where the two disagree, **the type surface wins**, and the disagreement is
recorded here rather than resolved silently.

## Versions

| Thing | Version | Where it is pinned |
|---|---|---|
| Official client (`@opencode/client`) | **2.1.2** | `package.json` and `web/package.json` |
| Managed server, supported range | **`>=2.0.15 <2.2.0`** | `src/config/opencode.ts` |
| CI's pinned server binary | **2.1.2** | the CI workflow, with npm's `dist.integrity` re-verified |
| Upstream source read for this work | **2.0.32** (an audit-time local checkout; the pinned, tested surface is the **2.1.2** release above) | `packages/cli/src/env.ts`, `packages/opencode/src/server/…` |

The supported range's **lower half is unchanged**, so a 2.0.x server is still
supported. That direction was checked too: the 2.1.2 client against a real,
integrity-verified **2.0.22** server passes the same real-server suites.

Every surface TBAi uses was compared at `v2.1.0`, `v2.1.1` and `v2.1.2` - all
three are identical on every surface TBAi touches: **no route removed**, **no
event type removed**, and the imported types compatible (the ids became
branded aliases, every one of them `= string`).

## Documented versus empirically verified

This is the distinction the contract exists to keep honest.

**Empirically verified on this machine, against a real 2.1.2 server:**

- the Code view's session boundary (11 cases),
- the session and session-list suites,
- the capabilities catalogue,
- the client and client-status observations,
- the auth proxy,
- the runtime authentication,
- the first-send draft handoff.

**Verified against the upstream SOURCE but not against a live server:**

- the auth env-var precedence (`packages/cli/src/env.ts`),
- the permission precedence model (§3.5.1 of the remediation plan),
- the event and route surfaces at the 2.1.x tags.

**Documented upstream but NOT relied on:**

- the published `docs/server.md` and `docs/cli.md` prose, for the reasons in
  the table above.

### The HTTP surface, probed against a real 2.1.4 server

The 2.1.4 build answers the API under `/api/*` and serves its own **web app**
everywhere else. Probed on 2026-10-26 in a throwaway config home, with and
without the Basic credential:

| Request | Result on 2.1.4 |
|---|---|
| `GET /api/info` (authenticated) | `200 application/json` — `{version, pid, urls, paths, capabilities}` |
| `GET /api/info` (no credential) | `401` — `{"_tag":"UnauthorizedError",…}` |
| `GET /api/config` (authenticated) | `200 application/json` — the config document array |
| `GET /api/config` (no credential) | `401` |
| `GET /global/health`, `GET /doc`, `GET /config`, `GET /readyz` | `200 text/html` — the **SPA shell**, not API JSON |
| `GET /api/server/instance` | `404` |

Two consequences, both load-bearing:

1. **`readinessProbePath` must stay `/api/info`.** The health/docs paths one
   finds in upstream prose are not the V2 API on this build; `waitForHttpReady`
   would poll an HTML page forever and fail with a misleading timeout.
2. **A `200` is not readiness.** `/global/health` returns `200` with `text/html`
   to an unauthenticated request, so a status-only check would accept the web
   app. `probeOpenCodeInfo` requires a JSON body carrying an in-range `version`,
   and an HTML `200` is asserted to classify as `not_ready`
   (`tests/integration/opencode/serverManager.test.ts`, "reports not ready for
   an HTML 200").

`/api/server/instance` is TBAi's own route (the desktop shell's identity
handshake), not an OpenCode route — the probe above confirms OpenCode does not
serve it.

**The one place the two surfaces differ in a way TBAi must handle.** The 2.1
client gained a **declared 404** for 39 routes, exactly one of which is a route
TBAi calls: `GET /api/permission/request`. The client's declaration changed;
the server's behaviour for that route did not. The client therefore throws a
**tagged** error for a missing location, which is the same class the error
classification already handles.

## The error shape the client actually throws

This is the one that bit, and it is worth stating plainly because the
assumption it replaces was reasonable and wrong.

**The official client DISCARDS the HTTP status on every error it throws.**

- a **declared** error is thrown as a **tagged** error with **no `status`**;
- an **undeclared** one carries the status in `cause.status`;
- a **transport** failure is a `ClientError` with `reason: "Transport"`.

So every classification that read `error.status` was reading `undefined`. The
consequences were user-visible: a permission the server had forgotten was
never retired, a form the server had already settled surfaced as an error, and
a prompt the server refused was never recognised as a refusal.

The classification now uses **the client's own exported guards**
(`web/src/features/opencode/clientErrors.ts`). A **409 is not a refusal**:
`ConflictError` and `SessionBusyError` are the client's own classes for it, and
both mean "not now", not "no".

## The event surface

The reduction is owned by `web/src/features/opencode/v2Events.ts`, and the
event scope is checked against the subscribed directory: an event that names a
different workspace in its official `location` is not applied to the view.

An event's **durable sequence** is what makes the history reconciliation
possible. The reconciliation rule is D1: a snapshot **always** preserves the
live events observed after its read began, and the snapshot-confirmed deletion
is the only removal the merge may perform.

## The route boundary

`/api/opencode/*` forwards only the routes the **browser's client** actually
calls (`src/services/opencode/proxyRoutes.ts`). Everything else the managed
server exposes - the shell, the filesystem reader/writer, credential storage,
config writes, RPC, MCP registration, PTY, plugin updates - is refused before
any upstream request is made. An **allowlist** is used rather than a blocklist,
so a route added upstream later is unreachable by default.

## The workspace boundary

The caller never chooses the working directory. The proxy resolves the session
the request names - `session -> conversation -> folder -> absolute directory` -
strips the caller's `x-opencode-directory`, `x-tbai-session` and
`location[directory]`, and forwards the server's own directory.

A session id is a **selector** over workspaces the local database already knows
about; it can never name an arbitrary path. An unknown session, a session
header that disagrees with the path, and an unresolvable workspace are all
refused.

## The configuration boundary

`GET /api/opencode/config` returns a **projection** in which every
credential-bearing value is masked: provider `settings` / `headers` / `body`,
MCP `environment` / `headers` / OAuth client secrets, plugin and LSP
environment values, and any key that names a credential. The `{env:VAR}` and
`{file:path}` substitution forms are masked whole, because the reference itself
names the secret.

The file on disk keeps its real values, and the write path reads the file - so
the preservation guarantee is untouched.

## Where the wire shapes live

- the installed types: `node_modules/@opencode/client`
- the event reduction and the state machine: `web/src/features/opencode/v2Events.ts`
- the per-layer owner table: `web/src/features/opencode/sync/ownership.md`
- the audit and the findings: `docs/2026-10-20-opencode-runtime-remediation-plan.md`
- the decisions: `docs/decisions.md`

## When the client is upgraded

The typecheck is the first gate, and it is the one that matters: the installed
client's types are what TBAi compiles against, so a breaking change in the
wire shapes fails the build rather than failing at runtime.

Then, in order:

1. re-check the route list against the new client (the allowlist is derived
   from the client, so a new route the browser starts calling is a gap);
2. re-check the event types (a removed event type is a silent gap in the
   reduction);
3. re-run the **real-server** suites - the ones listed as "empirically
   verified" above - against the new binary, not just against a mock.

The version gate moves with the client, and the CI binary's
`dist.integrity` is re-verified whenever it moves: the tarball is downloaded,
hashed, and the binary is run to confirm the version it reports.
