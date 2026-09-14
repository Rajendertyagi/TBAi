# Scheduler / Cron

Built-in, Bun-native job scheduler. No external services (no node-cron,
Bree, BullMQ, Redis).

## Architecture

```
SQLite (scheduler_jobs / scheduler_runs — source of truth)
  ↓
Scheduler coordinator (src/services/scheduler/scheduler.ts)
  ├── recurring → Bun.cron(expr, cb, { timezone })   (minute granularity)
  └── once      → setTimeout(exec_at - now)
  ↓
fire(jobId, occurrenceId)
  ├── overlap check (skip_if_running)
  ├── atomic claim: INSERT INTO scheduler_runs (UNIQUE job_id+occurrence_id)
  │     └── conflict → already claimed → do NOT execute
  └── executeJobRun → AI SDK generateText (same getModel stack as chat)
  ↓
run history + centralized logs (jobId/occurrenceId/runId/requestId)
```

Timers are an execution cache only. Restart rebuilds everything from SQLite.

## Schedule types

- **once**: absolute `exec_at` (ms epoch) + IANA `timezone`. No fake cron
  expression is stored. After success → job `completed` + disabled; after
  non-retryable failure → `failed`; retryable failure leaves it `active`
  for an operator/manual retry (the fired timer is gone).
- **cron**: 5-field expression (minute hour day month weekday, no seconds —
  this is Bun.cron's surface) + IANA timezone, plus @-macros
  (@daily/@weekly/@monthly/@yearly/@hourly, normalized server-side to
  canonical form). `next_run_at` (UTC ms) is bookkeeping/preview; the
  Bun.cron timer is what fires.

## Timezones & DST

Explicit IANA identifiers, persisted per job. GUI defaults to the system
zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`). Run records and
`next_run_at` are UTC. DST follows the IANA database via Intl/Bun — no
custom DST math. Firing DST behavior is Bun.cron's; `computeNextRun` is a
preview that mirrors it via offset round-trips.

## Occurrence identity (duplicate prevention)

- recurring slot: `cron-<utc-minute>` (matches Bun.cron's minute granularity)
- once: `once` (one stable occurrence per job)
- manual "Run now": `manual-<unique>` (never collides with schedule)
- skip records: `<occurrence>-skip-<ts>` (unique, informational)

Claim = single INSERT guarded by UNIQUE(job_id, occurrence_id). Conflict
means "already claimed" → no execution. Retries update the SAME run row
(`attempt`++, `error`), so one occurrence is always one row. "Exactly once"
refers to scheduler attempts per occurrence — external provider side
effects cannot be un-sent, and this is documented, not promised.

## Restart recovery (`recover()`)

1. `scheduler.recovery_started`
2. `running`/`scheduled` runs → `interrupted` (never blindly retried)
3. Rebuild recurring timers; recompute `next_run_at`
4. Rebuild pending one-time timers; overdue ones go through the missed-run
   policy
5. Invalid jobs (bad cron after edit) → disabled + `failed`
6. `scheduler.recovery_completed` with counts

## Missed-run policy (one-time jobs)

`missed_grace_seconds` (default 600, configurable per job):

- overdue ≤ grace → run once immediately
- overdue > grace → record a `missed` run, job → `missed` + disabled,
  never executes late

Recurring jobs just proceed to their next slot.

## Overlap policy

V1: `skip_if_running` only. A trigger while the previous run is `running`
records a `skipped` run and does not start a second execution — two AI jobs
never work the same workspace concurrently.

## Retry policy

Per job: `max_retries` (0-10) + `retry_delay_seconds`. Retried: timeouts,
aborts, network errors, 429, 5xx. Never retried: auth/credential errors,
invalid provider/model/config, workspace violations, approval refusals,
400-class errors. Attempts update the same run row (`attempt`, `error`).

## AI configuration (deterministic, explicit)

Each job stores provider / model / thinking / workspace / prompt. Active UI
provider, selected chat model, and active workspace are never consulted.
Deleted provider or missing credential → safe failure with reason, no
silent substitution. Thinking `off|low|medium|high` maps exactly like the
chat route; lite/nano models skip thinking (same rule as chat).

## Workspace

Must exist and resolve inside the TBAi workspace root (same traversal +
symlink-escape policy as interactive tools, `verifyJobWorkspace`). Outside
or missing → safe failure, no execution elsewhere.

## Conversation policy

V1: `dedicated_thread` — first run creates a `[Scheduler] <name>` thread
(stored as `conversation_id` on the job) so runs are grouped and isolated
from user chats. Run output is excerpted (≤2000 chars) onto the run row;
full prompts/outputs are never dumped to logs or list views. Mirroring full
assistant-ui messages into the thread is a follow-up (unknown format tags
must not be injected into the runtime's history path).

## Unattended execution safety (critical)

Scheduled runs are unattended. Destructive native tools (`write_file`,
`edit_file`, `delete_file`, `run_command`, `process_kill`) are offered with
an execute function that ALWAYS throws `ToolError("…user approval
required…")` — approval gates cannot be bypassed because approval cannot be
granted. MCP tools are excluded in V1. Safe read-only tools execute
normally. If the model attempts a destructive action, the run records the
refusal and continues/completes without the action.

## API

```
GET    /api/scheduler/jobs
POST   /api/scheduler/jobs
GET    /api/scheduler/jobs/:id
PATCH  /api/scheduler/jobs/:id
DELETE /api/scheduler/jobs/:id
POST   /api/scheduler/jobs/:id/enable
POST   /api/scheduler/jobs/:id/disable
POST   /api/scheduler/jobs/:id/run        (manual occurrence, 202 + runId;
works on any non-deleted job — missed/completed/paused included — without
touching the stored schedule)
POST   /api/scheduler/jobs/:id/runs/:runId/cancel  (abort a running run)
GET    /api/scheduler/summary            (job counts + recent failed/interrupted/missed runs)
GET    /api/scheduler/jobs/:id/runs?limit&offset
GET    /api/scheduler/runs?limit&offset
GET    /api/scheduler/runs/:id
POST   /api/scheduler/preview             (description + next N runs)
POST   /api/scheduler/compute-next-run    (single next run)
```

All inputs Zod-validated; schedule/provider cross-checks server-side
(cron validity, no execAt-on-cron, no cron-on-once, provider must exist).
List views return `promptPreview` (200 chars) + `promptLength`, never the
full prompt; detail views return it (needed for editing).

## GUI

`Scheduler` nav view: job table (Enabled/Name/Schedule/AI/Thinking/
Workspace/Next Run/Status), New/Edit form (General/When/AI/Workspace/
Prompt/Execution), preset repeat builders (minutes/hourly/daily/weekdays/
weekly/monthly/advanced cron — no cron typing needed for basics), live
preview (human description + next runs + timezone), Run now, enable/
disable, per-job run history (Time/Status/Duration/AI/Attempt/Error) with
run detail (runId/requestId/occurrenceId/timestamps/provider/workspace/
error/output excerpt).

## Logging

`scheduler.run` (outcomes: started/finished/failed/missed/skipped/cancelled/retried),
`scheduler.admin` (actions: created/updated/deleted/enabled/disabled/cancel_requested),
`scheduler.maintenance` (phases: started/finished/job_skipped/job_failed)
— every execution carries jobId + occurrenceId + runId + requestId. No
secrets, no full prompts. See docs/logging.md for the taxonomy.

## Limitations (V1)

- Minute granularity (Bun.cron: 5 fields, no seconds).
- Overlap: `skip_if_running` only (no queue/parallel).
- No MCP tools in scheduled runs.
- Run output is excerpted on the run row; full thread messages are mirrored
  (prompt/response/error) so the dedicated thread reads naturally.
- Retries share one run row (attempt counter), not per-attempt rows.
- Terminal runs older than 30 days are pruned on recovery.
- In-memory timers + abort controllers: a hard kill between claim and finish
  leaves an `interrupted` run for the operator (never auto-retried); cancel
  only works while the run executes in the current process.

## Live E2E checklist (another agent runs this)

1. One-time job minutes ahead → preview → fires → exact prompt received,
   correct provider/model/thinking/workspace, history row.
2. Recurring job → next-run → disable (no fire) → re-enable (resumes).
3. Restart → timers rebuilt, running runs → `interrupted`, no duplicates.
4. Overdue once: within grace → runs once; beyond grace → `missed`.
5. Overlap: trigger during run → `skipped`, single execution.
6. Failure/retry: transient retries, auth failure does not retry.
7. Destructive tool attempt → refused with approval message, no side effect.
8. Logs contain jobId/occurrenceId/runId/requestId; no console errors.

## Execution model notes (verified)

- **In-process timers are exempt from OS trigger limits.** The 48-trigger
  Windows cap (and Repetition-vs-expansion rules) apply only to OS-level
  `Bun.cron(path, ...)` jobs. TBAi uses in-process `Bun.cron(schedule,
  handler)`, which the official docs confirm has no Windows expression
  limits � `*/7`, `*/13`, `0,30 * 15 * FRI` all work. Gallery counts are
  real occurrence counts, not trigger-element estimates.
- **Sent vs shown prompt (codeg prompt_blocks vs display_text).** The model
  receives workspace/approval context; the thread stores the user`s own
  words under a one-line run header � scaffolding never shows in chat.
- **Spent jobs are never revived.** Enabling a one-time job whose date
  passed is refused with the real options (duplicate with a new date, or
  edit first). Delete hides the job but retains run history; terminal runs
  older than 30 days are pruned on recovery.
- **Live UI: the schedule sentence auto-updates** on every When-field
  change (no preview button); Run-now disables while a run is in flight
  and the job`s history refreshes when it settles.
