# Plan — close the remaining Direct Chat gaps (2026-09-26)

**Process:** disk/API audit → this plan → independent disk review → implement → verify.
Every line below was read on disk before being written. Corrections to my own
earlier audit are recorded in §0 because two of them were wrong.

---

## §0 Audit results — including two corrections to my own claims

I previously told the user that "billing/quota" and "invalid/truncated stream"
were both missing from the error taxonomy, and that `length` *and* `tool_calls`
settlement were both unproven. **Both claims were wrong.** Corrected:

| My earlier claim | Reality on disk |
|---|---|
| "billing/quota is missing" | **Already implemented** as a deliberate `billing` **flag**, not a category — `src/lib/errors.ts:37-43` (documented rationale: keep the coarse category so retry policy is unchanged) and `BILLING_RE` at `:82-83` |
| "`tool_calls` end-to-end is unproven" | **Covered.** `tests/integration/direct-hardening.test.ts` has a `tool-call-then-complete` behavior (`:187-193`, `toolCallChunk` `:132-159`) driving a real tool continuation |
| "invalid/truncated provider response is missing" | **Correct — genuinely absent.** No `ErrorCategory` or flag represents a malformed/incomplete provider stream |

Also re-verified as already done (contrary to my first audit): the `system`/`tools`
directive rejection (`chat.ts:190-200`, tested at `direct-hardening.test.ts:633`),
the cancellation-key single owner (`deleteConversation.ts:4` → `resumable-stream.ts:6`),
and the `assistant-stream` docs split (`decisions.md:103-106`).

**Net real gaps: 3 code gaps + housekeeping.** Not the four I first reported.

---

## W1 — Finish the error taxonomy (the last open item from the original plan)

> **REVIEW CORRECTIONS APPLIED (independent disk review, 15 checks).** The first
> draft of W1 was **wrong in a way that would have shipped silently.** Corrected
> design below; the defects are recorded in §R.

### W1.1 `src/lib/errors.ts` — add `invalid_stream` as a coarse base, name-first

**The first draft was broken.** It placed `invalid_stream` as a refinement inside
`refineCategory` (`errors.ts:90-99`), reasoning that "refining a category cannot
change retryability". The reviewer executed `classifyError` against the real module
and proved that placement **never fires** for two of the six names:

- `AI_TypeValidationError` ("Type validation failed…") hits `VALIDATION_RE` at `:93`
  — whose **first** alternative is `/\bvalidation\b/` — so it classified `validation`.
- `AI_InvalidStreamPartError` on a tool-call delta hits `TOOL_SUBJECT_RE`/`TOOL_OUTCOME_RE`
  at `:139` → coarse `base = "tool"` → `refineCategory` returns `"tool"` untouched at `:92`.
  Tool-call deltas are the *most common* malformed stream part.

So the branch must be reached **before** the prose heuristics, and the prose
heuristics are exactly the wrong place. `invalid_stream` becomes a **coarse `base`**,
assigned from the SDK's authoritative `errorType` name (`normalizeError` reads
`err.name`, `logger.ts:359`) — the plan's own instruction, "use AI SDK error types
where possible", taken literally.

Precedence (only `cancelled` and status-derived categories stay ahead of it):

1. `CANCELLED_RE` → `cancelled` (unchanged, first)
2. status: 401/403 → `auth`; 429 → `rate_limit`; 4xx → `config`; 5xx → `provider`/`unknown` (unchanged)
3. **NEW** — SDK name in `PROVIDER_RESPONSE_ERROR_NAMES`, and (for `AI_APICallError` only) status is 2xx → `invalid_stream`
4. existing prose: `NETWORK_RE`, `TIMEOUT_RE`, `CONFIG_RE`, `TOOL_*` (unchanged)

Names, all verified in `node_modules` (line numbers from the review):

| `errorType` | Location |
|---|---|
| `AI_InvalidStreamPartError` | `ai/dist/index.js:83` |
| `AI_StreamProviderError` | `ai/dist/index.js:408` |
| `AI_InvalidResponseDataError` | `@ai-sdk/provider@4.0.10/…/index.js:145` — **added; the review found the first draft missed it, and it is the canonical malformed-payload error** |
| `AI_TypeValidationError` | same `:300` |
| `AI_JSONParseError` | same `:164` |
| `AI_EmptyResponseBodyError` | same `:75` |
| `AI_APICallError` | same `:39` — **only when status is 2xx** |

**The retryability claim is corrected, not preserved.** Because `invalid_stream` is
a coarse base and not a refinement, it *does* reach the `retryable` computation
(`:148-152`). That is deliberate: a malformed provider stream is **not** retryable,
because retrying re-sends a request that produced garbage — the same principle as
`DIRECT_MAX_RETRIES = 0` (`chat.ts:53`). One behaviour genuinely changes:
`AI_InvalidStreamPartError` whose text contains "fetch failed" is `network` /
`retryable: true` today and becomes `invalid_stream` / `retryable: false`. The first
draft's claim that it was "already non-retryable" was false and is withdrawn. This
is the one intentional retry-policy change in the plan, and it gets its own test.

**The 2xx `AI_APICallError` rule is defensive, not hot.** `APICallError` is built by
`handleErrorResponse` for **non-2xx**; a 2xx with an unusable body surfaces as
`JSONParseError`/`TypeValidationError`/`EmptyResponseBodyError`. The restriction is
still correct — without it, every 401/429/5xx would be swallowed — but the plan does
**not** claim a real provider produces it, and the test for it is labelled a
classifier fixture, not a modelled failure.

### W1.2 `src/lib/redact.ts` — copy gaps, and a false-positive risk

1. **The `billing` flag is unreachable.** `sanitizeStreamError` switches on
   `classifyError(error).category` (`:41`), discarding the rest of the
   `ClassifiedError`. Hoist `const classified = classifyError(error)` and read the
   flag **before** the `rate_limit` case — today a no-credit failure tells the user
   to *"Wait briefly and retry"*.
2. **`BILLING_RE` is dangerously broad and the plan puts it on the hot path.**
   `errors.ts:83` contains the bare tokens `402` and `billing` with no boundaries.
   Once the flag outranks `rate_limit`, any rate-limit text that happens to contain
   the digits `402` (a request id, a byte count) or the word `billing` renders the
   no-credit copy. **Tighten the regex with boundaries and add a negative test** — a
   rate-limit message containing `402` must still get retry advice. The first draft
   had positive tests only.
3. **No `invalid_stream` case** → generic copy that invites a retry which will fail
   identically. Add one.
4. **No `transport` case** even though `transport` is a real category (`:27`).
   Add one. `validation`/`database`/`lifecycle`/`runtime` deliberately **stay** on
   the generic copy: those are internal server faults, not provider conditions, and
   "Generation failed" is the honest thing to tell a user. Documented, not
   overlooked.

### W1.3 Tests

Extend `tests/unit/error-taxonomy.test.ts` and `tests/unit/errors.test.ts`:
each of the **seven** names classifies `invalid_stream` · `AI_APICallError` at
401/429/500 still classifies `auth`/`rate_limit`/`provider` · tool-flavoured
`AI_InvalidStreamPartError` → `invalid_stream`, **not** `tool` (the regression the
review caught) · `AI_TypeValidationError` → `invalid_stream`, **not** `validation` ·
the one intentional retryability change, asserted explicitly · billing copy beats
rate-limit copy · **negative**: a rate-limit text containing `402` keeps the retry
advice · `transport` gets its own copy · raw provider text never reaches the copy.

---

## W2 — Close the one real settlement gap: `finish_reason: "length"`

The allowlist at `chat.ts:55-60` accepts `stop | length | content-filter |
tool-calls`, and `isSuccessfulDirectFinishReason` (`:62-64`) drives settlement at
`:458`. But **no test ever emits `length`** — and the review confirmed the one
`tests/` hit (`approval-lifecycle.test.ts:49`) is hand-built `UIMessageChunk`s for
a different route test, **not** provider wire bytes. So the acceptance criterion
*"valid `length` stream → `length` is preserved"* is genuinely unproven.

The review also confirmed these values are the AI SDK's **unified** finish reasons
(`@ai-sdk/openai-compatible@3.0.44/dist/index.js:334-348` maps `stop→stop`,
`length→length`, `content_filter→content-filter`, `tool_calls→tool-calls`,
`default→other`), so the allowlist is correct and `chatCompletionChunk({}, "length")`
reaches `length` unchanged.

In `tests/integration/direct-hardening.test.ts`: add a `finish-reason-length`
member to the `StreamBehavior` union (`:91-98`), an arm in the `pull()` chain beside
`finish-reason-other` (`:208-213`), and a case asserting the run settles
**`completed`**, `ai.response` **is** emitted (contrast `:857`, where `other` must
not emit it), and `finishReason === "length"` — preserved, not coerced to `stop`.

**Read path — the first draft assumed plumbing that does not exist.** The review
confirmed **no test in the repo reads the durable finish reason**, and
`/api/chat/stream-status` (`chat.ts:911-932`) does **not** expose `finishReason`. So
the durable assertion needs a **new import** of `chatStreamStore` from
`../../src/lib/resumable` and a direct `chatStreamStore.describe(streamId).finishReason`
read (`sqliteResumableStore.ts:906-919`). Assert both: the `ai.response` log line's
`finishReason` (`chat.ts:443`) *and* the durable row, so "preserved" is proven
end-to-end rather than inferred.

This is a **test-only** change: the allowlist already contains `length`, so if the
test fails, that is a real product bug the test just exposed.

---

## W3 — Copy ownership for the interrupted-reply notice

`web/src/lib/transport-errors.ts:47-50` returns the client copy
*"Connection interrupted. The AI run could not be resumed."* — a **durable-verdict
claim** ("could not be resumed") derived from a display-layer regex over transport
signatures. That directly contradicts the rule written in the strip's own config
comment (`web/src/config/composer.ts:48-53`): the durable reason is *"never [chosen]
by matching an error string"*, because the client cannot see **why**. Live
verification showed both notices at once for one event: the message-level
`"Connection interrupted. The AI run could not be resumed."` beside the strip's
`"The app restarted while this reply was streaming. Nothing was sent — retry?"`.

**Corrected after review — the first draft had the ownership model backwards.**
The review grepped the literal across `web/src` and `src`: it appears in exactly
**one** code owner (`transport-errors.ts:49`), plus one test, two docs, and this
plan. There is **no code duplication today**, so "move it to a single owner" was
solving a problem that does not exist — and `web/src/config/composer.ts:1-6` scopes
itself to *"composer menu copy (model / thinking / attach pickers)"*, so parking a
chat-transport error notice there would be a **new** ownership smell.

Corrected fix, minimal and truthful:
- **Keep the owner where it is.** `transport-errors.ts` is the correct home for
  client transport-failure copy.
- **Change the claim, not the location.** The copy states only what the display layer
  actually knows — the connection dropped. It stops asserting what happened to the
  run, which is the strip's job and is backed by the server's durable verdict.
- After this, the two notices carry **disjoint** facts (connection lost · the app
  restarted and nothing was sent) instead of restating one event twice.

**This breaks a test the plan must therefore name:** `transport-errors.test.ts:65-68`
pins the exact string with `toBe(...)`. It is updated in the same change. (The
review confirmed this was the *only* test W3 breaks, and that W1.2's billing copy
breaks **none** — `errors.test.ts:83` and `reconciliation.test.ts:14` use
429-markers that match no `BILLING_RE` alternative, and `error-hygiene.test.ts`'s
assertions are self-referential, so both sides move together.)

**Explicitly NOT doing:** suppressing assistant-ui's message-level error to leave a
single notice. That means custom message-error rendering in a frozen dependency
(AGENTS.md: "assistant-ui primitives only; no custom rendering of messages"), for a
pure product preference. **Flagged for the user's decision, not silently chosen.**

---

## W4 — Documentation and tracker sync

- `docs/phases.md` — add Direct Chat durability Phase 1/2/3 rows. Verified: the
  file is 21 lines and contains **zero** matches for durability/resumable/Phase 1-3,
  and it has **no** protocol section of its own — the update protocol the first
  draft quoted (*"whoever finishes a phase flips its row in the same change"*) is in
  **`docs/decisions.md:1297`**, not in `phases.md`. Its only normative line is `:3`.
  Cited correctly now.
- `docs/roadmap.md:67` — replace *"Durable SQLite resumable chunks remain a
  separately reviewed storage phase"* (confirmed verbatim; stale, Phase 2 shipped).
- `docs/2026-09-25-phase2-durability-design.md` — record the **measured**
  performance numbers: ~0.07–0.22 ms/chunk (~14k chunks/s), 4,171-chunk reply
  ≈300–380 ms, 2.5 MB replay 8–19 ms, 500 expired rows cleaned in 4 ticks / 36–55 ms.
- `docs/decisions.md` — ADR entries for W1 (taxonomy discipline: coarse category
  owns retryability, SDK error *names* not prose) and W3 (no verdict claims from
  the display layer).

---

## Deferred, with reasons (not silently skipped)

- **The 37 pre-existing no-content assistant rows.** Irreversible deletion of real
  user history. Proposing a **dry-run + DB-backup** maintenance command, executed
  only on explicit approval. The write guard already prevents new ones.
- **"Normal OpenAI/Anthropic/Google/Ollama paths unaffected."** Only Google is
  configured (`is_active=1`); Anthropic and Ollama have no credentials in this
  environment, so live parity is **untestable here**, not verified. Offline
  registry/adapter coverage is the only honest substitute.
- **Playwright cannot parse specs under Bun** (`BuildMessage: Unterminated string
  literal`, identical on untouched specs) — a pre-existing runner/interop defect
  that blocks the repo's own e2e suite. Separate infrastructure work.

---

## Verification (independent re-runs, not agent-reported)

1. `bun run typecheck` → 0 · `bun run build` → 0 · biome lint → 0
2. `bun run test` — record actual suite + case counts; the 15 pre-existing
   failures (todo ×8, OpenCode ×3, approval parity, Phase 4 idempotency,
   sessionBootstrap ×2) must remain **exactly** those — no new ones
3. `bun run test:shutdown` → 1/1
4. Boundary greps: no duplicated copy literals; no prose-regex added to
   `errors.ts` for W1; `invalid_stream` referenced only via the classifier
5. Real user data unchanged: 16 conversations, 507 messages, 13 chat dirs,
   providers untouched, **0 staged**

---

## §R Independent review — verdict and defects found

Reviewed against disk by a separate agent (15 checks, plus empirical
`classifyError` runs against the real module). **Verdict: the first draft was not
implementable as written.** Defects found and now corrected above:

| # | Severity | Defect |
|---|---|---|
| A | **material** | `invalid_stream` placed in `refineCategory` would **never fire** for `AI_TypeValidationError` (beats it to `validation` via `VALIDATION_RE`'s `\bvalidation\b`) or for tool-flavoured `AI_InvalidStreamPartError` (beats it to `tool`). The branch had to move ahead of the prose heuristics and become a coarse base. |
| A2 | **material** | "already non-retryable today" was false — a malformed stream surfacing as `fetch failed` is `network` / `retryable: true`. Claim withdrawn; the one real retry-policy change is now declared and tested. |
| A3 | minor | The draft **missed** `AI_InvalidResponseDataError`, the canonical malformed-payload error. Added. |
| B | minor | The 2xx-`AI_APICallError` rule guards a shape the SDK does not emit. Kept as defence, no longer claimed as hot, test relabelled a fixture. |
| C | **material** | `BILLING_RE` contains unanchored `402` and `billing`. Once the flag outranks `rate_limit`, false positives become user-visible ("no credit" for a rate limit). Tighten + negative test. |
| D | minor | `sanitizeStreamError` discards the whole `ClassifiedError`; reading the flag needs an explicit hoist. |
| E | minor | W2's durable read does not exist — new `chatStreamStore` import; `/api/chat/stream-status` does not expose `finishReason`. |
| F | minor | W3 breaks `transport-errors.test.ts:65-68`, which the plan's own "no new failures" gate forbids. Now named. |
| G | minor | `transport` copy gap unclosable as described; `validation`/`database`/`lifecycle`/`runtime` share the same fallback. Resolution: `transport` gets copy, the four internal-fault categories deliberately keep the generic copy, documented. |
| H | minor | Protocol quote misattributed to `phases.md`; it is `decisions.md:1297`. |

The review's line citations were otherwise exact, including all six SDK error names
and `chat.ts:190-200`.
