# Implementation Plan: Paseo-Style OpenCode Session Import (Live Native Attachment)

**Date:** 2026-11-01  
**Status:** Architecture Proposal & Specification (Revised — Awaiting Confirmation)  
**Target Subsystem:** OpenCode Subsystem (`TBAi`)  
**Reference Implementations:**  
- Paseo (`D:\Temp\paseo`): OpenCode V2 Agent Adapter (`packages/server/src/server/agent/providers/opencode/v2/agent.ts`)
- TBAi Native History & Reverse Proxy Architecture (`web/src/features/opencode/`, `src/services/opencode/`)

---

## 1. Project State & Working-Tree Baseline

### 1.1 Local Checkout State
- **Repository:** `Rajendertyagi/TBAi`
- **Branch:** `ci/tauri-e2e-verify`
- **Local HEAD:** `4a2727ada6bd212c75e3529d77eb6b3750feff88`
- **Working-Tree Integrity:**
  - Exactly 17 files modified from the preceding OpenCode backend hardening task are currently present in the working tree.
  - Every single existing hardening change is preserved intact.
  - Zero application source files are modified during this task.
  - Zero commits, pushes, merges, stashes, checkouts, or discards are performed.

### 1.2 Preservation of Existing Hardening Work
The 17 modified files from the hardening phase are:
1. `scripts/run-opencode-runtime-suites.ts` (Compaction conformance promoted to required CI)
2. `src/config/opencode.ts` (Version 2.2.0+ floor and stability window config)
3. `src/db/schema/opencode-session-orphans.ts` (Orphan journal `deferred_until` schema migration)
4. `src/services/opencode/compatibility.ts` (Strict 2.2.0+ version classification)
5. `src/services/opencode/connectionState.ts` (Unique `targetId` tracking and context invalidation)
6. `src/services/opencode/orphanReconciler.ts` (Safe adopted target capture and deferral)
7. `src/services/opencode/runtimeTarget.ts` (`targetId` propagation)
8. `src/services/opencode/serverManager.ts` (Child identity invalidation and crash-loop resilience)
9. `src/services/storage/opencodeSessionOrphans.ts` (Orphan deferral storage methods)
10. `tests/integration/opencode/opencode-native-compaction-conformance.test.ts` (120s stall fix)
11. `tests/integration/opencode/serverManager.test.ts`
12. `tests/integration/opencode/startup-orchestration.test.ts`
13. `tests/unit/opencode/adoption-attempts.test.ts`
14. `tests/unit/opencode/compatibility.test.ts`
15. `tests/unit/opencode/orphanReconciler.test.ts`
16. `tests/unit/opencode/runtime.test.ts`
17. `tests/unit/storage/opencodeSessionOrphans.test.ts`

The import implementation plan builds on top of this hardened foundation without reverting, duplicating, or conflicting with any of these changes.

---

## 2. Core Architectural Decisions

### 2.1 Live Native Session Attachment (No SQLite Transcript Copying)
- **Product Decision:** An imported TBAi conversation attaches directly to the original OpenCode session and uses the live OpenCode history. It is a native session attachment, not an independent, frozen transcript snapshot.
- **Why Storing Messages in SQLite is Prohibited:**
  1. *Existing Architecture:* In TBAi, `web/src/adapters/threadHistoryAdapter.ts` explicitly enforces:
     ```ts
     // opencode rows are session-history owned (OpenCode server is the authority;
     // the runtime projects it). The SQLite adapter must never store their messages.
     if (peekMaterializedEngine(remoteId) === "opencode") return;
     ```
     OpenCode conversations in TBAi do not store transcript messages in SQLite.
  2. *Live Projection:* The frontend (`CodeShell` -> `useOpenCodeRuntime` -> `v2Client.ts` -> `sessionMessageLoader.ts`) dynamically reads messages from the OpenCode server through the reverse-proxy endpoint (`GET /api/opencode/session/:id/message`) and renders them using `v2MessageProjection.ts`. Real-time tokens and events arrive via SSE (`GET /api/opencode/event`).
  3. *Single Source of Truth:* If messages were copied into SQLite via `messageService.upsertStored()`, the stored transcript would immediately diverge whenever turns, tool executions, or compactions occur outside TBAi (or inside OpenCode).
  4. *Settled Contract:* The import operation associates the TBAi conversation row with the remote session ID, service owner, and directory. When opened, the imported conversation activates the standard OpenCode V2 client and history loader.

### 2.2 Original OpenCode Directory Preservation (`opencode_directory`)
- **The Problem:** TBAi's workspace authorization (`resolveConversationWorkspace`) currently relies exclusively on the local `folders` table. An external OpenCode session can reside in an arbitrary directory (e.g. unregistered local folder, or an opaque remote directory on an adopted Linux service).
- **The Solution:** Add a nullable `opencode_directory TEXT` column to the `conversations` table.
- **Unified Directory Resolver:**
  Define a centralized helper in `src/services/opencode/workspace.ts`:
  ```ts
  export async function resolveOpenCodeSessionDirectory(
    conversation: Pick<Conversation, "id" | "opencodeDirectory">,
  ): Promise<string>
  ```
  - If `conversation.opencodeDirectory` is present and non-empty: returns it verbatim.
    - Never calls local path normalization or `stat()` on adopted/remote paths.
    - Never rejects an imported session because its directory is not registered in TBAi.
    - Never silently falls back to the hidden TBAi chat directory if the path is unavailable.
  - If `conversation.opencodeDirectory` is null: delegates to `(await resolveConversationWorkspace(conversation.id)).dir` (preserving standard behavior for ordinary TBAi-created conversations).
- **Call-Site Audit:** Every OpenCode session operation must use `resolveOpenCodeSessionDirectory`:
  - `src/services/opencode/proxyAuthorization.ts`: Resolves session directory for upstream header injection.
  - `src/services/opencode/sessions.ts`: Resolves directory for session resume, activity check (`client.session.active()`), and session termination (`client.session.remove()`).
  - `src/services/opencode/conversationDeletion.ts`: Resolves directory for deletion intent journaling (`opencodeOrphanService.recordDeletionIntent`).
  - `src/routes/opencode.ts`: Strip caller-supplied directory parameters and use authorized directory.

### 2.3 Protection Against Accidental Session Recreation (Imported Provenance)
- **The Defect in Existing Creation:** In `src/services/opencode/sessions.ts` (`ensureOpenCodeSessionInner`), when a conversation has `opencodeSessionId`, it calls `fetchOpenCodeSession(client, sessionId)`. If that returns `null` (404 Not Found), the existing code logs `opencode.session_stale` and falls through to `session.create`, minting a new session ID and rebinding the pointer.
- **Why This is Unsafe for Imports:** If an imported external session is deleted or unavailable on the OpenCode server, silently creating a new blank session would wipe out context and deceptively present a fresh session under the old conversation title.
- **The Solution:** Add an explicit provenance column:
  `opencode_imported INTEGER NOT NULL DEFAULT 0` to `conversations`.
- **Enforcement:** In `ensureOpenCodeSessionInner`:
  ```ts
  if (conversation.opencodeSessionId) {
    const live = await fetchOpenCodeSession(client, conversation.opencodeSessionId);
    if (live) {
      ...
      return { sessionId: live.id, directory: live.directory, reusedExistingSession: true };
    }
    if (conversation.opencodeImported) {
      // Never silently recreate an imported session!
      throw new OpenCodeImportedSessionMissingError(conversationId, conversation.opencodeSessionId);
    }
    // Ordinary TBAi-created session: fall through to recreate
    logger.warn("opencode", "opencode.session_stale", { conversationId, sessionId: conversation.opencodeSessionId });
  }
  ```
  Missing imported sessions are surfaced with a clean error; replacement requires an explicit user action.

### 2.4 Service Ownership Consistency & SQLite Deduplication
- **Existing Service Owner Formats:**
  - Managed service: `"managed"` (or legacy `NULL` / `""`).
  - Adopted service: `"adopted:<canonical-origin>"`.
- **Deduplication Identity:** A session is uniquely identified by `(serviceOwner, sessionId)`. The same session ID on two distinct OpenCode services represents two distinct sessions.
- **Database Uniqueness & Legacy NULL Handling:**
  In SQLite, multiple rows can have `NULL` in a unique index unless constrained.
  - *Migration Strategy:*
    1. Audit existing `conversations` rows for duplicates on `(COALESCE(NULLIF(opencode_service_owner, ''), 'managed'), opencode_session_id)`.
    2. Backfill existing bound rows:
       ```sql
       UPDATE conversations 
       SET opencode_service_owner = 'managed' 
       WHERE opencode_session_id IS NOT NULL AND (opencode_service_owner IS NULL OR opencode_service_owner = '');
       ```
    3. Create the unique partial index:
       ```sql
       CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_opencode_owner_session 
       ON conversations(opencode_service_owner, opencode_session_id) 
       WHERE opencode_session_id IS NOT NULL;
       ```
- **Owner-Aware Session Lookup:**
  Replace single-parameter lookups with owner-scoped lookups:
  `conversationService.findByOpenCodeSession(serviceOwner: string, sessionId: string): Promise<Conversation | null>`
- **Proxy Authorization Owner Binding:**
  In `src/routes/opencode.ts`, the route handler resolves the runtime target (`target = await resolveOpenCodeRuntimeTarget()`).
  Pass `target.owner` (e.g. `"managed"` or `"adopted:..."`) into `authorizeOpenCodeProxyRequest`. Authorization verifies that the conversation bound to `sessionId` has a matching `opencode_service_owner`. A request for a managed session can never be authorized against an adopted target, and vice versa.

### 2.5 Freshness Guard: `sourceRef`
- **Purpose:** `sourceRef` is a target freshness and correlation guard, not an authorization token or secret.
- **Structure:** Encodes the active target's identity:
  `encodeSourceRef(target: { mode: "managed" | "adopted"; targetId: number; origin: string; shutdownEpoch: number }): string`
- **Validation:** When `POST /api/opencode/import` is received:
  1. The backend captures the currently active runtime target.
  2. Compares the target's `targetId`, `mode`, `origin`, and shutdown epoch against `sourceRef`.
  3. If the active target changed, restarted, or is unavailable, reject with `OpenCodeImportStaleTargetError` (HTTP 409).
  4. The client cannot supply an arbitrary directory or service owner; all session parameters are read directly from the captured target's verified `client.session.get({ sessionID })` call.

### 2.6 Concurrent Import Safety & Workspace Cleanup
- **The Race:** If two concurrent requests attempt to import the same session:
  `conversationService.create()` creates a conversation row. If it creates a local chat workspace folder before inserting into SQLite, a unique-index failure on `(opencode_service_owner, opencode_session_id)` could orphan a folder row or directory on disk.
- **The Safe Sequence:**
  1. Perform an initial existence check: `findByOpenCodeSession(serviceOwner, sessionId)`. If present, throw 409 immediately.
  2. For simple mode (unregistered directory), defer workspace folder creation or wrap in try/catch: if `conversationService.create()` throws a unique constraint error (`SQLITE_CONSTRAINT_UNIQUE`), cleanly delete the newly minted workspace folder (if created) and return the existing conversation ID with HTTP 409.

---

## 3. Paseo Reference Analysis & OpenCode 2.2.0 API Grounding

### 3.1 Paseo's Default Discovery Implementation
From `D:\Temp\paseo\packages\server\src\server\agent\providers\opencode/v2/agent.ts` (lines 233–263):
```ts
async listImportableSessions(options: ListImportableSessionsOptions = {}): Promise<ImportableProviderSession[]> {
  const connection = await this.runtime.acquire();
  try {
    const sessions: SessionInfo[] = [];
    let cursor: string | undefined;
    const scanLimit = Math.min(options.scanLimit ?? 100, 500);
    do {
      const page = await connection.client.session.list({
        ...(cursor ? { cursor } : { directory: options.cwd, search: options.query }),
        limit: Math.min(50, scanLimit - sessions.length),
      });
      sessions.push(...page.data);
      cursor = page.cursor.next ?? undefined;
    } while (cursor && sessions.length < scanLimit);
    return sessions
      .filter((info) => !info.parentID && !info.time.archived)
      .slice(0, options.limit ?? 50)
      .map((info) => ({
        providerHandleId: info.id,
        cwd: info.location.directory,
        title: info.title ?? null,
        firstPromptPreview: null,
        lastPromptPreview: null,
        lastActivityAt: new Date(info.time.updated),
      }));
  } finally {
    await connection.release();
  }
}
```

### 3.2 TBAi Adoption of Paseo's Defaults
1. Use `client.session.list` with cursor-based pagination.
2. Filter: `!info.parentID && !info.time.archived` (top-level, non-archived sessions only).
3. Pagination defaults: page size `50`, default scan limit `100`, max scan limit `500`, default display limit `50`.
4. Discovery across all directories: Do not pass `directory` into discovery; list sessions regardless of whether their directories exist in TBAi.
5. Server search query: Forward optional `query` to `search` parameter in `client.session.list`.
6. Deduplication: Exclude sessions where `conversationService.findByOpenCodeSession(serviceOwner, session.id)` returns an existing row.

### 3.3 Verified OpenCode 2.2.0 Contract
Verified directly against installed `@opencode/client` v2.2.0:
- `client.session.list`: GET `/api/session` with `{ limit, cursor, search, parentID, archived, directory }`.
- `client.session.get`: GET `/api/session/:sessionID` returning `{ data: SessionInfo }`.
- `client.message.list`: GET `/api/session/:sessionID/message` with `{ limit, order, cursor, type }`.
- Version constraint: OpenCode 2.2.0 and newer stable versions only. Prereleases and versions < 2.2.0 are rejected at the service compatibility boundary.

---

## 4. Implementation Specifications

### 4.1 Schema Migration (`src/db/index.ts`)
```ts
// 1. Add opencode_directory column
addColumnIfNotExists("conversations", "opencode_directory", "TEXT");

// 2. Add opencode_imported provenance column
addColumnIfNotExists("conversations", "opencode_imported", "INTEGER NOT NULL DEFAULT 0");

// 3. Backfill legacy null/empty owners to 'managed'
sqlite.run(`
  UPDATE conversations 
  SET opencode_service_owner = 'managed' 
  WHERE opencode_session_id IS NOT NULL 
    AND (opencode_service_owner IS NULL OR opencode_service_owner = '')
`);

// 4. Create unique deduplication index
sqlite.run(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_opencode_owner_session 
  ON conversations(opencode_service_owner, opencode_session_id) 
  WHERE opencode_session_id IS NOT NULL
`);
```

### 4.2 Storage Service (`src/services/storage/conversations.ts`)
- Update `ConversationRow`:
  - `opencode_directory: string | null`
  - `opencode_imported: number`
- Update `Conversation` domain model:
  - `opencodeDirectory: string | null`
  - `opencodeImported: boolean`
- Update `CreateConversationData` and `UpdateConversationData`:
  - Include optional `opencodeDirectory?: string | null`
  - Include optional `opencodeImported?: boolean`
- Implement `findByOpenCodeSession(serviceOwner: string, sessionId: string): Promise<Conversation | null>`:
  ```ts
  const normalizedOwner = serviceOwner || "managed";
  const row = db.query<ConversationRow, [string, string]>(
    `SELECT * FROM conversations 
     WHERE opencode_session_id = ? 
       AND COALESCE(NULLIF(opencode_service_owner, ''), 'managed') = ? 
     LIMIT 1`
  ).get(sessionId, normalizedOwner);
  return row ? this.mapRow(row) : null;
  ```
- Implement `listImportedOpenCodeSessionIds(serviceOwner: string): Promise<Set<string>>`:
  Queries all non-null `opencode_session_id`s for the given `serviceOwner`.

### 4.3 Workspace Directory Seam (`src/services/opencode/workspace.ts`)
```ts
export async function resolveOpenCodeSessionDirectory(
  conversation: Pick<Conversation, "id" | "opencodeDirectory">,
): Promise<string> {
  if (conversation.opencodeDirectory && conversation.opencodeDirectory.trim().length > 0) {
    return conversation.opencodeDirectory;
  }
  const resolved = await resolveConversationWorkspace(conversation.id);
  return resolved.dir;
}
```

### 4.4 Import Service (`src/services/opencode/import.ts`)
```ts
export interface ImportableSessionSummary {
  readonly sessionId: string;
  readonly directory: string;
  readonly title: string | null;
  readonly firstPromptPreview: string | null;
  readonly lastPromptPreview: string | null;
  readonly lastActivityAt: number;
  readonly sourceRef: string;
}

export async function listImportableOpenCodeSessions(input?: {
  query?: string;
  limit?: number;
  scanLimit?: number;
}): Promise<ImportableSessionSummary[]>

export async function importOpenCodeSession(input: {
  sessionId: string;
  sourceRef: string;
}): Promise<{ conversationId: string }>
```

**Import Execution Flow:**
1. **Freshness Check:** Decode `input.sourceRef` and verify against `resolveOpenCodeRuntimeTarget()`. Throw `OpenCodeImportStaleTargetError` (409) if mismatched.
2. **Retrieve Metadata:** Call `client.session.get({ sessionID: input.sessionId })` using the captured target's transport.
3. **Verify Eligibility:** Ensure session is not archived and has no `parentID`.
4. **Deduplication:** Call `conversationService.findByOpenCodeSession(serviceOwner, input.sessionId)`. If existing conversation found, throw `OpenCodeImportAlreadyImportedError(existing.id)` (409).
5. **Folder Association:** Check if `info.location.directory` exactly matches a registered folder in `folders` table. If so, bind `workspaceMode: "project"` and `workspaceFolderId: folder.id`; otherwise `workspaceMode: "simple"`.
6. **Create Conversation:** Call `conversationService.create(...)` with:
   - `engine: "opencode"`
   - `opencodeSessionId: info.id`
   - `opencodeServiceOwner: serviceOwner`
   - `opencodeDirectory: info.location.directory`
   - `opencodeImported: true`
   - `title: info.title || "Imported OpenCode Session"`
   - `opencodeAgent: info.agent ?? null`
   - `opencodeModel: info.model ? `${info.model.providerID}/${info.model.id}` : null`
7. **Clean Race Handling:** If database insert throws unique constraint error, catch it, clean up any created simple workspace, and return the winner's conversation ID via 409.
8. **Return:** `{ conversationId }`. (When opened, the conversation loads live history via the proxy).

### 4.5 REST API Routes (`src/routes/opencodeImport.ts`)
- `GET /api/opencode/importable`:
  - Query: `{ query?, limit?, scanLimit? }` validated via Zod.
  - Returns: `{ sessions: ImportableSessionSummary[] }`.
- `POST /api/opencode/import`:
  - Body: `{ sessionId: string, sourceRef: string }` validated via Zod.
  - Responses:
    - `201`: `{ conversationId: string }`
    - `404`: Session not found on remote server.
    - `409`: Already imported (returns `{ error, conversationId }`) or stale sourceRef.
    - `422`: Invalid input schema.
    - `502 / 503`: Upstream service unreachable or incompatible.
- Mount in `src/routes/index.ts` under `/api/opencode`.

### 4.6 Frontend Sidebar Integration (`web/src/features/opencode/`)
- Component: `OpenCodeImportInline.tsx` mounted in the sidebar OpenCode section.
- Control: "Import from OpenCode" button.
- Behavior:
  - On click: Fetches `GET /api/opencode/importable` on demand (temporary component state, no second Zustand store).
  - Displays inline list with session title, relative time, and directory badge.
  - Clicking a session calls `POST /api/opencode/import`.
  - On `201`: Invokes `openAgent(conversationId)` from `chatTabs`, navigating straight to Code mode.
  - On `409`: Displays "Session already imported" notification with button to open existing thread.
  - Zero runtime `@opencode/client` imports in web bundle.

---

## 5. Comprehensive Verification Test Matrix

| # | Test Scenario | Target Test File | Description |
|---|---------------|------------------|-------------|
| 1 | Managed session import | `tests/integration/opencode/import.test.ts` | Import top-level session from managed OpenCode server. |
| 2 | Adopted session import | `tests/integration/opencode/import.test.ts` | Import top-level session from adopted OpenCode server; verifies canonical owner. |
| 3 | Unscoped discovery | `tests/unit/opencode/import.test.ts` | Discovers sessions across multiple distinct directories. |
| 4 | Directory preservation | `tests/unit/opencode/workspace.test.ts` | Verifies `opencode_directory` is preserved and resolved without fallback to chat sandbox. |
| 5 | Native history load | `tests/integration/opencode/import.test.ts` | Imported conversation loads live history through OpenCode proxy. |
| 6 | Live history reflection | `tests/integration/opencode/import.test.ts` | External messages added outside TBAi appear upon history refresh. |
| 7 | Session continuity | `tests/integration/opencode/import.test.ts` | Sending a message continues the imported OpenCode session ID. |
| 8 | No SQLite transcript copy | `tests/integration/opencode/import.test.ts` | Asserts `messages` table contains 0 rows for the imported conversation. |
| 9 | Cross-owner collision safety | `tests/unit/opencode/import.test.ts` | Same session ID on managed and adopted services creates 2 distinct conversations. |
| 10 | Legacy owner normalization | `tests/unit/storage/conversations.test.ts` | Legacy rows with NULL/empty owner resolve and query as `'managed'`. |
| 11 | Duplicate migration safety | `tests/unit/storage/conversations.test.ts` | Audits and verifies migration on database with existing rows. |
| 12 | Stale sourceRef rejection | `tests/integration/opencode/import.test.ts` | Rejects import with 409 when target ID or origin has changed. |
| 13 | Directory tampering prevention | `tests/integration/opencode/import.test.ts` | Browser cannot supply an arbitrary directory; server-reported directory is authoritative. |
| 14 | Missing imported session protection | `tests/unit/opencode/sessions.test.ts` | Asserts 404 remote session throws `OpenCodeImportedSessionMissingError` and never recreates. |
| 15 | Ordinary session recreate preserved | `tests/unit/opencode/sessions.test.ts` | Ordinary TBAi session still recreates on 404 stale pointer. |
| 16 | Concurrent import race | `tests/integration/opencode/import.test.ts` | Concurrent imports result in exactly 1 conversation and 0 orphaned workspaces. |
| 17 | Deletion with custom directory | `tests/integration/opencode/conversation-deletion.test.ts` | Deletion intent and termination use `opencode_directory`. |
| 18 | OpenCode version gate | `tests/unit/opencode/compatibility.test.ts` | Verifies rejection of < 2.2.0 and prereleases; accepts 2.2.0+. |
| 19 | Frontend inline discovery & navigation | `tests/dom/opencode/import.test.tsx` | Renders inline list, handles click, calls `openAgent(id)`. |
| 20 | Frontend 409 duplicate link | `tests/dom/opencode/import.test.tsx` | Shows "already imported" notice with link to existing conversation. |

---

## 6. Execution Gates (To Be Verified Upon Implementation)

1. `bun run typecheck` (Backend, Web, Tests: 0 errors)
2. `bun x biome check` (0 errors, 0 warnings)
3. `bun test --isolate tests/unit/opencode/`
4. `bun test --isolate tests/integration/opencode/`
5. `bun run test:opencode-runtime` (10/10 required runtime suites pass)

---

## 7. Scope Boundaries & Explicit Non-Goals

- **No Bidirectional Sync Engine:** No background polling or sync workers writing to external OpenCode disks.
- **No Automatic Folder Registration:** External directories are not automatically added to the TBAi project folders list.
- **No Child or Archived Session Imports:** Strictly top-level, active sessions.
- **No SQLite Message Duplication:** Transcript remains authoritative on OpenCode server.
