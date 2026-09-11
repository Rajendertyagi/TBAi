# TBAi Scheduler / Cron Architecture Study

## 1. Executive Summary

This document studies the design of a durable, configurable scheduler for TBAi that can create jobs such as "Every day at 9:00 AM: Use Gemini, Thinking = High, Workspace = D:\ProjectA, Prompt = Review TODOs" and execute them through TBAi's AI pipeline. The scheduler must be:

- **SQLite-persisted** — jobs survive restarts and crashes
- **Configurable via UI** — non-coder friendly schedule builder
- **Provider-agnostic** — independent of current chat state
- **Safe for unattended execution** — no silent auto-approval of destructive actions
- **Minimal dependencies** — follows TBAi's minimum-custom-code principle

**Recommendation:** Use **`Bun.cron`** (built into Bun runtime, zero dependencies) combined with SQLite persistence for job state, next-run calculation, and run history.

> **Update (2026-09-11):** Initially recommended `node-cron`, but discovered Bun has native cron support. `Bun.cron` is now preferred because it requires zero new dependencies and integrates directly with the runtime. See §2.1 for detailed comparison.

---

## 2. Libraries Researched

| Library | Bun | Windows | Cron | Timezone | DST | One-time | Recurring | Persistence | Restart Recovery | Weight |
|---|---|---|---|---|---|---|---|---|---|---|
| **Bun.cron** ✅ | ✅ (built-in) | ✅ | ✅ basic | ✅ | ⚠️ shifts on spring-forward | ❌ (manual) | ✅ | ❌ | ❌ (SQLite handles) | 0 deps |
| node-cron | ✅ | ✅ | ✅ advanced | ✅ | ✅ skips on spring-forward | ❌ (manual) | ✅ | ❌ | ❌ (SQLite handles) | 0 deps |
| cron (kelektiv) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | 2 deps |
| bree | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | 8 deps |
| node-schedule | ✅ | ✅ | ✅ | ✅ | ⚠️ basic | ✅ | ✅ | ❌ | ❌ | 3 deps |
| cron-parser | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ | 1 dep |

### 2.1 Bun.cron vs node-cron — Detailed Comparison

| Aspect | `Bun.cron` (built-in) | `node-cron` v4 |
|---|---|---|
| **Dependencies** | 0 (part of Bun) | 0 external (but needs `npm install`) |
| **API** | `Bun.cron(expr, handler, opts)` | `cron.schedule(expr, fn, opts)` |
| **DST Spring-forward** | **Shifts forward** — `0 2:30` becomes `0 3:30` | **Skips** — no fire that day |
| **DST Fall-back** | Fires once at first occurrence | Fires once at first occurrence |
| **Overlaps** | Built-in no-overlap guarantee | `noOverlap: true` option |
| **Runtime control** | `job.stop()`, `job.unref()` | `task.stop()/start()/destroy()/getStatus()` |
| **Events** | None (use Promise rejection handling) | `execution:finished`, `execution:failed`, etc. |
| **One-time jobs** | ❌ Only recurring | ❌ Only recurring (same limitation) |
| **Advanced cron** | Basic 5-field only | Supports `L`, `W`, `#`, inverted ranges |
| **Max executions** | ❌ | ✅ `maxExecutions` option |
| **Distributed coord** | ❌ | ✅ `distributed: true` |
| **Windows trigger limit** | 48-trigger cap for OS-level | No limit (in-process) |
| **Hot reload** | ✅ `bun --hot` | ✅ |
| **Fake timers** | ✅ `jest.useFakeTimers()` | ✅ |

#### Critical DST Difference

```
Spring-forward in America/New_York (2:00 → 3:00):

Bun.cron:   "0 2:30 * * *" → fires at 3:30 (shifted forward)
node-cron:  "0 2:30 * * *" → skipped entirely that day
```

For TBAi's use case (daily reviews, summaries), **both are acceptable** — the user would notice one missed run per year. But node-cron's "skip" is arguably more correct (the configured time doesn't exist).

#### One-Time Job Limitation (Both)

Neither library supports true one-time execution natively. Both are recurring schedulers. For one-time jobs, implement as:
- Set a `setTimeout` that fires once, then cancels itself
- Or use a cron expression designed to match once (impractical)

### Rejected Options

| Library | Reason Rejected |
|---|---|
| Redis-based schedulers (BullMQ, Agenda) | Violates "no external services" rule; TBAi is local-first |
| PostgreSQL-dependent schedulers | Requires external DB; contradicts SQLite-native design |
| Docker-based schedulers | External dependency; not portable |
| SaaS schedulers (cron-job.org, etc.) | Requires internet; breaks portability |
| Bree | 8 dependencies is heavy for a simple scheduler; worker threads add complexity |
| node-schedule | Less mature DST handling than node-cron; larger dependency footprint |
| cron (kelektiv) | 2 dependencies vs Bun.cron's 0 |
| cron-parser alone | No scheduling engine; only parses expressions |

---

## 3. Recommended Scheduler Engine

**Primary:** `Bun.cron` (built into Bun runtime)
**Parser:** `Bun.cron.parse(expr, Date.now(), { tz })` for next-run calculation
**Timezone:** IANA timezone names via `{ tz }` option

### Why Bun.cron?

1. **Zero new dependencies** — already part of Bun; follows TBAi's minimal dependency philosophy strictly
2. **Native integration** — hot reload (`bun --hot`) compatible; fake timer support for tests
3. **Built-in no-overlap** — schedules next fire only after handler settles
4. **Simple API** — `Bun.cron(expr, handler, { tz })`
5. **SQLite persistence handles restart recovery** — scheduler is in-memory; jobs are persisted and recreated on boot

### Trade-offs Accepted

| Trade-off | Rationale |
|---|---|
| DST spring-forward shifts instead of skips | Acceptable for personal-use app; same behavior as system crontab |
| No built-in events | Use Promise resolution/rejection + centralized logger |
| No one-time native support | Implement via setTimeout wrapper |
| Basic cron syntax only | Sufficient for V1; can add node-cron in V2 if advanced syntax needed |

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                        TBAi Server                           │
│                                                             │
│  ┌──────────────┐    ┌──────────────────┐    ┌───────────┐ │
│  │  Bun.cron    │───▶│  Job Coordinator │───▶│  Execution│ │
│  │  (built-in)  │    │  (src/services/  │    │  Engine   │ │
│  └──────────────┘    │   scheduler.ts)  │    └─────┬─────┘ │
│       ▲              └──────────────────┘          │       │
│       │                         │                  │       │
│       │                    ┌────┴────┐      ┌─────┴───┐   │
│       │                    │ SQLite  │      │ AI SDK  │   │
│       │                    │ (bun:   │      │ streamText│  │
│       │                    │  sqlite)│      └─────┬───┘   │
│       │                    └─────────┘            │        │
│       │                    scheduler_jobs         │        │
│       │                    scheduler_runs         │        │
│       └────────────────────────────────────────────┘        │
│                                                             │
│  Persistence Layer:                                         │
│  - scheduler_jobs: job definitions, schedule, state         │
│  - scheduler_runs: execution history, status, duration      │
│                                                             │
│  Restart Recovery:                                          │
│  - On boot: load all enabled jobs from SQLite              │
│  - Recalculate nextRunAt for each                          │
│  - Register with Bun.cron(); cancel existing               │
│  - One-time jobs: schedule via setTimeout                  │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. Schedule Model

### Four Schedule Types

| Type | Storage | UX | Example |
|---|---|---|---|
| **One-time** | `schedule_type: 'once'`, `exec_at: TIMESTAMP` | Date/time picker | 2026-09-15 18:30 IST |
| **Interval** | `schedule_type: 'interval'`, `interval_ms: NUMBER` | "Every X minutes/hours/days" | Every 30 minutes |
| **Cron** | `schedule_type: 'cron'`, `cron_expr: TEXT` | Guided builder + "Advanced: cron" | `0 9 * * *` |
| **Cron (advanced)** | `schedule_type: 'cron'`, `cron_expr: TEXT` | Raw expression input | `0 9 * * 1-5` |

### Recommended Storage Strategy

Store **both** structured schedule fields AND the cron expression:
- `schedule_type` — enum for quick filtering
- `cron_expression` — raw expression (fallback, debugging, import/export)
- `interval_minutes` — for interval-type jobs (null for cron/one-time)
- `exec_at` — for one-time jobs (null for recurring)

This allows:
- GUI to present friendly options (dropdowns, sliders)
- Cron parser for next-run calculation
- Raw expression stored for transparency and portability

---

## 5. Full Job Configuration Model

### Example Job Object

```typescript
interface SchedulerJob {
  // Identity
  id: string;                          // cuid2 generated
  name: string;                        // user-friendly name
  description: string | null;          // optional description
  enabled: boolean;                    // pause/resume toggle
  
  // Schedule
  scheduleType: 'once' | 'interval' | 'cron';
  cronExpression: string | null;       // e.g., "0 9 * * *"
  intervalMinutes: number | null;      // e.g., 30
  execAt: number | null;               // one-time timestamp (ms)
  timezone: string;                    // IANA timezone, e.g., "Asia/Kolkata"
  startDate: number | null;            // optional start (ms)
  endDate: number | null;              // optional end (ms)
  maxRuns: number | null;              // optional limit (null = infinite)
  
  // AI Target (explicit snapshot, not live references)
  targetType: 'chat' | 'tool';         // future extensibility
  providerId: string;                  // immutable reference at creation
  modelId: string | null;              // null = use provider default
  thinkingLevel: 'off' | 'low' | 'medium' | 'high';
  providerOptions?: Record<string, unknown>;  // provider-specific settings
  
  // Workspace
  workspacePath: string;               // explicit per-job folder
  
  // Prompt
  prompt: string;                      // static prompt text
  promptVariables?: Record<string, string>; // V2: {current_date, prev_status, etc.}
  
  // Conversation Policy
  conversationMode: 'new' | 'persistent' | 'dedicated';
  // 'new' = new thread per run
  // 'persistent' = one thread, grows over time
  // 'dedicated' = named thread per job (e.g., "Scheduler: Daily Review")
  
  // Execution Policy
  timeoutMs: number;                   // default 300000 (5 min)
  maxRetries: number;                  // default 0
  retryDelayMs: number;                // default 1000
  overlapBehavior: 'skip' | 'queue' | 'allow'; // default 'skip'
  
  // Metadata
  createdAt: number;
  updatedAt: number;
  lastRunAt: number | null;
  nextRunAt: number | null;
  runCount: number;
  lastStatus: 'success' | 'failed' | 'skipped' | 'running' | null;
  lastError: string | null;
}
```

### Field Rationale

| Field | Why Included | Why Not Added |
|---|---|---|
| `providerId` | Must be explicit, not current UI selection | — |
| `modelId` | Allow per-job model override | No "live reference" — snapshot at creation |
| `thinkingLevel` | Explicit per-job reasoning budget | No global fallback — required field |
| `workspacePath` | Jobs may target different folders | No "use current workspace" — explicit opt-in |
| `promptVariables` | V2 template system | Not in V1 — static prompt only |
| `conversationMode` | Controls thread isolation | Simpler than custom thread management |
| `overlapBehavior` | Configurable for different use cases | Default is safest (skip) |

---

## 6. Restart/Recovery Model

### Problem
Server was offline at 09:00. Job runs every day at 09:00. What happens on restart?

### Recommended Policy: **Skip Missed Runs**

**Default behavior:**
- On startup, query SQLite for all enabled jobs with `nextRunAt <= now`
- For each overdue job:
  - If one-time job and `execAt < now`: mark as `skipped`, log warning
  - If recurring job: recalculate `nextRunAt` to next valid occurrence, skip missed
- Log: `scheduler.recovered`, `job.skipped_past_due`

**Why skip (not catch up):**
1. Scheduled AI jobs are typically informational (reviews, summaries)
2. Running missed runs back-to-back could spam the user with results
3. User can manually trigger a "run now" if they want the missed output
4. Simpler to reason about; no queue buildup

**Exception:** One-time jobs that are overdue by < 5 minutes can run immediately (transient outage assumption).

### Crash Recovery

If a job was running when the server crashed:
1. On restart, scan `scheduler_runs` for `status = 'running'` with `started_at < now - timeout`
2. Mark as `failed` with `error = 'timeout_or_crash'`
3. Increment `runCount`, update `lastStatus`
4. Recalculate `nextRunAt` for the parent job
5. Do NOT retry automatically (user decides)

---

## 7. Duplicate/Overlap Model

### Guarantees (Not Exactly-Once, But Close)

| Scenario | Handling |
|---|---|
| Same tick, two scheduler instances | SQLite `INSERT OR IGNORE` on run creation |
| Crash during execution | Run marked `failed` on restart, not re-executed |
| Job takes longer than interval | `overlapBehavior` controls: skip/queue/allow |
| Restart while job running | Handled in §6 |

### Execution Lock Strategy

Use SQLite `INSERT ... ON CONFLICT DO NOTHING` for run creation:

```sql
INSERT INTO scheduler_runs (id, job_id, started_at, status, request_id)
VALUES (?, ?, ?, 'running', ?)
ON CONFLICT(id) DO NOTHING;
```

If insert fails (duplicate), the scheduler skips execution for this tick.

### Unique Occurrence Key

Each scheduled execution gets a unique `occurrence_id`:
```
occurrence_<job_id>_<scheduled_utc_timestamp>
```

This provides idempotency: same occurrence attempted twice = second attempt ignored.

---

## 8. Retry Model

### Default Policy

| Setting | Default | Rationale |
|---|---|---|
| `maxRetries` | 0 | Most jobs should not retry silently |
| `retryDelayMs` | 1000 | Short delay for transient errors |
| `retryOn` | `['network', 'rate_limit', 'timeout']` | Only retry recoverable errors |
| `dontRetryOn` | `['auth_error', 'invalid_config', 'provider_disabled']` | Don't retry misconfiguration |

### Backoff Strategy

Linear backoff: `delay = retryDelayMs * (attempt + 1)`

### When to Retry

| Error Type | Retry? | Reason |
|---|---|---|
| Network timeout | ✅ | Transient |
| Rate limit (429) | ✅ | Wait and retry |
| Provider unavailable | ✅ | Could come back |
| Invalid API key | ❌ | Configuration error |
| Model not found | ❌ | Configuration error |
| Prompt validation error | ❌ | User error |
| Destructive tool requires approval | ❌ | Safety — never auto-proceed |

---

## 9. Workspace Model

### Validation on Execution

Before executing a job:
1. Check `workspacePath` exists via `fs.existsSync()`
2. Check path is accessible (read + write)
3. If inaccessible: mark run as `failed` with `error = 'workspace_not_accessible'`
4. Do NOT fall back to another path or the global workspace

### Safe Behavior if Workspace Changes

| Scenario | Behavior |
|---|---|
| Deleted between creation and run | Run fails with clear error |
| Moved to new location | Run fails; user must update job |
| Permissions changed | Run fails; user must fix |
| Symlink to outside workspace | Reject (security) |

### No Global Workspace Dependency

Jobs explicitly specify their workspace. Never:
- Use the currently selected chat workspace
- Fall back to `process.cwd()`
- Use a hardcoded default

---

## 10. AI/Thread Model

### Thread Creation Policy

| Mode | Behavior | Use Case |
|---|---|---|
| `new` | Create new thread each run | Isolated, no context growth |
| `persistent` | One thread, append all runs | Running log, context accumulates |
| `dedicated` | Named thread per job | Debugging, history per job |

**V1 Default:** `new` (isolated runs, no context growth)

### Provider/Model Resolution

1. Load job config from SQLite
2. Resolve `providerId` against `ProviderRegistry`
3. If provider disabled/deleted: mark job as `error`, do not execute
4. If `modelId` specified but not in provider's model list: use provider default
5. Decrypt API key server-side only (never send to browser)
6. Build model via existing `getModel()` function

### Thinking Level Mapping

```typescript
const thinkingBudgets = { low: 1024, medium: 4096, high: 8192 };

function mapThinkingToProvider(provider: string, level: string): Record<string, any> {
  if (level === 'off') return {};
  
  const budget = thinkingBudgets[level as keyof typeof thinkingBudgets] ?? 4096;
  
  switch (provider) {
    case 'google':
      return { google: { thinkingConfig: { thinkingBudget: budget } } };
    case 'anthropic':
      return { anthropic: { thinking: { type: 'enabled', budgetTokens: budget } } };
    case 'openai':
    case 'custom':
      return { openai: { reasoningEffort: level } };
    default:
      return {}; // Provider doesn't support thinking
  }
}
```

**Unsupported level behavior:** If the selected provider doesn't support the requested thinking level, log a warning and fall back to `off`. Do NOT reject the job — the user may have configured it for a different provider.

---

## 11. Run History

### Minimal Useful Schema

```sql
CREATE TABLE scheduler_runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES scheduler_jobs(id) ON DELETE CASCADE,
  occurrence_id TEXT NOT NULL UNIQUE,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  duration_ms INTEGER,
  status TEXT NOT NULL CHECK(status IN ('running', 'success', 'failed', 'skipped')),
  error TEXT,
  request_id TEXT,
  provider TEXT,
  model TEXT,
  workspace TEXT,
  thread_id TEXT,  -- assistant-ui thread ID if applicable
  messages_count INTEGER DEFAULT 0
);
```

### Indexes

```sql
CREATE INDEX idx_scheduler_runs_job_id ON scheduler_runs(job_id);
CREATE INDEX idx_scheduler_runs_status ON scheduler_runs(status);
CREATE INDEX idx_scheduler_runs_started ON scheduler_runs(started_at DESC);
CREATE INDEX idx_scheduler_runs_occurrence ON scheduler_runs(occurrence_id);
```

### What to Store (and Not Store)

| Store | Reason |
|---|---|
| `started_at`, `finished_at`, `duration_ms` | Observability |
| `status`, `error` | Debugging |
| `provider`, `model`, `workspace` | Audit trail |
| `thread_id` | Link to conversation if persistent mode |
| `messages_count` | Quick count without joining |
| **NOT** prompt content | Privacy, size |
| **NOT** full response | Size, only relevant for persistent threads |
| **NOT** sensitive tool outputs | Security |

---

## 12. Security/Unattended Execution

### Core Principle

**Scheduled execution does NOT bypass safety.** A job running at 3 AM has the same constraints as a user-initiated chat.

### Approval Gates for Dangerous Tools

| Tool Category | Auto-Run | Requires Approval |
|---|---|---|
| Read files | ✅ | ❌ |
| Search files | ✅ | ❌ |
| List directory | ✅ | ❌ |
| File info | ✅ | ❌ |
| System info | ✅ | ❌ |
| Process list | ✅ | ❌ |
| Write file | ❌ | ✅ |
| Edit file | ❌ | ✅ |
| Delete file | ❌ | ✅ |
| Run command | ❌ | ✅ |
| Process kill | ❌ | ✅ |

### Unattended Execution Policy

When a scheduled job triggers a tool that requires approval:

1. **NEVER** silently auto-approve
2. **FAIL** the run with error: `approval_required_unattended`
3. **LOG** clearly: `scheduler.run_failed`, `reason: approval_required`
4. **OPTIONAL (V2):** Notify user via desktop notification to approve remotely

This ensures destructive actions never execute without explicit human consent.

---

## 13. SQLite Schema Proposal

### New Tables

```sql
-- Scheduler job definitions
CREATE TABLE scheduler_jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  
  -- Schedule
  schedule_type TEXT NOT NULL CHECK(schedule_type IN ('once', 'interval', 'cron')),
  cron_expression TEXT,
  interval_minutes INTEGER,
  exec_at INTEGER,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  start_date INTEGER,
  end_date INTEGER,
  max_runs INTEGER,
  
  -- AI Target
  target_type TEXT NOT NULL DEFAULT 'chat' CHECK(target_type IN ('chat', 'tool')),
  provider_id TEXT NOT NULL,
  model_id TEXT,
  thinking_level TEXT NOT NULL DEFAULT 'off' CHECK(thinking_level IN ('off', 'low', 'medium', 'high')),
  provider_options TEXT,
  
  -- Workspace
  workspace_path TEXT NOT NULL,
  
  -- Prompt
  prompt TEXT NOT NULL,
  prompt_variables TEXT,
  
  -- Conversation
  conversation_mode TEXT NOT NULL DEFAULT 'new' CHECK(conversation_mode IN ('new', 'persistent', 'dedicated')),
  
  -- Execution Policy
  timeout_ms INTEGER NOT NULL DEFAULT 300000,
  max_retries INTEGER NOT NULL DEFAULT 0,
  retry_delay_ms INTEGER NOT NULL DEFAULT 1000,
  overlap_behavior TEXT NOT NULL DEFAULT 'skip' CHECK(overlap_behavior IN ('skip', 'queue', 'allow')),
  
  -- Metadata
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_run_at INTEGER,
  next_run_at INTEGER,
  run_count INTEGER NOT NULL DEFAULT 0,
  last_status TEXT CHECK(last_status IN ('success', 'failed', 'skipped', 'running')),
  last_error TEXT,
  
  FOREIGN KEY (provider_id) REFERENCES provider_configs(id)
);

-- Execution history
CREATE TABLE scheduler_runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES scheduler_jobs(id) ON DELETE CASCADE,
  occurrence_id TEXT NOT NULL UNIQUE,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  duration_ms INTEGER,
  status TEXT NOT NULL CHECK(status IN ('running', 'success', 'failed', 'skipped')),
  error TEXT,
  request_id TEXT,
  provider TEXT,
  model TEXT,
  workspace TEXT,
  thread_id TEXT,
  messages_count INTEGER DEFAULT 0,
  
  FOREIGN KEY (job_id) REFERENCES scheduler_jobs(id) ON DELETE CASCADE
);

-- Indexes
CREATE INDEX idx_scheduler_jobs_enabled ON scheduler_jobs(enabled);
CREATE INDEX idx_scheduler_jobs_next_run ON scheduler_jobs(next_run_at) WHERE next_run_at IS NOT NULL;
CREATE INDEX idx_scheduler_jobs_schedule_type ON scheduler_jobs(schedule_type);
CREATE INDEX idx_scheduler_runs_job_id ON scheduler_runs(job_id);
CREATE INDEX idx_scheduler_runs_status ON scheduler_runs(status);
CREATE INDEX idx_scheduler_runs_started ON scheduler_runs(started_at DESC);
CREATE INDEX idx_scheduler_runs_occurrence ON scheduler_runs(occurrence_id);
```

---

## 14. GUI Proposal

### Navigation Integration

Add "Scheduler" to `web/src/config/navigation.ts`:

```typescript
{
  label: 'Scheduler',
  icon: 'clock',
  view: 'scheduler',
  order: 4,
  badge: null,
  visible: true,
}
```

### View Structure

```
Scheduler
├── Jobs
│   ├── Enabled Jobs (active, next run upcoming)
│   ├── Disabled Jobs (paused)
│   └── All Jobs (with filter)
│
├── Create/Edit Job
│   ├── Basic: name, description
│   ├── Schedule: type selector, when config
│   ├── AI: provider, model, thinking
│   ├── Workspace: path picker
│   └── Prompt: text area
│
└── History
    ├── Recent Runs (table)
    ├── By Job (drill-down)
    └── Stats (runs/day, success rate)
```

### Schedule Builder UX

**V1 Approach: Tabbed Schedule Editor**

```
Schedule Type: [One-time] [Interval] [Cron]

--- One-time ---
Date: [____]  Time: [____]  Timezone: [Dropdown]

--- Interval ---
Every: [30] [minutes | hours | days]

--- Cron ---
Quick Select:
  [Every hour] [Every 6 hours] [Daily at 9am] [Weekdays at 9am] [Weekly Monday]
  
Advanced:
  Cron Expression: [0 9 * * *]  [Validate]
  Timezone: [Dropdown with IANA names]
```

**V2 (Future): Natural Language Input**
```
"Every weekday at 9 AM in Asia/Kolkata"
→ Parses to cron: "0 9 * * 1-5", tz: "Asia/Kolkata"
```

---

## 15. Failure/Edge-Case Behavior

| Scenario | Behavior |
|---|---|
| Invalid cron expression | UI rejects on save; backend logs error |
| Invalid timezone | UI rejects; show valid IANA list |
| Workspace deleted | Run fails with `workspace_not_found` |
| Provider disabled | Job marked `error` on next tick; user notified |
| Model removed from provider | Fall back to provider default; log warning |
| Credentials missing | Run fails with `provider_credentials_missing` |
| Provider timeout | Retry if `maxRetries > 0`; otherwise fail |
| AI error (non-retryable) | Mark failed; do not retry |
| Native tool error | Included in run error; respect retry policy |
| MCP server unavailable | Tool call fails; job continues without MCP tools |
| Server restart during run | Run marked `failed` on restart (timeout check) |
| Crash during execution | Same as restart; run marked `failed` |
| Overlapping run | `overlapBehavior` controls: skip/queue/allow |
| Missed run (server down) | Skip; recalculate next run |
| DST spring-forward | Shifts forward (Bun.cron behavior: 2:30 → 3:30) |
| DST fall-back | Run once at first occurrence |
| Duplicate scheduler tick | SQLite `ON CONFLICT` prevents double run |
| Job edited while running | Current run uses old config; new config for next run |
| Job disabled while running | Current run completes; next run skipped |
| Job deleted while running | Current run completes; next run never fires |

---

## 16. Dependency Recommendation

### V1 Dependencies

| Package | Version | Purpose | Reason |
|---|---|---|---|
| *(built-in)* `Bun.cron` | — | Scheduling engine | Zero new dependencies |
| *(existing)* `bun:sqlite` | built-in | Persistence | Already used |
| *(existing)* `@paralleldrive/cuid2` | ^3.3.0 | ID generation | Already used |
| *(existing)* `zod` | ^4.5.4 | Validation | Already used |
| *(existing)* `ai` | ^7.0.93 | AI execution | Already used |

**Total new dependencies: 0**

### V2 Consideration

If V2 requires advanced cron syntax (`L`, `W`, `#` for "last day of month", "nearest weekday", "nth weekday"), add:
- `node-cron` ^4.6.0 as an optional dependency
- Use `Bun.cron` for basic schedules, `node-cron` for advanced expressions

### Why Not Add More

- `cron-parser` is already a transitive dependency of node-cron; no need to add directly
- `luxon` (used by cron library) is a transitive dep; no direct usage needed
- No timezone library needed — node-cron handles this internally

---

## 17. V1 vs Later Features

### MUST HAVE (V1)

- [ ] SQLite persistence for jobs and runs
- [ ] Bun.cron integration with restart recovery
- [ ] One-time, interval, and cron schedule types
- [ ] Explicit provider/model/thinking configuration
- [ ] Explicit workspace per job
- [ ] Static prompt text
- [ ] Basic run history (status, duration, error)
- [ ] Overlap prevention (skip by default)
- [ ] Thread-per-run (new mode)
- [ ] Approval gates respected (no auto-approve destructive)
- [ ] Centralized logging integration
- [ ] REST API (CRUD for jobs, run history)
- [ ] Basic UI (job list, create/edit, history table)

### NICE TO HAVE (V2)

- [ ] Natural language schedule input ("every weekday at 9")
- [ ] Prompt templating with variables (`{{date}}`, `{{prev_status}}`)
- [ ] Desktop notifications for job completion/failure
- [ ] Remote approval for destructive tools
- [ ] Job dependencies (run B after A succeeds)
- [ ] Webhook callbacks on job completion
- [ ] Export/import jobs as JSON
- [ ] Advanced analytics (success rate, trend charts)

### DO NOT BUILD YET

- [ ] Distributed scheduling (multiple TBAi instances)
- [ ] Persistent job queues (BullMQ, etc.)
- [ ] Worker thread isolation for heavy jobs
- [ ] Real-time job streaming to UI
- [ ] AI-generated prompts for jobs
- [ ] Multi-user support
- [ ] OAuth/scoped credentials for scheduled runs

---

## 18. Implementation Phases

### Phase 1: Core Infrastructure (Backend)

1. Create `src/services/scheduler.ts`
   - Job CRUD operations
   - Bun.cron integration
   - Restart recovery logic
   - Next-run calculation
2. Add SQLite schema (`scheduler_jobs`, `scheduler_runs`)
3. Add Zod validation schemas
4. Add routes (`/api/scheduler/jobs`, `/api/scheduler/runs`)
5. Write unit tests

### Phase 2: Execution Engine

1. Integrate with existing AI pipeline (`streamText`)
2. Handle provider/model resolution
3. Implement workspace validation
4. Add approval gate checks for destructive tools
5. Add run history recording

### Phase 3: UI

1. Add Scheduler navigation item
2. Create `SchedulerPanel.tsx`
3. Create `JobEditor.tsx` (create/edit form)
4. Create `JobList.tsx` (job cards with status)
5. Create `RunHistory.tsx` (table with filters)
6. Connect to REST API

### Phase 4: Polish

1. Add logging events (`scheduler.job_created`, etc.)
2. Add error boundaries
3. Add export/import
4. Performance testing
5. Documentation updates

---

## 19. Final Decision

### What to Build

A SQLite-backed scheduler using `Bun.cron` that:

1. **Stores jobs** in `scheduler_jobs` table with explicit configuration
2. **Schedules execution** via Bun.cron with SQLite-driven restart recovery
3. **Recovers on restart** by recalculating next-run times from SQLite
4. **Prevents duplicates** via SQLite unique constraints
5. **Respects safety** by never auto-approving destructive tools
6. **Logs everything** via existing centralized logger
7. **Provides API** for UI CRUD and history
8. **Builds UI** with guided schedule editor

### Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Scheduler library | `Bun.cron` | Built-in, zero new deps, native Bun integration |
| Persistence | SQLite (bun:sqlite) | Already used, no external services |
| Restart policy | Skip missed runs | Prevents spam, simpler reasoning |
| Overlap default | Skip | Safest for unattended execution |
| Retry default | 0 | User must opt-in |
| Workspace | Explicit per-job | Never assume global workspace |
| Thread mode | New per run (V1) | No context growth, isolation |
| Approval | Never auto-approve | Safety first |
| Prompt | Static only (V1) | Simplicity |
| Template vars | V2 | Not in V1 |

### File Map (Proposed)

```
src/
├── services/
│   ├── scheduler.ts          # Scheduler engine + Bun.cron integration
│   ├── schedulerTypes.ts     # TypeScript interfaces
│   └── storage/
│       └── scheduler.ts      # SQLite CRUD for scheduler_jobs, scheduler_runs
├── routes/
│   └── scheduler.ts          # REST API: /api/scheduler/*
├── lib/
│   └── schedulerValidation.ts # Zod schemas
└── db/
    └── migrations/
        └── 001_scheduler.sql  # Schema migration

web/src/
├── components/
│   ├── SchedulerPanel.tsx    # Main scheduler view
│   ├── JobList.tsx           # Job cards
│   ├── JobEditor.tsx         # Create/edit form
│   └── RunHistory.tsx        # Run history table
├── stores/
│   └── scheduler.ts          # Zustand store (UI state only)
└── config/
    └── navigation.ts         # Add Scheduler nav item
```

---

## Appendix: Bun.cron DST Behavior Reference

From Bun documentation:

**Spring-forward (gap):** Times in the gap are **shifted forward**. `0 2:30 * * *` in `America/New_York` fires at `03:30` on the spring-forward day (the nonexistent 2:30 is mapped to the first valid time after the gap).

**Fall-back (overlap):** First occurrence fires, second is ignored. `0 1:30 * * *` fires once at pre-transition `01:30 EDT`; the post-transition `01:30 EST` is skipped.

**Sub-hourly expressions inside gap:** Only the first match fires. `*/15 2 * * *` during spring-forward fires at `02:00` then jumps to `03:00`.

**Fixed-offset zones:** Use `{ tz: 'Etc/UTC' }` for DST-free schedules.

### node-cron DST (for reference / V2 consideration)

If advanced cron syntax (`L`, `W`, `#`) is needed in V2, `node-cron` provides different DST behavior:
- **Spring-forward:** Skips nonexistent times entirely (no fire that day)
- **Fall-back:** Same as Bun.cron — fires once at first occurrence

---

*Document version: 2026-09-11*
*Research scope: TBAi built-in scheduler architecture*
*Status: READ-ONLY STUDY — no implementation*
