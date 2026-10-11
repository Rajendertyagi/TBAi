# Shared-Tree Integration Plan — Chat Route Strictness Recovery

**Status:** PROPOSAL ONLY — amended after full isolated verification.
**Nothing has been written to the shared repository.** No staging, commit, push, reset,
cleanup, or reorganisation performed or authorised.

**Source of truth for every "current" fact below:** direct SHA-256 comparison of disk bytes
against `git cat-file blob HEAD:<path>` in `D:\Temp\ai-chat-app`.

---

## 1. Two independent defects, deliberately kept separate

They are unrelated bugs. Neither causes the other. They must land as two independently
revertible changes.

### Fix A — stale assembly snapshot (the overflow regression)

`assemble-run.ts:334` does `state.assembled = assembled`, so overflow recovery **replaces**
the assembly object. The strictness work added a phase-scope narrowing guard:

```ts
const assembled = state.assembled;   // snapshot taken BEFORE streaming
if (!assembled) throw ...
```

That snapshot is then read *after* recovery replaced what it points at. The guard converted
a live property read into a captured pointer. Two sites:

| Site | Stale read | Consequence |
|---|---|---|
| `execute-direct-stream.ts` `recover` callback | `assembled.diagnostics.compactionApplied` | always `false` → throws `compaction_not_applied` → gate forwards the original overflow, no retry → `upstreamCalls` 2 instead of 3 |
| `gate.ts` `publishCompactionDivider` / `compactionPart` | `assembled.context.provenance.compaction` | `applied` false → divider never persisted or emitted → 0 dividers, expected 1 |

**Correction:** re-read through `state` after the rebuild, keeping the guard at phase entry.

### Fix B — duplicate `streamWriter` (terminal output silently dropped)

The route builds the terminal batcher *before* assembly (assembly wires the tap into
`run_command`), so its sink must reach the writer the stream phase installs later. The
extraction gave each phase its own binding:

```
chat.ts L124   createTerminalOutput((part) => streamWriter?.write(part))  ← route-local
chat.ts L127   let streamWriter = null                                  ← never assigned
execute  L177  let streamWriter = null                                  ← a DIFFERENT variable
execute  L360  streamWriter = writer                                   ← the only assignment
```

The route's binding stays `null` for the request's whole lifetime, so every
`data-tbai-terminal` part was dropped in silence. HEAD had one binding serving as both the
batcher sink and the recovery-flush target.

**Correction:** one `StreamWriterHolder` created by the route, passed to
`executeDirectStream`, which fills `holder.current` instead of a private local.

Note: the `streamWriter` lead was pursued *because* it was the reported culprit. It was not
the overflow cause. Chasing it is what surfaced Fix A.

---

## 2. Verified per-test results

Run with the repository's exact test command:

```
bun test --isolate ./tests/unit ./tests/integration \
  --path-ignore-patterns "**/shutdown-lifecycle.test.ts" --timeout=30000
```

| Config | pass | skip | fail | tests |
|---|---|---|---|---|
| Neither fix | 3892 | 43 | 15 | 3950 |
| Fix A only | 3900 | 43 | 7 | 3950 |
| Fix A + Fix B | 3901 | 43 | 7 | 3951 |

Per-test identity diffs (junit XML, compared by `file + classname + name + occurrence`;
identical populations in every pair, so no aggregate cancellation is possible):

```
Fix A:  repaired 8   broken 0   added 0   removed 0   skip-changes 0
Fix B:  repaired 0   broken 0   added 1   removed 0   skip-changes 0
```

`tsc --strict`: **0 errors** with both fixes applied.

### The 8 tests Fix A repairs

All under `tests/integration/history/`:

| Suite | Test |
|---|---|
| `direct-overflow-control-flow` | issues a second provider attempt and streams only the recovered answer |
| `direct-compaction-invariant` | compacts, then issues exactly one more model attempt |
| `direct-observed-window-recovery` | records the stated limit, not the input size, and plans the retry against it |
| `direct-observed-window-recovery` | does not attempt a third time, and still records what the provider stated |
| `direct-observed-window-recovery` | leaves the conservative stand-in in place |
| `direct-a1-certification` | two attempts, one compaction, no third attempt |
| `direct-a1-certification` | emits one `data-tbai-compact` divider with `origin: 'recovery'` |
| `direct-a1-certification` | persists the recovered reply once, and the next turn succeeds on compacted state |

Causality was established by reversible experiment (remove → restore → remove → restore),
not inferred.

### Fix B regression test — mutation-proven

`tests/integration/history/terminal-output-delivery.test.ts` (NEW)

Drives a real `POST /api/chat`; a stub provider emits a genuine `run_command` tool call; the
approval gate is answered exactly as the client does; the shell command actually executes.

```
with Fix B     → 1 pass
Fix B reverted → 1 fail:  Expected: > 0   Received: 0
```

That zero is the defect: the tool ran, its output existed, and the route dropped every part.

**Why this test had to be written.** `tests/unit/tools/terminal-wiring.test.ts` covers the
batcher and the tap in isolation and never asserts delivery. The overflow suites never
invoke `run_command` at all. A green suite was blind to Fix B — which is precisely how the
defect survived the chat-route extraction.

---

## 3. Known gaps — stated plainly

### 3.1 These are NOT the shared tree's baseline

The figures in §2 were measured in the isolated copy. They are **not** a shared-tree
baseline and must not be quoted as one. Three reasons:

1. The copy predates six test files the concurrent agent created after the 11:23 freeze
   (§3.2). They are absent from every run above.
2. The copy's test population had to be aligned by deleting 97 stale files (old
   `src/**/*.test.ts` and duplicate `tests/integration/<name>.test.ts` locations superseded
   by the `tests/` relocation). Recorded at `evidence/stale-test-files.txt`.
3. The copy's `node_modules` and `web/node_modules` are junctions into the shared tree, so
   runs exercise the shared tree's installed packages but not its live working state.

**A baseline must be re-measured in the shared tree after integration.**

### 3.2 Six concurrent test files absent from the reconstructed copy

Created by the concurrent agent after the freeze; not present in any isolated run:

```
tests/unit/logs/log-settings.test.ts
tests/unit/logs/logger-loss.test.ts
tests/unit/logs/logger-sink.test.ts
tests/unit/logs/logger.test.ts
tests/integration/logs/logs-client-ingest.test.ts
tests/integration/logs/logs-settings.test.ts
```

They touch no file in this plan, but they mean the §2 totals understate current reality.

### 3.3 Seven pre-existing failures, untriaged

Present with and without both fixes; none touches the chat route, overflow recovery, MCP, or
any file in this plan.

| Test | Area | Note |
|---|---|---|
| `e2e-build-integrity` ×4 | `buildWebAndStamp`, stale-stamp refusal | may be artifacts of running build tooling inside a copy; **not verified** |
| `normalizeBrowserUrl` prepends http:// | browser URL normalisation | pre-existing |
| `check-test-location` — no bare `@/` imports in web layers | test-location policy | may reflect the copy's layout, **not verified** |
| `codeCompactConformance` — `/compact` reaches the reducer | concurrent agent's spike work | **belongs to the other agent** |

Not attributed to any cause. Triaging them is outside this authorisation.

### 3.4 Superseded numbers, recorded so they are not reused

Earlier figures of `4188/74/70` and `4172/74/86` are **void**. They came from a command the
project never runs (missing `--path-ignore-patterns` and `--timeout`), against a population
that no longer exists. Of the 70 "failures", **57 were `Cannot find package 'lucide-react'`**
— a missing `web/node_modules` junction in the copy, i.e. my environment's defect, not a code
defect. The real failure count was 13.

---

## 4. Per-path plan

**Tracked targets (12)** — all currently byte-identical to HEAD, so HEAD is a free rollback
and there is no concurrent work on any of them. The ` M` git reports on seven of them is a
`core.autocrlf` phantom with no `.gitattributes`; `git diff --numstat` is empty for each.

| # | Path | Shared SHA-256 (16) | Recovered blob |
|---|---|---|---|
| 1 | `src/routes/chat.ts` | `d3aa40a6c4e94d0a` | `eb1b14a430b7` **+ Fix B** |
| 2 | `src/services/mcp/manager.ts` | `9afcacf35f697fe1` | `8eba009093a7` |
| 3 | `src/context/limits.ts` | `65ca9dd15db3d4ac` | `17aabe4c90a3` |
| 4 | `src/services/todos.ts` | `2dba557cd088c215` | `282d59e80e8d` |
| 5 | `src/config/providers.ts` | `47860d6259c05dd9` | `f4b5ee9b8892` |
| 6 | `src/context/cache/verification.ts` | `012f8011ee2c8cbc` | `5836d3d03a4c` |
| 7 | `src/services/modelDiscovery.ts` | `bebd0aa8f51c30b7` | `7f3e2c00c4d9` (**not** `bc298b72`) |
| 8 | `src/services/chat-streams/historyReconciler.ts` | `2d4dbf08a24977bc` | `f4a8cf73f4fa` |
| 9 | `src/services/scheduler/schedulerExecution.ts` | `512f8039137ddb1d` | `cae3a44f40cc` |
| 10 | `src/routes/providers.ts` | `7701cb289947bade` | `0a0b5e3f8276` |
| 11 | `src/services/chat-streams/sqliteResumableStore.ts` | `d7e927b12f30247f` | `536b43da5ec8` |
| 12 | `src/routes/direct-compact-command.ts` | `bf65759709697af2` | `507aaf1f5def` (**not** `3f273730`) |

**Untracked modules integration would ADD or REPLACE (4)** — these do not exist in HEAD; they
are artefacts of the chat-route extraction. Git has no record of them, so there is no HEAD
rollback and a byte-preserving backup is mandatory.

| # | Path | Shared SHA-256 (16) | Action |
|---|---|---|---|
| 13 | `src/routes/chat/gate.ts` | `63c70224a34ca4f1` | replace: recovered **+ Fix A** |
| 14 | `src/routes/chat/execute-direct-stream.ts` | `1d4764a4d048cd76` | replace: recovered **+ Fix A + Fix B** |
| 15 | `src/routes/chat/types.ts` | `3f300581f050768c` | replace: **Fix B only** (`StreamWriterHolder`) |
| 16 | `tests/integration/history/terminal-output-delivery.test.ts` | *absent* | add: Fix B regression test |

`types.ts` is **not** in the original 14-path recovery set — it survived intact and Fix B
modifies it. Adding it is why this plan now covers 16 paths, not 14.

**New file, not in HEAD:** #16 must be created. It belongs under `tests/` per the repo's
test-location rule.

### Untouched by design — verified identical to the copy

`src/routes/chat/{validate-and-resolve,assemble-run,settlement}.ts`,
`src/services/mcp/{store,transport,tool-content}.ts` — all untracked, all byte-identical to
the verified copy. Overwriting them would be gratuitous churn.

### Explicitly out of scope

- `.tmp-all.mjs` — untouched per standing instruction. It is this assistant's artefact from
  the destructive bisect, not the concurrent agent's. Recommend deletion, on authorisation only.
- The six concurrent log tests (§3.2) — another agent's work.

---

## 5. Preconditions — all before any shared-tree write

1. **Re-run the byte-identity check immediately before writing.** §4's hashes were taken at
   plan time and the tree is live. If any target's SHA-256 differs, **stop and reassess that
   path** — do not overwrite. A changed hash means a concurrent write landed and the
   LOW-risk assessment for that path is void.
2. Byte-preserving pre-integration snapshot of all 16 paths plus a
   `git status --porcelain` manifest → `pre-integration/`. For the four untracked paths this
   is the **only** rollback that exists.
3. Copy blobs byte-preserving: `git cat-file blob` → `File.WriteAllBytes`.
   **Never PowerShell `>` redirection** — it produced UTF-16LE in the first export attempt
   and silently corrupted every candidate file.
4. Apply in dependency order: `chat.ts` → `gate.ts` → `execute-direct-stream.ts` →
   `types.ts` → `mcp/manager.ts` → remaining tracked files → the new test.
5. Re-run gates **in the shared tree**, not the copy: `tsc --strict`, the five overflow
   suites, `bun run test` against the real population (including the six log tests), the new
   terminal test, `test:locations`, `build`.

---

## 6. Residual risk

- **Candidate selection was evidence-based, not archival.** Each recovered file was chosen by
  content markers plus compiler feedback. Two were initially wrong (`modelDiscovery`,
  `direct-compact-command`) and were corrected. A subtler mis-selection would still yield a
  tree that compiles and passes while differing from the genuinely lost file. The gates do
  not eliminate this.
- **The freeze is aging.** It was taken at 11:23 and the concurrent agent has written since.
  Precondition 1 exists for this reason and must not be skipped as ceremony.
- **The 7 remaining failures are untriaged**, and two of them (`e2e-build-integrity`,
  `check-test-location`) may be artifacts of running inside a copy rather than real defects.
  That is unverified either way.