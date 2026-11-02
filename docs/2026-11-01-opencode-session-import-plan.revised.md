# Implementation Plan: Paseo-Style OpenCode Session Import (Live Native Attachment)

**Date:** 2026-11-01

**Status:** Revised architecture plan — directory behavior and implementation boundaries verified; implementation still requires explicit authorization

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

  1. **Existing Architecture:** In TBAi, `web/src/adapters/threadHistoryAdapter.ts` explicitly enforces:

     ```ts

     // opencode rows are session-history owned (OpenCode server is the authority;

     // the runtime projects it). The SQLite adapter must never store their messages.

     if (peekMaterializedEngine(remoteId) === "opencode") return;

     ```

     OpenCode conversations in TBAi do not store transcript messages in SQLite.

  2. **Live Projection:** The actual frontend path is `OpenCodeView.tsx` -> `sessionBootstrap.ts` -> `useOpenCodeRuntime.ts` -> `v2ThreadController.ts` -> `sync/sessionMessageLoader.ts` -> `v2History.ts` / `v2Client.ts`. The controller reads native history through the official SDK's `client.message.list()` method, which the TBAi reverse proxy forwards to OpenCode (`GET /api/session/:sessionID/message`). Live tokens and session events use the existing SSE event subscription. This history is projected into the existing controller/reducer state; it is not fetched through TanStack Query.

  3. **Single Source of Truth:** If messages were copied into SQLite via `messageService.upsertStored()`, the stored transcript would immediately diverge whenever turns, tool executions, or compactions occur outside TBAi (or inside OpenCode).

  4. **Settled Contract:** The import operation associates the TBAi conversation row with the remote session ID, service owner, and directory. When opened, the imported conversation activates the standard OpenCode V2 client and history loader.

### 2.2 OpenCode Directory Preservation and Directory Changes

Add a nullable `opencode_directory TEXT` column to `conversations`.

**Important distinction:** `opencode_directory` is TBAi's persisted mirror of the OpenCode session's *currently confirmed* working directory. It is not the permanent source of truth and must not be treated as immutable after import. OpenCode owns the session's current location.

### What OpenCode 2.2.0 actually does

OpenCode 2.2.0 stores the session's `location.directory` on the session record. Its `POST /api/session/:sessionID/move` operation moves the session to another existing project directory. The implementation:

1. Validates that the destination exists and is a directory.
2. If execution is active, admits the move for the requested safe delivery boundary.
3. If the source is unavailable and the session is idle, it can apply the move directly.
4. Publishes `session.moved`.
5. Projects the event into the OpenCode database, updating the session's `directory`, project/path metadata, and update time.

OpenCode routes a move event to both the old and new locations so an existing subscriber can observe the transition. Subsequent session operations use the updated session location.

This means an imported session **can continue working after its directory is changed through OpenCode's own Move Session operation**, provided the destination exists and is accessible to that OpenCode service. TBAi must follow the updated location. It must not keep routing the event stream to the old directory forever.

### Directory resolver and authority

Keep a centralized helper in `src/services/opencode/workspace.ts`, such as:

```ts
export async function resolveOpenCodeSessionDirectory(
  conversation: Pick<Conversation, "id" | "opencodeDirectory">,
): Promise<string>
```

- For an ordinary TBAi-created OpenCode conversation with no stored OpenCode directory, fall back to `(await resolveConversationWorkspace(conversation.id)).dir`.
- For an imported conversation, use the last server-confirmed `opencodeDirectory` as the backend routing value until it is refreshed from OpenCode.
- The authoritative current location comes from `client.session.get({ sessionID })` against the exact captured service/transport. Persist the returned `session.location.directory` before the browser establishes or re-establishes its event stream.
- When the server-reported directory changes, update `opencode_directory` and return the new directory to the frontend. Do not create a replacement session.
- The browser must never submit a directory to choose the OpenCode working directory. The browser sends the existing session selector; the backend resolves the conversation, service owner, and trusted current directory.

### Required directory reconciliation points

1. **At import:** retrieve the session metadata from the captured service and save its current `location.directory`.
2. **Whenever an imported conversation is opened or bootstrapped:** call `session.get` by session ID on the same owner-bound service, reconcile `opencode_directory`, and only then allow the browser runtime's event connection to start.
3. **While TBAi is already open:** handle `session.moved` as a location-change signal. Re-fetch the session metadata through the backend, update `opencode_directory`, and rebuild/reconnect the OpenCode V2 client/controller so the event stream is subscribed using the new backend-resolved directory. Preserve the same OpenCode session ID and the existing conversation/thread identity.
4. **After a move while TBAi is closed:** the next bootstrap performs the same `session.get` reconciliation before connecting.

At commit `4a2727a`, TBAi's `v2Events.ts` includes `session.moved` in its public-event allowlist, but `applyKnownEvent()` has no `session.moved` case and its default branch returns the current state unchanged. The plan must therefore add an explicit controller/runtime reconciliation path; merely adding the event to the allowlist is not enough.

### What happens when the directory is moved outside OpenCode

A filesystem rename/delete by Explorer, Finder, `mv`, or another tool is **not the same as OpenCode's session.move operation**. OpenCode still has the old path. TBAi must not guess the new path, silently fall back to its hidden chat workspace, or pretend the original session has moved. Surface a clear unavailable/location error and require the user to move/relink the session using an OpenCode-supported operation to a valid destination. A missing imported session must also remain missing; do not create a new session automatically.

### Local versus adopted paths

- **Managed/local service:** matching a registered TBAi project folder is allowed only when the same local directory is verified.
- **Adopted/remote service:** always use a simple TBAi conversation workspace. The remote `location.directory` is an opaque path owned by that OpenCode service. Preserve it exactly; never normalize it with local OS path utilities, call local `stat()`, or compare it with local TBAi folders.
- A change to the remote path must be obtained from the adopted OpenCode service, not inferred locally.

### Call-site audit

Every OpenCode session operation must use the appropriate current-directory resolver or session metadata reconciliation:

- `src/services/opencode/proxyAuthorization.ts`: owner-scoped conversation lookup; inject the currently confirmed OpenCode directory for location-scoped upstream requests.
- `src/services/opencode/sessions.ts`: fetch session metadata, reconcile current directory, and use the same service owner/transport for session resume, activity, interrupt, and termination.
- `src/services/opencode/conversationDeletion.ts`: journal the current service directory and owner observed for that imported session; never resolve an adopted path as a local TBAi workspace.
- `src/routes/opencode.ts`: strip caller-supplied directory parameters and inject only the backend-authorized directory.
- Any session move event handler: reconcile the session directory and reconnect the existing runtime without changing the session ID.

Do not globally replace `resolveConversationWorkspace()`: TBAi's local conversation workspace and the OpenCode service's working directory are separate concepts.

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

### 2.4 Service Ownership Consistency and SQLite Deduplication

Existing owner formats:

- Managed: `managed` (legacy `NULL` or empty values on bound rows also mean managed).
- Adopted: `adopted:<canonical-origin>`.

A session identity is `(normalized service owner, OpenCode session ID)`. The same ID on two different OpenCode services represents two different sessions.

### Migration requirements

Before creating the unique index:

1. Audit all bound rows using `COALESCE(NULLIF(opencode_service_owner, ''), 'managed')`.
2. If duplicates exist for the same normalized owner/session pair, **abort the migration** and report the conflicting conversation IDs. Do not delete conversations, select a winner, or rewrite bindings automatically.
3. Only after the duplicate audit passes, backfill legacy bound `NULL`/empty owners to `managed`.
4. Create the unique partial index on `(opencode_service_owner, opencode_session_id)` where `opencode_session_id IS NOT NULL`.
5. Keep the row mapper and every query consistent with the legacy managed interpretation.

### Owner-aware lookup

Add an owner-aware lookup such as:

```ts
conversationService.findByOpenCodeSession(
  serviceOwner: string,
  sessionId: string,
): Promise<Conversation | null>
```

Replace every use of the unscoped `findByOpenCodeSessionId(sessionId)` for authorization or association. Search the entire repository for callers, including proxy authorization and tests.

### Proxy target identity: do not assume `target.owner` exists

At the reviewed GitHub commit `4a2727a`, `OpenCodeRuntimeTarget` in `src/services/opencode/runtimeTarget.ts` does **not** expose a `target.owner` property. The owner helpers already live in `src/services/opencode/historyBoundary.ts` (`historyOwnerFromTarget()` and `serializeHistoryOwner()`). The implementation plan must derive the persisted owner from the exact captured connection target using these existing helpers, or deliberately extend the captured-target type to carry the derived owner.

Do not independently resolve the target a second time after capturing its transport. The owner identity and transport must come from the same immutable target snapshot. Inspect the 17 existing local hardening modifications first; those uncommitted changes may already add target identity fields that are not visible on GitHub.

### Authorization

In `src/routes/opencode.ts`, pass the captured target's verified owner into `authorizeOpenCodeProxyRequest`. Authorization must resolve `(owner, sessionId)` and compare it to the conversation's stored owner before injecting the directory. A managed session must never be authorized against an adopted service, or vice versa.

### 2.5 Freshness Guard: `sourceRef`

`sourceRef` is a target-freshness/correlation guard, not an authorization token or secret.

Its payload may carry the currently captured target identity (mode, target ID/instance identity, canonical origin, and shutdown/connection epoch as appropriate). Base64-encoded JSON is not cryptographic authorization.

When `POST /api/opencode/import` is received:

1. Capture the active OpenCode runtime target and transport exactly once.
2. Verify the supplied source reference against that captured target.
3. Reject stale target identity, mode, origin, or epoch with HTTP 409.
4. Use the same captured target/transport for `session.get`, owner determination, and import.
5. Obtain session ID, title, model, agent, and directory from the OpenCode server response. Never trust browser-supplied directory or service owner values.

At commit `4a2727a`, the committed runtime-target interface does not contain all the identity fields named by the proposal. Check the local uncommitted hardening changes before deciding which target ID/epoch fields already exist. Add only the missing pieces; do not duplicate the identity mechanism.

### 2.6 Concurrent Import Safety and Workspace Cleanup

`conversationService.create()` creates a hidden chat workspace before inserting the conversation row. An existence check alone does not prevent a race.

Required behavior:

- Two concurrent imports of the same `(owner, sessionId)` produce one conversation.
- On a unique-index conflict, identify and return the already-created conversation ID with the documented 409 response.
- Clean up the workspace/folder created by the losing attempt.
- Apply cleanup to **any** conversation insertion failure after workspace creation, not only `SQLITE_CONSTRAINT_UNIQUE`.
- Cleanup must target only resources created by that exact attempt. Never remove the winner's workspace or an existing registered project.
- If possible within the current storage architecture, avoid creating the workspace until the unique association is safely claimed. Do not introduce a new transaction framework without evidence it is necessary.

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

Verified against the OpenCode 2.2.0 protocol/client source and the pinned dependency at the reviewed TBAi commit. Root and web manifests both pin `@opencode/client` to `2.2.0` at commit `4a2727a`.

**Version-policy caveat:** the committed TBAi source at `4a2727a` still documents `2.0.15` as the compatibility evidence floor, and its adopted-version classifier can allow a stable version below that floor if capability probes pass. The 17 uncommitted local hardening changes may already correct this. The implementation agent must inspect the actual local files and prove that both managed startup and adopted-service registration reject every version below `2.2.0` and every prerelease. Do not treat the dependency pin alone as enforcement.

- `client.session.list`: GET `/api/session` with `{ limit, cursor, search, parentID, archived, directory }`.

- `client.session.get`: GET `/api/session/:sessionID` returning `{ data: SessionInfo }`.

- `client.message.list`: GET `/api/session/:sessionID/message` with `{ limit, order, cursor, type }`.

- Version constraint: OpenCode 2.2.0 and newer stable versions only. Prereleases and versions < 2.2.0 are rejected at the service compatibility boundary.

---

### 3.4 OpenCode 2.2.0 directory-move contract

Verified in the OpenCode `v2.2.0` source:

- `POST /api/session/:sessionID/move` is the `session.move` API operation.
- Its public payload carries a destination directory and optional delivery mode.
- `SessionMove.resolveDestination()` validates that the destination exists and is a directory, then resolves the destination project.
- When the session is active, the move is admitted and applied at the requested safe delivery boundary. If the source is unavailable and the session is idle, OpenCode can apply it directly.
- `SessionProjector` handles `SessionEvent.Moved` by updating the stored session directory and path/project/workspace metadata.
- OpenCode's event bus routes `session.moved` to both the previous and destination locations, then routes later session events to the new location.

Relevant OpenCode source references:

- `packages/protocol/src/groups/session.ts` — `session.move` endpoint and description.
- `packages/core/src/session/move.ts` — destination validation and safe-boundary move behavior.
- `packages/core/src/session/projector.ts` — updates persisted session directory after `session.moved`.
- `packages/core/src/bus.ts` — routes a move event to both old and new locations.
- `packages/server/src/middleware/session-location.ts` — session-scoped operations resolve the session record and run under that session's current location.

TBAi does not need to add a Move Session UI as part of this import feature. It does need to remain attached to the same session and follow a move performed through another OpenCode client.

**Location-scope verification:** OpenCode's internal `Location.Ref` can include an optional `workspaceID`, while the public session location omits it and TBAi's current proxy scope is directory-based. Add an integration test for any importable session shape that carries a non-null workspace identity. If directory-only event subscription cannot receive its events, resolve that using trusted backend/OpenCode data; do not ask the browser to supply a workspace ID. Do not claim this edge case is supported until it is tested.

## 4. Implementation Specifications

### 4.1 Schema Migration (`src/db/index.ts`)

The migration must be fail-safe. Add the two columns, then audit normalized owner/session duplicates **before** backfilling or creating the unique index. If duplicates exist, abort startup/migration with the conflicting conversation IDs. Do not resolve them automatically.

```ts
// 1. Add metadata columns.
addColumnIfNotExists("conversations", "opencode_directory", "TEXT");
addColumnIfNotExists("conversations", "opencode_imported", "INTEGER NOT NULL DEFAULT 0");

// 2. Preflight: collect every duplicate normalized owner/session identity.
const duplicates = sqlite.query(`
  SELECT
    COALESCE(NULLIF(opencode_service_owner, ''), 'managed') AS owner_key,
    opencode_session_id,
    GROUP_CONCAT(id) AS conversation_ids,
    COUNT(*) AS duplicate_count
  FROM conversations
  WHERE opencode_session_id IS NOT NULL
  GROUP BY COALESCE(NULLIF(opencode_service_owner, ''), 'managed'), opencode_session_id
  HAVING COUNT(*) > 1
`).all();

if (duplicates.length > 0) {
  // Include the conflicting conversation IDs in the local migration diagnostic.
  const conflictingConversationIds = duplicates
    .map((row) => row.conversation_ids)
    .filter(Boolean)
    .join("; ");
  throw new Error(
    `Duplicate OpenCode owner/session bindings require manual resolution. Conversation IDs: ${conflictingConversationIds}`,
  );
}

// 3. Normalize only legacy bound managed rows after the audit passes.
sqlite.run(`
  UPDATE conversations
  SET opencode_service_owner = 'managed'
  WHERE opencode_session_id IS NOT NULL
    AND (opencode_service_owner IS NULL OR opencode_service_owner = '')
`);

// 4. Enforce one conversation per canonical owner/session pair.
sqlite.run(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_opencode_owner_session
  ON conversations(opencode_service_owner, opencode_session_id)
  WHERE opencode_session_id IS NOT NULL
`);
```

The actual implementation must use the repository's migration/error-reporting conventions. Include the conflict IDs in a safe diagnostic; never silently delete, merge, or rebind a conversation to make the index build succeed.

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

The service may expose:

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

### Import execution flow

1. **Capture and validate target:** capture the active runtime target/transport once; verify `sourceRef` against it. Reject stale input with 409.
2. **Retrieve metadata:** call official `client.session.get({ sessionID })` through that captured target.
3. **Verify eligibility:** reject archived sessions and child sessions (`parentID` present).
4. **Deduplicate:** use `findByOpenCodeSession(serviceOwner, sessionId)`.
5. **Choose TBAi workspace:** only managed/local sessions may match a registered TBAi project folder after exact local-directory verification. Adopted sessions always receive a simple TBAi chat workspace.
6. **Create the association:** save engine `opencode`, `opencodeSessionId`, normalized `opencodeServiceOwner`, current `opencodeDirectory`, `opencodeImported: true`, title, agent, and model metadata. Do not copy transcript messages.
7. **Handle failure/race:** clean up only workspace resources created by this attempt for any failed insert. On uniqueness conflict, return the winning conversation ID via 409.
8. **Return:** `{ conversationId }`. When opened, bootstrap re-fetches `session.get` from the same owner and reconciles the current directory before mounting the V2 runtime.

### Existing conversation bootstrap/reconciliation

For an imported conversation, the existing bootstrap/resume endpoint must not treat the persisted directory as more authoritative than OpenCode. It must:

1. Resolve the conversation's service owner and capture the correct service transport.
2. Fetch the existing session by ID. A missing imported session raises `OpenCodeImportedSessionMissingError`; it is never silently recreated.
3. Compare the server-returned `session.location.directory` with `conversation.opencodeDirectory`.
4. Persist the server-returned current directory if it changed.
5. Return the same session ID and the current directory so the frontend starts its event subscription with the right backend scope.

The regular TBAi-created session path keeps its existing creation semantics. The imported-session missing guard must not accidentally change ordinary new-session behavior.

### 4.5 REST API Routes

Provide:

- `GET /api/opencode/importable` — query/limit/scanLimit and paginated discovery.
- `POST /api/opencode/import` — accepts only `{ sessionId, sourceRef }`.
- An internal/backend-only directory reconciliation path, or reuse the existing session bootstrap endpoint, to re-fetch `session.get`, update `opencode_directory`, and return the authoritative current directory after an external `session.moved` event.

**Route ordering is mandatory.** The current `src/routes/opencode.ts` registers an `app.all("*", ...)` reverse-proxy catch-all. Register the new import endpoints in the existing OpenCode router **before** that catch-all. A separate import service module is fine, but do not mount import routes after the catch-all or let `/api/opencode/importable` and `/api/opencode/import` fall through to the proxy allowlist.

The browser request body must not include a directory or owner. The backend resolves both from the captured target and the server-reported session metadata.

Responses:

- `201`: `{ conversationId }`
- `404`: session not found on the owning OpenCode service
- `409`: already imported or stale source reference
- `422`: invalid input
- `502/503`: upstream unavailable or unsupported/incompatible version
- A distinct, safe unavailable-location error when the session record exists but its directory cannot be used. Do not translate this into automatic recreation.

### 4.6 Frontend Sidebar Integration

- Component: `OpenCodeImportInline.tsx` mounted in the existing OpenCode sidebar section.
- Control: “Import from OpenCode”.
- On click: fetch `GET /api/opencode/importable` on demand using temporary component state. Do not introduce another global Zustand store for this.
- Display session title, relative activity time, and directory label.
- On selection: call `POST /api/opencode/import`.
- On `201`: use `openAgent(conversationId)` from the existing `chatTabs` flow to open Code mode.
- On `409`: show “Already imported” with an action to open the existing conversation.
- Do not import `@opencode/client` into the web bundle just for discovery/import. OpenCode SDK operations stay behind the backend and the existing V2 client boundary.

The directory displayed in the frontend is informational. The browser continues sending the existing session selector only; it must never become the authority for a directory or service owner.

### 4.7 Existing TBAi history and TanStack responsibilities

Do not add TanStack Query/React Query for this feature.

The reviewed TBAi code uses:

- `OpenCodeView.tsx` and `sessionBootstrap.ts` to bootstrap the existing conversation/session.
- `useOpenCodeRuntime.ts` and `v2ThreadController.ts` for runtime setup, in-memory thread state, hydration, event reconciliation, reconnect, and refresh.
- `sync/sessionMessageLoader.ts` and `v2History.ts` to retrieve native OpenCode history through the official `client.message.list()` reader, paginate, deduplicate by native message ID, and project it.
- `v2Client.ts` for the official SDK boundary and session-scoped proxy client.
- `VirtualizedTranscript.tsx` (`@tanstack/react-virtual`) and `ChatWindow.tsx` for rendering and scrolling.

**TanStack Virtual is a renderer, not the history data/cache layer.** The reviewed root and web manifests contain `@tanstack/react-virtual`, but not `@tanstack/react-query`; the OpenCode history path does not use `useQuery` or `useInfiniteQuery`. History is held in the existing controller/reducer state. `loadV2History()` fetches all pages during hydration/refresh (page size 100); virtualization limits mounted DOM rows, not the amount of history fetched or retained in memory.

The import path must enter through the existing `OpenCodeView`/V2 controller flow. Do not use `messageService.upsertStored()`, the Direct-chat history window, or a new query cache to create an imported transcript. `threadHistoryAdapter.ts` deliberately skips SQLite message writes for OpenCode conversations.

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

Additional required test cases:

| # | Test Scenario | Target Test Area | Description |
|---|---------------|------------------|-------------|
| 21 | Managed session directory remains valid | Backend integration | Import a managed session outside the registered TBAi folders and prove history load and a new prompt use its OpenCode directory, not the hidden TBAi workspace. |
| 22 | Adopted remote directory remains opaque | Backend integration | Import an adopted session with a remote path; prove no local normalization/stat/folder matching occurs and all operations remain on that owner/transport. |
| 23 | Move while TBAi is closed | Backend + frontend integration | Move the session using OpenCode 2.2.0 `session.move`, then open TBAi. Bootstrap must read the current `session.location.directory`, update `opencode_directory`, connect the event stream at the new location, load the same transcript, and send a prompt on the same session ID. |
| 24 | Move while TBAi is open | Backend + V2 controller integration | Move the session from another OpenCode client. TBAi receives `session.moved` on the old stream, re-fetches the authoritative session record, updates the stored directory, reconnects the event stream, keeps the same conversation/session ID, and continues sending prompts. |
| 25 | Active-session move boundary | OpenCode-backed integration | When the session is executing, verify that OpenCode applies the move at its safe delivery boundary and TBAi follows the resulting event rather than changing directory prematurely. |
| 26 | Filesystem rename without session.move | Integration | Rename/delete the original directory outside OpenCode. TBAi must not guess the replacement path, fall back to the hidden chat folder, or silently recreate the imported session. Show a clear location-unavailable error. |
| 27 | Invalid move destination | OpenCode-backed integration | A move to a missing/non-directory destination is rejected; TBAi retains the previous confirmed location and session association. |
| 28 | `session.moved` controller handling | Frontend unit/integration | Pin that the currently allowlisted `session.moved` event triggers location reconciliation/reconnect. A no-op reducer default is not sufficient. |
| 29 | Import routes precede proxy catch-all | Route integration | Assert both import endpoints reach their own handlers and are not forwarded to the OpenCode proxy. |
| 30 | Workspace-scoped event routing | Integration | Verify directory-only proxy scope can receive session events for every supported session location shape. If a non-null workspace identity requires additional trusted scope, prove how it is derived server-side. |
| 31 | No React Query added | Build/dependency check | Verify the feature introduces no `@tanstack/react-query`, query client, duplicate history cache, or second history owner. |

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

---

## 8. Directory Behavior — Plain-English Contract and Verified Findings

This section is authoritative if any earlier wording sounds as though the import-time directory can never change.

### What works

An OpenCode session is not just a transcript. It has a working directory on the OpenCode machine. When TBAi imports it, TBAi stores the session ID and the current OpenCode directory, then opens the same session through the existing V2 runtime. If that directory is still available to the same OpenCode service, the session can load its history and accept new prompts.

If the user changes the session's directory through OpenCode's own **Move Session** operation, OpenCode updates the session record. TBAi must notice that update, refresh its stored directory, and reconnect its event stream. The conversation and session IDs do not change; the transcript is not copied or reset.

### What does not work automatically

Renaming or deleting the project folder directly in the operating system does not tell OpenCode that the session moved. OpenCode still has the old path. TBAi cannot safely infer the intended replacement folder. The user must move the session through OpenCode to a destination that exists on the machine running that OpenCode service.

For an adopted service, the destination directory must exist on the adopted machine, not on the machine running TBAi.

### Source audit facts

- TBAi `src/services/opencode/sessions.ts` currently resolves session setup through `resolveConversationWorkspace()`; the import feature must introduce the OpenCode-directory seam without conflating the two workspace types.
- TBAi `src/services/opencode/proxyAuthorization.ts` currently resolves a session ID using the unscoped `findByOpenCodeSessionId()` and obtains its directory from the TBAi workspace. Both assumptions must change for imported/adopted sessions.
- TBAi `src/routes/opencode.ts` resolves the active target before its reverse-proxy catch-all; authorization currently does not receive the target owner.
- TBAi `web/src/features/opencode/v2Client.ts` sends the `x-tbai-session` selector. It deliberately does not send a browser-chosen directory; the backend injects the trusted scope.
- TBAi `web/src/features/opencode/OpenCodeView.tsx` receives the directory from session bootstrap, and `useOpenCodeRuntime.ts` rebuilds the client/controller when its event-directory input changes.
- TBAi `web/src/features/opencode/v2Events.ts` currently lists `session.moved` as a permitted public event but has no reducer branch for it; its default branch returns the current state unchanged. Add location reconciliation at the controller/runtime boundary.
- OpenCode `v2.2.0` `session.move` validates the destination directory and projects the new session directory after a `session.moved` event. OpenCode's bus routes that event to old and new locations.

## 9. Implementation Guardrails From the Audit

1. Preserve the existing 17 local uncommitted hardening changes. Inspect them locally before implementation; they are not visible in GitHub commit `4a2727a`.
2. Do not use `target.owner` unless the current local `OpenCodeRuntimeTarget` type actually exposes it. The reviewed committed type does not. Reuse `historyOwnerFromTarget()` / `serializeHistoryOwner()` or extend the captured-target type deliberately.
3. Register import routes before `app.all("*", ...)` in the existing OpenCode router.
4. Treat `opencode_directory` as the last server-confirmed current directory. Reconcile it from `session.get` on every bootstrap and after `session.moved`.
5. No local `stat()` or path normalization for adopted remote directories.
6. A move through `session.move` is supported by OpenCode 2.2.0; a raw filesystem rename is not a reliable session relocation signal.
7. Do not add React Query. Continue using the native V2 history controller and TanStack Virtual for rendering.
8. Before adding new test files, inspect the actual local test layout. The paths in this plan are proposed targets, not a claim that every file already exists.
9. Keep the 2.2.0+ stable-only version policy consistent in both managed and adopted service paths. The committed GitHub baseline and local uncommitted hardening state differ; local verification is required.
10. Do not implement, commit, or push until the user explicitly authorizes implementation under `docs/PROJECT_MANAGER_PROTOCOL.md`.
