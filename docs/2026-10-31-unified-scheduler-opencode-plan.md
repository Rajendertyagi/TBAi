# Unified Scheduler: Direct + OpenCode 2.2.0 Engine Architecture (V1 Implementation Plan)

> **Document Status**: **FINAL V1 IMPLEMENTATION PLAN (Planning Phase Only — No Application Code Modified)**
> **Repository Baseline**: `Rajendertyagi/TBAi` @ branch `ci/tauri-e2e-verify` (Commit: `22d6f59ac20c041244846dd5cdde7a0440621e2e`)
> **Governing Standards**: `AGENTS.md` (lines 134–150), `docs/PROJECT_MANAGER_PROTOCOL.md` (§9 Engineering Philosophy and Scope).
> **Core Architecture Decisions**:
> 1. **Single Unified Scheduler**: ONE Scheduler GUI (`web/src/features/scheduler/`), ONE SQLite coordinator (`scheduler_jobs` & `scheduler_runs`), ONE job lifecycle, ONE execution dispatcher, and ONE run-history system supporting both Direct Chat and OpenCode Agent execution.
> 2. **Three OpenCode Session Strategies**:
>    - **Fresh session**: Dedicated new OpenCode session and run-scoped conversation per execution (clean transcript context, orphan-intent journaled).
>    - **Persistent session**: Dedicated OpenCode session and conversation per job reused across executions (context retained, job-owned).
>    - **Existing conversation**: Schedules turns into a user-selected interactive conversation (retained transcript, shared interactive context).
> 3. **Authoritative Session Ownership**: The SQLite `conversations` table is the single authoritative owner of OpenCode sessions. The scheduler references conversations via `job.conversation_id` without introducing competing session identity tables.
> 4. **Unified Prompt & Inbox Identifier**: OpenCode 2.2.0 uses the same message ID for the submitted prompt, the returned `SessionInboxUser.id`, inbox cancellation, and message lookup. The plan uses a single durable `opencode_prompt_id`, completely removing the redundant `opencode_inbox_id`.
> 5. **Clean Status vs. Turn Outcome Separation**: Distinguishes the overall scheduler run lifecycle (`scheduler_runs.status`) from the granular remote execution outcome (`scheduler_runs.turn_outcome`). Uncertain results are never presented as success and never automatically retried.
> 6. **Grounded Permission Policy & Honest Disclosure**: Removes the background SSE permission watcher from V1. Fresh/Persistent sessions use explicit creation permissions (Autonomous Coding grants broad local machine access; Read-Only Analysis restricts to search/read). Existing Conversations preserve user permissions with explicit disclosure. No false claims of OS-level isolation.
> 7. **Turn-Boundary Correlation & No Active Polling Fallback**: Replaces raw chronological heuristics with strict turn-boundary parsing (`SessionMessageUser` with `m.id === opencode_prompt_id` bounded by terminating `SessionMessageIdle`). Removes `session.active()` polling fallback; unprovable completions settle honestly to `turn_outcome = 'outcome_unknown'`.
> 8. **Targeted Cancellation (No Shared Session Interruption)**: In Existing Conversations, in-flight timeouts do NOT call session-wide `session.interrupt` to avoid terminating active human turns. Only queued prompts are cancelled via inbox delete.
> 9. **Aligned Database Migration**: Identical SQL DDL and TypeScript `applySchedulerEngineMigration`. Respects `scheduler_jobs.workspace_path NOT NULL` by deriving the path from `workspace_folder_id` through the authoritative folder resolver. Populates required `provider_id` ('opencode') and `model_id` without dummy placeholders.
> 10. **Non-Destructive Soft Deletion**: Soft deleting a job stops future scheduling but **never deletes** remote sessions, conversation rows, or transcripts. Terminal runs follow TBAi's standard 30-day pruning policy.
> 11. **Strict Seam Boundary**: `src/services/scheduler/` NEVER imports `@opencode/client`. All OpenCode communication is encapsulated inside `src/services/opencode/`.

---

## 1. Executive Summary & Verification Baseline

### 1.1 Executive Summary
TBAi's scheduler is a unified desktop scheduling system that coordinates recurring (cron) and one-time tasks. This plan defines the streamlined, implementation-ready V1 architecture for extending the existing Direct chat scheduler to support OpenCode Agent execution (`@opencode/client@2.2.0`, OpenCode server $\ge 2.2.0$).

The design prioritizes personal-desktop reliability, simple execution paths, durable SQLite history, and safe unattended execution without enterprise SaaS overhead or fragile background watchers.

### 1.2 Verification Baseline
- **Repository**: `Rajendertyagi/TBAi`
- **Active Branch**: `ci/tauri-e2e-verify`
- **HEAD Commit**: `22d6f59ac20c041244846dd5cdde7a0440621e2e` (`22d6f59`)
- **Working Tree**: Only this planning document is modified. All other files and tests are untouched.
- **Installed Stack**:
  - `@opencode/client`: `2.2.0` (`@opencode/schema@2.2.0`, `@opencode/protocol@2.2.0`).
  - OpenCode Server Compatibility: $\ge 2.2.0$ (`OPENCODE_CONFIG.minimumVersion = "2.2.0"`).
  - AI SDK: `ai@7.0.145` (Direct chat).
  - Database: `bun:sqlite` with WAL mode, `PRAGMA busy_timeout = 5000`, `PRAGMA foreign_keys = ON`.
- **Quality Gates**:
  - `bun run typecheck`: 0 errors across all 4 tsconfigs.
  - `bun test tests/unit/scheduler`: 93/93 passing (333 assertions across 3 test files).

---

## 2. Existing TBAi Architecture & Ground Truth

### 2.1 Persistence & Data Model (`src/db/index.ts`, `src/services/scheduler/schedulerStore.ts`)
- **`scheduler_jobs` Table**:
  - Columns: `id`, `name`, `description`, `enabled`, `schedule_type`, `cron_expression`, `exec_at`, `timezone`, `provider_id` (NOT NULL), `model_id` (NOT NULL), `thinking_level`, `workspace_path` (NOT NULL), `prompt`, `conversation_policy`, `conversation_id`, `overlap_policy`, `max_retries`, `retry_delay_seconds`, `timeout_seconds`, `missed_grace_seconds`, `next_run_at`, `last_run_at`, `status`, `created_at`, `updated_at`.
  - Indexes: `idx_scheduler_jobs_next` on `(enabled, next_run_at)`.
- **`scheduler_runs` Table**:
  - Columns: `id`, `job_id`, `occurrence_id`, `request_id`, `started_at`, `completed_at`, `status`, `error`, `output_excerpt`, `provider_id` (NOT NULL), `model_id` (NOT NULL), `workspace_path` (NOT NULL), `conversation_id`, `attempt`, `duration_ms`, `created_at`.
  - Constraints: `UNIQUE(job_id, occurrence_id)`, `FOREIGN KEY (job_id) REFERENCES scheduler_jobs(id) ON DELETE CASCADE`.
  - Indexes: `idx_scheduler_runs_job` on `(job_id, started_at DESC)`, `idx_scheduler_runs_status` on `(status)`.
- **Atomic Occurrence Claim (`schedulerStore.claimRun`)**:
  - Claims runs via `INSERT INTO scheduler_runs (job_id, occurrence_id, ...)`.
  - Guarded by `UNIQUE(job_id, occurrence_id)` to prevent double executions across race conditions.
- **Terminal Run Retention (`schedulerStore.pruneOldRuns`)**:
  - Runs in terminal states (`completed`, `failed`, `skipped`, `interrupted`, `missed`, `cancelled`) older than 30 days are automatically pruned at boot.

### 2.2 Coordinator Spine (`src/services/scheduler/scheduler.ts`)
- **In-Memory Timers**: `Bun.cron` for cron schedules; `setTimeout` for one-time absolute runs.
- **Run Controllers (`runControllers`)**: Map of `AbortController` by `runId` enabling user cancellation and timeout handling.
- **Pending Runs (`pendingRuns`)**: Tracked execution promises awaited during graceful shutdown (`abortAllRuns`).
- **Boot Recovery (`recover`)**: Marks orphaned `running` runs as `interrupted`, evaluates missed runs, and rebuilds active timers.

### 2.3 OpenCode Subsystem Boundary (`src/services/opencode/`)
- **Exclusive Boundary (`AGENTS.md`)**: All OpenCode communication is encapsulated inside `src/services/opencode/`.
- **Authoritative Session Management (`src/services/opencode/sessions.ts`)**:
  - `ensureOpenCodeSession(conversationId)`: Creates or verifies OpenCode sessions bound to conversations.
  - Durable Intent Journal (`opencode_session_orphans`): Tracks pre-create intent for crash durability (RT-001).
  - Liveness Verification (`fetchOpenCodeSession`): Checks session presence via `client.session.get`. Definitive HTTP 404 indicates stale session; transport/500 errors propagate without replacing session.
- **Workspace Resolution (`src/services/workspace.ts`)**:
  - `resolveConversationWorkspace(conversation)`: Resolves absolute working directory authoritatively from registered folders in `folders` table via `workspace_folder_id`.

---

## 3. Verified OpenCode 2.2.0 API Contracts

Verified against `node_modules/@opencode/client/dist/promise/generated/types.d.ts`, `client.d.ts`, and core server schemas:

### 3.1 Verified Operations Table

| Operation | HTTP Method / Path | Request Payload | Response Body / Status | Version / Contract Details |
|---|---|---|---|---|
| **`session.create`** | `POST /api/session` | `{ id?: string, parentID?: string, title?: string, agent?: string, model?: { id: string, providerID: string, variant?: string }, location?: { directory: string }, permissions?: ReadonlyArray<{ action: string, resource: string, effect: "allow" \| "deny" \| "ask" }>, metadata?: Record<string, any> }` | `200 OK`<br/>`{ data: SessionInfo }` | OpenCode V2.0+ |
| **`session.get`** | `GET /api/session/:sessionID` | None | `200 OK`<br/>`{ data: SessionInfo }`<br/>*(or `404 Not Found`)* | OpenCode V2.0+ |
| **`session.switchModel`** | `POST /api/session/:sessionID/model` | `{ model: { id: string, providerID: string } }` | `204 No Content` | OpenCode V2.0+ |
| **`session.switchAgent`** | `POST /api/session/:sessionID/agent` | `{ agent: string }` | `204 No Content` | OpenCode V2.0+ |
| **`session.prompt`** | `POST /api/session/:sessionID/prompt` | `{ id?: string, text: string, delivery?: "steer" \| "queue", metadata?: Record<string, any>, files?: Array<...>, agents?: Array<...>, skills?: Array<...> }`<br/>*(Note: Does NOT accept `agent` or `model` overrides)* | `200 OK`<br/>`{ data: SessionInboxUser }`<br/>*(Where `id` is the prompt ID)* | OpenCode V2.2.0 (`delivery: "steer" \| "queue"`, client-supplied `id`) |
| **`session.inbox.list`** | `GET /api/session/:sessionID/inbox` | None | `200 OK`<br/>`{ data: Array<SessionInboxInfo> }` | OpenCode V2.2.0 |
| **`session.inbox.cancel`** | `DELETE /api/session/:sessionID/inbox/:inboxID` | None | `204 No Content` | OpenCode V2.2.0 *(DELETE operation; inboxID is the prompt ID)* |
| **`session.wait`** | `POST /api/experimental/session/:sessionID/wait` | None | `204 No Content` | Experimental. Awaits agent loop idleness. |
| **`session.interrupt`** | `POST /api/session/:sessionID/interrupt` | None (query: `resume?: boolean`) | `200 OK`<br/>`{ data: SessionStatus }` | OpenCode V2.0+ *(Session-wide interruption)* |
| **`message.list`** | `GET /api/session/:sessionID/message` | None (query: `order?: "asc" \| "desc"`, `limit?: number`) | `200 OK`<br/>`{ data: Array<SessionMessageInfo> }` | OpenCode V2.0+ |

### 3.2 Unification of Prompt ID and Inbox ID
In OpenCode v2.2.0:
- When a client supplies `id: promptId` to `session.prompt`, the server stores it as the message ID.
- The returned `SessionInboxUser` has `id: promptId`.
- Cancelling the prompt in the queue calls `DELETE /api/session/:sessionID/inbox/:promptId`.
- When admitted to execution, the resulting `SessionMessageUser` has `id: promptId`.
- **Conclusion**: There is only ONE identifier. We use `opencode_prompt_id` everywhere and eliminate `opencode_inbox_id`.

---

## 4. OpenChamber Comparative Analysis

| Feature | OpenChamber Implementation | OpenChamber Behavior / Failure Mode | TBAi V1 Adaptation & Decision | Adopted? |
|---|---|---|---|---|
| **Target Validation** | `existing-session.js:validateTarget` | Checks session existence, archive status, and directory on save, admission, and send. | Adopt directly: validate existence, active status, engine (`opencode`), and folder match at save and fire time. | **YES** |
| **Queue Delivery** | `existing-session.js:enqueueMessage` | Enqueues prompt with provenance metadata. | Adopt directly: `session.prompt` with `delivery: "queue"` and `{ metadata: { jobId, runId } }`. | **YES** |
| **Cancel on Disable/Delete** | `existing-session.js:cancelScheduledTask` | Cancels waiting queue items when task is disabled or deleted. | Adopt directly: call `DELETE /api/session/:id/inbox/:promptId` for waiting queued items. | **YES** |
| **In-Memory Lock** | `existing-session.js:admissions` | In-process Set to prevent double admissions. | Reject: SQLite `UNIQUE(job_id, occurrence_id)` is cross-process safe and durable across restarts. | **NO (Use SQLite)** |
| **Auto-Accept Permissions** | `runtime.js:setSessionAutoAccept` | Automatically approves all permissions. | **REJECTED**: Unattended auto-approval of arbitrary commands is dangerous. | **NO (Unsafe)** |
| **Run History Tracking** | `DOCUMENTATION.md:140` | Stops tracking at queue send; no per-run history in Existing Session mode. | **REJECTED**: TBAi provides durable SQLite run history for all executions. | **NO (TBAi tracks full history)** |

---

## 5. Three Session Strategies and Ownership

The SQLite `conversations` table is the sole authoritative owner of OpenCode sessions. The scheduler links to conversations via `job.conversation_id`.

```mermaid
flowchart TD
    Start([Job Fired / fireJob]) --> StrategyCheck{OpenCode Session Strategy}

    %% Strategy A: Fresh
    StrategyCheck -->|Fresh| FreshCreate[Create Run-Scoped Conversation<br/>title: '[Scheduler] JobName RunId']
    FreshCreate --> FreshEnsure[ensureOpenCodeSession<br/>Applies Selected Permission Preset<br/>Journals intent in opencode_session_orphans]
    FreshEnsure --> FreshRun[Submit Prompt via delivery: 'queue'<br/>Wait for Idle & Bound Turn<br/>Collect Outcome & Excerpt]
    FreshRun --> FreshRetain[Record run in scheduler_runs<br/>Preserve remote session for audit]

    %% Strategy B: Persistent
    StrategyCheck -->|Persistent| PersistCheck{job.conversation_id exists?}
    PersistCheck -->|No| PersistCreate[Create Dedicated Job Conversation<br/>Save ID to job.conversation_id]
    PersistCreate --> PersistEnsure[ensureOpenCodeSession<br/>Applies Selected Permission Preset]
    PersistCheck -->|Yes| PersistVerify[fetchOpenCodeSession<br/>Check liveness via client.session.get]
    PersistVerify --> PersistLiveness{Status?}
    PersistLiveness -->|200 OK| PersistRun[Submit Prompt in Reused Session]
    PersistLiveness -->|404 Not Found| PersistRecover[Recover Stale Session<br/>ensureOpenCodeSession mints replacement<br/>Record context_reset: true in run]
    PersistLiveness -->|Transport / 500| PersistFail[Fail Run with Transport Error<br/>Do NOT replace session binding]
    PersistRecover --> PersistRun

    %% Strategy C: Existing Conversation
    StrategyCheck -->|Existing Conversation| ExistValidate[Validate Target Conversation<br/>Check exists, active, engine==opencode,<br/>workspace folder matches]
    ExistValidate --> ExistLiveness{Reachable?}
    ExistLiveness -->|200 OK| ExistRun[Submit Prompt with delivery: 'queue'<br/>Preserve Existing Session Permissions<br/>Wait for Idle & Bound Turn]
    ExistLiveness -->|404 / Missing / Archived| ExistFailSafe[FAIL SAFE<br/>Mark run failed: target_unavailable<br/>NEVER silently replace user session]
```

### 5.1 Strategy Details

1. **Fresh Session**:
   - Creates a dedicated run-scoped conversation in SQLite.
   - `ensureOpenCodeSession` creates a new OpenCode session with the selected permission preset.
   - Context isolation: No previous transcripts are reused.
   - Remote session and conversation records are retained for user audit.
2. **Persistent Session**:
   - A single dedicated conversation owns the OpenCode session.
   - Reused across executions, retaining multi-turn context.
   - If `client.session.get` returns definitive HTTP 404, `ensureOpenCodeSession` creates a replacement session and marks the run with `context_reset: true`. Transport/500 errors fail the run without replacing the session.
3. **Existing Conversation**:
   - The user selects an existing interactive conversation.
   - Validated on save, admission, and fire time (exists, not archived, `engine === 'opencode'`, folder matches).
   - If missing or 404, fails immediately; **never** silently replaces the session or mutates user settings.
   - Prompts submitted with `delivery: "queue"` to serialize cleanly behind interactive typing.

---

## 6. Permission Scope, Security Model & Honest Disclosures

### 6.1 Honest Disclosure on Permission Scope (No False OS Sandbox Claims)
In OpenCode, passing permission rules like `{ action: "edit", resource: "*", effect: "allow" }` or `{ action: "shell", resource: "*", effect: "allow" }` grants permissions within OpenCode's agent tool loop.
- **CRITICAL FACT**: **This does NOT establish an operating system container or sandbox boundary.**
- Subprocesses executed via OpenCode's `shell` action run with the current host user's OS privileges.
- Setting `workspace_path` sets the working directory (`cwd`), but does not prevent scripts or commands from accessing network resources or paths outside that directory if permitted by the host OS.
- TBAi explicitly discloses this in documentation and UI: scheduled coding agent runs have local machine execution access within the bounds of OpenCode's tool capabilities.

### 6.2 Permission Presets for Fresh and Persistent Sessions
To prevent scheduled coding runs from being rendered useless by denying edits and shell commands, V1 offers two clear presets:

```ts
export const AUTONOMOUS_CODING_PERMISSIONS = [
  { action: "read", resource: "*", effect: "allow" },
  { action: "glob", resource: "*", effect: "allow" },
  { action: "grep", resource: "*", effect: "allow" },
  { action: "edit", resource: "*", effect: "allow" },
  { action: "shell", resource: "*", effect: "allow" },
  { action: "subagent", resource: "*", effect: "deny" },
  { action: "skill", resource: "*", effect: "deny" },
] as const;

export const READ_ONLY_PERMISSIONS = [
  { action: "read", resource: "*", effect: "allow" },
  { action: "glob", resource: "*", effect: "allow" },
  { action: "grep", resource: "*", effect: "allow" },
  { action: "edit", resource: "*", effect: "deny" },
  { action: "shell", resource: "*", effect: "deny" },
  { action: "subagent", resource: "*", effect: "deny" },
  { action: "skill", resource: "*", effect: "deny" },
] as const;
```

- **Autonomous Coding (Default)**: Allows `read`, `glob`, `grep`, `edit`, and `shell`. Denies `subagent` and `skill`. Grants full unattended coding ability.
- **Read-Only Analysis**: Allows search and read operations; strictly denies file edits, shell execution, subagents, and skills.

### 6.3 Existing Conversation Policy & No Shared Session Disruption
- Existing Conversations retain their established interactive permissions and saved approvals.
- **No Background SSE Watcher**: An automated SSE watcher is removed from V1 to eliminate the risk of accidentally intercepting and auto-rejecting the human user's interactive actions.
- **UI Disclosure**: The UI requires explicit acknowledgement when choosing Existing Conversation:
  > *"This job will execute inside your existing conversation using its active permissions. If an unattended prompt triggers an action requiring manual approval, it will remain waiting until the job timeout expires."*
- **Cancellation Isolation**:
  - If a scheduled prompt in an Existing Conversation is still queued in the inbox, cancelling the run calls `DELETE /api/session/:sessionID/inbox/:promptId`. This cancels the scheduled prompt cleanly without affecting the shared session.
  - If the prompt is already executing and times out, **the scheduler does NOT call `session.interrupt` on the shared session**, because `session.interrupt` is session-wide and would terminate the human user's interactive turn. Instead, the scheduler settles the run to `status = 'failed'`, `turn_outcome = 'outcome_unknown'` with the diagnostic:
    *"Scheduled run timed out while executing in a shared conversation. Session was not interrupted to prevent aborting user interactive work."*

---

## 7. Execution Lifecycle, Turn Bounding & Outcome Semantics

### 7.1 Clean Separation: Run Status vs. Turn Outcome

To avoid confusing overall scheduler coordination with remote OpenCode turn outcomes, the two are modeled separately:

| Column | Scope | Possible Values | Meaning |
|---|---|---|---|
| **`scheduler_runs.status`** | Local Scheduler Lifecycle (`RunStatus`) | `'scheduled'`, `'running'`, `'completed'`, `'failed'`, `'cancelled'` | The macro state of the job execution in TBAi. |
| **`scheduler_runs.turn_outcome`** | Remote OpenCode Turn Attribution | `'succeeded'`, `'failed'`, `'interrupted'`, `'outcome_unknown'` | The verified result of the specific prompt turn on the OpenCode server. |

#### Exact Behavior on Uncertain Outcomes:
If a prompt was submitted, but its turn completion cannot be verified definitively (e.g. intervening user messages, lost connection, or unprovable idle outcome):
- `status` is set to `'failed'` (or `'cancelled'` if aborted by user).
- `turn_outcome` is set to `'outcome_unknown'`.
- The run record stores a clear explanatory diagnostic in `error`.
- **CRITICAL SAFEGUARD**: **An uncertain outcome is NEVER presented as success, and is NEVER automatically retried.** Automatic retries on uncertain executions are strictly prohibited to prevent duplicate external side effects.

### 7.2 Turn-Bounding Algorithm (No `session.active()` Fallback)

1. **Awaiting Completion**:
   - The adapter invokes `POST /api/experimental/session/:sessionID/wait`.
   - **No Inferred Success**: `session.wait` returning `204 No Content` proves the agent loop became idle; it does **not** prove our specific prompt succeeded.
   - **Removal of Active Polling Fallback**: If `session.wait` is unavailable or fails (e.g. returns 404 or 501), the system **does NOT fall back to polling `session.active()`** to guess completion. Instead, it queries message history directly. If reliable completion cannot be verified, the run settles immediately to `turn_outcome = 'outcome_unknown'`.
2. **Turn-Bounding Inspection**:
   - Fetch messages via `client.message.list({ sessionID, order: "asc" })`.
   - Locate `SessionMessageUser` where `m.id === run.opencodePromptId`.
   - Scan forward from the prompt index:
     - If the next boundary message is `SessionMessageIdle` (`m.type === "idle"`) with NO intervening `user` messages:
       - Collect assistant text parts for `output_excerpt` (truncated to 2000 chars).
       - If `idle.outcome === "succeeded"` $\to$ `status = 'completed'`, `turn_outcome = 'succeeded'`.
       - If `idle.outcome === "failed"` $\to$ `status = 'failed'`, `turn_outcome = 'failed'`, `error = idle.error?.message`.
       - If `idle.outcome === "interrupted"` $\to$ `status = 'cancelled'`, `turn_outcome = 'interrupted'`.
     - If another `user` message appears before `idle` (interleaved interactive activity):
       - Attributing subsequent assistant messages is ambiguous.
       - Settle to `status = 'failed'`, `turn_outcome = 'outcome_unknown'`, `error = "Interactive user message intervened before turn completion; assistant output cannot be unambiguously attributed."`

---

## 8. Database Migration and Schema Alignment

### 8.1 Required Column Compatibility
Existing `scheduler_jobs` and `scheduler_runs` tables enforce `NOT NULL` on `provider_id`, `model_id`, and `workspace_path`. For OpenCode jobs and runs:
- **`provider_id`**: Populated with `'opencode'` (the execution engine namespace).
- **`model_id`**: Populated with the resolved OpenCode model identifier (e.g. `opencode_model ?? 'default'`).
- **`workspace_path`**: Populated with the absolute directory path resolved from `workspace_folder_id` through `resolveConversationWorkspace()`.
This preserves database integrity, satisfies all SQLite `NOT NULL` constraints, avoids dummy placeholders, and ensures compatibility with existing queries and logs.

### 8.2 Migration SQL DDL (`0015_scheduler_opencode.sql`)
```sql
-- Migration: Additive OpenCode Engine Columns
-- Matches TypeScript applySchedulerEngineMigration identically.

-- 1. Extend scheduler_jobs
ALTER TABLE scheduler_jobs ADD COLUMN engine TEXT NOT NULL DEFAULT 'direct';
ALTER TABLE scheduler_jobs ADD COLUMN opencode_session_strategy TEXT;
ALTER TABLE scheduler_jobs ADD COLUMN opencode_agent TEXT;
ALTER TABLE scheduler_jobs ADD COLUMN opencode_model TEXT;
ALTER TABLE scheduler_jobs ADD COLUMN opencode_variant TEXT;
ALTER TABLE scheduler_jobs ADD COLUMN opencode_permissions TEXT;
ALTER TABLE scheduler_jobs ADD COLUMN workspace_folder_id TEXT;
ALTER TABLE scheduler_jobs ADD COLUMN deleted_at INTEGER;

-- 2. Extend scheduler_runs
ALTER TABLE scheduler_runs ADD COLUMN engine TEXT NOT NULL DEFAULT 'direct';
ALTER TABLE scheduler_runs ADD COLUMN opencode_session_id TEXT;
ALTER TABLE scheduler_runs ADD COLUMN opencode_prompt_id TEXT;
ALTER TABLE scheduler_runs ADD COLUMN turn_outcome TEXT;

-- 3. Additive Indexes
CREATE INDEX IF NOT EXISTS idx_scheduler_jobs_engine ON scheduler_jobs(engine);
CREATE INDEX IF NOT EXISTS idx_scheduler_jobs_deleted ON scheduler_jobs(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scheduler_runs_prompt ON scheduler_runs(opencode_prompt_id) WHERE opencode_prompt_id IS NOT NULL;
```

### 8.3 TypeScript Migration (`src/db/index.ts`)
```ts
export function applySchedulerEngineMigration(database: Database = sqlite): void {
  // scheduler_jobs extensions
  addColumnIfNotExists("scheduler_jobs", "engine", "TEXT NOT NULL DEFAULT 'direct'", database);
  addColumnIfNotExists("scheduler_jobs", "opencode_session_strategy", "TEXT", database);
  addColumnIfNotExists("scheduler_jobs", "opencode_agent", "TEXT", database);
  addColumnIfNotExists("scheduler_jobs", "opencode_model", "TEXT", database);
  addColumnIfNotExists("scheduler_jobs", "opencode_variant", "TEXT", database);
  addColumnIfNotExists("scheduler_jobs", "opencode_permissions", "TEXT", database);
  addColumnIfNotExists("scheduler_jobs", "workspace_folder_id", "TEXT", database);
  addColumnIfNotExists("scheduler_jobs", "deleted_at", "INTEGER", database);

  // scheduler_runs extensions
  addColumnIfNotExists("scheduler_runs", "engine", "TEXT NOT NULL DEFAULT 'direct'", database);
  addColumnIfNotExists("scheduler_runs", "opencode_session_id", "TEXT", database);
  addColumnIfNotExists("scheduler_runs", "opencode_prompt_id", "TEXT", database);
  addColumnIfNotExists("scheduler_runs", "turn_outcome", "TEXT", database);

  // Indexes
  database.run("CREATE INDEX IF NOT EXISTS idx_scheduler_jobs_engine ON scheduler_jobs(engine)");
  database.run("CREATE INDEX IF NOT EXISTS idx_scheduler_jobs_deleted ON scheduler_jobs(deleted_at) WHERE deleted_at IS NOT NULL");
  database.run("CREATE INDEX IF NOT EXISTS idx_scheduler_runs_prompt ON scheduler_runs(opencode_prompt_id) WHERE opencode_prompt_id IS NOT NULL");
}
```

### 8.4 Application-Level Constraint Enforcement
To guarantee 100% compatibility with SQLite's `ALTER TABLE ADD COLUMN` (which does not support adding table-level `CHECK` or `REFERENCES` constraints on existing tables without a rebuild):
- Constraints for `engine IN ('direct', 'opencode')`, `opencode_session_strategy IN ('fresh', 'persistent', 'existing_conversation')`, and `turn_outcome IN ('succeeded', 'failed', 'interrupted', 'outcome_unknown')` are enforced authoritatively at the application and Zod validation level in `schedulerValidation.ts`.
- `workspace_folder_id` foreign key validation is enforced authoritatively against the `folders` table at validation and execution time.

---

## 9. Backend Implementation Inventory

| File Path | Current Responsibility | Exact Planned Change | Why Necessary | Status | Dependencies |
|---|---|---|---|---|---|
| `src/db/index.ts` | SQLite setup & migrations | Add `applySchedulerEngineMigration(database = sqlite)` with new columns and indexes. | Persist engine, session strategy, folder ID, and prompt ID. | Existing | None |
| `src/services/scheduler/schedulerTypes.ts` | Job and Run TypeScript types | Add `engine`, `opencodeSessionStrategy`, `TurnOutcome`, `opencodePromptId` to types. | Strong typing across scheduler layers. | Existing | `src/db/index.ts` |
| `src/services/scheduler/schedulerStore.ts` | Persistence CRUD | Map new columns; persist `opencode_prompt_id` at `claimRun`; reset `conversation_id` on persistent config edit; soft delete. | Read/write OpenCode attributes. | Existing | `schedulerTypes.ts` |
| `src/services/scheduler/schedulerExecution.ts` | Execution dispatcher & Direct adapter | Add branch in `executeJobRun`: if `job.engine === 'opencode'`, delegate to `executeOpenCodeScheduledTurn`; else run Direct chat. | Route executions without modifying Direct behavior. | Existing | `scheduledExecution.ts` |
| `src/services/opencode/scheduledExecution.ts` | None (New File) | Implements `executeOpenCodeScheduledTurn`: handles session resolution, queue delivery, wait/polling, turn bounding, and timeout/cancellation. | Encapsulate OpenCode protocol inside `src/services/opencode/` per `AGENTS.md`. | **NEW** | `src/services/opencode/sessions.ts` |
| `src/services/opencode/sessions.ts` | OpenCode session management | Support passing `permissions` to `client.session.create`; return `recoveredFromStaleSession` flag. | Configure Autonomous Coding permissions on session creation. | Existing | `src/services/opencode/client.ts` |
| `src/services/scheduler/scheduler.ts` | Timers, shutdown, recovery | On job disable/delete, call `DELETE /api/session/:id/inbox/:promptId` for queued items. Reconcile uncertain prompts on restart. | Prevent ghost executions and recover from crashes. | Existing | `schedulerStore.ts` |
| `src/services/scheduler/schedulerValidation.ts` | Job validation | Validate engine selection, session strategy, workspace folder existence, and existing conversation status. | Reject invalid configurations early. | Existing | `schedulerTypes.ts` |
| `src/routes/scheduler.ts` | REST API routes | Pass engine, strategy, and OpenCode fields through request validation and response mapping. | Allow web GUI to configure OpenCode jobs. | Existing | `schedulerStore.ts` |
| `src/services/scheduler/schedulerTools.ts` | AI model tools | Update `scheduler_create_job` and `scheduler_update_job` tools with `engine` and strategy options. | Allow AI model to schedule OpenCode jobs. | Existing | `schedulerStore.ts` |

---

## 10. Frontend and AI-Tool Integration Inventory

| File Path | Current Responsibility | Exact Planned Change | Why Necessary | Status | Dependencies |
|---|---|---|---|---|---|
| `web/src/features/scheduler/components/JobEditor.tsx` | React job creation & edit form | Add Engine segmented toggle (`Direct` vs `OpenCode`); when OpenCode is selected, show Strategy selector (`Fresh`, `Persistent`, `Existing`), Agent/Model dropdowns, Permission Preset toggle, and workspace folder picker. | Allow users to configure OpenCode jobs. | Existing | `scheduler-draft.ts` |
| `web/src/features/scheduler/components/JobDetail.tsx` | Run history viewer | Display Engine badge, Session Strategy tag, OpenCode Session ID link, Prompt ID, and turn outcome indicators in run cards. | Full visibility into run execution history. | Existing | `JobEditor.tsx` |
| `web/src/features/scheduler/components/JobListItem.tsx` | Job list item summary | Display Engine icon and session strategy tag on job list cards. | Visual distinction of job types in list. | Existing | `JobEditor.tsx` |
| `web/src/features/scheduler/SchedulerPage.tsx` | Main scheduler page | Pass registered folder list and active OpenCode conversations to `JobEditor`. | Provide folder and conversation options. | Existing | `JobEditor.tsx` |
| `web/src/features/scheduler/lib/scheduler-draft.ts` | Form draft state | Add OpenCode engine, strategy, agent, model, variant, and folder ID fields. | Maintain consistent draft state. | Existing | `schedulerTypes.ts` |
| `src/tools/index.ts` | Native AI tool registration | Synchronize Zod schemas for scheduler tools with engine and strategy parameters. | Model tool call alignment. | Existing | `schedulerTools.ts` |

---

## 11. Testing and Acceptance Criteria

### 11.1 Test Suite Breakdown

1. **API Contract Verification (`tests/unit/scheduler/opencode-api-contract.test.ts`)**:
   - Verify `SessionInbox.Delivery` accepts `"queue"` and `"steer"`.
   - Verify `session.inbox.cancel` issues `DELETE /api/session/:id/inbox/:promptId`.
   - Verify session creation passes valid action names (`read`, `edit`, `glob`, `grep`, `shell`, `subagent`, `skill`).
2. **Session Ownership & Strategies (`tests/unit/scheduler/opencode-session-strategy.test.ts`)**:
   - *Fresh*: Asserts distinct conversation and session ID per execution; verifies orphan journal intent is recorded.
   - *Persistent*: Asserts session reuse across runs; verifies 404 recovery creates replacement session and flags `context_reset: true`.
   - *Existing Conversation*: Asserts selected conversation is reused; asserts 404 fails run safely without replacing user session.
3. **Turn Bounding & Correlation (`tests/unit/scheduler/opencode-turn-bounding.test.ts`)**:
   - Verify clean turn bounded by `idle` message extracts assistant text excerpt.
   - Verify intervening interactive user message flags run as `turn_outcome = 'outcome_unknown'` with appropriate diagnostics.
   - Verify failed `session.wait` does not fall back to `session.active()`, settling to `turn_outcome = 'outcome_unknown'`.
4. **Cancellation & Queue Management (`tests/unit/scheduler/opencode-cancel.test.ts`)**:
   - Verify disabling or deleting a job deletes queued items via `DELETE /inbox/:promptId`.
   - Verify cancellation of an in-flight execution in Fresh/Persistent calls `session.interrupt`.
   - Verify timeout of an in-flight execution in Existing Conversation does NOT call `session.interrupt`.
5. **Direct Engine Regression (`tests/unit/scheduler/`)**:
   - All 93 existing scheduler tests continue to pass without regression.

---

## 12. Explicit Non-Goals

1. **No Enterprise SaaS Infrastructure**: No Redis, RabbitMQ, Kafka, or separate background daemons. Everything runs in-process.
2. **No Fragile Background Watchers**: No SSE permission watchers intercepting and auto-rejecting user actions in shared sessions.
3. **No Over-Engineered Micro-States**: No 9-state state machine for localhost prompt dispatch.
4. **No Fake Distributed Exactly-Once Guarantees**: Prompt ID deduplication is session-scoped on the OpenCode server.
5. **No Silent Session or Model Substitution**: Missing models or deleted conversations fail fast with clear diagnostics.

---

## 13. Final Implementation Readiness Assessment

**ASSESSMENT: READY FOR V1 IMPLEMENTATION**

- **All 6 Issues Resolved**:
  1. `session.active()` fallback completely removed; unprovable completions settle honestly to `turn_outcome = 'outcome_unknown'`.
  2. Existing Conversation timeouts do not interrupt shared sessions.
  3. Permission scope claims grounded in reality without false OS container claims.
  4. SQL and TypeScript migrations aligned identically, with application-level constraint enforcement documented.
  5. Status (`scheduler_runs.status`) and turn outcome (`scheduler_runs.turn_outcome`) cleanly separated; uncertain executions are never retried.
  6. Required `provider_id` ('opencode') and `model_id` populated compatibly without dummy values.
- **Zero Direct Regression**: Direct chat scheduling retains its 93/93 passing test suite.

*Planning phase complete. Ready to begin Phase 1 implementation upon user authorization.*
