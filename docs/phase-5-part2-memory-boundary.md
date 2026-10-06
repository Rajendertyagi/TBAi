# Phase 5 — Part 2 Architecture Investigation: the MemoryService boundary

**Date:** 2026-10-01
**Scope:** architecture only. **No implementation.** No ICM dependency, no client, no
adapter, no retrieval, no ranking, no injection, no MemoryPanel change.
**Question:** *Does Phase 5 need ICM specifically, or a TBAi-owned `MemoryService`
boundary capable of supporting multiple memory providers?*

Every conclusion is classified: **VERIFIED · CONTRADICTED · UNKNOWN · INTERPRETATION**.

---

## 1. VERIFIED current architecture

### 1.1 Actual code path

```
MemoryPanel.tsx  ──fetch──▶  /api/memories  ──▶  routes/memories.ts
                                                        │
                                                        ▼
                                          memoryService (storage/index.ts:579)
                                                        │
                                                        ▼
                                     db.query / db.run  →  TBAi SQLite `memories`
```

### 1.2 Actual storage

```sql
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)
```

No index. No category. No scope. No status. No provenance. Table contains **0 rows**.

### 1.3 Actual "MemoryService" implementation

```ts
export const memoryService = {          // storage/index.ts:579 — a plain object literal
  async list(): Promise<Memory[]>        // SELECT * FROM memories ORDER BY updated_at DESC
  async add(content: string): Promise<Memory>
  async delete(id: string): Promise<void>
}
```

- Calls `db.query` / `db.run` **directly on the module-level SQLite singleton**.
- No constructor parameter, no driver, no injection point, no interface implemented.
- **5 references in the entire codebase**, all in `routes/memories.ts` plus its own
  declaration. Never mocked, stubbed, or substituted anywhere.

### 1.4 Actual UI relationship

`MemoryPanel.tsx` is a 63-line settings page at `/memory`: list content, add, delete. It
talks only to `/api/memories`. It has no notion of a provider, a connection, or an
external service.

---

## 2. ICM status

### 2.1 What does NOT exist — VERIFIED absent, five independent ways

| Probe | Command | Result |
|---|---|---|
| Code references | whole-word `ICM` across `src/` + `web/src/` | **0** |
| Dependency | `icm\|memory\|vector\|embed` in `package.json` | **0** |
| Configuration | `TBAI_ICM\|ICM_URL\|ICM_PORT\|icm_url` | **0** (earlier apparent hits were `renderToStat`**`icM`**`arkup`) |
| Git history | `git log --all --grep="\bICM\b"` | **0 commits, ever** |
| Git filenames | any path containing `icm`, all history | **0 files, ever** |

There is no ICM client, adapter, HTTP integration, configuration, dependency, or runtime
integration. **VERIFIED.**

### 2.2 What DOES exist

- A `memories` table in **TBAi SQLite**, present since the **initial commit** `db63645`.
- A 4-column concrete `memoryService` reading it.
- A CRUD UI over it.
- **Documentation describing ICM** — and nothing else.

### 2.3 Chronology — VERIFIED

| Event | Commit |
|---|---|
| `memories` table created in TBAi SQLite | `db63645` — *Initial commit: TBAi chat app with scheduler* |
| `docs/architectural-principles.md` added, mandating ICM | `f4fadae` — *docs: add durable architecture principles* |

**The code predates the document.** The ICM architecture describes a state the codebase
was never moved to. This is material to interpreting every ICM statement below.

---

## 3. ARCHITECTURE DOCUMENT INTERPRETATION

Classifying each ICM statement rather than reconciling them silently.

### 3.1 `decisions.md:16, 21–22, 26–28` — **INTERPRETATION (strong)**

The ICM clause sits inside the "Durable architecture direction" block, whose own
**Status** line reads:

> **Status:** this is the target architecture, not a requirement to preserve every
> existing custom implementation — prefer deleting obsolete custom code when upstream
> capability becomes sufficient.

That status governs the block containing both the ICM clause and the
"merging ICM with TBAi's application SQLite" rejection.

**Reading:** ICM is named as the *anticipated* implementation, and the whole block
self-declares as **target architecture, not a binding requirement**. This status line is
the single strongest piece of evidence against treating ICM as mandatory.

### 3.2 `architectural-principles.md:200–201` — **VERIFIED requirement**

> Expose a TBAi-owned `MemoryService` interface so the application does not depend
> directly on ICM implementation details.

**Reading:** the *abstraction* is an explicit, unambiguous requirement — and its stated
purpose is specifically to decouple from ICM. That is the same conclusion the maintainer
reached: the boundary is the requirement, ICM is one anticipated implementer.

### 3.3 `architectural-principles.md:180–198` — **VERIFIED text, CONTRADICTED in practice**

> TBAi owns memory policy: what to recall · when to recall · scope/project selection ·
> what is worth storing · sensitivity/privacy policy
>
> ICM owns memory mechanics: storage · deduplication · **embedding** · **ranking** ·
> decay · consolidation · **retrieval**

This assigns **ranking and retrieval to ICM**. It is the only place in the repository
that does.

### 3.4 `TBAI-context-subagent-roadmap.md:1387–1389, 1401` — **CONTRADICTS §3.3**

> - Retrieval must be relevance-based, with recency as one signal.
> - Retrieval must be **deterministic**: the same query and memory set must produce the
>   same selection
> - Memory ordering … must not depend on retrieval-engine internal iteration.

And §5.2 places `retrieval → ranking → budget allocation` inside TBAi's context pipeline.

**Conflict, stated plainly:** two authoritative documents assign **retrieval and ranking
to different owners.** `architectural-principles.md` says ICM. The roadmap says TBAi.

A *reconciliation* is available — read "what to recall" (TBAi policy) as selecting among
candidates, and "retrieval" (ICM mechanics) as fetching them — under which both hold.
**That reconciliation is an INTERPRETATION, not evidence.** It is consequential (see §6)
and is therefore not adopted here.

### 3.5 `architecture.md:603, 611–614` — **INTERPRETATION: aspirational**

> `+-- durable memory ----------> MemoryService -> ICM`
> ICM is the shared durable memory engine… These paths share the ICM corpus without
> merging the two databases.

Directly contradicted by the tree (memories live in TBAi SQLite). Given §2.3 chronology
and §3.1's status line, this reads as a description of the **intended end state**, not
the current one.

---

## 4. MEMORY PROVIDER MODEL

The model below is **supported by repository evidence for its shape**, though not for
its population.

```
Context Assembly (src/context/assemble.ts)
        ↓  depends on a contract, never an implementation
MemoryService  ← interface, TBAi-owned   [REQUIRED: architectural-principles.md:200-201]
        ↓
Memory Provider  ← interchangeable
        ├── Application / Local  (TBAi SQLite)   [EXISTS today: memories table + memoryService]
        ├── ICM                                    [DOES NOT EXIST — named in docs only]
        ├── Other external provider                [UNKNOWN — no evidence either way]
        └── None                                   [EXISTS today: no provider is wired]
```

**What evidence supports each layer:**

| Layer | Status | Evidence |
|---|---|---|
| Context assembly depends on a contract, not an implementation | **VERIFIED** | `CompactionSeam` is the established idiom: interface in `src/context/types.ts`, constructed by the route (`chat.ts:363+`), injected into `assembleContext` |
| `MemoryService` as a TBAi-owned interface | **VERIFIED requirement** | `architectural-principles.md:200-201` |
| Provider layer is the right shape | **INTERPRETATION** | The interface's stated purpose ("does not depend directly on ICM implementation details") implies substitutability, but no doc describes a provider list |
| Application/Local provider | **VERIFIED exists** | `memories` table + concrete `memoryService` |
| ICM provider | **VERIFIED absent** | §2.1 |
| "Other external provider" | **UNKNOWN** | No evidence. Not contradicted either |
| "None" | **VERIFIED exists** | No provider is wired; no seam exists on `AssembleContextInput` |

**Alternative idiom considered:** the codebase also uses singleton+class for shared
infrastructure (`ProviderRegistry.getInstance()`, `McpManager.getInstance()`). That
would **not** give substitutability — a singleton cannot be swapped without editing it.
For a contract the context layer consumes, `CompactionSeam` is the correct precedent.
**INTERPRETATION**, evidence-consistent.

### What evidence is missing for a fuller model

- No doc enumerates providers or describes selection among them.
- No doc says whether MemoryPanel should surface external-provider memory.
- No doc resolves §3.3 vs §3.4.

---

## 5. Application memory vs external memory tools

**CONTRADICTED / UNRESOLVED.**

- `architectural-principles.md:139–157` models **one** memory corpus (ICM) with two
  access paths — TBAi via HTTP, external agents via MCP/hooks — **converging on the same
  corpus**.
- The tree implements **one** memory system that is **entirely TBAi-local**, with no
  external path at all.

These are two different system shapes. Which is intended *for Phase 5* is not
established by the repository.

---

## 6. What MemoryPanel represents

**VERIFIED:** it is **application memory UI** — a thin CRUD surface over
`/api/memories` → TBAi SQLite. It cannot represent external memory, because no provider
concept exists anywhere in the codebase.

**UNKNOWN:** whether it was *intended* to also surface external-provider memory. No
document states this. `architecture.md:100` lists it only among UI components.

This matters for Part 14: if Phase 5 introduces a provider boundary, MemoryPanel's
scope — application memory only, or all memory — is undetermined.

---

## 7. Part 2 exit rule — ANSWER

> *Does Phase 5 need ICM specifically, or a TBAi-owned `MemoryService` boundary capable
> of supporting multiple memory providers?*

**ANSWER, from repository evidence: Phase 5 needs the TBAi-owned boundary. It does not
need ICM.**

Grounds, each independently classified:

1. **VERIFIED** — zero ICM implementation, dependency, configuration, history, or
   filename exists (§2.1). Nothing can be built *on* it.
2. **VERIFIED requirement** — `architectural-principles.md:200-201` explicitly requires a
   TBAi-owned `MemoryService` interface, and its stated purpose is decoupling from ICM.
3. **INTERPRETATION (strong)** — the ICM clause's own block is marked *"target
   architecture, not a requirement to preserve"* (`decisions.md:26`).
4. **VERIFIED precedent** — `CompactionSeam` shows the codebase already expresses exactly
   this shape for Phase 4, so the boundary is not a new architectural idea.

**Therefore:** ICM must **not** be a hard-coded dependency, and the context layer must
depend on a contract rather than on ICM. This matches the maintainer's stated
interpretation.

**However — the exit rule also requires that the answer be *established*, and one
question inside it is not:**

> **For Phase 5, does TBAi own candidate *retrieval*, or only *selection* over candidates
> a provider supplies?**

- If TBAi owns retrieval → Phase 5 is buildable and locally testable now against the
  local `memories` table.
- If a provider owns retrieval → Phase 5 cannot be tested at all until a provider exists,
  because there is nothing to fetch candidates from.

§3.3 and §3.4 contradict each other on exactly this point, and the reconciliation in
§3.4 is an interpretation I am **not** entitled to adopt on the maintainer's behalf.

---

## 8. DECISION REQUIRED before Part 3

### D1 — Retrieval ownership *(blocks the port signature)*

Who fetches candidate memories for a turn?

- **(i) TBAi owns retrieval.** Phase 5 implements retrieval + deterministic ranking
  against the local `memories` table, behind the `MemoryService` contract. Buildable and
  fully testable now. Consistent with roadmap §5.3. Requires treating
  `architectural-principles.md:190-198` as aspirational for the retrieval/ranking
  bullets.
- **(ii) Provider owns retrieval; TBAi owns selection only.** Phase 5 implements
  selection, budget and injection over a provider-supplied candidate list. Consistent
  with `architectural-principles.md:190-198`. **Not testable end-to-end until a provider
  exists** — which means Phase 5 could only be certified against a stub.
- **(iii) Both**, via the contract: `MemoryService` may supply candidates, TBAi ranks and
  selects. Most faithful to both documents; needs a contract that makes "provider
  pre-ranked" an explicit, testable case.

**Recommendation: (iii)** — it is the only option that satisfies both documents, and it
keeps Phase 5 testable locally. But this is an architecture decision, not mine to make.

### D2 — Corpus scope *(blocks Part 14 / MemoryPanel)*

Is MemoryPanel **application memory only**, or the surface for **all** configured
providers? §6 is UNKNOWN from the repository.

### D3 — Documentation reconciliation *(not blocking)*

`architectural-principles.md:190-198` vs roadmap §5.3 currently disagree on retrieval and
ranking ownership. Whichever way D1 goes, one document needs a dated correction.
**I have not edited either** — historical/architecture docs are not rewritten
retroactively per the project rules.

---

## 9. STOP CONDITIONS — assessment

| Stop condition | Triggered? | Basis |
|---|---|---|
| ICM proven to be a mandatory architectural dependency | **NO** | §2.1 zero implementation; `decisions.md:26` marks the block as target architecture (§7) |
| Application vs external memory proven intentionally separate **with an undefined boundary** | **PARTIAL** | §5: the doc models one corpus, the tree implements a local-only system. Boundary undefined — but this is a *doc-vs-code* gap, not a proven-intent separation |
| Repository requires a product decision on which provider is authoritative | **YES — D1** | §3.3 vs §3.4 are contradictory; D1 is a product/architecture call |
| Required abstraction absent **and** introducing it would be a significant change | **NO** | `CompactionSeam` proves the shape already exists in-repo; the port is a small Phase-5-local interface, not a redesign |

**Verdict: STOP at D1.** Not because the architecture is unsound, but because the port's
signature depends on a decision the repository contradicts itself about, and I am
instructed not to resolve that by guessing.

---

## 10. Evidence index

| Claim | Class | Where |
|---|---|---|
| `memoryService` is a concrete SQLite object | VERIFIED | `src/services/storage/index.ts:579-605` |
| No memory port/abstraction exists | VERIFIED | only `MemoryRow` (private) + `Memory` (DTO) exist |
| 5 references, never substituted | VERIFIED | repo-wide grep |
| `memories` = 4 columns, 0 rows, no index | VERIFIED | `src/db/index.ts:356-361`; live DB read |
| Zero ICM in code/deps/config/history | VERIFIED | §2.1, five probes |
| `memories` predates the ICM doc | VERIFIED | `db63645` < `f4fadae` |
| `MemoryService` interface is required | VERIFIED | `architectural-principles.md:200-201` |
| ICM block is "target architecture" | INTERPRETATION (strong) | `decisions.md:26-28` |
| Docs are aspirational, not descriptive | INTERPRETATION | §2.3 chronology + §3.1 |
| Retrieval/ranking ownership | **CONTRADICTED** | principles `:190-198` vs roadmap `:1387-1389` |
| One-corpus model vs local-only reality | CONTRADICTED | principles `:139-157` vs tree |
| MemoryPanel = application memory | VERIFIED | code; §6 |
| MemoryPanel intended for external memory | UNKNOWN | no doc |
| Provider-list model | INTERPRETATION | §4 |
| `CompactionSeam` is the boundary idiom | VERIFIED | `src/context/types.ts:480`, `chat.ts:363+` |

**Nothing was implemented. No file in `src/` or `web/src/` was modified by this
investigation.**