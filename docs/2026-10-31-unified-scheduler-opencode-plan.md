# Unified Scheduler: Direct + OpenCode Engine Plan

> Status: **PLAN (no code changes yet)** — read-only study of TBAi
> (`src/services/scheduler/`, `src/services/opencode/`, `web/src/features/scheduler/`)
> and OpenChamber (`packages/web/server/lib/scheduled-tasks/`, `agent-tool/`,
> `opencode/lifecycle.js`, `managed-config-file.js`), distilled into a durable,
> single-interface design.

**Goal:** one scheduler surface that can run a job through either engine —
Direct (AI SDK `streamText`) or OpenCode (managed `opencode serve`) — with no
OpenCode plugin required for execution.

**Architecture:** the existing scheduler core (SQLite source of truth, timer
cache, claim/retry/shutdown spine) stays untouched. A second execution adapter
joins the Direct adapter behind one `executeJobRun` entry point, chosen by a
per-job `engine` field. OpenCode runs are unattended: they drive the OpenCode
HTTP API through the same `ensureOpenCodeSession` seam the chat route uses,
with a native permission policy that can never silently auto-approve.

**Tech stack:** Bun, `bun:sqlite`, AI SDK v7 (Direct path only),
`@opencode/client` v2 official client (OpenCode path), Hono, React +
`@assistant-ui/react` (UI unchanged in shape).

---

## 1. What we learned from OpenChamber

### 1.1 Execution needs no plugin

OpenChamber's scheduler (`lib/scheduled-tasks/runtime.js`) is a plain server
module: timers + queue + cron-parser/luxon. When a tick fires it just calls
**OpenCode's public HTTP API** — create a session, send a prompt. No plugin is
involved in *running* a schedule.

OpenChamber's plugins (`lib/opencode/session-title-plugin.js`,
`lib/agent-tool/runtime.js`, `lib/opencode/managed-config-file.js`) solve a
different problem: they let an **in-session agent** call OpenChamber back
(`openchamber_schedule`, session control, render). That is an *in-band,
agent-driven* extension of the UI surface, not of the execution path.

**Decision for TBAi:** ship execution plugin-free. An OpenCode plugin to
expose `openchamber_schedule` to in-session agents is a follow-up, out of
scope for this plan.

### 1.2 Cross-process claim (note, not adopted)

OpenChamber coordinates multiple server processes sharing one config file
with a project write lock + `state.lastScheduledFor` claim. TBAi is a single
Bun process per install; its `UNIQUE(job_id, occurrence_id)` SQLite claim
guard already prevents duplicate execution. **No change needed** — recorded so
we don't import their locking mechanism.

### 1.3 Long-horizon timers (note, not adopted)

OpenChamber splits any `setTimeout` delay longer than
`MAX_TIMER_DELAY_MS` (2,147,483,647 ms ≈ 24.8 days) into chained re-schedules.
TBAi's `scheduleOnce` uses a plain `setTimeout(delay)`. **Action item:**
bound TBAi's one-time delays to the same ceiling (a chained re-schedule on
the already-existing `scheduleJob`/`clearTimer` machinery). One task,
low-risk, independent of the engine work.

### 1.4 Chats scope / one-fresh-session-per-run

OpenChamber's chats scope creates `<chats root>/<yyyy-mm-dd>/session-<uuid>`
per run. TBAi's equivalent is `conversationPolicy: "dedicated_thread"`, which
already persists the created conversation on the job (`schedulerStore.update`).
No new surface needed.

---

## 2. Current TBAi state

### 2.1 Scheduler core (`src/services/scheduler/`)

- `scheduler.ts` — timers (Bun.cron + setTimeout), `fireJob` (overlap guard →
  atomic claim → `ensureJobConversation` → `executeJobRun`), recovery,
  shutdown. **Engine-agnostic today only because every job is Direct.**
- `schedulerExecution.ts` — Direct adapter: `buildSchedulerTools()` (read-only
  tools execute, destructive tools always refuse), `resolveJobModel`
  (registry + credentials + `getModel`), `executeJobRun` (retry loop,
  timeout, abort, message persistence to the thread).
- `schedulerStore.ts` — SQLite CRUD + `claimRun`
  (`UNIQUE(job_id, occurrence_id)`), `JobCreate` payload.
- `schedulerValidation.ts` — `checkProvider`, `checkExistingThread`,
  `checkScheduleFields`.
- `schedulerTools.ts` — AI-tool handlers (model-driven create/update/run)
  mirroring the REST surface.

### 2.2 OpenCode seam (`src/services/opencode/`)

- `sessions.ts#ensureOpenCodeSession(conversationId)` — **the only** TS →
  OpenCode-server boundary for session lifecycle. Row-authoritative:
  refuses unless the conversation row has `engine === "opencode"`. Creates or
  resumes the session, assigns a model if unbound, persists the
  `opencodeSessionId` pointer durably before the request (RT-001).
- `capabilities.ts` — `getOpenCodeCapabilities()` (agents, models,
  variants), `resolveOpenCodeModelRef`, `fetchDefaultModel`.
- `client.ts` — `createOpenCodeClient(baseUrl, { directory, transport })`,
  the official `@opencode/client` V2.
- `serviceAccess.ts` — `resolveOpenCodeServiceAccess(conversation)` →
  `{ baseUrl, transport, owner }` (managed vs adopted).
- No prompt-sending seam exists yet in the backend: the browser drives
  `session.prompt` through the proxy (`proxyRoutes.ts` allowlist,
  `OPENCODE_PROXY_ROUTES`). The backend has never needed to send a prompt
  itself — the scheduled run is the first backend caller.

### 2.3 UI (`web/src/features/scheduler/`)

`SchedulerPage` → `JobEditor` (837 lines: provider/model selectors, thinking
level, workspace, prompt, conversation policy) → `JobListItem` / `JobDetail`
/ runs. No engine dimension anywhere. Templates in
`lib/scheduler-templates.ts`.

### 2.4 Data (`src/db/index.ts`)

`scheduler_jobs`: `provider_id`, `model_id`, `thinking_level`,
`workspace_path`, `conversation_policy`, `conversation_id`, retry/timeout
columns. **No `engine` column.** `conversations` already carries
`engine`, `opencode_session_id`, `opencode_model`, `opencode_agent`,
`opencode_variant` (the OpenCode engine is a first-class row field).

---

## 3. Design

### 3.1 Invariant (the durable part)

> **The scheduler executes a job through exactly one execution interface,
> `runScheduledExecution(job, run, conversationId, signal) → ExecutionResult`,
> and the choice of engine is a per-job value read once, never a branch
> scattered through timers, recovery, retry, shutdown, or the UI store.**

Everything else in §4 is how we get there without churning the existing
Direct path. The engine field is data on the job row; the execution module is
the single place that reads it.

### 3.2 Schema (persistent contract — the one change AGENTS.md requires us to
surface explicitly before implementation)

`scheduler_jobs` gains:

```sql
ALTER TABLE scheduler_jobs ADD COLUMN engine TEXT NOT NULL DEFAULT 'direct';
-- engine: 'direct' | 'opencode'
ALTER TABLE scheduler_jobs ADD COLUMN max_runs INTEGER;      -- NULL = unlimited
ALTER TABLE scheduler_jobs ADD COLUMN expires_at INTEGER;    -- ms epoch, NULL = no expiry
ALTER TABLE scheduler_jobs ADD COLUMN workspace_folder_id TEXT;  -- §4d.2 B, NULL = raw path / temp
```

**§3.2b — `schedule_type` gains `'manual'` (§4e.4).** A table rebuild,
not an ALTER (SQLite cannot edit a CHECK; the repo's established pattern
is the `conversations.status` rebuild, `conversations.ts` L196-206):

```sql
-- copy existing rows, recreate CHECK IN ('once','cron','manual'), recreate indexes
CREATE TABLE scheduler_jobs_new (... same columns ... 
  schedule_type TEXT NOT NULL CHECK(schedule_type IN ('once','cron','manual')));
INSERT INTO scheduler_jobs_new SELECT * FROM scheduler_jobs;
DROP TABLE scheduler_jobs; ALTER TABLE scheduler_jobs_new RENAME TO scheduler_jobs;
-- recreate every index + FK on scheduler_jobs (scheduler_runs.job_id)
```

Existing rows are all `once`/`cron` and copy verbatim; a new `manual`
job has `next_run_at IS NULL`. The rebuild must recreate `scheduler_runs`'
FK (`ON DELETE CASCADE`) and the three `idx_scheduler_*` indexes, or the
FK silently drops.

Backward compatible: every existing job becomes `direct`, zero behavior
change. No column migration for `scheduler_runs` — a run inherits its
job's engine at claim time and that is enough for reporting (a
`run.provider_id`/`run.model_id` that already mirror the job are retained;
for OpenCode runs `provider_id` stores `"opencode"` and `model_id` the
session model, so run rows stay uniform).

Rationale for adding a column over inferring engine from the target
conversation (e.g. `conversationPolicy=existing_thread` +
`conversation.engine`): a job can point at a dedicated thread that is
itself Direct or OpenCode, and the job's engine is what the *execution
adapter* is selected by. The engine is a property of the job, not of the
conversation it happens to land in. (A dedicated OpenCode job creates a
conversation **with** `engine: "opencode"`; the job and the conversation
then agree, and the conversation row stays the row-authoritative engine
source at session-ensure time — `ensureOpenCodeSession` refuses a
conversation whose row says `engine !== "opencode"`, so a wrong combination
fails fast at run start, which is the correct failure.)

### 3.3 Execution adapter interface

```ts
// src/services/scheduler/execution.ts (new — owns the seam)
export type JobEngine = "direct" | "opencode";

export interface ExecutionContext {
  job: SchedulerJob;
  run: SchedulerRun;
  conversationId: string;
  signal?: AbortSignal;
}

export interface ExecutionResult {
  ok: boolean;
  text: string;
  error: string | null;
  retryable: boolean;
}

/** The single engine dispatch. The only place `job.engine` is read. */
export async function runScheduledExecution(ctx: ExecutionContext): Promise<ExecutionResult>;
```

- `runScheduledExecution` is a thin switch: `direct` → the existing
  `executeJobRun` body (moved as-is into
  `schedulerExecutionDirect.ts`), `opencode` → `executeOpenCodeRun`
  (new, `schedulerExecutionOpencode.ts`).
- `scheduler.ts` (`fireJob`, `runJobNow`) calls `runScheduledExecution`
  instead of `executeJobRun`. Timer/claim/retry/shutdown code is untouched
  except that the conversation it resolves is engine-aware (§3.4).

### 3.4 Conversation resolution per engine

`ensureJobConversation(job)` today always creates a Direct conversation.
Becomes:

- `engine === "direct"` → unchanged.
- `engine === "opencode"`:
  - `dedicated_thread` → `conversationService.create({ title, providerId,
    engine: "opencode", workspaceMode,
    opencodeServiceOwner: serializeHistoryOwner(access.owner) })`
    (the engine column already exists on `conversations`).
    **Owner binding (new, §4f):** store the serialized owner of the
    service access the run will later resolve — read from
    `resolveOpenCodeServiceAccess` for a blank conversation (the active
    target), never a guessed literal. Under B7's profile model
    (`serviceProfile.ts`), an unbound owner makes
    `ensureOpenCodeSession`'s boundary check refuse the first run with
    `OpenCodeHistoryBoundaryError`. The session is **not** created
    here — it is created lazily at first prompt by
    `ensureOpenCodeSession`, exactly as the interactive chat route
    does. This keeps the adapter's failure surface small (a job whose
    OpenCode server is down still creates the conversation row; the
    *run* records the failure with retry semantics).
  - `existing_thread` → validate the target conversation exists, is not
    archived, and (new check) has `engine === "opencode"`; otherwise the
    run fails fast with a clear error. This is the one validation that
    must live in `schedulerValidation.ts` (`checkExistingThread` extended
    with an `engine` parameter).

### 3.5 OpenCode execution (`executeOpenCodeRun`)

Steps, in order, each individually testable:

1. **Resolve service + client.** `resolveOpenCodeServiceAccess(conversation)`
   → `{ baseUrl, transport }`. Build the directory-scoped client with
   `createOpenCodeClient(baseUrl, { directory, transport })`
   (`resolveConversationWorkspace(conversationId)` for the directory —
   same call the chat seam uses).
2. **Ensure session.** `ensureOpenCodeSession(conversationId)` →
   `{ sessionId, directory, reusedExistingSession }`. All the row-guards,
   model-binding, intent-journal, and orphan-recovery behavior of §2.2
   apply unchanged — the scheduled run is just another caller of the
   seam.
3. **Send the prompt.** `client.session.prompt({ sessionID, ... })` with
   the job's prompt (no scaffolding prefix — OpenCode's own context
   carries the workspace; the Direct path's `[Scheduled run of job ...]`
   header is a Direct-specific convention). A new backend seam
   `promptOpenCodeSession(client, sessionID, prompt, { signal })` in
   `src/services/opencode/sessions.ts` (or a small sibling module) owns
   this one call: it sends the prompt and resolves when the turn
   completes, bounded by the job's `timeoutSeconds` via the passed
   `AbortSignal` (OpenCode prompt turns are server-side work; the signal
   must interrupt the wait — on abort, `client.session.interrupt` best
   effort, mirroring `terminateOpenCodeSession`).
4. **Read the outcome.** After the turn, `client.session.get({ sessionID })`
   (or the messages already carried by the prompt response, depending on
   the installed client's contract — verify at implementation, §6) →
   extract the last assistant text for `outputExcerpt` (same 2000-char
   slice as Direct).
5. **Record.** `schedulerStore.updateRun` with `completed`/`failed`/
   `cancelled`, `error` from `toOpenCodeError` (the module's existing
   error vocabulary, §2.2), `provider_id: "opencode"`,
   `model_id: <session model>`.
6. **Retry/timeout loop.** The *shape* of Direct's retry loop
   (`maxAttempts`, `retryDelaySeconds`, timeout → `controller.abort()`)
   is reused, but each attempt is one full prompt turn — OpenCode's own
   step accounting is not TBAi's to manage. Retry classification:
   `OpenCodeNotReadyError` / connection failures → retryable; a
   **permission wait** (§3.11) → retryable for cron, terminal for once;
   a target-gone error (§3.14) → terminal.

### 3.6 Permissions for unattended OpenCode runs (the "never auto-approve"
rule, satisfied natively)

AGENTS.md: *destructive tools always refuse, no MCP tools in V1, never
auto-approve*. Direct encodes this with `refusalTool`. OpenCode encodes
it with its **permission system** (`permission.list`/`permission.reply`
routes in the proxy allowlist). A scheduled OpenCode run must therefore:

- **Not** reply `allow` to any pending permission automatically.

**V1 policy (Paseo-derived, §3.11):** a scheduled OpenCode run **never
replies to a permission at all.** If the turn ends with a pending
permission, the run *fails* with a clear reason — it does not deny-and-continue
(an early draft of this plan said to deny; §3.11 supersedes that,
because a denial hides the reason the user needed to be there; a failure
surfaces it). The session is left intact for an interactive retry.
Document this in `docs/decisions.md`: *a scheduled OpenCode run
never approves and never denies; a permission wait is a run failure,
retryable on the next cron slot, terminal for a once job.*

### 3.7 Validation (`schedulerValidation.ts`)

New `checkEngine` / extended `checkProvider`:

- `engine === "direct"` → existing `checkProvider` (registry lookup).
- `engine === "opencode"` → `providerId` is fixed to `"opencode"` (the
  UI exposes OpenCode models through `getOpenCodeCapabilities()`, not
  through `registry`); `modelId` may be empty (the session model-binding
  in `ensureOpenCodeSession` falls back to the server default — M11
  degradation). `thinkingLevel` maps to the OpenCode model *variant*
  (`listOpenCodeModelVariants`), not provider options.
- `existing_thread` + `engine` mismatch check (§3.4).
- **§3.12 self-limiting:** `maxRuns` (when set) must be `> 0`;
  `expiresAt` (when set) must be a future timestamp; both optional,
  both cron-only (a once job is rejected if either is set — its
  `execAt` is already its terminal bound).

### 3.8 UI (extend `JobEditor`, never duplicate)

- One new **Engine** row (segmented control: `Direct | OpenCode`) at the
  top of the model section, matching the app's existing "Engine" concept
  (`web/src/features/chat/`, `OpenCodeAgentChip`).
- Engine = Direct → current provider/model/thinking selectors, unchanged.
- Engine = OpenCode → model selector sourced from
  `getOpenCodeCapabilities()` (agents + models + variants, already a
  frontend capability); agent is optional.
- `existing_thread` conversation list filters to conversations matching
  the chosen engine (Direct list stays as-is for Direct).
- **§3.12 self-limiting fields:** one "Stop after" line in the
  schedule section — an optional run-count input and an optional expiry date,
  both blank by default (cron jobs only; a once job has no UI for
  them since `execAt` is its terminal bound).
- **Service-profile note (§4f):** OpenCode service access now carries a
  *profile id* (`serviceProfile.ts`, B7); `opencode_service_owner` on a
  conversation row is the serialized form of that owner (`managed` /
  `adopted:<origin>` / `profile:<id>`). The OpenCode execution path must
  only ever resolve its owner through `resolveOpenCodeServiceAccess`
  and `serializeHistoryOwner(access.owner)` — never invent owner strings.
  If a dedicated OpenCode thread is created without storing the owner,
  its first `ensureOpenCodeSession` refuses with
  `OpenCodeHistoryBoundaryError` (boundary check); the create step in
  Task 4 therefore stores
  `opencodeServiceOwner: serializeHistoryOwner(access.owner)` read from
  the same service access the run will later resolve.
- `JobListItem` / `JobDetail` / run rows show an engine badge; OpenCode
  run rows link to their conversation (the session transcript); a
  "N of M runs" chip on `JobListItem` when `maxRuns` is set.
- `scheduler-draft.ts` gains `engine` + `maxRuns` + `expiresAt`;
  templates may carry one.
- No new routes, dialogs, or entry flows — this is a new field in the
  existing editor, not a new surface.

### 3.9 API / routes (`src/routes/scheduler.ts` + `schedulerTools.ts`)

- Job create/update Zod schemas gain `engine: "direct" | "opencode"`
  (default `"direct"`).
- `schedulerTools` (AI-driven scheduler) mirrors: a model creating a job
  can pass `engine: "opencode"`. The tool schema's `providerId`/`modelId`
  semantics per engine are stated in the tool's description (same
  "declared once" discipline as OpenChamber's agent-tool docs).
- Responses include `engine` on jobs and runs.

### 3.10 Docs

- `docs/scheduler.md` — gains an "Engines" section: which adapter runs
  which, the permission rule, the retry semantics per engine.
- `docs/decisions.md` — the three decisions from §3.2/§3.6 plus the
  deferred plugin (`openchamber_schedule` for OpenCode agents, §5).

---

## 4. Task decomposition

Each task ends independently testable and committable. TDD throughout
(repo rule §5: a structural change needs a test that would have failed
before it).

### Task 1 — Schema: new columns + `schedule_type` rebuild on `scheduler_jobs`

- `src/db/index.ts`:
  - `CREATE TABLE scheduler_jobs` gains
    `engine TEXT NOT NULL DEFAULT 'direct'`, `max_runs INTEGER`,
    `expires_at INTEGER`, `workspace_folder_id TEXT`;
  - **§3.2b rebuild** for the new `schedule_type` CHECK
    `IN ('once','cron','manual')` (§4e.4): copy rows, drop, rename,
    recreate the three `idx_scheduler_*` indexes **and** the
    `scheduler_runs.job_id` FK (`ON DELETE CASCADE`) — a rebuild that
    drops the FK is a silent data-contract change.
  - The existing-DB migration adds the four columns via the guarded
    `ALTER TABLE ... ADD COLUMN` pattern already used for
    `scheduler_runs.conversation_id` (lines 589-595), and performs the
    same rebuild only when the `manual` CHECK is absent (idempotent,
    like the `conversations.status` rebuild).
- `schedulerStore.ts`: `JobRow`/`SchedulerJob`/`JobCreate` gain
  `engine`, `maxRuns`, `expiresAt`, `workspaceFolderId`; `create`
  accepts them, `update` accepts them, `list*` returns them. A
  `scheduleType: "manual"` job stores `execAt: null`, `nextRunAt: null`.
- **Test (would have failed before):** create a job with
  `engine: "opencode"` → stored and read back as `"opencode"`; create
  without any of the four → stored as `"direct"`, `null`, `null`,
  `null`; create a `manual` job → `execAt: null`, `nextRunAt: null`,
  no timer armed by `scheduleJob`; a pre-upgrade fixture DB (no
  columns, old CHECK) → migration adds all four columns AND rebuilds
  the table with the new CHECK, existing rows read as
  `engine: "direct"`, `maxRuns: null`, `expiresAt: null`,
  `workspaceFolderId: null`, and the `scheduler_runs` FK + indexes
  survive (asserted by a `PRAGMA foreign_key_list(scheduler_runs)`
  check and a cascade-delete test on a job row).
- Commit.

### Task 2 — Execution seam: `runScheduledExecution` + Direct adapter move

- New `src/services/scheduler/execution.ts` (§3.3 interface).
- Move the current `executeJobRun` body of `schedulerExecution.ts` into
  `schedulerExecutionDirect.ts` verbatim (behavior-preserving move: the
  file must still export `buildSchedulerTools`, `resolveJobModel`,
  `verifyJobWorkspace` — those stay in `schedulerExecution.ts`; only the
  run loop moves).
- `scheduler.ts`: `fireJob`/`runJobNow` call `runScheduledExecution`.
- **Test (behavior preservation):** the existing scheduler execution
  tests (retry, timeout, cancellation, message persistence) pass
  unchanged — they are the "test that would have failed" gate for a
  move that must not change behavior. Plus: a Direct job still executes
  through the Direct adapter (adapter selection asserted via a spy on
  the Direct module).
- Commit.

### Task 3 — Long-horizon timer bound (independent, §1.3)

- `scheduler.ts#scheduleOnce`: cap `delay` at `MAX_TIMER_DELAY_MS`
  (2,147,483,647); when exceeded, set the timer to fire at
  `now + MAX_TIMER_DELAY_MS` and re-schedule the remainder on fire
  (the timer body already re-reads the job from the DB, so the re-arm
  is the existing `scheduleJob` path; add the re-arm branch).
- **Test:** a job with `execAt` 60 days out → timer is set for ≈24.8
  days, not 60; on the intermediate fire the remainder is re-armed
  without claiming the occurrence (the UNIQUE guard already blocks a
  premature claim — the intermediate fire must *not* call `fireJob`,
  only re-schedule). This last property is the one that would fail if
  the re-arm naively reused the fire path.
- Commit.

### Task 4 — Engine-aware conversation resolution + validation + folder binding

- `schedulerExecution.ts#ensureJobConversation`:
  - dedicated conversation carries `engine` from the job (Direct create
    unchanged; OpenCode create sets `engine: "opencode"`).
  - **§4d.2 A/B: the dedicated sub-mode drives the workspace.**
    `workspaceFolderId` set → `workspaceMode: "project"` + the folder
    id (the thread lives under the project folder in the sidebar);
    unset → `workspaceMode: "simple"` (today's temp-chat behavior).
    Both engines use this — the OpenCode path additionally needs the
    folder's path as the session's `location.directory`
    (`resolveConversationWorkspace` closes that chain, never the job).
- `resolveJobWorkspace(job)` (new, in `schedulerExecution.ts`, before
  the engine split): `workspaceFolderId` → `folderService.get(id).path`
  (a deleted folder → `ScheduleTargetGoneError`, §3.14); else the raw
  `workspacePath`. Both adapters consume it; the Direct `verifyJobWorkspace`
  sandbox check runs on the resolved path.
- `schedulerValidation.ts`: `checkExistingThread` gains the
  engine-mismatch check (§3.4) **and** the folder-mismatch check
  (§4d.2 D: an existing thread's folder ≠ the job's `workspaceFolderId`
  → 422) **and** the imported-target refusal (§4f.2: an
  `existing_thread` target with `opencodeImported = 1` → 422 "imported
  sessions are not schedulable targets"); `checkProvider` gains the
  `checkEngine` split (§3.7).
- **Owner binding on create (§4f.2, new):** the dedicated OpenCode
  create passes
  `opencodeServiceOwner: serializeHistoryOwner(access.owner)` —
  asserted by a test that the created row's owner equals the
  serialized active target's owner (managed and profile-qualified
  cases).
- **Test:** OpenCode job + `existing_thread` at a Direct conversation
  → engine-mismatch at save; an `existing_thread` target with
  `opencodeImported = 1` → 422 "imported sessions are not schedulable"
  (§4f.2); OpenCode job + `dedicated_thread` →
  created row carries `engine: "opencode"` + the folder (when set) or
  a temp chat folder (when unset); a job whose `workspaceFolderId`
  points at a deleted folder → run-time `ScheduleTargetGoneError`;
  `resolveJobWorkspace` returns the folder path for a folder-bound job
  and the raw path otherwise.
- Commit.

### Task 5 — OpenCode prompt seam

- New `src/services/opencode/schedulerPrompt.ts` (owner: the
  opencode service, since it is the only code allowed to call the
  OpenCode client for prompt work):
  `promptOpenCodeSession(conversationId, prompt, { signal, timeoutMs })`
  → resolves with `{ text, permissionWait }` where `permissionWait`
  (null or the pending tool name) reports a permission the turn left
  outstanding (§3.11 — the seam does **not** reply to it; it surfaces
  it).
- Internals: resolve access → `ensureOpenCodeSession` →
  `client.session.prompt` with the signal wired to a polling interval
  on `client.session.permission.list`; on a permission wait, throw
  `OpenCodePermissionWaitError(toolName)` (§3.11) — the session is left
  intact, no interrupt, no reply.
- **Test (against a stubbed OpenCode transport, the established pattern
  in `tests/integration/opencode/`):** happy path resolves with the
  last assistant text; a turn ending with a pending permission throws
  `OpenCodePermissionWaitError` and the session is *not* interrupted;
  a timeout aborts the wait and best-effort `session.interrupt` is
  attempted; a `OpenCodeNotReadyError` propagates classified as
  retryable.
- Commit.

### Task 6 — OpenCode execution adapter + retry/timeout

- New `src/services/scheduler/schedulerExecutionOpencode.ts`:
  `executeOpenCodeRun(ctx)` — the loop of §3.5, reusing the
  `ExecutionResult`/retry/timeout shape; records runs with
  `provider_id: "opencode"`; a **permission wait** (`OpenCodePermissionWaitError`,
  §3.11) is **retryable for cron jobs, terminal for once jobs** — the
  run's `error` text quotes the pending tool.
- `execution.ts#runScheduledExecution` dispatches `"opencode"` to it.
- **Test:** success path (run `completed`, excerpt = last assistant
  text, `provider_id` = `"opencode"`); server-not-ready → retry up to
  `maxRetries` then `failed` (retryable classification asserted);
  permission wait → cron: next slot retries, once: terminal `failed`;
  cancellation → `cancelled` + interrupt attempted;
  **§4f.2:** `OpenCodeHistoryBoundaryError` → terminal `failed` for
  both cron and once (no retry), run's `error` names the refusal kind.
- Commit.

### Task 7 — API surface: routes + AI tools + validation wiring

- `src/routes/scheduler.ts`: Zod schemas + response mapping gain
  `engine` (default `"direct"`), `maxRuns`, `expiresAt`.
- `src/lib/validation.ts` (repo rule: all API input validation lives
  here): the job create/update schemas gain `engine`, `maxRuns`,
  `expiresAt`.
- `schedulerTools.ts`: create/update handlers pass `engine` through;
  the tool schema description states the per-engine
  provider/model semantics (§3.9).
- **Test:** create a job via the route with `engine: "opencode"` →
  stored; via the AI tool with `engine: "opencode"` and empty
  `modelId` → accepted (server default applies at run time); an
  `existing_thread` + engine-mismatch → 422 with the validation
  message; a cron job with `maxRuns: 0` or `expiresAt` in the past →
  400 (§3.12 validation); a once job with `maxRuns` set → 400.
- Commit.

### Task 8 — UI: engine row + self-limiting fields + simplified "When" + multi-time

- `web/src/features/scheduler/lib/scheduler-draft.ts`: draft gains
  `engine` (default `"direct"`), `maxRuns`, `expiresAt`.
- **§4e.2 — the "When" control is replaced.** The `once | cron`
  toggle and the 7-`RepeatPreset` row are removed. In their place, one
  **"When" segmented control** with three options:
  - **Once** — the current once block (date + time + quick slots),
    unchanged.
  - **Repeats** — a *cadence* selector
    (`Daily · Weekly · Specific days · Every N min · Every hour ·
    Custom`) + a **times list** (OpenChamber multi-time row, add /
    remove) + the weekdays row when cadence = Weekly / Specific days.
    The cadence + times + days compile to `cronExpression` (replacing
    `presetToCron`'s 7-case switch with a cadence-aware one). "Custom"
    = the raw-cron field (today's `advanced`).
  - **Manual** — no schedule inputs; a one-line note "This job only
    runs when you start it". Sets `scheduleType: "manual"`,
    `execAt: null`, no timer. The **Run now** button (already on
    every job) is the only way to fire it.
- `JobEditor.tsx`:
  - **Engine segmented control** (§3.8) — the model section switches its
    source between `providers` (Direct) and `getOpenCodeCapabilities()`
    (OpenCode); conversation list filters by engine; `JobPayload` gains
    `engine`, `maxRuns`, `expiresAt`.
  - **"Stop after" line** (§3.12 UI) under Repeats only: optional run
    count + optional expiry date, both blank by default. A Manual or
    Once job has no Stop-after.
  - **Cron example chips** (§4c.2.1) under the Custom cadence.
  - **Calendar date picker** (§4c.2.3) for Once jobs.
  - **Per-model variant select** (§4c.2.2) in the OpenCode model
    section, disabled when the model offers none.
  - **Multi-time preset** (§4e.3): the "Daily multi-time" template
    seeds a Repeats/Daily draft with 3 times, not a cron string.
  - **Times list** (§4e.3): add/remove `HH:MM` rows under Repeats
    (Daily / Weekly / Specific days cadences); the times compile into
    the cron hour list (`0 6,12,18 * * *`).
- `JobListItem` / `JobDetail`: engine badge + OpenCode run →
  conversation link; "N of M runs" chip when `maxRuns` set; a Manual
  job's row shows "Manual — no schedule" instead of a next-run, and
  the Run-now button is always visible.
- `scheduler-templates.ts`: the 7 presets collapse to the new cadence
  values; at least one OpenCode template + one Manual template so the
  gallery shows both.
- **Test (DOM, per repo conventions):** editor defaults to Direct
  (existing behavior, unchanged); the "When" control shows three
  options, not once/repeat + 7 chips; selecting Repeats + Daily shows
  the times list (add a second time, the cron preview updates to
  `0 6,12 * * *`); Repeats + Specific days shows the weekdays row and
  compiles to `0 9 * * 1,3,5`; Manual shows no date/cron inputs and
  saves `scheduleType: "manual"` with `execAt: null` and no armed
  timer; the Run-now button is present on a Manual job; switching to
  OpenCode re-sources the model list and shows the variant select;
  saving an OpenCode job posts `engine: "opencode"`; a Repeats job
  saved with `maxRuns: 5` + `expiresAt` posts both; a Once job shows
  no Stop-after; clicking a cron example chip fills the Custom field
  and updates the preview; the calendar picker disables past days;
  an existing Direct job edited with the engine switched to OpenCode
  is rejected server-side by Task 7 when its conversation policy
  targets a Direct thread.
- Commit.
- **§4d.2 (folder binding + specific days):**
  - **Folder selector** replaces the free-text workspace input when
    `dedicated_thread` + "Project folder" sub-mode is chosen; populated
    from `GET /api/folders` (registered project folders: name + color
    dot + path tooltip). Free-text is retained for unregistered paths
    (a "Custom path" option in the same control).
  - **Existing-thread lock:** selecting `existing_thread` swaps the
    workspace control to a **read-only line** showing the target
    conversation's folder name (no re-pick; the thread owns its
    folder, §4d.2 A).
  - **"Temp (new chat)" sub-mode** in the dedicated-thread section: a
    radio pair "Project folder / Temp" — "Temp" = today's
    `workspaceMode: "simple"` hidden chat folder (§4d.1).
  - **Weekdays checkbox row** (§4d.2 C-i): a new **"Weekdays
    (custom days)"** repeat preset with 7 locale-ordered day
    checkboxes; selecting days + a time writes a cron string
    (`0 9 * * 1,3,5`) into the existing `cronExpression` — no new
    schedule type, no new column. The preset's summary line reads
    "Mon, Wed, Fri 09:00".
  - `JobListItem`'s workspace line shows the **folder name** (linked)
    when the job is folder-bound, the raw path otherwise.
  - **DOM tests:** folder selector shows registered folders and hides
    them under "Temp" sub-mode; existing-thread lock hides the picker
    and shows the thread's folder; the weekdays preset writes the
    expected cron string to `draft.cronExpression` and the preview
    reflects it; `JobListItem` renders a folder name, not a path, for
    a folder-bound job.
- Commit.

### Task 9 — Docs

- `docs/scheduler.md` "Engines" section (§3.10): adapter map, the
  permission rule, retry semantics per engine, what a run row means for
  each engine. Also document §3.11 (permission-wait = failure, not
  denial), §3.12 (`max_runs` / `expires_at`), §3.13 (catch-up, never
  replay), §3.14 (target-gone = terminal).
- `docs/decisions.md`: entries for (a) the `engine` column + its
  rationale vs. inferring from the conversation, (b) **permission-wait
  is a failure** (Paseo pattern; replaces the earlier "deny and
  continue" draft — the run's transcript shows *why* it failed, not a
  silent tool refusal), (c) the deferred in-session
  `openchamber_schedule` plugin (§5), (d) the timer bound (Task 3),
  (e) `max_runs` / `expires_at` self-limiting jobs, (f) target-gone is
  terminal.
- Commit.

### Task 10 — `advanceNextRunAtPast` in `cron.ts` (§3.13)

- `src/services/scheduler/cron.ts`: add the bounded catch-up helper
  (§3.13 signature) and `MAX_CATCH_UP_OCCURRENCES`.
- `scheduler.ts`: the cron fire path and `recoverEssential`'s cron
  rebuild call it instead of a single `computeNextRun`.
- **Test:** a cron job last fired 3 slots ago (app was down) → one run
  now, `nextRunAt` advances past all three missed slots; a job whose
  catch-up would exceed the bound → marked `missed`, timer cleared, log
  line; a job whose cursor is already in the future → unchanged.
- Commit.

### Task 11 — `max_runs` + `expires_at` completion (§3.12)

- `schedulerStore.ts`: a `countCompletedRuns(jobId)` helper (count of
  `scheduler_runs.status = 'completed'` for the job).
- `scheduler.ts`: `fireJob`'s terminal block (lines 238-252) becomes
  `isTerminalCompletion(job)` (§3.12) — a cron job completes when
  `maxRuns` is reached *or* `nextRunAt` would fall past `expiresAt`;
  the recurring bookkeeping refresh is skipped on completion.
- `schedulerValidation.ts`: `checkScheduleFields` (or a new
  `checkSelfLimiting`) rejects `max_runs < 1` and `expires_at <= now` at
  create/update; the field is optional (null = unlimited / no expiry).
- **Test:** a cron job with `maxRuns: 3` → after the 3rd completed run
  the job is `completed` + disabled + timer cleared; a cron job with
  `expiresAt` in the past → rejected at save; a job with both set →
  whichever bound hits first completes it; a job with neither →
  unchanged behavior (regression check against the current
  recurring-refresh path).
- **`manual` jobs are excluded** (§4e.4): a `manual` job's `nextRunAt`
  is null, `scheduleJob` arms no timer, and `isTerminalCompletion`
  never applies (a manual job is not a recurring one). The only path
  that runs a manual job is `runJobNow`.
- Commit.

### Task 12 — Permission-wait = run failure (§3.11; supersedes §3.6)

- `src/services/opencode/schedulerPrompt.ts` (Task 5's seam): replace
  the "deny-on-seek" step with a **permission-wait probe** — after the
  prompt turn's activity read, if `session.permission.list` is
  non-empty and the session is not still running, the seam throws a
  new `OpenCodePermissionWaitError` carrying the pending tool name(s),
  *instead of replying deny*. The session is left intact (a later
  manual run can still be approved interactively).
- `schedulerExecutionOpencode.ts`: classify
  `OpenCodePermissionWaitError` as **retryable for cron jobs,
  terminal for once jobs** (§3.11); the run's `error` text quotes the
  pending tool, sanitized.
- **Test:** a stubbed turn that ends with a pending permission →
  run records `failed` with the permission error, the session is
  *not* interrupted, and a subsequent manual run on the same
  conversation still reaches the prompt (the pending permission is
  still there, user-approvable). A cron job's next slot retries; a
  once job is terminal.
- Commit.

### Task 13 — `ScheduleTargetGoneError`: terminal, not retryable (§3.14)

- `src/services/scheduler/schedulerTypes.ts`: add
  `ScheduleTargetGoneError` (§3.14 shape).
- `schedulerExecution.ts`:
  - `ensureJobConversation`'s "Conversation not found (deleted or
    archived)" `ToolError` (line 232-243) becomes
    `ScheduleTargetGoneError` for `existing_thread` jobs. This is the
    **one behavior change** in this task: that error is no longer
    retried — call it out in the commit message.
  - `isRetryableError` (line 118) returns `false` for
    `ScheduleTargetGoneError`.
- `schedulerExecutionOpencode.ts`: an OpenCode job whose conversation
  was archived/deleted between save and fire (the run-time twin of the
  save-time `checkExistingThread` check) throws
  `ScheduleTargetGoneError` before `ensureOpenCodeSession` is called.
- **Test:** an `existing_thread` job pointing at an archived
  conversation → run fails terminal, job marked `failed`, timer
  cleared, no retry; a `dedicated_thread` job is unaffected (its own
  target always exists at run start); an OpenCode job whose
  conversation was deleted concurrently → same terminal classification.
- Commit.

### Task 14 — `manual` schedule type + multi-time cadence compile (§4e)

- `src/services/scheduler/scheduler.ts`:
  - `scheduleJob(job)`: a `manual` job returns after
    `clearTimer(job.id)` — **no timer is armed** (the manual-mode
    invariant; the job is reachable only via `runJobNow`).
  - `runJobNow` is unchanged and remains the only fire path for
    manual jobs; its `manual-` occurrence id already distinguishes
    it from scheduled fires.
- `src/services/scheduler/cron.ts`: a **cadence-aware compiler**
  replaces `presetToCron`'s 7-case switch (the function moves to the
  backend owner at Task 2, or stays a pure helper the UI imports —
  either way one owner):
  `compileCadence(cadence, times: string[], weekdays: number[])` →
  `cronExpression`. Cadences: `daily`, `weekly`, `specificDays`,
  `everyNMinutes`, `hourly`, `custom` (passthrough). `times` compile
  to the cron hour list (`"0 6,12,18 * * *"`); `weekdays` (0-6)
  join the weekday field (`"0 9 * * 1,3,5"`). **`everyNMinutes` and
  `hourly` ignore `times`** (§4e.4b): `everyNMinutes` →
  `*/N * * * *` (N=1 → `* * * * *`), `hourly` → `M * * * *`. At
  least one time and (for `weekly` / `specificDays`) at least one
  weekday are required, else `null`.
- `schedulerValidation.ts`: `checkScheduleFields` accepts
  `scheduleType === "manual"` (no `cronExpression` or `execAt`
  required; both rejected when present), and for `cron` requires a
  non-empty `cronExpression` (the times/days are compiled before
  save, so a job with neither times nor days cannot save as `cron`).
- **Test:** a manual job → `scheduleJob` arms no timer (assert
  `activeTimerCount()` is unchanged after the call), `runJobNow`
  still fires it; `compileCadence("daily", ["06:00","12:00","18:00"],
  [])` → `"0 6,12,18 * * *"`; `compileCadence("specificDays",
  ["09:00"], [1,3,5])` → `"0 9 * * 1,3,5"`; a `cron` job with zero
  times → validation error; a `manual` job with a `cronExpression`
  set → validation error.
- Commit.

---

## 4b. Paseo study — patterns to fold in (no architecture change)

Paseo's scheduler (`packages/server/src/server/schedule/`) is a tick-poll JSON-file
store; TBAi's timer + SQLite + claim-guard architecture is better and stays. But
Paseo's *edge-case semantics* are the reference to copy. Four additions below
extend the design without touching the engine-dispatch invariant.

### 3.11 Permission-wait = terminal failure (replaces §3.6 "deny and continue")

**Paseo's rule:** a scheduled agent that ends its turn *waiting for a
permission* is a **failure**, not a hang and not a silent denial. The run
fails with the reason, the schedule stays active, and the next slot retries.
No auto-approve, no "deny the tool and keep going."

**TBAi adaptation (replaces the §3.6 deny-on-seek step):** while the
OpenCode turn is active, poll `client.session.permission.list`. If a pending
permission is present when the turn's activity read says idle/blocked:
- the run records `failed` with the error string
  `Scheduled run blocked on interactive permission "<tool>"; approval is
  unavailable unattended` (the tool name from the pending request, sanitized).
- the failure is **retryable** for a cron job (next slot retries; a different
  prompt or a user-approved session state may pass), **non-retryable** for a
  once job (terminal `failed`, matching the Direct path's retry semantics).
- The session is **not** interrupted or deleted: a later manual run in the
  same conversation can still be approved interactively.

This is the cleanest articulation of AGENTS.md's "never auto-approve" and
keeps the run's failure visible in the transcript instead of burying it in
a tool refusal.

### 3.12 `max_runs` + `expires_at` on recurring jobs

**Paseo's rule:** a schedule can self-limit: `maxRuns` (stop after N
completed runs) or `expiresAt` (stop after a date). Completion is terminal:
`status = "completed"`, `nextRunAt` cleared, no more ticks.

**TBAi schema addition (joins §3.2, same migration):**

```sql
ALTER TABLE scheduler_jobs ADD COLUMN max_runs INTEGER;          -- NULL = unlimited
ALTER TABLE scheduler_jobs ADD COLUMN expires_at INTEGER;        -- ms epoch, NULL = no expiry
```

**Semantics (mirror Paseo's `shouldCompleteSchedule`):**
- A cron job whose completed-run count (runs with `status = "completed"`,
  excluding the current in-flight attempt) reaches `maxRuns`, or whose
  `nextRunAt` would fall past `expires_at`, is marked `completed` + disabled
  and its timer cleared — the *terminal-once path in `fireJob`* (§2.1,
  lines 238-252) extended from `scheduleType === "once"` to
  `isTerminalCompletion(job)`:

  ```ts
  function isTerminalCompletion(job: SchedulerJob): boolean {
    if (job.status === "completed") return true;
    if (job.expiresAt != null && Date.now() >= job.expiresAt) return true;
    if (job.maxRuns != null && completedRunCount(job.id) >= job.maxRuns) return true;
    return false;
  }
  ```

- `fireJob`'s cron bookkeeping refreshes `nextRunAt` only when
  `!isTerminalCompletion(job)`; otherwise the terminal path clears the timer.
- **Validation:** `max_runs > 0` or null; `expires_at > now` at create
  (a past expiry is rejected at save, not silently completed); `max_runs`
  and `expires_at` are both optional and independent.
- **UI:** one line in the editor's schedule section ("Stop after: [N] runs /
  [date]", both optional); `JobListItem` shows a "N of M runs" chip when
  `maxRuns` is set, mirroring Paseo's card footer.

### 3.13 Missed-catch-up for recurring jobs (`advanceNextRunAtPast`)

**Paseo's rule:** if a recurring schedule's cursor is in the past (app was
down across one or more slots), compute the *next* occurrence from the
past-due one and **advance past every missed slot** until the cursor is in
the future. One run, skip-forward — never replay the backlog.

**TBAi addition to `src/services/scheduler/cron.ts`:**

```ts
/**
 * Compute the next run strictly in the future. If `from` is past-due,
 * advance occurrence-by-occurrence past every missed slot (bounded: no
 * more than MAX_CATCH_UP_OCCURRENCES iterations; beyond that the schedule
 * is treated as permanently overdue and the job is marked `missed`).
 *
 * @returns the first occurrence strictly after `now`, or null when the
 *   expression cannot produce one within the bound.
 */
export function advanceNextRunAtPast(
  cronExpression: string,
  timezone: string,
  now: number,
  from?: number,
): number | null;
```

- **Caller change:** `scheduler.ts`'s recurring fire path and
  `recoverEssential`'s cron rebuild use `advanceNextRunAtPast(expr, tz,
  Date.now(), job.nextRunAt)` instead of a single `computeNextRun(...)`.
  A cron job that missed 3 slots while the app was down fires **once now**
  (for the first missed slot) and its `nextRunAt` advances past all three
  — the runs for slots 2 and 3 are *not* replayed.
- **Bound:** `MAX_CATCH_UP_OCCURRENCES = 1440` (one week of 5-minute slots)
  as a constant in `cron.ts`. Beyond the bound, the job is marked
  `missed` (existing status) with a log line, not an infinite loop.
- **Once jobs are unaffected** — `handleOverdueOnce` already encodes the
  grace-window rule for the single-occurrence case; this change is cron-only.

### 3.14 Target-gone is terminal, not retryable

**Paseo's rule:** if a schedule's target (agent/workspace) no longer
exists, the schedule **completes immediately** — retrying only burns the
run until expiry. `ScheduleTargetGoneError` → `completeSchedule`.

**TBAi adaptation (run-time twin of `checkExistingThread`, which covers
save-time only):**

- `executeOpenCodeRun` / `executeJobRun`: if the resolved conversation is
  **archived** or **deleted** at run start (a concurrent teardown between
  save and fire), throw a new `ScheduleTargetGoneError` in
  `src/services/scheduler/schedulerTypes.ts`:

  ```ts
  export class ScheduleTargetGoneError extends Error {
    constructor(conversationId: string, reason: "archived" | "deleted") {
      super(`Job target conversation ${conversationId} is ${reason}; no further runs are possible`);
      this.name = "ScheduleTargetGoneError";
    }
  }
  ```

- `isRetryableError(err)` (line 118 of `schedulerExecution.ts`) returns
  `false` for this class; `fireJob`'s terminal path (§2.1 lines 238-252)
  marks the job `failed` (not `completed` — the job was valid when saved,
  the target was removed later) and clears its timer.
- The same classification applies to `ensureJobConversation`'s
  "Conversation not found (deleted or archived)" `ToolError` for
  `existing_thread` jobs: today it is a generic `ToolError` (retryable);
  it becomes `ScheduleTargetGoneError` (terminal). **This is a behavior
  change for that one existing error** and must be called out in the
  task that makes it — the retry loop will no longer hammer a deleted
  conversation.
- `dedicated_thread` jobs are unaffected (they create their own target).

## 4d. TBAi folder/thread model study — workspace population (new)

OpenChamber's scheduler *inherits* the session's directory (a task runs in
the project the session belongs to). TBAi has no sessions-that-own-projects
in the same shape; it has a **folders registry**
(`src/services/folders.ts`, `folders`/`folder_links`/`folder_groups` tables)
and a **conversations** model that is the unit of workspace binding. The
scheduler today ignores both: `JobEditor`'s "Workspace" is a free-text
`workspacePath` string, and `dedicated_thread` creates the conversation with
`workspaceMode: "simple"` (a hidden temp chat folder). That's the gap.

### 4d.1 The model (verified on disk)

- **`folders` table** (`src/db/index.ts` L477): registered project folders
  (`kind='regular'`) and hidden chat folders (`kind='chat'`).
  `GET /api/folders` returns the user-facing list (hidden chat folders
  excluded); `GET /api/folders/all` includes them.
- **`conversations.workspace_mode`** (`conversations.ts` L295):
  - `'simple'` → a hidden `kind='chat'` folder on
    `workspace/chats/<id>` (the "temp folder" mode — created via
    `createChatWorkspace(id)` in `create`, L157).
  - `'project'` → `workspace_folder_id` points at a registered
    `kind='regular'` folder; the folder's `path` is the workspace root
    (resolved by `resolveConversationWorkspace`, the only place the
    chain `conversation → folder → dir` is closed).
- **`folder_links`**: authorized linked/allowed paths *inside* a folder
  (no real symlinks, phase 1) — the folder's working set.

### 4d.2 Scheduler changes this implies

**A. Workspace source = folders registry, not free text.**
- `JobEditor`'s "Workspace" input becomes a **folder selector** populated
  from `GET /api/folders` (registered project folders, colored, with
  their path shown). Free-text entry is kept as a fallback for
  unregistered paths (a Direct job today can name any workspace under the
  permitted root).
- When `existing_thread` is selected: the workspace selector is
  **locked to the target conversation's folder** — the user picks the
  thread, the folder follows (`conversations.ts` L399: switching
  `workspaceMode` back to `simple` clears the folder id, so a thread's
  folder is the thread's, not a free choice). The editor shows the
  thread's folder as a read-only line, no re-pick.
- When `dedicated_thread` is selected: two sub-modes, mirroring the
  app's own two-mode model:
  - **"Project folder"** — a folder selector (same source as A). The
    created conversation uses `workspaceMode: "project"` +
    `workspaceFolderId`, so the run's thread lives in the project's
    folder (visible under that folder in the sidebar), and the OpenCode
    session's `location.directory` is the folder's path.
  - **"Temp (new chat)"** — `workspaceMode: "simple"`; the run's
    thread is a fresh hidden chat folder, matching today's default.
- `JobDetail`'s workspace line shows the *folder name* (linked) instead
  of a raw path when the job is folder-bound; raw path otherwise.

**B. Schema: `workspace_folder_id` on `scheduler_jobs` (joins §3.2
migration).**

```sql
ALTER TABLE scheduler_jobs ADD COLUMN workspace_folder_id TEXT;  -- NULL = raw path / temp
```

- `workspacePath` stays (the effective dir, resolved at run time from
  the folder when set, so a folder rename is tracked, not frozen).
- **Run-time resolution** (owner: `schedulerExecution.ts`, *before* the
  Direct/OpenCode split — both engines need it): `resolveJobWorkspace(job)`
  → if `workspace_folder_id` is set, `folderService.get(id).path`; else
  the raw `workspacePath`. A folder that was *deleted after save* falls
  back to `ScheduleTargetGoneError` (§3.14) — the folder registry is the
  source of truth, a stale id is a gone target, not a silent raw path.

**C. No "pick specific days" — use OpenChamber's model instead of a new
one.** TBAi's cron is a single `HH:MM` per preset; there is no
weekdays-grid row. OpenChamber's `weekdays: number[]` +
`times: string[]` model compiles to cron: `times × weekdays` →
`"0 9,14 * * 1,2,5"` (their `runtime.js` does exactly this; see
§1's OpenChamber study). Two options, decide in the plan review:
- **(i) Recommended — preset-level "on specific days":** add a
  **"Weekdays (custom days)"** preset to `JobEditor`'s repeat control
  with the 7-day checkbox row (locale-ordered like OpenChamber's
  `rotateWeekdays`), writing a *cron string* (`0 <time> * * <days>`).
  No new schedule type; the existing `cronExpression` carries it. The
  preset's "summary line" shows "Mon, Wed, Fri 09:00".
- **(ii) Full OpenChamber parity:** multiple times × days per week
  (`times: string[]`, their multi-time row). That needs either a
  `times` array column on the job, or a cron string with repeated
  fields — (i) is the V1 scope, (ii) is a follow-up unless the user
  specifically wants several times per day.

**D. What this adds to the plan**
- §3.2 schema: + `workspace_folder_id`.
- Task 1: the column joins the same migration.
- Task 4 (engine-aware conversation resolution): the dedicated-thread
  sub-mode (`project` vs `simple`) is decided *here*, not in
  `ensureJobConversation`'s Direct-only create — the OpenCode path
  already needs the folder for `ensureOpenCodeSession`'s
  `location.directory`, so both engines share the resolver (4d.2 B).
- Task 7 (validation): `existing_thread` + folder mismatch (thread's
  folder ≠ selected folder) → 422; `dedicated_thread` + project sub-mode
  requires a registered folder id.
- Task 8 (UI): the folder selector (project sub-mode), the locked
  read-only line (existing-thread), the weekdays checkbox row
  (4d.2 C-i), the "N of M" + folder-name line on `JobListItem`.

## 4e. Schedule form simplification + multi-time parity (new)

The user asked for two things: **(1)** full OpenChamber parity with
multiple daily times, **(2)** a simpler "When" control than the current
`once / repeat` toggle + 7-preset row.

### 4e.1 Current TBAi "When" (the thing to simplify)

`JobEditor`'s schedule block is a **2-level control**:

- Level 1: a `once | cron` (`scheduleType`) segmented toggle
  (lines 454-479).
- Level 2: **seven** `RepeatPreset` chips — `minutes | hourly | daily |
  weekdays | weekly | monthly | advanced` (lines 545-556) — each with
  its own inline inputs. `once` shows a date + time + 3 quick slots.

That's 8 distinct shapes the user has to learn. OpenChamber collapses
this to **four kinds** (`daily | weekly | once | cron`, each with a
clean rule) — the model TBAi should match.

### 4e.2 The replacement: three "When" modes (not once/repeat)

Drop the `once/repeat` toggle and the 7-preset row. Replace with one
**"When" segmented control** with exactly three options, each named for
what it *does*, not for the cron internals:

| Mode | What it shows | Cron it writes |
|---|---|---|
| **Once** | a date + time picker (+ "in 1 h / tomorrow / next Mon" quick slots, kept) | `scheduleType: "once"` (`execAt`), as today |
| **Repeats** | a *cadence* selector (`Daily · Weekly · Specific days · Every N min · Every hour`), a **times list** (add/remove, OpenChamber's multi-time row), and a weekdays row when cadence = Weekly/Specific days | `scheduleType: "cron"`; the cadence + times + days compile to the cron string in `presetToCron`'s place |
| **Manual** | no schedule inputs at all — just a one-line note "This job only runs when you start it" | no `nextRunAt` is armed; the job is `enabled` but **unscheduled** |

**"Manual" is new** and is the "manual option" the user asked about:
the job exists in the list, can be **Run now** (TBAi already has
`runJobNow` in `scheduler.ts`), but has no timer. This is exactly
OpenChamber's model, where `runNow` is separate from the schedule and a
task with no due slot simply waits for a manual start. It is also how
you express "I want a saved prompt I can fire on demand, not a timer."

Concretely:
- A **Manual** job stores `scheduleType: "once"`, `execAt: null` (or a
  new `scheduleType: "manual"` — see §4e.4 for the schema call), and
  `nextRunAt: null`; `scheduleJob` sees no timer to arm.
- The **list row** for a Manual job shows "Manual — no schedule" instead
  of a next-run; the **Run now** button is always present (it already
  is, for every job).
- Manual + `enabled` is coherent: `enabled` means "may run", not "has
  a timer". A Manual job that is `disabled` cannot be run now either.

### 4e.3 Multi-time parity (OpenChamber `times: string[]`)

"Repeats" mode carries a **times list** — OpenChamber's
`schedule.times` array, not a single time:

- UI: a row of `TimePill`-style inputs with **add / remove** buttons
  (their `addTime`/`removeTimeAt`, lines 960-995). At least one time
  required.
- Cadence = `Daily` → one cron *minute/hour* expression per time:
  `times.map(t => m h)` joined, e.g. `0 6,12,18 * * *`.
- Cadence = `Weekly` / `Specific days` → the weekdays row
  (§4d.2 C) × times, e.g. `0 9,14 * * 1,3,5`.
- Cadence = `Every N min` / `Every hour` → ignores the times list
  (a single expression: `*/N * * * *` or `m * * * *`), the same as
  today's `minutes`/`hourly` presets.

The cron string is still the stored value (no schema change for times:
they compile to cron). The **list-row summary** reads OpenChamber's way:
"Daily at 06:00, 12:00, 18:00" or "Mon, Wed, Fri at 09:00, 14:00".

#### 4e.4b "Every N min" is just a cron value — no special case

The "Every N min" cadence is **not a different mechanism**; it writes the
same cron string the existing `minutes` preset already does
(`scheduler-templates.ts` L141): `*/N * * * *` (`* * * * *` for N=1).
The times list is hidden for this cadence (there's nothing to pick —
the interval is the whole schedule). No new column, no new schedule
type. It only looks like a fourth shape in the UI because the cadence
selector surfaces it as a named option.

| Every N min | Cron string |
|---|---|
| every 1 min | `* * * * *` |
| every 5 min | `*/5 * * * *` |
| every 15 min | `*/15 * * * *` |
| every 30 min | `*/30 * * * *` |

Note: cron `*/N` means "every N minutes **of the hour**" — `*/15`
fires at :00, :15, :30, :45 (1,440 runs/day at N=1). Both TBAi and
OpenChamber treat it that way; no semantic divergence to resolve.

## 4e.4 Schema call: `scheduleType` gains `"manual"`

Today `schedule_type CHECK(schedule_type IN ('once','cron'))`. Add
`'manual'`:

```sql
ALTER TABLE scheduler_jobs DROP CONSTRAINT ... -- not portable in SQLite
```

SQLite cannot `ALTER` a CHECK, so the clean path is **rebuild the table**
(the repo already does this for `conversations.status`,
`conversations.ts` L196-206). Add `manual` to the CHECK, copy rows
unchanged (existing rows are all `once`/`cron`), recreate indexes. A
`manual` job has `next_run_at IS NULL` and no timer.

- `fireJob`'s recurring bookkeeping is a no-op for `manual` (no cron).
- `scheduleJob` for a `manual` job: does **not** arm any timer (returns
  after clearing). This is the "manual or custom" option the user asked
  for, expressed as a first-class schedule type rather than a UI trick.

### 4e.5 What this removes from the plan's Task 8

- The `once | repeat` toggle (§4e.2 replaces it).
- The 7-`RepeatPreset` row (§4e.2's "Repeats" cadence selector replaces
  it: `Daily · Weekly · Specific days · Every N min · Every hour` —
  the `weekdays` preset is folded into "Specific days", `monthly` and
  raw-cron are folded into "Custom" (the `advanced` escape hatch, kept
  as a 4th cadence option under Repeats for power users)).
- The "Stop after" line stays (self-limiting, §3.12) but moves under
  Repeats, where it applies; a Manual job has no Stop-after.

## 4c. OpenChamber form study — UI elements worth borrowing

OpenChamber's scheduler editor (`packages/ui/src/components/session/ScheduledTaskEditorDialog.tsx`,
~1,900 lines) and its list surface (`ScheduledTasksDialog.tsx`). TBAi's
`JobEditor` (837 lines, settings-page form) is structurally similar but
coarser; a handful of OpenChamber elements earn their place.

### 4c.1 Elements present in OpenChamber, absent in TBAi today

| OpenChamber element | What it does | TBAi equivalent today |
|---|---|---|
| **TimePill** | A compact `HH:MM` time editor: digit-by-digit inputs with arrow-key stepping, 12/24-hour locale awareness, AM/PM select. | Native `<input type="time">` + text fallback; no locale awareness, no stepping. |
| **Calendar date picker** | A 6×7 month grid, locale-aware weekday labels, "jump to today", past days disabled. A `once` job picks a date from a real calendar. | `<input type="date">` (TBAi `JobEditor` uses `execAtDate`/`execAtTime` as raw strings). |
| **Cron examples + next-runs preview** | A live "next 3 runs" line under the cron field, plus clickable example chips (`0 6 * * *` = "Daily 06:00"). | TBAi has a schedule preview (`Runs … · …`) but no clickable examples. |
| **Prompt autocomplete** | The prompt textarea triggers `@` (file/agent), `/` (command), `#` (snippet) autocompleters — the same three the composer has. | Plain textarea, no autocomplete. |
| **Variant select** | A per-model thinking/variant dropdown sourced from the model's `variants` array; disabled when the model offers none. | TBAi has a `thinkingLevel` select, but it's registry-driven per provider, not per model-variant. |
| **Use-defaults checkbox** | "Follow the session's model/agent at run time" — the task stores no model, and the run resolves the session's current choice. | No equivalent: TBAi always pins provider+model on the job. |
| **Goal Mode row** | `goalEnabled` + `goalTokenBudget` — a scheduled run can carry a goal with a token cap. | TBAi's scheduler has no goal concept; out of scope. |
| **Permission auto-accept toggle** | A shield icon in the footer, default off; when on, the run's permission prompts are auto-approved. | **TBAi must not add this** (§3.11: a scheduled run never auto-approves). |
| **Weekday checkbox row** | A single row of 7 labeled checkboxes for weekly schedules, locale-ordered. | TBAi's cron macro presets cover weekdays but don't expose the row directly. |
| **Multiple daily times** | A `daily` schedule can carry several `HH:MM` entries; add/remove time buttons. | TBAi's `daily` preset is single-time; cron is the escape hatch for multi-time. |

### 4c.2 What TBAi should borrow (add to Task 8)

Ranked by cost/benefit against the existing `JobEditor` shape:

1. **Cron examples + next-runs preview** (cheap, high value): TBAi already
   computes the preview; adding 3–4 clickable example chips under the
   advanced-cron field is a ~30-line UI change with real onboarding value.
   Add to Task 8's DOM test: "clicking an example chip fills the cron
   field and the preview updates."

2. **Variant select (per-model)**: TBAi's `thinkingLevel` is
   provider-capped; OpenChamber's variant select is model-capped and
   disabled when the model offers none. For the OpenCode engine, the
   variant comes from `listOpenCodeModelVariants(model)` (§3.5) — the
   same "disable when empty" rule applies. Extend Task 8's OpenCode
   model section with a variant select alongside the existing thinking
   select; the two are independent (thinking = provider-level budget,
   variant = OpenCode model flavor).

3. **Calendar date picker for `once` jobs**: replace the raw
   `<input type="date">` with a real month-grid picker (past days
   disabled, "today" ring). TBAi's `SchedulerPage` is a settings-style
   surface, so this is a new element — justify it: the editor's most
   error-prone field (a user mistypes `2026-02-30`) becomes
   un-errable. Add to Task 8.

4. **TimePill (locale-aware time editor)**: only worth it if the
   calendar picker lands (they share the "locale-aware" story). TBAi's
   current `<input type="time">` is acceptable for a desktop settings
   page; flag it as a *maybe*, not a default.

5. **Multiple daily times**: skip for V1. TBAi's cron expression already
   expresses multi-time daily (`0 6,12,18 * * *`); the presets just
   don't build it. A "daily multi-time" preset that *writes* a cron
   string is a 5-line change to `scheduler-templates.ts` and needs no new
   UI — do it in Task 8's template work.

### 4c.3 What TBAi should NOT copy

- **Prompt autocomplete in the scheduler textarea.** It needs the
  composer's mention/command/snippet stores, which belong to the chat
  surface. A scheduled prompt is a *template*, not a live composer;
  copying the autocomplete into it would be a second autocomplete
  implementation. Out of scope.
- **Permission auto-accept.** §3.11 forbids it for scheduled runs,
  unconditionally. OpenChamber's toggle is the exact behavior AGENTS.md
  says to refuse.
- **Goal Mode.** TBAi's goal concept (if any) is not scheduler-coupled
  today; adding a `goalTokenBudget` to a job row is a persistent
  contract change with no current consumer. Deferred.
- **The whole 1,900-line dialog as a pattern.** OpenChamber's editor is
  one monolith; TBAi's `JobEditor` is already split into a form module.
  Keep the split; borrow elements, not the file shape.

### 4c.4 Plan task updates this study implies

- **Task 8** gains: (a) cron-example chips, (b) a calendar picker for
  `once` jobs (replacing `execAtDate`'s native input), (c) a
  per-model variant select in the OpenCode model section, (d) a
  "daily multi-time" preset in `scheduler-templates.ts` (writes a cron
  string, no new UI), (e) DOM tests for (a)–(d).
- No new schema fields from this study: multi-time is a preset,
  variants reuse `opencodeVariant` on the conversation (or a job column
  if §3.5's model-binding decides to store it on the job — see §6's
  open question).

## 5. Explicitly out of scope (deferred, with owners)

1. **OpenCode plugin exposing `openchamber_schedule` to in-session
   agents** (OpenChamber's `lib/agent-tool` pattern: a materialized
   plugin directory in the managed config, rewriting a watched
   `opencode.managed.json`). Owner: a follow-up plan. It is a *separate
   concern* from execution — an agent-driven scheduling surface — and it
   needs the managed-plugin-config machinery TBAi does not have yet
   (TBAi's OpenCode boundary today is process + session lifecycle only,
   per AGENTS.md). Until then, agents can still schedule through TBAi's
   native AI tools in a Direct session (`schedulerTools.ts`).
2. **MCP tools in scheduled runs** — already a documented V1 limit for
   the Direct path; unchanged for OpenCode (OpenCode sessions do carry
   MCP servers, but TBAi's scheduler does not claim them; the session's
   own permission settings govern).
3. **Cross-process scheduler locking** — single-process app; the
   SQLite claim guard suffices (§1.2).
4. **Goal-mode / auto-accept semantics for scheduled OpenCode runs** —
   a scheduled run uses the conversation's configured agent/model/
   permissions as-is. Auto-approving destructive work unattended is
   forbidden by AGENTS.md and is not offered.

---

## 6. Open questions to verify at implementation (not plan blockers)

- **Prompt turn completion contract:** does the installed
  `@opencode/client`'s `session.prompt` resolve when the turn
  completes, or return a message id for a later read? The seam in Task
  5 is written against the installed client's actual contract (the repo
  already pins `@opencode/client` + schema to exact versions and has
  drift tests against the client's real routes — follow that pattern
  rather than assuming).
- **Permission polling vs event subscription:** V1 polls
  `session.permission.list` on an interval; if the installed client
  exposes a session-level event stream that's cheap to consume server-
  side, prefer that. The interval is a constant, not a tuning knob.
- **Excerpt source:** last assistant message text vs the session's
  transcript endpoint — use whatever the prompt response already
  carries; don't add a second read for the happy path.

---

## 7. Verification (repo "Testing before done" rule)

Per task: `bun run typecheck` (backend + web), `bun run build`, the
task's tests. End-to-end before "done":

1. Start the app, create an OpenCode-engine job via the UI against a
   managed OpenCode server, run it manually → the conversation thread
   shows the prompt + reply; the run row is `completed` with
   `provider_id: "opencode"`.
2. Same with a permission-requiring prompt → the run records the
   denial, the session transcript shows the reason, the run is
   `failed` (non-retryable).
3. Stop the OpenCode server, fire a scheduled OpenCode job →
   `OpenCodeNotReadyError` → retried per `maxRetries` → `failed` with
   the not-ready message; the Direct jobs in the same window are
   unaffected.
4. Recovery: restart the app with a pending one-time OpenCode job
   within grace → it runs; beyond grace → `missed`.
5. **Catch-up (§3.13):** a cron job that missed 3 slots while the app
   was down → on recovery it runs **once** now (first missed slot),
   its `nextRunAt` skips past all three, and no backlog runs are
   queued.
6. **Self-limiting (§3.12):** a cron job with `maxRuns: 3` → after the
   3rd completed run it is `completed` + disabled, timer cleared; a
   job with `expiresAt` in the future → completed when the next slot
   would fall past it; a job with `expiresAt` in the past at save
   time → rejected.
7. **Permission wait (§3.11):** a cron OpenCode job whose prompt
   triggers a tool needing approval → the run is `failed` with the
   permission reason (no denial recorded in the session), the session
   is intact; the next cron slot retries; a once job with the same
   prompt is terminal `failed` after one attempt.
8. **Target-gone (§3.14):** an `existing_thread` job whose
   conversation is archived between save and fire → run fails
   terminal (`ScheduleTargetGoneError`), job marked `failed`, no
   retry, timer cleared.
9. **Service-owner continuity (§4f):** create an OpenCode dedicated
   job while the runtime is bound to a profile-qualified service →
   the conversation row's `opencode_service_owner` matches the
   serialized active owner; a later `ensureOpenCodeSession` on that
   row does not refuse with `OpenCodeHistoryBoundaryError`.
10. The full scheduler + opencode test suites, real numbers.

---

## 4f. B7 service-profile model — what the scheduler plan must respect (new)

Studied on disk against the B7 working tree (2026-11-02):
`src/services/opencode/serviceProfile.ts`, `historyBoundary.ts`,
`serviceAccess.ts`, `sessions.ts`.

### 4f.1 What B7 changed that touches scheduled OpenCode runs

- **Owner keys now carry a profile.** `opencode_service_owner` is
  serialized as `managed`, `adopted:<origin>`, or `profile:<id>`
  (`serviceProfile.ts`, `historyBoundary.ts`). `serializeHistoryOwner`
  remains the only writer of that string; `resolveOpenCodeServiceAccess`
  remains the only reader-side resolver.
- **`ensureOpenCodeSession` is owner-authoritative.** Before any
  session work it resolves the conversation's owner through
  `resolveOpenCodeServiceAccess` and refuses a cross-service binding
  (`OpenCodeHistoryBoundaryError`). A conversation row created with
  *no* owner (or a guessed one) is not "auto-fixed" — it is either
  refused or, under the new managed→adopted continuity rule
  (`serviceAccess.ts`, `isManagedToAdoptedContinuity`), allowed to
  verify the remote session only.
- **Imported rows are session-pinned.** Rows with
  `opencode_imported = 1` + `opencode_directory` never fall back to
  `resolveConversationWorkspace`, never silently create a replacement
  session (`OpenCodeImportedSessionMissingError` instead), and their
  directory is the server-confirmed one.

### 4f.2 Consequences for the scheduler plan (the corrections)

1. **Task 4 (conversation create) must bind the owner.** The
   dedicated-thread OpenCode create stores
   `opencodeServiceOwner: serializeHistoryOwner(access.owner)` from the
   service access the run will later resolve (§3.4, amended above). This
   is a one-line addition, but without it the first scheduled run on a
   profile-qualified service is refused by the boundary check.
2. **`existing_thread` engine check is unchanged, owner check is
   free.** `checkExistingThread`'s new `engine === "opencode"`
   validation stays; no new owner validation is needed at save time,
   because the owner travels *on the row* and is verified at run time
   by `resolveOpenCodeServiceAccess`. A job saved against a thread whose
   owner later becomes unavailable fails the run with
   `OpenCodeHistoryBoundaryError` (`adopted_unavailable`), classified
   as **non-retryable** — the service is gone, retrying cannot install
   it.
3. **Scheduled runs must never target imported conversations.** An
   `existing_thread` job whose target row has `opencode_imported = 1`
   is a *read-attached* session: sending a scheduled prompt into it
   would mix unattended execution with a session TBAi does not own the
   lifecycle of (its directory may vanish, its session must not be
   recreated). `checkExistingThread` gains a third check:
   `opencodeImported === true` → 422 "imported sessions are not
   schedulable targets" (V1). Imported sessions remain fully viewable
   in TBAi; they are just not scheduler targets.
4. **Retry classification table (Task 6) gains one row:**
   `OpenCodeHistoryBoundaryError` → terminal (not retryable), for both
   once and cron jobs. Rationale: the refusal means "this conversation's
   history lives on a service that is not installed", and no amount of
   retrying installs it.

### 4f.3 What B7 did NOT change (no plan edits needed)

- `resolveOpenCodeServiceAccess`'s signature and refusal semantics are
  unchanged; the plan's §3.5 step 1 still reads
  `{ baseUrl, transport, owner }` as before.
- `ensureOpenCodeSession(conversationId)` still returns
  `{ sessionId, directory, reusedExistingSession }` — the shape
  `schedulerPrompt.ts` (Task 5) is written against.
- The permission polling surface (`session.permission.list` on the
  proxy allowlist) is unchanged — §3.11's permission-wait rule still
  applies verbatim.
- Database-ownership and adoption machinery (`ownership.ts`,
  `adoption.ts`) is server-lifecycle only; a scheduled run never
  starts or stops the service, so those changes are invisible to it.
