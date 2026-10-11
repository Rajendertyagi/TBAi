# Durable Runs & Auto-Reconnection Plan: Session Persistence, Robustness, and Durability

**Date:** 2026-10-10  
**Status:** Approved design; pending implementation  
**Scope:** Direct Chat session durability, unassisted background run completion, and client mount auto-reconnection.

---

## 1. Context and Problem Statement

TBAi is a local-first, low-ceremony AI chat application. It does not use enterprise distributed infrastructure (no Redis, no Kafka, no microservices). However, real-world desktop and local usage requires two critical durability invariants:

1. **Unattended Execution ("Fire and Forget")**:
   When a user sends a prompt and leaves (closing the tab, locking the laptop, or losing connection), the agent/LLM must run to completion on the backend server. The completed turn must not be discarded merely because the browser was not attached when the last token arrived.
2. **Auto-Reconnection Without Loss ("Return and See")**:
   When the user reopens the app or switches back to an in-flight conversation, the UI should seamlessly reconnect to any running stream, or immediately display the finished turn from SQLite without requiring manual user intervention or blank "Retry" states.

---

## 2. Reference Architectures Studied

### Cline (VS Code Extension)
- **Process Decoupling**: Extension Host owns the execution loop; the Webview panel only renders state. The Webview closing never cancels in-flight work.
- **Persistence Boundary**: History is persisted atomically per turn via file writes to disk (`tasks/<task-id>/api_conversation_history.json` and `ui_messages.json`).
- **Recovery**: On panel reload or restart, state is read directly from disk; missing indices are reconstructed automatically from task folders.

### OpenChamber (`D:\Temp\openchamber`)
- **Backend-Authoritative Model**: The `opencode serve` daemon owns execution and persistence (`~/.opencode/`). OpenChamber frontend stores zero raw message transcripts in its own database.
- **Cursor-Based Windowing & Prefetching** (`session-message-loader.ts`): Reconnection queries the latest message page with chronological insertion (`mergeOptimisticPage`) and picks up streaming deltas.
- **RFC 7386 JSON Merge Patch** (`session-metadata-store.js`): State patches update without wiping concurrent background edits.

---

## 3. Audited Contracts & Installed Versions

- **`@assistant-ui/react` & `@assistant-ui/ai-sdk`**:
  - `ThreadHistoryAdapter`: Normal path where the browser saves thread history via `POST /api/conversations/:id/messages`.
  - `ResumableClientStorage` (`resumable.d.ts`): Supports `getStreamId`, `setStreamId`, `clear`, and `subscribe(listener, threadId)`. Calling `setStreamId()` invokes registered listeners, which automatically triggers `AssistantChatTransport`'s reconnection pipeline.
- **`assistant-stream`**:
  - `toUIMessageStream.onEnd`: Emits `{ isAborted, responseMessage, outcome, finishReason }`.
  - Server-side SQLite resumable byte store records chunks in `chat_stream_chunks`.
- **`@tanstack/virtual-core` (3.17.11) & `VirtualizedTranscript.tsx`**:
  - Uses `anchorTo: 'end'`, `followOnAppend`, and `measureElement`.
  - When reconnected streams append chunks after mounting, TanStack Virtual preserves scroll position if scrolled up, or tracks the bottom if at the tail.
- **React 19 (`@types/react` ^19.2.18)**:
  - Strict effect cleanup: subscriptions on `ResumableClientStorage` must be created and detached cleanly inside `useEffect`.

---

## 4. The Two-Phase Architecture Plan

### Phase 1: Server-Authoritative Run History (The Backend Guarantee)

**Problem on Disk:**
In `src/routes/chat.ts` (line 1539):
```typescript
if (!wasDetached || !didSettle || settlement !== "completed") return;
await finalizeDetachedRunHistory(chatHistoryFinalizerDeps, { ... });
```
The server only saves the message row to SQLite if `wasDetached` is true. If the browser is still connected when the stream ends, the server skips saving, relying on the browser's subsequent HTTP POST. If the user closes the app within 200ms of generation finishing, the message is permanently lost.

**Solution:**
1. In `src/routes/chat.ts`, remove the `!wasDetached` restriction so `finalizeDetachedRunHistory` executes whenever `didSettle && settlement === "completed"`.
2. `finalizeDetachedRunHistory` in `src/services/chat-streams/historyFinalizer.ts` already checks `deps.messageExists(conversationId, message.id)` and uses `upsertStored` (`ON CONFLICT(id) DO UPDATE`). If the client also sends a save later, it is an idempotent no-op.
3. The server becomes the primary authority for saving completed assistant turns into `data/chat.db`.

### Phase 2: Client Auto-Reconnection on Thread Mount

**Problem on Disk:**
`createDirectResumableStorage` uses `sessionStorage`. Closing the browser window clears the key, so reopening the app does not know a stream is still running on the server.

**Solution:**
1. Utilize the existing backend endpoint `GET /api/chat/stream-status?threadId=:threadId`.
2. On conversation tab mount (in `web/src/features/chat/state/resumable-stream.ts` / `web/src/runtime.ts`):
   - Check if `readDirectResumableStreamId(threadId)` is missing.
   - If missing, check `GET /api/chat/stream-status?threadId=${threadId}`.
   - If the status is `"streaming"`, invoke `storage.setStreamId(streamId, threadId)`.
   - The native `subscribe()` callback in `AssistantChatTransport` notifies the transport, which immediately connects to `/api/chat/resume/:streamId` and continues streaming into the UI.
   - If the status is `"completed"`, Phase 1 ensures the completed message is already waiting in SQLite; `ThreadHistoryAdapter` loads and displays it immediately.
3. Clean up the stream pointer once terminal markers arrive (`finish`, `abort`, `error`).

---

## 5. Non-Functional & Invariant Protections

- **No New Dependencies**: Zero additional libraries or external infrastructure.
- **Provider-Agnostic**: Direct chat provider abstraction and AI SDK contracts remain untouched.
- **OpenCode Boundary**: Coding agent execution continues to run through the managed `opencode serve` process; Direct chat durability improvements do not alter OpenCode session isolation.
- **Input Durability**: Composer drafts continue to be guarded by `localStorage` via `web/src/features/chat/state/composerDraft.ts`.

