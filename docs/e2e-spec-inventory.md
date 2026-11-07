# E2E spec inventory and CI classification

**Date:** 2026-11-07
**Scope:** every `tests/e2e/**/*.spec.ts` (50 files)
**Authority for the push-CI list:** `.github/workflows/tests.yml`, the `e2e` job.
This document records the classification; the workflow owns the list.

## Classes

| Class | Meaning |
|---|---|
| **push CI** | Runs in the `e2e` job on every push to `main` / `ci/tauri-e2e-verify`. |
| **full-dispatch-only** | Runs only in `e2e-full` (`workflow_dispatch`, two revisions compared test-identity by test-identity). Never a per-push gate. |
| **credential-dependent** | Needs a real model credential. Dispatch-only (`e2e-big-pickle`) or skipped without `TBAI_E2E_LIVE=1`. Never a gate. |
| **quarantined-flaky** | Known-unstable in this environment. Not a gate; named here so it is not mistaken for coverage. |
| **unclassified** | On disk, collected by `e2e-full` on dispatch, gated nowhere on push. Pre-existing work in progress. |

## The push-CI list (9 specs)

`p2-history-load-recovery`, `p2-direct-history-window`, `p2-paging`,
`p2-live-runtime`, `p2-tool-result-persistence`, `phase-8-tabs-navigation`,
`opencode-v2-code-route`, `appearance-scaling`, `typography-standardization`.

The first six are the conversation-history and tool-persistence specs, where a
silent stale-bundle run does the most damage. `opencode-v2-code-route` is the
only browser-level coverage of the OpenCode runtime. The last two are the
typography/scaling rendered-behaviour specs.

## Widening the push-CI list

A spec is added to the `e2e` job only after **repeated successful runs** in this
environment, and only when it is high-value (it guards a defect class that a
stale bundle would hide, or a runtime boundary nothing else covers). A single
green run is not evidence of stability. A spec that fails for an environmental
reason is not a candidate until that reason is understood.

Scroll and virtualizer specs were prioritised for this review because they are
the least covered by the current list and the most sensitive to bundle drift.
Measured on 2026-11-07 (chromium-headless, `TBAI_E2E_SKIP_BUILD=1` against a
stamped bundle):

| Spec | Result | Disposition |
|---|---|---|
| `virtualizer/composer-overlay-follow.spec.ts` | pass | candidate, needs a second run |
| `virtualizer/initial-scroll-range.spec.ts` | pass | candidate, needs a second run |
| `virtualizer/run-start-scroll.spec.ts` | pass | candidate, needs a second run |
| `virtualizer/scroll-anchoring-regressions.spec.ts` | **fail** — R1, "the reasoning row is mounted after collapsing" | not a candidate; pre-existing, unrelated to this work |
| `virtualizer/scroll-to-latest.spec.ts` | pass | candidate, needs a second run |
| `virtualizer/status-layout-stability.spec.ts` | pass | candidate, needs a second run |
| `virtualizer/transcript-header-contract.spec.ts` | pass | candidate, needs a second run |
| `virtualizer/virtual-end-distance.spec.ts` | pass | candidate, needs a second run |
| `virtualizer/mouse-activation.spec.ts` | **fail** — "the panel must start collapsed" | not a candidate; pre-existing, unrelated to this work |
| `virtualizer/renderer-cpu-profile.spec.ts` | not run | profiling harness, not a gate |

No virtualizer spec was added to push CI in this change: one run is not
"repeated successful runs", and two of the nine fail in this environment for
reasons unrelated to this work (both are reasoning-disclosure geometry cases).
Widening the list remains a deliberate decision.

## Inventory

| Spec | Class | Notes |
|---|---|---|
| `appearance-scaling.spec.ts` | push CI | Typography/scaling rendered behaviour |
| `components/composer-bar.spec.ts` | unclassified | |
| `components/context-menu-spellcheck.spec.ts` | unclassified | |
| `components/edit-preview.spec.ts` | unclassified | |
| `components/mermaid-diagram.spec.ts` | unclassified | |
| `components/radix-primitives.spec.ts` | unclassified | |
| `components/tab-strip-reorder.spec.ts` | unclassified | |
| `components/toast-visuals.spec.ts` | unclassified | |
| `components/welcome-composer.spec.ts` | unclassified | |
| `core/code-fence-budget.spec.ts` | unclassified | |
| `core/phase-ua-a.spec.ts` | unclassified | |
| `core/phase-ua-d.spec.ts` | unclassified | |
| `core/quick-messages.spec.ts` | unclassified | |
| `core/refresh-flash.spec.ts` | unclassified | |
| `core/running-indicator.spec.ts` | unclassified | |
| `history/p2-direct-history-window.spec.ts` | push CI | |
| `history/p2-history-load-recovery.spec.ts` | push CI | |
| `history/p2-live-runtime.spec.ts` | push CI | |
| `history/p2-measurements.spec.ts` | unclassified | acceptance numbers, recorded not asserted |
| `history/p2-paging.spec.ts` | push CI | |
| `history/p2-stale-publication-reachability.spec.ts` | unclassified | |
| `history/p2-streaming.spec.ts` | unclassified | |
| `history/p2-tool-result-persistence.spec.ts` | push CI | |
| `history/phase-4-first-send.spec.ts` | unclassified | |
| `history/phase-8-tabs-navigation.spec.ts` | push CI | |
| `logs/logs-viewer.spec.ts` | unclassified | |
| `opencode/opencode-big-pickle-live.spec.ts` | credential-dependent | `e2e-big-pickle`, dispatch-only |
| `opencode/opencode-config-live.spec.ts` | credential-dependent | needs `TBAI_E2E_LIVE=1` |
| `opencode/opencode-config-override-live.spec.ts` | credential-dependent | needs `TBAI_E2E_LIVE=1` |
| `opencode/opencode-edit-approval-diff-live.spec.ts` | credential-dependent | needs `TBAI_E2E_LIVE=1` |
| `opencode/opencode-model-chip-live.spec.ts` | credential-dependent | needs `TBAI_E2E_LIVE=1` |
| `opencode/opencode-v2-code-route.spec.ts` | push CI | no credentials needed; asserts the refusal surface |
| `opencode/opencode-v2-edit-reload-live.spec.ts` | credential-dependent | needs `TBAI_E2E_LIVE=1` |
| `opencode/opencode-v2-permission-live.spec.ts` | credential-dependent | needs `TBAI_E2E_LIVE=1` |
| `routing/index-redirect.spec.ts` | unclassified | |
| `routing/newchat-flow.spec.ts` | unclassified | |
| `server/availability-recovery.spec.ts` | unclassified | |
| `server/boot-loading.spec.ts` | unclassified | |
| `tools/tool-body-budget.spec.ts` | unclassified | |
| `typography-standardization.spec.ts` | push CI | |
| `virtualizer/composer-overlay-follow.spec.ts` | unclassified | candidate for push CI after repeated runs |
| `virtualizer/initial-scroll-range.spec.ts` | unclassified | candidate for push CI after repeated runs |
| `virtualizer/mouse-activation.spec.ts` | quarantined-flaky | fails in this environment ("the panel must start collapsed"); pre-existing |
| `virtualizer/renderer-cpu-profile.spec.ts` | unclassified | profiling harness, not a gate |
| `virtualizer/run-start-scroll.spec.ts` | unclassified | candidate for push CI after repeated runs; contains one `test.fixme` |
| `virtualizer/scroll-anchoring-regressions.spec.ts` | quarantined-flaky | fails in this environment (R1, reasoning row not mounted after collapsing); pre-existing |
| `virtualizer/scroll-to-latest.spec.ts` | unclassified | candidate for push CI after repeated runs |
| `virtualizer/status-layout-stability.spec.ts` | unclassified | candidate for push CI after repeated runs; three `test.skip` for live-turn states |
| `virtualizer/transcript-header-contract.spec.ts` | unclassified | candidate for push CI after repeated runs |
| `virtualizer/virtual-end-distance.spec.ts` | unclassified | candidate for push CI after repeated runs |

Counts: 9 push CI, 7 credential-dependent, 2 quarantined-flaky, 32 unclassified.
`e2e-full` (dispatch-only) runs every non-live spec at two revisions and is the
backstop for the unclassified set.
