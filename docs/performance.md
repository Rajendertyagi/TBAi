# Performance Guidelines

How to build software that stays fast. General practice, not a task list and not a
report on one codebase.

There are no checkboxes and no file names. Every rule here is written so it stays true
regardless of what the code looks like today. Where a rule depends on your application
being a specific shape, that shape is stated in the rule.

**Every rule is marked with how it applies:**

| Marker | Meaning |
|---|---|
| **Always** | Correct by default. Follow it while writing code. Costs nothing. |
| **Verify first** | Real, but the fix is expensive and may be unnecessary. Measure before committing to it. |

Most rules are **Always**. The **Verify first** ones are where teams lose weeks: a
plausible optimization that turns out not to matter, shipped anyway, carrying its own
regression risk for zero measured benefit.

---

## 1. Measure before you claim a bottleneck

**Always.** Distinguish two acts that look identical:

- **Optimizing** is cheap and often pointless. Fine to do speculatively.
- **Claiming something is a bottleneck** and restructuring code around that claim is
  destructive. It needs a measurement first.

The failure mode is not that nothing happened. It is that effort goes where it does not
matter while the actual slow path stays slow — and now you are maintaining changes with
no payoff, each carrying its own risk.

```ts
// Wrong: a claim with no number behind it.
const rows = allRows.filter((r) => matches(r, query)).slice(0, 20)

// Right: the cap is in the query, and the index serves the sort.
const rows = db
  .query("SELECT * FROM rows WHERE status = ? ORDER BY created_at DESC LIMIT 20")
  .all(status)
```

The second version is not only faster. It is *knowably* faster, which is what makes it
safe to maintain.

### What counts as a measurement

Something that produces a number you can compare before and after:

- A CPU profile showing which component and which prop caused a render
- A query plan showing a full table scan
- A timestamp spanning a real operation, not a synthetic guess
- A field metric from real users

"I felt it was slow" is not a measurement. "P95 latency went from 800 ms to 40 ms" is.

### When you may skip measuring

**Always** rules need no measurement. Indexing a column you sort by, setting image
dimensions, paginating a list — these are correct whatever the numbers say.

Measuring gates the expensive structural work: virtualizing a list, changing state
architecture, replacing a library. That is the whole scope of this section.

---

## 2. Budgets

**Always.** A budget is a number you check, not an aspiration.

### The industry metrics

These are Google's Core Web Vitals, and they are stable — published thresholds with an
annual change cadence and advance notice. Safe to quote long-term:

| Metric | Measures | Good | Needs work |
|---|---|---|---|
| **LCP** — Largest Contentful Paint | loading | ≤ 2.5 s | ≤ 4.0 s |
| **INP** — Interaction to Next Paint | responsiveness | ≤ 200 ms | ≤ 500 ms |
| **CLS** — Cumulative Layout Shift | visual stability | ≤ 0.1 | ≤ 0.25 |

A page passes when all three are good **at the 75th percentile**, not the average. A
fast average hides a slow minority.

**INP replaced FID in 2024.** FID measured input delay only. INP measures the full
lifecycle until the next paint. If you find FID in tooling or documentation, it is stale.

### INP is a field metric

It cannot be measured in a lab. There is no user, so there is no interaction to time.
Lighthouse reports TBT (Total Blocking Time) as a lab proxy — useful for catching
regressions before release, but it is not INP and does not replace it.

**If your software has no public user base, you cannot collect INP.** Do not let an
unreachable target stand in as a reason not to measure. Use a lab proxy and say plainly
which one you used.

### Desktop is not the web

Guidance written for the public web assumes constraints that do not apply to software
running on the user's own machine:

- **No network latency for local assets.** Bundle size costs milliseconds, not seconds.
  A megabyte from localhost is not a megabyte from a CDN.
- **HTTP caching barely applies.** No round trips, no CDN, no `Cache-Control` negotiation.
- **The machine is usually fast and idle.** Mobile throttling models are noise.
- **Sessions are long-lived.** Memory growth that a website hides behind a refresh stays
  visible. Leaks matter more here, not less.

Apply the principles, discard the numbers. A desktop app should still have explicit
budgets — they just measure different things.

### Set your own

Industry numbers are a starting point, not a fit. Define what your application promises
and check it in CI where possible:

- Bytes for the initial payload, split from the total
- Milliseconds for a keystroke to paint
- Milliseconds for a typical request end to end
- A ceiling on elements rendered at once

One enforced number beats five aspirational ones.

---

## 3. TypeScript and build configuration

**Always.** Compiler flags are the cheapest performance work available.

### `verbatimModuleSyntax`

Requires `import type` for type-only imports, and makes TypeScript's elision
reliable. Without it, TypeScript guesses which imports are types; when it guesses wrong,
dead imports survive into the shipped JavaScript.

```ts
// Wrong — ambiguous. The compiler may keep this at runtime.
import { User } from "./types"

// Right — unambiguous, and guaranteed removed.
import type { User } from "./types"
```

Expect to add `type` to some existing imports. That is the point: it surfaces places
where the intent was never written down.

### `strict`

Catches the largest class of production defects — undefined values reaching code that
assumed they could not be. Worth enabling on any codebase, and worth treating as its own
change with the compiler running throughout, because the error count is a measure of
accumulated unstated assumptions, not of effort.

### `noEmit`

Without an `outDir`, a bare `tsc` emits a compiled `.js` twin beside every source file.
Those accumulate silently, and compiled copies of test files get collected by test
runners as duplicate suites — inflating counts and causing failures that look random.
If nothing consumes emitted JavaScript, emit nothing.

### `build.target`

Set to the oldest runtime you actually support. Each target step removes a class of
polyfills and transpilation. Targets lower than your real floor cost bytes for
compatibility nobody needs.

### What not to do

Do not add compiler flags in the same change as a feature. Flag adoptions surface large
error counts, and mixing them makes it impossible to tell which edit caused which error.
One flag, one change.

---

## 4. Lazy loading and code splitting

**Always.** Ship what the user needs now; defer the rest.

### Two techniques, two problems

**Elimination** — never include it at all. Dev-only tools, unreachable branches,
compile-time-constant feature flags.

```ts
// Compiled away entirely in production. No chunk, no cost.
if (import.meta.env.DEV) {
  import("./devtools").then((m) => m.mount());
}
```

**Deferral** — include it, but load on demand. Routes the user may never visit.

The unit is the **route**, not the component. Splitting individual buttons produces
hundreds of tiny requests and makes the app slower.

### Split by what users actually visit

Ship the default surface eagerly — deferring it trades bytes for a slower first paint on
the route everyone sees first. Defer everything else.

Three things justify eager loading even when they could be deferred:

- The **default route's shell**. Everyone sees it.
- **Error boundaries.** A fallback that must itself be fetched cannot report the failure
  that stopped it.
- **Layout frames.** Keeping the chrome eager lets it paint while children stream in.

### Use the framework's mechanism

If your router has route-level lazy loading, use it. A hand-rolled wrapper around
`lazy()` — to add preloading, say — introduces a module to own and can break when the
framework's contract changes. Reach for a wrapper only when you need something the
framework does not provide.

### The trade you accept

Code splitting moves bytes out of the first load and adds a fetch on first navigation.
On a fast connection this is close to free. On a slow one, or on a route users hit
immediately, it can be a regression.

**Verify first:** measure entry-payload bytes before and after. A split that moved code
into a chunk still reachable from the entry chunk achieved nothing.

### `manualChunks` is a caching tool

Grouping vendor code into a stable chunk helps browsers keep using their cached copy
across deploys. It does **not** meaningfully reduce total bytes. Use it for cache
stability, not size, and do not expect it to fix a bundle-size problem.

---

## 5. Rendering

### Keep state small and local

The single most effective rendering optimization: put frequently-changing state in the
smallest component that needs it.

```tsx
// Bad — every keystroke re-renders the entire list and every row in it.
function Chat() {
  const [draft, setDraft] = useState("");
  return (
    <>
      <Input value={draft} onChange={(e) => setDraft(e.target.value)} />
      <MessageList />
    </>
  );
}

// Good — typing re-renders one input.
function Chat() {
  return (
    <>
      <Input />
      <MessageList />
    </>
  );
}
```

This costs nothing, needs no measurement, and is always correct.

### Most re-renders are caused by Effects, not missing memoization

Before adding memoization, check whether an Effect is the actual cause. React's
documentation states that most performance problems are *"chains of updates originating
from Effects that cause your components to render over and over."*

An Effect that sets state, and depends on state it sets, renders in a loop. Adding
`memo` to the components in that loop treats the symptom and leaves the loop running.

### Five ways to make memoization unnecessary

These are correct regardless of measurement, and should come first:

1. **Accept JSX as `children`.** When a component visually wraps others, taking them as
   children lets React skip re-rendering them when the wrapper's own state changes.
2. **Keep state local.** Do not lift transient state — form drafts, hover state — to a
   global store or a distant parent.
3. **Keep render logic pure.** If re-rendering produces a visual artifact, that is a
   bug in the component, not a missing memo.
4. **Avoid Effects that update state.** Ask whether the value can be derived during
   render instead.
5. **Remove unnecessary Effect dependencies.** Often simpler than memoizing: move an
   object or function inside the Effect, or outside the component.

### Memoize only what measurement justifies

Memoization trades clarity for render avoidance. It pays when a component re-renders
often with identical props **and** its render logic is expensive. If there is no
perceptible lag when it re-renders, `memo` is unnecessary.

Two situations where it is worthless:

- **Props are always different.** Passing an object or inline function means the
  component re-renders anyway. One always-new value defeats memoization for the whole
  component.
- **The component updates its own state or reads changing context.** `memo` only stops
  re-renders driven by *parent* re-renders.

Do not memoize because a function looks expensive. Profile before and after; if the
difference is below a frame, remove it.

**Verify first:** any memoization added to fix a felt slowness.

### Custom prop comparison is a trap

A second argument to `memo` replaces shallow equality with your own function. Two
hazards, both of which React's docs call out explicitly:

- **You must compare every prop, including functions.** Functions close over the
  parent's props and state. Returning `true` when a callback reference changed makes
  the component keep reading values from an earlier render — inside its handlers. The
  docs describe the resulting bugs as very confusing, because the code looks correct.
- **Deep equality can be slower than re-rendering.** Check that your comparison is
  genuinely cheaper than the render it replaces, in a production build. Deep checks on
  unbounded structures can freeze an application for seconds.

If props cannot be made stable, prefer restructuring over a custom comparator.

### React Compiler changes the calculation

With the compiler enabled, `React.memo` can be removed — the compiler inserts the same
guard automatically, caching the created JSX so an unchanged-prop child is not
re-rendered. Its coverage is broader than `memo`: it also memoizes intermediate values
and expensive computations inside components, closer to `memo` plus `useMemo`
throughout the tree.

This is not free adoption. The compiler:

- Requires a build step and a Babel plugin
- Cannot memoize across every boundary, especially into third-party libraries
- Requires `"use no memo"` at seams where automatic memoization is wrong
- Mutates a ref during render, which conflicts with libraries that do the same

If it is **not** enabled, hand-written memoization is still what you have. Document
which regime you are in, because advice differs completely between them — under the
compiler, hand-written `memo` is redundant; without it, it is the only tool available.

### Identity and re-renders

React compares props with `Object.is`, which is reference equality. Two objects with
identical contents are different references, so a freshly-built prop defeats
memoization every render.

Pass individual values rather than a whole object when you can — fewer identities to
stabilize:

```tsx
// Defeats memo — new object every render.
<Row data={{ id, name }} />

// Better — primitives compare by value.
<Row id={id} name={name} />

// When an object is required, stabilize it.
const data = useMemo(() => ({ id, name }), [id, name]);
<Row data={data} />
```

### Virtualize unbounded lists — verify first

Anything that grows without limit and renders every row — transcripts, logs, search
results — eventually costs more than constant. Virtualization renders only what is
visible.

**Verify first**, because:

- It is real architectural work, not a drop-in
- It breaks scroll-anchoring, find-in-page, and accessibility expectations
- CSS containment often already handles the common cases adequately

Virtualize when a measurement shows the long case is slow. Confirm the cause is row
count before investing — it is often one expensive row type repeated, and fixing that
is far cheaper than virtualization.

### Contain what repeats

Two CSS properties reduce work for repeated content, and both are free:

```css
/* Skip layout and paint for off-screen content. */
.message {
  content-visibility: auto;
  contain-intrinsic-size: auto 80px; /* reserve space to avoid scrollbar jumps */
}
```

`contain-intrinsic-size` matters: without a size estimate, skipped content collapses
and the scrollbar jumps.

### Animate only compositor properties

`transform` and `opacity` are handled by the compositor. `width`, `height`, `top`,
`margin`, and `padding` force layout on every frame.

---

## 6. Streaming and updating

### Batch updates per frame, skipping empty ones

Events arriving from independent async callbacks at unpredictable intervals are not
coalesced by automatic batching. At 30 events per second that is 30 renders per second,
each diffing the whole tree.

```ts
const queue: Update[] = [];
let scheduled = false;

function enqueue(update: Update) {
  queue.push(update);
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    if (queue.length === 0) return; // nothing arrived — skip the render
    const batch = queue.splice(0);
    apply(batch);
  });
}
```

Two details make the difference:

- **Return early when the buffer is empty.** A fixed-interval timer spends renders on
  nothing, which is why "update every 16 ms" is the wrong instruction.
- **Reset the scheduled flag before applying.** Otherwise a throw inside `apply` wedges
  the buffer permanently.

### Never parse expensive formats per event

Parsing is far costlier than appending a string. If a growing buffer is rendered as
markup, parse on a throttle and append raw text between parses.

### Keep unbounded growth impossible

Any buffer accumulating from an external source needs a cap, even if you believe the
source is well-behaved. The belief is what fails.

```ts
if (buffer.length > MAX_BUFFER_BYTES) {
  // Discard and resynchronize on the next delimiter rather than growing.
  buffer = "";
  resync = true;
}
```

Apply the cap before allocation when possible. Reading a whole file to check its size,
then discarding, still paid the memory cost.

### Separate live presentation from durable record

Live updates are transient. The stored result is authoritative. When you bound or drop
live updates, nothing is lost — the record survives.

This is what makes aggressive caps safe, and it is the reason to prefer dropping a
duplicate presentation over persisting one.

### Handle backpressure

Streams regulate themselves: a consumer that is busy signals upstream to slow down.
`desiredSize` on a stream controller reports capacity.

**Ignore backpressure and you get unbounded memory** — a fast producer fills a queue no
one is draining. On a network stream from an untrusted or misbehaving peer, this is a
denial-of-service vector, not merely a performance problem.

---

## 7. Data access

### Index what you query by

The single most common cause of slow data access is a missing index on a hot path. An
unindexed query is a full table scan plus a sort, per request, growing with your data.

```sql
-- Every request sorts the whole table to return 20 rows.
SELECT * FROM events WHERE status = ? ORDER BY created_at DESC LIMIT 20;

-- The index serves both the filter and the sort.
CREATE INDEX idx_events_status_created ON events(status, created_at DESC);
```

Column order in a composite index matters: equality columns first, then the sort column.
An index on `(created_at, status)` cannot serve a query filtering by `status` and
sorting by `created_at`.

### A leading wildcard cannot use an index

```sql
WHERE name LIKE '%foo%'   -- full scan, always
WHERE name LIKE 'foo%'    -- index-usable
```

If you need substring search, use a full-text index. If you also need a fallback for
short or partial queries, **sequence them** — run the cheap indexed query first and only
fall back if it returns too little:

```sql
-- Wrong: OR forces a scan of every branch, including when the fast path would match.
SELECT * FROM docs WHERE body LIKE ? OR id IN (SELECT id FROM docs_fts WHERE docs_fts MATCH ?)

-- Right: try the fast path, fall back only when it under-delivers.
```

An `OR` with a non-indexable branch disables the index for the whole statement. The
common bug is writing the union when the intent was a fallback.

### Paginate everything unbounded

No request should return every row because the table has every row.

```ts
// Fetched 100,000 rows to show 20.
db.query("SELECT * FROM messages").all().slice(0, 20)

// Did 20 rows of work.
db.query("SELECT * FROM messages ORDER BY id LIMIT ? OFFSET ?").all(20, offset)
```

Fetching then slicing is the mistake that hides inside otherwise reasonable code.

### Select only what you use

`SELECT *` transfers, parses, and hydrates columns nobody reads. It also makes the
query fragile: adding a column changes its cost silently.

### Batch writes in transactions

Each statement outside a transaction is its own durable operation. Wrapping related
writes in one transaction turns many syncs into one.

```ts
db.transaction(() => {
  db.run("INSERT INTO a ...");
  db.run("INSERT INTO b ...");
  db.run("UPDATE c ...");
})();
```

---

## 8. Database engine and concurrency

### Use WAL mode for read-heavy apps with concurrent access

Write-ahead logging lets readers and writers proceed simultaneously. Under a rollback
journal, a writer blocks every reader.

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
```

`NORMAL` with WAL skips the per-commit fsync; checkpointing becomes the only sync point.
The cost: a power loss can lose recent transactions. The benefit: writes become
substantially faster.

This pairing is the standard configuration for a local application database.

### WAL is not free — know the failure modes

Documented consequences worth knowing before relying on it:

- **All connections must be on the same host.** WAL needs shared memory; it does not
  work across a network filesystem.
- **One writer at a time.** WAL allows many readers but only one concurrent writer.
- **The WAL file can grow without bound** if checkpoints are starved by continuous
  readers. Long-running readers prevent checkpoints completing.
- **Read performance degrades as the WAL grows.** Checkpoint regularly.
- **`SQLITE_BUSY` is still possible** in WAL mode in specific situations, including
  recovery after a crash and connection teardown.

Set a `busy_timeout` so contention waits rather than failing immediately.

### Check the engine version against known defects

SQLite has shipped rare but serious correctness bugs in WAL mode. One example: a
data race where two connections checkpointing and committing simultaneously could leave
committed transactions uncheckpointed and corrupt the database. It affected versions
3.7.0 through 3.51.2 and was fixed in 3.51.3.

The SQLite team rates its real-world likelihood as no higher than SSD malfunctions or
cosmic-ray strikes — rare, but not to be dismissed. The practice that generalizes:

**Know your engine version and check it against published defects when concurrency
matters.** A version floor is a concrete rule; "keep dependencies updated" is not.

### Run `EXPLAIN QUERY PLAN` before believing an index helps

It reports `SCAN` where a full table scan happens and `SEARCH` where an index is used. A
composite index in the wrong column order, or a query whose shape defeats the index,
shows up here as an obvious scan. This is the cheapest verification available and it
costs one statement.

---

## 9. Caching

### Cache reads, not writes

Most applications are read-heavy. Caching the result of an expensive read and
invalidating on write is usually correct. Caching writes means handling coherence, which
is where the bugs live.

### Prefer a real cache to a memo

A per-process map is invisible to other processes, unbounded unless you bound it, and
returns stale data after a restart. For anything shared or long-lived, use a cache that
knows how to expire and invalidate.

### Bound every cache

A cache without a maximum size is a memory leak with a helpful name. Set both a count
limit and, where entries vary in size, a total-size limit.

### Make eviction cheap

When a bounded collection is full, the cheapest eviction is a cursor that resets on
compaction:

```ts
// Bad: O(n) on every insert once the buffer is warm.
if (buffer.length > limit) buffer.splice(0, buffer.length - limit);

// Good: O(1). Compact only occasionally.
this.slots[this.head] = entry;
if (++this.head >= capacity) this.head = 0;
```

If you must splice, splice once per full cycle rather than once per write.

### Invalidate by dependency, not by guess

Cache entries that depend on other data need to state what they depend on. Ad-hoc
invalidation — clearing everything when something changes — is correct but throws away
the cache's value under any write-heavy load.

---

## 10. Memory and lifecycle

### Leaks matter more in long-lived software

A website hides leaks behind page refreshes. Desktop applications and long sessions do
not. Growth over hours is the symptom; the causes are almost always:

- Subscriptions, listeners, or intervals never removed
- Timers not cleared on unmount or abort
- Closures capturing large objects longer than intended
- Caches and buffers that grow without bound
- Aborted requests whose cleanup never runs

### Tie every resource to the thing that owns it

```ts
useEffect(() => {
  const controller = new AbortController();
  const id = setInterval(poll, 1000);
  source.addEventListener("message", onMessage);

  return () => {
    controller.abort();          // stops in-flight work
    clearInterval(id);           // stops the timer
    source.removeEventListener("message", onMessage);
  };
}, []);
```

The pattern: anything acquired in setup is released in cleanup. This also makes
aborts reliable, because the abort signal cancels requests rather than leaving them to
complete into nothing.

### Bound what grows without being asked

Ring buffers, log retention, and message history are the usual culprits. Every one
needs a limit, and the limit belongs in configuration rather than inline in the code.

---

## 11. Server and runtime

### Do less work per request

The cheapest optimization is not doing something. Remove the work rather than making it
faster — eliminate a round trip, drop a redundant query, skip a serialization step.

### Bound everything a request can cause

A request must not be able to trigger unbounded work. Cap page sizes, body sizes,
upload sizes, concurrent operations, and time spent. `SQLITE_BUSY`-style failures are
often symptoms of an unbounded request arriving while others are in flight.

### Never let a network buffer grow without limit

Accumulating a stream into a string until a delimiter arrives is the standard
implementation and the standard bug: a peer that never sends the delimiter consumes
memory without limit. Cap, discard, and resynchronize.

### Keep crash-visible logging synchronous

If a log line must survive a crash, write it before the process can die. Batching for
throughput is right for ordinary logging and wrong for the last few lines before exit.

---

## 12. Anti-patterns

Things that look like performance work and are not.

**Optimizing measured-and-adequate code.** Adds risk, adds maintenance, delivers
nothing measurable. A change with no measurable effect and a real chance of breaking
something is a net loss.

**Micro-optimizations nobody measured.** Replacing a readable loop with bit tricks for
nanoseconds nobody will notice.

**Caching without a reason.** Every cache is a correctness liability: stale reads,
invalidation bugs, memory growth. Do not add one to avoid a query you could index.

**Memoizing everything.** Uniform application hides which paths are actually hot and
adds a dependency array to maintain on every render.

**Splitting a bundle without measuring.** Splitting code that was reachable from the
entry chunk moves nothing.

**Buffering to smooth over latency.** Defers the problem and adds memory pressure.

**Shipping optimizations as a bundle.** Three unrelated performance changes in one
commit makes each one unmeasurable and each one a suspect when something breaks.

---

## 13. Review

Before merging a performance change, be able to answer:

1. **What number was this fixing?** If none, why is it needed now?
2. **What is the number now?** If unknown, was the change worth its risk?
3. **What breaks if this is wrong?** Every cache, every cap, every memo has a failure
   mode.
4. **Does this belong alone in its change?** Mixed changes cannot be measured or
   reverted independently.

A performance change with no measured before-and-after is a refactor. That is sometimes
the right thing to make — but call it what it is.

---

## Sources

- Google, *Web Vitals* — `web.dev/articles/vitals`. INP replaced FID as a stable Core
  Web Vital in 2024. Stable thresholds change at most annually, with notice.
- Google, *Interaction to Next Paint* — `web.dev/articles/inp`
- MDN, *Streams API concepts* — backpressure, `desiredSize`, queuing strategies.
  `developer.mozilla.org/docs/Web/API/Streams_API/Concepts`
- SQLite, *Write-Ahead Logging* — `sqlite.org/wal.html`. Documents the WAL-reset
  corruption defect, versions 3.7.0–3.51.2, fixed in 3.51.3.
- SQLite, *Query Planning* — `sqlite.org/queryplanner.html`
- React, *memo* — `react.dev/reference/react/memo`. Verified source for §5: the
  Effects-not-memoization claim, the five principles, `Object.is` prop comparison, the
  custom-comparator pitfalls, and Compiler interaction.
- React, *You Might Not Need an Effect* — `react.dev/learn/you-might-not-need-an-effect`

Sections written from working knowledge rather than a fetched source, and worth
re-checking when the material is available: memory and lifecycle patterns (§10),
caching depth (§9), runtime-specific tuning (§11), and desktop-versus-web
characteristics (§2). The claims there are long-established, but they are not cited
above because they were not verified against a current source.

## Related documents

| Document | Contains |
|---|---|
| `performance-baseline.md` | Historical measurements and the reasoning behind past decisions. Not guidance. |
| `TBAiPERFORMANCEAUDIT.md` | Point-in-time source survey. Superseded. |
| `development-rules.md` | Architecture and process rules. |
| `AGENTS.md` | Project-wide agent rules. |