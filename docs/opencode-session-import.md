# OpenCode Session Import Architecture & User Guide

## Overview

The OpenCode Session Import feature allows TBAi users to discover existing OpenCode sessions created outside TBAi (e.g. via the OpenCode CLI, Web UI, or external agents) and import them as first-class TBAi conversations.

Imported conversations operate on **live native OpenCode history**:
- Messages and tool executions are **not** duplicated or copied into TBAi's SQLite database.
- The conversation history is loaded dynamically on-demand from the OpenCode server through TBAi's authenticated reverse proxy.
- State modifications, message sending, and tool interactions execute natively on OpenCode.

---

## 1. User Guide: Importing Sessions

### Discovery & Import Flow
1. **Open Import Dialog**: In the TBAi sidebar under the OpenCode section, click the **"Import Session"** action (or the import icon next to "New Session").
2. **Browse Importable Sessions**:
   - The modal displays all available sessions on the active OpenCode runtime target.
   - For each session, it displays the session title, working directory, and last activity timestamp.
   - Previously imported sessions are filtered out automatically.
3. **Import**:
   - Click **"Import"** on any session candidate.
   - TBAi creates a local conversation linked to the authoritative OpenCode session ID, service owner, and directory.
   - The UI immediately navigates to the imported conversation.
4. **Handling Conflicts & Stale State**:
   - **Duplicate Import**: If another tab or user already imported the session, TBAi surfaces a 409 conflict and offers a direct link to navigate to the existing conversation.
   - **Stale Target/Source**: If the active OpenCode connection target changed (e.g. switched from managed to adopted), TBAi informs the user and enables a refresh.
   - **Missing Session**: If the session was deleted externally prior to import, a 404 message is shown with a refresh prompt.

---

## 2. Architecture & Provenance

### Database Schema & Identity
The conversations table schema is extended with:
- `opencode_directory` (`TEXT`): The authoritative project directory where the OpenCode session operates.
- `opencode_imported` (`BOOLEAN`): Set to `1` for imported sessions, `0` or `NULL` for TBAi-created sessions.
- `opencode_service_owner` (`TEXT`): Canonical owner identity:
  - `"managed"` for TBAi-managed local daemon instances.
  - `"adopted:<canonical_origin>"` (e.g. `"adopted:http://127.0.0.1:51234"`) for external/adopted servers.

A partial unique index enforces uniqueness across non-null session pointers:
```sql
CREATE UNIQUE INDEX idx_conversations_opencode_owner_session
ON conversations(opencode_service_owner, opencode_session_id)
WHERE opencode_session_id IS NOT NULL;
```
This guarantees:
1. No duplicate imports under the same service owner.
2. Identical session IDs across distinct OpenCode service owners remain strictly isolated without namespace collision.

### Workspace & Directory Handling
- **TBAi Native Sessions**: May fall back to the hidden default TBAi workspace directory if unspecified.
- **Imported Sessions**: Resolve `opencode_directory` directly. If missing, TBAi queries OpenCode's authoritative `session.get` endpoint. If unavailable, TBAi raises `OpenCodeDirectoryUnavailableError` rather than silently substituting the hidden workspace.
- **Adopted Service Directories**: Treated strictly as opaque strings without local path normalization or validation (supporting remote Linux paths on Windows hosts).

---

## 3. Directory-Move Reconciliation

When an OpenCode session moves to a new working directory:
1. **Live Move (`session.moved` Event)**:
   - The frontend event stream listener detects `session.moved` matching the active session ID.
   - It invokes `/api/opencode/reconcile-move/:id` on the backend.
   - The backend validates the move against OpenCode's `session.get(id)` and updates `opencode_directory` in SQLite.
   - The frontend controller updates its subscribed directory and reconnects the SSE event stream without dropping state or re-creating the session.
2. **Offline Move (While TBAi Closed)**:
   - When the imported conversation is opened, `ensureOpenCodeSession` checks the session metadata.
   - If the remote session directory differs from `opencode_directory`, it reconciles SQLite before streaming begins.
3. **Idempotence & Safety**:
   - Out-of-order, duplicate, or stale move events for unrelated sessions are safely ignored.

---

## 4. Missing Session & Fail-Closed Protection

- **Ordinary TBAi Conversations**: If an OpenCode session returns 404, TBAi logs a stale-session warning and re-creates a new OpenCode session under the existing conversation.
- **Imported Conversations**: If OpenCode returns 404 for an imported session, TBAi **never** calls `session.create()`.
  - Doing so would destroy provenance and lose access to the user's external session.
  - Instead, TBAi raises `OpenCodeImportedSessionMissingError`.
  - The UI displays an actionable location/session error informing the user that the external session is unavailable.

---

## 5. Security & Reverse Proxy Authorization

All frontend OpenCode API requests pass through the authenticated reverse proxy (`/api/opencode/*`):
1. The proxy inspects the requested OpenCode session ID.
2. It performs an owner-scoped database lookup (`findByOpenCodeSession(target.serviceOwner, sessionId)`).
3. Requests to sessions that belong to a different service owner or do not exist are rejected with HTTP 403 / 404.
4. The client browser never specifies or chooses the service owner or directory; these are determined securely server-side.

---

## 6. Limitations & Troubleshooting

1. **Service Target Switching**:
   - Conversations imported from an adopted server remain bound to that server's canonical owner identity (`adopted:<origin>`).
   - If the user disconnects the adopted server or reverts to managed mode, attempting to open the imported conversation will fail closed with an explicit error rather than pointing to the managed instance.
2. **Server Deletions**:
   - If an imported session is deleted externally on the OpenCode server, TBAi marks the session as missing. To resume work, the user can create a new native TBAi session in the same directory.
3. **OpenCode Versions**:
   - Supported on OpenCode version 2.2.0 and newer stable releases.
