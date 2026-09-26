# Phases — Current Tracker

This file records active implementation phases only. Completed migration reports and superseded plans are not retained here; current architecture and decisions live in `docs/architecture.md` and `docs/decisions.md`.

## OpenCode native V2

| Phase | Scope | Status | Evidence / remaining acceptance |
|---|---|---|---|
| V2 client boundary | Official `@opencode/client@2.0.16` in backend and browser; managed server constrained to `>=2.0.15 <2.1.0` | Complete | Package manifests and canonical root lockfile; proxy/auth boundary unchanged |
| V2 runtime | Native client, external-store controller, event reduction, history, tools, permissions, forms, cancellation | Complete | Focused native/OpenCode suite and Code-route Playwright |
| Permission UX | Allow-once and deny flows | Complete | Live terminal success and interrupted execution verified |
| Form UX | Create, reply, cancel lifecycle | In progress | Real question creation remains blocked by the upstream permission gate; no synthetic form result is claimed |
| Repository cleanup | Retired client packages, compatibility modules, wire-shape fallbacks, migration plans, and generated reports removed | Implemented; focused verification complete | Forbidden-reference audit: 0 matches; typecheck/build: exit 0; focused V2 regression: 70/0; focused OpenCode web: 194/0; Code-route Playwright: 1/0. Full suite: 1,798 pass / 0 fail / 2 skip / 0 error across three consecutive runs — the earlier "214 fail, blocked by unrelated shared-database failures" line was stale and has been corrected; those failures were test-side (a stale expected-name list, an approval-parity gap, missing `/compact` lifecycle events, synthetic thread ids rejected by the todo foreign key, and unscoped fetch counters polluted by a leaked OpenCode readiness probe) with exactly one real product bug among them, the `clientRequestId` singleflight race now fixed |

## Direct Chat durability (provider-agnostic Direct path only)

| Phase | Scope | Status | Evidence / remaining acceptance |
|---|---|---|---|
| 1 — Direct correctness & security | Outcome-based settlement replacing `onFinish`; strict terminal `finishReason` allowlist; `maxRetries`/`streamRetries` = 0; `safeValidateUIMessages`; backend-only approval secret; sanitized Direct logging | Complete | 20 route-level cases in `tests/integration/direct-hardening.test.ts`; live SIGKILL run against `agnes-2.5-flash`. Provider-agnostic — no provider is special-cased |
| 2 — Durable resumable streams | SQLite `ResumableStreamStore` (`chat_streams`/`chat_stream_chunks`), boot recovery, TTL cleanup, detached-run history finalization, resume observability | Complete | 19 route-level cases in `tests/integration/detached-history-finalization.test.ts`; measured 0.07–0.22 ms/chunk (~14k chunks/s). Design: `docs/2026-09-25-phase2-durability-design.md` |
| 3 — Recovery UX | Per-thread recovery state, Composer notice with a guarded Retry (gated on `terminalKind === 'interrupted'` **and** a non-empty prompt), conversation-keyed run status | Complete | Verified live: crash → recovery notice → Retry issues exactly one new model request. No auto-retry anywhere |
| 4 — Gap closure | `invalid_stream` conformance category from SDK error names; billing/transport copy; `length` settlement proven; phantom-shell write guard; orphan-sweep safety guard | Complete | `tests/unit/error-provider-response.test.ts`; 20/20 `direct-hardening`; `tests/integration/phantom-assistant-shell.test.ts`; `tests/unit/workspace-gc-guard.test.ts`. Plan + independent review: `docs/2026-09-26-direct-gap-closure-plan.md` |

**Known limitations, deliberately not repaired:** post-restart finalization of a run
that completed while the server was down (ADR decision 3 — scoping, not impossibility);
a malformed provider stream is surfaced, not masked; Anthropic/Ollama live parity is
untested in this environment for want of credentials.

## Active product work

| Item | Status | Source |
|---|---|---|
| Provider-switching UI | Open | `docs/roadmap.md` |
| Desktop packaged acceptance flows | User acceptance pending | `docs/development-rules.md` |
| RAG, uploads, persistent memory, auth/multi-user, deployment hardening | Deferred | `docs/roadmap.md` |
