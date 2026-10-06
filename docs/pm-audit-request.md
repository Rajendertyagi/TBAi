# PM Infrastructure Audit Request

**Created by: AI Project Manager**
**Purpose: Understand what infrastructure EXISTS today across the full application.**

This is NOT a bug hunt. Do NOT suggest fixes.
Report what EXISTS. If something does not exist, say "Does not exist."
Facts and code only.

---

## 1. Session Lifecycle

A session = from when the user opens the app to when they close it.

- Is there a defined "session start" event anywhere in the code? Show file + line.
- Is there a defined "session end" or cleanup event? Show file + line.
- When the app closes (Tauri window close), what cleanup runs on the backend? Show the shutdown sequence code.
- When the app closes, what cleanup runs on the frontend? Show any `beforeunload` or Tauri close handlers.
- Is there a concept of "session" in the DB? Yes/No.

---

## 2. Memory Management (Frontend)

- List every Zustand store: file name, what it stores, does it have a max size or cleanup boundary.
- List every `useEffect` that sets up a listener, timer, or subscription — and whether it has a cleanup return. File + line for any that do NOT have cleanup.
- List every global variable or module-level array/map/set in `web/src/` that grows over time.
- Does the frontend have any concept of "free memory when idle"? Yes/No.

---

## 3. Memory Management (Backend)

- List every in-memory data structure in `src/` that grows over time (arrays, maps, sets, queues, caches).
- For each: file + variable name + what adds to it + what removes from it (if anything).
- Does the backend have any concept of "idle cleanup" or "memory ceiling"? Yes/No.
- What is the in-memory log ring buffer size? What happens when it's full?

---

## 4. Resource Lifecycle — Streams & Connections

- List every SSE stream the backend opens. For each: file, what opens it, what closes it.
- List every SSE stream the frontend opens. For each: file, what opens it, what closes it.
- List every fetch/HTTP connection that stays open (not one-shot). File + what manages its lifecycle.
- Does any stream have a timeout? Show the timeout code or say "No timeout."

---

## 5. Resource Lifecycle — Timers & Background Jobs

- List every `setInterval` in the codebase: file + line + what it does + what stops it.
- List every `setTimeout` that is NOT a one-shot fire-and-forget: file + line + what it does.
- List every `Bun.cron` registration: file + line + what it does + what stops it.
- When a job/timer errors, what happens? Is it restarted, stopped, or left in an unknown state?

---

## 6. Resource Lifecycle — MCP Connections

- How many MCP connections can be open simultaneously? Is there a limit? Show the code.
- What is the full lifecycle of one MCP connection: open → error → reconnect → give up. Show each step with file + line.
- When the app shuts down, are MCP connections explicitly closed? Show the shutdown code.
- After MAX_RECONNECT_ATTEMPTS is reached, is the connection object released from memory? Show code.

---

## 7. Context Budget (Direct Chat)

- Where is the context window limit for a model stored? (DB column? Config file? Hardcoded?)
- Show the exact code that reads the context limit before building a request.
- Is there a check that the assembled messages fit within the limit BEFORE sending? Show it or say "Does not exist."
- What is the exact fallback constant used when no limit is known? Show the value.
- How is token count estimated? (Character count? Tiktoken? AI SDK utility? Something else?) Show the code.

---

## 8. Context Budget (OpenCode / Code Mode)

- Where does TBAi read the context limit for the active OpenCode model?
- Show the exact file + function + line.
- Does TBAi know when OpenCode is near its context limit? Yes/No + show code.
- Who decides when to compact in OpenCode mode — TBAi or OpenCode itself?
- Can TBAi trigger a manual compact? Show the API call or say "Cannot."

---

## 9. Compaction

- List every place in the codebase where compaction is triggered. File + function + line + what triggers it.
- For each compaction: is it wrapped in a DB transaction? Yes/No + show code.
- What DB tables does compaction touch? List all of them.
- What happens to the in-memory runtime state (assistant-ui) when compaction happens? Is it updated, reloaded, or left stale?
- Is there a test for compaction correctness? Show the test file name.

---

## 10. Hono Server Health

- Does the Hono server have a health check endpoint? Show it or say "Does not exist."
- Does the server track how many concurrent requests are active? Yes/No.
- Is there a request timeout? Show it or say "Does not exist."
- Is there a maximum request body size limit? Show it or say "Does not exist."
- What happens if a route handler throws an uncaught error? Show the global error handler or say "Does not exist."

---

## 11. Bun Runtime

- What is the Bun server configuration? Show `src/index.ts` or wherever `Bun.serve` / Hono server is started.
- Is there a maximum number of concurrent connections configured? Show it or say "Not configured."
- Is there memory limit configuration for Bun? Show it or say "Not configured."
- What handles `SIGTERM` and `SIGINT`? Show the signal handler code.
- What handles `uncaughtException` and `unhandledRejection`? Show the code or say "Does not exist."

---

## 12. Database

- Is there a connection pool? Or a single shared connection? Show the DB initialization code.
- Are long-running queries possible? Is there a query timeout? Show it or say "Does not exist."
- Is WAL mode enabled? Show the PRAGMA or say "Not set."
- Is there a DB size ceiling or rotation policy? Yes/No.
- What is the largest table expected to grow over time? Estimate based on schema.

---

## 13. Frontend Performance

- Does the app use React.memo, useMemo, or useCallback in high-frequency components (message list, composer, tool cards)? List which components use them.
- Is the message list virtualized (only rendering visible messages)? Yes/No + show component.
- When a new chunk arrives during streaming, how many React components re-render? Estimate based on component tree.
- Is there any debouncing on the composer input? Show it or say "No."

---

## 14. OpenCode Event Pipeline

- How does TBAi receive events from OpenCode during a response? (Polling? SSE? WebSocket? Callback?)
- Show the event handler that fires on each incoming chunk/event.
- How many functions are called per event? List the call chain.
- Is there any throttling or batching of events before they reach the UI? Yes/No + show code.

---

## 15. What Does NOT Exist (explicit check)

Answer Yes/No for each:

- A centralized service that manages context budget across all models: Yes/No
- A session start/end lifecycle with explicit resource allocation and cleanup: Yes/No
- A resource governor that limits CPU/memory per response: Yes/No
- A health monitor that tracks app state (context pressure, active connections, memory): Yes/No
- A graceful degradation policy (app slows down instead of crashing under load): Yes/No
- A circuit breaker for provider/MCP failures: Yes/No
- A backpressure mechanism on the event pipeline: Yes/No
- A maximum message history size enforced before context overflow: Yes/No

---

## Delivery Format

Return as a markdown report. One section per numbered item above.
Code snippets max 20 lines each.
If something does not exist, say exactly: **"Does not exist."**
No fixes. No suggestions. Facts only.
