# Direct `/compact` — timeline surface plan

Status: **proposal**, not implemented. Nothing in this document has been built.

Supersedes the first draft of this file. Everything below was established by
reading source and installed packages, not inferred.

Scope: Direct chat. Excludes Code/OpenCode, A1 recovery, provider adapters, and
the compaction engine itself.

---

## 1. The problem

`/compact` on Direct **works and is certified** — `968f49c` (server command),
`48a47f2` (UI interception), `57bc82e` (tool-part projection).

The defect is **surface, not correctness**. From the user's seat:

- a transient grey sentence in the composer corner — *"Compacted N earlier messages."*
- held in React state (`directCompactStatus`), therefore **gone on reload**
- no lifecycle, no transcript position, no retry, no record of the summary

So a long conversation can be silently rewritten and the user cannot tell whether
the model is reading their actual history or a summary of it.

## 2. What is already proven (do not re-derive)

| Fact | Where proven |
|---|---|
| A `data-*` part **survives reload** through the real codec | `web/src/adapters/dataPartCodec.test.ts` — 3 tests, green |
| Codec is `aiSDKV6FormatAdapter`, `format: "ai-sdk/v6"` | `assistant-cloud/ai-sdk` |
| `encode` returns **content**; the adapter wraps it in `{id, parent_id, format, content}` | verified by running it |
| `decode` returns **`{ parentId, message }`**, not the message | verified by running it |
| Persistence needs **no schema migration** — `messages.content` is TEXT holding JSON | `src/services/storage/index.ts:480` `upsertStored` |
| Deterministic transcript position already exists | `order_seq`, assigned in `upsertStored` |
| A data part is registered with a renderer | `makeAssistantDataUI` in `app/layout/ChatShell.tsx:94` |
| `makeAssistantDataUI`, `AssistantDataUIProps`, `DataMessagePartProps` are exported | installed `@assistant-ui/react` typings |
| shadcn `Badge` exists in repo | `web/src/components/ui/badge.tsx` |
| shadcn `Separator` does **not** exist in repo — add via CLI | `web/src/components/ui/` listing |
| Tailwind is v4.3.3, CSS-first, tokens in `styles/themes.css` | `web/package.json`, `web/src/styles/` |
| shadcn `Separator` has **no label-in-rule variant** | ui.shadcn.com/docs/components/radix/separator |

## 3. The reference: ZCode

Renders `/compact` as a **divider in the transcript**:

```
──────────────  Context compressed  ──────────────
```

Copy, verbatim (`packages/i18n/src/locales/en-US.ts:292`):

| status | string |
|---|---|
| `started` | Compressing context |
| `retrying` | Retrying context compression (2/3) |
| `skipped` | Context is up to date; no compression needed |
| `completed` | Context compressed |
| `failed` | Context compression failed |
| `interrupted` | Context compression interrupted |
| retry | `Ctrl-R to retry /compact` |

Model — a persisted message part:

```
MessagePart { type: "timeline", timelineType: "context_compaction",
              anchorMessageId, anchorTurnId, summaryMessageId,   // required
              boundaryId, compactReason, status, attempt, display }
```

- `role: "timeline"`, `content: ""` — structurally cannot be a chat bubble
- persisted (`sqlite-session-store.ts:166`), rehydrated (`transcript-hydration.ts:289`)
- optimistic local entry upserted by `operationId` (`app-compact-timeline.ts`)
- `/compress` and `/compact <instructions>` accepted

Files: `packages/tui/src/app-compact-timeline.ts`,
`packages/tui/src/app-transcript-components.tsx:187` (`CompactTimelineRow`),
`bootstrap/src/zcode-protocol/server-operations.ts:2013` (`compactSession`),
`bootstrap/src/zcode-protocol/message-mapper.ts:145`.

**Standing caveat: ZCode ships zero automated tests for manual compact.** This is
a shape to copy, not evidence it behaves correctly.

## 4. Correction to an earlier assumption

There is **no shared compaction part type in TBAi to reuse.** `compaction`
appears under `web/src` only inside `features/opencode/`. What Code has is a
*state machine* bridged from OpenCode's events (`compaction_running` /
`compaction_settled` / `compaction_failed` / `compaction_admitted`) in
`v2ThreadController.ts`. It is not a persisted transcript part and belongs to a
different engine.

Reusable: the **shape and vocabulary**. Not infrastructure.

## 5. Deletion inventory (line numbers verified against `48a47f2`)

Prove each item superseded before removing it.

### Delete — Direct-only, added by this workstream

| Location | What |
|---|---|
| `web/src/components/Composer.tsx:56` | `type DirectCompactStatus` import |
| `web/src/components/Composer.tsx:546` | `const [directCompactStatus, setDirectCompactStatus] = useState(...)` |
| `web/src/components/Composer.tsx:551`, `:557` | the `setDirectCompactStatus` calls |
| `web/src/components/Composer.tsx:955-963` | the `{directCompactStatus && ...}` status strip |
| `web/src/config/composer.ts` | `compacting`, `compactCompacted`, `compactSkipped` — Direct-only copy |

### Keep — correct, still required

| Location | Why |
|---|---|
| `Composer.tsx:54-55`, `:644-645` | `isDirectCompactCommand` / `runDirectCompact` / the guard in `handleComposerSubmit`. This IS the command interception; removing it puts `/compact` back into history as a user bubble |
| `web/src/features/chat/compactCommand.ts` | command detection, assistant-ui→AI SDK tool-part translation, the POST |

### HAZARD — `compacting` and `compactError` are SHARED with Code/OpenCode

| Location | Shared with |
|---|---|
| `Composer.tsx:505-506` — `compacting` / `compactError` state | driven by BOTH `runCompact` (Code: 509/514/515/525/527) and `runDirectCompactCommand` (Direct: 549/550/568/570) |
| `Composer.tsx:941-945` — error strip | copy is *"Couldn't compact the session"* — **Code wording** |
| `Composer.tsx:948-952` — `{compacting && ...}` strip | also Code |

**Therefore "delete the grey sentence" must NOT mean deleting those strips** —
that would break OpenCode compact, which is out of scope. It means:

1. Stop the Direct path writing to `compacting` / `compactError` / `directCompactStatus`
2. Delete only the Direct-specific strip at `955-963`
3. Leave `941-952` intact for Code

### Consequence requiring a decision

After this, Direct shows **nothing transient** — the transcript divider is the only
feedback. That is the goal, but it means a slow compaction gives the user zero
in-place feedback unless the optimistic `started` entry (ZCode model) is built.

**The `started` state is therefore not optional polish** — it is what stops the
command feeling dead while it runs.

## 6. Approach — library-first, minimum custom code

An earlier draft proposed a "persisted timeline part model". That was inventing
architecture the libraries already cover. Corrected:

| Need | Library primitive | Custom code |
|---|---|---|
| Render a non-text part | `makeAssistantDataUI({ name, render })` | one component |
| Component contract | `DataMessagePartProps<T>` | — |
| Write the durable row | `messageService.upsertStored` | one payload builder |
| Transcript position | existing `order_seq` | none |
| Reload survival | existing thread loader + stored `parts` | none |
| Status word | shadcn `Marker variant="separator"` (**added via `bunx shadcn@latest add marker`**) | — |
| Rules | MarkerContent | — |
| Colours | existing tokens in `styles/themes.css` | a few classNames |

Total custom code: **one component, one registration line, one server message
write.** No new part type, no new store, no new adapter, no schema change.

### Three facts measured in the browser, not assumed

Each of these cost a wrong implementation first. They are the reason the code
looks the way it does.

1. **`GroupedParts` children cannot render a leaf part.** `children` is a
   sentinel that *throws* for any part that is not a `group-…` case. A `data`
   part must render itself (`<CompactionDivider {...part} />`). Returning
   `children`, or changing `default`, both fail — the first crashes the app, the
   second silently drops every unknown part.
2. **assistant-ui's `DataMessagePart` is `{ type: "data", name, data }`** — the
   discriminator is the literal `"data"`, not `data-<name>`. `data-<name>` is
   the AI SDK *wire* form. `thread().append()` needs the former; a stored row
   needs the latter, because every row in this database is
   `{ role, parts, metadata }`.
3. **`thread().append()` is NOT a persistence path in this runtime.**
   `adapters.history` is unset, so the library only writes messages the transport
   streams, via its `onNew` / `onUpdate` hooks. Measured: an appended message
   renders in the thread and leaves no row in SQLite, and disappears on reload.
   This is why the server writes the row and the client appends only as an
   optimistic, non-durable preview. It is also why the `dataPartCodec.test.ts`
   round-trip proof was **deleted** — it asserted a codec path this feature does
   not use. Durability is asserted instead on the stored payload
   (`buildDividerStoredContent`) and by the B-suite integration test.

> **Trap:** `browser.open` on the same URL serves a **stale bundle**. Every
> conclusion drawn before adding a `?cb=N` cache-buster is invalid. Symptom:
> edits to the frontend provably in `dist/web/assets/*.js` change nothing on
> screen.

### Visual composition

`Marker variant="separator"` draws the rule; `MarkerContent` holds the label.
shadcn's docs use "Conversation compacted" as this variant's own example.

**Read `styles/themes.css` before writing a single className.** Do not guess token
names.

## 7. Order — chosen so nothing can regress

1. **Divider + registration.** Nothing persists yet, so no reload regression.
2. **Server persistence** — `direct-compact-command.ts` writes the divider row
   via `messageService.upsertStored`; the response returns `operationId` and
   `anchorMessageId` (`null` when the write failed, which is a distinct state
   from "the compaction failed").
3. **Remove obsolete surface** — composer strip, `directCompactStatus`, direct
   `compactError`. `Composer.tsx` is in the maintainer's dirty set: hunk-split
   before staging, as done for `48a47f2`.
4. **Lifecycle + reload verification.**
5. **Manual extras** — `/compress`, `/compact <instructions>`.
6. **Automatic compaction — last.**

Persisting a part *before* a renderer exists loads an invisible message on every
reload. That is why the renderer is first.

## 8. Open decisions (require judgement, not more study)

1. **`summaryMessageId`** — ZCode's summary *is* a message; TBAi's is a
   `summary_text` column on `conversation_compactions`. Either materialise the
   summary as a message, or reference the checkpoint row. No second store.
2. **Anchor** — nothing in TBAi defines which transcript position a compaction
   occupies. Decide, then implement deterministically.
3. **`boundaryId`** — TBAi's `span_fingerprint` is arguably better
   (`orchestrate.ts` documents id-based detection as unsound). Prefer reusing it.

## 9. Tests

ZCode has none. These are ours.

| # | Test | Level | Where |
|---|---|---|---|
| 1 | `/compact` writes exactly ONE row, and it is the divider — no user bubble, no reply | route | `tests/integration/direct-manual-compact.test.ts` TEST 2 |
| 2 | Stored payload is the envelope the loader replays (`role`/`parts`/`metadata`) | unit | `buildDividerStoredContent` |
| 3 | `skipped` / `failed` / `compacted` each stored as themselves | unit | same |
| 4 | Every outcome renders its own wording | render | `compaction-divider.test.tsx` |
| 5 | Divider payload is keyed by `operationId`, so two compactions are two entries | unit | `compactCommand.test.ts` |
| 6 | `anchorMessageId` survives as a nullable fact, never invented | unit | same |
| 7 | Exact-match only: `/compress` yes, `/compact now` no | unit | `direct-compact-command.test.ts`, `compactCommand.test.ts` |
| 8 | Tool-containing conversation compacts | route | B suite |

## 10. Acceptance criteria

- [x] `/compact` leaves a visible, **reload-durable** transcript entry — proved in
      the browser: divider on screen, row in SQLite, divider present after a hard
      reload (`?cb=5`), exactly one entry, no `/compact` bubble
- [x] No `/compact` user bubble, no fake assistant message
- [x] `compacted` / `skipped` / `failed` visually distinguishable
- [x] Failure is visibly a failure, never a silent success
- [x] Obsolete composer strip removed (`directCompactStatus`, the outcome strip,
      and `config/composer.ts`'s four compact copy strings)
- [x] B suite, A1 suite, `compactCommand` suite, divider-payload suite green —
      `3786 pass / 23 skip / 0 fail`
- [x] No change to the compaction engine, A1, or Code/OpenCode
- [x] `/compact <instructions>` — done, see §11a
- [x] Automatic compaction — done, see §11b

## 11a. `/compact <instructions>`

`/compact [instructions]` is one grammar, not two commands: the command word is
matched as a **whole token** and everything after it is the user's narrowing words.
`parseCompactCommand` on the server and `parseDirectCompactCommand` on the client
implement the same rule; the client sends the text the user actually typed as the
deciding message, so the SERVER reads the instructions off it rather than receiving
the same fact through a second parameter that could disagree.

The words are **added to** the summariser's system prompt, never substituted for it
(`buildSummarySystemPrompt`). The base preservation contract and its "report only
what is in the transcript" rule stay in force — instructions narrow *what to keep*,
they do not authorise a different document. With no instructions the prompt is
byte-identical to before the parameter existed.

**Behaviour change, deliberate:** `/compact now` used to be ordinary user text. It is
now the command with the instruction `now`. Tests that documented the old rule were
updated, not deleted, and say so in their names.

## 11b. Automatic compaction

### What ZCode does, and what was taken from it

`ZCodeContextCompactionTimelineMeta` (`packages/shared/src/zcode-task-types-core.ts`)
is a synthetic timeline row: `kind: "synthetic"`, `type: "context_compaction"`,
`display: "separator"`, with two independent axes —

- `status: "started" | "retrying" | "skipped" | "completed" | "failed" | "interrupted"`
- `trigger: "manual" | "auto" | "reactive" | "partial" | "session_memory"`
- plus `phase: "standalone_turn" | "pre_request" | "mid_turn" | "reactive"`

The load-bearing fact: **automatic compaction is not a different object.** It is the
same timeline entry with `trigger: "auto"` and a phase describing where it happened.
ZCode has no separate "auto compaction" surface. Neither does TBAi.

ZCode also has a `started` status and a `replace`/`inputId` pair for replacing the
optimistic row. TBAi does **not** implement `started`: there is no client-side
upsert, because the durable row is written server-side and the client's append is
optimistic-only. That gap is recorded rather than half-built.

### What TBAi does

`chat.ts`, after `assembleForRequest()`:

1. reads `provenance.compaction.applied` — the same report, and the same `applied`
   fact, overflow recovery and the manual command are gated on;
2. on `true`, calls the SAME `persistCompactionDivider` the manual command uses;
3. streams a `data-tbai-compact` part with `origin: "automatic"` as the FIRST part of
   that turn's assistant message, before any provider output.

No second engine, no second part, no second writer, no second renderer. The client
needed **no changes at all** for automatic compaction — the `data` case added for
manual rendering already renders it.

`origin` is the only difference from a manual compaction, and it is why the divider
can read "Context compacted automatically": a divider that says "Context compacted"
after a turn the user never compacted is indistinguishable from one they asked for.

### Verification

Reaching the trigger needs a context window a test cannot type, so the proof used a
real, supported configuration rather than a stubbed threshold: a model declaring a
small `contextWindow`. Tool definitions are ~10.7k tokens of FIXED overhead that
compaction cannot reclaim, so the window must clear them plus the safety margin
while the conversation must still cross 80% of usable input — 24k does both.

- **Integration, through the real route and engine:** the response stream carries
  `data-tbai-compact` with `outcome: "compacted"`, `origin: "automatic"`,
  `generation > 0`; the summariser actually ran; the stored row is the same envelope
  a manual one uses. A second test proves the negative — the same window with a short
  conversation writes nothing at all.
- **Browser, through the real Direct path:** the live provider's model was given a
  24k window, five long turns were sent, and the engine compacted on its own
  (`origin=automatic, outcome=compacted, generation=1, spanLength=12`). The divider
  rendered live inside the turn, and survived a hard reload. The provider config was
  restored afterwards.

Not yet covered: repeated automatic compaction across generations, and
`reactive`/overflow-recovery compaction, which uses its own force-recovery path and
does not pass through this branch.

## 12. Out of scope

Compaction engine changes · A1 · provider adapters · Code and OpenCode · new
styling system · CSS-only hiding of conversation content · the frontend context ring
(which still estimates 128k client-side and so can disagree with the server's
resolved window — a pre-existing display issue, recorded, not fixed here).