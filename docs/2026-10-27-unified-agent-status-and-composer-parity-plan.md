# Unified Agent Status Pill, Tool Activity Detection & Composer Parity — Implementation Record

**Status:** IMPLEMENTED IN THE WORKING TREE, verified locally; **not committed, not pushed**.
**Branch:** `ci/tauri-e2e-verify`
**Baseline Commit:** `2804f94` — a **child of `2facd38`**. `2facd38` is the commit certified by the
push-triggered CI run `40502847792` (success); the G5 comparison run `40498931974` ran at `8fb8d64`
(success). CI run `40527025056` ran at `2804f94` and **failed only the `tauri` job's "Observe the
packaged WebView origin (G1)" step, for an unclassified cause** — so `2804f94` is **not**
CI-certified and this document makes no such claim. See §8.3.
**Date:** 2026-10-27, corrected 2026-10-29 against the working tree
**Owner:** Architecture / OpenCode & Chat UI Runtime
**Governing plan:** `docs/2026-10-27-status-ownership-and-activity-plan.md` (Rev 16). This document
records **what was built and what was measured**; that plan holds the reasoning and the revisions.
Its claim that this file's original "single unified pill" diagram contradicted its own priority
table is why this version replaces that diagram with the ownership rule in §2.

> **Correction note (2026-10-29).** The 2026-10-27 revision of this document described a plan that
> was **not** what landed: it claimed `(msg.content ?? msg.parts)`, a re-skinned retry banner, a
> 15 s notice, and slot props `aboveComposerExtra`/`belowComposerExtra`, and it printed a test table
> whose numbers could not be reproduced. Every such statement is corrected below against the
> working tree. Where the earlier text asserted something that turned out to be a *different
> defect* (the assistant-message chrome), the discovery is recorded rather than hidden.

---

## 1. Problem inventory — what the defects were, and what actually fixed them

| Area | Defect / symptom | Root cause (verified) | What landed |
|---|---|---|---|
| **Tool activity** | The agent pill stayed on `"Thinking…"` and never showed `"Running…"`, `"Writing…"`, `"Editing…"`. | [useAssistantActivity.ts](file:///D:/Temp/ai-chat-app/web/src/features/chat/hooks/useAssistantActivity.ts) read `lastMessage.parts`, but thread messages carry their parts on **`message.content`**; `.parts` is not a field of the installed message type at all, so the scan always saw an empty list. | The scan reads **`lastMessage.content`** (no `.parts` fallback — see §6.1), through an engine-neutral analyzer with an injected label resolver, newest-part-first. |
| **Tool labels** | OpenCode's terminal tool `"shell"` rendered as a raw tool name; Direct's own `run_command` did too. | One label map served two engines with different tool vocabularies. | Two resolvers: [features/chat/toolActivityLabel.ts](file:///D:/Temp/ai-chat-app/web/src/features/chat/toolActivityLabel.ts) (Direct: `run_command`, file tools, `bash`) and [features/opencode/toolActivityLabel.ts](file:///D:/Temp/ai-chat-app/web/src/features/opencode/toolActivityLabel.ts) (OpenCode: `read/write/edit/patch/shell/bash/execute/glob/grep/websearch/webfetch/skill/subagent/task/question`). |
| **Transcript pollution** | A raw `"retry 3"` appeared as a message bubble next to the retry status. | [v2MessageProjection.ts](file:///D:/Temp/ai-chat-app/web/src/features/opencode/v2MessageProjection.ts) projected `part.kind === "retry"` as text. | Retry **and** step parts return **`null`** (`if (part.kind === "step" \|\| part.kind === "retry") return null;`). They are dropped, not projected as empty text. |
| **Duplicated status surfaces** | In Code mode the Direct pill *and* the OpenCode banners both reported the turn; two rectangular cards sat above the composer. | Two owners for one fact, plus hand-built card markup. | One owner per fact (§2). `OpenCodeRetryBanner.tsx` is **deleted**; its countdown and announcement live in `OpenCodePrimaryStatus`. |
| **Notice presentation** | The reuse notice was a rectangular card. | Custom `rounded-md border … bg-card px-3 py-2` markup. | Re-skinned onto the vendored `AgentStatus` (S5; decision recorded in `docs/decisions.md`, not repeated here). |
| **Heart error coupling** | The connection heart turned red on turn execution / rate-limit errors. | [OpenCodeStatus.tsx](file:///D:/Temp/ai-chat-app/web/src/features/opencode/OpenCodeStatus.tsx) read `state.execution.type === "error"` into its tooltip. | The heart reads connection + load + blocked-recovery **only**; turn errors never reach it. |
| **Layout jump** | Showing/hiding a status changed the composer folder's flow height, moving the transcript and composer. | The pill was a normal-flow child above the `flex-1` transcript. | A reserved status row with a pinned one-line height (§4). |
| **Silent failed turns** *(found during this work, not in the original plan)* | A failed assistant turn rendered **nothing**: no error card, no actions. | Core 0.3.30 emits `message` rows only for user messages (or an assistant message being edited); a normal assistant message becomes **part rows**, and a part-less one emits no rows at all — so `AssistantMessage`, which owns the error card and footer, never mounted. | The chrome is rendered from the row that owns it (§6.3). |

## 2. The governing rule — one owner per status fact

A status fact is presented in exactly **one** surface. This replaces the earlier "single pill"
diagram, which showed the retry countdown and the restore notice as alternatives to the primary and
in doing so contradicted the code.

| Surface | Owns | Never presents |
|---|---|---|
| **Primary pill** — `AssistantStatusPill` (Direct) / `OpenCodePrimaryStatus` (Code), marker `data-primary-status` | the **active turn**: `Stopping…`, engine retry countdown, waiting for approval, running tool, thinking | transport health; session-restoration facts |
| **Connection heart** — `OpenCodeStatus`, in the `below` row | **transport/recovery health** only: `Connected`, `Reconnecting`, `Error`, `Disconnected` | turn errors, rate limits, tool activity |
| **Chat viewport** — `MessagePrimitive.Error` (Direct) / projected message status (OpenCode) | recorded **turn outcomes**: rate limit, missing model, auth, execution failure | live retry countdown; connection health |
| **Restoration notice** — `OpenCodeRecoveryNotice`, marker `data-restoration-notice` | the **verified reuse fact**, plus what the inbox/activity confirm | the primary's label; any claim of "recovered"/"restarted" |

Two consequences that are load-bearing:

- **The primary is suppressed when the heart is presenting** reconnecting, terminal failure, blocked
  recovery, load error, or `off`. `isConnectionHealthy(...)` is the single predicate both read, so
  "the heart is idle" and "the primary may present" are one decision, not two that can drift.
- **The notice never changes the primary count.** It is a sibling pill in the same row and states a
  different fact.

## 3. Presentation contract

### 3.1 One pill anatomy

Every status surface composes the vendored
[agent-status.tsx](file:///D:/Temp/ai-chat-app/web/src/components/assistant-ui/elements/agent-status.tsx)
through its native `state` / `label` / `elapsed` / `trailing` / `className` props. No hand-built
pill markup remains above the composer. `paper` (`bg-background border border-border/60
dark:bg-popover`) is the shared surface.

`AgentStatus` has **no live region** and truncates its label at `max-w-44`, so callers that need to
announce something add a sibling `role="status"` node — they do not stretch the label.

### 3.2 Precedence on a healthy connection

```
cancelling "Stopping…"  >  engine retry  >  approval waiting  >  running tool  >  thinking
```

Implemented in that order in `OpenCodePrimaryStatus`. Direct has no engine retry and no
`cancelling` state, so its pill starts at "running tool". `thread.isRunning` is false while a tool
part is `requires-action`, which is why the Direct pill does **not** present while an approval is
outstanding; Code mode reads `extras.permissions.length > 0` for the approval row.

### 3.3 Retry announcement

The retry row is one `AgentStatus` plus:

- an sr-only `role="status"` node carrying **`Retrying, attempt K`** — one polite announcement per
  **attempt**, because the countdown repaints every `OPENCODE_RETRY_TICK_MS` (500 ms);
- the visible pill marked `aria-hidden`, so the ticking seconds are not re-announced;
- copy derived from the server's **absolute deadline**: `Retrying in Ns` while the deadline is in
  the future, plain **`Retrying`** when it is missing or already passed. No second is ever invented.

### 3.4 Trailing accessibility (S5)

`AgentStatus`'s `data-slot="agent-status-trailing"` wrapper was unconditionally `aria-hidden`, which
would have made a caller-supplied dismiss button focusable but invisible to assistive technology. It
is now hidden **only when the default decorative icon is rendered**; a caller-supplied `trailing`
node is exposed. The default rendering is byte-identical. The notice therefore keeps
`button[aria-label="Dismiss session notice"]`, reachable and announced.

### 3.5 The notice is a reuse fact, not a recovery claim

`reusedExistingSession` is set only when the backend verified and adopted a live session — and an
ordinary navigation back into a conversation looks exactly like a relaunch. The notice therefore has
no boot-id or crash heuristic, never says "recovered"/"restarted"/"reopened", and shows on every
verified reuse. Visible label: **"Session restored"**; the confirmed sentence goes to a polite
live region beside it, so the whole message is announced exactly once.

`OPENCODE_RECOVERY_NOTICE_MS` is **12 000 ms** ([config.ts:116](file:///D:/Temp/ai-chat-app/web/src/features/opencode/config.ts#L116)). The
earlier version of this document said 15 s; that was wrong.

## 4. Layout — the reserved status row (S7a)

### 4.1 Slot API

[ChatWindow.tsx](file:///D:/Temp/ai-chat-app/web/src/components/ChatWindow.tsx) takes one opaque,
engine-neutral object:

```ts
interface ComposerExtras {
  status?: ReactNode;      // transient status presentations, INSIDE the reserved row
  interactive?: ReactNode; // forms/questions, ABOVE the row at natural height
  below?: ReactNode;       // connection heart + chips, in its own row
}
```

`aboveComposerExtra` / `belowComposerExtra` no longer exist. `ChatWindow` imports nothing from
`features/opencode/` or `features/chat/`; `OpenCodeView` supplies the three nodes and the Direct pill
is rendered by `ChatWindow` itself, gated to `mode === "chat"`.

Order, top to bottom: transcript → `interactive` (natural height, never clipped to a pill) →
reserved status row → composer → `below` row. The connection heart stays **outside** the reserved
row; its popover is an out-of-flow overlay, so opening it moves nothing.

### 4.2 The row is always mounted

```
flex flex-wrap items-center gap-2 min-w-0 overflow-x-clip pb-2 min-h-[var(--status-reserved-height)]
```

`--status-reserved-height: 46px` is declared **exactly once** (`web/src/styles/globals.css`) and
consumed **exactly once** (the row); both are asserted by source-scan tests.

### 4.3 Measured geometry

Every `AgentStatus` is **38 px** tall, because its trailing wrapper is always a `size-6` box:
`6 (py) + 24 (wrapper) + 6 (py) + 2 (border)`. That holds for both pills, including the notice after
S5. Hence:

| Case | Row border-box |
|---|---|
| empty, primary only, notice only, both on one line | **46 px** = 38 + 8 (`pb-2`) |
| both pills, wrapped | **92 px** = 38 + 8 (`gap-2` line gap) + 38 + 8 (`pb-2`) |

The plan's historical **84 px** assumed a 30 px hand-built notice; the notice is now a 38 px
`AgentStatus`, so the measured number is 92 px. The browser spec derives it from the measured pills
rather than asserting a literal.

**Widths, measured in Chromium** by
[status-layout-stability.spec.ts](file:///D:/Temp/ai-chat-app/tests/e2e/virtualizer/status-layout-stability.spec.ts):

| Viewport | Row content | Primary pill | Notice pill | Outcome |
|---|---|---|---|---|
| 1280 px | 736 px (`max-w-3xl` − `px-4`) | — | 173.25 px | both on one line, row 46 px |
| 480 px — the product minimum (`tauri.conf.json` `minWidth: 480`) | 176 px | 131.15625 px | 173.25 px | one pill per line, row 46 px alone / 92 px for both |

At 480 px the content box is 176 px, so either pill fits alone but the two cannot share a line; that
is the documented, bounded two-line case. A viewport narrower than 480 px is not a supported product
size (at 320 px the content box is 16 px), so the spec does not pretend to measure it.

## 5. What was deleted, and why nothing replaced it

`OpenCodeRetryBanner.tsx` and `tests/dom/opencode/OpenCodeRetryBanner.test.tsx` are **gone**. The
countdown, its per-attempt announcement and its "no invented seconds" rule moved into
`OpenCodePrimaryStatus`, so deleting the component deleted no behaviour. The eight retry-banner
assertions survive inside the 30-case `OpenCodePrimaryStatus` suite. `OpenCodeRetryBanner` must not be
resurrected: a second surface for the retry fact is the defect this work removed.

## 6. Projection, typing, and message chrome

### 6.1 No `.parts` fallback

The Direct hook reads `lastMessage.content`. The installed `@assistant-ui` message type has no
`parts` field on thread messages, so `(msg.content ?? msg.parts)` was not merely redundant — it
recorded a field that does not exist and would have hidden a future shape change. The parts are
`content`; that is what the hook reads, and `lib/assistantActivityParts.ts` documents the one field
the runtime attaches at run time (`status`), which the published `ToolCallMessagePart` omits on
0.15.30.

### 6.2 Typed activity, not casts

`ActivityPart` states the runtime-attached `status` once; the analyzer branches on the `status`
discriminant. No `as unknown as`. Retry and step parts are dropped in projection (§1), and a typed
execution error is **preserved**: `formatOpenCodeErrorNotice(...)` is mapped onto the last assistant
message as `status: { type: "incomplete", reason: "error", error }`, or onto a new content-empty
assistant message when no assistant message can be named.

### 6.3 The assistant-message chrome fix

Core 0.3.30 turns a normal assistant message into **part rows**, and a part-less message into no
rows, so `AssistantMessage` never mounted for the messages a reader sees. `ChatRow` now renders the
chrome from the row that owns it ([ChatWindow.tsx:342](file:///D:/Temp/ai-chat-app/web/src/components/ChatWindow.tsx#L342)):

- **first** part row → the session timeline;
- **last** part row → the error card + turn footer;
- `turn-end` row → `PartlessAssistantTail`, which self-guards
  (`composer.isEditing || parts.length > 0` → renders nothing) so it cannot duplicate a tail that a
  part row already owns.

`indices` partition a message's parts, so exactly one row satisfies "first" and exactly one satisfies
"last". A one-row message owns both. That yields **one** error card and **one** action bar per turn,
which is what the 11-case `assistant-message-error` suite asserts.

## 7. Component-by-component record

| File | Owner | State |
|---|---|---|
| `web/src/lib/assistantActivityParts.ts` | `lib/` | new — engine-neutral analyzer with injected label resolver |
| `web/src/features/chat/toolActivityLabel.ts` | `features/chat/` | new — Direct resolver |
| `web/src/features/chat/hooks/useAssistantActivity.ts` | `features/chat/` | reads `content`; 1 s elapsed ticker; gated on `thread.isRunning` |
| `web/src/features/opencode/toolActivityLabel.ts` | `features/opencode/` | new — OpenCode resolver (owns `shell`) |
| `web/src/features/opencode/OpenCodePrimaryStatus.tsx` | `features/opencode/` | new — the Code primary (§3.2/§3.3) |
| `web/src/features/opencode/OpenCodeRecoveryNotice.tsx` | `features/opencode/` | re-skinned on `AgentStatus`; 12 s; full sentence in a live region |
| `web/src/features/opencode/OpenCodeRetryBanner.tsx` | — | **deleted** |
| `web/src/features/opencode/OpenCodeStatus.tsx` | `features/opencode/` | turn-error branch removed |
| `web/src/features/opencode/statusView.ts` | `features/opencode/` | healthy → `idle "Connected"`; `off` driven solely by `connection.type` |
| `web/src/features/opencode/v2MessageProjection.ts` | `features/opencode/` | retry/step → `null`; typed error preserved |
| `web/src/features/opencode/OpenCodeView.tsx` | `features/opencode/` | supplies `composerExtras` |
| `web/src/components/ChatWindow.tsx` | `components/` | `ComposerExtras`; reserved row; Direct pill gated to `chat`; row-driven assistant chrome |
| `web/src/components/assistant-ui/elements/agent-status.tsx` | vendored element | `trailing` wrapper no longer hidden for caller nodes |
| `web/src/styles/globals.css` | styles | `--status-reserved-height: 46px` |
| `web/src/features/opencode/config.ts` | `features/opencode/` | `OPENCODE_RECOVERY_NOTICE_MS = 12_000` |

## 8. Verification evidence (2026-10-29, this tree)

### 8.1 Focused suites — re-run today, actual output

| Suite | Layer | Result |
|---|---|---|
| `tests/unit/web/opencode/v2MessageProjection.test.ts` | unit | 19 pass / 0 fail |
| `tests/unit/web/opencode/v2RetryActivity.test.ts` | unit | 27 pass / 0 fail |
| `tests/unit/web/opencode/statusView.test.ts` | unit | 17 pass / 0 fail |
| `tests/unit/web/lib/assistantActivityParts.test.ts` | unit | 8 pass / 0 fail |
| `tests/unit/web/opencode/toolActivityLabel.test.ts` | unit | 7 pass / 0 fail |
| `tests/unit/web/components/assistantActivityMapping.test.ts` | unit | 3 pass / 0 fail |
| `tests/unit/web/chat/toolActivityLabel.test.ts` | unit | 3 pass / 0 fail |
| `tests/unit/tooling/no-orphan-modules.test.ts` | unit | 31 pass / 0 fail |
| `tests/dom/opencode/OpenCodePrimaryStatus.test.tsx` | DOM | 30 pass / 0 fail |
| `tests/dom/opencode/OpenCodeRecoveryNotice.test.tsx` | DOM | 19 pass / 0 fail |
| `tests/dom/components/chat-layout-stability.test.tsx` | DOM | 15 pass / 0 fail |
| `tests/dom/opencode/OpenCodeStatus.recovery.test.tsx` | DOM | 12 pass / 0 fail |
| `tests/dom/components/assistant-message-error.test.tsx` | DOM | 11 pass / 0 fail |
| `tests/dom/components/agent-status-defaults.test.tsx` | DOM | 10 pass / 0 fail |
| `tests/dom/opencode/OpenCodeView.test.tsx` | DOM | 6 pass / 0 fail |
| `tests/dom/components/chat-window-status-pill.test.tsx` | DOM | 2 pass / 0 fail |
| `tests/e2e/virtualizer/status-layout-stability.spec.ts` | E2E (Chromium) | 6 pass / 0 fail / 0 skip |

Totals: **115 unit cases across 8 files**, **105 DOM cases across 8 files**, **6 browser cases**;
0 failures in each group.

The test table in the 2026-10-27 version of this document (3/14/27/17/8/9/6/31 cases) is **retired**:
several rows named suites that no longer exist (the retry banner), and the rest understated the
current files. The numbers above are today's output.

### 8.2 Static gates

`bun run typecheck` (four projects), `bun run lint` (`biome ci --error-on-warnings`) and
`bun run format:check` were run on this tree and exit **0**; lint and format each checked **1062
files** with no fixes applied. The full `bun run verify` chain also exits **0**: `build`,
`test:locations` and `test:quarantine` OK; `test` **5071 pass / 66 skip / 0 fail** (5137 tests
across 381 files); `test:dom` **643 pass / 0 fail** (62 files). The E2E row in §8.1 was re-run in
this environment today — 6 pass / 0 fail, exit 0.

The credential-free G3 live case (status plan §19.5) was run with the same stock tooling and exits
**0**: both cases **PASS**, twice.

### 8.3 CI — what is and is not certified

| Run | Commit | Conclusion |
|---|---|---|
| `40502847792` | `2facd38` | success — the certified baseline |
| `40498931974` | `8fb8d64` | success (G5 comparison, `workflow_dispatch`) |
| `40527025056` | `2804f94` | **failure**: only the `tauri` job's "Observe the packaged WebView origin (G1)" step. **Cause unclassified.** |

- No full-CI claim is made for `2804f94`.
- The **2.2.0 OpenCode pin has not run on GitHub Actions.** The committed workflow at `2804f94`
  pins `OPENCODE_VERSION: "2.1.2"`; the working tree changes it to `2.2.0` with the registry's
  `dist.integrity` as the SHA-512 pin. That pin was verified **locally only**, and on 2026-10-29 the
  check was made exact: the workflow constant, npm's `dist.integrity` for
  `@opencode/cli-windows-x64@2.2.0`, and a fresh download of that tarball are the **same** sha512
  string (`S/eVkz…FkBA==`, 118,650,212 bytes); the tarball contains `package/bin/opencode.exe`; the
  binary reports `opencode v2.2.0`; the seven required runtime suites pass 37 cases; and the two
  workflow tooling guards pass 47/47. See `docs/decisions.md`, "OpenCode 2.2.0 is supported".
- `opencode-native-compaction-conformance` stays excluded from the required set until the 2.2.0 pin
  runs green on CI. Re-run directly against the local 2.2.0 binary on 2026-10-29 it is **8 pass,
  0 fail, 24 assertions** — evidence that the exclusion is not hiding a local defect, and not a
  substitute for the CI run it names.

## 9. Maintenance notes

1. **DOM tests need the preload.** `--preload ./tests/setup/dom-preload.ts` (i.e. `bun run test:dom`);
   without Happy-DOM the render tree does not mount.
2. **Train freeze.** No `@assistant-ui/*` version changed. The vendored element was adapted through
   its existing props (rule 4 of `architectural-principles.md`). The deferred train bump is planned
   in `docs/2026-10-29-assistant-ui-train-upgrade-plan.md`.
3. **No cross-engine imports.** `ChatWindow.tsx` composes opaque nodes only; the Direct pill is
   gated to `mode === "chat"`, so Code mode never reports one turn twice.
4. **Geometry numbers are measured, not asserted from memory.** If a pill's padding or trailing
   wrapper changes, the 46/92 px pair must be re-derived — the E2E spec measures the pills and
   computes the expected row height from them.
5. **The retry announcement and the notice's live region are intentional custom nodes.** The vendored
   `AgentStatus` has no live region; removing them would make the retry and restoration facts
   silent to a screen reader.

## 10. What this document deliberately does not claim

- It does not claim the OpenCode **viewport** error card (an OpenChamber `SessionErrorNotice`
  equivalent). Turn errors reach the OpenCode transcript through projection; a dedicated Code-mode
  error card is a separately authorized follow-up.
- It does not claim layout stability for **interactive** content. Forms keep natural height by
  design; opening one moves the composer, and that is content, not a status jump.
- It does not claim sub-pixel geometry under zoom or non-1× DPI. The E2E tolerance is 1 px at the
  tested viewports.
- It does not claim CI success for `2804f94` or for the 2.2.0 pin (§8.3).
