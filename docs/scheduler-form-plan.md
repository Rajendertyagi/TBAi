# Scheduler Form Plan — Superseded

> [!WARNING]
> **ARCHIVED / SUPERSEDED — NOT AN IMPLEMENTATION PLAN.**
> The former 1,311-line plan at this path is preserved as a historical
> snapshot at [`docs/archive/scheduler-form-plan-rev5-historical.md`](archive/scheduler-form-plan-rev5-historical.md).
> Do not execute its P2/P3 file lists, codecs, schemas, or UI proposals.

## Current authority

- [`docs/2026-11-03-model-metadata-deep-audit.md`](2026-11-03-model-metadata-deep-audit.md)
  **Revision 2.4** is the sole current architecture authority for
  AI capability / reasoning.
- [`docs/p2-implementation-plan.md`](p2-implementation-plan.md) is the
  historical, **cancelled** P2 proposal (custom reasoning codec and
  Models.dev reasoning-metadata ingestion). It is retained only as a
  record; do not implement it.

## Live implementation (Direct Chat reasoning)

- Direct Chat uses AI SDK v7's native top-level `reasoning` option for
  `low`, `medium`, and `high` (`src/routes/chat/execute-direct-stream.ts`).
- `off` or an absent selection omits the `reasoning` option entirely.
  It does not explicitly disable reasoning.
- `src/routes/chat/provider-options.ts` only supplies Google's
  additional `includeThoughts` option. It is not a shared reasoning codec.
- The Scheduler remains on its existing four-level schema and inline
  reasoning mapping (`src/services/scheduler/schedulerExecution.ts`).

## Scheduler reasoning changes

Any change to Scheduler reasoning requires a **new, separately approved
proposal** based on the current implementation. Do not revive the
archived P2/P3 codec, dynamic-selection, or shared-integration designs.
