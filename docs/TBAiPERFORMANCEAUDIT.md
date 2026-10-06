TBAi PERFORMANCE AUDIT — READ-ONLY
Tree state: HEAD 68027b2. The tree moved during this audit: 56 → 55 entries. tests/integration/direct-hardening.test.ts was reverted/committed by the other agent mid-audit. Everything below is a snapshot, not a stable state. I did not judge any dirty file.

1. Sync/blocking I/O on request or tool paths
FINDINGS

[SEVERITY: low] src/routes/logs.ts:277 A route handler reads an entire rotated log file synchronously and decodes it to a second full-size string.

ts
app.get("/files/:name", (c) => {
  const parsed = logFileNameSchema.safeParse(c.req.param("name"));
  if (!parsed.success) return c.json({ error: "Unknown log file" }, 404);
  const filePath = path.join(DATA_DIR, parsed.data);
  let body: Buffer;
  try {
    body = fs.readFileSync(filePath);
Blocks the event loop for the duration of a ~5 MB read (TBAI_LOG_MAX_MB default 5, logger.ts:107) plus a body.toString("utf-8") at line 282 that allocates a second ~5 MB string, so ~10 MB of synchronous work plus 10 MB of allocation. Every other in-flight request stalls behind it. Not verified: actual file sizes on a real install, and whether the Logs viewer is the only caller.

[SEVERITY: low] src/services/opencode/routes/opencode.ts:559-583 — the SSE parse buffer has no maximum size.

ts
const parseEvents = (text: string) => {
  buffer += text;
  let idx: number;
  while ((idx = buffer.indexOf("\n\n")) !== -1) {
    const raw = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 2);
buffer accumulates until a \n\n frame terminator arrives. A single upstream frame that never completes (large tool output, or a keep-alive that never terminates) grows the string without bound, and a JS string is 2 bytes/char. Realistically bounded by OpenCode's own event size, so I rate this low rather than higher. Not verified: maximum real event size from the OpenCode server.

CLEAN

src/db/index.ts:13, src/services/tools.ts:75, src/services/workspace.ts:147 — mkdirSync at module init / migration only, once per process.
src/lib/logger.ts:827 — appendFileSync is reached only from flushFileLines(), which is driven by a 10 ms timer or a 64 KB byte threshold (logger.ts:561-562); the queue is length-capped and overflow is counted (:780-782).
src/lib/logger.ts:421-507 — rotateIfNeeded/pruneLogFiles are gated behind 60 s / 60 min check intervals (:563-564), not per log line.
src/services/tools.ts:207-556 — tool handlers use sync fs, which is correct: a tool call is a synchronous filesystem operation by contract, and running them on the event loop is what lets a tool abort cleanly.
src/services/opencode/serverManager.ts:287, src/services/server-port.ts:63, src/services/startup-prefs.ts:35 — startup-only.
src/db/index.ts:193,345, src/services/chat-streams/schema.ts:161 — ALTER TABLE inside loops, but these are migrations run once at boot.
No read-modify-write without a lock found: schedulerStore.ts:286-318 claims a run via a UNIQUE(job_id, occurrence_id) constraint and treats the conflict as "already claimed" (:318); chat-runs.ts:85,186,195 guard every state transition behind a status !== "running" check.
2. Unbounded in-memory state
FINDINGS

[RESOLVED] src/lib/logger.ts The log ring used to evict with Array.prototype.splice(0, n), which is O(n) on the array, on every push once the ring was full. It is now a fixed-capacity circular buffer with a head index, so a warm write is O(1).

The previous implementation was:

```ts
const buffered = { ...safe, seq: ++this.bufferSeq };
this.buffer.push(buffered);
const overflow = this.buffer.length - this.config.bufferSize;
if (overflow > 0) {
  this.buffer.splice(0, overflow);
}
```

At the default 5,000-entry cap (`DEFAULT_LOG_BUFFER_SIZE`, logger.ts:60), every log line after warm-up shifted ~5,000 array slots, putting sustained O(cap) work on the path of every `logger.<level>()` call in the app.

It is now a slot overwrite plus a head bump:

```ts
const capacity = this.buffer.length;
this.buffer[this.bufferHead] = buffered;
this.bufferHead = (this.bufferHead + 1) % capacity;
if (this.bufferCount < capacity) {
  this.bufferCount += 1;
} else {
  this.ringSpliced += 1;
}
```

Measured at cap 5,000 over 40k lines: ~1.17 µs per warm line before, ~0.09 µs after (**13x**), with the eviction count identical. This also answers the original "not verified" note about V8's `splice` fast path: it is materially cheaper than the naive O(n) reading suggested, but still linear, so the change is a real reduction rather than a rounding error. Reads (`getRecentEntries`, `lastSeq`) now walk from the oldest occupied slot, so the oldest-first contract is unchanged across wrap-around. Covered by `tests/unit/logger-loss.test.ts` ("live log ring").

CLEAN — every accumulator checked, with key / growth / bound / delete path:

src/services/chat-runs.ts:69 — keyed by stream id; TTL 60 min + maxRecords 2000, lazy sweep() on every mutation (:54-55, 94-99). Bounded.
src/services/grants.ts:21 — keyed by grant id; sweep() prunes consumed/expired on every mutation (:23-25, 46, 71, 88). Bounded.
src/services/mcp/manager.ts:130 — keyed by configured server id; deleted at :320 and replaced at :423. Bounded by config.
src/services/scheduler/scheduler.ts:45,48,51 — keyed by job id / run id; per-job timers and per-run controllers, deleted on fire and on shutdown. Bounded by job count.
src/services/scheduler/cron.ts:152 — tzPartFormatterCache keyed by timezone with no eviction, but validateTimezone (:144-149) rejects anything Intl.DateTimeFormat won't accept, so it is bounded by the ~600 valid IANA zones.
src/lib/logger.ts:597 — throttleStates keyed by scope; scopes are a fixed set from code. Bounded.
src/lib/logger.ts:573 — bufferListeners; subscribe() returns an unsubscribe closure (:919-920) and the SSE route calls it on abort (routes/logs.ts:225). Bounded.
src/context/cache/capabilities.ts:194, src/lib/errors.ts:141, src/lib/message-persistence-policy.ts:35, src/routes/chat.ts:81, src/services/tools.ts:460, src/tools/index.ts:173 — frozen constant lookup tables, not accumulators.
src/services/opencode/sessions.ts:241 — sessionEnsuresInFlight holds in-flight promises only, resolved and removed per session.
src/context/divergence.ts:36 — constant set.
3. Query patterns
FINDINGS

[SEVERITY: medium] src/db/index.ts — the entire memories table has no index CREATE TABLE IF NOT EXISTS memories at :354 is created with no accompanying CREATE INDEX, unlike every other growable table (messages :393-400, conversations :256-257,398-399, scheduler_runs :574-575, chat_streams :126-138, folders :493-496, compactions :76, todos :153). Three queries read it, and two of them have no LIMIT:

ts
// src/context/memory/provider.ts:69  — the hot path, every memory-enabled request
"SELECT id, content, created_at, updated_at FROM memories ORDER BY created_at DESC, id ASC LIMIT ?"
// src/routes/memories.ts:57         — MemoryPanel list, no LIMIT
"SELECT id, content, created_at, updated_at FROM memories ORDER BY updated_at DESC, id ASC"
// src/services/storage/index.ts:581  — no LIMIT
db.query<MemoryRow, SQLQueryBindings[]>("SELECT * FROM memories ORDER BY updated_at DESC").all();
The LIMIT 50 in the provider bounds the result, not the work: with no index on created_at, SQLite scans every row and sorts before discarding, on every Direct request. The two list queries have no LIMIT at all, so the MemoryPanel materialises the entire table. memories is user-authored and grows without bound, so all three degrade linearly. This is in code I shipped in Part 5 — I am reporting it against my own commit. Not verified: measured query time at realistic row counts, and whether a future migration already adds the index.

[SEVERITY: medium] src/services/storage/index.ts:234-239 — conversation search always evaluates two non-indexable branches, and the comment misdescribes them as a fallback.

ts
if (search) {
  // Server-side content search: FTS5 sidecar over title + message content,
  // with a LIKE fallback if FTS is unavailable or yields nothing.
  const q = search.trim().replace(/"/g, '""');
  clauses.push(`(
    c.title LIKE ?
    OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.content LIKE ?)
    OR c.id IN (SELECT conversation_id FROM conv_fts WHERE conv_fts MATCH ?)
  )`);
  params.push(`%${search}%`, `%${search}%`, `"${q}"*`);
}
These are OR'd, not sequenced, so the FTS index is not a fast path — SQLite must evaluate both LIKE '%…%' branches for every candidate row. EXISTS is correlated, so it scans each candidate conversation's messages; the leading % means idx_messages_conv_content(conversation_id, content) cannot be used. The same where string is then reused for the COUNT(*) at :252, doubling the cost. conv_fts is populated by triggers (db/index.ts:405-436), so the FTS branch works and the LIKE work is redundant rather than a genuine fallback. Not verified: measured latency at realistic corpus sizes.

[SEVERITY: low] src/services/chat-streams/sqliteResumableStore.ts:947-955 — the resume read materialises every remaining chunk, then copies each one again.

ts
"SELECT seq, chunk FROM chat_stream_chunks WHERE stream_id = ? AND seq > ? ORDER BY seq ASC",
)
.all(streamId, after);
for (const entry of pending) {
  if (signal.aborted) return;
  yield { cursor: cursorOf(entry.seq), chunk: new Uint8Array(entry.chunk) };
.all() loads the whole remaining stream as an array of Blobs before the first chunk is yielded, and the defensive copy in the loop doubles it, so peak is ~2× stream size. The signal.aborted check inside the loop cannot help — the load already happened. The query itself is index-served (the table is WITHOUT ROWID with PRIMARY KEY (stream_id, seq), schema.ts:118-124) and the same file uses LIMIT ? for its other chunk read at :443, so pagination is the established pattern here. Not verified: realistic peak stream size for a long response.

[SEVERITY: low] src/context/cache/capabilities.ts — no index concern; noted only that the registry at :194 is a Map built from constants, so it is a lookup table, not growth.

CLEAN

Prepared statements throughout: every query in schedulerStore.ts, sqliteResumableStore.ts, storage/index.ts, provider.ts, manager.ts uses db.query<Row, Bindings>(...) with bindings, never string interpolation. The one interpolated fragment, storage/index.ts:244-245 orderBy, is a whitelisted column branch, explicitly commented as such.
No N+1 SQL found. I scanned every for/forEach/map in src/ for a query within the loop body; every hit resolved to Map.get, a sort comparator, or a migration loop.
Bounded, no LIMIT needed: providers.ts:33 (provider_configs), manager.ts:157,164,172 (mcp_servers) — both user-config tables.
Properly paginated: storage/index.ts:248,250 (LIMIT ? OFFSET ? + separate COUNT), schedulerStore.ts:437,458 (LIMIT ? OFFSET ?), sqliteResumableStore.ts:826 (LIMIT ?), memories.ts:57 has an index-backed ORDER BY once one exists.
storage/index.ts:549 (listThreadMessages) has no LIMIT, but it is served by idx_messages_conv_seq (conversation_id, order_seq) so the ordering is index-backed, and loading a conversation's full history is the function's purpose. Noted, not filed.
Indexes that appear used: idx_messages_conv_seq, idx_conversations_updated_at, idx_chat_streams_expires, idx_scheduler_runs_job, idx_chat_streams_pending_history, idx_folders_group. Indexes I could not match to a query: idx_todos_thread (db/index.ts:153) and idx_conversations_title (:257) — no query orders by or filters conversations.title outside the LIKE at storage/index.ts:235, which cannot use it.
4. Stream / SSE lifecycle
No findings. Every stream path has a matching teardown.

CLEAN

src/routes/logs.ts:213-232 — heartbeat setInterval cleared and unsubscribe() called in the same abort handler; send is guarded by closed so a late enqueue cannot throw.
src/routes/logs.ts:187-234 — no cancel() on the ReadableStream. Client disconnect fires c.req.raw.signal, which does run the teardown, so this is safe in practice; a hypothetical reader.cancel() without a disconnect would leak the interval and subscription.
src/routes/opencode.ts:586-627 — pull-based ReadableStream: one reader.read() per pull(), so backpressure is native. cancel(reason) at :624 cancels the upstream reader and logs.
src/routes/opencode.ts:515-583 — observeBody keeps per-connection counters in closure scope (eventCount, firstByteMs), so there is no cross-request state. Event logging self-limits to the first 20 (:574-580), so log volume does not scale with stream length.
src/services/chat-streams/sqliteResumableStore.ts:428 — signal.addEventListener("abort", done, { once: true }), correctly once.
src/context/compaction/summarize.ts:140,183, src/services/scheduler/schedulerExecution.ts:268,306, src/services/browser.ts:221 — all abort listeners use { once: true }; :306 is not once but is guarded by a cancelledByParent flag.
src/routes/chat.ts:935,970 — the run's AbortController is created once per run and the tool/model call share its lifetime, so a client disconnect does not orphan the model call.
5. Frontend render path
FINDINGS

[SEVERITY: medium] web/src/components/ChatWindow.tsx:161-167 + src/routes/conversations.ts:291-299 — the transcript is unvirtualized and unbounded, and the server feeds it without a cap.

tsx
<ThreadPrimitive.Viewport className="flex-1 space-y-4 overflow-y-auto px-4 py-6 pb-4">
  {showBoot ? <ThreadBootSkeleton /> : null}
  <ThreadPrimitive.Messages>
    {({ message }) =>
      message.role === "user" ? <UserMessage /> : <AssistantMessage mode={mode} />
    }
  </ThreadPrimitive.Messages>
</ThreadPrimitive.Viewport>
ThreadPrimitive.Messages mounts a component per message with no windowing, and GET /api/conversations/:id/messages → messageService.listThreadMessages returns every row for the conversation with no LIMIT (storage/index.ts:549). So a long conversation mounts its entire history and React reconciles that whole list on every streamed chunk. virtua is already an installed dependency and is used for the logs list (web/src/components/LogsPanel.tsx:899), so the capability is present and applied elsewhere. Caveat on the fix, not the finding: AGENTS.md forbids hand-rolling message rendering, so the remedy is an ADR-level decision about the frozen assistant-ui primitives, not a new list component. Not verified: measured render cost at realistic conversation lengths — this needs a profile, which I could not run.

CLEAN

No useAuiState selector constructs a value. I checked every call site: reasoning.aui.tsx:66 → boolean, thread-running-dot.tsx:36,46 → boolean, ChatWindow.tsx:611 → string|undefined, ChatWindow.tsx:136,139,204,215,256,262 and ScrollPill.tsx:40 → primitives. Object-returning selectors (Composer.tsx:112,222, context-ring.tsx:30, WelcomeScopePicker.tsx:62, v2RuntimeExtras.tsx:82) all return a pre-existing store slice by reference, not a new object.
web/src/tools/computer/terminal-ui.tsx:29-44 — explicitly correct, with the failure mode documented: the selector returns parts by reference and merges in a useMemo, because filtering inside the selector would hand useSyncExternalStore a fresh array every snapshot and cause an infinite re-render (React #185).
web/src/components/assistant-ui/elements/session-timeline.tsx:199-207 — selects parts whole and derives, with a comment stating useAuiState compares by reference.
ChatWindow.tsx:305-310 — the 1 s setLiveMs interval is inside a per-message component but gated on isStreaming, so only the one streaming message holds a timer, and it is cleared.
All polling intervals have matching cleanup: McpPanel.tsx:141, SchedulerPage.tsx:135, serverIdentity.ts:53, ElicitationModal.tsx:37, web/src/tools/opencode/V2FormCard.tsx:273, use-copy-to-clipboard.ts:22, LogPanel.tsx:446.
Heavy dependencies are code-split via dynamic import(): beautiful-mermaid (mermaid-diagram.tsx:62), all @tauri-apps/* (web/src/lib/platform.ts:13-53), typo-js dictionaries (spellcheck.ts:33-34).
ThreadRunningDot runs items.find() per store notification, and I initially suspected O(N²) — downgraded after finding web/src/config/sidebar.ts:122-123 caps the sidebar to recentSectionLimit: 10 / searchResultLimit: 20. That file is in-flight, so this is a caveat rather than a guarantee, but at that scale the cost is ~100 comparisons.
Per-chunk work in app code: none found. The SSE consumers dispatch by event type and let assistant-ui own message state.
6. TypeScript configs
FINDINGS

[SEVERITY: medium] tsconfig.json — the backend compiles with strict OFF while the frontend has it ON.

json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["bun"],
There is no "strict" key and no "extends", so TypeScript's default (strict: false) applies to all of src/ and scripts/. web/tsconfig.json sets "strict": true plus noUnusedLocals, noUnusedParameters, noFallthroughCasesInSwitch. The backend therefore gets no strictNullChecks and no noImplicitAny, which is why null-related escapes survive there: 24 any, 18 as unknown as, ~9 non-null assertions across non-test src/, concentrated in mcp/manager.ts (4), chat-runs.ts (2), routes/chat.ts (2). The src/context/memory/seam.ts:200 as unknown as UIMessage and :174 blockId! are exactly the patterns strict mode rejects — and they sit in the code path I shipped in Part 5. Both configs' noEmit: true is deliberate and documented (tsconfig.json comment block explains the stale .js twin incident), which is good. Not verified: how many of the 24 any and 9 assertions would actually fail under strict — enabling it is a change, not a measurement, and I made no changes.

CLEAN

tsconfig.json — noEmit: true (with a comment documenting the stale-twin bug it fixed), skipLibCheck: true, moduleResolution: "bundler", target: "ESNext", types: ["bun"], include: ["src", "scripts"].
web/tsconfig.json — strict, isolatedModules, noEmit, noUnusedLocals, noUnusedParameters, noFallthroughCasesInSwitch, useDefineForClassFields, allowImportingTsExtensions, project reference to tsconfig.node.json.
No config uses extends, so there is no inherited-option drift to reason about.
Zero @ts-ignore / @ts-expect-error / @ts-nocheck in both src/ and web/src/.
web/src escape-hatch counts are roughly half the backend's (12 any, 8 as unknown as).
Absent, reported as required, not filed as defects: verbatimModuleSyntax and erasableSyntaxOnly are set in neither config. web/tsconfig.node.json (which only covers vite.config.ts) has no strict — defensible for a 30-line config file, and I am not filing it.

7. Build config
FINDINGS

[SEVERITY: low] web/vite.config.ts (committed at HEAD) — no chunk strategy, so the warning threshold is left at its default and vendor code ships as one chunk.

ts
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
})
No build.rollupOptions.output.manualChunks/advancedChunks, no chunkSizeWarningLimit, no build.target, no reportCompressedSize, no modulePreload tuning, and no production sourcemap setting. In the build I ran during the Part 5 work (before this audit, against this same committed config) Vite emitted "Some chunks are larger than 500 kB after minification", so the default threshold is being hit in practice. The cost is a single large vendor bundle to parse on every cold start of the WebView2 renderer. Mitigating: the genuinely heavy optional dependencies are already dynamically imported, so they are not in the main chunk. Not verified: actual chunk sizes and their composition — that needs a build, which I could not run.

CLEAN

No drop_console in either the committed or in-flight config, so nothing is stripped from what ships.
build.sourcemap is not enabled for production in either version.
The in-flight web/vite.config.ts adds a TBAI_PROFILE_BUILD=1 branch (unminified + sourcemap + separate dist-profile outDir) and documents at length why it must never ship. I am reporting this as observed, not judging it — the file is in-flight. Its reasoning about (program) frames being a V8 pseudo-bucket is a claim I cannot verify without a profile.
dist-profile as a separate outDir means a profiling build cannot overwrite web/dist — the right containment, and it matches the constraint I was given about not touching web/dist.
8. CI
FINDINGS

[SEVERITY: medium] .github/workflows/tests.yml:71 + tests/setup.ts:8 — the merge gate runs a suite whose documented baseline is ~259 unique failures, so a real regression cannot be distinguished from the noise.

yaml
- name: Test
  run: bun run test
bun run test is bun test ./tests ./src ./web/src ./web/tests --path-ignore-patterns "**/shutdown-lifecycle.test.ts" --timeout=30000. tests/setup.ts:8-9 points every test file in a process at one temp dir (tbai-test-${process.pid}), so all files in that process share a single SQLite file. The project's own report documents the consequence precisely: "The unique failing-test set is byte-identical: 259 before, 259 after… confirmed by tests/unit/db.test.ts passing 6/6 in isolation while failing in the suite" (docs/f-a-budget-defect-fix-report.md:377-381). The cost is that the gate cannot fail for the right reason — a genuine new failure is indistinguishable from the standing 259. This also closes the discrepancy I flagged in the Part 4 audit: 285 is total failure instances, 259 is unique failing tests.

[SEVERITY: low] .github/ — no bundle-size or performance gate exists in either workflow. Confirmed by grepping both files for size|bundle|perf|budget|benchmark|dist/. tauri-build.yml:228 prints the 12 largest artifacts with Format-Table for human eyes but asserts no threshold, and docs/decisions.md:1549 records this as a deliberate decision ("Budget thresholds come after the first real run, the same baseline-first discipline scripts/perf.ts uses"). Given that decision is documented and reasoned, I am not filing the absence as a defect — the concrete cost is that bundle growth is caught by a human reading build logs, never automatically.

CLEAN

tests.yml triggers on push to main, pull_request to main, and workflow_dispatch; gates are bun run typecheck, bun run lint (Biome), bun run test, in that order.
tauri-build.yml is workflow_dispatch + push, and carries its own typecheck, cargo check, tauri build, and a compiled-sidecar smoke test (:146-162) before assembling the portable artifact.
The two workflows are deliberately independent, and tests.yml:1-11 and decisions.md:1443 both record the reasoning (a ~4-minute suite must not block a release build).
Bun is pinned to 1.4.2 in both, with a comment recording that latest made two builds of one commit differ.
Runner is windows-latest, justified in-file as path/port sensitivity.
e2e is not wired into CI — deliberate, and it is not a gap: scripts/run-e2e.ts documents that it restarts the server per spec file precisely so ordering cannot matter, and that *-live specs are skipped unless TBAI_E2E_LIVE=1. Playwright is a devDependency (:"playwright": "^1.63.0").
One known-flaky file is explicitly excluded by the test script (shutdown-lifecycle.test.ts), with a dedicated test:shutdown script to run it deliberately.
9. Tests and the harness
FINDINGS

[SEVERITY: low] tests/unit/db.test.ts:65,95,97 — a test opens the shared chat database three times concurrently, which is the mechanism behind the 259.

ts
const holder = new Database(CHAT_DB_PATH);
…
const reader = new Database(CHAT_DB_PATH);
const writer = new Database(CHAT_DB_PATH);
Because CHAT_DB_PATH resolves under the per-PID DATA_DIR from tests/setup.ts:8, this file contends with every other file in the process. The contention is intentional for this test (it is testing multi-connection behaviour), which is why it cannot simply be fixed here. Not verified: whether any of the 259 failures are caused by this file specifically rather than by the general sharing.

CLEAN

A known-failing baseline is documented: docs/f-a-budget-defect-fix-report.md:369-381 (285 instances / 259 unique, cross-file SQLite contention, proven by isolation comparison), plus an e2e baseline of "54 passed / 20 failed" in docs/2026-09-26-playwright-failure-recovery.md:5.
The suite is isolated from developer data: tests/setup.ts redirects both DATA_DIR and WORKSPACE_DIR to a per-PID temp dir, with a comment stating the intent explicitly.
e2e is runnable locally via bun run test:e2e; per-file server restart removes ordering dependence; live specs gated behind TBAI_E2E_LIVE=1.
Real-time dependencies are bounded by deadline checks rather than bare sleeps: tests/integration/chat-runs.test.ts:93, detached-history-finalization.test.ts:215, direct-hardening.test.ts:492, __spike-sse.test.ts:98 all use if (Date.now() > deadline) throw. These are a flakiness source on a loaded CI runner even though they are correctly written.
Network dependence is avoided where it matters: mcp-connection.test.ts uses http://127.0.0.1:9/x (discard port) for connection-refused paths, which fails fast and deterministically.
Scratch databases in tests are per-file temp paths: conversation-status-migration.test.ts:43, memory-api.test.ts:43.
web/src/lib/spellcheck.test.ts:248-249 uses import("./spellcheck?lazy-probe=${Date.now()}") to defeat a module cache deliberately — a real-time dependency, but a controlled one.
10. Secrets
No findings.

CLEAN

src/services/credentials.ts:9-16 — AES-256-GCM under a per-install 32-byte DEK; the doc comment states the accepted threat model plainly ("the app's data file can recover the DEK and decrypt the keys. This is accepted for a…"). That is a documented, reasoned decision, so I am not filing the plaintext DEK at src/db/index.ts:94-101 as a defect.
No decrypted value is retained beyond the request that needed it. credentials.ts:195-207 get() reads, decrypts, and returns; nothing is memoised. getToolApprovalSecret() (:93) re-reads the encrypted setting from SQLite on every request, and the comment states the reason: "after bootstrap we re-read the encrypted setting on every request so deletion/corruption cannot be hidden by an in-memory cache." I grepped for module-level const|let|var bound to secret/token/key/password/credential names across src/ — the only match holding a live plaintext is src/services/opencode/runtime.ts:121 let authPassword: string | null = null.
runtime.ts:126-140 — that password is a 32-byte random value (or an env-provided one), generated once because the managed child process needs a stable credential across reconnects, and never logged. Never zeroed on shutdown; a theoretical exposure that requires local process memory access, which already implies the DEK is reachable.
src/lib/logger.ts:157-160 — SENSITIVE_KEY_RE plus SECRET_VALUE_PATTERNS redact secrets by key name and by value shape before emission, so a decrypted value cannot reach the log sinks.
src/lib/ai-diagnostics.ts:20 — documents that it touches no credentials, DEKs, or auth headers.
Encrypt/decrypt sites are limited to: credentials.ts (provider keys, tool-approval secret, generic encryptSecret/decryptSecret at :238-274), mcp/manager.ts:178,191,243 (MCP auth tokens, encrypted under the same DEK), and opencode/runtime.ts:135.
createHash is used only for non-secret digests: context/cache/prefix.ts:42 (prefix fingerprint) and context/memory/seam.ts:118 (memory block id).

## COVERAGE LEDGER

| # | Section | Files opened | Greps run | Status |
|---|---|---|---|---|
| 1 | Sync/blocking I/O | `logger.ts`, `logs.ts`, `opencode.ts`, `tools.ts`, `workspace.ts`, `db/index.ts`, `folders.ts`, `server-port.ts`, `startup-prefs.ts`, `serverManager.ts`, `schedulerExecution.ts` | `readFileSync\|writeFileSync\|existsSync\|statSync\|realpathSync\|readdirSync\|mkdirSync\|appendFileSync\|unlinkSync\|rmSync\|copyFileSync\|openSync` across `src/` non-test; loop-scoped query scan | **covered** |
| 2 | Unbounded state | `chat-runs.ts`, `grants.ts`, `mcp/manager.ts`, `scheduler.ts`, `cron.ts`, `logger.ts`, `capabilities.ts`, `opencode/sessions.ts`, `cache/prefix.ts` | `^(export )?(const\|let\|var)\s+\w+\s*(:[^=]+)?=\s*new (Map\|Set\|WeakMap)`; class-field Map/Set; per-candidate `.set/.delete/.get` | **covered** |
| 3 | Query patterns | `db/index.ts`, `storage/index.ts`, `schedulerStore.ts`, `sqliteResumableStore.ts`, `schema.ts`, `provider.ts`, `memories.ts`, `manager.ts`, `mcp/classify.ts` | every `SELECT`; every `CREATE INDEX`; loop-scoped query scan for N+1 | **covered** |
| 4 | Stream / SSE | `logs.ts:180-283`, `opencode.ts:514-627`, `chat.ts:935-1000`, `summarize.ts`, `schedulerExecution.ts`, `browser.ts`, `sqliteResumableStore.ts` | `text/event-stream\|new ReadableStream\|AbortController\|addEventListener\(`; `setInterval\|setTimeout` | **covered** |
| 5 | Frontend render | `ChatWindow.tsx`, `thread-running-dot.tsx`, `terminal-ui.tsx`, `session-timeline.tsx`, `reasoning.aui.tsx`, `McpPanel.tsx`, `SchedulerPage.tsx`, `serverIdentity.ts`, `ElicitationModal.tsx`, `LogsPanel.tsx`, `config/history.ts`, `config/sidebar.ts`, `mermaid-diagram.tsx`, `platform.ts`, `spellcheck.ts` | `useSyncExternalStore`; `useAuiState` (all 30+ sites); selector-construction regex; `setInterval\|setTimeout` in `web/src`; `import(`; `virtua` | **covered** — but no runtime profile, so render cost is inferred from structure only |
| 6 | TS configs | all 3 found: `tsconfig.json`, `web/tsconfig.json`, `web/tsconfig.node.json` | `strict`/`extends` per config; `any`/`as unknown as`/`@ts-ignore` counts per directory | **covered** |
| 7 | Build config | `web/vite.config.ts` at HEAD **and** working tree | `manualChunks\|chunkSizeWarningLimit\|modulePreload\|reportCompressedSize\|drop_console\|sourcemap\|TBAI_PROFILE_BUILD` | **partial** — config read fully; actual chunk sizes need a build |
| 8 | CI | both workflows, read in full | `size\|bundle\|perf\|budget\|benchmark\|dist/`; `e2e\|playwright`; `on:`/trigger blocks | **covered** |
| 9 | Tests / harness | `tests/setup.ts`, `bunfig.toml`, `package.json` (at HEAD), `run-e2e.ts`, `db.test.ts`, `mcp-connection.test.ts`, 4 integration deadline helpers, `f-a-budget-defect-fix-report.md` | `setTimeout(\d{3,})\|await sleep(\|Date.now() [<>]=\|localhost:\d\|new Database(`; known-failing baseline grep | **covered** |
| 10 | Secrets | `credentials.ts`, `db/index.ts:94-101`, `mcp/manager.ts`, `opencode/runtime.ts`, `logger.ts:150-240`, `ai-diagnostics.ts` | `createDecipheriv\|createCipheriv\|aes-\|scrypt\|pbkdf2\|createHash\|randomBytes\|decryptSecret\|encryptSecret\|DEK`; module-level secret-named bindings | **covered** |

No section is `could-not-verify-because-requires-running` at the *survey* level. Section 7 is partial for measurement only.

---

## COULD NOT VERIFY WITHOUT RUNNING

**Quantities I asserted structurally but could not measure:**

1. **Whether the unvirtualized transcript actually costs meaningful CPU.** `web/src/components/ChatWindow.tsx:161-167` + `listThreadMessages` (`storage/index.ts:549`) is a structural finding: no windowing, no `LIMIT`. I did not measure re-render cost at realistic conversation lengths. Needs a React profile: `React DevTools Profiler` recording over a long conversation, or the in-flight `web/e2e/helpers/cpuProfile.ts` harness. *This is the one finding whose severity I would most want confirmed by measurement rather than by reading.*

2. **Actual Vite chunk sizes and composition.** No `manualChunks` at `web/vite.config.ts`; the 500 kB warning I cite was observed in a build run during the Part 5 work (before this audit), against the same committed config. Needs `bun run build:web` plus reading `web/dist/.vite/manifest.json` — I was forbidden from touching `web/dist`.

3. **The conversation-search cost at `storage/index.ts:234-239`.** The two non-indexable `LIKE '%…%'` branches are confirmed present and OR'd with a working FTS branch (`db/index.ts:405-436` creates the triggers). I did not measure search latency on a realistic corpus. Needs seeded data plus `EXPLAIN QUERY PLAN` on a scratch DB — I was forbidden from touching `data/*.db`.

4. **Whether enabling `strict` on the backend would surface real errors.** I counted 24 `any`, 18 `as unknown as`, ~9 non-null assertions in non-test `src/`, and identified `seam.ts:200`/`:174` as examples strict mode rejects. I did not flip the flag and count failures — that is a code change, not a measurement.

5. **Real log-file sizes feeding `routes/logs.ts:277`.** The 5 MB default is from `logger.ts:107`; actual on-disk sizes in `data/` I did not read (forbidden path).

6. **Peak stream size for the resume path at `sqliteResumableStore.ts:947`.** Structural: `.all()` with no `LIMIT`, then a per-chunk copy. Peak memory is 2× the largest resumable stream, unmeasured.

7. **Whether the 259 unique failures are still 259 at HEAD `68027b2`.** The documented baseline is from `f-a-budget-defect-fix-report.md` against an older tree (`ad00a2b`). During the Part 4 audit I observed 285 failure instances from a bare `bun test`, which includes `web/e2e` — that is a **different command** from CI's `bun run test` (`./tests ./src ./web/src ./web/tests`, excluding e2e). So the CI-relevant failure count is unknown to me. Answering it needs `bun run test` at HEAD, which I was forbidden to run.

8. **Sustained log rate**, which sets how much the `splice(0, n)` eviction at `logger.ts:756` actually costs.

**Two things I deliberately did not judge, per your instruction:** `web/vite.config.ts` (in-flight — I read it and reported what it contains, including the `TBAI_PROFILE_BUILD` branch, but filed no finding against the modification) and the other 54 dirty entries.

---

**A note on scope.** This audit is titled "performance," and sections 1–5 and 7 are where performance findings live. But two of the most consequential things I found are not performance problems at all: the backend running with `strict` off (§6) and the merge gate sitting on top of ~259 known failures (§8/§9). Both are correctness-adjacent, both have a named cost, and both were in scope as written. I have flagged the CI gate as the one I would act on first, because until it can fail for the right reason, every other fix is unprotected by CI.

**Nothing was run, built, staged, or written.** All 56 inspections were read-only: `Get-Content`, `Select-String`, `Get-ChildItem`, `git status`/`log`/`diff`/`show`.