# Telegram Integration — Plan (PLANNING ONLY, NOT STARTED)

Owner: TBAi maintainer. Status: **topology locked 2026-09-16; two
sub-decisions provisionally resolved, flagged in §2.**
This document is a plan. No code has been written and no implementation has
begun. It exists so the work can be executed phase by phase against a written
contract, per the maintainer's standing rule (plan on disk first, then implement
one phase at a time and report back).

Companion docs: `architecture.md`, `security.md`, `decisions.md` (ADR-021 to be
written when Phase W1 lands), `dual-chat-opencode-plan.md` (engine model).

Revision history:
- v1 (2026-09-16) — initial plan; goal choice left open.
- v2 (2026-09-16) — scope confirmed as **all three goals**; topology locked to a
  single private DM (no forum / no supergroup / no multiplexer); two-way
  confirmed; scheduler→OpenCode identified as blocked and parked; scheduler
  engine-guard gap recorded as a standalone bug.

---

## 1. Goal

Let the user (a) receive scheduled AI output on Telegram, (b) let the AI send
Telegram messages on demand, and (c) chat with the AI from Telegram — for
**both engines** where the engine model allows.

Three goals, all confirmed in scope:

| Goal | Description | Decided by |
|---|---|---|
| **N — notify** | "Send me the latest news at 9am." A lifecycle event fires; the app pushes the message. | nothing / the scheduler |
| **T — tool** | "Let the AI send me a Telegram message." The model invokes a tool mid-conversation. | the model |
| **C — chat** | Two-way: message the bot and talk to the AI. | the user |

N and C share one destination (§2). T is an additive layer over the same send
core. None of the three requires a forum, group, or channel.

---

## 2. Topology (LOCKED 2026-09-16)

**A single private DM with the bot.** `chat_id` = the user's numeric Telegram
user ID. Outbound notifications and inbound chat share that one chat.

| # | Decision | Value |
|---|---|---|
| D5 | Destination | One private DM (`chat_id` = user ID) |
| D6 | Notify + chat channel | **Shared** — the same DM serves both |
| D7 | Chat ↔ conversation granularity | **1:1 initially**; `/new` deferred (see below) |
| D8 | Engine binding | **`/code` rebind command** (see below) |
| D9 | Forum / topics / supergroup / multiplexer | ❌ **Rejected — not needed** |
| D10 | Bot count | One bot, one token |

### Consequences the maintainer has accepted

**D7 — one DM = one conversation.** Without `/new`, all Telegram history
accumulates in a single TBAi thread. Provisional default: 1:1. `/new` is a small
addition when the thread becomes unwieldy.
*Flagged for confirmation.*

**D8 — one DM = one engine at a time.** This is the engine lock
(`conversations.engine`) meeting the single-chat choice. A DM maps to one
conversation, and that conversation is either Direct or OpenCode — never both.
The maintainer asked for both engines over Telegram, so the provisional default
is a **`/code` rebind command** that repoints the DM at an OpenCode conversation.
This is not a multiplexer: it is one command updating one binding row.
*Flagged for confirmation; the alternative is fixing the DM to Direct permanently
and using OpenCode only in the app.*

### What the DM choice unlocks

**Streaming drafts work.** `sendMessageDraft` is **private-chats-only**, so the
simple DM is exactly the case that gets live animated message updates. Groups and
topics would have forced the clunkier throttled `editMessageText` fallback.

---

## 3. Hard Telegram constraints (design inputs, not choices)

| Constraint | Consequence for this design |
|---|---|
| **A bot cannot initiate a conversation.** It can only message a chat that already started it. | Outbound needs a `chat_id` captured once. With two-way in scope there is an inbound handler anyway — capture it automatically on `/start` rather than copying from @userinfobot. |
| **`sendMessageDraft` is private-chats-only** — numeric `chat_id`; no groups, channels, or `@username`. | Satisfied by the locked topology. |
| **`sendMessageDraft` requires forum topic mode enabled in @BotFather** (Bot Settings → Group Privacy → Forum Topic Mode), even for a DM. | A bot-level toggle, not a chat type. Nothing to create. If left off, drafts fail and `editMessageText` is the fallback. |
| **`draft_id` must be non-zero**; same id animates in place. Drafts are a **30-second ephemeral preview** and must be finalized with `sendMessage`. | The final send is mandatory, not optional — losing it loses the message. |
| **4096 chars per message.** | A news digest will chunk into multiple messages. Layout is part of the design, not an afterthought. |
| **Rate limits + `429 retry_after`.** | Rapid chunked sends risk per-chat limits. Throttle per chat and honor `retry_after`. |
| **One bot token = one identity.** | Notify and chat cannot be separate identities without a second bot — accepted, since D6 shares one DM. |
| **Messages live on Telegram's servers.** | Public if a channel is public. For a private DM it is not public, but it is **not local-only** — a material change to TBAi's privacy posture (§8.5). |
| **Bot API current version: 10.3** (2026-08-24). | `sendMessageDraft` gained `can_stop` / `keep_on_stop` in 10.3, plus a `MessageGenerationStopped` update for the user-facing stop button. |

---

## 4. Why one mechanism cannot cover both engines

The load-bearing constraint of the whole plan. Verified on disk:

| | Direct chat | OpenCode (Code mode) |
|---|---|---|
| Model runs in | TBAi's `streamText` — `src/routes/chat.ts:224` | managed `opencode serve` — `src/services/opencode/serverManager.ts:8` |
| Tool registry | `aiToolkit.tools()` + `mcpManager.getAiTools()` — `src/routes/chat.ts:142-155` | OpenCode's own agents/tools/config |
| Reaches a native TBAi tool? | Yes | **No** |
| Reaches an OpenCode plugin/tool? | **No** | Yes |

Three hard facts:

1. **`/api/chat` refuses OpenCode rows** — `src/routes/chat.ts:79-91` returns 422
   `ENGINE_MISMATCH` for any conversation with `engine === "opencode"`, before run
   creation. TBAi's toolkit is never constructed for a Code conversation.
2. **TBAi's MCP registry is not shared with OpenCode.** `src/services/opencode/`
   contains zero MCP wiring; `src/config/opencode.ts` covers only binary name,
   ports, and timeouts.
3. **This is deliberate and locked** — `AGENTS.md:133-146` (OpenCode isolation
   boundary): TBAi core never imports the OpenCode SDK, and the OpenCode module
   never consumes main-app context.

Consequence: **no single file covers both engines.** What unifies them is a
**shared HTTP endpoint** that both thin adapters call.

---

## 5. Options considered

| Option | Direct | OpenCode | New process | Verdict |
|---|---|---|---|---|
| MCP server, registered twice | via MCP panel | via `mcp.servers` | **Yes** | Rejected — two registries, a second process, no capability gain. **Also disqualified for Goal N:** `buildSchedulerTools()` excludes MCP tools in V1, so a scheduled job could never have used it. |
| **Shared HTTP endpoint + thin adapters** | native tool entry | `.opencode/tools/` or plugin | No | **Chosen** |
| Shell + `curl` | native tool | model runs `curl` | No | Fallback only — untyped, unreliable |
| TBAi-side only (Goal N) | — | — | No | **Chosen for Goal N** — no tool needed at all (§9) |

Note: even the MCP route is cheaper than it looks — `@modelcontextprotocol/server@2.0.0`
is already installed (`package.json:19`). It is rejected on architecture grounds,
not availability.

---

## 6. Target architecture

```
src/services/telegram/send.ts       ← ONE implementation
  · token decrypt (credentialStore.decryptValue)
  · 4096-char chunking
  · markdown → Telegram HTML escaping
  · 429 retry_after backoff + per-chat throttling
        │
        ├──────────────────────────────────────────────┐
        │                                              │
src/routes/telegram.ts                          (Goal T adapters)
  POST /api/telegram/send                          ├─ Direct: entry in src/tools/index.ts
  GET/PUT /api/telegram/config                     └─ OpenCode: ~/.config/opencode/tools/telegram.ts
  POST /api/telegram/test                                 (or a plugin registering a tool)
  GET  /api/telegram/links
        │
        ├─ Goal N, Direct:    hook at scheduler run completion
        ├─ Goal N, OpenCode:  plugin on `session.idle`     (PARKED — §10 W2b)
        └─ Goal C:            src/services/telegram/bot.ts — inbound long polling
```

**Inbound (Goal C)** starts from `startServer()` alongside the existing
`mcpManager.init()` / `initScheduler()` (`src/server.ts:80-110`), gated on
`enabled && token present`. A bad token must never block startup — the same
posture as MCP auto-connect.

**Bot framework.** Two-way is now in scope, which justifies **grammY 1.46.0**
(MIT) for long polling: correct update-offset management, backoff, and 429
handling are exactly what breaks when hand-rolled. `AGENTS.md:45-47` requires a
recorded reason — that is the reason, and it goes in ADR-021. Long polling (not
webhooks) is correct here: TBAi is local-first with no public HTTPS URL, which
webhooks require.

**Placement of the OpenCode artifact.** TBAi's OpenCode server spawns with `cwd`
= `serverHomeDir` (`src/config/opencode.ts:27`,
`src/services/opencode/serverManager.ts:229`), and sessions get a disposable
per-conversation workspace. Project-level `.opencode/` would mean seeding the
file into every workspace — so use the **global** location:

- Tool: `~/.config/opencode/tools/telegram.ts`
- Plugin: `~/.config/opencode/plugins/telegram.ts`
- Dependencies: `~/.config/opencode/package.json` — OpenCode runs `bun install`
  at startup, caching into `~/.cache/opencode/node_modules/`

---

## 7. Data model

Config lives in the existing `app_settings` key/value store
(`src/db/index.ts:47-53`), following the upsert pattern already used by log
settings (`src/services/log-settings.ts:55-61`).

| Key | Value | Notes |
|---|---|---|
| `telegram.config` | `{ enabled, chatId, botUsername, parseMode, notifyOnSchedulerRun }` | **Never contains the token.** Validated by a Zod schema in `src/lib/validation.ts`. |
| `telegram.token` | `encryptSecret(<bot token>)` | Encrypted under the local DEK via `src/services/credentials.ts:146-182`. Same treatment as MCP auth tokens. |

Two-way adds one additive table, following the idempotent pattern at
`src/db/index.ts:420-482`:

```
telegram_links
  chat_id          TEXT PRIMARY KEY
  telegram_user_id TEXT NOT NULL      -- allowlist enforcement
  conversation_id  TEXT               -- NULL until bound
  engine           TEXT               -- 'direct' | 'opencode'; mirrors conversations.engine
  created_at       INTEGER NOT NULL
  updated_at       INTEGER NOT NULL
```

One row per DM in practice (D5), but the table shape is per-chat so `/new` and
`/code` are single-row updates rather than schema changes.

---

## 8. Security model (binding)

1. **Token never reaches the browser.** `GET /api/telegram/config` returns
   `{ enabled, chatId, botUsername, configured: true }` and nothing else —
   mirroring the provider rule (`AGENTS.md:30-37`). The token is decrypted
   in-process only.
2. **Sender allowlist is mandatory for two-way.** A bot token plus a discoverable
   public bot means anyone who finds it can burn API credits and read the
   workspace. Unknown `telegram_user_id` is rejected before any model call.
   **Two-way must not ship without this.**
3. **Outbound is scoped to one configured `chat_id`.** Neither Goal N nor Goal T
   can address an arbitrary recipient — the model cannot choose a target.
4. **Goal T is approval-gated** — added to the `toolApproval` map in
   `src/routes/chat.ts:229-236`, and refused as a stub in `buildSchedulerTools()`
   (`src/services/scheduler/schedulerExecution.ts:59-106`) so unattended runs
   cannot message anyone.
   *Note the gap this closes:* MCP tools are **not** approval-gated in Direct
   chat — `chat.ts:229-236` gates only six native destructive tools. A Telegram
   tool added carelessly would fire with no confirmation.
5. **`docs/security.md` gets a Telegram section** recording the token's storage,
   the allowlist, and that a Telegram message leaves the machine and is stored on
   Telegram's servers — unlike every other TBAi feature, this is **not**
   local-only. That is a material change to the app's privacy posture and must be
   stated plainly.
6. **Duplicate tolerance (accepted).** The scheduler's
   `UNIQUE(job_id, occurrence_id)` claim guard prevents duplicate *runs*, but the
   Telegram send is not idempotent — a crash between send and record can
   double-post. For a daily digest a rare duplicate is acceptable; stated here
   rather than discovered later.

---

## 9. The 9am news job — hook, not tool

For Goal N the send should **not** be a tool call. A tool means the model
decides whether to send; for a fixed daily digest it must **always** fire.

- **Direct:** the run already persists its output (`outputExcerpt` and the
  assistant message — `schedulerExecution.ts:339-353`). A post-run hook pushes
  that text to Telegram. Deterministic, no prompt engineering, no chance of the
  model skipping it.
- **OpenCode:** the plugin's `session.idle` event is the equivalent hook.

Use a tool (Goal T) only for the "tell me mid-conversation if you find something
important" case, where the model genuinely should decide. A tool can be skipped
by the model; a hook cannot.

Consequence to accept: with a shared DM (D6), the 9am digest lands in the same
chat you talk in, while in the app it lives in its own thread
(`dedicated_thread`). That asymmetry is intended.

---

## 10. Phases

### W1 — Send core + config + REST (no AI involvement)

- `src/services/telegram/send.ts` — chunking, HTML escaping, 429 backoff, throttling.
- `src/services/telegram/settings.ts` — `app_settings` read/write, token encrypt/decrypt.
- `src/routes/telegram.ts` — `GET/PUT /api/telegram/config`, `POST /api/telegram/test`, mounted in `src/routes/index.ts:77-97`.
- Zod schemas in `src/lib/validation.ts`.
- `docs/security.md` Telegram section (§8.5).

Acceptance: a message can be sent by hand via `POST /api/telegram/send` with the
token configured through the API; the token never appears in any response body or
log line; `bun run typecheck` + `bun run build` exit 0.
**No new dependency. No AI. No UI.**

### W2 — Settings UI

- `telegram` added to `ViewId` and `SETTINGS_VIEWS` (`web/src/config/navigation.ts:14-27`, `:243-253`).
- One route in `web/src/app/router.tsx:44-57`.
- Page built from the existing grammar — `SettingsPage` / `SettingsSection` / `SettingRow` / `SettingsSaveBar` (`web/src/components/shared/settings.tsx:15-192`).

Acceptance: the user can paste a token, set a chat id, and press Test; the flow is
walked step by step in the report (entry → surface → save → result). No new
dialog, no new nav pattern (`AGENTS.md:247-268`).

### W3 — Goal N: scheduled output to Telegram

- **Direct:** post-run hook at `schedulerExecution.ts:339-353`, gated by `notifyOnSchedulerRun` (§9).
- **OpenCode:** parked with W2b.

Acceptance: a 9am cron job posts its output to the DM; a Telegram failure never
fails the run itself.

### W4 — Goal T: model-driven send

- **Direct:** one entry in `entries` (`src/tools/index.ts:50-169`) calling the send service in-process; one render-only entry in `web/src/tools/toolkit.ts:39-60` with `display: "standalone"`; added to the `toolApproval` map; refused stub in `buildSchedulerTools()`.
- **OpenCode:** `~/.config/opencode/tools/telegram.ts` (filename = tool name) calling `POST /api/telegram/send`. A plugin may instead register the tool *and* the `session.idle` hook in one file, since plugins are a superset.

Acceptance: in **both** engines, asking the AI to send a message delivers it; in
Direct it pauses at the approval card first; in an unattended scheduler run it
refuses.

### W5 — Goal C: two-way DM

- `src/services/telegram/bot.ts` — grammY long polling, started from `src/server.ts:80-110`, gated on enabled + token.
- Allowlist enforcement; `/start` captures and persists `chat_id`.
- `telegram_links` table (§7); `chat_id` → conversation binding.
- `/new` (D7) and `/code` (D8) commands.
- Streaming via `sendMessageDraft`, finalized with `sendMessage`; `editMessageText` fallback.

Acceptance: messaging the bot produces an AI reply in the same DM; an unknown
sender is rejected; `/code` repoints the DM at an OpenCode conversation and the
next message is served by that engine.

### W6 — Docs

`docs/decisions.md` ADR-021 (mechanism choice, engine split, grammY justification,
topology); `docs/architecture.md` layer diagram; `docs/roadmap.md` status.

### W2b — Scheduler → OpenCode (**PARKED**)

The maintainer confirmed the scheduler is Direct-only for now and the OpenCode
integration is still in progress. Scheduled prompts driving an OpenCode session
does **not** work today:

- `SchedulerJob` has no `engine` field (`schedulerTypes.ts:33-59`); a grep for
  `engine` across the scheduler returns **zero matches**.
- `executeJobRun` uses `getModel` + `streamText` + `buildSchedulerTools()`
  unconditionally — the Direct stack.
- `AGENTS.md:133-146` forbids the scheduler importing the OpenCode SDK.

Making it work needs an `engine` field on jobs, a clean call through the OpenCode
module's public API (the SDK prohibition covers the SDK, not the module), and an
ADR amending the isolation boundary.

**Do not plan W2b in detail until the OpenCode integration stabilizes.**

### Standalone bug — missing scheduler engine guard (**independent of Telegram**)

`ensureJobConversation` (`schedulerExecution.ts:214-252`) checks
`conv.status === "archived"` but **never `conv.engine`**. A job pointed at an
OpenCode conversation will therefore write Direct-generated messages into a Code
thread — the exact inconsistency `chat.ts:79-91` guards against on the
interactive path. There is no guard on the scheduler path.

This is a real defect regardless of Telegram and is fixable now, on the Direct
side, without touching OpenCode.

---

## 11. Open questions to verify on disk

1. **Does grammY 1.46.0 expose `sendMessageDraft` in its typings?** It ships
   `@grammyjs/types@5.0.0`; if absent it is a raw `bot.api.raw` call. Confirm
   before W5 rather than during.
2. **Global placement actually loads.** Confirm `~/.config/opencode/tools/` and
   `~/.config/opencode/plugins/` are read for sessions whose directory is a
   disposable workspace, given the server's `cwd` is `serverHomeDir`.
3. **`@opencode-ai/plugin` resolves from a global file.** Docs say a
   `package.json` in the config directory plus startup `bun install` handles it,
   and the plain-object + direct `zod` import is a fallback — confirm empirically,
   since a global file sits outside any `node_modules`.
4. **Which OpenCode build is installed** — config shape differs between versions
   (`mcp.servers` in V2 vs server names directly under `mcp` in older builds).
5. **BotFather forum topic mode** is required for `sendMessageDraft`; confirm it
   is enabled before W5 uses drafts.

---

## 12. Verification

Per phase: `bun run typecheck` → `bun run build` → start `:3000` → the phase's
acceptance scenario run for real. Tests are owned by a separate agent
(`AGENTS.md` "Agent division of labor"); this plan's executor adds no test files
and runs no suites.

Global checks before any commit:
- No token in any response body, log line, or frontend bundle (grep the **built**
  output, not just the source).
- Boundary greps: no `@opencode-ai/*` import outside the global plugin/tool file;
  no Telegram logic in `src/routes/index.ts` (it composes, it does not implement).
- Direct-chat behavior unchanged when Telegram is disabled.
- OpenCode sessions and TBAi rows untouched by Telegram config changes.
- Unknown Telegram sender cannot reach a model call.

## 13. Definition of DONE (mirrors `dual-chat-opencode-plan.md`)

1. Planner disk-review ACCEPTED (paths, boundaries, no stale references).
2. `bun run typecheck` (backend + web) exit 0 AND `bun run build` exit 0,
   independently re-run.
3. Test-agent suite numbers recorded with actual counts.
4. The phase's acceptance scenario demonstrated end to end, with the UI flow
   walked step by step for any UI phase.

---

## 14. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Model sends unprompted (Goal T) | Messages people without consent | Approval gate; refuse in unattended runs (§8.4) |
| Telegram outage / 429 | Failed notification | Best-effort send; never fail the originating run |
| Two-way allowlist gap | Anyone with the bot burns credits, reads workspace | Allowlist mandatory; two-way blocked without it |
| Privacy posture change | Data leaves the machine | Stated explicitly in `docs/security.md` (§8.5) |
| Global OpenCode file not loaded | Goal T silently dead in Code mode | §11.2–11.3 verified before W4 |
| Engine locked per conversation | One DM = one engine | `/code` rebind (D8) |
| Scheduler writes into an OpenCode thread | Silent thread corruption | Standalone bug fix (§10) |
| Long single Telegram thread (D7) | Unwieldy history | `/new` when needed |

---

## 15. References

- Telegram Bot API (current: **10.3**, 2026-08-24) — https://core.telegram.org/bots/api
- `sendMessageDraft` — https://core.telegram.org/bots/api#sendmessagedraft
- OpenCode custom tools — https://opencode.ai/docs/custom-tools/
- OpenCode plugins (events incl. `session.idle`) — https://opencode.ai/docs/plugins/
- OpenCode MCP servers — https://opencode.ai/v2/docs/mcp-servers
- grammY long polling vs webhooks — https://grammy.dev/guide/deployment-types
- grammY `webhookCallback` (adapter list incl. `hono`, `bun`) — https://grammy.dev/ref/core/webhookcallback
