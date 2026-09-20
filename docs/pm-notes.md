# PM Notes — Living Working Reference

This document is for the **PM agent** (non-coding), not for the dev agents.
Read it at the start of every session. It is flexible: different agents are used
for different tasks, and no single agent does everything all the time.

## 1. Role

I act as the **non-coding project manager**:

- Write prompts for whichever dev agent the user picks (OpenCode, Claude Code,
  Codex, or any other).
- Review the reports the user pastes back.
- No code, no commands run by me. The user drives the dev agents.

## 2. The Loop

1. **User** states the goal casually.
2. **I** draft a ready-to-paste prompt, scoped to one bounded task.
3. **User** runs it on their chosen agent.
4. **User** pastes me the agent's report/diff summary.
5. **I** review against the checklist (§4) and give a verdict:
   - **accept** — work is done; update the repo snapshot (§5) and loop log (§6).
   - **send back** — issue a follow-up fix-prompt for the same agent.

## 3. Prompt-Writing Rules

- Every prompt starts with: `Read AGENTS.md fully before touching anything.`
- Name which `docs/*.md` the agent should also read for the task.
- State the goal in one line, plus the **exact files/paths** to touch.
- Note which agent the prompt is for (the user picks per task; I adapt tone/length).
- Guardrails always included:
  - assistant-ui + AI SDK v7 only — no second custom streaming protocol.
  - Library-first, minimum custom code.
  - Config-first; no hardcoded values.
  - Security: no keys/tokens to the browser; secrets encrypted at rest only.
  - One bounded task per prompt. Do not ask one agent to do everything.
- Definition of done (for any AI-touching work):
  - `bun run typecheck` exit 0
  - `bun run build` exit 0
  - A real AI smoke request works (actual numbers, not "should be fine").
- The report the agent must produce:
  - Diff summary
  - Actual test/verification numbers
  - Decisions made
  - Anything deliberately not touched, and why
  - Anything that needs a `docs/decisions.md` entry

## 4. Review Checklist

When the user pastes a report, check:

- [ ] Architecture boundaries respected (per AGENTS.md map)
- [ ] No security rule violations (keys/tokens leaking, missing Zod validation)
- [ ] Config-first / no hardcoded values
- [ ] assistant-ui + AI SDK v7 boundary held
- [ ] "Done" evidence present (actual test/build numbers)
- [ ] Anything that needs a `docs/decisions.md` entry
- [ ] Whether the repo snapshot (§5) needs updating

Verdict: **accept** (update §5 + §6) or **send back** (write a fix-prompt).

## 5. Repo 360° Snapshot

Updated by me at the end of each loop. This is the current state without
re-exploring the codebase.

**Built & verified:**
- Provider-agnostic chat (OpenAI/Anthropic/Google/Ollama/custom) with encrypted
  key storage (AES-256-GCM, local DEK, no login/unlock).
- Conversation/message persistence via assistant-ui thread architecture
  (`RemoteThreadListRuntime` + `ThreadHistoryAdapter`); survives reload.
- 11 native tools with server-side approval gates; tool-lifecycle pruning
  hardened (`prepareModelMessages` is the single production path).
- Generic MCP client (STDIO/Streamable HTTP/legacy SSE), server-executed,
  GUI-managed (`McpPanel` + `/api/mcp`). Resources/prompts insertable into
  composer; roots/sampling/elicitation wired.
- Built-in scheduler (SQLite cron + one-time, `Bun.cron` + `setTimeout`,
  restart recovery, unattended-safe tool set, `/api/scheduler` + Scheduler GUI).
- OpenCode agent mode (isolated `src/services/opencode/` + `web/src/features/opencode/`).
- Dual-theme UI (shadcn tokens, no hardcoded colors); centralized logging with
  `req_<id>` correlation + Live Logs panel (SSE + ring buffer).
- Agent-progress data parts (`data-tbai-progress`) rendered as a compact stage list.
- Hash routing + chat tabs; per-conversation 3-tier model config
  (SQLite default → runtime projection → one-shot Zustand override).

**Pending / unverified E2E:**
- Live SSE transport against a legacy SSE server.
- MCP sampling + elicitation end-to-end with a real provider key.
- Desktop Commander MCP on a machine with Node/npm/npx.
- Tauri desktop build (GitHub-only; not run locally).
- Scheduler + foundation test suites still need a live test-agent run.
- "stored systemPrompt never sent to model" is a flagged latent gap.

**Deferred (do not build until basic path confirmed):**
- RAG / retrieval, file uploads, advanced persistent memory supplied to model,
  auth/multi-user, deployment hardening.

**Test files present:** ~30 unit + integration tests under `tests/`
(workspace, tools, terminal, scheduler, pruning, logger, opencode,
conversations, approval-lifecycle, chat-runs, grants, etc.).

## 6. Loop Log

One line per task: goal / agent used / verdict / follow-ups.

- 2026-09-15 — (setup) Wrote this PM workflow doc; no dev task yet. Agent: n/a.
  Verdict: n/a. Follow-ups: first real task pending.
- 2026-09-15 — Web Service settings panel: decisions captured, prompt NOT yet
  issued. Agent: n/a. Verdict: pending. Follow-ups: write single dev-agent
  prompt (Option A, auto-start yes, QR no) on next loop.
- 2026-09-16 — Cherry-pick 3 server.ts improvements (metrics/healthz/readyz,
  graceful shutdown, safe static serving). Agent: me (build mode). Verdict:
  ACCEPTED. typecheck backend+web exit 0; build exit 0; live /healthz
  200 + /metrics counters incrementing confirmed. Follow-ups: test-agent
  suite run + docs entry.
- 2026-09-16 — OpenCode tool-linked question UI: agent hardened
  `toolLinkedQuestion.ts` (try/catch on `useOpenCodeRuntimeExtras`, 67→88
  lines), `ui.tsx` tool renderer (linked→interactive card / unlinked→read-only),
  `OpenCodeQuestions.tsx` (unlinked-only panel + exported `QuestionCard`).
  Regression: `toolLinkedQuestion.test.ts` (unbound no-throw). Verdict:
  ACCEPTED — typecheck+build green. Follow-ups: question form-richness
  (descriptions/Other/stepper) pending; `docs/decisions.md` entry optional.
- 2026-09-18 — Web server/port panel: built the SIMPLIFIED version
  (single-server port manager with "Restart to apply", NOT the LAN-exposure
  plan). Agent: user + dev agent. Verdict: matches disk — §7/§8 updated to
  reflect what's actually built. Follow-ups: verify `server.ts`
  `restartListener`/`getActivePort` (close old listener only after new bind),
  Tauri `main.rs` reads the `port` mirror file, DesktopSettings mount.
- 2026-09-18 — OpenCode heartbeat: built CodeG-parity heart chip
  (`OpenCodeStatus.tsx`, 4-state + popover w/ working dir + session id +
  Reconnect). Verdict: good; §9 marked BUILT. Follow-up: confirm the mount
  passes a real `onReconnect` (else Reconnect button is dead).

## 7. Web Service / port panel — BUILT (simplified vs original plan)

> **Status 2026-09-18: BUILT as a SIMPLER design than the original CodeG-mirror
> plan.** Kept: port management. Dropped: separate LAN-exposure server,
> auto-start, token, address row / Copy+Open, QR. This is the correct,
> smaller scope for TBAi (one server, not two; no LAN-exposure surface).

**What's on disk now (verified):**
- **Frontend:** `web/src/features/desktop/ServerSection.tsx` — a
  `SettingsSection` "Web server" with an **Active port** row + a **Port** input
  + a **"Restart to apply"** button (only appears when the input differs from
  the active port). Editing the port NEVER restarts the live server; only
  "Restart to apply" rebinds. Also `StartupSection.tsx` (startup/auto-start).
  Reuses the shared `SettingsSection`/`SettingRow` grammar.
- **Backend:** `src/routes/server.ts` —
  - `GET  /api/server` → `{ activePort, configuredPort, persistedPort, envLocked }`
  - `PUT  /api/server/port` → persist configured port **without** restarting
  - `POST /api/server/restart` → validate → persist → **rebind the same
    server** on the new port. Response comes from the OLD listener; the client
    then polls the NEW origin's `/healthz` and navigates (preserving
    path+hash). On bind conflict the old listener stays up and the error is
    reported (never claims success).
- **Port persistence:** `src/services/server-port.ts` — `app_settings`
  (SQLite source of truth, key `server.port`) + a one-line **`port` mirror file**
  in the data dir (advisory, cross-process contract the Tauri shell reads at
  startup before SQLite is practical). `isPortEnvLocked()` → when `PORT` env is
  set, the UI disables editing and says why. `DEFAULT_WEB_PORT = 3000`.
- **Server lifecycle:** `src/server.ts` gained `getActivePort()` +
  `restartListener(port)` (rebinds the same Hono app).

**Design rationale (why simpler than §8's CodeG-mirror plan):**
- One server, not two → no "which port is the app on" confusion, no second
  listener, no LAN-exposure security surface, no token. Matches AGENTS.md
  "keep it small."
- Safe restart semantics: the live listener is untouched until restart; the
  client reconnects by navigating to the new origin. Bind-failure leaves the
  old listener running (honest, no false success).

**Still to verify (read-only follow-ups, NOT blocking the build):**
1. `src/server.ts` `restartListener`/`getActivePort` — confirm it rebinds the
   SAME Hono app and only closes the old listener AFTER the new bind succeeds
   (else a restart could drop the server).
2. `src-tauri/src/main.rs` — confirm the desktop shell reads the `port` mirror
   file at boot and launches the sidecar on it (so a changed port is honored
   next launch).
3. `StartupSection.tsx` / `ServerSection.tsx` mount — confirm they're wired
   into the Desktop settings surface (`DesktopSettings.tsx`).

## 8. Web Service panel — measured UI/UX spec (CodeG reference) — SUPERSEDED

> Kept for reference only. The built version (§7) is a **port manager**, not
> the full CodeG "web services" panel (no start/stop, token, address row, QR,
> auto-start). The CodeG measurements below are useful only if we later add
> the LAN-exposure features back.

Measured from `D:\Temp\codeg\src\components\settings\web-service-settings.tsx`
so future prompts cite it verbatim. TBAi target page:
`web/src/features/web-service/WebServicePage.tsx` composing the shared grammar
(`SettingsPage`/`SettingsSection`/`SettingRow`/`SettingsError` in
`web/src/components/shared/settings.tsx`).

**Decision summary (user-chosen):** Option A (real start/stop of TBAi's Bun
server + port mgmt) · auto-start YES · QR NO · address row = Copy + Open only ·
single prompt for both backend + frontend.

### Page rhythm
- Single column. TBAi `SettingsPage` already gives `max-w-3xl space-y-4 p-4` —
  keep it; match CodeG's internal `space-y-4` between rows, `gap-4` within a row.
- Section heading: CodeG uses `text-lg font-medium` + `text-sm
  text-muted-foreground` description. In TBAi, the `SettingsSection` heading is
  `text-sm font-semibold` — keep TBAi's grammar, only adjust if we adopt the
  CodeG standalone page shell.
- Row layout: `flex items-center gap-4`; label `w-20 text-sm font-medium`;
  control to the right.

### Control specs (copy-paste classes)
| Control | Spec |
|---|---|
| Port input | `flex h-9 w-32 rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50`; `type=number min=1024 max=65535` |
| Start/Stop button | `inline-flex h-8 items-center rounded-md border border-input bg-background px-3 text-xs font-medium ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50` |
| Status dot | `inline-block h-2 w-2 rounded-full` → running `bg-green-500`, stopped `bg-muted-foreground/30` |
| Status label | `text-sm` |
| Token field wrap | `rounded-md border bg-muted/40 px-3 py-2`, inner flex `items-center gap-1`; input `min-w-0 flex-1 bg-transparent font-mono text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed`; action icons `h-3.5 w-3.5` inside `h-7 w-7 rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground` hit areas |
| Auto-start switch | TBAi `Switch` + hint `text-sm text-muted-foreground` |
| Address row | `flex items-center gap-2`; circular buttons `inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-input text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground`; read-only variant `flex h-9 min-w-0 flex-1 items-center rounded-4xl border border-input bg-input/30 px-3` with `code truncate text-sm select-all`; multi-IP uses a `Select` `min-w-0 flex-1` |
| Stale-port banner | `flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3`; icon `mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400`; title `text-sm font-medium text-amber-700 dark:text-amber-300`; hint `text-sm text-muted-foreground` |
| Error line | `text-sm text-destructive` |
| Hints | `text-xs text-muted-foreground` |

### Color tokens (token-first — NO hardcoded hex)
- status green = `bg-green-500` / `text-green-500` (copied check)
- warn/stale = `amber-500` (border/bg `/40` `/10`)
- error = `text-destructive`, `border-destructive/30 bg-destructive/5`
- muted text = `text-muted-foreground`; surfaces = `bg-card` `bg-muted/40`
  `border-input`

### Behavior spec (the "feel")
- Port input **disabled while running**; config auto-saves debounced ~500ms.
- Auto-start **persists immediately** on toggle.
- Stale-port banner shows when stopped **and** port probe = occupied/unknown.
- Address row renders **only when running**.
- Token: masked; show/hide (Eye/EyeOff), regenerate (random 32-hex via
  `crypto.randomUUID`), copy with a transient ✓.
- Start/Stop is **one button** (state-driven label + "Running"/"Stopped").

### Backend surface (Option A — CORRECTED: separate LAN-exposure server)

**Architecture (verified in CodeG `src-tauri/src/web/mod.rs` + transport layer):**
The web service is a **separate, optional HTTP/WS LAN-exposure server**, NOT
the app's own backend. In CodeG the Tauri shell talks to the backend over
in-process Tauri IPC (`tauri-transport.ts`); the `:3080` server is an
*add-on* that lets **other devices** reach the same backend over the network.
Stopping it never affects the desktop app — the app doesn't depend on that port.

**Therefore for TBAi (Option A, corrected):**
- TBAi's desktop shell (Tauri/ElectroBun) webview ↔ Bun backend on `:3000` is
  the app runtime and is **NOT touched** by Stop. The web-service panel
  manages a **separate LAN-exposure HTTP server on a different port**
  (default `3080`, like CodeG) that serves the same Hono app + static web/dist
  for reachability from other devices / the phone.
- "After Stop the app still works" = because the desktop runtime uses the
  in-process backend, not the `:3080` socket. Stop only cuts the network path.
- **Auto-start** = bring the LAN-exposure server up when the desktop shell
  launches.
- The address row (`http://<ip>:<port>` + Copy/Open) shows how other devices
  reach the app.
- Web-mode (plain browser, no Tauri) → hide the nav item (mirror CodeG's
  `detectEnvironment() === "web"` gate in `settings-shell.tsx`).

**New `src/routes/web-service.ts` composed into `src/routes/index.ts`:**
- `GET  /api/web-service/status` → `{ running, port:number|null, addresses:string[] }`
- `GET|POST /api/web-service/config` → `{ port, autoStart, token:string|null }`
  (token encrypted at rest via `src/services/credentials.ts`; only
  `tokenConfigured` boolean returned)
- `POST /api/web-service/start` / `stop` — start/stop the **separate**
  LAN-exposure server (a second `Bun.serve` on the configured port serving the
  same Hono `app` + `web/dist` static), NOT the app's primary `:3000` server.
- `POST /api/web-service/probe-port` → `{ port, state:"free"|"occupied"|"unknown" }`
- All Zod-validated; no secret returned to the browser.

**Persistence:** `web_service_config` table (port, auto_start, encrypted token)
in `src/db/index.ts` (idempotent migration).

**Design guardrail (the key risk avoided):** never stop/restart the primary
app backend from this panel — only the secondary LAN-exposure server.
The primary `:3000` Hono server stays up for the whole desktop session.

## 9. OpenCode Heartbeat — study (CodeG reference, for TBAi)

Source: CodeG `src/components/chat/composer-connection-status.tsx`. TBAi target
surface = `web/src/features/opencode/OpenCodeStatus.tsx` (extend, not duplicate).

**CodeG design (colour-coded heart in the row below the composer):**

| State | Icon | Colour / feel |
|---|---|---|
| connected | `HeartHandshake` | no colour (inherits `text-muted-foreground`) — resting shouldn't stand out |
| connecting | `HeartPulse` | amber + `animate-pulse` |
| error | `HeartCrack` | red |
| disconnected | `HeartOff` | dimmed `text-muted-foreground/60` |

- Inline = just the small `size-3.5` heart (no label, no agent icon).
- Click → `Popover` (`w-64 p-3`): agent icon + label + status, error box
  (destructive bg) when in error, **Working dir** + **Session id** detail rows
  (`font-mono text-2xs break-all`), viewer note, amber "reconnect interrupts"
  warning, **Reconnect** button (available in every state; disabled when no
  reconnect info). The "prompting" state collapses to "connected" for the icon
  but is labelled separately in the popover.

**TBAi real data source (no new backend work):**
- `useOpenCodeThreadState()` → `runState` (idle|streaming|cancelling|
  reverting|error), `loadState` (idle|loading|ready|error), `sessionStatus`,
  `sessionId`, `session` (the `@opencode-ai/sdk` `Session` object, carries
  working-dir fields).
- `useOpenCodeSession()` → live `Session | null`.
- `useOpenCodeRuntimeExtras()` → `refresh()`, `cancel()`, `fork()`, etc.
  (the TBAi equivalent of CodeG's `reconnect()` is `refresh()`).
- Working dir also resolvable from `OpenCodeSessionRow` (folder scope) and
  `/api/opencode/session` → `directory` field.

**State mapping (TBAi → heart):**
- `idle` + session attached → `HeartHandshake` (no colour).
- `streaming` OR `loadState==="loading"` → `HeartPulse` (amber + pulse).
- `runState.type==="error"` → `HeartCrack` (red).
- no session / `disconnected` → `HeartOff` (dimmed).

**Plan (single bounded task, extend `OpenCodeStatus.tsx` only):**
- Replace the flat text strip with a CodeG-style heart chip in the same spot
  (it's already a sibling of the composer area in `OpenCodeView.tsx:218-227`).
- Data from the existing hooks above; NO new files / routes / store / backend.
- Click → popover (`w-64 p-3`): status label + heart, **Working directory**
  (`font-mono text-xs break-all`), **Session id** (`font-mono`), error detail,
  **Refresh** action (runtime `refresh()`).
- UI/UX: TBAi `globals.css` shadcn tokens only — amber/red/`muted-foreground`
  status colours, `text-xs`/`text-2xs`, `size-3.5` icon, spacing like
  `OpenCodeSessionRow` (`px-3 py-2`).
- DONE = `bun run typecheck` + `bun run build` exit 0 + visually confirm the
  heart flips across idle/streaming/error/disconnected in a live OpenCode run.

**Open decisions (user to confirm before prompt):**
1. Inline text: heart-only (CodeG) vs heart + short label.
2. Action: `refresh()` only (safe) vs also terminate+recreate.

> **Status 2026-09-18: BUILT (CodeG parity, done well).** `OpenCodeStatus.tsx`
> is now a 4-state heart chip: `HeartHandshake` (idle/connected, muted) ·
> `HeartPulse` (streaming/loading, amber + pulse) · `HeartCrack` (error,
> destructive) · `HeartOff` (no session/cancelling, dimmed). Precedence:
> error → off → working → idle. Click → Popover with **Working directory**
> (reads both V2 `location.directory` + 1.18.x top-level `directory`) +
> **Session id** + error detail + a **Reconnect** button.
> - Extras read is guarded like `useToolLinkedQuestion` (unbound → degrades to
>   a disabled control, no crash). `compact` prop for inline composer placement.
> - **Reconnect is a transport re-establish, deliberately NOT history
>   `refresh()`** — its own pending state, derived from the real `loadState`
>   (a failed reconnect shows the error heart, not a stuck spinner).
> - **Verify (not blocking):** the mount in `OpenCodeView`/`CodeShell` must
>   pass a real `onReconnect` handler, else the Reconnect button is permanently
>   disabled. If none is wired, consider dropping the button.

## 10. OpenCode tool-UI parity with Paseo — build spec

Goal: TBAi's OpenCode tool surfaces reach **Paseo-grade** richness where it's
safe, reusing TBAi's existing shells (never a second card/approval machinery).
Paseo reference = `D:\Temp\paseo` (OpenCode provider + React Native app).

**Rule (AGENTS.md):** extend TBAi's existing renderers/shells. No new files
beyond the UI edits below. No new deps. No second approval path — every card
routes approval through `BackendToolView` → `ApprovalGate` (the single guarded
lifecycle). Verify field names on disk / against the live OpenCode server, not
from memory (`web/src/tools/opencode/adapt.ts` documents this contract).

### 10.1 What TBAi already does well (do NOT rebuild)
- **diff** → `DiffViewer` (`web/src/components/diff-viewer.tsx`), used by
  `OpenCodeEditToolUI` (`web/src/tools/opencode/ui.tsx`) + markdown `diff`
  fences. Equivalent to Paseo.
- **code block** → Shiki highlighter + language label + copy
  (`web/src/components/assistant-ui/elements/shiki-highlighter.tsx`,
  `markdown-text.tsx`). Equivalent.
- **terminal** → `TerminalBlock` (`web/src/components/assistant-ui/elements/
  terminal-block.tsx`, ink-style, streaming), used by `OpenCodeBashToolUI` +
  native `run_command`. Equivalent.
- **success/error** → assistant-ui `ToolCallMessagePart` status +
  `MessagePrimitive.Error` red strip + tool-group running/complete/error.
  Equivalent.

### 10.2 The three Paseo-parity gaps (the actual work)

**Gap A — Live todo panel (Paseo `TaskListRow` + progress footer).**
- Paseo: todo is an **always-visible composer-track panel** (not just an inline
  card), one row per item, status icon per state, a **"N/M tasks done"**
  footer, and an `activeForm` live "doing X…" label that swaps in while
  `in_progress`.
- TBAi today: `OpenCodeTodoWriteToolUI` = inline card, title
  `todowrite · N item(s)`, result body as plain text. No live panel, no
  progress footer, no activeForm.
- TBAi data: OpenCode `todowrite` args `{ todos: [{ content, status, priority? }] }`
  (`OpenCodeTodoWriteToolUI` in `web/src/tools/opencode/ui.tsx:346`). Status
  enum = `pending | in_progress | completed` (match Paseo's normalize:
  inProgress→in_progress).
- **Build:** a compact live todo list (rows w/ Circle / CircleDot / CircleCheck
  + strikethrough on completed) anchored near the composer (sibling of
  `ChatWindow`, like `OpenCodeSessionRow`), driven by the latest `todowrite`
  args; add a progress line `done/total`. Data-only: read from the thread's
  last `todowrite` part. No new backend.

**Gap B — Structured web-search results (Paseo result card).**
- Paseo: `websearch` shows a **structured list** — per hit: title (link),
  URL, snippet.
- TBAi today: `OpenCodeWebSearchToolUI` = card `websearch · <query>`, result
  as plain monospace text.
- TBAi data: OpenCode `websearch` args `{ query, numResults?, type?, livecrawl? }`;
  result = the search output (parse into hits if the result is JSON; else
  fall back to text).
- **Build:** render a results list (title + truncated snippet + URL, clickable
  via `openUrl`/`target=_blank rel=noreferrer` per the markdown security rule).
  Reuse the `TextBody` fallback when the result isn't parseable.

**Gap C — Tool-linked question UI (DONE; Paseo form-richness PENDING).**
- TBAi shipped a **tool-linked question** bridge (Phase B): a pending OpenCode
  question that is linked to a tool call (`request.tool.callID`) answers **inline
  on that tool's card**, instead of the top-of-page panel.
- **Files (verified on disk 2026-09-16):**
  - `web/src/features/opencode/toolLinkedQuestion.ts` — single owner of the
    tool-call ↔ question mapping (strict `request.tool.callID === toolCallId`).
    `useToolLinkedQuestion(toolCallId)` returns the linked request + `answer()`
    (forwards `replyToQuestion`) + `skip()` (forwards `rejectQuestion`).
  - `web/src/tools/opencode/ui.tsx` — `OpenCodeQuestionToolUI`: linked →
    interactive `QuestionCard`; unlinked → `QuestionReadonlyView`
    ("answer on the question card above").
  - `web/src/features/opencode/OpenCodeQuestions.tsx` — now renders **unlinked
    only** (`questions.filter(req => !isLinkedQuestion(req))`); exports
    `QuestionCard` for reuse. No double-answer.
- **Unbound safety (added by the agent, 67→88 lines):** `useOpenCodeRuntimeExtras()`
  **throws** outside an OpenCode runtime (verified in the pinned
  `@assistant-ui/react-opencode@0.2.23` `hooks.js`/`.d.ts`), so the bridge
  wraps it in a **try/catch that returns `null` when unavailable** → the tool
  card falls back to the read-only view instead of crashing the message list.
  Hook-order invariant: the extras call is **unconditional** (always runs), so
  hook order never varies between renders. Do NOT make that call conditional.
- **Data contract (verified):** `useOpenCodeQuestions()` → `OpenCodeQuestionRequest`
  with `request.questions[i] = { header, question, options[], multiple?, custom? }`
  and `request.tool?.callID`. Answer = `replyToQuestion(id, answers: string[][])`;
  skip = `rejectQuestion(id)`. TBAi's SDK shape uses `multiple`/`custom`, NOT
  Paseo's `multiSelect`/`allowOther` — map, don't assume.
- **Remaining Paseo-grade delta (pending):** option chips show `description`
  under the label (already in the read-only view); an "Other…" free-text field
  when `custom`/no options; an optional multi-question **stepper** (Next/Submit,
  answered tabs). Not yet built.
- **Regression tests (agent-authored, on disk):**
  `web/src/features/opencode/toolLinkedQuestion.test.ts` — unbound no-throw,
  exact-callID match, answer/skip forwarding, panel linked-exclusion.

### 10.3 Invariants (must hold, per AGENTS.md)
- Question/permission cards are **display-only** for the tool part; answering
  happens on the owning surface (`OpenCodeQuestions` / `OpenCodePermissions`).
  The tool renderer points at the surface, never calls `addResult`
  (`web/src/tools/opencode/ui.tsx:392-401`).
- One approval lifecycle: `ApprovalGate` carries the stale-permission guard
  (`web/src/stores/stalePermissionsStore.ts`). No second gate path.
- Cards stay out of `ToolFallback`; unregistered `question` previously crashed
  ("Runtime does not support tool results").
- Colors = `globals.css` shadcn tokens only (no hardcoded hex). Icons `size-3.5`.

### 10.4 File map (what an agent edits)
- Gap A: new `web/src/features/opencode/OpenCodeTodoPanel.tsx` (live list) +
  mount in `OpenCodeView.tsx` (sibling of `ChatWindow`, like `OpenCodeSessionRow`).
- Gap B: edit `OpenCodeWebSearchToolUI` in `web/src/tools/opencode/ui.tsx`.
- Gap C: edit `web/src/features/opencode/OpenCodeQuestions.tsx` (+ optional
  `question-form` helper). Reuse `approval-card.tsx` shell.
- All UI in `web/`; **no** `src/` (backend) changes; **no** new deps.

### 10.5 DONE per gap
- `bun run typecheck` + `bun run build` exit 0.
- Live OpenCode run: todo panel updates as `todowrite` fires (progress line
  tracks done/total); websearch shows structured results (link works); question
  card: options show description, multi-select works, "Other" input, Skip
  leaves no row, error path shows inline.
- Tests handed to test agent (this doc is PM-only, no test authoring).

### 10.6 Status
- **Gap C (question):** tool-linked bridge DONE 2026-09-16 —
  `toolLinkedQuestion.ts` (unbound-safe extras read via try/catch; hook-order
  invariant = the extras call stays unconditional), `ui.tsx`
  `OpenCodeQuestionToolUI` (linked→interactive card, unlinked→read-only),
  `OpenCodeQuestions.tsx` (unlinked-only panel + exported `QuestionCard`).
  Regression tests: `toolLinkedQuestion.test.ts`. typecheck + build exit 0.
  **Remaining Paseo delta pending:** option descriptions on the interactive
  card, "Other…" input, multi-question stepper.
- **Gap A (todo panel)** and **Gap B (structured websearch):** NOT yet built.
  Suggested order: **B** then **A** (pure display, low risk). The question
  form-richness is a third, smaller item after C's base.

## 11. OpenCode auto-approval — study (OpenChamber reference, for TBAi)

Source: `D:\Temp\openchamber`. Goal: TBAi gets the same "auto-accept
permissions for this session" shield toggle OpenChamber has in its composer,
scoped to TBAi's OpenCode (Code) mode. **Docs-only for now — no code written,
prompt not yet issued.**

### 11.1 What OpenChamber does (the 4 layers)

A shield button in the composer footer. ON = OpenCode permission requests for
that session are auto-approved; no manual Approve clicks.

| Layer | File | Role |
|---|---|---|
| UI | `packages/ui/.../composer/ui/PermissionAutoAcceptButton.tsx` | Shield icon in footer; `shield-user` (off) / `shield-check` (on, blue accent), `aria-pressed`, tooltip "Permission auto-accept: on/off" |
| Toggle logic | `packages/ui/.../chat/permissionAutoAccept.ts` | live session → PUT policy; new-session draft → stash flag on the draft, apply at session materialization |
| Client store | `packages/ui/.../stores/permissionStore.ts` (Zustand) | per-session boolean map; hydrates from server; revision-guarded (a stale write can't clobber a fresh one) |
| Backend runtime | `packages/web/server/lib/permission-auto-accept/runtime.js` | **Authoritative** policy. Persists to settings, subscribes to OpenCode SSE event hub, auto-replies `once` on each `permission.asked`; on enable/reconnect **reconciles** all pending permissions |

Key subtleties in the backend runtime:
- **Lineage inheritance:** a child session walks up to its parent/grandparent;
  nearest explicit value wins, so a child `false` overrides a parent `true`.
- **`once`, never `always`:** auto-accept replies `once` — it is a per-session
  convenience switch, **not a trust grant**. ("Always" trust is a separate,
  explicit user action.)
- **Fail closed:** unknown lineage / failed policy load → not auto-accepting.
- **Reconcile-on-enable:** enabling a session immediately answers every
  currently-pending matching request; survives UI disconnect + server restart.
- **UI is a projection:** the server is the sole responder; the client renders
  pending cards until the authoritative `permission.replied` SSE event arrives.

### 11.2 How TBAi differs (why the design is smaller)

- **No backend SSE bridge.** TBAi's backend never subscribes to OpenCode
  events. `@assistant-ui/react-opencode` (in the browser) owns the runtime;
  `useOpenCodePermissions` + `reply()` live client-side
  (`web/src/features/opencode/OpenCodePermissions.tsx`). So "reconcile pending
  on server restart / headless auto-approve" has **no TBAi equivalent** — and
  per the OpenCode-isolation boundary we should NOT add one.
- **No session lineage.** TBAi's OpenCode sessions are 1:1 with conversations,
  no subagents. Drop the inheritance machinery entirely.
- **No draft concept.** `CodeShell`/`OpenCodeView` creates the OpenCode
  session on entry; the toggle only matters once a session exists.

### 11.3 Proposed TBAi design (3 layers, OpenCode-mode-scoped)

- **Persistence** — new SQLite row in the `app_settings` pattern:
  `conversationId → boolean`. App state ⇒ SQLite is correct (AGENTS.md).
- **Backend routes** (`src/routes/opencode.ts`, named routes registered
  **before** the `app.all("*")` proxy catch-all):
  - `GET  /api/opencode/permissions/auto-accept` → `{ sessions: Record<string,boolean> }`
  - `PUT  /api/opencode/permissions/auto-accept/:conversationId` → `{ enabled }`
  - Zod-validated. New service `src/services/opencode/autoAccept.ts` (under the
    OpenCode boundary) reads/writes the policy. No event handling.
- **Frontend store** — new `web/src/stores/` slice (Zustand, mirrors
  `stalePermissionsStore`): per-conversation flag; hydrates from backend;
  exposes `isConversationAutoAccepting(conversationId)` +
  `setAutoAccept(conversationId, enabled)`.
- **UI button** — new `web/src/features/opencode/` component, placed in the
  Code-mode composer area (sibling of `OpenCodeSessionRow`/`OpenCodeStatus`),
  shadcn `Tooltip` + lucide `ShieldCheck`/`ShieldQuestion`, TBAi tokens
  (NOT OpenChamber's `--status-info`), matching §9's visual language.

**Decisive decision — auto-approvals execute in the browser, gated on the flag.**
A small effect in `web/src/features/opencode/` watches
`useOpenCodePermissions().pending`; when the active conversation's flag is ON it
auto-replies `once` to each unlinked permission (same `reply(request.id,"once")`
call `OpenCodePermissions.tsx` uses). The manual card then disappears on the
authoritative `permission.replied` SSE event — **no second protocol**, library-
first.

**Tradeoff (flag for the user):** auto-approvals only run while TBAi's UI is
open and in Code mode. OpenChamber's server runtime auto-approves headless; TBAi
client-side cannot. Accept it to stay library-first (no new SSE bridge).

**Safety parity:** reply `once` only (never `always`) — the existing "Always"
button already delegates trust to OpenCode, so auto-accept stays a
convenience, never a trust grant. Fail closed if the conversation can't resolve.

### 11.4 Files a dev agent would touch (plan only — DO NOT code yet)
- `src/db` — new settings table/row (conversationId → boolean)
- `src/services/opencode/autoAccept.ts` — NEW service (read/write policy)
- `src/routes/opencode.ts` — 2 named routes (before the proxy catch-all)
- `web/src/stores/` — NEW slice (per-conversation flag + hydrate)
- `web/src/features/opencode/` — NEW button + the auto-reply effect
- i18n copy (shield on/off labels, e.g. "Permission auto-accept: on")
- `docs/decisions.md` — one entry (client-side auto-approve scope + `once`
  safety + "UI must be open" tradeoff)
- **No new dependencies.**

### 11.5 Open decisions (user to confirm before the prompt is written)
1. **Scope:** client-side only (accept the "UI must be open + Code mode"
   tradeoff) vs also a headless backend auto-approver (bigger: bridge OpenCode
   event stream into TBAi backend — not recommended).
2. **Button placement:** Code-mode composer area (sibling of
   `OpenCodeSessionRow`/`OpenCodeStatus`) vs a more prominent slot.
3. **Fail-closed vs fail-open default:** when the flag can't be read, treat as
   OFF (recommended) — never auto-approve by default.

> **Status 2026-09-19: STUDIED + PLANNED, NOT BUILT. Prompt not yet issued.**
