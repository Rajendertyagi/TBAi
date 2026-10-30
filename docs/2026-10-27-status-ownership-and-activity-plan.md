# Primary Status Ownership, Typed Activity Detection & Turn-Error Separation — Plan & Implementation Record (Rev 20)

**Status:** IMPLEMENTED — S1, S2, S3, S5, S6, S7a are implemented and verified locally, and S7b is
this document. **Committed and pushed to `ci/tauri-e2e-verify` on 2026-10-29**: `8f3f2d2` (2.2.0
pin + turn-facts owner), `38b2d91` (this record), `a170def` (the transcript end-pin fix, §19.8),
`ec15de0` (the G1 observation wait, §19.9) and `3d90d6f` (the teardown classifier, §19.9). **Runs
`40889992913` (`3d90d6f`) and `40892621675` (`7bef5ab`) are green in every job a push runs** —
`verify`, `e2e`, `opencode-runtime`, `opencode-g3` and `tauri`; `e2e-full` and `e2e-big-pickle` are
skipped because they are dispatch-only (a skip is not a pass). The 2.2.0 pin has runner evidence (§19.4 item 2), the
`e2e` job is green with both K-I4 and K-I8 (§19.8), and the `tauri` G1 step now carries a real
observation of the packaged WebView origin from the runner (§19.9). The earlier red runs are kept as
reported in §19.8, not rewritten. One thing this record still does **not** explain: the packaged-app
smoke step's `packaged app did not become ready` at `8f3f2d2` (§19.8), which nothing here claims to
have fixed. See §19.
**Branch:** `ci/tauri-e2e-verify` — **Baseline commit:** `2804f94a0398e8606cd0f109e5694a87a5f5a1d1`
(child of `2facd38`; §19.2)
**Date:** 2026-10-28 (Rev 17 added 2026-10-29; Rev 18 added 2026-10-29; Rev 19 added 2026-10-29; Rev 20 added 2026-10-29)
**Owner:** Architecture / status-presentation + chat & OpenCode features
**Governing docs:** `AGENTS.md` (file ownership, train freeze, test location), `docs/architectural-principles.md` (UI rule 4 — vendored-element adaptations)

**Rev 12 (2026-10-28)** added **§17, a read-only `@assistant-ui/*` upgrade compatibility
review**. **Rev 13 (2026-10-28)** recorded the deferred-upgrade decision and tarball audit.
**Rev 14 (2026-10-28)** clarifies and codifies the three core architectural directives:
1. **Maximize library code & eliminate duplicate custom code:** Explicitly specifies that
   `OpenCodePrimaryStatus` and the re-skinned `OpenCodeRecoveryNotice` directly compose the
   official vendored `@assistant-ui` `AgentStatus` component (`web/src/components/assistant-ui/elements/agent-status.tsx`)
   using its native `state`, `label`, `elapsed`, and `trailing` props. Completely deletes
   custom `OpenCodeRetryBanner.tsx` and eliminates hand-rolled parallel pill markup.
2. **OpenChamber Parity & Complete Heart Decoupling (Viewport vs. Heart vs. Pill, §1, §2, §16.5):**
   Decouples the Heart completely from turn execution. The Heart is strictly server transport/connection
   health (`HeartHandshake` Connected, `HeartPulse` Reconnecting, `HeartCrack` Failed, `HeartOff` Offline).
   It never pulses or cracks for turn errors or rate limits. Instead, turn errors (429 rate limits
   "Limit resets at...", missing models 404, auth failures 401/403, and failed executions) belong in
   the **chat viewport** (`MessagePrimitive.Error` / inline turn error cards per OpenChamber's
   `SessionErrorNotice`/`ErrorResponseDetails` model) and live countdowns belong in the **Primary Status Pill**.
3. **`@assistant-ui/*` Upgrade Evaluation (§17.7):** Explicitly documents why upgrading packages does
   not eliminate custom code or fix OpenCode status, while affirming the deferred-upgrade decision under
   the `AGENTS.md` train freeze.
4. **Rev 14 audit corrections (this update):** three spec defects found by audit and fixed:
   (a) `AgentStatus`'s trailing wrapper is `aria-hidden` — an interactive dismiss button placed
   inside it is invisible to assistive technology; S5's re-skin must either remove `aria-hidden`
   from the wrapper or render the dismiss button outside the trailing slot (with a unit test proving
   the dismiss is announced).
   (b) The reserved-row height spec mixes content-box (38 px) and flow-box (46 px) — the row's own
   border-box is the single number the test asserts (`H_status` = 46 px one-line / **92 px two-line**
   after S5 — this line said 84 px; §19.2), i.e. pill content + 8 px spacing inside the row box).
   (c) The OpenCode viewport-error requirement was ambiguous — now explicitly out of S1–S7b scope;
   it is a separately-authorized follow-up (Direct already has it via `MessagePrimitive.Error`).

**Rev 15 (2026-10-28)** is an implementation-readiness audit against the working tree at
`2804f94` and the installed `@assistant-ui` type graph. It adds **§18** and corrects eight
defects that would fail on landing: two missed test consumers of deleted/renamed code
(§18.1–18.2), four existing `statusView` cases that encode the behaviour S3 reverses
(§18.3), the notice re-skin's live-region/truncation conflict (§18.4), the undefined
Code-mode approval source (§18.5), the retry announcement the vendored element cannot
provide (§18.6), the unmeasured width budget and the non-existent welcome status surface
(§18.7), and the 38-vs-46 contradiction in `--status-reserved-height` (§18.8). It also
records the assistant-ui docs study as a §16.4 addendum. Nothing below was implemented;
no gate was run.

**Rev 16 (2026-10-29)** records the implementation as landed in the working tree and the one
measurement that contradicted this plan. It **supersedes every "84 px two-line" number in the
Rev 11–15 text**: the two-line reserved row is **92 px**, because S5 re-skinned
`OpenCodeRecoveryNotice` onto `AgentStatus`, and `AgentStatus` always renders its `size-6`
trailing wrapper (`6 + 24 + 6 + 2` border = **38 px**) whether or not a trailing node is
supplied. The old 84 px assumed a 30 px hand-built notice. Measured in the browser by
`tests/e2e/virtualizer/status-layout-stability.spec.ts`: one line **46 px**, wrapped **92 px**,
narrow row content **176 px** at the product's `minWidth: 480`. The `OpenCodeRetryBanner` and
its 30/32 px figures are moot — the file was deleted in S3. §19 is the implementation record.

This plan supersedes the "single unified pill" section of
`docs/2026-10-27-unified-agent-status-and-composer-parity-plan.md`, whose diagram
contradicted its own priority table. Rev 7 is unchanged in substance. **Rev 8** added the
layout-stability concern (§15) and stage **S7a**, renumbering old S7→S7b; **Rev 9 refines §15
before implementation authorization:** it splits **transient status presentations** from
**interactive content** (`OpenCodeQuestions`/forms keep natural height and are never clipped
to the pill), pins the **exact reserved region** in Direct and Code mode, adds **responsive
narrow-viewport** behavior and a **dedicated draft/welcome treatment**, and tightens the
geometry tests. It keeps S3 the atomic ownership handoff and S7a the separate layout stage,
and deliberately does **not** fold in OpenChamber features (model-prefixed labels,
background-work controls, de-churning) nor reset-time parity (§16.3; §5). **Rev 10**
committed one concrete final layout for S7a (§15.2a): a single opaque `composerExtras`
object, a reserved-height *status* row, and the connection heart staying **outside** the
row. **Rev 11** re-evaluates that row's height against the real components and commits
a **one-line `min-height` reserved row** (38 px content / 46 px incl. spacing) that
grows to two lines **only** in the narrow-both-present case, with the measured space
budget, the clipping/growth/overflow/overlap test definitions, and the extended
acceptance criteria (§15.2a.4/5). **§15.2a.4** also records a grounding check against
OpenChamber's *actual* layout (its pill is an absolute floating overlay, `ChatContainer.tsx:1921-1941`;
TBAi deliberately does **not** adopt that — the reserved row is the in-flow counterpart,
and OpenChamber's zero-flow-cost floating design does not transfer a height number to TBAi).
**§16** remains the non-normative OpenChamber agent-status-pill reference matrix (state /
when / what / display), recorded so TBAi can borrow phrasing and priority ordering
without adopting OpenChamber's floating-overlay layout or runtime.

---

## 1. Governing rule

**One primary status presentation per active runtime. A fact is owned by exactly one surface.**

- **Primary pill (`data-primary-status`)** = active turn execution: cancellation "Stopping…", engine retry countdown (`Retrying in Ns (attempt K)`), running tool, approval-waiting, thinking. Both Direct and Code modes compose directly onto the official vendored `@assistant-ui` `AgentStatus` component (`web/src/components/assistant-ui/elements/agent-status.tsx`) using its native `state`, `label`, `elapsed`, and `trailing` props. Custom duplicate banner markup (such as `OpenCodeRetryBanner.tsx`) is eliminated.
- **Connection heart (`OpenCodeStatus`)** = transport/recovery health **only**: reconnecting, terminal connection failure, blocked recovery, load error, disconnected/off. It is strictly decoupled from turn-level errors (rate limits, missing models, execution failures). The heart never pulses or cracks for turn failures or quota hits.
- **Chat viewport (`MessagePrimitive.Error` / inline turn cards)** = recorded turn-level outcomes: provider rate limits (429 "Usage limit reached. Resets at HH:MM"), missing models (404), API key auth failures (401/403), and unhandled command failures. These live in the chat transcript where the conversation is read, matching OpenChamber's `SessionErrorNotice` / `ErrorResponseDetails` model.
- **Primary is suppressed whenever the heart is presenting** reconnecting / terminal failure / blocked recovery / load error / disconnected-off.
- **Restoration notice (`OpenCodeRecoveryNotice`)** = contextual session state; re-skinned onto the official vendored `AgentStatus` with its native `trailing` dismiss button. May coexist with the primary, never restates its active label.

## 2. Health definition — transport/recovery only, cancellation excluded

```
healthy :=
  connection.type === "connected"
  && load.type !== "error"
  && revertRecovery.type !== "blocked"
```

No `!cancelled` term. A `cancelling` execution on a connected transport leaves the transport healthy: **heart shows `idle "Connected"`**. The **primary** owns cancellation: it renders `working "Stopping…"` (top of the intra-primary precedence), not suppressed and not blank.

**Primary-suppressed (health-presentation) set:** `reconnecting`, terminal `failed`, `blocked` recovery, `load.error`, **`off`/disconnected**. `load.loading`/`reconciling` on a healthy transport do **not** suppress the primary.

### 2b. `off` / disconnected (verified against the runtime contract)
`statusView.ts:138-145` returns `off "Disconnected"` when `connection.type !== "connected"` **or** `cancelled`. The `|| cancelled` clause is **removed**: `off` is driven solely by `connection.type !== "connected"` (`waiting-for-server` at `v2Events.ts:1342`, `closed` at `v2Types.ts:193`). A cancelling execution on a connected transport is **not** "Disconnected."

## 3. Atomic ownership handoff + the staged invariant (corrected, Rev 7)

The entire ownership transfer is **one stage (S3), one diff**. The baseline `2804f94`
**already** has the duplicated-presentation defect (the Direct pill and the OpenCode
banners both present Code-mode status, and the heart presents `retrying`/`working`).
The invariant is therefore staged, not global:

- **S1–S2: preserve existing behavior, introduce no new regression.** S1 extracts the
  pure scanner to `lib/` and keeps the Direct resolver behaviorally intact (including the
  temporary `shell` entry, §4); S2 adds the OpenCode resolver. Neither touches the
  heart, the pill gate, or the banner. No S1–S2 commit *adds* a duplicated fact.
- **S3 atomically resolves the existing defect.** It is the single transition to the
  compliant model (below).
- **After S3, every subsequent stage (S5, S6, S7) must preserve the invariant.** They
  touch presentation geometry, projection, and docs only — none re-introduces a fact in
  two surfaces.

S3 does **all** of the following in a single commit, so no committed state renders a
fact in two surfaces:
1. Gate the Direct pill to `mode === "chat"` in `ChatWindow.tsx` (+ `data-primary-status` on its wrapper).
2. Introduce `OpenCodePrimaryStatus` (cancelling "Stopping…" + retry + activity + approval + thinking; §2 precedence; §5 timing).
3. **Delete `OpenCodeRetryBanner`** and its source-text guard line; move countdown/announcement into the primary.
4. **`statusView.ts`**: healthy branch → `idle "Connected"` (drop the `retrying`/`working` heart presentations); remove the `cancelled`→`off` coupling (§2b).
5. **Add `data-restoration-notice` to the existing `OpenCodeRecoveryNotice.tsx` wrapper** (one-line change; no styling/copy/dismissal/lifetime change) **and add the coexistence + no-duplicate-label assertions in the same stage** (§7, §11).
6. **Delete the S1 temporary `shell` compatibility entry** from `features/chat/toolActivityLabel.ts`, and **retire its S1 temporary-entry unit assertion** (§4); Code mode no longer routes through the Direct pill. `execute` and `patch` leave the Direct mapping in the same edit — no Direct tool declares either name (§18.9).
7. **Sweep the two test consumers of the code S3 deletes or renames**, and **rewrite the four `statusView` cases that assert the old heart contract**:
   - `tests/unit/web/components/assistantActivityMapping.test.ts:3,21-25` imports `getToolRunningLabel` from the hook and asserts `shell`/`bash`/`execute` (§18.1).
   - `tests/dom/opencode/OpenCodeRecoveryNotice.test.tsx:58,244` imports and renders `OpenCodeRetryBanner` in the coexistence case (§18.2).
   - `tests/unit/web/opencode/statusView.test.ts:85,92,115,125` assert "load/run in flight = working" and "retry = retrying" — the exact behaviour S3 reverses. Removing or rewriting them carries the evidence note in §18.3.

**The separate runtime S4 is removed** — its content is in S3.

## 4. Staged label migration — no Code-mode regression (behavioral test, Rev 7)

`shell` is rendered in Code mode today via the Direct pill (`useAssistantActivity.ts:27`).

- **S1** extracts the scanner to `lib/` and moves the *mapping* into the **Direct resolver** `features/chat/toolActivityLabel.ts`, **retaining `shell` as a documented, temporary compatibility entry.** The comment is for maintainers: *"temporary — OpenCode Code-mode still routes tool labels through the Direct pill until the S3 atomic handoff; delete this entry when S3 lands."*
- **S1 test is behavioral, not comment-inspecting:** `tests/unit/web/chat/toolActivityLabel.test.ts` asserts **`toolActivityLabel("shell")` returns the running verb** (and the other Direct names map correctly). It does **not** assert that the source contains a comment or a "temporary" marker.
- **S2** adds the OpenCode resolver `features/opencode/toolActivityLabel.ts` (the real owner of `shell`/`execute`/`patch` → `toolsConfig` verbs), tested in `tests/unit/web/opencode/toolActivityLabel.test.ts`.
- **S3 (deletion point, stated exactly):** delete the `shell`, `execute`, and `patch` entries from `features/chat/toolActivityLabel.ts` — Direct declares none of the three (`src/tools/index.ts:210-384`: `read_file`, `write_file`, `edit_file`, `run_command`, `list_dir`, `search_files`, `file_info`, `delete_file`, `process_list`, `process_kill`, `system_info`, `scheduler`, `todo`, `browser`, `browser_action`) — **retire its S1 temporary-entry assertion** (the `"shell"` case in `tests/unit/web/chat/toolActivityLabel.test.ts`), and **update the existing mapping test** `tests/unit/web/components/assistantActivityMapping.test.ts` (import + `shell`/`execute`/`patch` cases, §18.1). **Retain a Code-mode DOM test** in `tests/dom/opencode/OpenCodePrimaryStatus.test.tsx` proving that, **after the handoff, the OpenCode resolver supplies the correct running label for a running `shell` tool** (count 1 + correct verb). This is the preservation guard for the Code-mode label.
- **Named pre-existing gap, not silently preserved:** the Direct mapping never mapped Direct's own `run_command` (the workspace shell tool, `src/tools/index.ts:256`), so a running command in Direct currently reads `"run_command…"`. S1 is behaviour-preserving and **keeps** that; S3 must either map the real Direct names via `toolsConfig` or record the gap as deferred (§18.9). It must not present the old mapping as the Direct contract.
- **No stage claims S1 is Code-mode behavior-preserving.** S1 is Direct-mode behavior-preserving; Code-mode label preservation is explicitly S3's responsibility, guarded by the S3 DOM test. Fallback: S1+S3 atomic.

## 5. Elapsed-time decision (unchanged)
- **Direct:** keeps its 1-second `elapsed` ticker; `activityFromParts` returns `{state,label}` only; the Direct hook adds elapsed. Byte-for-byte unchanged.
- **OpenCode:** **no per-second ticker** on activity rows; the retry row = server-deadline countdown (`OPENCODE_RETRY_TICK_MS` 500 ms repaint, one-announcement-per-attempt, `aria-hidden` countdown, no invented seconds); the cancellation "Stopping…" row has **no elapsed**.

## 6. Tool-label ownership (unchanged)
`lib/assistantActivityParts.ts` engine-neutral with an **injected** `toolLabel`. Direct resolver in `features/chat/` (Direct names via `toolsConfig`; `shell` only as the S1 temp entry). OpenCode resolver in `features/opencode/` (real home of `shell`/`execute`/`patch`; **`shell` not in `config/tools.ts`**).

## 7. Unambiguous DOM markers (corrected sequencing, Rev 5/6 — unchanged)

| Element | Wrapper marker |
|---|---|
| `OpenCodePrimaryStatus` (primary) | `data-slot="agent-status"` **`data-primary-status`** |
| Direct `AssistantStatusPill` (primary) | `data-primary-status` |
| `OpenCodeRecoveryNotice` (contextual) | `data-slot="agent-status"` **`data-restoration-notice`** |

- **`data-primary-status`** ⇒ unambiguous primary count; introduced in **S3** with `OpenCodePrimaryStatus`.
- **`data-restoration-notice`** ⇒ the notice is identified **exclusively** by this marker, never by a negated agent-status selection. **Introduced in S3** (one line on `OpenCodeRecoveryNotice.tsx:80-86`, no other change), **not** S5.
- **Coexistence + no-duplicate-label assertions are added in S3**, selecting the notice via `[data-restoration-notice]` and the primary via `[data-primary-status]`.
- **S5 (presentation-only follow-up)** re-skins the notice onto `AgentStatus` and **preserves** `data-restoration-notice`; it does **not** introduce the marker.

**Primary-count fixtures:**
- **count = 1**: active-healthy Code mode (cancelling "Stopping…" / retry / running tool / approval / thinking; transport connected, no load error, no blocked recovery).
- **count = 0**: idle; reconnecting; terminal failure; blocked recovery; load error; **off/disconnected**.
- **Restoration notice never changes the count.** **No-duplicate-label**: for each active-healthy fixture, the element matching `[data-restoration-notice]` contains none of that fixture's primary labels (tool verb, "Retrying in Ns", "Stopping…").

## 8. Test placement (verified paths; no `tests/dom/chat/`)
| Test | Verified location |
|---|---|
| `activityFromParts` (pure, engine-neutral) | `tests/unit/web/lib/assistantActivityParts.test.ts` |
| Direct `useAssistantActivity` (ticker, running gate) | `tests/unit/web/chat/useAssistantActivity.test.ts` |
| Direct resolver (**behavioral**: `toolActivityLabel("shell")` → running verb; other Direct names) — the S1 temp entry is asserted behaviorally, not by source comment | `tests/unit/web/chat/toolActivityLabel.test.ts` |
| **Direct mapping (existing, missed by Rev 14)** — `getToolRunningLabel` import and the `shell`/`bash`/`execute` cases | update `tests/unit/web/components/assistantActivityMapping.test.ts` (§18.1) |
| **Recovery-notice coexistence (existing, missed by Rev 14)** — imports and renders the retry banner | update `tests/dom/opencode/OpenCodeRecoveryNotice.test.tsx:58,244` (§18.2) |
| OpenCode resolver (`shell`/`execute`/`patch` → verbs) | `tests/unit/web/opencode/toolActivityLabel.test.ts` |
| `OpenCodePrimaryStatus` DOM (countdown, one-announcement, **`data-primary-status` + `data-restoration-notice`**, §7 count fixtures, "Stopping…", **Code-mode shell label via the OpenCode resolver**, **coexistence + no-duplicate-label via the markers**) | `tests/dom/opencode/OpenCodePrimaryStatus.test.tsx` |
| `ChatWindow` engine-gate DOM (marker present in `chat`, absent in `agent`) | `tests/dom/components/chat-window-status-pill.test.tsx` |
| `statusView` unit (healthy→`idle`; `off` decoupled from `cancelled`; §2/§2b rows) | **rewrite** the four old-contract cases at `:85`, `:92`, `:115`, `:125` + extend `tests/unit/web/opencode/statusView.test.ts` (§18.3) |
| Rendered heart DOM (cancelling ⇒ "Connected" not "Disconnected"; off decoupled) | extend `tests/dom/opencode/OpenCodeStatus.recovery.test.tsx` |
| Execution-error / heart separation (preserved) | `tests/dom/opencode/OpenCodeStatus.recovery.test.tsx` |
| Retry/step projection (no blank, no raw "retry N") | extend `tests/unit/web/opencode/v2MessageProjection.test.ts` (+2) |
| `AgentStatus` props-only surface guard (`state`/`label`/`elapsed`/`trailing`/`className`; no new props, §16.4) | **new** `tests/unit/web/components/agent-status-defaults.test.ts` — the file does not exist at `2804f94` (§18.10) |

`bun run test:locations` remains mandatory; every path passes it.

## 9. Complete priority matrix

**Health:** `connected && !load.error && !revertRecovery.blocked`. **Primary-suppressed:** reconnecting, terminal failed, blocked recovery, load error, off/disconnected.

| State (transport/recovery) | Heart (`statusView`) | Primary pill | count |
|---|---|---|---|
| Reconnecting | `working "Reconnecting (K of M)"` | **suppressed** | 0 |
| Terminal connection failure | `error "Error"` + Reconnect | **suppressed** | 0 |
| Blocked recovery | `error "Error"` + Retry recovery | **suppressed** | 0 |
| Load error | `error "Error"` | **suppressed** | 0 |
| **Disconnected / off** (`waiting-for-server` or `closed`) | `off "Disconnected"` | **suppressed** | 0 |
| **Cancelling execution, transport connected** | **`idle "Connected"`** | `working "Stopping…"` | 1 |
| Engine retry, healthy conn | **`idle "Connected"`** | `retrying "Retrying in Ns (K)"` / `"Retrying"` | 1 |
| Running tool, healthy conn | **`idle "Connected"`** | `working` + latest tool verb (no elapsed) | 1 |
| Waiting approval, healthy conn | **`idle "Connected"`** | `waiting "Waiting for approval…"` | 1 |
| Thinking, healthy conn | **`idle "Connected"`** | `working "Thinking…"` | 1 |
| Idle, healthy conn | `idle "Connected"` | **none** | 0 |
| Load in flight (`loading`/`reconciling`), healthy transport | `idle "Connected"` | **not suppressed** | 0/1 |

**Intra-primary precedence (healthy conn):** **cancelling "Stopping…"** **>** engine retry **>** approval-waiting **>** running tool **>** thinking. **Count rule:** `1` iff an active-healthy row; `0` otherwise; restoration-notice presence never changes it.

## 10. Stages, dependencies, files (corrected, Rev 7; final S7a layout Rev 10 §15.2a)

| Stage | Concern | Depends on | Files / tests |
|---|---|---|---|
| **S1** | `lib` analyzer + Direct hook rewrite + **temporary `shell` compatibility entry** (retained, documented; **behaviorally tested**) | — | new `web/src/lib/assistantActivityParts.ts`; change `web/src/features/chat/hooks/useAssistantActivity.ts`; new `web/src/features/chat/toolActivityLabel.ts` (**with temporary `shell` entry + maintainer comment**); tests `tests/unit/web/lib/assistantActivityParts.test.ts`, `tests/unit/web/chat/useAssistantActivity.test.ts`, `tests/unit/web/chat/toolActivityLabel.test.ts` (**behavioral: `toolActivityLabel("shell")` → running verb; no comment inspection**); **update the existing import** in `tests/unit/web/components/assistantActivityMapping.test.ts:3` if `getToolRunningLabel` moves out of the hook (§18.1) |
| **S2** | OpenCode tool-label resolver (real `shell` owner) | S1's signature | new `web/src/features/opencode/toolActivityLabel.ts`; `tests/unit/web/opencode/toolActivityLabel.test.ts` |
| **S3 (atomic — one diff)** | **Full ownership handoff** — resolves the existing defect: gate Direct pill to `chat`; **new `OpenCodePrimaryStatus`** (incl. "Stopping…"); **delete `OpenCodeRetryBanner`** + guard line; **`statusView.ts` healthy→`idle`, remove `cancelled`→`off` coupling**; **add `data-restoration-notice` to `OpenCodeRecoveryNotice.tsx` wrapper** + coexistence/no-duplicate-label assertions; **delete the S1 temp `shell` entry and retire its S1 unit assertion; retain the Code-mode DOM label test** | S1, S2 | change `ChatWindow.tsx`; new `web/src/features/opencode/OpenCodePrimaryStatus.tsx`; change `OpenCodeView.tsx:328`; **change `OpenCodeRecoveryNotice.tsx` (add `data-restoration-notice` only)**; delete `OpenCodeRetryBanner.tsx`; change `statusView.ts`; **remove `shell`/`execute`/`patch` from `features/chat/toolActivityLabel.ts`** and **drop the `"shell"` case from `tests/unit/web/chat/toolActivityLabel.test.ts`**; update `tests/dom/opencode/OpenCodeView.test.tsx:54-79`; move `OpenCodeRetryBanner.test.tsx` → `tests/dom/opencode/OpenCodePrimaryStatus.test.tsx` (+ §7/§2/§2b fixtures incl. "Stopping…", **"Code-mode shell label via OpenCode resolver"**, coexistence + no-duplicate-label via the markers); new `tests/dom/components/chat-window-status-pill.test.tsx`; **rewrite** the four old-contract cases in `tests/unit/web/opencode/statusView.test.ts` (`:85`, `:92`, `:115`, `:125`) + add §2/§2b rows; extend `tests/dom/opencode/OpenCodeStatus.recovery.test.tsx` (heart DOM); **update the two missed consumers** `tests/unit/web/components/assistantActivityMapping.test.ts` (import + `shell`/`execute`/`patch` cases) and `tests/dom/opencode/OpenCodeRecoveryNotice.test.tsx` (`:58,244` — coexistence renders `OpenCodePrimaryStatus` instead of the banner); **approval source = `extras.permissions`** (§18.5); **retry announcement = an sr-only live region** inside the primary (§18.6) |
| **S4** | *removed* — content is in S3 | — | (none) |
| **S5 (presentation-only)** | vendored `AgentStatus` `trailing` node (the dismiss/action; **no new `icon`/`action` props — see §16.4**) + **re-skin the restoration notice onto `AgentStatus`, preserving `data-restoration-notice` — subject to the §18.4 decision** (shorten the copy + keep a live region, or retain the hand-built notice as a documented exception, because the sentence exceeds `max-w-44` and the vendored element has no `role="status"`) + **the notice's dismiss button must remain announced to assistive tech: `AgentStatus`'s `data-slot="agent-status-trailing"` wrapper is `aria-hidden`, so either remove that `aria-hidden` when an interactive `trailing` is supplied or place the dismiss button outside the trailing slot** (§1.4(a)) | — | change `elements/agent-status.tsx` (add a `trailing` dismiss node; it already accepts `trailing` — + **new** `tests/unit/web/components/agent-status-defaults.test.ts`, **incl. an assertion that an interactive `trailing` is NOT inside an `aria-hidden` subtree**); re-skin `OpenCodeRecoveryNotice.tsx` (**marker already present from S3; S5 keeps it, does not introduce it**; **decide §18.4 first** — if re-skinned, add an explicit live region and a copy/width cap, and assert the full sentence is reachable); `docs/decisions.md`; **no** `@assistant-ui/*` version change (§16.4: the runtime-bound `TaskTray`/`useTaskSummary` lane is out of scope — frozen train) |
| **S6** | retry/step projection exclusion | — | change `v2MessageProjection.ts`; `tests/unit/web/opencode/v2MessageProjection.test.ts` +2 |
| **S7a** *(new, Rev 8; layout final Rev 10–11, §15.2a)* | **chat layout stability: reserved-height *status* row** — single committed `composerExtras` object (`{ status?, interactive?, below? }`); the reserved row holds **status presentations only** (Direct pill, `OpenCodePrimaryStatus`, `OpenCodeRecoveryNotice`); **interactive content (`OpenCodeQuestions`/forms) stays natural-height above the row**; the **connection heart stays outside** the reserved row (constant-height `below` row; its popover is an out-of-flow overlay, asserted shift-free); **one-line `min-height` `H_status` (38 px) that grows to two lines only in the narrow-both-present case** (§15.2a.4), `--status-reserved-height` pinned by the geometry test | S3, S5 | change `web/src/components/ChatWindow.tsx` (replace `aboveComposerExtra`/`belowComposerExtra` with the `composerExtras` object; new one-line reserved status row; Direct pill rendered into it; interactive above the row; heart in its existing row); change `web/src/features/opencode/OpenCodeView.tsx` (supply `composerExtras` with `interactive` = `OpenCodeQuestions`, `status` = `OpenCodePrimaryStatus` + `OpenCodeRecoveryNotice`, `below` = `OpenCodeStatus`); ~~change `web/src/features/chat/components/WelcomeScreen.tsx`~~ — **dropped**: no status pill renders in the welcome branch (`ChatWindow.tsx:201-204`), so there is no defect to fix (§18.7); reinstate only if a status surface is added there; tests `tests/dom/components/chat-layout-stability.test.tsx` (or extended `chat-status-pill.test.tsx`) + `tests/e2e/virtualizer/status-layout-stability.spec.ts`, **including a measured pill-width assertion for the both-present case** (§18.7) — see §15.2a, §15.3 |
| **S7b** | plan-doc correction (was S7) | all | `docs/2026-10-27-unified-agent-status-and-composer-parity-plan.md` (§13 list) + record this rev-8 plan |

**Staged invariant (Rev 7):** S1–S2 preserve existing behavior and introduce **no new** duplicated-fact regression; **S3 atomically resolves the existing defect**; **after S3, S5/S6/S7a/S7b preserve the invariant** (presentation/projection/layout/docs only). No stage after S3 renders a status fact in two surfaces.

**Landing order (Rev 11):** S1 → S2 → **S3 (atomic)** → S5 → S6 → **S7a** → S7b. S1–S2 compile/test independently. S3 is the single indivisible ownership diff (**not** broadened by the layout work). S5/S6 independent. **S7a is the new one-concern layout-stability stage, kept separate from S3, implementing the final §15.2a layout (the single `composerExtras` object, the one-line `min-height` reserved status row that grows to two lines only in the narrow-both-present case (§15.2a.4), and the heart staying outside the row), tested against the post-S5 structure.** S7b last.

## 11. Acceptance criteria

**Status of this checklist (Rev 16, §19):** every item that is observable in code or tests is met,
with the evidence in §19.3. Two items depend on external systems and remain **open**: CI
certification of this tree, and the 2.2.0 pin running on a GitHub Actions runner (§19.4). The boxes
are left as originally written so this still reads as the contract it was, rather than a list edited
after the fact.

- [ ] **Staged invariant stated accurately (§3/§10):** S1–S2 preserve behavior without a new regression; S3 atomically resolves the existing defect; every stage after S3 preserves the invariant.
- [ ] **Health excludes cancellation** (§2): no `!cancelled` in the predicate; cancelling on a connected transport leaves heart `idle "Connected"` (unit: `statusView` healthy+cancelling ⇒ `idle`; DOM: `OpenCodeStatus` renders "Connected", not "Disconnected").
- [ ] **`off` covered** (§2b): `statusView` `off` driven solely by `connection.type !== "connected"` (the `|| cancelled` clause removed); "Disconnected ⇒ primary suppressed (count 0)" asserted for `waiting-for-server` and `closed`.
- [ ] **Cancellation defined**: while `cancelling` on a connected transport, primary `working "Stopping…"` (count 1); precedence "Stopping… > retry > approval > running > thinking" pinned; on settle the primary re-derives. Unit + DOM cases.
- [ ] **Atomic S3**: Direct-pill gate + `OpenCodePrimaryStatus` + `OpenCodeRetryBanner` deletion + `statusView` healthy/`off`/cancellation change + **`data-restoration-notice` added** + coexistence/no-duplicate-label assertions + **temp-`shell` deletion + S1 temp-entry assertion retired** + **Code-mode DOM label test retained**, **one diff**; no separate runtime S4.
- [ ] **Temporary-shell test is behavioral (§4/§11):** S1's `tests/unit/web/chat/toolActivityLabel.test.ts` asserts `toolActivityLabel("shell")` → the running verb (no source-comment inspection); S3 deletes the `shell` entry and retires that S1 assertion; the Code-mode DOM test in `tests/dom/opencode/OpenCodePrimaryStatus.test.tsx` proves the OpenCode resolver supplies the correct running label after the handoff.
- [ ] **Typed activity**: no `as unknown as`/`.parts`; typed `status` discriminant; `shell` not in `config/tools.ts`; OpenCode resolver owns `shell`.
- [ ] **Precedence**: approval > running > thinking; cancellation (then retry) above all activity rows on a healthy connection.
- [ ] **Timing**: Direct keeps its 1s elapsed ticker; OpenCode activity has no ticker; retry row = deadline countdown (500 ms interval, one-announcement-per-attempt, `aria-hidden`, no invented seconds); cancellation row has no elapsed.
- [ ] **Marker sequencing agrees**: `data-restoration-notice` added in **S3** (one line, no styling/copy/dismissal/lifetime change) with its coexistence + no-duplicate-label tests in S3; **S5 re-skins the notice and preserves the marker, not introducing it**. `data-primary-status` (primary only) and `data-restoration-notice` (notice only) are the sole selectors for counting/notice-identification; `data-slot="agent-status"` is geometry-only. Count = 1 for active-healthy, 0 for idle/reconnecting/failed/blocked/load-error/**off**; notice presence never changes the count.
- [ ] **Heart/primary boundaries**: healthy-heart source of truth is `statusView.ts` (unit) **and** the rendered heart is asserted in `OpenCodeStatus.recovery` DOM; execution-error omission preserved.
- [ ] **Projection**: retry/step parts excluded from content — no blank bubble, no raw "retry N"; existing 14 projection cases unchanged.
- [ ] **Frozen train / docs / CI**: `AgentStatus` surface is **`state`/`label`/`elapsed`/`trailing`/`className`** (the vendored props-only variant; **no new `icon`/`action` props — §16.4**); S5 adds a `trailing` dismiss node and re-skins the notice onto it; **the notice's dismiss button is NOT hidden from assistive tech** — `AgentStatus`'s `data-slot="agent-status-trailing"` wrapper is `aria-hidden` (`agent-status.tsx:63-67`), so an interactive `trailing` must either have that `aria-hidden` removed when a node is supplied, or the dismiss button rendered outside the trailing slot; a unit test asserts the dismiss is announced (not inside an `aria-hidden` subtree); **no `@assistant-ui/*` version change** (the runtime-bound `TaskTray`/`useTaskSummary` lane in the docs is out of scope under the train freeze); doc corrections applied; **CI `40527025056` G1 packaged-WebView failure recorded as UNCLASSIFIED, no full-CI certification.**
- [ ] **Consumer sweep (Rev 15, §18.1/18.2):** `tests/unit/web/components/assistantActivityMapping.test.ts` and `tests/dom/opencode/OpenCodeRecoveryNotice.test.tsx` are in the S3 diff and green; no test imports a deleted module or an unmapped name.
- [ ] **Status-view churn is explicit (§18.3):** the four cases at `statusView.test.ts:85/92/115/125` are rewritten (or removed with the evidence note recorded in the commit message); the remaining 9 cases are unchanged; new §2/§2b cases are added.
- [ ] **Code-mode approval source defined (§18.5):** the primary's "Waiting for approval…" derives from `extras.permissions.length > 0`, coexists with the `ApprovalCard`s, and adds no second approval control.
- [ ] **Retry announcement (§18.6):** one `role="status"` announcement per attempt from an sr-only node inside `OpenCodePrimaryStatus`; the countdown is `aria-hidden`; the vendored `AgentStatus` itself is unchanged for this.
- [ ] **Notice re-skin decision recorded before S5 (§18.4):** either shortened copy + live region + full-sentence accessibility, or a documented exception retaining the hand-built notice. The truncated visible copy is a stated decision, not an accident.
- [ ] **Width budget measured (§18.7):** the both-present case asserts the *measured* outcome at the 736 px usable width; if the long notice cannot fit, the two-line row is accepted and the §15.2a.4 "one line at wide widths" target is amended. WelcomeScreen is not modified unless a status surface exists there.
- [ ] **One height value (§18.8):** `--status-reserved-height` = **46 px** (row border-box = 38 px pill + 8 px spacing) in §15.2a.2, §15.2a.3, and §15.2a.4; no 38 px value remains as the property's content.
- [ ] **Direct mapping gap named (§18.9):** `run_command` either maps via `toolsConfig` or is recorded as a deferred pre-existing finding; `execute`/`patch` are gone from the Direct resolver at S3.
- [ ] All new tests under verified `tests/{unit/web,dom}/<feature>/` paths; `bun run test:locations`, `typecheck`, `lint` (`--error-on-warnings`), `format:check` exit 0 with real numbers; `bun run verify` full chain green with recorded pass/skip counts.
- [ ] **Layout stability (S7a, §15.2a/§15.3):** showing/hiding any **status presentation** (Direct pill, `OpenCodePrimaryStatus`, recovery notice) does **not** move the transcript viewport, the composer, or the scroll anchor — the reserved-height *status* row keeps the composer folder's flow height constant. The row is **one-line `min-height`** `H_status` (38 px content / 46 px incl. spacing, §15.2a.4) that **grows to two lines only in the narrow-both-present case**; the **empty row and every single-pill state hold exactly the one-line height** (space budget met, never exceeding it). Verified by **geometry** (transcript/composer `getBoundingClientRect()` + `scrollTop` identical across idle→active→idle, ≤1px, **including label changes; the row height asserted equal to `H_status` for empty/single-pill and to the two-line height only for narrow-both-present**) in both `tests/dom/components/chat-layout-stability.test.tsx` **and** the real-browser `tests/e2e/virtualizer/status-layout-stability.spec.ts`, covering **Direct: tool-activity + approval; Code: tool-activity + retry + approval + cancellation** (Direct has no engine-retry or `Stopping…` state — §18.6); **simultaneous primary + restoration notice render as disjoint sibling pills with no overlap and no horizontal overflow**, staying on **one line at wide widths** (truncated labels keep full accessible names); **the retry countdown and recovery actions remain available and keyboard-accessible** (focusable buttons, visible focus rings; no important information hidden to save space); **the connection heart stays outside the reserved row** — its popover open/close and its reconnecting/terminal/`off` presentation move nothing; **interactive question/form content stays visible and usable and is asserted *outside* the reserved region** (never clipped to the pill height), its own natural-height add/remove documented as intentional; the draft/welcome centered column is position-stable (E2E). A "renders the pill" assertion is explicitly **not** sufficient, and sub-pixel DPI tolerance is recorded, not claimed covered (§15.5).

## 12. Product decisions (recommended defaults)

1. **Health excludes cancellation; cancelling renders "Stopping…" on a Connected heart.** Adopt §2/§2b.
2. **`off` driven solely by `connection.type !== "connected"`; `off` suppresses the primary.** Adopt (verified against `statusView.ts:138`, `v2Events.ts:1342`, `v2Types.ts:193`).
3. **Atomic S3 owns the `statusView` healthy/`off`/cancellation change; no separate runtime S4.** Adopt.
4. **Temporary, behaviorally-tested `shell` entry in S1, deleted exactly at S3 (or S1+S3 atomic).** Adopt standalone S1; atomic S1+S3 documented fallback.
5. **`data-primary-status` + `data-restoration-notice` markers, both first introduced in S3; S5 preserves them.** Adopt.
6. **`AgentStatus` stays the vendored props-only variant (`state`/`label`/`elapsed`/`trailing`/`className`); S5 adds a `trailing` dismiss node and re-skins the notice — **no new `icon`/`action` props**, no `primary` prop, no `@assistant-ui/*` version bump** (§16.4: the runtime-bound `TaskTray`/`useTaskSummary` lane is out of scope under the train freeze).** Adopt; fallback = retain hand-built copies as a documented exception.
7. **`resets_at` parity: defer.** No UI now (no structured 2.1.2 field; do not parse error text).
8. **CI `40527025056` G1 failure: open/unclassified.** No full-CI claim until artifact/log inspection or a valid re-run.
9. **Code-mode approval source = `extras.permissions.length > 0`.** There is no `requires-action` tool-part status in the OpenCode projection; the permissions surface is `ApprovalCard`-based (`OpenCodePermissions.tsx:81-97`). The primary is a status line beside those cards, never a second approval control. Adopt (§18.5).
10. **Retry announcement is a small sr-only `role="status"` node** inside `OpenCodePrimaryStatus`; the pill itself stays the vendored `AgentStatus`. The vendored element has no live region, so this is a required, documented addition — not "zero custom markup" (§18.6).
11. **The notice re-skin is conditional (decision deferred to S5, before that diff):** either shorten the copy to a pill label + add a live region, or retain the hand-built notice as a documented exception. The current sentence exceeds `max-w-44` and the element has no `role="status"` (§18.4).
12. **Width is measured, not assumed:** at the 736 px usable width the two pills may wrap with the long notice copy; S7a asserts the measured outcome and may accept two lines as the normal both-present case (§18.7).
13. **Direct resolver owns the real Direct tool names** (`run_command`, `read_file`, `write_file`, `edit_file`, `list_dir`, `delete_file`, `process_*`, `system_info`, `browser*`, `todo`, `scheduler`); `execute`/`patch` leave the Direct mapping at S3; mapping `run_command` is fixed at S3 or recorded as deferred (§18.9).
14. **The welcome/draft reserved row is dropped** unless a status surface is ever rendered in that branch (§18.7).
15. **One value:** `--status-reserved-height` = **46 px** (row border-box) everywhere (§18.8).

## 13. Corrected documentation claims (carried from §2.6 of the prior plan)
`docs/2026-10-27-unified-agent-status-and-composer-parity-plan.md`:
- L175 "15s auto-dismiss" → the constant is `OPENCODE_RECOVERY_NOTICE_MS = 12_000` (`config.ts:116`); the test uses the constant.
- L3/L5 "Status: Implemented, verified, and passing all quality gates" + "Baseline Commit `2facd38`" → implementation commit is `2804f94` (child of `2facd38`); "verified" is not backed by a recorded run.
- L172-179 assertion counts → re-measure or delete; several understate the visible test blocks.
- L85 `(msg.content ?? msg.parts)` → the `.parts` branch is in no installed type and is recorded as removable.

## 14. CI wording (kept)
**CI run `40527025056` failed at the G1 packaged-WebView observation; the other required jobs passed.** The cause is **unclassified** — not labelled pre-existing, and **no full-CI-certification claim** is made for `2804f94` on that run. It becomes a supported statement only after artifact/log inspection of the G1 job or a valid re-run. This change's own gate set (§11) is independent of the G1 job.

## 15. Chat layout stability — new concern (Rev 8, refined Rev 9), new stage S7a

### 15.1 The defect and its diagnosed cause (inspected, not assumed)
When an agent status pill appears or disappears, the conversation viewport shifts vertically. **Root cause, confirmed from the layout:**

- `ChatWindow.tsx:243-244`: the composer-folder container (`relative z-10 … pb-4`) is a **normal flow block**. Its first child is `<AssistantStatusPill />` — a flow child that **mounts and unmounts** with activity. When it appears, the folder gains the pill's height; the `flex-1 min-h-0` `VirtualizedTranscript` (`ChatWindow.tsx:213,227`) is the flex filler **above** the composer row, so the folder growing **shrink-then-grow** moves the transcript's bottom edge and the composer up/down by the pill height. When the pill unmounts, the folder shrinks and everything moves back.
- The transcript is a scroll container (`overflow-y-auto`, `ChatWindow.tsx:227`) with virtualized rows; its height is driven by the flex fill. A height change on the composer-folder therefore changes the transcript's visible height and can move the effective scroll anchor.
- The **draft/welcome branch has the same class of defect:** `WelcomeScreen.tsx:25-45` centers a column (`items-center`) inside `flex-1 … overflow-y-auto`; a pill appearing above/around that column shifts the centered content.
- The **`aboveComposerExtra` slot** (`ChatWindow.tsx:248`) is a **mixed slot owned by `OpenCodeView`**: it renders, in order, `OpenCodeQuestions` (the interactive form dock — `V2FormCard`, multi-line natural height), `OpenCodeRecoveryNotice` (a transient status pill, `data-slot="agent-status"`), and the old `OpenCodeRetryBanner` (also a transient status pill). **Only the two status pills are the layout-shifting concern.** The interactive `OpenCodeQuestions` must **not** be clipped or pinned to a pill's height — it is a content surface, not an agent-status label, and it keeps its natural height and behavior.

So the defect is **flow participation of *transient status* surfaces between the transcript and the composer**, not the pill's internal content and **not** the interactive question dock. The fix must reserve space for **status presentations** only, and leave interactive content (questions, forms) to its natural height.

### 15.2 The fix — reserve space for *status presentations only*, keep interactive content at natural height (chosen against the actual architecture)

**Two principles:**
1. **Status is reserved; interactive is natural.** Only transient **agent-status presentations** (the primary pill, retry line, restoration/recovery notice, the Code connection heart) live in a **geometrically reserved region** whose height is constant whether or not one is showing. **Interactive content — `OpenCodeQuestions`/`V2FormCard` and any form — is never placed in that region.** It keeps its natural, content-driven height, full scrolling/clipping behavior, and stays usable; pinning it to the pill height would clip it and is prohibited.
2. **No absolute positioning.** A floating layer risks covering the transcript, the forms, the composer, or the recovery controls. The reserved region is a normal flow row of **fixed height**, so the composer folder's flow height is constant across show/hide.

**The reserved region is a single, engine-neutral row** — `StatusReservationRow` (new component, owned by `ChatWindow`) — that occupies a **constant height** `H_status` and renders *whichever* status presentation is active, or empty when none. It is the **only** place a fixed height exists; it is pinned by the geometry test (§15.3), not by comment.

- **What the region reserves** (per mode):
  - **Direct (`mode="chat"`):** the primary pill (`AssistantStatusPill` → `AgentStatus`) and, when a bound Direct thread carries one, its restoration/recovery presentation (`data-restoration-notice`). Nothing else.
  - **Code (`mode="agent"`):** the primary presentation the OpenCode feature owns (`OpenCodePrimaryStatus`, incl. the "Stopping…" line and the 500 ms retry countdown) **and** the restoration notice. These are the only two OpenCode surfaces moved *into* the reserved row. The connection heart (`OpenCodeStatus`, `belowComposerExtra`) and the scoped-chip row are **not** status pills and stay in their own existing rows (they are not height-changing with activity; see §15.4 file notes).
- **What stays OUT of the region** (natural height, above or below the reserved row, in flow):
  - `OpenCodeQuestions`/`V2FormCard` — the interactive question dock. Rendered **outside** the reserved row so a multi-line form never collapses to the pill height. When a form is open the region stays empty (the form is not a status presentation), so the reserved height still holds and the transcript/composer do not move when the *form* appears/disappears only if the form is the sole above-composer surface — but a form **does** add natural height; that is acceptable and intentional (it is content, not a transient status), and is covered by the §15.3 "interactive stays visible/usable" assertion rather than a geometry no-jump one.
  - The scope picker, the agent scope chip, and `belowComposerExtra` (heart + reconnect) keep their current rows.

**How OpenCode surfaces reach the row without breaking the engine boundary:** `ChatWindow` still receives only the **opaque** `aboveComposerExtra`/`belowComposerExtra` slots — it never imports `features/opencode/*`. The split is done **on the OpenCode side**: `OpenCodeView` stops passing a mixed slot and instead passes (a) an **interactive slot** (`OpenCodeQuestions`, natural height, still opaque, rendered by `ChatWindow` outside the reserved row) and (b) a **status slot** (`OpenCodePrimaryStatus` + `OpenCodeRecoveryNotice`, opaque, rendered *into* the reserved row). `ChatWindow` therefore gains two opaque slots (or one slot object `{ interactive?, status? }`) and keeps the Direct pill in the same reserved row. No OpenCode type crosses into `ChatWindow`. This is the one structural change to `ChatWindow`'s slot API and is bounded to S7a.

**Pinning `H_status` (grounded in the real components):** all reserved presentations are single-line `rounded-full` pills — `AgentStatus` (`py-1.5` 12 px + `size-6` trailing 24 px + 1 px borders = **38 px border-box**; label `max-w-44 truncate`), `OpenCodeRecoveryNotice` (`py-1` 8 px + `size-5` 20 px + borders = **30 px**), `OpenCodeRetryBanner` (`py-1.5` 12 px + `text-xs` 16 px + borders = **30 px**; deleted in S3). Rev 14's single number governs: `H_status` = the **row's border-box**, 38 px pill content + 8 px row spacing = **46 px** (§15.2a.4, §18.8). The older "≈32 px / ≈40 px" figures in this paragraph were content-box estimates and are superseded.
- `H_status` = the **row border-box** 46 px, held as one named CSS custom property (`--status-reserved-height`) consumed only by the reserved row and pinned by the geometry test. It fits the shorter recovery pill (30 px) inside the same 38 px line.
- **Label change (thinking → tool → approval → retry → "Stopping…") does not change `H_status`**, because every one is the same single-line pill class with a truncating `max-w-44` label; the countdown re-skins in place at the same height.
- **Restoration notice appear/disappear** occupies the same reserved row (it is itself a `rounded-full` pill of that class), so the height is unchanged.
- **Narrow viewport / label wrap:** the label is `max-w-44 truncate` (clamped, not wrapped), so even at narrow widths the pill stays **one line and its height is constant** — the reserved height is valid across the full width range. The responsive rule is therefore: *the label truncates, the row does not grow*; no `min-h` change at any breakpoint. A pill that genuinely cannot fit would be a defect to surface, not a silent layout grow.
- This avoids the Rev 8 "height that only works for one label" trap: because all reserved presentations share one single-line pill class, **one** height works for all of them and for narrow viewports alike.

**Draft/welcome branch (`WelcomeScreen.tsx`) — dropped from S7a (Rev 15, §18.7):** the welcome branch renders only `<WelcomeScreen composer={…} />` inside a viewport (`ChatWindow.tsx:201-204`); there is **no status pill and no composer folder** there, so there is no observable shift to reserve against. AGENTS.md requires a reproducible defect before a production change, so S7a does **not** modify `WelcomeScreen.tsx`. If a status surface is ever added to the welcome branch, the reserved-row + center-on-folder treatment is the recorded design; it is not implemented speculatively now.

### 15.2a Final layout architecture (Rev 10; Rev 11 refines the reserved-row height)

Rev 10 committed one concrete layout, replacing the undecided "two props or one object" alternatives and resolving the heart-placement contradiction. This is the design S7a implements; the earlier §15.2 bullets are superseded where they conflict. **Rev 11 (§15.2a.4) revises the reserved-row height** from a permanently two-line row to a **single-line min-height row that grows to two lines only when both primary and notice are present at a narrow viewport**.

#### (1) Connection heart — where it actually renders (inspected)
- The heart is `OpenCodeStatus` (`web/src/features/opencode/OpenCodeStatus.tsx`), the **trigger** of which is a fixed-size button (an `inline-flex … p-1 rounded-md` box wrapping a `size-3.5` icon). It is passed as `belowComposerExtra` and rendered **inside the existing agent-scope-chip row** (`ChatWindow.tsx:260-267`): `<div className="flex items-center gap-1 px-1 pt-1"><WelcomeScopePicker/> {belowComposerExtra}</div>`. That row is **always present in `mode="agent"`**, so the heart button occupies a **constant, deterministic height** within it.
- The heart's **detail** (`PopoverContent` — working dir, session id, Reconnect/Retry-recovery `Button`, `role="alert"` text) is a Radix popover rendered in a **portal**: it is an **absolute-positioned overlay**, outside normal flow. Opening/closing it never changes the flow height of the chip row, the transcript, or the composer.
- **Resolution:** the heart button is **outside** the reserved status row — it keeps its existing row. **S7a does not move it.** What the reserved row owns is only the *suppression behavior* of the primary pill (when the heart presents reconnecting / terminal-failed / blocked-recovery / load-error / `off`, the reserved row shows empty, per §2b). Two facts, one owner each:
  - **In the reserved status row:** the Direct `AssistantStatusPill`, `OpenCodePrimaryStatus`, and `OpenCodeRecoveryNotice`.
  - **Outside the reserved status row (constant-height, existing row):** the connection heart (`belowComposerExtra`, always present in agent mode) and the agent-scope chip row it shares. The heart's popover overlay is out of flow by design.
- **Test consequence (explicit):** opening/closing the heart popover must be asserted **not** to move the transcript bounds, composer bounds, or `scrollTop` (the overlay is absolute; the trigger button is fixed-size). This is a "no shift from the popover" assertion, distinct from the reserved-row no-jump assertions.
- This removes the §15.3 "the heart is in `belowComposerExtra` (its own row, also reserved when it can appear)" and §15.4 "reserve that row too" hedges: the heart row is **not** reserved or moved; it is constant by construction and only *asserted* shift-free.

#### (2) Simultaneous primary + restoration notice, narrow screens — the concrete layout
- The reserved row is a **single-row flex container** `flex flex-wrap items-center gap-2 min-w-0` with a **one-line** `min-height` of `H_status` (§15.2a.4: **46 px row border-box = 38 px `AgentStatus` content + 8 px spacing**, pinned as `--status-reserved-height`; the earlier "38 px" here was the pill content, not the row — §18.8); the row **grows to two lines only** when both the primary and the restoration notice are present *and* they do not fit side-by-side. That growth is a real, bounded layout event (the folder gains 38 px), not a permanent cost — **provided** the width measurement in §18.7 shows the pills do fit at some supported width.
- **Pill sizing:** each pill (primary, notice, retry line) is a `rounded-full` flex pill with `max-w-full min-w-0` and `shrink` so its label truncates to available width (`truncate`), with **no horizontal overflow** of the row (`min-w-0` + `overflow-x-clip`). A pill with an action/dismiss control (the notice's `X`, S5's `AgentStatus` `trailing` action slot) reserves that control's `size-6`/`size-5` box inside the pill so the control is never clipped.
- **Wrapping rule (single-line by default — Rev 11):** the row's `min-height` is the **one-line** height (`H_status`, §15.2a.4), not a permanent two-line max. When a pill is too wide for the remaining space in the line it wraps to a second line; two pills therefore occupy **at most two lines**, and that two-line height is reached **only** when both the primary and the restoration notice are present *and* they do not fit side-by-side (the narrow-both-present case, §15.2a.4). At wide widths, both pills sit in **one** line and the row stays at its one-line height — **only if the measured widths actually fit** (§18.7). The wrapping rule is what makes the default reservation cheap while still bounding the narrow case; it does **not** guarantee a one-line both-present layout.
- **Coexistence, no collision:** primary and restoration notice render as **sibling pills** in the wrapping row; they never overlap because they are separate flex items (primary first/top, notice second). The notice is a *contextual* fact (per §1 governing rule) and may coexist with the primary; neither restates the other's label.
- **Accessibility on truncation:** a truncated label keeps its full accessible name. Each pill exposes its full label via `aria-label` (or a visually-hidden full span) so a visually truncated pill is still announced in full — "labels may truncate **visually** only if their full accessible names remain available."
- **Retry countdown / "Stopping…":** these are states of the *primary* pill (S3's `OpenCodePrimaryStatus`), not separate pills, so they occupy the same one line as the primary and never add a second line beyond what the primary already reserves.
- **Height is verified against the real components, not an estimate (§15.2a.4/5):** the one-line `H_status` (38 px, the `AgentStatus` border-box height) is established by **measuring the rendered reserved row** at the actual widths in the DOM/E2E tests and asserting the measured one-line height equals the pinned `--status-reserved-height`; the two-line height (**92 px**, §19.4) is asserted only for the narrow-both-present case. A CSS custom property (`--status-reserved-height: 46px`, the row border-box = 38 px content + 8 px spacing — §18.8) holds the single named value; the row consumes it, and the test fails if a measured render diverges — the height is pinned by the geometry test (§15.3), not by a comment.

#### (3) Committed slot API and component order
**One interface** — replace the two-props / one-object alternatives. `ChatWindow` gains a single opaque, engine-neutral `composerExtras` object; nothing else:
```ts
type ComposerExtras = {
  /** Reserved status row content — transient status presentations only.
   *  Direct: the pill; Code: OpenCodePrimaryStatus + OpenCodeRecoveryNotice.
   *  Rendered *inside* the reserved row; empty when no status is active. */
  status?: ReactNode;
  /** Interactive content (questions / forms) — natural height, always usable.
   *  Rendered *above* the reserved row, outside it. */
  interactive?: ReactNode;
  /** Below-composer row content (agent mode only) — the connection heart +
   *  any display-only chips. Constant-height, its own existing row. */
  below?: ReactNode;
};
```
- **Component order (top → bottom), one concern each:**
  1. `VirtualizedTranscript` (the `flex-1` scroll container) — unchanged.
  2. **Interactive content** (`composerExtras.interactive`: `OpenCodeQuestions`/`V2FormCard`) — **natural height**, above the reserved row; opening/closing it is *content* height, not status, and is not asserted jump-free (§15.2 principle 2, §15.5).
  3. **Reserved status row** (constant `H_status`, `composerExtras.status` rendered inside it; empty when idle) — **between** interactive content and the composer.
  4. **Composer** — unchanged.
  5. **Below-composer row** (`composerExtras.below`: connection heart + display-only chips, agent mode) — **constant height, outside** the reserved row; the heart popover is an out-of-flow overlay.
- **Engine-neutrality preserved:** `ChatWindow` renders only the opaque nodes in `composerExtras`; it never imports `features/opencode/*` or `features/chat/` pill internals. `OpenCodeView` supplies `status` / `interactive` / `below` as opaque nodes; the **direct** pill is supplied by the `ChatWindow` caller in `mode="chat"`. The slot API is the **only** change to `ChatWindow`'s public surface in S7a, and it is bounded to that stage.
- **S3 (atomic handoff) is unchanged:** S3 still delivers the *content* ownership (gate the pill, new `OpenCodePrimaryStatus`, marker `data-restoration-notice`, delete the banner). S7a delivers the *layout* slot split. They are separate diffs and do not touch each other's responsibilities; S7a depends on S3/S5 so it is tested against the post-S5 component structure (§15.4).

#### (4) Rev 11 — reserved-row height: single-line min-height, two-line only when needed (re-evaluated against the real components)

**Grounding check: how OpenChamber solves the same class of problem.** Before committing the height, I inspected OpenChamber's actual layout (`D:\Temp\openchamber\packages\ui\src\components\chat\`):

- **The status pill is an absolute-positioned floating overlay, not a flow child.** `ChatContainer.tsx:1921-1941` renders `StatusRowContainer` inside `<div className="oc-composer-riders absolute bottom-full inset-x-0 …">` — a zero-height anchor on the composer's top edge. The pill floats **above** the composer and **overlaps the transcript's last rows** (the transcript fades out behind it via `data-live-tail` + CSS when the view is at the end). The comment at line 2009–2011 is explicit: *"as a row sibling it took part in the flex layout and pushed the transcript, which is the one thing an overlay must not do."* **OpenChamber deliberately chose floating-over-transcript** so that showing/hiding the pill moves nothing — the exact opposite of TBAi's flow-placement, and the reason TBAi's layout-shift defect exists in the first place.
- **TBAi does NOT adopt the floating overlay** (Rev 8, §15.2): the transcript is a scroll container and the pill must not cover messages/forms/composer/recovery controls; a floating pill has no reserved space and would hide content. TBAi's reserved-row design is the **in-flow, geometry-pinned** counterpart to OpenChamber's **out-of-flow, overlapping** one. Both achieve the same goal (no jump); they trade different things. This is why the two apps' "height" answers are not directly transferable: OpenChamber's pill costs **zero** flow space (it's absolute), so it has no height budget at all.
- **OpenChamber's "quiet" status line** (`ComposerStatusStrip`, `ChatInput.tsx:4302-4309` — worktree-setup, space-queued) **is a flow row** and does grow the composer's top rows (`composerTopRows`, line 4334). It is a *composer-top* row, not a transcript-above row, and OpenChamber accepts its height change because it sits inside the composer's own stacked row area, not above the transcript. TBAi's transient status sits **above the transcript**, which is why it needs a reservation.
- **OpenChamber's interactive content (forms, permissions)** is docked **inside `ChatInput`** (`PermissionDock`/`FormDock`, `ChatInput.tsx:4906-4915`), i.e. *in-flow at the composer's bottom, inside the composer box area* — they grow the composer, not the transcript-above region. TBAi's `OpenCodeQuestions`/forms are in-flow **above** the composer (the current `aboveComposerExtra`), which is the harder placement and why TBAi's Rev 9/10 split puts them *above* the reserved status row at natural height.

**Conclusion of the grounding check:** OpenChamber confirms the *diagnosis* (a flow status row above the transcript is what causes the push; hence they float it) but **does not** hand TBAi a height number — TBAi's reserved-row height is a TBAi-specific consequence of its flow layout and must be measured from TBAi's own components (done below), not borrowed from a floating overlay. The one transferable insight: **OpenChamber never reserves space for its pill at all (zero flow cost, overlapping instead)**; TBAi's reserved row is the price of not overlapping, and the single-line `min-height` design is the minimum such price.

**Why the two-line permanent reservation is rejected.** A permanently two-line row costs `38 + 8 + 38 = 84 px` of pill content (plus the row's 8 px spacing = **92 px** border-box, §19.4) of composer-folder height at **all** widths, including when empty. That is the "60–80 px" the user flagged. The three presentation cases do **not** require two lines in the common (wide-enough) layout:

| Case | Content in the row | Natural height of tallest item | One line enough? |
|---|---|---|---|
| Primary only | `AgentStatus` (working/waiting) | 38 px (border-box) | Yes |
| Restoration notice only | `OpenCodeRecoveryNotice` (an `AgentStatus` since S5) | 38 px (border-box) | Yes — row uses its 38 px min-height |
| Primary + notice together, **wide** | `AgentStatus` + notice, side-by-side | 38 px (both are the same pill) | Yes — one line |
| Primary + notice together, **narrow** (they wrap) | two lines | 38 + 8 + 38 = 84 px content (92 px row) | Two lines required |

The **only** case that needs two lines is the last one: both pills present **and** the viewport is too narrow to fit them side-by-side. That is a bounded, narrow-viewport condition, not a permanent cost. So the row's `min-height` is set to the **one-line** height; the row *grows* to two lines only in that case, and the growth is a layout event (the folder gains a second 38 px line + the 8 px gap = **46 px**) that the geometry test bounds rather than hides.

**Measured component heights (from source, not estimate):**
- `AgentStatus` (the primary pill; `agent-status.tsx:33`): `py-1.5` (6+6 px) + a `size-6` trailing action circle (24 px content, the tallest inner element) + 1px border×2 → **38 px border-box**. In `done`/`failed` the `size-6` circle is still present (it hosts the rotate/pause/trailing icon), so the height is the same across all states. **This wrapper is unconditional**, which is why the same 38 px applies whether or not the caller supplies a `trailing` node.
- `OpenCodeRecoveryNotice`: **38 px** since S5, because it now *is* an `AgentStatus`. Before S5 it was a hand-built pill of **30 px**; the 84 px two-line figure in Rev 11–15 was derived from that 30 px and is superseded (§19.4).
- `OpenCodeRetryBanner` (`OpenCodeRetryBanner.tsx:58`): `py-1.5` (6+6 px) + `text-xs` label line-height (16 px) + 1px border×2 → **30 px border-box** (Rev 14 wrote 32 px; corrected in Rev 15, §18.10). The banner is deleted in S3 and replaced by `OpenCodePrimaryStatus`, so this number does not enter the row height.
- The tallest single pill is therefore **38 px** (`AgentStatus`).

**The single-line row design (committed for S7a):**
- **`H_status` (one-line min-height) = 38 px**, the border-box height of the tallest reserved pill (`AgentStatus`). This is the **permanent** reserved space when the row is empty or holds a single pill. It is expressed as one named CSS custom property `--status-reserved-height: 38px` consumed only by the reserved row; a geometry test pins it (§15.3) rather than a comment.
- **Spacing is inside the row's reservation.** The row carries the `pb-2` spacing (8 px) that currently sits around the pill as part of the row's own padding, so the *flow* height the folder contributes is `38 + 8 = 46 px` (one line) — not 92 px. When empty, the folder costs **46 px**, not the two-line 84+8 = 92 px.
- **Wide + both pills:** `AgentStatus` and the notice render **side-by-side** in the one 38 px line (both are 38 px tall). Row stays 46 px (border-box) **only if the measured widths fit** — see the width budget below; with S5's short "Session restored" label they do fit at 736 px (§19.4).
- **Narrow + both pills (wrap):** the pills wrap to two lines. The row's `min-height` is still 38 px but its *content* is 84 px, so the row renders at 84 px (92 px flow). **This is the one case the row exceeds the one-line budget** — it is *allowed to grow* (it is a real layout event, not hidden), and the geometry test asserts (a) the growth only happens when both pills are present **and** side-by-side does not fit, and (b) when only one pill or neither is present the row is exactly the one-line 46 px. **Priority:** the primary pill always renders on the first (top) line; the notice wraps to the second. The retry countdown (part of the primary, S3) stays on the primary's line.
- **No horizontal overflow:** the row is `min-w-0` and each pill is `max-w-full shrink` with a truncating label (`max-w-44 truncate` on `AgentStatus`), so at any width a pill clamps rather than overflows the row; the dismiss/action controls keep their fixed `size-5`/`size-6` boxes so they are never clipped.
- **Accessible names on truncation:** every truncated pill carries its full label in `aria-label` (or a visually-hidden full span) so a visually truncated pill is still announced in full. Keyboard: the notice's dismiss and the primary's trailing action are native `<button>`s (focusable, visible `:focus-visible` rings) and remain keyboard-reachable in the wrapped layout.
- **What is NOT hidden for space:** the retry countdown and the recovery "Reconnect / Retry recovery" action are **not** suppressed to save space. The countdown is part of the primary pill's line; the recovery action lives on the heart's popover (outside the row, §15.2a.1) and on the notice's dismiss. The narrow-wrap case costs 46 extra px of transcript height only when both pills are present; that is an accepted, bounded trade-off, documented not hidden.

**The one-line row is viable and is the committed choice** — it satisfies all three presentation cases at one line for any viewport that can fit two pills side-by-side (the normal case), and it bounds the two-line growth to the genuine narrow-both-present case.

**Space budget (single measured number — Rev 14 audit fix, §1.4(b)):** the numbers above mix two
boxes: the *pill content* (38 px `AgentStatus` border-box — both pills since S5) and the *row flow*
(content + the `pb-2`/`pt-2` spacing the row carries). The spec uses **one** asserted value —
the **row's own border-box height** — and derives every other number from it:

- **`H_status` = the row's one-line border-box height = 46 px** (38 px pill content + 8 px
  spacing, both inside the row box). This is the single value the geometry test asserts;
  `--status-reserved-height` holds it. It is *not* the 38 px pill content height — 38 px is
  the pill, 46 px is the row.
- **Two-line (narrow-both-present) row border-box = 92 px** (84 px two-pill content + 8 px
  spacing; §19.4 — every `AgentStatus` is 38 px, so both lines cost 38 px). Asserted only in
  that case.
- **Empty row / one pill:** row = 46 px (`min-height` holds; the 8 px spacing is inside the box).
- **Both pills, wide:** row = 46 px (one line).
- **Both pills, narrow:** row grows to 92 px (two lines) — the one permitted growth event.
- **Transcript cost:** the `flex-1` transcript gives up **46 px** for the permanent one-line
  reservation (92 px only in the narrow-both-present case), measured against the real
  `AgentStatus` (38 px) + row spacing (8 px) in DOM/E2E (§15.3), never a hardcoded estimate.
- The test asserts **`row.getBoundingClientRect().height`** equals `H_status` (46 px) for
  {empty, primary-only, notice-only, both-wide} and 92 px for both-narrow; it does **not**
  assert the pill's 38 px content height directly (that is a property of the pill inside the
  row, not of the row box the layout-stability test measures).

**Width budget — measured, not assumed (Rev 15, §18.7).** The composer folder is `max-w-3xl`
(768 px) with `px-4`, so the reserved row has **736 px usable at every desktop width**. The
`AgentStatus` pill is ~220–250 px wide (icon + `max-w-44` label + trailing/padding); the longest
notice sentence — *"Previous session restored — a run is still in progress, and a prompt is
waiting to run."* — is ~500 px of `text-xs` text before its icon, padding, and dismiss button,
i.e. ~560–580 px as a pill. Their sum is **~800–830 px**, so the two pills may wrap **even at the
widest supported width**. Rev 15 therefore:
- makes the S7a geometry test **measure** the two pills at the 736 px row and assert the *actual*
  outcome (one line or two), instead of asserting a one-line both-wide case that may be
  unreachable;
- treats the notice's visible width as an S5 product decision (§18.4): shorten the copy, cap it
  with a `max-w-*` + truncation, or accept a two-line row whenever the long notice variant is
  present;
- keeps the **46 px (one line) / 92 px (two line)** row numbers (§19.4) — only the frequency of
  the two-line case is unresolved by measurement alone; after S5 shortened the notice to
  "Session restored", the measured outcome is one line at 736 px and two lines at 480 px (§19.4).

#### (5) How the geometry tests detect clipping, growth, overflow, and overlap (Rev 11)
- **Clipping / content overflow of the row:** assert `row.scrollHeight === row.clientHeight` (no vertical overflow of the reserved box) in every case except the documented narrow-both-present wrap, where `scrollHeight` may exceed `clientHeight` but the row is *allowed* to be taller (asserted as an expected growth, not a defect).
- **Unexpected row growth:** for each of {empty, primary-only, notice-only, both-wide}, assert the **row's own border-box** (`row.getBoundingClientRect().height`) equals `H_status` = **46 px** (the 38 px pill content + 8 px spacing the row box carries; within 1 px). The two-line (narrow-both-present) case is asserted to equal **92 px** (84 px two-pill content + 8 px spacing, §19.4). Only that case differs from 46 px.
- **Horizontal overflow:** at the narrowest viewport, assert `row.scrollWidth <= row.clientWidth` (no horizontal scroll) and that no pill's `getBoundingClientRect().right` exceeds the transcript column's right edge.
- **Overlap:** assert the primary pill and the notice pill have disjoint `getBoundingClientRect()` boxes (no intersection) in both the side-by-side and the wrapped layouts.
- **Stable positions:** as in §15.3, the transcript top/height, composer top, and `scrollTop` are identical across idle→active→idle for each label, and the row's *one-line* height never moves the composer in any single-pill case.
- **Accessible/keyboard:** assert the dismiss and trailing-action `<button>`s are focusable (`tabIndex` reachable, `:focus-visible` ring present) and that each truncated pill exposes its full label via `aria-label` / `aria-labelledby` in the DOM.

### 15.3 Tests (what they prove, and the boundary)
Layout stability is a **geometry** property. Two layers, both grounded in existing tooling (the repo already asserts layout in `tests/dom/virtualizer/virtual-transcript-harness.test.ts` via `getBoundingClientRect`/`scrollHeight`, and has real-browser E2E in `tests/e2e/virtualizer/`):

1. **DOM geometry test** (`tests/dom/components/chat-status-pill.test.tsx` — the S3 ChatWindow DOM test gains layout cases, or a new `tests/dom/components/chat-layout-stability.test.tsx`):
   - Render a bound Code/Direct thread with the transcript at a known scroll offset; **mount then unmount the primary** (idle → active → idle). Assert the **transcript element's `getBoundingClientRect()` top/height, the composer's `getBoundingClientRect()`, and the transcript's `scrollTop` are identical** across the three states (within a 1px tolerance). A `renders the pill` assertion alone is **insufficient** and is not the acceptance.
   - Idle → active → idle for **each** of: tool-activity and approval-waiting in **Direct**, and tool-activity, retry, approval-waiting, and cancellation "Stopping…" in **Code**. (Direct has no engine retry and no `cancelling` state — §18.6 — so those two fixtures are Code-only.) For each, the reserved row keeps constant height, so all three measurements are stable.
   - **Label change keeps height:** cycle the primary label thinking → tool → approval → retry → "Stopping…" and re-assert the transcript/composer bounds are unchanged (the pill truncates via `max-w-44`, so a label change never grows the row).
   - **Restoration notice + connection-recovery:** mounting `[data-restoration-notice]` (the reserved row, together with the primary) must not move the transcript/composer or overlap the composer or recovery controls. The **heart stays outside** the reserved row in its constant-height `below` row (§15.2a.1): assert that its **popover open/close does not move** the transcript bounds, composer bounds, or `scrollTop` (absolute overlay + fixed-size trigger), and that its reconnecting/terminal/`off` presentation (which suppresses the primary, leaving the reserved row empty) also moves nothing.
   - **Space budget: empty row does not exceed the chosen budget (§15.2a.4):** the row's **own border-box** (`row.getBoundingClientRect().height`) is exactly `H_status` = **46 px** in the **empty** state and in every **single-pill** state and the both-wide case, and **92 px** only in the narrow-both-present case (two lines). It does **not** assert the 38 px pill *content* height — that is the pill inside the row, not the measured row box. The permanent transcript cost is the 46 px one-line reservation (92 px only when wrapping).
   - **Simultaneous primary + notice, no collision / no overflow / no overlap (§15.2a.4/5):** with both the primary pill and the restoration notice present, assert the two pills have **disjoint** bounding boxes (no intersection) in both the side-by-side (wide) and wrapped (narrow) layouts; assert **no horizontal overflow** (`scrollWidth <= clientWidth`; no pill's right edge past the transcript column); assert **no clipping** of either pill's dismiss/action control; assert the row height is the one-line `H_status` when they fit side-by-side and the two-line height only in the narrow-both-present case.
   - **Accessibility: retry countdown + recovery actions remain available & accessible:** the retry countdown (part of the primary pill) and the recovery actions (the notice's dismiss button; the heart's Reconnect/Retry-recovery in its popover) are **present and reachable** in every state — assert they are focusable `<button>`s with a visible `:focus-visible` ring, and that a visually truncated pill still exposes its full label via `aria-label` / visually-hidden text. Important retry/recovery information is never hidden to save space (§15.2a.4). The restoration notice keeps a live-region announcement (`role="status"`); if S5 re-skins it onto `AgentStatus`, the re-skin must add and assert an explicit live region, because the vendored element has none (§18.4).
   - **Narrow viewport (measured, §15.2a.4/§18.7):** at each tested width, **measure** the two pills; assert the row's border-box height is 46 px when they fit side-by-side and 92 px when they wrap. Empty/primary-only/notice-only must be 46 px at every width. The test must **not** assume a width exists at which both pills fit: the notice copy may exceed the row, in which case the two-line result is the recorded outcome, not a failure. **Measured outcome (§19.4):** 480 px (the product minimum) → 176 px of row content, notice 173.25 px, a single pill per line, row 46 px; both pills → 92 px. 1280 px → 736 px of row content, both pills on one line, row 46 px.
   - **Width budget (Rev 15, §18.7):** record `primary.getBoundingClientRect().width`, `notice.getBoundingClientRect().width`, and the row width at the widest viewport; assert the sum + `gap-2` against the row width, so the one-line/two-line outcome is evidence, not a guess.
   - **Interactive content stays visible & usable (the split, not a geometry no-jump):** with an `OpenCodeQuestions`/`V2FormCard` open, assert the form's interactive controls are **reachable** (not clipped to the pill's `H_status`) and that opening/closing the *form* is **not** asserted to be jump-free — the form is natural-height content, and its add/remove flow height is intentional. This assertion is separate from the status no-jump one and documents that interactive content was deliberately kept out of the reserved region.
   - **Direct chat and Code mode** both covered (the row is shared; assert in both `mode="chat"` and `mode="agent"`).
   - The draft/welcome branch: asserting stable centered-column position is **a known limitation of the DOM harness** (centering is layout-dependent); it is covered by the E2E spec and documented in §15.5, not claimed by the DOM test.
2. **Real-browser confirmation** (`tests/e2e/virtualizer/` — a new `status-layout-stability.spec.ts` alongside the existing scroll specs, run in the existing Playwright environment where `getBoundingClientRect`/`scroll` are real):
   - Drive a live turn (tool activity / retry / approval / cancellation) in both Direct and Code; capture the transcript and composer bounding boxes and `scrollTop` at idle→active→idle; assert no jump. This is the "real browser where layout measurements are possible" requirement.
   - **Narrow viewport** re-run at a responsive width to confirm the reserved row height is stable and labels truncate (the §15.2 responsive rule, proven in a real browser rather than only the DOM harness).
   - **Draft/welcome (dropped — §18.7):** no status pill renders in the welcome branch (`ChatWindow.tsx:201-204`), so there is no idle→active transition to measure. The E2E spec does not assert a welcome-column jump.
   - **Interactive content:** with an OpenCode form open, assert the form is fully visible and its controls usable; assert the *form's own* add/remove height is not claimed jump-free (it is intentional content height, distinct from status).
   - **Boundary, documented (§15.5):** the E2E spec is reliable for the **bound-thread** viewport and the **welcome centered column**. The **exact sub-pixel tolerance** under the app's real virtualizer + browser is the one point the harness cannot prove; the plan states what is and is not covered rather than asserting full coverage. A render-only "the pill shows" check is explicitly **not** a browser-geometry proof.

### 15.4 Stage S7a (distinct from S3; one concern)
- **Objective:** make transient **status presentations** a reserved-height layout slot so no status surface's mount/unmount changes the composer folder's flow height; transcript height, composer position, and scroll anchor stay stable; Direct and Code both covered; recovery/reconnect surfaces contained. **Interactive content (questions/forms) is deliberately kept at natural height and out of the reserved region.** The final layout, slot API, and component order are those of **§15.2a** (the single `composerExtras` object; the **one-line `min-height` reserved row that grows to two lines only in the narrow-both-present case**, §15.2a.4; the heart staying outside the row).
- **Depends on:** S3 (the `data-primary-status`/`data-restoration-notice` markers and `OpenCodePrimaryStatus` exist, so the fix is tested against the **final component structure**, not the pre-handoff one) and S5 (so the row is sized against the re-skinned notice, not the old hand-built one). It must **not** be folded into S3 (keeps S3 the ownership handoff, not a layout refactor) — one concern per diff.
- **Files (per §15.2a):**
  - `web/src/components/ChatWindow.tsx` — replace the single mixed `aboveComposerExtra` prop with the **one committed `composerExtras` object** (`{ status?, interactive?, below? }`); render `status` **into** the new reserved-height status row (**one-line `min-height` `--status-reserved-height`, `flex flex-wrap`, two-line only in the narrow-both-present case**, §15.2a.2/4) and the Direct `AssistantStatusPill` into the same row; render `interactive` (`OpenCodeQuestions`/`V2FormCard`) **above** the row at natural height; render `below` (the connection heart) in its **existing constant-height row**, outside the reserved row. No OpenCode import crosses in — the slots stay opaque.
  - `web/src/features/opencode/OpenCodeView.tsx` — supply `composerExtras` with three opaque nodes instead of the mixed slot: `interactive` = `OpenCodeQuestions`, `status` = `OpenCodePrimaryStatus` + `OpenCodeRecoveryNotice`, `below` = `OpenCodeStatus` (the heart). This is the OpenCode-side half of the split and keeps the engine boundary intact.
  - ~~`web/src/features/chat/components/WelcomeScreen.tsx`~~ — **not modified (Rev 15, §18.7):** the welcome branch has no status surface, so there is no shift to reserve against. The design remains recorded in §15.2 if one is added later.
  - **Not moved by S7a:** the connection heart stays in its constant-height `below` row; S7a only **asserts** (per §15.3/§15.2a.1) that its popover open/close and its reconnecting/terminal/`off` presentation move nothing. The agent-scope chip and scope picker keep their rows.
- **Tests:** the §15.3 DOM geometry test (`tests/dom/components/chat-layout-stability.test.tsx` or extended `chat-status-pill.test.tsx`) + the E2E `tests/e2e/virtualizer/status-layout-stability.spec.ts`. Both under the verified `tests/` layout; `test:locations` gate holds.
- **Acceptance criteria (Rev 11):** the §15.3 measurements pass for idle→active→idle across tool-activity / retry / approval / cancellation **and label changes** (thinking → tool → approval → retry → "Stopping…"), in both Direct and Code; the composer and transcript bounding boxes and `scrollTop` are unchanged (≤1px); the **empty row and every single-pill state hold exactly the one-line `H_status`** (38 px content / 46 px incl. spacing — the space budget, §15.2a.4) and **do not exceed** the two-line height; **simultaneous primary + restoration notice** render as disjoint sibling pills (no overlap, no horizontal overflow) and stay on **one line at wide widths** (growing to two lines only in the narrow-both-present case, §15.2a.4/5); **truncated labels keep their full accessible names** and the **retry countdown and recovery actions remain available and keyboard-accessible** (focusable buttons, visible focus rings, no information hidden to save space); the **heart popover open/close and its reconnecting/terminal/`off` presentation** move nothing (the heart is outside the reserved row, §15.2a.1); interactive question/form content **stays visible and usable** and is asserted *outside* the reserved region (not clipped to the pill height); the reserved-height constant is the **single** source of the row height (pinned by the geometry test, not a comment).

### 15.5 Documented limitations (do not claim what the harness cannot prove)
- **Interactive content height is intentionally *not* reserved.** `OpenCodeQuestions`/`V2FormCard` keep natural height; the plan does **not** claim the form's own add/remove is jump-free (it is content, not transient status). The test asserts it stays *visible and usable*, not that it is height-stable. This is the deliberate consequence of the status/interactive split.
- **Draft/welcome is out of scope (Rev 15, §18.7):** the welcome branch renders no status surface, so there is nothing to stabilize. The earlier "centered-column" concern had no corresponding component in the tree; no test claims it.
- **Real-browser pixel tolerance:** E2E runs on the app's virtualizer + browser; a 1px tolerance is asserted, but **sub-pixel rounding under zoom/DPI is out of scope** and not claimed. A render-only "the pill shows" check is explicitly **not** a browser-geometry proof.
- **The heart popover is out of flow by design and is *asserted* shift-free, not excluded:** its open/close does not move the transcript/composer (absolute overlay + fixed-size trigger). The plan does **not** claim a general geometry proof for arbitrary popovers — it asserts the specific heart-popover open/close and the heart's reconnecting/terminal/`off` presentation move nothing (§15.2a.1, §15.3). This is recorded so a reviewer knows the heart is deliberately *not* placed in the reserved row.

### 15.6 Renumbered stage table (Rev 10)
| Stage | Concern | Depends on |
|---|---|---|
| S1 | `lib` analyzer + Direct hook + temp `shell` entry (behaviorally tested) | — |
| S2 | OpenCode resolver (real `shell` owner) | S1 |
| **S3 (atomic)** | ownership handoff (gate + primary + banner deletion + `statusView` healthy/`off`/cancel + markers + temp-`shell` deletion) | S1, S2 |
| S4 | *removed* (in S3) | — |
| S5 | vendored `AgentStatus` `trailing` dismiss/action node + re-skin notice (preserves markers; no new props, §16.4) | S3 |
| S6 | retry/step projection exclusion | — |
| **S7a (new)** | **chat layout stability: reserved-height status row** per §15.2a (single `composerExtras` object; **one-line `min-height` row that grows to two lines only in the narrow-both-present case, §15.2a.4**; heart stays outside the row) | **S3, S5** |
| S7b | plan/doc correction + record this plan (replaces old S7) | S7a |

**State (Rev 16):** S1, S2, S3, S5, S6, S7a are implemented in the working tree and verified locally;
S7b is this revision. S4 stays removed. See §19 for the per-stage evidence.

**Landing order:** S1 → S2 → **S3** → S5 → S6 → **S7a** → S7b. S7a is a **separate, later** one-concern diff (the layout fix), not part of the S3 handoff, and is tested against the post-S5 component structure.

## 16. OpenChamber agent-status pill — reference matrix (non-normative data point)

OpenChamber (the sibling app in `D:\Temp\openchamber`) ships an agent status pill that
TBAi's Direct + Code status work deliberately **does not** copy: it is a floating,
composer-anchored overlay, not a flow child. It is recorded here purely as a
state/when/what reference matrix so the TBAi plan can borrow *phrasing and
priority ordering* without adopting OpenChamber's layout or runtime. Source:
`packages/ui/src/components/chat/{StatusRowContainer,StatusRow}.tsx`,
`message/parts/WorkingPlaceholder.tsx`, and `hooks/{useAssistantStatus,
useSessionActivity}.ts`. **None of this is a TBAi decision; it is a data point.**

### 16.1 Wiring
| Piece | File | Role |
|---|---|---|
| `StatusRowContainer` | `StatusRowContainer.tsx` | Reads `useAssistantStatus()` + agent/model name → feeds `StatusRow`; owns the background keybind. |
| `StatusRow` | `StatusRow.tsx` | Floating chip; renders **only when `isWorking`**, else `null`. Holds `WorkingPlaceholder` + optional `BackgroundWorkButton`. |
| `WorkingPlaceholder` | `WorkingPlaceholder.tsx` | Chooses *which* label (retry / permission / tool / generic) and de-churns it. |
| `useAssistantStatus` | `useAssistantStatus.ts` | Computes `isWorking`, `statusText`, `isGenericStatus`, `isWaitingForPermission`, `retryInfo`, `canBackground`, model context. |
| `useSessionActivity` | `useSessionActivity.ts` | busy/idle/retry phase gate that `isWorking` rests on. |

### 16.2 State / when / what / display
| State (condition) | When it appears | Agent is doing | Pill shows |
|---|---|---|---|
| **Idle** | `isWorking === false` | Nothing | **Nothing** — chip is `null`. A completed abort also shows no chip. |
| **Retrying (rate limit)** | `isWorking` && `retryInfo` (session status `retry` **or** last assistant message's `retry`) | Provider 429; OpenCode scheduled a backoff | `Retrying in Ns (attempt K)` live 500 ms countdown; if `resets_at` is later than the retry target, `Limit resets at <time> · retry in Ns (attempt K)`. `aria-live="polite"`. |
| **Waiting for permission** | `isWorking` && a pending **permission** | A gated/destructive action awaits a yes/no | `waiting for permission`, `aria-live="assertive"`. |
| **Running tool / editing** | `isWorking` && active part is a running/pending tool | Invoking tools | Bucketed phrase with parallel counts ("reading a file / reading 3 files", "editing a file", "running a command", "searching files", "looking things up", "handing off a task", "asking a question", "picking up a skill"); named phrases for OpenChamber-namespace + MCP tools; a running Code-Mode `execute` names its sub-tool. |
| **Thinking** | `isWorking` && active part is running **reasoning** | Model reasoning | `thinking`. |
| **Composing** | `isWorking` && active part is streaming **text** | Model writing | `composing`. |
| **Working (generic)** | `isWorking` && no specific active part | Turn started, nothing classifiable | Stable generic phrase from `WORKING_PHRASES` **hashed by session+assistant id** (no flicker); ignored by the de-churn gate. |
| **Aborting** | `abortActive` (abort pressed, unacknowledged) | Turn stopping | Label suppressed (`shouldRenderPlaceholder=false`); only `BackgroundWorkButton` may show. After acknowledgement → idle, chip gone. |
| **Backgroundable** | `isWorking` && `canBackground` (a running `shell`/`subagent`, incl. inside Code-Mode `execute`) | Work you can hand off | A `BackgroundWorkButton` on the chip's right edge, beside the label. |

**Common display behavior** (`WorkingPlaceholder`): a new label is shown only after
the previous has been on screen ≥ 1.2 s (`STATUS_DISPLAY_TIME_MS`), else queued;
generic churn is ignored. When a model resolves, the label is prefixed with the
provider logo + model name; the shown model is the last assistant's model unless a
newer prompt overrides it to the session's model.

### 16.3 What TBAi borrows vs. keeps (this plan's own decisions stand)
- **Borrow as phrasing/priority data:** the bucketed parallel counts, the
  "retry + limit-resets" two-line format, the `assertive`-on-permission
  accessibility tier, and the stable-generic-phrase de-churn. These inform the
  §4 labels and §9 priority matrix *without* importing OpenChamber's code.
- **Keep TBAi's own:** floating overlay is **rejected** in favor of the reserved
  flow row (§15/S7a) because TBAi's pill is a flow child of the composer folder;
  TBAi's `resets_at` parity is **deferred** (OpenCode 2.1.2's live
  `SessionStatus.retry` carries no reset field — §5); TBAi's "questions are forms,
  not approvals" rule already matches OpenChamber's form-vs-permission split; and
  TBAi's cancellation-excluded health (§2) matches OpenChamber's abort-suppress.

### 16.4 The official assistant-ui `AgentStatus` element — what the docs say vs. what the installed type graph provides

Studied against the official docs page `assistant-ui.com/elements/agent-status` and the **installed** `@assistant-ui/react` `0.15.30` / `@assistant-ui/core` `0.3.30` type graph (no dependency-train change; the train is frozen).

**What the docs describe (the current element):**
- A rounded pill: state dot + crossfading label + elapsed time + trailing icon. Two lanes:
  - **With a runtime** — the element *reads* `s.thread.tasks` and is a live chip: it renders **only while a task runs or waits for input**, and nothing once everything has settled. Its label is the running task's label, or `N of M tasks running`, or `N tasks waiting for input`; elapsed starts from the earliest running task's timing.
  - **`TaskTray`** uses the same pill as a disclosure button into a popover listing every task (indented, per-row state/label/meta/elapsed, paged four at a time) with the tally `M tasks done [N failed]`.
  - **Props-only (single tool call)** — bind one tool call; `requires-action` → `waiting`, `running` → `working`, complete/incomplete → `done`.
- **Anatomy** (matches TBAi's vendored copy exactly): root `span[data-slot="agent-status"]`; leading check/cross/dot; a **visually-hidden state word** (so the dot's color is never the only state signal — an accessibility property TBAi's vendored element already preserves); a `key={label}` crossfade label; `elapsed` shown only while `working`/`waiting`; a decorative trailing icon (pause/replay, or a `trailing` node) hidden from AT.

**What the installed type graph actually provides (verified on disk, not assumed):**
- `s.thread.tasks` **exists** — `@assistant-ui/core@0.3.30` `store/scopes/thread.d.ts:54`: `readonly tasks: readonly TaskState[]`, where `TaskState` (`store/scopes/task.d.ts`) is a *tool call carrying a nested conversation* (`id`, `toolName`, `args`, `result`, `isError`, `status`, `timing`, `messageId`, `parentTaskId`, `depth`, `messages`). So the *data source* the official bound element reads is present in our version.
- `@assistant-ui/react@0.15.30` re-exports **only the types** `TaskState`/`TaskMethods`/`TaskMeta`/`TaskClientSchema` from `core/store` (`react/dist/index.d.ts:60`). **It does not export `useTaskSummary()`, `TaskTray`, `summaryState`, or `summaryLabel`** — those helpers are **not in the installed 0.15.30 type graph** (grep of the react dist found none). The docs page describes a *newer* element generation; the canonical helpers it references are not yet in the train we're frozen on.
- Consequence (frozen-train rule): **TBAi cannot adopt the runtime-bound `AgentStatus`/`TaskTray` as documented** without a dependency-train change, which is prohibited. TBAi's vendored `web/src/components/assistant-ui/elements/agent-status.tsx` is the **props-only** variant (state/label/elapsed/trailing) and is a faithful copy of the official element's anatomy.

**Docs re-study (2026-10-28, Rev 15 — live page + installed dist).** The published page documents
exactly the surface the vendored copy implements: `state` (required), `label` (required),
`elapsed`, `trailing`, `className`; two lanes (**runtime-bound** through the provider and a
**standalone controlled** binding); `useTaskSummary()` aggregating `s.thread.tasks`; `TaskTray`'s
done/failed tally; and the anatomy the plan already relies on — a **visually hidden state word**
and an **`aria-hidden` trailing icon**. It states that `AgentStatus` returns null unless a task
runs or waits, and that `TaskTray` returns null only when the thread has no tasks. Two
consequences for this plan: (a) the runtime-bound lane is still **not available in the frozen
train** (§17.3), so the vendored props-only copy remains the correct target; (b) the vendored
element has **no live region**, which is why §18.6's sr-only announcer is required for the retry
path and §18.4's notice re-skin is not copy-compatible as-is.

**What this means for the plan (no design change; one correction to S5's wording):**
- The official element's **content contract** (renders only while a task runs/waits; label = the running task; `N of M tasks running` aggregate; elapsed from the earliest running task) **aligns with TBAi's Direct pill** and confirms the *labels* TBAi should produce (§4/§9). It does **not** hand TBAi a layout answer: the official element is the *pill itself*, engine-owned, and it **mounts/unmounts with activity** — which is precisely the flow-participation that causes TBAi's layout shift. So **the reserved-row design (§15/S7a) stands** as TBAi's solution to the layout problem the official element does not address.
- **S5 wording correction (the S5 row in §10/§15.6 and §11):** S5 is described as "`AgentStatus` `icon`/`action` + re-skin the notice". The installed vendored `AgentStatus` **has no `icon`/`action` props** — its surface is `state`/`label`/`elapsed`/`trailing`/`className` (a `trailing` node, e.g. a dismiss `<button>`, is how an action ships). S5's real, train-safe work is therefore: **add a `trailing` node (the dismiss/action) to the vendored `AgentStatus` (it already accepts `trailing`) and re-skin `OpenCodeRecoveryNotice` to render through the vendored `AgentStatus` with `state`/`label`/`trailing`** — **no new `icon`/`action` props, no version bump**. This is a **correction to S5's public API description only**; S5 stays presentation-only and preserves `data-restoration-notice`. (The runtime-bound `TaskTray`/`useTaskSummary` lane in the docs is recorded here for awareness but is **out of scope** — it requires a dependency-train change the freeze prohibits.)

### 16.5 OpenChamber parity: Heart vs. Viewport vs. Status Row

OpenChamber enforces an unambiguous separation of responsibilities across three distinct surfaces:
1. **The Transport/Connection Health**:
   - Tracked strictly at the server connection boundary (`connectionPhase`).
   - Does NOT reflect turn-level execution issues like provider rate limits, missing models, or command failures.
   - When the user's turn hits a 429 quota or fails, the connection health remains calm and connected.
2. **The Chat Viewport (`SessionErrorNotice`, `ErrorResponseDetails`, `LongErrorText`)**:
   - Turn errors are rendered inside the chat view in the conversation stream or as an inline turn notice.
   - **Rate limit (429)**: Displays the error text, parsed reset time ("Limit resets at HH:MM"), and provider notice.
   - **Model missing / unavailable (404)**: Identifies the missing model directly in the message area.
   - **Authentication / API key failure (401/403)**: Prompts the user with diagnostic details in the message area.
   - **Unhandled failure**: Shows expandable `ErrorResponseDetails` with raw JSON and copy button.
3. **The Active Status Row (`StatusRow`, `StatusRowContainer`)**:
   - Renders live transient state: `Retrying in Ns (attempt K)`, `running command`, `waiting for permission`, `thinking`, `composing`.
   - Never duplicates the static error description that belongs in the viewport.

**TBAi Parity Mapping:**
- **Heart (`OpenCodeStatus` / `statusView.ts`)**: Retains only transport health (`HeartHandshake`, `HeartPulse`, `HeartCrack`, `HeartOff`). Never touches execution errors or rate limits.
- **Viewport (`MessagePrimitive.Error` / turn error notice)**: Displays static turn failures, missing models, and rate limits in context.
- **Pill (`OpenCodePrimaryStatus`)**: Uses the official vendored `AgentStatus` component to show live activity (retry countdown, tool verb, thinking, "Stopping…").

---

## 17. `@assistant-ui/*` upgrade compatibility audit (read-only; no dependency change)

**Decision recorded here (Rev 13, 2026-10-28): defer the dependency upgrade.** The planned
status-ownership + chat-layout work (S1–S7b, §15/§16) continues on the **existing locked
train**, subject to this plan's existing gates. Any train move is a **separate, explicitly
authorized compatibility change** with its own review (`AGENTS.md` train-freeze rule);
nothing in S1–S7b presumes a newer `@assistant-ui/*`. No manifest, lockfile, source, test, or
other file was changed by this section; no package was installed and no check was run.

Evidence below is measured against the **published tarballs** (0.3.30/0.3.31/0.3.32 core,
0.0.14/0.0.15/0.0.16 ai-sdk, 0.15.30/0.15.31/0.15.32 react), not the changelog. A capability
is only claimed "new" where a published declaration or implementation actually differs; the
absence of one named token in a package is **not** treated as proof that the behavior is
unavailable elsewhere in the graph.

### 17.1 Current locked train (baseline the work proceeds on)
| Package | Locked (single instance in `bun.lock`) | Manifest range |
|---|---|---|
| `@assistant-ui/react` | **0.15.30** | `^0.15.30` (root deps + web deps) |
| `@assistant-ui/core` | **0.3.30** | transitive |
| `@assistant-ui/store` | **0.3.22** | transitive (at latest) |
| `@assistant-ui/tap` | **0.9.24** | transitive (at latest) |
| `@assistant-ui/ai-sdk` | **0.0.14** | `^0.0.14` (root + web) |
| `@assistant-ui/react-markdown` | **0.14.15** | **exact pin** `0.14.15` (web deps) |
| `@assistant-ui/react-devtools` | **1.2.25** | `^1.2.25` (web devDeps) |
| `assistant-cloud` | **0.2.7** | web deps `^0.2.5` + transitive |
| `assistant-stream` | **0.3.53** | root + web deps `^0.3.53` + transitive |

Support train (single instance each): `radix-ui@1.8.1`, `zustand@5.0.15`,
`@ai-sdk/react@4.0.140`, `ai@7.0.145`/`7.0.137`, `safe-content-frame@0.0.34`.
No `overrides`/`resolutions`/dedupe block in either manifest (confirmed clean).

### 17.2 Candidate train (latest published; the deferred target)
`react 0.15.32 / core 0.3.32 / ai-sdk 0.0.16 / react-markdown 0.14.24` (a same-day
2026-10-28 batch). A patch-level move within the declared ranges **except two manifest
edits**: `@assistant-ui/ai-sdk` `^0.0.14` does not span `0.0.14 → 0.0.16` (a `0.0.x`
caret), and `@assistant-ui/react-markdown` is an **exact** `0.14.15` pin — both require an
explicit manifest change. `bun outdated` (run in this environment) confirms the same split:
`react` Latest 0.15.32 / Update 0.15.32; `ai-sdk` Latest 0.0.16 but **Update 0.0.14**
(range-permitted); `react-markdown` Latest 0.14.24 (candidate established by this audit).

### 17.3 The official bound `AgentStatus` / `TaskTray` — CLI-scaffolded, NOT a package export
Verified against the **0.15.32** `dist`:
- `@assistant-ui/react` 0.15.30 **and** 0.15.32 export **only** `TaskState`/`TaskMethods`/
  `TaskMeta`/`TaskClientSchema` as *types* from `core/store` (`index.d.ts:60`) — byte-identical
  across the two versions.
- **No `TaskTray`, no `useTaskSummary`, no bound `AgentStatus`, no `summaryState`/`summaryLabel`**
  in either published dist. GitHub `packages/react/src/{hooks,primitives}` has no agent-status
  source. The bound element is the **CLI-scaffolded `.aui` element** (`agent-status.aui`),
  generated into the app — the same pattern TBAi already uses for `context-display.aui`,
  `mermaid-diagram.aui`, `reasoning.aui`, `shiki-highlighter.aui`.
- The **data source** it reads, `s.thread.tasks`, **is** a package export:
  `core` `store/scopes/thread.d.ts:54` `readonly tasks: readonly TaskState[]` (present in
  0.3.30 and 0.3.32).

**Consequence:** the train bump does **not** unlock a runtime-bound status element. Introducing
one is a **separate feature** (CLI-scaffold `agent-status.aui`, re-skin to TBAi theme per
`architectural-principles.md` rule 4, wire the Direct lane; the OpenCode runtime
`useExternalStoreRuntime` is a different boundary and is not populated the same way) and
requires its own compatibility review. It is **not** part of this upgrade and **not** part of
the S1–S7b status/layout work.

### 17.4 Run / error outcomes — what the baseline already provides vs. what is new
The upstream changelog for core 0.3.31 / ai-sdk 0.0.15 describes "newly reported" run
outcomes. **The published declarations do not establish that as a new client-facing
`MessageStatus` vocabulary.** Verified against the tarballs:

- **Existing (baseline `core@0.3.30`)** — the terminal run-outcome contract is already
  `core` `dist/types/message.d.ts`: `MessageStatus` / `MessagePartStreamStatus` carry
  `type: "incomplete"` with
  `reason: "cancelled" | "tool-calls" | "length" | "content-filter" | "other" | "error"`,
  plus the running part `status` discriminants. `aborted`/`incomplete`/`rate-limit`-class
  outcomes are therefore already representable.
- **TBAi already models a richer taxonomy than the changelog's five tokens.**
  `src/lib/errors.ts:16-…` defines categories `"cancelled" | "auth" | "rate_limit" |
  "network" | "timeout" | …`, with `RATE_RE = /429|rate limit|rate_limit|quota|too many
  requests/i` and `401|403` → auth. **No upgrade is required to classify a turn as
  cancelled / rate-limited / auth / network / invalid-stream** — the Direct route's
  `onEnd` outcome + `sanitizeStreamError` (per `docs/decisions.md` "Direct AI SDK boundary")
  already settle this. **This is why the turn-error-separation work (S3 heart/primary split,
  `statusView.ts` healthy→`idle`, `off` driven solely by `connection.type`) is unaffected
  by the bump and proceeds on the current train.**
- **The token check is bounded:** the strings `rate_limited`, `server_error`,
  `persistence_error`, `aborted` do **not** appear in any of 0.3.30/0.3.31/0.3.32 or the
  ai-sdk/react dists. That is expected — the outcome is carried by the `MessageStatus`
  `incomplete`/`reason` union and by TBAi's own `errors.ts`, not by a new string literal.
  Absence of the literal is **not** evidence the capability is missing; it is evidence the
  capability is carried by an existing field.

**Genuinely new in `core@0.3.31` (verified present in 0.3.31 *and* 0.3.32, absent in 0.3.30):**
- **`persistenceError`** on the `ThreadHistoryAdapter`/`GenericThreadHistoryAdapter`
  `reportTelemetry` options — `dist/adapters/thread-history.d.ts:41`
  `persistenceError?: unknown` ("the error that kept the items, or a message before them,
  from being stored"), alongside new `message` / `userMessageId` telemetry options. TBAi's
  `web/src/adapters/threadHistoryAdapter.ts:315` currently no-ops `reportTelemetry() {}`, so
  it does **not** consume this.
- **`ComposerTextOrigin`** — `dist/runtime/interfaces/composer-runtime-core.d.ts:23`
  `export type ComposerTextOrigin = "user" | "recall" | "send" | "return" | "reset" |
  "external"`, with a new `textChange` composer event carrying `origin` and an `origin`
  field on the composer store scope (`store/scopes/composer.d.ts`). `@assistant-ui/react`
  re-exports the **type** from 0.15.31 (`index.d.ts:62`); the **runtime behavior** (the
  `textChange` event with `origin`) was added to the composer runtime in the same 0.3.31
  core. Both absent from 0.3.30 / 0.15.30. **Relevance to TBAi: optional and orthogonal** —
  it would let the composer distinguish user-typed vs. failed-send-return vs. recall writes,
  which TBAi does not currently track; adopting it is a separate feature decision, not part
  of the status/layout plan.

### 17.5 What the upgrade would and would not change in TBAi's custom code
- **Eliminated/simplified by the bump:** nothing required by the S1–S7b status or layout
  work. The turn-error split operates on TBAi's own `errors.ts` + OpenCode
  `connection`/`load`/`retry` state, which the bump does not touch.
- **Optional new capability (only if desired):** `ComposerTextOrigin` (17.4) and the
  `persistenceError` telemetry field. Both are additive and do not gate the status/layout
  plan.
- **OpenCode status remains custom regardless:** `v2Runtime.tsx` → `useExternalStoreRuntime`
  reads `V2ThreadState.connection/load/retry/activity`, not `thread.tasks`; no bump changes
  that.

### 17.6 Recommendation
**Defer the dependency upgrade (Option B) until S7b lands.** Land S1–S7b on the **current** locked
train (react 0.15.30 / core 0.3.30 / ai-sdk 0.0.14 / react-markdown 0.14.15). The deferred move is
now **planned** in `docs/2026-10-29-assistant-ui-train-upgrade-plan.md` (2026-10-29), which turns
this section into a sequenced, gated work item: re-audit the target tarballs, two required manifest
edits (`@assistant-ui/ai-sdk ^0.0.14 → ^0.0.16`; `@assistant-ui/react-markdown 0.14.15 → 0.14.24`),
clean install, single-instance proof, full `verify` + error/provider paths, G1 re-baseline, and a
`docs/decisions.md` entry. **That document is a plan, not an authorization:** it still requires the
maintainer to lift the `AGENTS.md` train freeze for the one dependency commit, and nothing in it has
been executed.

**Unverified (research-only; not executed):** the single-instance `core`/`store`/`tap`
proof, `bun run verify`, the Direct/OpenCode error+provider paths, and the G1 CI re-run.
None is claimed passing. A future train move — including a *subset* re-resolution — must
still clear the full `AGENTS.md` compatibility review; this audit does not authorize it.

### 17.7 Direct Answers to Architectural Questions (Rev 14 Summary)

#### 1. Can we remove custom code and use library code/functions for agent status / pill status?
- **Yes — the status/label layer does. Exactly what is eliminated and what is not:**
  - `OpenCodeRetryBanner.tsx` is deleted in S3; its countdown moves into the primary
    (`OpenCodePrimaryStatus`), matching §5's "one primary surface per runtime" invariant.
  - `OpenCodeRecoveryNotice.tsx` is re-skinned in S5 onto the vendored `AgentStatus` with
    its native `trailing` dismiss node — no separate hand-rolled pill class (its own markup
    currently duplicates the `AgentStatus` pattern, `OpenCodeRecoveryNotice.tsx:80-86`).
    **Rev 15 caveat (§18.4):** the notice's sentence exceeds `max-w-44` and it currently
    provides `role="status"`, which the vendored element does not; the re-skin is conditional on
    the S5 copy/live-region decision, else the hand-built notice stays as a documented exception.
  - Both the Direct pill (`AssistantStatusPill` → `AgentStatus`) and the OpenCode primary
    compose the **same vendored element**, so the pill markup exists once, in
    `elements/agent-status.tsx` (rule 4 of `architectural-principles.md`: vendored official
    element, small TBAi adaptation).
- **What is NOT eliminated, and why (library-first, minimum custom code — §1 of the
  principles, not "zero custom code"):**
  - `OpenCodePrimaryStatus.tsx` (new, S3) must **stay** as a thin engine adapter: the
    OpenCode external-store runtime has no first-party status element, so a small
    OpenCode→`AgentStatus` projection (state/label/elapsed) is the minimum custom surface.
  - The **activity analyzers** (§3–§6: `lib` scanner, Direct + OpenCode resolvers) and the
    **health split** (§2: `statusView.ts` heart vs. primary) remain TBAi code: they encode
    application policy (which fact owns which surface), which `architectural-principles.md`
    assigns to TBAi, not to the library.
  - The **layout-stability row** (§15/S7a) remains TBAi code: assistant-ui does not ship a
    reserved-flow-height status row; OpenChamber solves the same problem with a floating
    overlay (§15.2a.4), which TBAi rejects.

#### 2. Can we remove duplicate code in the heart and show errors (rate limits, missing models, API issues) in the viewport like OpenChamber?
- **The heart/primary split does this, with two corrections to the Rev 14 wording:**
  - The Heart (`OpenCodeStatus` / `statusView.ts`) keeps **four** presentations —
    `idle` (connected), `working` (reconnecting, heart-pulse), `error` (terminal failure /
    blocked recovery / load error, heart-crack), `off` (disconnected, heart-off).
    It is stripped of the **`retrying`** presentation (`statusView.ts:147-157`) and the
    **`working`** presentation for load/runs (`:158-166`); the connection / blocked-recovery /
    load **error** branches (`:111-136`) stay. **There is no execution-error branch today** — Rev
    14's "execution.error … `statusView.ts:149`/error branches" wording was wrong; the existing
    recovery test already proves execution errors are omitted
    (`OpenCodeStatus.recovery.test.tsx:281`, §18.10). So the heart no longer duplicates the
    primary's live work. **It still cracks for a terminal transport
    failure** (the server can't reach OpenCode at all) — that is transport health, not a
    turn error; §2's "stripped of execution errors" reads as "no turn-level failures",
    not "no transport failures".
  - **Turn-level failures (429/404/401–403/auth, execution errors) are NOT new S7a work.**
    The Direct lane **already** renders them in the viewport via `MessagePrimitive.Error`
    (`ChatWindow.tsx:734`, `AssistantError` → `classChatError` copy for quota/auth).
    The OpenCode lane currently surfaces the same facts through **message projection**
    (S6 excludes retry/step parts from `v2MessageProjection.ts`), not a new viewport
    surface. **If an OpenCode `SessionErrorNotice`-style card is wanted, that is a new,
    separately-authorized stage** (the OpenChamber parity mapping is the data point in
    §16.5; the TBAi decision to add, adopt, or drop that surface is not yet made).

#### 3. What happens if we upgrade the `@assistant-ui` packages here?
- **Upgrading does NOT eliminate custom code or fix the status pill/heart.**
- The tarball audit (§17.3/§17.4) proves upstream still exports **no** runtime-bound
  agent-status element and **no** external-store status component: `TaskTray`/`AgentStatus`
  are CLI-scaffolded source elements, and `core@0.3.32` adds only `persistenceError`
  telemetry + `ComposerTextOrigin` (0.3.31), neither of which touches OpenCode status.
- Upgrading introduces real risks:
  - Violates the `AGENTS.md` train-freeze rule (the 2026-09-15 context-breakage lesson,
    re-stated in §17.6 as a separate authorized compatibility change).
  - Requires two manifest edits (`@assistant-ui/ai-sdk` `^0.0.14` caret; `react-markdown`
    exact `0.14.15` pin).
  - `react@0.15.32` relocates the runtime hooks (`useRemoteThreadListRuntime`,
    `useExternalStoreRuntime`) to re-exports of `@assistant-ui/core/react`, which is
    precisely the duplicate-context risk the freeze guards against — the single-instance
    proof must hold across both the Direct and the OpenCode boundary.
- **Decision:** keep the train frozen (Option B, §17.6). Full OpenChamber-parity and custom-
  code elimination are achieved by the §1–§2 composition on the current stable train;
  any train move is a **separate, explicitly authorized** compatibility change with its own
  review, and a future move — including a subset re-resolution — must still clear that
  review.

---

## 18. Rev 15 implementation-readiness audit (2026-10-28)

Read-only. Every item was checked against the working tree at `2804f94`; nothing was
implemented and no gate was run. §18.1–18.8 are blocking for the stage they touch; §18.9–18.10
are minor corrections.

### 18.1 Missed test consumer — `assistantActivityMapping.test.ts`

`tests/unit/web/components/assistantActivityMapping.test.ts:3` imports `getToolRunningLabel`
from `features/chat/hooks/useAssistantActivity`, and `:21-25` asserts `shell`, `bash`, and
`execute` map to `"Running…"`. S1 moves the mapping and S3 removes `shell`; the test goes red
unless it is in the same diff. It is absent from Rev 14's S1/S3 file lists.

**Resolution:** update the import in S1 (or re-export deliberately); rewrite the case set in S3
to assert the OpenCode resolver for `shell`/`execute`/`patch` and the Direct resolver for
Direct's real names.

### 18.2 Missed test consumer — recovery-notice coexistence

`tests/dom/opencode/OpenCodeRecoveryNotice.test.tsx:58` dynamically imports
`OpenCodeRetryBanner` and `:244` renders it in "the notice and the retry banner coexist". S3
deletes the banner, so the test cannot compile. Rev 14's S3 list names only
`OpenCodeRetryBanner.test.tsx` and `OpenCodeView.test.tsx`.

**Resolution:** the coexistence case renders `OpenCodePrimaryStatus` instead; the assertion
becomes "a live retry does not suppress the notice".

### 18.3 Existing `statusView` cases encode the contract S3 reverses

`tests/unit/web/opencode/statusView.test.ts` asserts the old heart behaviour at `:85` ("load in
flight as working"), `:92` ("run in flight as working"), `:115` ("scheduled engine retry as
retrying"), and `:125` ("retry wins over the working predicate"). S3's healthy→idle and
retry-removal change contradicts all four. Rev 14 says only "extend".

**Resolution:** rewrite them in S3 (not "extend"), record in the commit message that the heart's
contract changed by design, and keep the other 9 cases unchanged. This satisfies AGENTS §6b.6
(no silent test deletion).

### 18.4 The notice re-skin conflicts with its content and accessibility contract

`OpenCodeRecoveryNotice` renders a full sentence and is `role="status"`
(`OpenCodeRecoveryNotice.tsx:79-86`). The vendored `AgentStatus` label is `max-w-44 truncate`
(176 px, `agent-status.tsx:56`), has no live region, and injects `sr-only {state}` whose
vocabulary is working/waiting/done/failed — not "restored". A naive re-skin silently truncates
the visible message (hiding "…a prompt is waiting to run") and removes the polite announcement.

**Resolution (decision required before S5):** either (a) shorten the copy to a pill label, add
an explicit `role="status"` wrapper, and assert the full label via `aria-label`; or (b) retain
the hand-built notice as the documented exception §12.6 allows. Do not re-skin without one.

### 18.5 Code-mode approval-waiting has no defined data source

Rev 14's §9 puts "Waiting for approval…" in the primary, but OpenCode permissions are
`ApprovalCard`s driven by `extras.permissions` (`OpenCodePermissions.tsx:81-97`), and the
OpenCode projection has no `requires-action` tool-part status (grep of `features/opencode/`
finds none). Direct has one; Code does not.

**Resolution:** define the source as `extras.permissions.length > 0` (or drop the row from Code),
state that the pill is a status line beside the approval cards, and test coexistence.

### 18.6 The retry announcement cannot come from `AgentStatus`

`OpenCodeRetryBanner` guarantees one `role="status"` announcement per attempt with an
`aria-hidden` countdown (`OpenCodeRetryBanner.tsx:62-67`). `AgentStatus` has no live region and no
per-node aria control; its label is the visible text. Passing the countdown as `label` changes it
every tick and cannot be aria-hidden selectively.

**Resolution:** `OpenCodePrimaryStatus` keeps a small sr-only `role="status"` announcer (attempt
number) and an `aria-hidden` countdown, using the vendored element for the pill itself. This is a
required custom addition; the "composes the official element with its native props, no custom
markup" claim is corrected.

### 18.7 Width budget unmeasured; welcome branch has no status surface

- The folder is `max-w-3xl` with `px-4` → **736 px** usable. `AgentStatus` ≈220–250 px; the long
  notice ≈560–580 px; sum ≈800–830 px. The "both pills, wide → one line" premise may never hold.
- `ChatWindow.tsx:201-204` renders only `WelcomeScreen` in the draft branch; there is no pill and
  no folder, so the S7a welcome treatment has no defect to fix.

**Resolution:** measure pill widths in the geometry test and assert the real outcome; make the
notice width an S5 decision; drop `WelcomeScreen` from S7a (§12.12/12.14).

### 18.8 `--status-reserved-height` was two values

Rev 14 fixed the content-box/flow-box mix in §15.2a.4 (46 px) but left "38 px" as the property's
value in §15.2a.2/§15.2a.3.

**Resolution:** the property is **46 px** (row border-box = 38 px pill + 8 px spacing) in all
three places. 38 px is only ever the pill content.

### 18.9 Direct resolver ownership (minor)

Direct's workspace shell tool is `run_command` (`src/tools/index.ts:256`), which
`getToolRunningLabel` does not map, so it falls back to `"run_command…"`. Conversely `execute`
and `patch` have no Direct tool. S1 is behaviour-preserving; S3 removes only `shell` in Rev 14.

**Resolution:** remove `execute`/`patch` from the Direct resolver at S3; map `run_command` (and
the other real Direct names that already have `toolsConfig` verbs) or record it as deferred.

### 18.10 Corrections of record

- `OpenCodeRetryBanner` border-box height is **30 px**, not 32 (`py-1.5` 12 + `text-xs` 16 +
  borders 2). It is deleted in S3.
- `tests/unit/web/components/agent-status-defaults.test.ts` **does not exist** at `2804f94`, and the
  path was wrong: S5 created `tests/dom/components/agent-status-defaults.test.tsx` (10 cases).
- §17.7's "execution.error … `statusView.ts:149`/error branches" is wrong: no execution-error
  branch exists; §17.7 is corrected in Rev 15.
- The docs study (2026-10-28) is recorded in §16.4: props and anatomy match the vendored copy;
  `useTaskSummary`/`TaskTray` are documented but not in the installed train; the vendored element
  has no live region.

---

## 19. Rev 16 — implementation record (2026-10-29)

Everything below is what was **in the working tree** when the local verification ran; §19.6 and
§19.7 are the live-provider work that followed it, and the status line above records the commit.
The handoff report carries the exact command output; this section carries the stage ledger and
the facts that changed a plan statement.

### 19.1 Stage ledger

| Stage | State | Evidence |
|---|---|---|
| **S1** — engine-neutral analyzer + Direct hook + Direct resolver | done | `tests/unit/web/lib/assistantActivityParts.test.ts` 8 pass; `tests/unit/web/components/assistantActivityMapping.test.ts` 3 pass; hook reads `lastMessage.content` |
| **S2** — OpenCode resolver | done | `tests/unit/web/opencode/toolActivityLabel.test.ts` 7 pass (`shell`/`execute`/`patch` owned here) |
| **S3** — atomic ownership handoff | done | `OpenCodeRetryBanner.tsx` + its test deleted; `OpenCodePrimaryStatus.tsx` new (30 DOM cases); `statusView` 17 unit cases; `data-primary-status` / `data-restoration-notice` markers; heart error branch removed (12 DOM cases) |
| **S5** — vendored `AgentStatus` trailing + notice re-skin | done | `agent-status-defaults.test.tsx` 10 pass (includes "interactive trailing is not inside an `aria-hidden` subtree"); notice 19 DOM cases; decision recorded in `docs/decisions.md` (not repeated here) |
| **S6** — retry/step projection exclusion | done | `v2MessageProjection.test.ts` 19 pass, incl. typed execution error preserved and a part-less error message still projected |
| **S7a** — reserved status row + `composerExtras` | done | `chat-layout-stability.test.tsx` 15 pass; `chat-window-status-pill.test.tsx` 2 pass; `OpenCodeView` 6 pass (slot split); E2E `status-layout-stability.spec.ts` 6 pass in Chromium |
| **S7b** — document correction | this revision | `docs/2026-10-27-unified-agent-status-and-composer-parity-plan.md` rewritten; §19 added |
| **S4** | not resurrected | its content stayed in S3, as planned |

### 19.2 Facts that corrected the plan

- **Two-line row is 92 px, not 84 px.** S5 made the notice an `AgentStatus`, and every `AgentStatus`
  is 38 px because its `size-6` trailing wrapper is unconditional. Measured in the browser
  (38 + 8 gap + 38 + 8 padding). Every 84 px / 76 px / "30 px notice" figure above is superseded
  (§15.2a.4 is updated; the Rev 11–15 narrative is left in place as revision history).
- **The narrow width is the product's 480 px, not 320 px.** `src-tauri/tauri.conf.json` declares
  `minWidth: 480`; at 320 px the composer's content box collapses to 16 px, which is not a layout the
  product supports. The E2E spec therefore measures 480 px and records 176 px of row content.
- **The transient y-shift the first E2E run reported was not a status-row effect.** The transcript
  header mounts `ThreadBootSkeleton` while history loads; a 50 ms probe showed the scroller going
  `y=104 h=446 → y=408 h=142 → y=104 h=446` while the status row (`y=566 h=46`) and the composer
  folder never moved. The spec now samples **post-settle** (boot skeleton absent and two consecutive
  identical geometry samples) instead of asserting on the first frame. This is a load-state
  transient, not layout instability, and the spec says so in its header.
- **Direct presents no primary while an approval is pending.** `thread.isRunning` is false for a
  `requires-action` tool part, confirmed by the E2E annotation. The approval fixture in the spec
  therefore asserts an empty-but-reserved row (46 px), which is the correct outcome for the Direct
  lane; Code mode reads `extras.permissions` and does present.
- **`tests/dom/components/agent-status-defaults.test.tsx`** is the S5 test path (§18.10 said
  `tests/unit/web/components/...test.ts`).

### 19.3 Test ledger (2026-10-29, this tree)

Unit — 115 cases over 8 files, 0 fail: `v2MessageProjection` 19, `v2RetryActivity` 27, `statusView`
17, `assistantActivityParts` 8, OpenCode `toolActivityLabel` 7, `assistantActivityMapping` 3, Direct
`toolActivityLabel` 3, `no-orphan-modules` 31.

DOM — 105 cases over 8 files, 0 fail: `OpenCodePrimaryStatus` 30, `OpenCodeRecoveryNotice` 19,
`chat-layout-stability` 15, `OpenCodeStatus.recovery` 12, `assistant-message-error` 11,
`agent-status-defaults` 10, `OpenCodeView` 6, `chat-window-status-pill` 2.

E2E — `tests/e2e/virtualizer/status-layout-stability.spec.ts` 6 passed / 0 failed / 0 skipped
(`chromium-headless`).

The repository-wide gates (`typecheck`, `lint`, `format:check`, `test:locations`, `build`, the full
`test` / `test:dom` / quarantine chains, and `verify`) are run as the final step of this change; the
handoff report records their exit codes and counts. They are **not** asserted here on the strength of
the focused suites.

**Re-run on 2026-10-29, `bun run verify` exit 0**: four-project `typecheck`; `biome ci
--error-on-warnings` and `biome format .` over **1062 files**, no fixes applied; `test:locations` OK;
`build` OK; `test` **5071 pass, 66 skip, 0 fail — 5137 tests across 381 files**; `test:shutdown` 1
pass; `test:startup-rollback` 2 pass; `test:lifecycle-integration` 3 pass; `test:dom` **643 pass,
0 fail across 62 files**; `test:quarantine` OK.

### 19.4 Remaining external verification gaps

1. **CI has not run this change.** `2804f94` is the last commit CI saw, and its run `40527025056`
   failed only the `tauri` G1 packaged-WebView step for an **unclassified** cause (§14). No
   full-CI certification is claimed for this tree or for that commit.
   **Superseded 2026-10-29, not rewritten:** the change was pushed and CI ran on it twice
   (`40857768051` at `8f3f2d2`, `40857787405` at `38b2d91`). Both runs are red in `e2e`, and the
   cause, the two fixes and the remaining gap are §19.8. The `tauri` flake named above is unchanged.
2. **The 2.2.0 `OPENCODE_VERSION` pin has never executed on a GitHub Actions runner.** The
   committed workflow still pins 2.1.2. Everything checkable off a runner was checked on
   2026-10-29: the workflow's `OPENCODE_CLI_SHA512` constant, npm's `dist.integrity` for
   `@opencode/cli-windows-x64@2.2.0`, and a fresh download of that tarball all hash to the **same**
   sha512 (`S/eVkz…FkBA==`; 118,650,212 bytes); the tarball contains `package/bin/opencode.exe`;
   the installed binary reports `opencode v2.2.0`; and the two workflow tooling guards
   (`opencode-runtime-gate`, `verify-script`) pass 47/47 (84 assertions, exit 0). Running the pin
   itself needs a push, which this change did not make.
   **Superseded 2026-10-29, not rewritten:** the pin was pushed and executed on a runner in both
   post-push runs — `40857768051` at `8f3f2d2` and `40857787405` at `38b2d91`. Each log records
   `OPENCODE_VERSION: 2.2.0`, `Unpacked opencode 2.2.0 from the npm registry (sha512 verified).`,
   `opencode --version: opencode v2.2.0`, and then **`7/7 required runtime suites passed`**. That
   is the first runner evidence behind the pin; it does not cover the excluded suite (item 4).
3. **Live acceptance suites were not run, apart from the credential-free case in §19.5 — and the
   earlier "six" was wrong.** There are **seven**
   `tests/e2e/opencode/*-live.spec.ts` files. **Five need a real model** (and therefore a provider
   credential): `big-pickle` (the metered free tier — attempted, blocked by an exhausted free-tier
   quota; §19.6), `edit-approval-diff`, `model-chip`,
   `v2-edit-reload`, `v2-permission`. **Two need only a live managed server and its real config, no
   LLM**: `config` (which reads and writes the host's real OpenCode configuration — not run here,
   because that is the user's file) and `config-override` (the G3 case, which owns an isolated
   fixture and server). The E2E suite otherwise runs the stub provider, so real-provider streaming
   is not covered by anything in this change. Note that the four remaining model-dependent specs
   bind `agnes/agnes-3.0-flash` (`tests/e2e/helpers/opencode-live-fixtures.ts:21`), a provider the
   hermetic E2E harness deliberately does not have: it isolates `XDG_CONFIG_HOME`, so no global
   provider credential exists in that environment. **Those four were subsequently run against the
   host's own OpenCode configuration directory — see §19.7**: three pass with agnes answering, and
   `edit-approval-diff` is blocked because the host's config carries `//` comments and TBAi refuses
   to edit a document it cannot re-serialize.
4. **`opencode-native-compaction-conformance` stays excluded** from the required set until the 2.2.0
   pin runs green on CI. It was re-run directly on 2026-10-29 against the local 2.2.0 binary
   (`TBAI_OPENCODE_RUNTIME_TESTS=1 bun test
   tests/integration/opencode/opencode-native-compaction-conformance.test.ts --timeout 120000`):
   **8 pass, 0 fail, 24 assertions, exit 0**, covering automatic compaction, a second automatic
   compaction in the same session, manual compact, the event-stream lifecycle (120.8 s), durability
   and meter recovery. A local pass is not the CI run the exclusion names, so the exclusion stays.
   **The exclusion's own stated precondition is now met (2026-10-29).** Its reason in
   `scripts/run-opencode-runtime-suites.ts` says "re-admit after the 2.2.0 pin runs green on CI", and
   the pin has now run green on a runner (item 2). The suite is still excluded, so nothing on CI has
   executed it, and removing the entry adds a suite to the required set — a deliberate change with
   its own runner observation, not a fold-in. It stays excluded in this diff and is flagged as
   ready for re-admission; the reason string is left as written rather than half-corrected.

### 19.5 The credential-free live case, run locally (2026-10-29)

The one `*-live` spec that needs neither a model nor the maintainer's configuration — the G3
override case — was run twice on this tree (`bun run test:opencode-g3 --project=edge-headless`).
**All four case-executions passed their assertions** against a real `opencode v2.2.0` server: each
fixture's row 1 rendered its exact notice ("Never applies — row 2 wins for every request." /
"Partly overridden — row 2 wins for the resources it matches.") with the explanatory title, row 2
rendered no notice, and `GET /api/config` reported the fixture path rather than a discovered
document.

Two earlier runs of the same command **exited 1**, on one cleanup step each time:
`taskkill /F /PID <n> exited 1 … The operation attempted is not supported`, for a recorded
descendant pid — the assertions had passed in those runs as well. That attribution is
**withdrawn**: at the time, this machine's Device Guard policy was refusing generated
`node_modules/.bin/*.exe` launchers, and it refused `taskkill` its targets too. With the policy
off, the same command was run **twice more: exit 0, both cases PASS** (`cases ok: 2, failed: 0`),
and re-running `bun run verify` reproduced the §19.3 counts exactly. No defect in
`scripts/lib/process.ts` is claimed.

Every number in §19.3 and here is from the stock tooling: `bun run verify` and
`bun run test:opencode-g3` invoked as written, with the original `node_modules/.bin` launchers in
place (the temporary `.cmd` shims were removed).

### 19.6 The Big Pickle live run, and the two stale probes it found (2026-10-29)

The metered free-tier model was authorised for this environment, and the live spec that drives it
was run against a real managed server:

```
TBAI_E2E_LIVE=1 bun run test:e2e --project=edge-headless opencode-big-pickle-live
```

**Exit 1 — and the model, not the product or the spec, is the reason.** The managed server's own
log records the turn failing before it produced a token:

```
level=ERROR message="Failed to drain Session" cause="AI.Error: Free usage limit reached.
Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going …"
  [cause]: AI.Error.QuotaExceeded: Free usage limit reached. …
```

The free tier is exhausted for the OpenCode account this host uses, so the model the spec requires
cannot answer. What did execute behaved correctly: the model was advertised by the managed server,
the prompt was admitted (HTTP 200, 1810 ms), the turn was observed in flight at **1839 ms**, an
assistant turn was rendered, and the disposable conversation was deleted. The run is therefore an
**environment block on the answer**, not evidence about the status surfaces.

**Two stale probes, retired in the same change.** The spec waited for
`getByRole("button", { name: "OpenCode status: Working" })`. That label is unreachable after S3:
`statusView` returns `working` only for `connection.type === "reconnecting"`
(`web/src/features/opencode/statusView.ts:130-132`), and a healthy active turn is `idle
"Connected"` **by design** (rule stated at lines 106-109). The probe asserted the contract S3
deliberately retired, so a timeout was guaranteed. Both call sites now probe the surface that owns
the fact:

| File | Before | After |
|---|---|---|
| `tests/e2e/opencode/opencode-big-pickle-live.spec.ts` | heart `Working` = "turn running" | the composer's `Stop generating`, mounted for the whole of `thread.isRunning` |
| `tests/e2e/opencode/opencode-v2-code-route.spec.ts` | heart `Working` OR the assistant action | `Stop generating` OR `Regenerate response` |

Neither replacement weakens an assertion: the live spec still fails when the turn never starts, and
the code-route spec still requires the turn to be observable in one of its two states. The new probe
is what produced the 1839 ms evidence above, so it is demonstrated to observe a running turn rather
than merely to stop failing. `tests/e2e/virtualizer/status-layout-stability.spec.ts` already used
this idiom (its "Stop generating" wait at line 289 and `[data-primary-status]` assertions), so the
two edited specs now agree with it. The edited code-route spec was re-run on this tree
(`bun run test:e2e --project=edge-headless opencode-v2-code-route`): **1 passed in 19.7 s, exit 0**.

**Gates re-run after the two spec edits**, on this tree: `bun run typecheck` exit **0** (all four
projects); `bun run lint` (`biome ci --error-on-warnings`) and `bun run format:check` each exit
**0** over **1062 files**, no fixes applied; `bun run build` exit 0 (re-run by the E2E driver,
9.26 s). `test` and `test:dom` were **not** re-run: neither collects `tests/e2e`, and the only
changes since the §19.3 run are those two spec files and this document, so the §19.3 counts stand
for unchanged code rather than being re-asserted.

**A separate, pre-existing finding this run exposed — named, not fixed.** A provider failure inside
`opencode serve` leaves the transcript with an **empty assistant turn and no error text**: the page
snapshot shows the assistant row carrying only a disabled `Copy message` and `Regenerate response`,
the session read returns zero text parts, and nothing on screen mentions the quota error above. The
projection renders an error only when `execution.type === "error"`
(`web/src/features/opencode/v2MessageProjection.ts:374-418`), which `session.execution.failed` sets
(`web/src/features/opencode/v2Events.ts:668-680`); `session.step.failed` marks only the step part,
and S6 projects step parts to `null` (`v2MessageProjection.ts:184`). This is **not a regression from
S6**: the pre-S6 projection emitted an empty text part for a step, i.e. the same empty bubble. Which
link loses the failure — the server's SSE payload or the client's application of it — is **not
established**; attributing it needs an SSE capture of a genuinely failing step. That is a separate
change with its own evidence, and it is not part of S1–S7b.

The follow-on dependency work — the deferred `@assistant-ui` train move — is planned separately in
`docs/2026-10-29-assistant-ui-train-upgrade-plan.md`. It is not part of this plan and it is not
authorized by it.

### 19.7 The agnes live run: what the four provider specs actually prove (2026-10-29)

The four remaining model-dependent specs were run against the real managed `opencode v2.2.0` server
with `agnes/agnes-3.0-flash` answering. One combined run is the record:

```
OPENCODE_CONFIG_DIR="C:/Users/RTPC/.config/opencode" TBAI_E2E_LIVE=1 \
  bun run test:e2e --project=edge-headless \
  opencode-model-chip-live opencode-v2-permission-live opencode-v2-edit-reload-live
```

**Exit 0 — `spec files ok: 3, failed: 0`, six tests:**

| Spec | Result | Time |
|---|---|---|
| `opencode-model-chip-live` | 3 passed | 5.1 s |
| `opencode-v2-permission-live` | 2 passed | 2.1 min |
| `opencode-v2-edit-reload-live` | 1 passed | 2.5 min |

That run is the first evidence in this work that a real model drives the Code surface end to end: a
real gated shell call was approved and its output landed, a real edit was proposed and its patch
survived a reload, and the chip matched the session's bound model through a hydration and a reload.

**Why the earlier agnes attempt failed, and why the model was never the reason.** The shared fixture
hardcoded `opencodeVariant: "high"` when creating a Code conversation. The agnes provider declares
no variants, so the managed server refused the turn before calling the model:
`SessionRunnerModel.VariantUnavailableError: Variant unavailable for agnes/agnes-3.0-flash: high`.
The variant is gone (`tests/e2e/helpers/opencode-live-fixtures.ts`): the model is the only
selection, and a provider that declares a variant is the provider that decides it has one.

**How the provider is supplied.** The hermetic E2E harness isolates `XDG_*`, so it has no provider
at all (§19.4 item 3). The run points the managed child at the host's normal OpenCode configuration
**directory** through `OPENCODE_CONFIG_DIR` — OpenCode's own variable, resolved by OpenCode itself —
rather than at a specific JSON file. Nothing from that directory is copied, committed, or echoed;
the credentials never leave the host.

**Two spec defects the run found, both fixed:**

1. `opencode-model-chip-live` derived the expected chip text as `id.split("/")[1]`. With the host's
   default model (`openrouter/particle-ai/particle-1`) that yields the *provider prefix*, and the
   retrying matcher timed out against `"Particle-1"`. The name is the **last** segment, and the
   one-shot check is case-insensitive because the chip display-cases it.
2. `opencode-v2-permission-live`'s negative case waited for the heart to read `OpenCode status:
   Error`. S3 retired that: the heart reports transport health only, so a failing turn leaves it
   `Connected`. The precondition is now "the turn ran and ended, and the heart is still Connected" —
   the S3 contract itself. The transcript error card for this failure is **absent today** (§19.6);
   the spec says so at the call site instead of asserting a card that does not exist or skipping.

**One intermittent failure, named rather than retried away.** A separate run of the permission spec
failed with the gate never appearing; the aria snapshot showed the turn still in flight at
**2m 59s** with `status: Retrying, attempt 7`. The provider was retrying and had not produced the
tool call, so the gate was never requested. The same test passed alone in **1.5 min** immediately
after. That is provider-side timing, not a product verdict, and no retry logic was added to the spec.

**`opencode-edit-approval-diff-live` cannot run in this environment, in either direction.** It arms
`edit/*` to `ask` through `/api/opencode/config/permissions`, which writes the selected config
document. With `OPENCODE_CONFIG_DIR` set, the selected document is the host's
`C:\Users\RTPC\.config\opencode\opencode.json`, which contains `//` comments: OpenCode accepts it,
and `readOpenCodeConfigDocument` reports `editable: false` because it re-serializes with strict
`JSON.parse`. The spec fails by design (`the OpenCode config is not editable`, not a skip). Without
the override there is no provider, so no model, so no gate. That is a pre-existing limitation of
TBAi's config writer (JSONC is not editable), not something this change introduced, and it is
reported rather than worked around.

### 19.8 The red `e2e` job after the push: two different natures (2026-10-29)

**What CI actually reported.** The push produced two runs — `40857768051` at `8f3f2d2` and
`40857787405` at `38b2d91`. Both are red in `e2e` and green in `verify`, `opencode-runtime` and
`opencode-g3`; `e2e-full` and `e2e-big-pickle` are skipped (dispatch-only, and a skip is not a
pass). Each `e2e` job ends `spec files ok: 6, failed: 1`, and in both runs the one failing case is
the same, at the same line:

```
1) … p2-history-load-recovery.spec.ts:536:2 › K-I8: after a successful load, an outage
   re-issues NO request and keeps the messages
   Error: expect(locator).toBeVisible() failed … element(s) not found
     > 110 |   await expect(page.getByText(text)).toBeVisible({ timeout: 30_000 });
       at expectTipLoaded (…p2-history-load-recovery.spec.ts:110:37)
       at …p2-history-load-recovery.spec.ts:573:12
```

Line 573 is the **oldest** seeded message. `K-I4` — the revisit case, and the one this session's
instrumented runs caught failing — passed in both CI runs.

`tauri` is a separate signal and is **not** claimed: it failed at `8f3f2d2` inside the packaged-app
smoke step with `packaged app did not become ready (exited=False)` — the same unclassified class as
`2804f94` (§14) — and passed at `38b2d91`, whose diff is documentation only. Nothing in this change
touches that job; it stays an open flake.

**K-I8 asserted that the whole conversation fits one window.** The transcript is virtualized, so only
the mounted window is in the DOM. K-I8 asked for the newest and the oldest seeded row to be visible
at the same time, which holds only while the whole seeded conversation fits the 1280×720 default.
The per-message chrome committed in `8f3f2d2` (`SessionTimeline` on the first part row, error card
and copy/regenerate footer on the last) made 12-message conversations taller than that window, and
the assertion — not the transcript — broke. Control, run at the base commit with nothing from this
change applied: the same spec is **9 passed** at the default viewport and **8 passed, 1 failed** at a
480 px viewport, the single failure being K-I8. The assertion encoded viewport fit; shrinking the
window reproduces it without any product change.

The fix asserts the claim the case is actually about: the newest message is visible, then a **real
wheel gesture** scrolls to the top (`scrollTop === 0`, polled) and the oldest message is asserted
there. This is the pattern already used by `p2-direct-history-window.spec.ts:160-199`
(hover the scroller centre, `mouse.wheel`, poll), not a new mechanism. The comment at the call site
records why the two-visibility form was wrong.

**K-I4 was the real regression, and a green CI run is not evidence it is gone.** Locally the same
spec failed K-I4 in **3 of 3** runs at this change while passing 9/9 at `2804f94`. It passed in both
CI runs because the defect is a measurement-timing race, and a runner's timing is not this machine's.
Instrumenting the virtualizer showed the sequence: while rows are re-measured after a re-entry the
virtualizer issues its own corrective scrolls, one of which moves the offset **up**; the code read
that as a reader's upward gesture and disarmed the sticky pin; the next correction was then applied
unguarded, to a stale target. Measured on the failing path: `top 147` while the live end was `396`
— 249 px short of the newest message, with the newest rows unmounted, and no later write re-asserting
the end.

`web/src/components/VirtualizedTranscript.tsx` now holds two invariants:

1. `scrollToFn` refuses any write whose **target** is above the live end while the pin is armed. The
   guard tests the target, not the current position: a correction the component already applied is
   not a reader's intent.
2. `writtenTopRef` records the offset this component wrote (`max(0, scrollHeight - clientHeight)`,
   the clamp-safe end offset); a scroll event landing on that offset is our own write and does not
   disarm stickiness. Reader disarming still requires a real upward movement with the height and
   client size unchanged.

Nothing else was touched: `estimateSize` is unchanged (its own comment forbids tuning it to paper
over measurement churn), no retry, timer or extra settle delay was added, and the assertion that the
pin holds was not relaxed. The rationale lives in the file, at the ref.

**Local evidence on the fixed tree.** These are the numbers this record is allowed to cite:

| Run | Result |
|---|---|
| `bun run test:e2e --project=chromium-headless p2-history-load-recovery.spec.ts` | **9 passed (46.0 s)**, exit 0 (base `2804f94`: 9 passed, 45.2 s) |
| the 10 virtualizer/scroll guard files (`initial-scroll-range`, `mouse-activation`, `run-start-scroll`, `scroll-anchoring-regressions` R1–R4, `scroll-to-latest`, `status-layout-stability`, `transcript-header-contract`, `virtual-end-distance`, `p2-measurements`, `p2-streaming`) | `spec files ok: 10, failed: 0` — **20 passed, 0 failed, 1 skipped**, exit 0. The skip is `run-start-scroll.spec.ts:134`, skipped by design. |

`scroll-anchoring-regressions` is the guard for the code that changed: R1–R4 still pass, including
R2 (an append while the reader is scrolled up does not move the read position) and R4 (measurements
survive a thread switch and a remount, and come back current).

**Repository-wide gates on this tree, `bun run verify` exit 0:** four-project `typecheck`; `biome ci
--error-on-warnings` and `biome format .` over **1062 files**, no fixes applied; `test:locations` OK;
`build` OK; `test` **5071 pass, 66 skip, 0 fail — 5137 tests across 381 files (322.4 s)**;
`test:shutdown` 1 pass; `test:startup-rollback` 2 pass; `test:lifecycle-integration` 3 pass;
`test:dom` **643 pass, 0 fail across 62 files**; `test:quarantine` OK. The unit/integration and DOM
totals are unchanged from §19.3 — this change adds no test case; it repairs one product invariant
and corrects one assertion that was never measuring the claim it named.

**`p2-paging` hangs locally and that is not this change.** In this environment it reaches the 600 s
test timeout with the "load earlier" control disabled and Playwright reporting an element detached
from the DOM. It does the same at the base commit `2804f94` (1 passed in 10.1 min), while the CI
runner ran the file in **6.8 s** at `38b2d91`. It is local-environmental and pre-existing, is not
attributed to this change, and is not papered over by raising a timeout or loosening the
`loadEarlier` poll.

**A CI run now exists for these fixes — run `40869474036` at `a170def` — and the `e2e` job is
green:** `spec files ok: 7, failed: 0`, with `p2-history-load-recovery` **9 passed (47.5 s)**
including both K-I4 and K-I8, `p2-direct-history-window` 1, `p2-paging` **2 passed (5.9 s)**,
`p2-live-runtime` 4, `p2-tool-result-persistence` 3, `phase-8-tabs-navigation` 8 and
`opencode-v2-code-route` 1. `verify`, `opencode-runtime` and `opencode-g3` are green in the same run;
`e2e-full` and `e2e-big-pickle` stayed skipped. The runner's 5.9 s on `p2-paging` is the parity the
local-hang paragraph above was measuring against.

**`tauri` failed in that same run, and this change is not what failed.** The packaged-app smoke step
passed; the failure is in the G1 origin observation — `verify:packaged-origin` exited 1 with
`[g1] stage: (teardown only)` and a teardown `taskkill` that reported "no running instance of the
task". That is a different step and a different symptom from `8f3f2d2`
(`packaged app did not become ready (exited=False)`), and the job passed at `38b2d91`. It stays an
open, unclassified flake; nothing here claims it fixed.

### 19.9 The `tauri` G1 blocker: two observation defects, both fixed and observed (2026-10-29)

**Rev 19 supersedes the "open flake" status in §19.8** for the G1 step only — §19.8's diagnosis of
the `e2e` job stands unchanged, and the `8f3f2d2` smoke-step failure ("packaged app did not become
ready") remains unclassified and untested here.

**What run `40871453744` (commit `2ae81b0`) actually recorded.** `POST /session` returned 200 with a
WebView2 capability set (`browserVersion 155.0.4283.62`, `goog:processID` present); the port mirror
reported `3000`; the direct probe read an `instanceId`; the packaged build, the smoke test and G2 all
passed. The page read in the same run was `{origin: "null", href: "about:blank", title: ""}`, and the
in-origin fetch then failed with `TypeError: Failed to fetch`. The artifact at `38b2d91` had read
`http://app.localhost` with probe 200 and a matching instance id, and the run at `a170def` observed
the same and then failed at teardown. Neither `src-tauri/tauri.conf.json` nor `src-tauri/src/main.rs`
changed across those commits: one configured `main` window, `frontendDist: "app://localhost"`, an
`app` protocol handler, and no navigation call anywhere in Rust.

**Two defects, one in the observation and one in its cleanup.**

1. *The read raced the document load.* `tauri-driver` attaches to the WebView2 page target as soon as
   it exists, which is before Tauri commits the navigation to `app://localhost`; the port mirror that
   gates the script is written by the Bun sidecar as it boots, so it exists before the document does.
   The script took exactly one `execute/sync` immediately after `port-wait`, so a read landing in that
   window became the run's evidence — and the blank document's `origin` is the string `"null"`, which
   the old code reported as an origin the app had chosen. That is an observation-script
   synchronization defect, not an application-navigation one: the same build navigated in the runs
   that read later. It is also not a wrong-window attachment — there is one window, and the fix now
   records the driver's handle count on any failure so that hypothesis stays distinguishable.
2. *A successful observation could still fail at cleanup.* `stopProcessTree` tolerated only
   `taskkill` exit 128 ("process not found"). The windows-2025 runner also reports an already-exited
   pid as exit 1 with `Reason: There is no running instance of the task.`, which is how `a170def`
   failed after its observation had passed.

**The fix (`ec15de0`, `3d90d6f`).** `executeScript` now polls the page until it has left
`about:blank`, bounded by `NAVIGATION_TIMEOUT_MS` (60 s), and records `{attempts, elapsedMs,
timeoutMs, timedOut}` as `navigation` in `packaged.json`. The loop stops on a real origin — right or
wrong — and on a read that did not happen, because neither is a slow load; a wrong origin is still
rejected by the unchanged exact-equality test against `EXPECTED_PACKAGED_ORIGIN`. When nothing loads,
the run additionally records the driver's `window/handles`, and the failure names the wait and the
handle count instead of reporting the blank page's `"null"` as a wrong origin. The in-origin fetch now
runs only after a document loaded: a blank page has no origin to ask from, and the old path added a
second, consequential "Failed to fetch" failure. `isTaskkillAlreadyGone` accepts the exit-1 form; the
stop is still confirmed against a fresh process table, so a pid that really survived is still
reported from `survivors`.

**Local gates, `bun run verify` exit 0 at `ec15de0`+`3d90d6f`:** four-project `typecheck`; `biome ci
--error-on-warnings` and `biome format .`; `test:locations`; `build`; `test` **5081 pass, 66 skip,
0 fail — 5147 tests across 382 files (319.5 s)**; `test:shutdown` 1; `test:startup-rollback` 2;
`test:lifecycle-integration` 3; `test:dom` **643 pass, 0 fail across 62 files**; `test:quarantine`.
The tooling suites are **270 pass, 0 fail across 9 files**. The new guards were exercised against the
defect: with the poll reduced to a single read, three of the new cases fail; restored, they pass.

**The runner result — run `40889992913` at `3d90d6f`, all jobs green:** `verify`, `e2e`,
`opencode-runtime`, `opencode-g3` and `tauri` succeeded; `e2e-full` and `e2e-big-pickle` stayed
skipped (dispatch-only). The uploaded `packaged.json` records a real observation of the packaged
WebView:

| Field | Value |
|---|---|
| `script` | `origin: http://app.localhost`, `href: http://app.localhost/`, `title: TBAi` |
| `navigation` | `attempts: 1`, `elapsedMs: 575`, `timedOut: false` |
| `probe` | `status: 200`, body `{"instanceId":"88c09423-…"}` |
| `appInstanceId` | `88c09423-…` — **equal to the in-origin read** |
| `observations` | `originMatchesExpected: true`, `inOriginApiStatus: 200`, `instanceMatchesApp: true` |
| `assessment` | `ok: true`, `stage: null`, `failures: []` |
| `teardown` | `sessionDeleteStatus: 200`, `confirmed: true`, `survivors: []`, `errors: []` |
| `host` | `integrity: medium`, `elevated: false` |

G2 passed in the same run with `origin http://localhost:3000`, `targetsSeen ["page
http://localhost:3000/"]` and a clean teardown of 12 recorded pids.

**A second run repeats it.** The docs-only commit `7bef5ab` produced run `40892621675`, also green in
every push job, and its artifact records the same observation — `origin http://app.localhost`,
`href http://app.localhost/`, `title TBAi`, `navigation {attempts: 1, elapsedMs: 174, timedOut:
false}`, probe 200 with an instance id equal to `appInstanceId`, `assessment.ok: true`, teardown
`confirmed: true` with no errors.

**What those runs do and do not prove.** They prove the new path end-to-end on a real runner: a real
packaged WebView on the documented origin, a real in-origin API read agreeing with the app's own
instance id, and a clean teardown. They do **not** prove the race was hit and survived — both report
`attempts: 1`, so the first read already found the loaded document and either run would also have
passed against the old code. The retry itself is proven by the deterministic test (blank, blank,
loaded → 3 reads → `ok`), not by these runs. The `tauri` job has produced four distinct outcomes
across five runs before this change, so two greens are not a stability measurement; the change is
justified by the artifact evidence plus the code-level test, and the next recurrence would name
itself through `navigation` and the handle count.

**Rev 20 (2026-10-29) — identity is required evidence, not corroboration.** Every run above recorded
a direct `127.0.0.1` read whose `instanceId` equalled the in-origin one, but the `fetch` stage only
made that comparison *when the direct read had produced an id*, so a run whose direct probe failed
could pass on an in-origin 200 alone. An origin plus a 200 prove that a server answered from
`http://app.localhost`; they do not prove it was the backend this launch started — the rule G2
already enforces. The accepted rule is now: correct origin, in-origin `GET /api/server/instance`
returning 200, a non-empty `instanceId` on **both** reads, and the two exactly equal. Missing,
blank or unreadable evidence fails at `fetch` and is reported with the direct read's status or error;
it is never described as a mismatch, because nothing was compared. `packaged.json` gains
`directProbe {status, error}` and `observations.inOriginInstanceId`, and
`observations.instanceMatchesApp` is `true` only when both ids were read and are equal.
`tests/unit/tooling/webview-origin-evidence.test.ts` replaces the case that accepted a missing
direct id, adds four cases (blank direct id, the direct read's reported cause, a whitespace
in-origin id, and equality after trimming) and strengthens two. The guards were exercised against
the defects: with the old lenient comparison three cases fail, and with an untrimmed id three fail.
**Observed on a runner (2026-10-29, commit `b440e20`, run `40904866839`).** The `tauri` job passed
and its G1 step passed with it; `packaged/packaged.json` carries `directProbe {"status": 200,
"error": null}`, a non-empty `appInstanceId`, `observations.inOriginInstanceId` equal to it,
`observations.instanceMatchesApp: true`, and `assessment {ok: true, stage: null, failures: []}` — at
the expected origin `http://app.localhost`, observed at medium integrity, with teardown confirmed.
G2 passed in the same job with its own `devInstanceIdMatched: true`. The artifact is
`tauri-webview-origin` on that run.
