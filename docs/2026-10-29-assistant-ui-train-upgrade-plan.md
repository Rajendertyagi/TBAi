# `@assistant-ui` train upgrade — plan (0.15.30/0.0.14 → 0.15.32/0.0.16)

**Status:** PROPOSED — read-only audit. No manifest, lockfile, source, or test was changed; no
package was installed; no gate was run. Starting this plan requires the maintainer to lift the
`AGENTS.md` train freeze for this one dependency commit (2026-09-15 rule), and it starts **only
after** `docs/2026-10-27-status-ownership-and-activity-plan.md` (S1–S7b) is committed and its
verification is recorded.
**Date:** 2026-10-29
**Owner:** Architecture / dependency train
**Depends on:** S7b landed; `bun run verify` green on that tree; CI green on the commit it lands on.
**Supersedes nothing.** It continues `docs/2026-10-27-status-ownership-and-activity-plan.md`
§17 (the compatibility audit) and §17.6 (the deferred-upgrade recommendation), which deferred the
move; this document turns that deferral into a sequenced, gated work item.

---

## 1. What this upgrade is - and is not

It is **one dependency commit**: raise the assistant-ui train, re-resolve the lockfile, prove the
context-bearing packages still exist once, and re-run every gate. No TBAi capability is rewritten.

It is **not** a way to delete custom status code. The §17 tarball audit established that upstream
still ships **no** runtime-bound `AgentStatus`/`TaskTray`; those are CLI-scaffolded `.aui`
elements. So `OpenCodePrimaryStatus`, the activity resolvers, `statusView.ts`, and the reserved
status row all stay. Their ownership was settled by S1–S7b and is not revisited here.

Three upstream capabilities exist in the target train and are **deliberately not adopted** by this
upgrade (each is a separate feature decision): `ComposerTextOrigin` (core 0.3.31+),
`persistenceError` on the history adapter telemetry options (core 0.3.31+), and a scaffolded
`agent-status.aui` element.

## 2. Current vs target train (verified 2026-10-29)

Installed values are read from `bun.lock`; latest values from `bun pm view <pkg> version`.

| Package | Installed | Latest | In target | How it moves |
|---|---|---|---|---|
| `@assistant-ui/react` | 0.15.30 | 0.15.32 | 0.15.32 | range `^0.15.30` already permits it; **floor edit** recommended (§3) |
| `@assistant-ui/core` | 0.3.30 | 0.3.32 | 0.3.32 | transitive |
| `@assistant-ui/ai-sdk` | 0.0.14 | 0.0.16 | 0.0.16 | **manifest edit required** — `^0.0.14` cannot cross a `0.0.x` boundary |
| `@assistant-ui/react-markdown` | 0.14.15 (exact) | 0.14.24 | 0.14.24 | **manifest edit required** — exact pin |
| `@assistant-ui/react-devtools` | 1.2.25 | 1.2.26 | 1.2.26 | range `^1.2.25` permits it (dev-only) |
| `assistant-stream` | 0.3.53 | 0.3.55 | 0.3.55 | range `^0.3.53` permits it; **floor edit** recommended |
| `assistant-cloud` | 0.2.7 | 0.2.9 | 0.2.9 | transitive (web deps declare `^0.2.5`) |
| `@assistant-ui/store` | 0.3.22 | 0.3.22 | unchanged | already latest |
| `@assistant-ui/tap` | 0.9.24 | 0.9.24 | unchanged | already latest |

`bun outdated` reports the same split: `react` Update 0.15.32, `ai-sdk` Latest 0.0.16 but **Update
0.0.14** (range-permitted is only 0.0.14), `assistant-stream` 0.3.55. `react-markdown`,
`react-devtools` and `assistant-cloud` do not appear because the outdated table only prints rows
whose manifest range is unsatisfied; their latest values above come from the registry query.

**Not moved by this plan:** AI SDK (`ai` 7.0.145), the provider packages, `radix-ui`, `zustand`,
`@ai-sdk/react` (it re-resolves only if the new `ai-sdk` package requires it — check and record).
A second dependency commit for any of those needs its own entry.

## 3. Manifest edits (two required, two recommended)

```diff
- root package.json   "@assistant-ui/ai-sdk": "^0.0.14"
+ root package.json   "@assistant-ui/ai-sdk": "^0.0.16"
- web/package.json    "@assistant-ui/ai-sdk": "^0.0.14"
+ web/package.json    "@assistant-ui/ai-sdk": "^0.0.16"

- web/package.json    "@assistant-ui/react-markdown": "0.14.15"
+ web/package.json    "@assistant-ui/react-markdown": "0.14.24"
```

Recommended, for the reason recorded in the 2026-10-20 entry (`docs/decisions.md`): raise the
**floors** of the packages that move so a clean install cannot silently fall back below the tested
set — `@assistant-ui/react` `^0.15.30 → ^0.15.32` (root and web) and `assistant-stream`
`^0.3.53 → ^0.3.55` (root and web). Without the floor edit the ranges still resolve to the new
versions, but a later `bun install` on a stale lockfile could re-pin the old ones.

`@assistant-ui/react-devtools` needs no edit (`^1.2.25` spans 1.2.26). Keep the exact pin on
`react-markdown`; the repo does not use ranges for it.

## 4. Risk surface — what in TBAi can break, and what proves it did not

Ordered by likelihood × blast radius. Each item names the code it touches and the gate that
would catch it.

### 4.1 Deep `dist/*` contract pins (highest risk)

[tests/helpers/dom/resolve.ts](file:///D:/Temp/ai-chat-app/tests/helpers/dom/resolve.ts) imports
four deep modules that are **not** package exports, precisely so the DOM contract suites pin the
installed internals:

- `@assistant-ui/ai-sdk/dist/utils/sliceMessagesUntil.js`
- `@assistant-ui/ai-sdk/dist/converters/toCreateMessage.js`
- `@assistant-ui/ai-sdk/dist/converters/convertMessage.js`
- `@assistant-ui/core/dist/runtime/utils/external-store-message.js`

Six suites consume that helper: `tests/dom/components/p2-runtime-integration.test.tsx`,
`tests/dom/components/react-composition.test.tsx`, `tests/dom/core/conversion.test.ts`,
`tests/dom/history/p2-core-instance.test.ts`, `tests/dom/history/p2-public-binding-sources.test.ts`,
`tests/dom/history/p2-writeback-invariants.test.ts`.

If `ai-sdk@0.0.16` or `core@0.3.32` moves or renames any of those four files, the helper throws at
import and all six suites fail — which is the intended behaviour: a loud, early failure rather than
subtle drift. **Step 2 of §5 re-reads the published tarball file lists before installing**, so this
is known before the install, not discovered after it. If a path moved, the plan is to update the
helper's paths **and** record the move; it is not to delete the contract.

### 4.2 The public surface TBAi actually uses

81 `@assistant-ui/react` import sites, plus 7 `@assistant-ui/ai-sdk`, 3
`@assistant-ui/react-markdown`, 1 `@assistant-ui/react-devtools`. Symbols by file count:

| Symbol | Files | Note |
|---|---|---|
| `useAuiState` | 34 | store scope reads; the largest single surface |
| `AssistantRuntimeProvider` | 16 | provider identity — §4.3 |
| `AuiProvider` | 12 | provider identity |
| `useAui` | 11 | store scope access |
| `Tools` | 9 | tool registration |
| `useExternalStoreRuntime` | 8 | **the OpenCode boundary** |
| `useToolCallElapsed` | 8 | TBAi-owned timing helper |
| `ToolCallMessagePart` | 7 | type-only |
| `getExternalStoreMessages` | 7 | external-store bridge |
| `useScrollLock` | 6 | |
| `unstable_useComposerInput` | 5 | **unstable API — may change without a major** |
| `AuiConfig` | 4 | |
| `bindExternalStoreMessage` | 3 | external-store bridge |
| `RemoteThreadListAdapter` | 2 | custom adapter (§4.4) |
| `RuntimeAdapterProvider` | 1 | |
| `defineToolkit` | 1 | |

Two of these are explicitly unstable (`unstable_useComposerInput`) or internal-shaped
(`bindExternalStoreMessage`, `getExternalStoreMessages`, `useToolCallElapsed`). A patch bump may
still change them; the first thing step 4 does is a **type-level diff** of the installed
`.d.ts` for exactly this list, before any behavioural test.

### 4.3 Provider / context identity

`AGENTS.md` "Dependency / context integrity" is the governing rule. The proof after install is:

- exactly one resolved `@assistant-ui/{react,core,store,tap}` in the tree (root and `web/`);
- one React, one `zustand`, one `radix-ui`, one `assistant-stream`, one `assistant-cloud`;
- `@assistant-ui/react` and the OpenCode feature still share one provider instance — the OpenCode
  boundary (`useExternalStoreRuntime` under `web/src/features/opencode/`) is the path that would
  break first if `react@0.15.32` relocates its runtime hooks behind `@assistant-ui/core/react`
  re-exports (a risk asserted in §17.7; **re-verify against the installed `.d.ts` at step 2**).

Guards that would fail: `tests/dom/history/p2-core-instance.test.ts` (single core instance),
`tests/dom/components/react-composition.test.tsx`, and the OpenCode runtime suites.

### 4.4 Chat behaviour contracts

The 2026-10-20 entry lists what actually reached TBAi on the last bump (remote thread list install,
`initialize` signature, `generateTitle` retry, shared viewport scroll controller, composer state
timing, resume opt-in, history ordering). The same areas must be re-walked here:

- custom `RemoteThreadListAdapter` / `ThreadHistoryAdapter`
  (`web/src/adapters/`), including the no-op `reportTelemetry()`;
- the external-store runtime and its message bridge;
- virtualized transcript + scroll anchoring (`tests/e2e/virtualizer/`);
- composer and send/stop geometry;
- error/stream paths (`src/lib/errors.ts`, sanitized stream errors) — untouched by the bump but
  covered because `MessageStatus.incomplete.reason` is the field S6 relies on.

### 4.5 The vendored element and the status row

`web/src/components/assistant-ui/elements/agent-status.tsx` is vendored per
`architectural-principles.md` rule 4 and is **not** replaced by an import. The upgrade does not
change it. What must be re-confirmed is that the new train does not start shipping a package export
of the same element (`AgentStatus`, `TaskTray`, `useTaskSummary`) that would create a second,
competing implementation: if it does, that is a **follow-up decision**, not a silent adoption.

The S7a geometry spec must stay green **unchanged**: 46 px one line, 92 px wrapped, 176 px content
at 480 px, no overlap/overflow. If a bump changes a pill's height (padding, trailing wrapper), the
spec fails — and the number must be re-derived, not the spec relaxed.

### 4.6 Type-level assumptions written into TBAi

`web/src/lib/assistantActivityParts.ts:5-10` records that the published `ToolCallMessagePart` omits
`status` on 0.15.30 while the runtime reads it. If 0.15.32 adds the field, the comment and the local
`ActivityPart` extension become stale. Read the new `.d.ts`; if the field is now published, delete
the local extension rather than leaving a duplicate declaration.

## 5. Execution sequence (one commit, gated steps)

Each step's output is evidence for the next; a red step stops the sequence.

1. **Preconditions.** S7b committed; working tree clean; `git status --short` empty; current
   `bun run verify` result recorded with counts; CI conclusion for that commit recorded.
2. **Read before installing.** Download the published tarballs for
   `react@0.15.32`, `core@0.3.32`, `ai-sdk@0.0.16`, `react-markdown@0.14.24`,
   `react-devtools@1.2.26`, `assistant-stream@0.3.55`, `assistant-cloud@0.2.9`. Compare:
   (a) the file list against §4.1's four deep paths; (b) `dist/index.d.ts` exports against §4.2's
   symbol list; (c) whether `TaskTray`/`AgentStatus`/`useTaskSummary` became package exports
   (§4.5); (d) `MessageStatus` / `MessagePartStreamStatus` (`§17.4`); (e) whether
   `ToolCallMessagePart.status` is now published (§4.6). Record the answers in the commit message.
3. **Manifest + lockfile.** Apply §3. Clean install (remove root and `web/node_modules`, then
   `bun install`). Exit code 0. Inspect the resolved tree: §4.3 identity proof. Record the lockfile
   diff row count — the 2026-10-20 move was exactly eight rows; a much larger delta is a finding.
4. **Type + static gates.** `bun run typecheck` (four projects), `bun run lint`,
   `bun run format:check`, `bun run test:locations`.
5. **Build.** `bun run build` (the unit suite depends on it, per `engineering-quality.md`).
6. **Suites, narrow to wide.** The six `resolve.ts` DOM suites → the whole DOM suite →
   `bun run test` (unit + integration) → `bun run test:dom` → `bun run test:quarantine` → the full
   `bun run verify`.
7. **Behavioural paths the suite does not prove.** Direct and Code error paths, provider switching,
   streaming start/stop/cancel; the OpenCode runtime suites (`bun run test:opencode-runtime`).
8. **Browser geometry.** `bun run test:e2e tests/e2e/virtualizer/status-layout-stability.spec.ts`
   and the virtualizer scroll specs — unchanged thresholds (§4.5).
9. **Record.** One `docs/decisions.md` entry in the 2026-10-20 shape: package table (was → now →
   how), the exact lockfile delta, the context-identity proof, what in the diff can reach TBAi and
   what cleared it, pre-existing failures named rather than absorbed, and "not verified".

## 6. Verification matrix (must be reported with real numbers)

| Gate | Command | Pass condition |
|---|---|---|
| Types | `bun run typecheck` | exit 0 |
| Lint | `bun run lint` | exit 0, 0 warnings (`--error-on-warnings`) |
| Format | `bun run format:check` | exit 0 |
| Test location | `bun run test:locations` | exit 0 |
| Build | `bun run build` | exit 0 |
| Unit + integration | `bun run test` | 0 fail; counts recorded |
| DOM | `bun run test:dom` | 0 fail; counts recorded |
| Quarantine | `bun run test:quarantine` | exit 0 |
| Full chain | `bun run verify` | exit 0 |
| OpenCode runtime | `bun run test:opencode-runtime` | 0 fail (spawns the pinned `opencode serve`) |
| Status geometry | `bun run test:e2e tests/e2e/virtualizer/status-layout-stability.spec.ts` | 6 passed, thresholds unchanged |
| CI | the push-triggered workflow on the commit | every required job green, including tauri G1 |

Any failure that also exists at the pre-upgrade commit is **pre-existing**: report it with the base
numbers beside the new ones. Never make a red gate green by relaxing a test.

## 7. Rollback

Single revert of the dependency commit (manifest + lockfile). No source code depends on the new
versions, so a revert restores the previous train exactly; no data migration, no schema change, no
wire-format change is involved. Record the pre-upgrade lockfile hash in the commit message so the
revert can be checked.

## 8. Explicitly out of scope

- Adopting `ComposerTextOrigin`, `persistenceError` telemetry, or a scaffolded `agent-status.aui`.
- Replacing the vendored `agent-status.tsx` with a package import.
- Any change to the status-ownership model, the reserved row, or the heart/primary/viewport split.
- AI SDK / provider / `radix-ui` / `zustand` moves.
- A `@assistant-ui` major-version move; nothing here crosses a major.

## 9. Open questions to settle before step 3

1. **Freeze exception.** The upgrade needs the maintainer's explicit approval, recorded in the
   commit message and in `docs/decisions.md`. Without it, this plan stays a plan.
2. **Floor edits.** Raise `@assistant-ui/react` and `assistant-stream` floors too (§3), or leave
   the ranges and rely on the lockfile? Recommendation: raise them, matching 2026-10-20.
3. **`react-markdown` pin.** Keep the exact pin at 0.14.24, or convert it to a range now? The repo's
   convention is an exact pin; keep it.
4. **CI timing.** The upgrade should land when a tauri G1 failure can be attributed. Run
   `40527025056`'s G1 step is currently **unclassified** (see the status plan §19.2); if it is still
   unclassified, a red G1 after the bump cannot be distinguished from the pre-existing one.

## 10. Evidence status of this document

**Verified today (2026-10-29, read-only):** installed versions (`bun.lock`), latest published
versions (`bun pm view`), `bun outdated` split, import-site and symbol counts (grep over
`web/src`, `tests`), the four deep `dist/*` paths and their six consuming suites
(`tests/helpers/dom/resolve.ts`), the `ToolCallMessagePart.status` note
(`web/src/lib/assistantActivityParts.ts:5`), the gate list (`docs/engineering-quality.md`).

**Inherited from §17 of the status plan (audited 2026-10-28 against published tarballs):** the
absence of `TaskTray`/`useTaskSummary`/`AgentStatus` as package exports, the `persistenceError` and
`ComposerTextOrigin` additions, and the `MessageStatus` vocabulary. These are cited, not re-derived
here; step 2 re-checks the parts that can change behaviour.

**Not verified — nothing here is claimed:** the install, the resolved tree, any test run, any CI
run, the §17.7 claim that 0.15.32 relocates the runtime hooks, and the per-file content of the
target tarballs beyond what §17 recorded.
