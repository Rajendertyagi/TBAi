# Performance Guidelines (TBAi)

Durable rules for frontend, streaming, backend, database, and vault performance.

This document replaces `performance-optimization-masterlist.md`. That file was a
list of unchecked optimisation ideas, most of which were already implemented, and
one of which would have reintroduced a security regression. See
[§11 Why the masterlist was retired](#11-why-the-masterlist-was-retired).

**This is not a task list.** There are no checkboxes. A rule here is a standing
constraint on code that touches the area, and it stays true whether or not anyone
is currently working on performance. Where the right action depends on a
measurement, the rule is written as a *trigger* — a condition you must observe
before acting — not as a task to complete.

Read this alongside `AGENTS.md` and `development-rules.md`. Those define the
architecture; this defines the performance envelope that architecture has to hold.

**On coverage.** `TBAiPERFORMANCEAUDIT.md` is a read-only survey of all ten areas
in this document — source-exhaustive, but **entirely unmeasured**, since running
a build or test was out of scope for it. Read it as a map of what exists, not as
evidence of what costs anything. §7.3 carries forward the defects it found. Where
this document and the audit disagree, this document was corrected: the audit found
that the synchronous tool handlers in `services/tools.ts` are correct by contract
and that the earlier claim they were a defect was wrong.

---

## 0. How to use this document

### 0.1 Measure before you optimize

> "Recorded because the design assumed a cost, and an unmeasured cost is a guess."
> — `2026-09-25-phase2-durability-design.md:416`

That sentence is the reason the `sqliteResumableStore` was left alone. Someone
measured it, found 0.07–0.22 ms per chunk, and wrote down that **no optimisation
was needed and none was added**. That is the correct outcome of a performance
exercise.

The failure mode this document exists to prevent is the inverse: changing code
because a performance idea *sounded* right, with no measurement on either side.
Every performance claim in a PR description should carry a number. If you cannot
produce one, say so and describe what you measured instead.

### 0.2 The three questions, in order

Before changing code for performance, answer these in order:

1. **Is it slow?** Measure it. Use only the instruments in [§2](#2-measurement).
   "Slow" is not a feeling; it is a number compared against [§1](#1-budgets).
2. **What layer is it slow in?** Renderer main thread, backend event loop, disk,
   or the model provider. Optimising the wrong layer does nothing. The renderer
   and the Bun server are separate processes — blocking the server does not block
   the UI, and vice versa.
3. **Does the fix cost anything?** Correctness, security, or architectural
   rules. Some things are correctly slow. Say so rather than optimising them.

### 0.3 Optimising measured-and-adequate code is a defect

If a subsystem has been measured and found adequate, leave it and record that
finding. Do not re-optimise it because a checklist said to. This is not
theoretical — §11 lists four items that proposed doing exactly that.

### 0.4 Rules are enforced in review

Every rule in §3–§9 is a review criterion. A PR that violates one and does not
carry a recorded reason for it is not done. Per `AGENTS.md`, "If the diff adds
more 'fix this later' notes than it removes, it's not done."

### 0.5 Nothing here is protected until the test gate can fail for the right reason

**This is the first thing to fix, and it outranks every performance item in this
document.**

CI runs `bun run test` as a merge gate. Its documented baseline is **259 unique
failing tests** (`f-a-budget-defect-fix-report.md:369-381`), proven to be
cross-file SQLite contention: `tests/setup.ts:8` points every test file in a
process at one temp directory, so they share a single database. The same report
records `tests/unit/db.test.ts` passing 6/6 in isolation and failing in-suite.

The cost: **a new failure is indistinguishable from the standing 259.** A gate
that cannot fail for the right reason is not protecting anything — including every
budget in §1 and every rule in §3–§9. A bundle-size gate wired into that CI would
be no more trustworthy than the tests beside it.

Two consequences for how you work here:

- **Verify by isolation, not by suite.** A test that passes alone and fails in the
  suite may be either a real regression or the known contention. Run the single
  file before believing either.
- **Do not add a CI performance gate until the test baseline is fixed.** It would
  inherit the same noise problem, and a gate that cries wolf gets disabled.

The root cause is a test-harness isolation defect, not a performance problem, and
it belongs in its own change with its own ADR.

---

## 1. Budgets

A budget is a line you refuse to cross. Every row states whether it is **gated**
(build fails on breach) or a **target** (measured and recorded, breach is a
defect but not a build failure).

| # | Metric | Budget | Enforcement | Instrument |
|---|---|---|---|---|
| B1 | Entry chunk, minified (`web/dist/assets/index-*.js`) | `__X__` KB | **Gated** | `scripts/check-bundle-size.ts` |
| B2 | Total shipped JS (`web/dist/assets/*.js`) | `__X__` KB | Target | `du`-style listing over `web/dist/assets` |
| B3 | `GET /api/conversations` p95 | `__X__` ms | Target | `scripts/perf.ts` |
| B4 | `GET /api/providers` p95 | `__X__` ms | Target | `scripts/perf.ts` |
| B5 | `POST /api/chat` time-to-first-byte p95 | `__X__` ms | Target | `scripts/perf.ts` |
| B6 | `POST /api/chat` SSE completion rate | ≥ 99% | Target | `scripts/perf.ts` |
| B7 | Long tasks (>50 ms) during a streamed reply | 0 | Target | CPU profile (§2.1) |
| B8 | Keystroke-to-paint in a 500-message thread | `__X__` ms | Target | DevTools, manual |
| B9 | Renderer RSS after a 2 h session | flat ±`__X__` MB | Target | Task Manager, manual |
| B10 | Stream chunk append cost | ≤ 0.25 ms | Target | `2026-09-25-phase2-durability-design.md:414` |

### 1.1 Current measured values

These are real, measured against the implementation as it stands. They are the
baseline, not the budget.

| Measurement | Value | Source |
|---|---|---|
| Entry chunk, minified | **2.01 MB** | `web/dist/assets/index-B8Ur55wG.js` (packaged build) |
| Total shipped JS | **13.9 MB across 323 chunks** | packaged `web/assets` |
| Lazy Shiki grammar chunks | **179 chunks, 2–20 KB each** | packaged `web/assets` |
| Mermaid chunk | 54 KB, already split | `mermaid-CQcHuHx7.js` |
| Stream chunk append | 0.07–0.22 ms (~14k/s) | `2026-09-25-phase2-durability-design.md:422` |
| Full run, 4,171-chunk reply | ~300–380 ms total store cost | same, `:423` |
| Replay 2.5 MB stored stream | 8–19 ms | same, `:424` |
| Cleanup 500 expired rows | 4 ticks, 36–55 ms | same, `:425` |

B10 is already met with two orders of magnitude of headroom. Leave the store
alone.

### 1.2 Filling in the `__X__` values

`scripts/perf.ts:17` already says the right thing:

```ts
// Baseline-first: fill in after the first real run. -1 = no threshold yet.
const THRESHOLDS = {
  restP95Ms: -1,        // p95 for /api/conversations + /api/providers
  chatTTFTp95Ms: -1,    // time-to-first-byte for /api/chat
  successRatePct: 99,   // min acceptable %
};
```

B3–B6 are those three thresholds. To fill them:

1. Start the backend against a realistic data directory (a copy of live, not an
   empty DB — an empty DB measures nothing).
2. `bun run scripts/perf.ts --samples 50 --concurrency 10`
3. Set each threshold ~20% above the observed p95, so ordinary variance does not
   trip it and a real regression does.
4. Record the run — date, sample count, concurrency, and the numbers — in this
   section, the way `2026-09-25-phase2-durability-design.md:414` does.

B1 is the one gated budget, and it is the only one that can be enforced without a
running server and a configured provider. The others need a live backend, which
is why they are targets.

### 1.3 Why the entry chunk is the number that matters most

Tauri ships no browser engine. The frontend bundle is therefore a much larger
share of the application than it would be under Electron, and every kilobyte of it
is parse and compile time on the WebView main thread before the window is
interactive. A Tauri cold start otherwise measures in the 200–500 ms range; a
2 MB entry chunk spends a meaningful fraction of that before React mounts.

This is also why §4 (code splitting) outranks the chunking questions people
usually ask first. Splitting *out* of the entry chunk reduces parse time. Rearranging
chunks that are already split does not.

---

## 2. Measurement

Only these instruments. A number from any other source is a guess with extra
steps.

### 2.1 Renderer CPU profile

```bash
cd web
TBAI_PROFILE_BUILD=1 bun run build      # writes dist-profile/, never dist/
```

Driven by `web/e2e/helpers/cpuProfile.ts`. The profile build is unminified so
real function names survive into the profile, and it writes to a separate
directory so a profiling artifact can never overwrite the shippable `web/dist`
(`vite.config.ts:37-40`).

**Read `(program)` as unattributable.** `vite.config.ts:9-40` documents why at
length: `(program)` held 78–100% of self time for *every* workload tried,
including an idle page, and survived `--jitless`. It is the sampler's bucket for
time with no JavaScript frame — idle and collector time included — not mangled
application code. No sourcemap will ever fix it. `cpuProfile.ts` reports
`(program)`, `(idle)`, and `(garbage collector)` as a separate bucket precisely
so the remaining names can be ranked without them dominating.

If a profile appears to say "everything is `(program)`", the answer is not "the
app is slow" — it is that there is nothing left to attribute. Re-run on a real
workload.

### 2.2 Backend latency

```bash
bun run scripts/perf.ts                              # quick: 20 samples, concurrency 5
bun run scripts/perf.ts --samples 50 --concurrency 10
bun run scripts/perf.ts --json --out perf-result.json
```

The backend must already be running; the script only measures. Reports REST
p50/p95 for `/api/conversations` and `/api/providers`, plus SSE TTFT p50/p95,
total p95, and completion rate for `POST /api/chat`.

> **Known defect — do not trust absolute TTFT yet.** `scripts/perf.ts:104` does
> `await new Promise((r) => setTimeout(r, 0))` inside the stream read loop. That
> is a macrotask per chunk, which inflates both TTFT and total duration. The
> shape is sound; the absolute values are pessimistic by an unknown amount.
> Fix it before recording B5 as a real baseline. Ratios between runs are still
> comparable to each other.

Also note `scripts/perf.ts:65`: the chat probe posts `providerId: "perf-probe"`,
which may not exist. It measures **transport** behaviour, not model latency. B5
is a transport budget, and a provider's own time-to-first-token is not in scope.

### 2.3 Query plans

Before adding an index, or before concluding a query is fine:

```sql
EXPLAIN QUERY PLAN <statement>;
```

`src/db/index.ts:396-397` is the worked example of doing this properly — the
comment records that a correlated `(conversation_id, order_seq)` subquery
"sorts without this and degrades to a per-row scan (O(N²)) over scheduler
threads", and the index exists for exactly that reason. That comment is the
standard: an index should be traceable to a plan you read.

### 2.4 What to record

Performance findings go in the document where the subsystem lives, in a table
with real numbers, the date, and the conditions. Do not put them in a checklist
and do not put them in a commit message. `2026-09-25-phase2-durability-design.md:414`
is the format to copy.

---

## 3. TypeScript and build configuration

### 3.1 Current state

`web/tsconfig.json` is in good shape:

| Option | Value | Line |
|---|---|---|
| `strict` | `true` | `:14` |
| `isolatedModules` | `true` | `:12` |
| `noUnusedLocals` / `noUnusedParameters` | `true` | `:15-16` |
| `noFallthroughCasesInSwitch` | `true` | `:17` |
| `moduleResolution` | `bundler` | `:8` |
| `noEmit` | `true` | `:11` |

Two choices there are load-bearing and must not be reverted:

- **`noEmit: true`.** The root `tsconfig.json:6-15` documents why with a scar: a
  bare `tsc -p tsconfig.json` with no `outDir` emitted a `.js` twin beside every
  source file, and ~80 stale twins accumulated — including 13 `*.test.js` copies
  that `bun test` collected as duplicate suites, which made `todo.test.ts` fail
  on a shared test database and **doubled the reported test counts**. Nothing
  needs `tsc` to emit: the backend bundles with `bun build`, the web app builds
  with Vite, and `typecheck` already passes `--noEmit`. Keep it that way.
- **`moduleResolution: "bundler"`.** Correct for a Vite/Bun project. Do not
  "fix" it to `node`/`nodenext`; that conflicts with the bundler resolution the
  build actually uses.

### 3.2 Known gap: the backend config is not held to the same standard

`tsconfig.json` (backend + scripts) has **no `strict`**, no `isolatedModules`,
and no `verbatimModuleSyntax`. It has no `extends`, so TypeScript's default
(`strict: false`) applies to all of `src/` and `scripts/`. `web/tsconfig.json`
sets `strict: true` plus `noUnusedLocals`, `noUnusedParameters`, and
`noFallthroughCasesInSwitch`.

The consequence is measured, not theoretical — the audit counted, in non-test
`src/`:

| Escape hatch | Backend | `web/src` |
|---|---|---|
| `any` | 24 | 12 |
| `as unknown as` | 18 | 8 |
| non-null assertions (`!`) | ~9 | — |
| `@ts-ignore` / `@ts-expect-error` | 0 | 0 |

So the backend gets no `strictNullChecks` and no `noImplicitAny`, and the escape
hatches cluster where you would expect: `mcp/manager.ts` (4), `chat-runs.ts` (2),
`routes/chat.ts` (2). `context/memory/seam.ts:200` (`as unknown as UIMessage`)
and `:174` (`blockId!`) are exactly the patterns strict mode rejects.

This is recorded rather than fixed because enabling `strict` is a sized change
with its own verification, not a documentation edit. Until it is done:

- New backend modules are still written to `development-rules.md` §3 standards —
  no `any`, no `as unknown as X`, explicit types at module boundaries. That rule
  is the substitute for the compiler flag, and it is currently the *only* thing
  enforcing it.
- When `strict` is enabled, it belongs in its own change with its own ADR, and it
  should be done with the compiler on so the error count is known in advance.

### 3.3 `verbatimModuleSyntax` — a build-performance flag, not a style rule

Worth understanding before adopting, because the reason is not stylistic. Under
default settings TypeScript performs **import elision**: it analyses how each
import is used and drops the ones that are type-only. `verbatimModuleSyntax`
(TS 5.0+) removes that analysis. Anything marked `type` is erased; anything not
marked is preserved exactly as written.

```ts
// Erased entirely.
import type { MessageRow } from "./rows";

// Preserved — buildTurns is a value.
import { buildTurns, type MessageRow } from "./rows";
```

Two consequences to know:

- It makes emit predictable. Under elision, whether an import survives can depend
  on how a value is *declared* (`class` vs `type` vs `interface`), which is not
  obvious from the import site.
- It will surface errors. Code relying on an unmarked type-only import being
  silently dropped will start failing to compile. That is the point — but budget
  for it as a real change, not a flag flip.

`erasableSyntaxOnly` is the companion flag: it forbids TypeScript syntax that
cannot be erased to plain JavaScript (enums, namespaces, parameter properties),
which keeps the door open to running `.ts` directly.

### 3.4 `build.target` — polyfill elimination

`web/vite.config.ts:50-64` configures **only** the profile build. The production
build takes Vite's defaults, which means no explicit `build.target`.

Setting an explicit `build.target` is the cheapest remaining win on entry-chunk
size: Vite lowers syntax to that target and **stops emitting polyfills for
anything the target already supports**. Left at the default, Vite assumes a
conservative browser range and ships transforms the WebView2 runtime does not
need.

Choose the target from what actually ships. TBAi's minimum is Windows 10 /
WebView2, so something like `['chrome110', 'safari15']` is defensible. Verify the
emitted output shrinks rather than assuming it does, and check it against the
WebView2 versions you support — this app ships as a portable folder to unknown
machines, and a target that is too aggressive breaks older runtimes.

### 3.5 What not to do

- **Do not add `manualChunks` as a size fix.** See §4.5 — it is a cache-hit tool
  and does not shrink the entry chunk.
- **Do not enable production sourcemaps.** Already correctly off outside the
  profile build.
- **Do not chase `chunkSizeWarningLimit`.** Raising the threshold silences the
  warning; it does not change the output.

---

## 4. Lazy loading and code splitting

### 4.1 Two techniques, two different problems

Most "add lazy loading" advice conflates two things that need opposite
approaches:

| Goal | Technique | Result |
|---|---|---|
| Code that **must never** ship to users | Statically-foldable constant + ordinary import | Chunk is **eliminated** — never downloaded, never parsed, absent from output |
| Code that is **used on demand** | `lazy()` + `<Suspense>` | Chunk is split; fetched when first rendered |

TBAi already ships the first technique and it works. It is the model to follow.

### 4.2 Pattern A — elimination (dev-only and dead code)

`web/src/components/DevToolsGate.tsx`:

```tsx
import { DevToolsModal } from "@assistant-ui/react-devtools";
import { DEV_TOOLS_ENABLED } from "../config/devtools";

export function DevToolsGate() {
  if (!DEV_TOOLS_ENABLED) return null;
  return <DevToolsModal />;
}
```

`web/src/config/devtools.ts:42`:

```ts
export const DEV_TOOLS_ENABLED = import.meta.env.DEV;
```

`import.meta.env.DEV` is **statically replaced** by Vite. In a production build
it folds to `false`, so the guard reduces to an unconditional `return null`, the
`DevToolsModal` reference becomes dead, and the bundler drops the import. The
~160 KB panel chunk stops existing in the output.

Verified against the packaged build: no DevTools chunk in `web/assets`, and the
string `"Waiting for assistant-ui instance"` appears in **no** chunk.

This is strictly better than `lazy()` for this case. `lazy()` would still place
the chunk in the output and merely never request it — the bytes ship forever.
Elimination removes them.

> **Correction to a comment in the code.** `DevToolsGate.tsx:21-23` and
> `devtools.ts:29` both describe this as "the `lazy()` panel chunk". There is no
> `lazy()` in `DevToolsGate.tsx` — the import at `:1` is ordinary. The *outcome*
> the comments claim is correct and verified; the *mechanism* they name is not
> what is implemented. Fix the comments when convenient. It is recorded here
> because a comment that misdescribes its own mechanism is how a future reader
> concludes `lazy()` is load-bearing here.

**Rule:** an import reachable only behind a build-time constant must be reachable
*only* through that constant. If any other module also imports it, elimination
stops and you are back to shipping the bytes.

### 4.3 Pattern B — `lazy()` + `<Suspense>` (on-demand routes)

`web/src/app/router.tsx:2-19` statically imports **all 18 route components**:

```ts
import { ChatShell } from "./layout/ChatShell";
import { ChatView } from "../features/chat/components/ChatView";
import { ProvidersPage } from "../features/providers/ProvidersPage";
import { McpPanel } from "../components/McpPanel";
import { CodeShell } from "../features/opencode/CodeShell";
// … 13 more
```

There is no `lazy()` anywhere in `web/src` outside of comments. Consequences:

- The 2.01 MB entry chunk contains every page, including the whole
  `@opencode/client` for Code mode, which most sessions never open.
- Search, MCP, and the scheduler workbench are paid for at startup by every user.

This is the largest available frontend win and it has **no architectural
tension** — it touches no assistant-ui boundary, no runtime, nothing in
`AGENTS.md:87-148`.

The sanctioned shape, with preloading attached:

```ts
// web/src/app/lazy-with-preload.ts
import { lazy, type ComponentType, type LazyExoticComponent } from "react";

/**
 * `React.lazy` with the importer exposed, so a surface can be fetched before it
 * is navigated to.
 *
 * Call `preload()` on nav hover/focus (a real intent signal) and on
 * `requestIdleCallback` for surfaces a user reaches constantly, so the common
 * case is warm before the click lands.
 */
export function lazyWithPreload<T extends ComponentType<unknown>>(
  importer: () => Promise<{ default: T }>,
): LazyExoticComponent<T> & { preload: () => Promise<unknown> } {
  const Component = lazy(importer) as LazyExoticComponent<T> & {
    preload: () => Promise<unknown>;
  };
  Component.preload = importer;
  return Component;
}
```

```ts
// web/src/app/router.tsx
const ProvidersPage = lazyWithPreload(
  () => import("../features/providers/ProvidersPage"),
);
const McpPanel = lazyWithPreload(() => import("../components/McpPanel"));
const CodeShell = lazyWithPreload(
  () => import("../features/opencode/CodeShell"),
);
```

`createHashRouter` accepts a `Component` that suspends, but a `<Suspense>`
boundary must exist above it. Put **one boundary high in the tree** — around the
route outlet, not one per page — so navigating between two lazy routes does not
unmount and remount a shell, and one fallback covers the whole surface.

```tsx
<Suspense fallback={<RouteFallback />}>
  <Outlet />
</Suspense>
```

### 4.4 Traps

**Webpack magic comments do nothing in Vite.** Most preloading guides online teach
this:

```tsx
// ❌ Vite ignores all of these comments.
const Reports = lazy(() =>
  import(/* webpackPrefetch: true */ /* webpackChunkName: "reports" */ "./Reports"),
);
```

Vite does not read webpack magic comments. The portable equivalent is
`lazyWithPreload` plus a real call site. If a lazy-loading tutorial leans on
`webpackPrefetch`, translate it rather than copying it.

**Do not over-split.** Not every component deserves a chunk. Each boundary costs a
request, a parse, and a fallback flash. Split routes and genuinely heavy,
rarely-used features; leave a dropdown with its page. The 179 Shiki grammar
chunks are the right pattern — small, independently useful, fetched on first use
of that language.

**Do not wrap individual messages in `<Suspense>`.** A boundary inside a streaming
transcript unmounts and remounts its subtree when it suspends, which fights the
scroll anchoring in §5.4.

**Route-level only, at first.** Splitting inside a route adds boundaries to every
navigation for a smaller share of the win. Measure the entry chunk after §4.3
before splitting further.

### 4.5 `manualChunks` is a cache tool, not a size tool

`web/vite.config.ts` sets no `manualChunks`. That is currently correct, and the
reason is worth stating because the opposite is commonly asserted.

`manualChunks` **reshuffles** already-split code into named groups. It does not
remove bytes from the entry chunk, does not reduce total size, and does not cut
parse time for code that still must load before first render. What it improves is
**long-term cache hit rate**: a vendor chunk that never changes stays cached
across app releases.

That is a real benefit, worth having eventually. It is not why the entry chunk is
2.01 MB. §4.3 is.

If it is added:

- Prefer the **function** form over the object map. The object form assigns a
  module to a chunk and can pull its dependencies along, producing a chunk that
  changes whenever any dependency changes.
- Over-splitting invites circular chunk warnings, which are a real regression.
- Vite is moving to Rolldown, where `manualChunks` is superseded by
  `advancedChunks` (`{ groups: [{ name, test }] }`). On Vite 6 with Rollup,
  `manualChunks` is correct today. Do not migrate config for a hypothetical
  upgrade.
- Measure before and after with §2.1 and record it. An unverifiable chunking
  change is a guess.

---

## 5. React rendering

### 5.1 Current state: memoization is hand-written, and the list is short

There is no `React.memo` in `web/src`. What exists instead is narrow selector
subscription through the runtime's own store, which is the right pattern:

```tsx
// ChatWindow.tsx:136, :262
const isEmpty = useAuiState((s) => s.thread.isEmpty);
const threadIsRunning = useAuiState((s) => s.thread.isRunning);
```

Each component subscribes to the narrowest field it needs, so a token arriving
does not re-render the whole transcript. Preserve that discipline: **a selector
must return a primitive or a stable reference.** Returning a freshly-built object
defeats the subscription, because every store notification looks like a change.

```tsx
// ❌ new object every notification — re-renders on every token
const meta = useAuiState((s) => ({ model: s.message.modelId }));

// ✅ narrow field
const modelId = useAuiState((s) => s.message.modelId);
```

### 5.2 React Compiler — decided, documented, not yet adopted

**Decision: not adopted. Revisit when the entry chunk work in §4.3 lands and a
baseline exists to compare against.**

React Compiler v1.0 has been stable since October 2025 and runs in production at
Meta. React's own guidance for new code is: *"For new code, we recommend relying
on the compiler for memoization and using `useMemo`/`useCallback` where needed to
achieve precise control."* Under that guidance, most hand-written `React.memo`
is redundant — which makes "wrap components in `React.memo`" obsolete advice
rather than merely unnecessary advice.

It is still not adopted here, for reasons worth recording:

- **There is no baseline to prove a win.** §1.2 has to be filled in first. A
  performance change adopted before the budget exists cannot be evaluated.
- **Rule violations are build errors.** That is a feature — it audits the
  component tree for free — but it means adoption is a change that can break the
  build in ways unrelated to the change's intent.
- **It will slow the build.** A Babel pass over every `.tsx` file is real cost on
  top of an already slow profile build.

**The setup, when the decision is revisited.** `web/vite.config.ts` currently
registers `react()` with no options. `@vitejs/plugin-react` v6 removed Babel
support, but TBAi is on `4.7.0`, so the legacy path is available and is the right
one — no `@rolldown/plugin-babel`, no plugin reordering:

```ts
// web/vite.config.ts
react({
  babel: {
    plugins: [["babel-plugin-react-compiler", { target: "19" }]],
  },
})
```

```
bun add -D --exact babel-plugin-react-compiler
```

Three things this does **not** need:

- **No `react-compiler-runtime`.** That is for React 17/18. TBAi is on 19.2.8.
- **No ESLint plugin.** TBAi uses Biome and never had `eslint-plugin-react-hooks`.
  The compiler is its own enforcement, and rule violations fail the build —
  stricter than a lint warning, and a better fit for `AGENTS.md` than adding an
  ESLint dependency would be.
- **No change to the assistant-ui freeze.** The Babel pass skips `node_modules` by
  default, so only TBAi source is transformed. The frozen train is not at risk
  from the compiler itself.

Pin the exact version. React's install docs use `--save-exact`, and floating
`@beta` tags have been a documented source of drift.

Verify it is actually compiling: the "Memo ✨" badge in React DevTools on a known
component, or `npx react-compiler-healthcheck`.

### 5.3 The `"use no memo"` policy — and one conflict you must know about

The compiler's documented escape hatch is a `"use no memo"` directive at the top
of a function, for cases of "Rules of React violations that weren't statically
detected".

**Policy:** `"use no memo"` is allowed, but each use carries a comment naming the
specific reason. A bare `"use no memo"` is a silent opt-out and is not acceptable
in review. Prefer fixing the code; use the directive when the pattern is
externally imposed.

**The known conflict.** The assistant-ui virtualization guide — the sanctioned
path for long threads (§5.5) — contains this pattern:

```ts
const useThreadMessageRows = (): readonly MessageRow[] => {
  const prevRowsRef = useRef<readonly MessageRow[]>([]);
  return useAuiState((s) => {
    const messages = s.thread.messages;
    const prev = prevRowsRef.current;
    if (/* membership unchanged */) return prev;
    const next = messages.map(({ id, role }) => ({ id, role }));
    prevRowsRef.current = next;   // ← ref mutation during render
    return next;
  });
};
```

**React Compiler rejects that.** Mutating a ref during render is a compiler
violation, and this class of violation is known to produce *silent bailouts*
rather than clean failures. It is also the referential-stability trick that makes
virtualization work, so it cannot simply be deleted — `"use no memo"` on that one
hook is the local fix.

This is recorded now so the conflict is discovered during design rather than
mid-implementation.

### 5.4 Long threads: virtualization is trigger-based, not automatic

`ChatWindow.tsx:161-167` renders the transcript through a library primitive:

```tsx
<ThreadPrimitive.Viewport className="flex-1 space-y-4 overflow-y-auto ...">
  <ThreadPrimitive.Messages>
    {({ message }) =>
      message.role === "user" ? <UserMessage /> : <AssistantMessage mode={mode} />
    }
  </ThreadPrimitive.Messages>
</ThreadPrimitive.Viewport>
```

`ThreadPrimitive.Messages` mounts every message. `@assistant-ui/react` ships **no
virtualization** — a grep for `virtualiz` across the installed package returns
nothing. So in a 1,000-message thread, 1,000 `MarkdownText` +
`BoundedSyntaxHighlighter` + tool-group subtrees are mounted.

**Before building anything, note what is already free.** The default assistant-ui
kit renders message bodies with `content-visibility: auto` and
`contain-intrinsic-size`, which already skips paint work for off-screen messages,
and `ThreadPrimitive.Viewport` handles auto-scroll. Per the vendor's own guide,
*"That covers typical threads."*

**The trigger.** Reach for virtualization when *React mount and update cost*
becomes the bottleneck — per the vendor: *"threads with hundreds to thousands of
messages, or very heavy per-message content, where typing latency degrades
because every message stays mounted."*

So the measurement to take first is **B8: keystroke-to-paint in a 500-message
thread.** If it is fine, this work does not happen, and the entry-chunk work in
§4.3 is strictly higher value per unit of risk.

**If the trigger fires,** follow the vendor guide rather than inventing an
approach. Four requirements that are easy to miss:

1. **Use ids, not indices.** `unstable_useThreadMessageIds()` returns ids with
   stable array identity across content-only updates, paired with
   `ThreadPrimitive.Unstable_MessageById`. The index-based
   `ThreadPrimitive.MessageByIndex` is *"more fragile when messages are inserted,
   removed, reordered, or when a virtual row briefly outlives the item it was
   created for."*
2. **Group per user turn**, not per message, so the virtualizer gets stable,
   meaningfully sized items.
3. **Padding spacers, not absolute positioning** — render items in normal flow
   inside a spacer div whose `paddingTop`/`paddingBottom` represent unmounted
   regions. This keeps `position: sticky` and kit styling working and lets
   `measureElement` record real heights.
4. **Own the scroll container.** Do not use `ThreadPrimitive.Viewport`: its
   auto-scroll assumes every message is mounted, and its resize-driven re-pin
   *"can fight the virtualizer's measurement adjustments."* Three pieces replace
   it — a `ResizeObserver` auto-follow with a sticky flag, a measurement guard via
   a custom `scrollToFn`, and a `useLayoutEffect` run-start jump on
   `s.thread.isRunning`.

**Two caveats to weigh honestly.** The API is flagged experimental and *"may
change in any release"* — against the `AGENTS.md:81-85` dependency freeze, that
is a genuine risk, not a footnote. And it is an architectural change that
interacts with `ScrollPill` (`ChatWindow.tsx:34, :170`), which depends on current
viewport behaviour. Per `AGENTS.md:204-207` this requires an ADR in
`docs/decisions.md` before implementation, not a checklist tick.

**A library choice already settled.** `virtua` is a dependency and is already
used for the logs list (`LogsPanel.tsx:14, :899`). Do **not** add `react-virtuoso`
or `@tanstack/react-virtual` — a second virtualizer violates
`development-rules.md` §7 and `AGENTS.md:184-189` ("no framework
multiplication"). Use `virtua` unless the vendor guide's `measureElement`/
`padding`-spacer requirements turn out to need an API `virtua` lacks, in which
case that is an ADR.

### 5.5 Rendering cost is already budgeted — do not re-add these

Three caps exist, are configuration-driven per `AGENTS.md:215-221`, and are
tested. Leave them alone:

| Cap | Value | Location |
|---|---|---|
| `diffPreviewMaxLines` | 2,000 | `config/tools.ts:326` |
| `diffPreviewMaxChars` | 256 KB | `config/tools.ts:318` |
| Syntax-fence budget | via `BoundedSyntaxHighlighter` | `code-budget.tsx` |

`patch-to-diffs.ts:32` destructures the two diff caps and renders its own
`diffRowsOmitted` marker. `ChatWindow.tsx:576-587` documents a real subtlety worth
preserving: the `diff` branch deliberately does **not** pass through
`BoundedSyntaxHighlighter`, because bounding it twice would produce two omission
markers and cut an already-cut payload. Any new code-fence path must be bounded —
that is what made this branch the one unbounded path when it was found.

### 5.6 `<Activity>` for hidden surfaces (React 19.2)

`<Activity>` renders hidden content in the background at lower priority, and
unlike `display: none` it **destroys Effects and cleans up active subscriptions**
while hidden, then restores state on reveal.

TBAi has two obvious candidates: `features/chat/state/chatTabs.ts` (open/active
tabs) and the Direct ↔ Code mode switch. It is also the most likely reason the
old masterlist's "suppress permission card flashes during view toggles" symptom
would need a dedicated store — an effect that keeps running while a surface is
hidden is exactly what `<Activity>` stops.

Evaluate it as a replacement for a suppression mechanism before building one.
Adopting it is a dependency-boundary question, so: ADR first.

### 5.7 Transitions and deferred values

- **`useTransition`** when you have the `set` function for the state being
  updated. Per React's caveat, you cannot wrap an update in a transition otherwise.
- **`useDeferredValue`** when the expensive work depends on a value you do not
  own — a prop, or a value from a store or custom hook. It re-renders at lower
  priority and "catches up" automatically.

Both are for work that is *interruptible*. Neither helps a synchronous cost that
must complete regardless, and neither is a substitute for §5.4.

---

## 6. Streaming and render smoothness

### 6.1 Batch on animation frames, and skip empty frames

Tokens arrive at unpredictable intervals from independent async callbacks.
React's automatic batching does **not** collapse them: it batches updates within
one event handler or microtask, not twenty independent callbacks firing at
unpredictable times. At 30 tokens/second that is up to 30 renders per second, and
each render diffs the message list and all its children.

Measured, at 30 tokens/sec:

| | per-token `setState` | rAF-batched |
|---|---|---|
| renders/sec | 28–30 | 12–16 |
| avg commit | 18 ms | 3 ms |
| avg commit @ 80 tok/s | 52 ms (long tasks, visible jank) | 5 ms |

The key detail is that the batcher is driven by **`requestAnimationFrame`, and it
returns early when the buffer is empty.** A fixed-interval timer fires on schedule
whether or not anything arrived, spending a render on nothing — which is why
"batch every 16 ms" is the wrong instruction and "batch per frame, skipping empty
ones" is the right one.

```ts
// web/src/lib/raf-buffer.ts
/**
 * Coalesces high-frequency stream chunks into at most one update per frame.
 *
 * Why a frame and not a timer: a fixed interval fires on schedule even when the
 * buffer is empty, spending a render on nothing. This arms at most one frame at
 * a time and returns early if there is nothing pending, so commit count tracks
 * frames that actually carry new content.
 */
export function createRafBuffer<T>(flush: (value: T) => void) {
  let pending: T;
  let hasPending = false;
  let frame = 0;

  const onFrame = () => {
    frame = 0;
    if (!hasPending) return;
    hasPending = false;
    flush(pending);
  };

  return {
    push(value: T) {
      pending = value;
      hasPending = true;
      if (frame === 0) frame = requestAnimationFrame(onFrame);
    },
    dispose() {
      if (frame !== 0) cancelAnimationFrame(frame);
      frame = 0;
      hasPending = false;
    },
  };
}
```

**This is a guideline, not an instruction to rewrite the transport.** The
streaming path is `assistant-stream` plus the assistant-ui runtime, and
`AGENTS.md:81-85` freezes the assistant-ui train. Before adding a buffer, confirm
the render-per-chunk actually happens in TBAi code rather than inside frozen
library code — if it is in the library, the fix belongs upstream and the local
lever is §6.2 instead.

### 6.2 Do not parse Markdown on every token

Re-parsing Markdown for every arriving token costs **40–60% of render time** in
long conversations. The fix is not incremental Markdown parsing, which is
genuinely hard and not worth the complexity:

> **While streaming:** render plain text. **On completion:** run the Markdown
> pipeline once.

This is why `BoundedSyntaxHighlighter` (§5.5) matters as much as it does — a
highlighter must not run per token on a partially-written fence. Any new renderer
added to the `MarkdownText` component map in `ChatWindow.tsx:395-403` inherits
this obligation.

### 6.3 No unbounded buffers

A client-side stream buffer must have a bound. A slow consumer plus an unbounded
accumulator is a memory leak that only shows up in a long session, which is
exactly how this app is used. `B9` exists to catch it.

The same applies server-side: a detached run's bytes belong in the durable store
(`chat_streams` / `chat_stream_chunks`), not in an in-process array that grows for
the life of the server.

### 6.4 Backpressure

If the consumer is slower than the producer, something has to give. The
durable-stream design already bounds the server side — 24 h default TTL, sliding
expiry refreshed on every append *and* on settlement, hourly `unref`'d cleanup
tick with `DEFAULT_CLEANUP_BATCH = 200` hard-capped at 1000, and a boot-time tick
so rows expired while closed are reclaimed at startup.

Preserve those properties. In particular, cleanup failures are logged and
swallowed by design: *"retention bookkeeping must not take the server down."*

---

## 7. Backend and Bun runtime

### 7.1 Invariants that are already correct — do not regress

| Property | Where |
|---|---|
| Native `bun:sqlite` driver | `src/db/index.ts:1` |
| `streamText` zero-buffer piping to the response | `src/routes/chat.ts` |
| Prepared statements, not string-built SQL | throughout `src/db` |
| Validation at the boundary, Zod | `src/lib/validation.ts` |
| Managed `opencode serve` process owned in one place | `src/services/opencode/serverManager.ts` |

### 7.2 Synchronous I/O: banned in request paths, required in tool paths

This section previously claimed the `tools.ts` handlers were a defect. **They are
not, and the earlier claim was wrong.** The correction is recorded here because
"make the tool handlers async" is the obvious next wrong move.

**Tool handlers are synchronous by contract, and must stay that way.**
`runRead`/`runWrite`/`runEdit` return plain objects, not promises, and the read at
`:238` and the write at `:244` in `runEdit` must not be interleavable. Keeping
them synchronous makes a read-modify-write atomic with respect to the event loop,
so a client abort or a concurrent run cannot land between the read and the write.
Making them `async` would *introduce* the race. A tool call is a discrete
filesystem operation on a bounded file, and the model invokes them sequentially —
the event-loop cost is not the concern; the atomicity is.

The `node:fs` calls in `tools.ts` are therefore correct as written. Do not
"modernise" them.

**Correct pattern for large reads — copy this, not the reverse.**
`src/routes/index.ts:247-276`:

```ts
// resources/web folder. Files stream via Bun.file().stream() so a large asset
// ...
return new Response(Bun.file(filePath).stream(), { headers });
```

Streaming means the bytes never fully materialise in memory. `configDocument.ts`
uses `Bun.file()` / `Bun.write()` for the same reason.

**Genuine finding — bound the read, not the result.** `runRead`
(`src/services/tools.ts:205-226`) reads the entire file at `:210`, splits it at
`:211`, and only applies `MAX_READ_BYTES` at `:215`. The cap is applied *after*
the allocation, so peak memory is roughly 3× the file size (file string, lines
array, joined string). The same "bound it after the fact" mistake that
`ChatWindow.tsx:576-587` documents for diff previews. Stat the size first, or
stream to the cap, so an oversized file is never fully resident.

**Genuine finding — log file reads.** `src/routes/logs.ts:277` reads a whole
rotated log file synchronously (`TBAI_LOG_MAX_MB` defaults to 5) and then
`toString()`s it at `:282`, so roughly 10 MB of synchronous work plus 10 MB of
allocation, stalling every other in-flight request. This is a route handler, not a
tool, so the tool-path exemption does not apply — it should read async.

**Acceptable elsewhere:** `existsSync`/`statSync` guards in
`src/routes/folders.ts:119-123` and `readdirSync` in `workspace.ts:263, :324` are
metadata-sized and fast. Module-init, migration, and maintenance use is always
fine (`db/index.ts:13`).

**Rule:** blocking I/O is a defect in a *route handler*; it is correct in a *tool
handler* and in *lifecycle* code. The distinction is request-vs-contract, not
library-vs-stdlib.

### 7.3 Known open findings

Recorded from the read-only audit in `TBAiPERFORMANCEAUDIT.md`, which is
exhaustive over source but **unmeasured** — every item is structural inference.
Severity is provisional until profiled. Each is a real defect, not a task.

| Severity | Where | Issue |
|---|---|---|
| medium | `src/db/index.ts:354` | `memories` is the only growable table with **no index at all**. Three queries read it and two have no `LIMIT`. |
| medium | `src/services/storage/index.ts:234-239` | Search `OR`s two `LIKE '%…%'` branches with the FTS branch instead of sequencing them, so FTS is not a fast path. |
| medium | `src/context/memory/provider.ts:69` | Hot path on every memory-enabled request: `ORDER BY created_at DESC, id ASC LIMIT 50` with no index, so SQLite scans and sorts the whole table before discarding. |
| low | `src/services/storage/index.ts:234-245, :252` | The same `where` string is reused for the `COUNT(*)`, doubling search cost. |
| low | `src/lib/logger.ts:753-757` | Log ring evicts with `splice(0, n)` — O(cap) on every push once warm, at the 5,000-entry default, on the path of every log call. |
| low | `src/services/opencode/routes/opencode.ts:559-583` | SSE parse buffer has no max size; an unterminated upstream frame grows the string unboundedly (2 bytes/char). |
| low | `src/services/chat-streams/sqliteResumableStore.ts:947-955` | Resume read does `.all()` with no `LIMIT`, then copies each chunk, so peak is ~2× stream size. The abort check cannot help — the load already happened. |

Two of these are worth calling out because they are the *same class* of mistake:

**`memories` has no index.** Every other growable table in `db/index.ts` has one
(`messages`, `conversations`, `scheduler_runs`, `chat_streams`, `folders`,
`compactions`, `todos`). `memories` is user-authored, grows without bound, and is
read on every Direct request. The `LIMIT 50` bounds the result, not the work.

**Search does not use FTS as a fast path.** The `EXISTS` subquery is correlated
and the leading `%` means `idx_messages_conv_content` cannot be used, so both
`LIKE` branches are evaluated for every candidate row — while `conv_fts` is fully
populated by triggers and would answer the query directly. The comment describes
these as a "LIKE fallback", but `OR` is not a fallback; it is additional mandatory
work.

**On the transcript finding.** The audit filed the unvirtualized transcript as
`medium` while also stating it is the one finding whose severity most needs
measurement. Those two positions conflict. Treat it as **low / unverified** until
profiled, and see §5.4 — the fix is ADR-level anyway.

### 7.4 Read once, at the boundary

`GET /api/providers` returns metadata plus `credentialConfigured` and never a key
or ciphertext (`development-rules.md` §3). That is both a security property and a
performance one: a list endpoint that must not decrypt anything cannot be slowed
down by decryption.

Keep new list endpoints on the same footing. If a route needs a secret to compute
its response, that is a design smell, not a caching opportunity — see §9.

### 7.5 Process reuse

The managed `opencode serve` child is owned exclusively by `serverManager.ts` and
is reused across interactions. Restart-thrash and orphan handling are already
covered and verified — `2026-09-17-lifecycle-hardening.md` records the `start()`
catch defect where a readiness timeout nulled `child`/`port`/`readyPromise`
without killing the child, plus live verification of exactly one managed child
across kill and shutdown cycles.

Do not add a second spawn path. `AGENTS.md:134-148` makes the OpenCode module the
only code permitted to talk to that process.

---

## 8. SQLite

### 8.1 The pragma baseline is set — do not remove any of it

`src/db/index.ts:18-51` sets seven pragmas at connection time:

| Pragma | Value | Line | Why |
|---|---|---|---|
| `journal_mode` | `WAL` | `:18` | readers never block the writer |
| `synchronous` | `NORMAL` | `:23` | skips per-commit fsync, stays corruption-safe |
| `cache_size` | `-65536` (64 MiB) | `:28` | hot pages stay in memory |
| `mmap_size` | 256 MiB | `:32` | reads bypass the page cache |
| `temp_store` | `MEMORY` | `:36` | sorts/GROUP BY do not spill to disk |
| `foreign_keys` | `ON` | `:43` | without it every `ON DELETE CASCADE` is decorative |
| `busy_timeout` | `5000` | `:51` | a second process retries instead of throwing `SQLITE_BUSY` |

This exceeds the commonly cited production baseline (`WAL` + `NORMAL` +
`foreign_keys` + `busy_timeout` + `cache_size`) by four pragmas. All seven are
load-bearing; each carries a comment explaining why.

Two notes for anyone tempted to change them:

- `foreign_keys` **must be set with no transaction open** — the pragma is a no-op
  inside one. The `conversations` rebuild at `:211-276` correctly flips it OFF
  around its own `BEGIN` and restores it in a `finally`.
- `busy_timeout` is **per-connection**, so reading it back post-hoc from another
  process proves nothing by design. The behavioural contention proof belongs in
  `tests/unit/db.test.ts`, which is where it is.

### 8.2 `PRAGMA optimize`, not periodic `VACUUM`

The old masterlist asked for "periodic VACUUM to reclaim unallocated pages". Do
not implement that. SQLite's own guidance for long-lived connections — which is
exactly what this is — is:

> "Applications that use long-lived database connections should run
> `PRAGMA optimize=0x10002;` when the connection is first opened, and then also
> run `PRAGMA optimize;` periodically, perhaps once per day or once per hour."

`PRAGMA optimize` is the supported way to keep query-planner statistics fresh.
Unconditional periodic `VACUUM` rewrites the whole database, takes an exclusive
lock for the duration, and on a live app causes exactly the stalls it was meant to
remove. If space reclamation is ever genuinely needed, the right shape is
`PRAGMA incremental_vacuum` or an explicit, operator-initiated `VACUUM` — not a
timer.

Two adjacent pragmas worth knowing about, to be evaluated with §2.3 rather than
added on faith:

- `wal_autocheckpoint` — defaults to 1000 pages. Raising it trades checkpoint
  frequency against WAL size.
- `journal_size_limit` — truncates the WAL file left behind after a checkpoint, so
  it does not persist at its high-water mark.

### 8.3 Indexes: one per proved query, with the plan recorded

Existing indexes are good and one is exemplary. `src/db/index.ts:394-397`:

```ts
// Composite index for repairSchedulerThreadChains: its correlated
// (conversation_id, order_seq) subquery sorts without this and degrades to a
// per-row scan (O(N²)) over scheduler threads).
sqlite.run("CREATE INDEX IF NOT EXISTS idx_messages_conv_seq ON messages(conversation_id, order_seq)");
```

That comment is the standard. An index records the plan observation that
justified it, so the next reader can tell whether the query still exists.

Rules:

- Run `EXPLAIN QUERY PLAN` before adding an index. If the plan is already index
  seek, the index is write overhead for nothing.
- `messages` also has a full-text sidecar: `conv_fts` (FTS5) with four triggers
  keeping it in sync and a one-time backfill (`db/index.ts:404-447`). Search goes
  through FTS, not `LIKE`. Do not add a redundant content index for search.
- Composite index column order follows the query's `WHERE` then `ORDER BY`, which
  is why `(conversation_id, order_seq)` and not the reverse.

### 8.4 Migrations stay additive and idempotent

The established patterns, all of which must be preserved:

- `addColumnIfNotExists(table, column, definition)` — `db/index.ts:190-195`
- `applyChatStreamsSchema` + `addChatStreamsColumnsIfMissing` — `db/index.ts:112-115`
- Partial unique index for nullable idempotency keys — `db/index.ts:319-323`
- Rebuilds wrapped in try/catch that log and continue, so **migration failure
  never blocks startup** (`db/index.ts:211-276`)

Two constraints from the code worth restating as rules:

- **Never drop user data in a migration.** `db/index.ts:325-336` drops old
  `messages` rows, and that is acceptable only because the old plain-text format
  is genuinely incompatible with the assistant-ui storage format. Irreversible
  deletion of real user history is not a migration technique.
- **`CREATE ... IF NOT EXISTS` everywhere**, so boot is idempotent. The app
  starts against a directory it did not create.

---

## 9. Caching and the vault

### 9.1 No decrypted secret is cached in memory

**This is a security rule that happens to also be a performance answer, and it is
the reason §9 exists.**

`src/services/credentials.ts:95-97` states the position:

> "Initialization is idempotent; after bootstrap we re-read the encrypted setting
> on every request so deletion/corruption cannot be hidden by an in-memory cache."

There is no decrypted-key cache in `CredentialStore`, and adding one would be a
regression. A cached decrypted DEK means a deleted or corrupted credential keeps
authenticating from a stale plaintext copy for the life of the process — which
defeats the point of storing it encrypted at rest, and defeats the ability to
revoke.

The old masterlist proposed exactly this cache, citing a `<0.5 ms` lookup target
that nobody measured. Do not reinstate it. If credential lookup ever shows up in
a profile, the correct fixes are a prepared statement and an index — not keeping
plaintext in memory.

### 9.2 Every other in-memory cache must be bounded

A `Map` or `Set` used as a cache is a defect unless it has all three:

1. **A bound** — max size, or TTL.
2. **An eviction rule** — and eviction must actually run, not just be declared.
3. **A lifecycle exit** — a clear path on the event that should invalidate it
   (session end, lock, shutdown, conversation delete).

```ts
// src/lib/bounded-cache.ts
/**
 * Fixed-capacity cache with per-entry TTL and least-recently-used eviction.
 *
 * Every in-memory cache in the backend is required to have a bound, an eviction
 * rule that runs, and a lifecycle exit. A bare `Map` is a leak until proven
 * otherwise.
 */
export class BoundedCache<K, V> {
  private readonly entries = new Map<K, { value: V; expiresAt: number }>();

  constructor(
    private readonly max: number,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {
    if (max < 1) throw new Error("BoundedCache requires max >= 1");
  }

  get(key: K): V | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= this.now()) {
      this.delete(key);
      return undefined;
    }
    // Re-insert to mark most-recently-used.
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit.value;
  }

  set(key: K, value: V): void {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  delete(key: K): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
```

The `now` parameter is injected so TTL behaviour is testable without fake timers
— which per `development-rules.md` §3 means this class ships with tests.

`B9` is the check that these bounds are actually sufficient. A long agent session
is the workload that finds the missing eviction.

### 9.3 Caches keyed by identity need a delete

The scheduler's in-memory timer map is a legitimate example of a bounded,
self-cleaning cache: SQLite is the source of truth and the map is an execution
cache (`AGENTS.md:116-118`). The pattern is correct — a cache that is
reconstructible from a durable store is much easier to reason about than one that
is not.

The failure mode to avoid is a cache keyed by a user-facing id with no delete
path, where deleting the row leaves the entry live for the life of the process.

---

## 10. Review anti-patterns

Reject a PR that introduces any of these without a recorded reason.

**Performance**
- A second library for a problem something already installed solves (a second
  virtualizer, a second markdown parser, a second diff renderer) — violates
  `development-rules.md` §7 and `AGENTS.md:184-189`.
- Per-token Markdown or syntax highlighting during streaming (§6.2).
- A fixed-interval token timer instead of a frame that skips empty buffers
  (§6.1).
- An unbounded `Map`/`Set` used as a cache (§9.2).
- A decrypted secret held in memory (§9.1).
- Synchronous filesystem I/O in a request or tool path (§7.2).
- A query inside a loop or `map` over rows — an N+1 (§2.3).
- An index with no plan observation behind it (§8.3).
- Raising `chunkSizeWarningLimit` to silence a size warning.

**Process**
- An optimisation with no measurement on either side (§0.1).
- A change to a measured-and-adequate subsystem with no new data (§0.3).
- A `"use no memo"` with no comment naming the reason (§5.3).
- An inline magic number where `AGENTS.md:215-221` requires a config constant —
  the render budgets in `config/tools.ts` are the pattern.
- Cargo-cult tuning: an optimisation whose premise has not been checked against
  how the code actually works. "Pre-compile Zod schemas" is the canonical example;
  Zod exposes no pre-compile API, and a schema hoisted to module scope is already
  constructed once at import.

---

## 11. Why the masterlist was retired

`performance-optimization-masterlist.md` was a list of 20 unchecked items. It was
audited against the implementation and the findings are recorded here so the same
proposals are not re-raised.

**Already implemented, filed as open:**

| Item | Reality |
|---|---|
| Mermaid lazy loading | `beautiful-mermaid` in its own 54 KB chunk |
| Lazy syntax highlighters | 179 Shiki grammar chunks, 2–20 KB each |
| Native `bun:sqlite` | `db/index.ts:1` |
| Zero-buffer streaming | `streamText` in `src/routes/chat.ts` |
| WAL mode | `db/index.ts:18` |
| Prepared statements | `.prepare` / `.query` throughout `src/db` |
| Database indexes | 10+ including the O(N²) fix at `:397`, plus FTS5 |
| Diff/syntax render caps | `config/tools.ts:318, :326`, `code-budget.tsx` — the masterlist cited these exact identifiers as if new |

**Wrong on the merits:**

- *"Use `react-virtuoso`"* — `virtua` is already a dependency and already used
  (`LogsPanel.tsx:14`). A second virtualizer violates the no-multiplication rule.
- *"Wrap `ChatMessage`/`ToolCard` in `React.memo`"* — assistant-ui owns message
  rendering and the train is frozen; `AGENTS.md:92` restricts `ChatWindow.tsx` to
  assistant-ui primitives. It is also superseded guidance now that React Compiler
  is stable (§5.2).
- *"16ms token batching"* — a fixed timer spends renders on empty buffers (§6.1),
  and the streaming path is in frozen library code (§6.1).
- *"Pre-compiled Zod schemas"* — not a Zod feature.

**Actively harmful:**

- *"Cache decrypted Data Encryption Keys in memory so API key lookups take
  `<0.5 ms`"* — reintroduces the in-memory cache that
  `credentials.ts:95-97` exists to prevent, in exchange for a latency target
  nobody measured.

**Silent no-op:**

- *"Stale permission guard via `stalePermissionsStore`"* — no such store exists.
  §5.6 records `<Activity>` as the thing to evaluate before building one.

The pattern across all of these: the list was written generically, and filing
generic advice as open TODOs in a project that has already measured its way
through most of them is how a real decision gets undone. That is the reason this
document is written as rules with triggers and citations instead.

---

## 12. Changing this document

Per `AGENTS.md:204-207`, propose a change in `docs/decisions.md` with the reason
and the alternatives considered, and read `docs/architectural-principles.md`
first. Performance rules that require a new dependency, a change to a frozen
train, or a change to a boundary named in `AGENTS.md:87-148` require an ADR even
when the performance argument is sound.

Two sections here are deliberately incomplete, and that is recorded rather than
hidden:

- **§1 budgets** carry `__X__` placeholders until a baseline run (§1.2).
- **§3.2** records that the backend tsconfig lacks `strict`, pending a sized
  change.
- **§5.2** records React Compiler as decided-not-adopted, pending a baseline to
  evaluate against.

A performance guideline with unfilled placeholders is still better than a
checklist with no rules, because the rules are what survive the author.

