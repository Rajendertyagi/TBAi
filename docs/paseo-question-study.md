# Deep Study: Paseo's OpenCode Question System (Read-Only)

All findings verified against `D:\Temp\paseo` source on disk. No files modified.
Study date: 2026-09-18.

---

## A. Repository / version findings

- **Repo:** Paseo monorepo, root `package.json` → `"name": "paseo", "version": "0.8.0"`.
- **OpenCode SDK:** `@opencode-ai/sdk` pinned to **`1.14.46`** — Status: PROVEN. Evidence: `packages/server/package.json:81`, `package-lock.json:38996,39463`, `patches/@opencode-ai+sdk+1.14.46.patch`, `packages/server/src/server/agent/providers/opencode/options.ts:10` ("maintained against @opencode-ai/sdk 1.14.46").
- **SDK generation used: V2, no compatibility adapter** — Status: PROVEN. Evidence: every OpenCode import comes from `"@opencode-ai/sdk/v2/client"` (`opencode-agent.ts:1-13`, `opencode/event-consumer.ts:1-5`, `opencode-bridge.local.e2e.test.ts:5`). Client constructed via `createOpencodeClient({ baseUrl, directory })` (`opencode-agent.ts:1389-1391`).
- **Event transport:** single global SSE stream `client.global.event(...)` — Status: PROVEN. Evidence: `opencode/event-consumer.ts:168-176` (`sseMaxRetryAttempts: 0`, watchdog 30s, reconnect with backoff).

## B. OpenCode client architecture (real flow)

```text
opencode serve (managed child process)
 → OpenCodeServerManager (owns process, acquisition/release)
 → OpenCodeEventConsumer (global.event SSE → GlobalEvent, reconnect/backoff)
 → OpenCodeAgentSession.consumeOpenCodeStreamEvent / translateEvent
 → AgentStreamEvent { permission_requested (kind tool|question), timeline, turn_* }
 → pendingPermissions Map + daemon snapshot (pendingPermissions[])
 → app client → agent-stream view → PermissionRequestCard → QuestionFormCard
 → session.respondToPermission(id, response)
 → client.question.reply / question.reject  OR  client.permission.reply
 → OpenCode resumes; pending entry deleted; permission_resolved emitted (recovery path)
```

- **Process ownership:** `opencode/server-manager.ts` (via `OpenCodeAgentClient`, `opencode-agent.ts:1399-1437`). Status: PROVEN.
- **Event subscription:** `OpenCodeEventConsumer.subscribe(listener)` fan-out to sessions; `ready()` resolves on first `server.connected` (`event-consumer.ts:90-122, 183-188`). Status: PROVEN.
- **Session handling:** `OpenCodeAgentClient.createSession` → `client.session.create({directory})`; resume re-attaches by sessionId (+ child-session server-URL registry, `opencode-agent.ts:200-218, 1439-1548`). Prompts via `session.promptAsync` / `session.command`. Status: PROVEN.
- **Permission/question handling:** unified `pendingPermissions: Map<id, AgentPermissionRequest>` + `pendingPermissionDirectories: Map<id, directory>` (`opencode-agent.ts:3353`, `5275-5276`). Status: PROVEN.

## C. Question data model

OpenCode emits **`question.asked`** (distinct event from `permission.asked`), dispatched at `opencode-agent.ts:2258-2260` → `appendOpenCodeQuestionAsked` (`3010-3058`).

Paseo consumes (in its own words): an object with `id` (request ID), `sessionID`, a `questions` array, and a `tool` object. Each array element carries `question` (body text), `header` (short key), optional `options[]` (each `label` + optional `description`), and optional `multiple` flag. Malformed entries (missing `question`/`header`) are dropped; a request with zero valid questions is ignored (`3018-3040`).

Paseo's normalized form (`input.questions[]`): `{ question, header, options[{label, description?}], multiSelect?, allowOther: true }`. **Paseo hard-codes `allowOther: true` for every OpenCode question** (`3033`) — freeform is always offered regardless of what OpenCode sent. `multiSelect` is set only when OpenCode sent `multiple === true` (`3032`).

Paseo's shared UI contract (`packages/app/src/components/question-form-card-core.ts:6-15`): `{ question, header, options[{label, description?}], multiSelect, allowOther, allowEmpty, placeholder?, dismissLabel? }`. `allowEmpty/placeholder/dismissLabel` are parsed opportunistically but **OpenCode's translator never sets them** — Status: PROVEN (absent from `3027-3035`; exercised only in core unit tests / non-OpenCode providers).

## D. Question lifecycle

- **Arrives:** `question.asked` → `permission_requested { kind: "question", name: "question", title: "Question" }` → stored in `pendingPermissions` → surfaces in daemon snapshot (`snapshot.pendingPermissions`, proven by `daemon-e2e/opencode-plan-and-questions.real.e2e.test.ts:68-82`). Status: PROVEN.
- **Answered:** `respondToPermission` → `question.reply` → entry **deleted** from `pendingPermissions` (`4860-4862`). UI card disappears (e2e `submitQuestionAnswers` asserts card count → 0, `e2e/support/helpers/questions.ts:71-74`). Status: PROVEN.
- **Rejected/dismissed:** `respondToPermission` with `behavior: "deny"` → `client.question.reject({ requestID, directory })` (`4833-4837`). Entry deleted. Status: PROVEN.
- **Partial answers:** impossible to submit — Submit/Next gated on `areQuestionsAnswered` over **all** questions (`question-form-card.tsx:376, 456`). Partial state lives only in local component state (`selections`/`otherTexts`), never sent. Status: PROVEN.
- **Reconnect/recovery:** `reconcileBlockingRequests` re-lists `permission.list` + `question.list`, replays live ones as events, and **prunes stale entries** (deletes pending IDs absent from server, emitting synthetic `permission_resolved { behavior: "allow" }`) (`4349-4407`). Status: PROVEN.
- **Reload:** pending permissions are part of the daemon agent snapshot (`waitForAgentUpsert` on `pendingPermissions`), so they survive client reload. Status: PROVEN (e2e test above).
- **Answered history:** answered questions do **not** remain as cards; only the synthetic `permission_resolved` event remains. Status: PROVEN (`4860-4862` + e2e card-count-0 assertion).
- **Session disappears:** stale-prune path removes them (same `4384-4404` block). Status: INFERRED (code path proves removal of non-live IDs; the exact "session deleted" trigger is reconciled via list results, not a dedicated deleted-session branch).

## E. Question UI (`QuestionFormCard`, `packages/app/src/components/question-form-card.tsx`)

Routed exclusively by kind: `view.tsx:1518-1526` — `if (request.kind === "question") return <QuestionFormCard/>`; question requests get **no action buttons at all** (`resolvedActions` returns `[]`, `view.tsx:1408-1411`).

- **Single choice:** options rendered as radio rows (role `radio` in a `radiogroup`, circle control). Selecting one auto-advances to the next question (`toggleOption`, `359-361`). Status: PROVEN.
- **Multi-select:** same rows with `role checkbox`, square control with check fill; toggle adds/removes without advancing (`335-349`, control styles `97-107`). Status: PROVEN.
- **Custom/freeform:** a text input is shown whenever the question has zero options OR `allowOther` — and since the translator always sets `allowOther: true`, **every OpenCode question gets a freeform box** (`questionShowsTextInput`, core `:65-67`; placeholder falls back to "Other..." / "Type your answer..."). Typing clears option selections and vice versa (`366-374`, `352-357`). Status: PROVEN.
- **Several questions:** **one question visible at a time**, with titled tab navigation (hidden for a single question), check marks on answered tabs, `Next` (non-final) / `Submit` (final) primary action (`QuestionNav`, `225-257`; e2e `question-prompt-pagination.spec.ts` proves one-visible-at-a-time, preserved selections, Next-before-Submit). Status: PROVEN.
- **Submission:** single `Submit` sends **all** answers at once as `{ behavior: "allow", updatedInput: { ...input, answers: { [header]: "label, label"|freeform } } }` (`386-404`, `buildQuestionFormAnswers` joins multi-select with `", "`). Status: PROVEN.
- **Cancel/reject/skip:** there is **no Skip/Reject concept in the question protocol**. The card has a **Dismiss** button (label overridable per-question, default "Dismiss") that normally sends `{ behavior: "deny", message: "Dismissed by user" }` → `question.reject`. Exception: if *every* question is `allowEmpty` with zero options, Dismiss sends an allow with empty answers (the "skippable input prompt" case, `406-423`, `shouldSubmitEmptyOnDismiss`). Status: PROVEN.
- **Validation:** primary action disabled until current question answered (Next) / all questions answered (Submit) (`456`). Option-only questions cannot be satisfied by typing (`core.test.ts:50`); freeform satisfies only inputs that show a textbox (`isQuestionAnswered`, core `:69-90`). Status: PROVEN.

## F. Multiple-question behavior

- One request **does** contain a `questions[]` array (OpenCode request → Paseo `input.questions`). Paseo preserves the whole array in one pending-permission entry. Status: PROVEN (`3018-3051`, real-daemon e2e asserts `Array.isArray(input.questions)`).
- Rendered as **one form, one question at a time**, tabbed wizard — never multiple cards, never one-card-per-question. Status: PROVEN (E + pagination e2e).
- Answers submitted **all at once** as a header-keyed map, converted server-side to a **positional `answers: string[][]`** aligned with the original question order (`4840-4851`). Status: PROVEN (also `full-access.test.ts:338-343`: `{ Decision: "Proceed" }` → `answers: [["Proceed"]]`).

## G. Answer payload / API

Dedicated question API, distinct from permissions — Status: PROVEN (`opencode-agent.ts:4832-4863` vs `4865-4871`):

- Deny → `client.question.reject({ requestID, directory })`.
- Allow → `client.question.reply({ requestID, directory, answers })` where `answers` is `string[][]` (one array per question; multi-select entries produced by splitting the `", "`-joined string on commas — so option labels containing commas would corrupt; noted as a latent edge, Status: INFERRED from `4847-4850`).
- Identity of the answered request: the **pending-permission entry ID** (= OpenCode `question.asked` `properties.id`), carried as `requestID` plus the stored per-request `directory`. The UI knows it via `permission.request.id` (`handleResponse`, `view.tsx:1479-1490`). Status: PROVEN.
- No `replyToQuestion()`-named abstraction exists; the branch lives inside the unified `respondToPermission(requestId, response)`. Status: PROVEN.

## H. Question vs permission (separation)

Separate at **every** layer — Status: PROVEN:

| | Permission (tool) | Question |
|---|---|---|
| OpenCode event | `permission.asked` | `question.asked` |
| Paseo kind | `"tool"` (title humanized, `actions` Deny/Allow-always/Allow-once) | `"question"` (title `"Question"`, `actions` none) |
| OpenCode list API | `client.permission.list` | `client.question.list` |
| OpenCode reply API | `client.permission.reply({ reply: "once"\|"always"\|"reject" })` | `client.question.reply({ answers })` / `client.question.reject(...)` |
| Auto-accept | `auto_accept` auto-replies `"once"` to tool permissions | questions explicitly excluded (`tryAutoApproveToolPermission` returns false unless `kind === "tool"`, `5292-5298`; test `"keeps questions separate from auto accept tool approval"`, `full-access.test.ts:304-348`) |
| UI | `PermissionRequestCard` with Deny/Allow buttons | `QuestionFormCard` form (options + freeform + Dismiss/Submit) |

Paseo **never converts a question into an approval** — both share only the `permission_requested` envelope/kind-union transport (`protocol/src/agent-types.ts:432`: `"tool" | "plan" | "question" | "mode" | "other"`). That envelope-sharing is Paseo-internal plumbing, not an OpenCode concept. Status: PROVEN.

## I. Tool linking

- OpenCode attaches `tool: { messageID, callID }` to `question.asked` (proven by fixture `full-access.test.ts:63-66`). Paseo spreads it into `metadata: { source: "opencode_question", ...tool }` (`3052-3055`) — i.e. linkage is **retained as metadata only**.
- The question UI does **not** render or navigate to the linked tool/message; routing/identity uses the request ID + directory only. Status: PROVEN (no `messageID`/`callID` reference in `question-form-card*.tsx/ts` or the answer path).
- Questions are filtered to sessions Paseo owns: `appendOpenCodeQuestionAsked` requires `sessionID === state.sessionId` (`3015`), while tool permissions accept tracked child sessions (`isOpenCodeSessionTrackedByParent`, `2973`). Child-session questions still surface via the subagent/recovery path (parent test proves a child-session `question.asked` lands in `parent.getPendingPermissions()` and answers via `questionReply` with the **child's directory**, `opencode-agent.test.ts:5094-5137`). Status: PROVEN with the noted nuance that live-child question forwarding and the strict session check coexist via different paths.

## J. Unlinked-question behavior

- A question whose `sessionID` matches no owned session is **silently dropped** (the `3015` early return; recovery path additionally requires `isOwnedSessionId`, `4371`). No global panel, notification, or fallback card is created by the question path. Status: PROVEN for the drop; UNKNOWN for any product-level fallback outside the provider (none found in `agent-stream` — unlinked requests never enter `pendingPermissions`, the sole render source).
- If it reaches a turn with no active foreground turn, `emitBackgroundPermissionRequests` handles it (`4449`) — Status: INFERRED (name/behavior not fully traced; flagged for follow-up reads).

## K. Test evidence (all read, none executed)

- `opencode-agent.full-access.test.ts:304-348` — auto-accept ignores questions; header-keyed allow → `questionReply { requestID, directory, answers: [["Proceed"]] }`; `permissionReply` untouched. **Strongest single proof of Q-vs-P separation + payload shape.**
- Same file `:350-400` — freeform answer passes through `questionReply` unchanged (proves custom answers ride the same `answers[][]` slot).
- Same file `:49-69` — canonical `question.asked` fixture shape (`id/sessionID/questions[{question, header, options[]}]/tool{messageID, callID}`).
- `opencode-agent.test.ts:3345-3346, 5127-5137` — child-session question recovery + answer with child directory.
- `daemon-e2e/opencode-plan-and-questions.real.e2e.test.ts:43-88` — real-server proof that clarifying questions surface as `pendingPermissions[0].kind === "question"` with `input.questions[]` and headers.
- `app/.../question-form-card-core.test.ts` — validation/payload unit proofs (option-only requires selection; freeform allowed only when input shown; empty-submit + "Skip" label only for all-optional-no-option forms).
- `app/e2e/browser/question-prompt-pagination.spec.ts` + `e2e/support/helpers/questions.ts` — UI behavior proofs (pagination, Next/Submit gating, dismissal, card disappearance).
- `TestOpenCodeClient` (`opencode/test-utils/test-opencode-harness.ts:270-285`) — proves the SDK surface Paseo programs against: `question.list/reject/reply` alongside `permission.list/reply`.

## L. What Paseo proves (facts)

1. OpenCode questions arrive on a **dedicated `question.asked` event** with `id/sessionID/questions[]/tool`, listed via `question.list`. (PROVEN)
2. One request carries **N questions**, each `{question, header, options[], multiple?}`. (PROVEN)
3. Paseo keeps the whole array in **one** pending item and renders **one paginated form**. (PROVEN)
4. Paseo forces **freeform on every question** (`allowOther: true`) and supports **multi-select** via `multiple === true`. (PROVEN)
5. Submission is **all-at-once**, header-keyed map → positional `answers: string[][]`. (PROVEN)
6. Deny maps to **`question.reject`**; there is no Skip in the protocol (Dismiss = reject, except the all-optional empty-submit edge). (PROVEN)
7. Questions and tool permissions use **fully separate SDK APIs** (`question.*` vs `permission.*`) and separate UI; auto-accept never touches questions. (PROVEN)
8. Tool linkage (`messageID/callID`) is preserved as **metadata only**; answering keys on **request ID + directory**. (PROVEN)
9. Unlinked/foreign-session questions are **dropped**; answered/rejected/stale ones **leave the active UI**. (PROVEN)
10. SDK is **`@opencode-ai/sdk@1.14.46`, V2 client, direct use, `global.event` SSE** — no compat layer. (PROVEN)

## M. Implications for TBAi

- **Question state:** needs a first-class `kind: "question"` pending-request entry holding the full `questions[]` array (header-keyed answers), not an approve/deny record. Sharing only the transport envelope is fine; sharing actions/semantics is not.
- **Question UI:** replace the `[Red][Blue][Answer][Skip]` approval card with a **form**: option list + freeform input + Dismiss/Submit. Freeform must always be present per Paseo's model; Submit gated on all-answered.
- **Multiple questions:** one request = one form, paginated one-at-a-time with per-question nav — not N cards, not approval-per-question.
- **Single-select:** radio semantics + auto-advance; **multi-select:** checkbox multi-toggle joined into one answer string.
- **Freeform/custom:** text input coexists with options (mutually exclusive per question); freeform text is the answer.
- **Answer payload:** submit `{ answers: { [header]: string } }` from UI, then translate to **positional `answers: string[][]`** for `question.reply({ requestID, directory, answers })`; deny → `question.reject({ requestID, directory })`.
- **Tool linkage:** store `messageID/callID` as metadata for display/diagnostics, but key answers on request ID + session directory.
- **Permission separation:** never route questions through permission reply, auto-accept, or approval buttons; separate event/API/UI branches end to end.
- **Unlinked questions:** drop (or explicitly design a fallback — Paseo has none; silence is the observed behavior).
- **Lifecycle:** answered/rejected/stale entries must be removed from the pending set (card disappears); recovery must re-list `question.list` and prune non-live IDs.
- **Client API:** use the OpenCode **V2 SDK event + `question.reply/reject/list`** surface directly; no approval-shaped adapter in between.

## N. Exact files to inspect next

- `packages/server/src/server/agent/providers/opencode-agent.ts` — `:2255-2260` dispatch; `:3010-3058` question normalization; `:4825-4875` answer branch; `:4349-4407` recovery/reconcile; `:5270-5314` pending-store + auto-approve exclusion.
- `packages/server/src/server/agent/providers/opencode-agent.full-access.test.ts` — `:49-69` fixture; `:304-400` answer-payload + auto-accept separation proofs.
- `packages/server/src/server/agent/providers/opencode-agent.test.ts` — `:5094-5137` child-question; `:3313-3383` list-recovery/stale-prune.
- `packages/server/src/server/agent/providers/opencode/event-consumer.ts` — SSE transport.
- `packages/server/src/server/agent/providers/opencode/test-utils/test-opencode-harness.ts` — `:270-285` SDK surface mirror.
- `packages/server/src/server/daemon-e2e/opencode-plan-and-questions.real.e2e.test.ts` — real-server question surfacing.
- `packages/app/src/components/question-form-card.tsx` + `question-form-card-core.ts` (+ `.test.ts`) — full form semantics/validation/payload.
- `packages/app/src/agent-stream/view.tsx` — `:1408-1411` (no approval actions for questions), `:1518-1526` (form routing), `:141-155` (pending-card render host).
- `packages/app/e2e/browser/question-prompt-pagination.spec.ts` + `e2e/support/helpers/questions.ts` — multi-question UI proofs.
- `packages/protocol/src/agent-types.ts:432-470` — shared `question` kind envelope vs `AgentPermissionResponse`.
- `packages/server/package.json:81` — SDK pin; `packages/server/src/server/agent/providers/claude/agent.ts:159-235` — contrast: Claude maps its `AskUserQuestion` tool into the same shared question UI (header-keyed answers), confirming the form contract is provider-agnostic.

---

### Anti-assumption check (explicit answers)

- **Is OpenCode question an approval mechanism?** No — separate `question.asked` event and `question.reply/reject` APIs. (PROVEN)
- **Should Question UI use Answer/Skip buttons?** No — Paseo uses option radios/checkboxes + freeform + Dismiss + Next/Submit. "Skip" appears only as an overridable dismiss label for all-optional freeform prompts. (PROVEN)
- **Can one request contain multiple questions?** Yes — `questions[]`, rendered as one paginated form. (PROVEN)
- **Custom/freeform answers?** Yes — always offered (`allowOther: true` forced). (PROVEN)
- **Multiple selections?** Yes — via `multiple === true` → checkbox multi-toggle. (PROVEN)
- **Response an `answers[]`-style structure?** Yes — `question.reply({ requestID, directory, answers: string[][] })`, positional per question. (PROVEN)
- **Questions vs permissions separate?** Yes — events, list/reply APIs, UI, auto-accept all separate. (PROVEN)
- **Dedicated question API?** Yes — `client.question.reply/reject/list`, branched inside `respondToPermission`. (PROVEN)
- **How is the answered question identified?** Pending-entry ID (= `question.asked` `properties.id`) sent as `requestID` + stored `directory`. (PROVEN)
- **Tool association?** `tool.{messageID, callID}` carried into `metadata` only; not used for routing. (PROVEN)
- **Unlinked questions?** Dropped; no fallback surface in source. (PROVEN for drop / UNKNOWN for any out-of-provider fallback)
- **SDK version / compat adapter?** `@opencode-ai/sdk 1.14.46`, V2 direct, no adapter. (PROVEN)
- **Reusable vs Paseo-specific:** reusable — N-question form model, header→positional answer translation, Q/P API separation, auto-accept exclusion, stale-prune recovery, drop-unlinked. Paseo-specific — React Native `QuestionFormCard` styling, tab-nav pagination aesthetic, `", "` join/split for multi-select (comma-fragile), `metadata.source` tagging, `Dismissed by user` message text.
