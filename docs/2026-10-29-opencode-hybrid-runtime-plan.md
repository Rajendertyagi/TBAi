# TBAi OpenCode Hybrid Runtime — Implementation Plan (revision 15, Windows-only)

**Status:** revised proposal for review. **Nothing implemented.** No source, test, config,
dependency, lockfile, or documentation file changes accompany this document beyond the document
itself.

**Date:** 2026-10-30 · **Baseline commit:** `b440e207d1e748e1220f462ceb460a02a1bf9d7a`
(branch `ci/tauri-e2e-verify`)

**Platform scope:** Windows packaging and CI targets are **VERIFIED (code/config)**:
`tauri.conf.json` targets only `nsis` (Windows installer); CI build matrix (`tauri-build.yml`)
runs only on `windows-latest` with `x86_64-pc-windows-msvc` target. Whether the product
officially supports only Windows at runtime is **INFERRED** from these targets — no explicit
product-support decision document was found. The plan assumes Windows-only scope but labels this
assumption as inferred, not verified.

**Verdict: NOT APPROVED FOR IMPLEMENTATION** — four owner decisions (B1, H3, H5, B7) are
outstanding, plus the evidence gap B5, the Windows symlink residual labelled UNKNOWN in §2.4,
and the request-context design gap (B8) in §1.9.

---

## 0. Evidence standard used in this document

Every critical claim carries one label:

| Label | Meaning |
|---|---|
| **VERIFIED (code)** | Read from this repository or from `node_modules` on disk during this revision. Line references are to the working tree at the baseline commit. |
| **VERIFIED (probe R4)** | Produced by a command **run during revision 4**, in a disposable temp root, against a process this agent started and stopped itself. |
| **VERIFIED (probe R5)** | Produced by a command **run during revision 5**, in a disposable temp root, against loopback stubs and temp files this agent created and removed itself. |
| **VERIFIED (probe R6)** | Produced by a command **run during revision 6**, in a disposable temp root, against files this agent created and removed itself. |
| **VERIFIED (probe R7)** | Produced by a command **run during revision 7**, in a disposable temp root, against files this agent created and removed itself. |
| **REPORTED (probe R2/R3)** | Produced during revision 2 or 3 of this plan in this same session and **not rerun**. Treated as reported evidence, never as independently verified. |
| **INFERRED** | Follows from code or from a measured fact but was not measured itself. |
| **UNKNOWN** | Not established. Where it matters, the plan states the conservative behavior it adopts instead of guessing. |

### 0.1 Revision 15 change log against revision 14

| # | Change | Section |
|---|---|---|
| 1 | **Restored §1.9 request-context design.** The section was missing from the saved document despite being referenced in the change log. Restored with corrected design: managed password explicitly included in captured state; transport-level credential injection specified as recommended enforcement; state-transition semantics reconciled with §1.5; race tests revised to test realizable concurrency boundaries. Request-context consistency remains a blocking design gap (B8). | §1.9 |
| 2 | **Corrected §6.4 timeout claim.** Removed "Callers can configure this via `EnsureOptions` timing overrides." `DiscoverOptions` exposes only `file` and `version`. `EnsureOptions` does not expose a public timeout/timing-override field. `withEnsureTiming()` is a separate internal timing helper. `discover()` calls `registered(options.file)` without an explicit timeout. `probeResult()` uses default 2,000 ms. Promise registration-file read has no supplied signal or full-operation deadline. | §6.4 |
| 3 | **Qualified §2.5 registration writer claim.** Temp-file-plus-rename is VERIFIED (code), but "new inode via rename" is not established by source alone. Distinguished source-verified write sequence, filesystem-specific identity behavior, runtime probe evidence, and external in-place modification residual. | §2.5 |
| 4 | **Fixed §2.2 channel contradiction.** `latest`, `beta`, and `next` all use `service.json`. Removed incorrect claim that beta users won't find the registration. Explained that exact-version gating is the only reliable gate; channel cannot be distinguished from the registration schema. | §2.2 |
| 5 | **Corrected platform scope evidence.** §7: Windows packaging and CI targets labelled VERIFIED (code/config). Product-wide Windows-only support labelled INFERRED (no explicit product-support decision found). | §7 |
| 6 | **Reconciled independent-review register.** §14 updated to distinguish historical defects from current proposed controls. Added findings 31–37 from Revision 11–13 corrections. | §14 |
| 7 | **Updated blocker list.** §13 now includes request-context design gap (B8) as a blocking design issue. | §13 |
| 8 | **Updated verdict narrative.** §16 includes Revision 15 corrections. | §16 |

### 0.2 What this revision does **not** do

It does not decide H3, H5, H1, H2, H4, B1, or B7, and does not treat the recommendation in §4 as an approval.
It does not implement, and does not claim any earlier probe was rerun when it was not (R2/R3 remain reported).
It does not contact, restart, stop, signal, or interfere with the user's real OpenCode service, and does not read,
print, reproduce, or log any provider API key, service password, authorization header, or encoded credential.

---

## 1. Review item 1 — the missing-password path (blocking)

### 1.1 Why `null` was not a cosmetic bug

Three facts, each **VERIFIED (code)**, compose into a credential-disclosure path:

1. `getOpenCodeAuthPassword()` lazily **generates** a password (`randomBytes(32)`,
   `runtime.ts:144-159`) and `getOpenCodeAuthHeaders()` **always** returns a Basic header
   (`runtime.ts:171-177`). There is no code path that returns `{}` today.
2. Every request path obtains its header from that one function: the proxy and the permission
   writer through `configServerTarget()` (`routes/opencode.ts:216-225`), the native client at
   construction (`client.ts:51-66`, six production call sites).
3. Revision 3 allowed an adopted mode whose stored password was `null`, expecting "no header".

Composed, the sequence is: adoption succeeds against a service that answered without a credential
→ the adopted origin becomes the base URL → the next proxied request calls
`getOpenCodeAuthHeaders()` → the `null` adopted value falls through to the managed password →
**TBAi's own generated Basic credential is sent to a process the user started outside TBAi.** That
is a leak to a third-party origin, not a 401.

### 1.2 Is an unauthenticated adopted mode needed? No.

**VERIFIED (probe R4)**, on a self-started `opencode serve --service` in a temp root:

```
first={"keys":["id","password","pid","url","version"],"version":"2.2.0","url":"http://127.0.0.1:42075","pid":5492,"hasPassword":true,"pidIsInteger":true}
api_info={"status":200,"bodyPid":5492,"bodyVersion":"2.2.0","pidEquals":true}
api_info_without_auth_status=401
```

A registered service always writes a `password` into its registration and **rejects an
unauthenticated `/api/info` with 401**. So an unauthenticated adopted mode would be unusable
against the very service this feature exists to adopt. It is removed, not kept as an option.

### 1.3 The rule

> A registration with a missing, empty, or whitespace-only `password` is refused as
> `missing_credential` **before any network request and before any header is constructed.**
> Adoption state cannot exist without a credential — this is enforced by the type, not by a
> runtime branch.

Consequences of the refusal are the ordinary fallback: the managed path runs. Nothing is installed,
nothing is sent.

### 1.4 Authentication state, as one value

`src/services/opencode/runtime.ts` keeps the single source of truth. Replacing three loose
module-level variables with one atomic value is what removes the "`null` means two things" defect:

```ts
/** Installed only after a probe succeeds. Absent means "managed mode". */
export type AdoptedCredential = {
  readonly origin: string;   // canonical origin, never a response field
  readonly password: string; // non-empty by construction
};

export function buildOpenCodeBasicAuthHeader(
  password: string,                       // non-empty; no null overload exists
  config: OpenCodeConfig = OPENCODE_CONFIG,
): Record<string, string>;

export function installAdoptedCredential(credential: AdoptedCredential): void;
export function clearAdoptedCredential(): void;
export function getOpenCodeAuthScope(): string | null;   // adopted origin, else null
export function getOpenCodeAuthHeaders(config?: OpenCodeConfig): Record<string, string>;
```

- `buildOpenCodeBasicAuthHeader` is **pure** and takes a `string`. There is no `null` parameter and
  no overload that yields `{}`; an empty string throws `OpenCodeCredentialError` (TypeScript cannot
  constrain JSON, so the guard stays, but no caller reaches it because §1.3 refuses first).
- `installAdoptedCredential` assigns **one object** in one statement, so there is never a moment
  with a password installed and no origin, or an origin with no password.
- `getOpenCodeAuthHeaders()` reads that one object: present → the adopted header; absent → the
  managed header, byte-identical to today (`runtime.ts:171-177`).
- `getOpenCodeAuthScope()` returns the adopted origin, and `client.ts` refuses to attach a
  credential to any other base URL while adoption is active:

  ```ts
  // client.ts — the one place a credential meets a destination
  const scope = getOpenCodeAuthScope();
  if (scope !== null && canonicalOrigin(baseUrl) !== scope) throw new OpenCodeAuthScopeError(...);
  ```

  This is what makes "every credential-bearing request targets only the validated origin" a
  property of the code rather than a property of six call sites' discipline.

### 1.5 The complete transition trace

| Stage | State (`AdoptedCredential` / mode) | Which credential is sent | Failure behavior |
|---|---|---|---|
| Process start | absent / `unresolved` | managed (generated or env) | — |
| Discovery: read + validate | absent | **none yet** — no header constructed | any refusal → absent, unchanged |
| Discovery: candidate probe | absent (header built from the argument, not from state) | the **candidate** password, to the candidate origin only | 401 → `unauthorized`; absent, unchanged |
| Adoption success | `{origin, password}` installed, mode `adopted` | adopted | — |
| First proxied request | `adopted` | adopted, to `scope` only | `createChild` refuses to run; a foreign base URL throws |
| Fallback (any failure) | absent | managed, exactly as before | the pre-call header deep-equals the post-call header |
| Revalidation, same password | re-installed after a successful probe | adopted | failure keeps the previous object |
| Revalidation, rotated password | replaced after a successful probe | the new one | failure keeps the **old** one (still valid if the service is merely slow) |
| Shutdown, adopted | cleared; mode reset | nothing after shutdown | managed state is untouched and still usable |
| Shutdown, managed | unchanged | — | today's spine |

`createChild()` asserts `getOpenCodeAuthScope() === null` before touching the managed password, so
a managed child can never be spawned while an adopted credential is installed.

### 1.6 Acceptance tests

| ID | Test | Assertion |
|---|---|---|
| A1 | **Missing password**, otherwise healthy stub | Outcome `missing_credential`; the stub records **zero** requests; no header is constructed (builder spy); mode `managed` |
| A2 | **Empty / whitespace password** | Same as A1, three fixtures (`""`, `"   "`, key absent) |
| A3 | **Wrong password → 401** | `unauthorized`; `installAdoptedCredential` spy not called; `getOpenCodeAuthHeaders()` deep-equals its pre-call value |
| A4 | **Valid password** | Stub receives `Basic base64("opencode:<registration pw>")`; `installAdoptedCredential` called exactly once; scope equals the canonical origin |
| A5 | **Every failure path preserves the prior credential** | For each of {missing, empty, 401, 500, redirect, timeout, bad body, untrusted URL, oversized, non-regular, replaced, in-place mutation, platform unsupported}: active headers deep-equal their pre-call value |
| A6 | **Subsequent authenticated requests** | After adoption, `configServerTarget()` and `createOpenCodeClient(origin)` send the adopted header; **the managed password value never appears in any request to the stub** (spy on the generated value) |
| A7 | **Revalidation, same password** | One probe, one install, header equals the registration's |
| A8 | **Revalidation, rotated password** | Probe uses the new candidate; success replaces the header; failure keeps the old one |
| A9 | **Shutdown isolation** | Adopted → shutdown → scope is `null`, `createChild()` is permitted again, and the header equals the managed one (the managed password was never cleared or replaced) |
| A10 | **Scope enforcement** | In adopted mode, `createOpenCodeClient("http://127.0.0.1:1")` throws `OpenCodeAuthScopeError` and performs no request |
| A11 | **Redaction** | Logger spy and every thrown error across A1–A10 contain neither a password nor its base64 form |
| A12 | **Ownership guard** | Source scan: base64 Basic construction for OpenCode auth exists only in `runtime.ts`; `serviceAdoption.ts` contains no `base64` and no `Buffer.from` for credentials |
| A13 | **Client created before adoption is not reused** | A client constructed in managed mode and held across an adoption transition is not reused; the next request constructs a fresh client against the adopted origin with the adopted header; the managed password never appears |

### 1.7 Credential scope, end to end (re-check)

Re-evaluated against every request path mapped in §1.8.

- **Initial probe builds a header from the candidate password without installing it.** The probe calls
  `buildOpenCodeBasicAuthHeader(candidatePassword)` and passes the result as `authHeaders` to
  `probeOpenCodeInfo`. `installAdoptedCredential` is called only after the probe returns `ready`.
  A failed probe leaves the installed state untouched (A3, A5).
- **Credentials are associated with the canonical adopted origin.** `AdoptedCredential.origin` is
  the slash-free canonical origin produced by §8.2, never a field read from the registration's
  `url` without canonicalization. The registration's `url` is validated first; only then is the
  origin stored.
- **All later native-client requests are constrained to that origin.** `createOpenCodeClient`
  performs the scope assertion at construction (§1.4). In addition, the bounded transport
  (§1.8, §8.6) checks the origin of **every outgoing request** before sending, so a client
  constructed with the right base URL cannot be redirected or re-targeted later.
- **The proxy and configuration utilities enforce the same destination boundary.** The proxy
  (`routes/opencode.ts`) attaches `getOpenCodeAuthHeaders()` to a URL it builds from the
  adopted base URL stored in the manager; it never accepts a destination from the browser. Config
  reads/writes go through `configServerTarget()` → `ensureBaseUrl()` → the adopted origin. There is
  no code path that takes a destination URL from request input and attaches a credential to it.
- **A redirect response is handled without following it.** See §1.8.
- **Revalidation with a rotated password.** The reattach loop (§8.3) re-runs discovery against the
  same canonical origin; on success it calls `installAdoptedCredential` with the new password,
  replacing the object atomically. On failure the previous object remains installed (A8).
- **Revalidation failure while an older credential is installed.** The old credential stays valid
  for the duration of the failure; it is cleared only on `lost` (D7), never on a transient failure.
- **Shutdown clears adopted state without altering the managed credential.** `clearAdoptedCredential`
  sets the adopted slot to absent; it does not touch `authPassword`/`authSource`/`authInitialized`
  in `runtime.ts`. The managed header is byte-identical before and after (A9).
- **Managed child startup is prevented while an adopted credential remains installed.**
  `createChild()` asserts `getOpenCodeAuthScope() === null` and throws otherwise (§1.5).
- **Clients created before adoption.** The native client is constructed per call site with the
  base URL resolved at that moment; it is not cached across mode transitions. A client created in
  managed mode carries the managed header and the managed base URL and is discarded when the call
  completes. After adoption, subsequent calls construct clients against the adopted origin with the
  adopted header. There is no long-lived client that could retain stale credentials. This is
  asserted by A6 (managed password never appears in any request after adoption) and by A13.
- **Config transport is mandatory.** `readOpenCodeConfigDocument(baseUrl, headers, transport)` now
  requires the transport. There is no default. A caller that omits it is a compile-time error.
  The transport is constructed via `createBoundedTransport(baseUrl, credential)` at the call site,
  so the credential and origin are always paired correctly. See §9 and §1.8.4.

### 1.8 Redirect policy and authenticated request inventory (blocking)

Revision 4 protected only the initial `/api/info` probe. Subsequent requests were not protected.
This section maps every credential-bearing OpenCode request path and states one consistent policy.

#### 1.8.1 Audit of credential-bearing request paths

| # | Path | File:lines | Destination construction | Credential attachment | Redirect policy |
|---|---|---|---|---|---|
| P1 | Adoption probe (`/api/info`) | `serverManager.ts:109-135` | `` `${baseUrl}${path}` `` from canonical origin | `authHeaders` argument (candidate password) | Bounded transport (origin check + manual + 3xx → typed error) |
| P2 | Native client (all methods) | `client.ts:35-66` | `new URL(descriptor.path, baseUrl)` inside `@opencode/client` | `options.headers` (adopted or managed) | Bounded transport as `options.fetch` |
| P3 | Config read | `configDocument.ts:140-144` | `new URL("/api/config", baseUrl)` | `headers` argument | Bounded transport (required parameter) |
| P4 | Config write | `configDocument.ts:584-609` | filesystem (`Bun.write(path, …)`) | none (no HTTP) | n/a — filesystem; path validated separately (§1.8.4) |
| P5 | Proxy (browser → OpenCode) | `routes/opencode.ts:565-666` | `url` built from adopted/managed base URL + request path | `getOpenCodeAuthHeaders()` set onto upstream headers | **Bounded transport** (not a separate `fetch` with `redirect: "manual"`) |
| P6 | Permission writer | `routes/opencode.ts:240-259` | via `configServerTarget()` → P3/P4 | via `configServerTarget()` | fixed via P3 |
| P7 | Version preflight (`--version`) | `serverManager.ts` (binary spawn) | CLI, no HTTP | none | n/a |
| P8 | DB path probe (`debug paths db`) | `ownership.ts:124-178` | CLI, no HTTP | none | n/a |
| P9 | Healthz | `routes/server.ts:108` | `http://127.0.0.1:${port}/healthz` | none | n/a — no credential |
| P10 | Model discovery | `services/modelDiscovery.ts:43` | caller-supplied URL | caller-supplied `init` | **not an OpenCode credential path** — no `getOpenCodeAuthHeaders()`; out of scope, documented as exempt (§1.8.4) |
| P11 | MCP transport | `services/mcp/transport.ts:262` | caller-supplied URL | caller-supplied | **not an OpenCode credential path** — out of scope (§1.8.4) |

**VERIFIED (code)** for P1–P9 locations and credential attachment. P10/P11 confirmed by grep: neither imports `getOpenCodeAuthHeaders` or `runtime.ts`.

**Credential-bearing paths:** P1, P2, P3, and P5 carry OpenCode credentials. P4 is a filesystem write (no HTTP, no credential). P6 inherits from P3/P4. P7, P8, P9 carry no credentials. P10 and P11 do not attach OpenCode credentials (out of scope).

#### 1.8.2 Measured redirect behavior (probe R5)

| Measurement | Result | Label |
|---|---|---|
| `fetch(url, {redirect: "manual"})` to a server returning 302 | status `302`, `Location` readable, target receives **zero** requests | **VERIFIED (probe R5)** (p1) |
| `fetch(url)` (default) to a server returning 302 to a different origin | follows to target; target receives the request; `Authorization` header is **stripped** by Bun on the cross-origin hop | **VERIFIED (probe R5)** (p2) |
| Same-origin 307 with default fetch | follows; target receives the request **with the `Authorization` header and the POST body preserved** | **VERIFIED (probe R5)** (s1) |
| `@opencode/client` with no wrapper | follows the redirect; target receives the request; no error | **VERIFIED (probe R5)** (p4) |
| `@opencode/client` with a forcing wrapper (`redirect: "manual"` + 3xx → throw) | target receives **zero** requests; client throws `ClientError` | **VERIFIED (probe R5)** (p5) |
| The client passes a `URL` object (not a string or `Request`) to fetch | `ctor=URL` | **VERIFIED (probe R5)** (probe3) |
| Thin wrapper preserves POST body | body arrives intact | **VERIFIED (probe R5)** (s2, s3) |
| Proxy passthrough copies `Location` (no hop-by-hop removal of it) | `responseHeaders = new Headers(upstreamHeaders)` includes `Location`; hop list does not contain `location` | **VERIFIED (code)** (`routes/opencode.ts:621-630`) |

Two consequences drive the policy:

1. **Cross-origin redirects strip the credential in this Bun build, but the request still reaches the
   target** — a boundary violation even without credential forwarding, and the stripping is an
   implementation detail, not a contract.
2. **Same-origin redirects forward the credential and the body** — a 307 on an OpenCode endpoint
   would replay an authenticated POST (e.g. a config write) to a different path on the same server
   with the credential attached. Refusing only cross-origin redirects would leave this open.

Therefore the policy is **refuse all redirects**, not "refuse cross-origin redirects."

#### 1.8.3 The policy and the shared enforcement mechanism

> **Every credential-bearing OpenCode request refuses redirects.** No redirect is followed, including
> same-origin redirects. A 3xx response is treated as a failure (`redirect_refused`), never as a
> destination. No credential is attached to any destination other than the validated canonical origin,
> and the origin is checked on every outgoing request, not only when a client is constructed.

**Consistency resolution.** The proxy uses the bounded transport. It does **not**
call `fetch(url, init)` directly and does **not** set `redirect: "manual"` itself. On
`OpenCodeRedirectRefusedError` it returns a typed 502 (mapped through `openCodeError`) with the
`Location` header removed from `responseHeaders`. It cancels the upstream body. It does not forward
the redirect. The proxy still sets auth headers (credential attachment, not enforcement).

Implementation, through the existing OpenCode feature boundary:

1. **`src/services/opencode/http.ts`** (owner: OpenCode service, backend) exposing
   `createBoundedTransport(baseUrl: string, credential: AdoptedCredential | null)` returning a
   `typeof globalThis.fetch`. It:
   - computes `expectedOrigin = canonicalOrigin(baseUrl)` and throws `OpenCodeAuthScopeError` if
     `credential` is non-null and its origin differs;
   - on every call, derives `targetOrigin` from the input (`Request.url` or the URL/string) and
     throws `OpenCodeOriginMismatchError` before sending if it differs from `expectedOrigin`;
   - calls the underlying fetch as `fetch(input, { ...init, redirect: "manual" })`;
   - if the response status is 3xx, cancels the body and throws `OpenCodeRedirectRefusedError`
     (carrying only the status and a stable error code — **no raw `Location`**);
   - otherwise returns the response.
   The managed case (`credential === null`) uses the managed base URL and the managed header; the
   origin check still applies, so a managed client cannot be redirected either.
2. **`client.ts`** passes `createBoundedTransport(baseUrl, adoptedCredentialOrNull)` as
   `options.fetch` to `OpenCode.make`, instead of `globalThis.fetch`. The observer wrapper composes
   around it (observe first, then bound, or bound then observe — order documented; observation must
   not swallow the redirect error).
3. **`serverManager.probeOpenCodeInfo`** is routed through `createBoundedTransport` so the origin
   check and the 3xx handling are identical.
4. **`configDocument.readOpenCodeConfigDocument`** takes a `fetch`-compatible transport as a
   **required** parameter and uses it for the request. No default.
5. **The proxy** (`routes/opencode.ts:565-666`) obtains its fetch function from
   `createBoundedTransport(baseUrl, credential)` and uses it for the upstream request.

#### 1.8.4 Exempt paths and why they are safe

- **P4 (config write)** is a filesystem write (`Bun.write`), not an HTTP request, so it cannot
  redirect. Its target path is supplied by the server's `/api/config` response. Residual risk: a
  malicious server could supply a path. Mitigation: the path is validated (must be under the
  server's config root, no traversal) before writing; this is existing behavior and is not changed
  by this plan.
- **P7, P8 (CLI probes)** spawn a local binary with an explicit argv and env; no HTTP, no
  credential. Safe by construction.
- **P9 (healthz)** carries no credential.
- **P10 (model discovery)** and **P11 (MCP transport)** do not attach OpenCode credentials
  (**VERIFIED (code)**: neither imports `getOpenCodeAuthHeaders`). They are out of scope for this
  policy; their redirect behavior is governed by their own callers and is not changed here. If a
  future change makes either attach an OpenCode credential, it must be routed through
  `createBoundedTransport` first — this is a stated invariant, not a current behavior.

#### 1.8.5 Acceptance tests (redirect)

| ID | Test | Assertion |
|---|---|---|
| R1 | **Initial-probe redirect** | Server A returns 302 to server B; B receives **zero** requests; outcome `redirect_refused` |
| R2 | **Native-client redirect** | Adopted server returns 302 to B for a subsequent authenticated API request; B receives **zero** requests; client throws `OpenCodeRedirectRefusedError` |
| R3 | **Configuration-read redirect** | Authenticated config-read path refuses a redirect; B receives **zero** requests |
| R4 | **Configuration-write redirect** | Any authenticated config-write path that performs HTTP refuses a redirect; B receives **zero** requests (the write itself is filesystem; the read that precedes it is covered by R3) |
| R5 | **Proxy redirect** | Proxy returns a typed 502, strips `Location`, cancels the upstream body; a browser-style fetch of the proxy does **not** contact B; **the proxy does not set `redirect: "manual"` itself** (source scan) |
| R6 | **Same-origin redirect** | A 307 on the same origin is also refused (credential + body would otherwise be replayed) |
| R7 | **Origin mismatch** | A request targeting a different origin is rejected **before** sending credentials (spy: zero fetch calls; zero header construction) |
| R8 | **Managed mode regression** | Existing managed requests continue to work through the established path (no redirect, no origin error) |
| R9 | **No secret disclosure** | Neither the password nor its Base64 representation appears in logs, errors, URLs, or test output across R1–R8 |
| R10 | **No raw Location in errors** | A stub's `Location` deliberately contains the candidate password and its Base64; neither value appears in the error message, serialized error details, logs, proxy response, or test output |
| R11 | **Proxy uses shared transport** | Source scan: `routes/opencode.ts` contains no `redirect:` literal; the proxy obtains its fetch function from `createBoundedTransport` (spy confirms) |
| R12 | **Config transport required** | `readOpenCodeConfigDocument` called without a transport is a compile-time error; at runtime, a missing transport throws before any request |

---

## 1.9 Request context contract (blocking design gap)

Revision 11 described `AdoptedCredential` as one atomic object. However, its broader design also
refers to independently resolving or reading the target `baseUrl`, `getOpenCodeAuthHeaders()`,
`getOpenCodeAuthScope()`, the credential passed to `createBoundedTransport(baseUrl, credential)`,
the proxy's target and headers, and configuration-read target, headers, and transport. The document
does not yet prove that all these values are captured from the **same authentication/runtime state**
for each logical request.

Checking the transport's expected origin against one credential object does not prove that a
separately constructed Authorization header came from that object. This section specifies a
**proposed** design for a single request-context contract. It is not yet proven safe. It remains a
blocking design gap (B8) until the contract is coherent and the required tests have actually passed.

### 1.9.1 Request path data flow (P1–P11)

For each credential-bearing request, the following values must be captured from the **same**
runtime-state snapshot:

| Path | Base URL source | Canonical origin source | Credential/header source | Transport expected origin | Can values be independently re-read? |
|---|---|---|---|---|---|
| P1 (probe) | `canonicalOrigin(registration.url)` | Same as base URL | `buildOpenCodeBasicAuthHeader(candidatePassword)` from candidate | `createBoundedTransport(baseUrl, null)` — probe uses candidate credential separately | **Yes** — base URL and credential are separate variables; must be captured together |
| P2 (native client) | `ensureBaseUrl()` → adopted or managed origin | `canonicalOrigin(baseUrl)` | `getOpenCodeAuthHeaders()` reads `AdoptedCredential` or managed password | `createBoundedTransport(baseUrl, credential)` | **Yes** — base URL from manager, credential from runtime; must be captured together |
| P3 (config read) | `configServerTarget().baseUrl` → `ensureBaseUrl()` | `canonicalOrigin(baseUrl)` | `configServerTarget().headers` → `getOpenCodeAuthHeaders()` | Transport passed as required parameter | **Yes** — base URL and headers from separate calls; must be captured together |
| P5 (proxy) | Manager's adopted/managed base URL + request path | `canonicalOrigin(baseUrl)` | `getOpenCodeAuthHeaders()` set onto upstream headers | `createBoundedTransport(baseUrl, credential)` | **Yes** — base URL from manager, credential from runtime, headers set separately; must be captured together |

**The problem:** In every path, the base URL and the credential are obtained from different
sources (manager vs. runtime module). Between obtaining the base URL and obtaining the credential,
the runtime state could change (adoption, revalidation, fallback, shutdown). This means a request
could combine a base URL from one state snapshot with a credential from another.

### 1.9.2 Proposed single request-context contract

Each logical request should capture one immutable, internally consistent context. The context is
produced by a **single capture operation** that reads all related values from the runtime state
in one synchronous step.

```ts
/** Captured once per logical request. Immutable. PROPOSED — not yet proven safe. */
export type OpenCodeRequestContext = {
  readonly mode: "managed" | "adopted";
  readonly baseUrl: string;           // canonical origin, slash-free
  readonly origin: string;            // same as baseUrl (canonical origin)
  readonly credential: AdoptedCredential | null;  // null = managed mode
  readonly headers: Record<string, string>;  // built from credential or managed password
  readonly transport: typeof globalThis.fetch;  // createBoundedTransport(baseUrl, credential)
};
```

**Capture operation (single, synchronous, atomic):**

```ts
export function captureOpenCodeRequestContext(): OpenCodeRequestContext {
  // Single synchronous read of all runtime state.
  const scope = getOpenCodeAuthScope();  // adopted origin or null
  const mode = scope !== null ? "adopted" : "managed";
  const baseUrl = scope !== null ? scope : getManagedBaseUrl();  // manager's base URL
  const credential = scope !== null ? getAdoptedCredential() : null;  // the installed object
  const headers = getOpenCodeAuthHeaders();  // reads the same credential state
  const transport = createBoundedTransport(baseUrl, credential);
  return { mode, baseUrl, origin: baseUrl, credential, headers, transport };
}
```

**Unresolved issue:** The managed password is not represented in the context. In managed mode,
`credential === null` while `headers` contains a Basic auth header built from the managed password.
The managed password is read independently by `getOpenCodeAuthHeaders()` from module-level state.
This means the context cannot account for the managed credential material. The managed password
must be included in the captured state, or the context must explicitly represent the managed
credential source.

**Recommended enforcement: transport-level credential injection.** The transport
(`createBoundedTransport`) should use the captured authentication context to construct or enforce
the request's Authorization header, while rejecting any conflicting caller-supplied Authorization
value. If the design retains caller-built headers, it must specify a concrete enforcement mechanism
showing that those headers cannot be substituted or derived from a different runtime snapshot.

**If caller-provided headers are retained:** The implementation must prove that `context.headers`
was built from `context.credential` (or the managed password when `credential === null`). This
is verified by a source scan and a runtime test: `context.headers` deep-equals
`buildOpenCodeBasicAuthHeader(context.credential?.password ?? managedPassword)`.

**Invariant (proposed, not yet proven):** A request must never send a credential selected from one
runtime-state snapshot to a destination selected from another snapshot.

**Discovery probe separation:** The initial registration probe may use a candidate credential with
a validated candidate origin before adoption succeeds. It must not install the candidate until the
trust validation and probe succeed. The adoption probe must not accidentally use the existing
managed credential. Failure must preserve prior installed state.

### 1.9.3 State-transition semantics

When the runtime transitions between managed and adopted modes, the credential rotates, fallback
begins, or shutdown starts:

- **Already-captured context:** A request that has already captured its context may finish to its
  captured origin. The context is immutable; it does not change when the runtime state changes.
  The request sends credentials only to `context.origin`, which was validated at capture time.
- **New requests after transition:** New requests capture a fresh context reflecting the new state.
  They use the new base URL, credential, and headers.
- **Cross-origin leakage prevention:** Because the transport checks every outgoing request's origin
  against `context.origin`, a stale context cannot send credentials to a different origin even if
  the runtime state has changed.
- **Stale completion:** A late completion from a superseded attempt cannot reinstall credentials
  or change mode. The `isAttemptActive` guard (§3.2) prevents this.
- **Shutdown:** On shutdown, `clearAdoptedCredential` is called. Already-captured contexts remain
  valid for their in-flight requests (they send to their captured origin). New requests capture a
  context with `credential === null` (managed mode) or fail if adoption is disabled.

**Reconciliation with §1.5:** §1.5 states that after shutdown "nothing" is sent. This is
reconciled as follows: §1.5 refers to *new* requests after shutdown (which capture a context with
no credential or fail). Already-captured contexts for in-flight requests may finish to their
captured origin. This is a coherent policy: shutdown prevents new credential-bearing requests but
does not abort in-flight requests that have already captured a valid context.

### 1.9.4 Race-oriented acceptance tests

| ID | Test | Assertion |
|---|---|---|
| RC1 | **State transition immediately before capture** | State changes (adoption/fallback/shutdown) immediately before `captureOpenCodeRequestContext()`; context reflects the new state; no stale values |
| RC2 | **State transition immediately after capture** | State changes immediately after capture; context remains immutable; request sends to captured origin with captured credential |
| RC3 | **Credential rotation during context creation** | Revalidation rotates credential while new request context is being created; context uses either old or new credential consistently (never mixed) |
| RC4 | **Proxy resolves target while state changes** | Proxy captures context; runtime state changes during upstream fetch; proxy sends to captured origin; no cross-origin leakage |
| RC5 | **Config read and native client use same contract** | Both use `captureOpenCodeRequestContext()`; both send to same origin with same credential |
| RC6 | **Deliberately mismatched URL/context rejected** | Context with URL A and credential for origin B → transport throws `OpenCodeOriginMismatchError` before fetch; zero requests |
| RC7 | **Every fetch sends credentials only to own context origin** | Spy on all fetch calls; each request's URL origin equals its context's origin |
| RC8 | **No managed credential to adopted origin** | In adopted mode, managed password never appears in any request |
| RC9 | **No adopted credential to managed origin** | In managed mode, adopted password never appears in any request |
| RC10 | **Stale attempt cannot reinstall credentials** | Superseded attempt's late completion cannot call `installAdoptedCredential` or change mode |

All of these are acceptance tests still to be implemented. A proposed test is not evidence that
the invariant already works. The request-context consistency issue remains a blocking design gap
(B8) until the contract is coherent and the required tests have actually passed.

---

## 2. Review item 2 — the registration read (blocking)