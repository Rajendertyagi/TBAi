# TBAi — Master Performance Optimization Checklist

> Single source of truth for frontend, backend, database, streaming, and coding agent performance optimizations in TBAi.

---

## 1. 🎨 Frontend & UI (React 19 + Vite)
- [ ] **Lazy Loading Pages & Panels**: Use `React.lazy()` for Settings, OpenCode View, and McpPanel so they only load when clicked.
- [ ] **Component Code-Splitting**: Lazily load heavy dependencies like Mermaid diagrams, syntax highlighters, and code diff viewers (`patchToCodeDiffs`).
- [ ] **Virtualized Message List**: Use `react-virtuoso` to render only visible chat messages, keeping memory flat even in 1,000+ message threads.
- [ ] **React.memo Guard**: Wrap `ChatMessage` and `ToolCard` components with `React.memo` to prevent unchanged messages from re-rendering during streaming.
- [ ] **Vite Vendor Chunks**: Configure `manualChunks` in `vite.config.ts` so icon sets and vendor libraries are cached permanently in the browser.

---

## 2. 🌊 Streaming & Render Smoothness
- [ ] **16ms Token Batching**: Group incoming SSE stream tokens into 16ms animation frames (60 FPS) to prevent high CPU usage during AI generation.
- [ ] **Deferred Markdown Parsing**: Parse Markdown text incrementally or throttle heavy syntax highlighting until streaming finishes.
- [ ] **Diff & Mermaid Render Budget**: Cap maximum lines/characters for diffs and diagrams (`diffPreviewMaxLines`, `diffPreviewMaxChars`) to avoid UI freeze on giant patches.

---

## 3. 🧅 Backend Runtime (Bun 1.4.2 + Hono)
- [ ] **Native `bun:sqlite`**: Use Bun’s native C++ SQLite driver (`import { Database } from "bun:sqlite"`).
- [ ] **Zero-Buffer Hono Streaming**: Use `c.streamText()` to pipe AI tokens directly from model providers to HTTP responses without server buffering.
- [ ] **Zero-Copy File Reading**: Use `Bun.file()` for workspace files and configuration reads.
- [ ] **Pre-compiled Zod Schemas**: Pre-compile Zod validation schemas to validate incoming API payloads in micro-seconds.

---

## 4. 🗄️ SQLite Database Tuning
- [ ] **WAL Mode (Write-Ahead Logging)**: Execute `PRAGMA journal_mode = WAL;` so reads and writes never block each other.
- [ ] **Prepared Statements**: Pre-compile all SQL queries with `db.prepare()` at startup.
- [ ] **Database Indexes**: Add indexes on `conversations(id)`, `messages(conversation_id, order_seq)`, and `memories(id)`.
- [ ] **Periodic VACUUM**: Reclaim unallocated SQLite storage pages after mass deletions.

---

## 5. 🔐 Security Vault & Memory Caching
- [ ] **AES-256-GCM DEK Memory Cache**: Cache decrypted Data Encryption Keys in memory so API key lookups take `<0.5 ms`.
- [ ] **Fast Map Lookups**: Use `Map<string, ProviderConfig>` for $O(1)$ constant-time provider and tool lookups.

---

## 6. 🤖 OpenCode Agent Engine
- [ ] **Process Reuse**: Keep the managed `opencode serve` background process alive across user interactions.
- [ ] **Stale Permission Guard**: Suppress permission card flashes during view toggles via `stalePermissionsStore`.
- [ ] **SSE Event Reduction**: Process raw OpenCode V2 events in a single reducer step without intermediate object creation.

---

## Usage Guide
When requesting an optimization implementation, specify the target item (e.g. *"Generate prompt for Item 1 in Section 1 (Lazy Loading Pages)"*) to receive a ready-to-copy implementation prompt for external coding tools.
