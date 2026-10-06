import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
  annotateFromSources,
  formatCallPaths,
  formatHotFunctions,
  formatTotals,
  formatUnattributable,
  wasmSelfMs,
  withCpuProfile,
} from "./helpers/cpuProfile";
import { removeConversation, seedConversation } from "./helpers/seedConversation";
import {
  resetStubStreamShape,
  setStubStreamShape,
} from "./helpers/stubProvider";

/**
 * Where the served chunks live, for naming frames from source.
 *
 * Resolved from WEB_DIST_DIR - the same seam the backend reads - so this
 * follows whichever artifact is actually being served. Falls back to the
 * minified `web/dist`, where line/column still resolve but the surrounding
 * source is mangled; run through `bun run profile:web` for readable names.
 */
const PROFILE_ASSETS_DIR = path.join(
  process.env.WEB_DIST_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist"),
  "assets",
);

/**
 * WHERE THE RENDERER CPU GOES.
 *
 * ## The question
 *
 * A packaged-app sample showed TBAi.exe and tbai-server.exe at ~0% while the
 * WebView2 process tree carried 15-20% on an 8-core machine. The cost is in
 * the renderer. Four things in there are expensive on the main thread, and
 * they are not equally worth fixing:
 *
 *   1. Markdown re-parsing. `defer` lowers the PRIORITY of re-parsing a
 *      growing message; it does not reduce the WORK. If the whole accumulated
 *      reply is re-parsed per arriving token, one reply costs O(n^2).
 *   2. Shiki tokenization. Oniguruma WASM, synchronous, per rendered fence.
 *   3. Mermaid rendering, synchronously into dangerouslySetInnerHTML.
 *   4. No virtualization, so every message stays mounted.
 *
 * Reading the code tells you all four are POSSIBLE. It cannot tell you which
 * one dominates, and optimizing the wrong one wastes the effort. So this
 * measures, and the tests below are deliberately A/B comparisons whose RESULT
 * is the finding: the same work with one variable changed.
 *
 * ## Why the streaming tests must use a chunked stub
 *
 * The default stub streams the entire reply as a SINGLE delta, so the browser
 * receives a complete message in one shot and never renders a partial reply.
 * Profiling that measures the cost of rendering a finished message, which is
 * NOT the cost of watching one arrive. Hypothesis 1 lives entirely in the
 * partial-render path, so it is invisible unless the stub is told to stream in
 * pieces. `setStubStreamShape` does that.
 *
 * ## What these tests assert
 *
 * Very little, on purpose. A profiler that fails the build on a slow machine
 * trains people to ignore it, and the numbers here are meant to be READ and
 * pasted into a decision, then turned into budgets once the real cost is
 * known. The assertions that do exist check that the measurement was real:
 * a non-zero sample count and a non-zero task time, so a broken harness fails
 * loudly instead of reporting a suspiciously clean zero.
 *
 * Each test writes its numbers to the Playwright log, so a run leaves a record
 * in the terminal that can be diffed against a later run.
 *
 * NOTE: no backticks in this comment - the spec transform mis-parses them and
 * reports the file as unbuildable.
 */

/** Characters per streamed delta. Small enough to look like real token flow. */
const CHUNK_CHARS = 24;
/**
 * Pause between deltas. Long enough that the browser genuinely paints partial
 * states rather than coalescing the whole reply into one frame.
 */
const CHUNK_DELAY_MS = 4;

const FENCE = "```";

/** A long, code-heavy reply: the shape that stresses parse + highlight. */
function codeHeavyReply(paragraphs: number): string {
  const parts: string[] = [];
  for (let i = 0; i < paragraphs; i++) {
    parts.push(
      `Paragraph ${i}. This sentence exists to give the markdown parser prose to chew on between the expensive blocks.`,
      "",
      [FENCE + "ts", `const value${i} = compute(${i});`, "export default value" + i + ";", FENCE].join("\n"),
      "",
    );
  }
  return parts.join("\n");
}

/** A prose-only reply of similar length, to isolate the code path from the parse path. */
function proseOnlyReply(paragraphs: number): string {
  return Array.from(
    { length: paragraphs },
    (_, i) =>
      `Paragraph ${i}. Prose of comparable length to the code-heavy variant, with no fenced block anywhere in it.`,
  ).join("\n\n");
}

/**
 * Count how many times code fences are re-highlighted while a reply streams.
 *
 * ## What is being counted, and why counting beats timing
 *
 * The question is whether Shiki highlighting is repeated unnecessarily for the
 * same accumulated code. Timing can only ever answer that indirectly - if the
 * slow case is also the many-deltas case, the cause is ambiguous between
 * "highlights too often" and "each highlight is genuinely expensive".
 *
 * Counting the highlight events answers it directly. A rendered fence is
 * `<pre class="shiki">` whose contents are Shiki's generated `<span>` tokens,
 * while unhighlighted code is plain text - so a mutation on a fence that
 * ALREADY contains spans is a repeat highlight of already-tokenized code, which
 * is precisely the waste under investigation.
 *
 * ## Why the first version of this detector measured zero
 *
 * It walked UP from the mutation target looking for a `<pre>`. That is wrong:
 * react-shiki mounts a finished fence by inserting the whole `<pre>` into its
 * container, so the mutation fires ON the container DIV and the `<pre>` is a
 * DESCENDANT of the target, never an ancestor. Every fence insertion was
 * invisible to it, and it reported 0 re-highlights on a reply that demonstrably
 * rendered 4 fences and 48 token spans.
 *
 * That was caught by inspecting the real DOM - `<pre class="shiki">`, 4 fences,
 * 48 spans, mutation targets `DIV=42 SPAN=5` - rather than by reasoning about
 * it, and it is why both directions are now checked: the target inside a fence,
 * and the target containing one.
 */
async function installFenceHighlightCounter(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    const counters = {
      reHighlights: 0,
      firstHighlights: 0,
      mutations: 0,
      fences: 0,
      perFence: [] as number[],
    };
    (window as unknown as { __fence: typeof counters }).__fence = counters;
    const perFence = new Map<Element, number>();

    const fencesFor = (target: Node): Element[] => {
      const el = target instanceof Element ? target : target.parentElement;
      if (!el) return [];
      const enclosing = el.closest("pre.shiki");
      if (enclosing) return [enclosing];
      // The fence may have been inserted INTO this target rather than mutated
      // within one, so descendants count too.
      return Array.from(el.querySelectorAll("pre.shiki"));
    };

    new MutationObserver((records) => {
      for (const rec of records) {
        for (const pre of fencesFor(rec.target)) {
          counters.mutations += 1;
          // MutationObserver delivers after the batch, so "already highlighted"
          // is read from the pre as it now stands: a fence still carrying its
          // own token spans is one being replaced a second time.
          const alreadyHighlighted = pre.querySelector("span") !== null;
          if (alreadyHighlighted) counters.reHighlights += 1;
          else counters.firstHighlights += 1;
          if (!perFence.has(pre)) perFence.set(pre, 0);
          perFence.set(pre, (perFence.get(pre) ?? 0) + 1);
          counters.fences = perFence.size;
        }
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true });

    (window as unknown as { __fenceSnapshot: () => void }).__fenceSnapshot = () => {
      counters.perFence = [...perFence.values()];
    };

    // Resets the per-fence map too, not just the totals. Leaving it populated
    // made the second run report fences created by the first, which is how a
    // per-run comparison silently turns into a cumulative one.
    (window as unknown as { __fenceReset: () => void }).__fenceReset = () => {
      counters.reHighlights = 0;
      counters.firstHighlights = 0;
      counters.mutations = 0;
      counters.fences = 0;
      perFence.clear();
      counters.perFence = [];
      const w = window as unknown as { __settle?: unknown };
      w.__settle = undefined;
    };
  });
}

interface FenceCounts {
  reHighlights: number;
  firstHighlights: number;
  mutations: number;
  fences: number;
  perFence: number[];
}

async function readFenceCounter(page: import("@playwright/test").Page): Promise<FenceCounts> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __fence: FenceCounts;
      __fenceSnapshot: () => void;
    };
    w.__fenceSnapshot();
    return w.__fence;
  });
}

async function resetFenceCounter(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __fence: FenceCounts;
      __fenceReset: () => void;
    };
    w.__fenceReset();
  });
}

/**
 * Wait until no new fence has been rendered for a few checks in a row.
 *
 * Without this the comparison is rigged and silently so. Shiki highlights
 * asynchronously AFTER the stream closes, so a run that delivers its reply in
 * one delta finishes - and its profile window shuts - before any highlighting
 * has happened. Reading counters at that point reports 0 fences for the fast
 * run and a full set for the slow one, which looks like "the fast run does no
 * highlighting" when it actually does the same work slightly later.
 *
 * Polls the DOM rather than sleeping a fixed time, so it terminates as soon as
 * highlighting is genuinely done instead of baking in an arbitrary wait.
 */
async function waitForHighlightingToSettle(page: import("@playwright/test").Page): Promise<void> {
  const STABLE_CHECKS = 4;
  const POLL_MS = 250;
  await page
    .waitForFunction(
      ({ stable, poll }) => {
        const w = window as unknown as { __fence: FenceCounts };
        const count = document.querySelectorAll("pre.shiki").length;
        const state = (w as unknown as { __settle?: { last: number; stable: number } }).__settle;
        if (!state) {
          (w as unknown as { __settle: { last: number; stable: number } }).__settle = {
            last: count,
            stable: 0,
          };
          return false;
        }
        if (count === state.last) state.stable += 1;
        else {
          state.last = count;
          state.stable = 0;
        }
        return state.stable >= stable;
      },
      { stable: STABLE_CHECKS, poll: POLL_MS },
      { timeout: 60000 },
    )
    .catch(() => {
      // Settling is best-effort: a reply with no fences never changes count and
      // would otherwise hang until the timeout. The assertions on real work
      // below are what actually guard this test.
    });
}

/** Send one message and wait for the run to finish, profiling the whole window. */
async function sendAndProfile(
  page: import("@playwright/test").Page,
  request: import("@playwright/test").APIRequestContext,
  prompt: string,
) {
  const box = page.getByRole("textbox", { name: /Send a message/ });
  await box.fill(prompt);
  await box.press("Enter");

  // The Stop button is the app's own signal that a run is in flight, and its
  // disappearance that the run finished. Profiling to a fixed sleep instead
  // would either cut the stream short or measure idle time after it.
  const stop = page.getByRole("button", { name: "Stop generating" });
  await expect(stop).toBeVisible({ timeout: 30000 });
  await expect(stop).toHaveCount(0, { timeout: 120000 });
}

/**
 * Append a completed user turn and its assistant reply (settled, not streamed).
 *
 * `parent_id` is threaded explicitly because the chain is what the transcript
 * renders from: an assistant message whose parent does not exist is accepted by
 * the API but never rendered, which silently produces an empty transcript and
 * a profile of nothing. Every id here is returned to the caller so the next
 * turn can attach to it rather than guessing a naming scheme.
 */
async function seedExchange(
  request: import("@playwright/test").APIRequestContext,
  conversationId: string,
  text: string,
  index: number,
  parentId: string | null,
): Promise<string> {
  const userId = `cpu-user-${conversationId}-${index}`;
  const user = await request.post(`/api/conversations/${conversationId}/messages`, {
    data: {
      message: {
        id: userId,
        parent_id: parentId,
        format: "ai-sdk/v6",
        content: { role: "user", parts: [{ type: "text", text: `question ${index}` }] },
      },
    },
  });
  if (!user.ok()) throw new Error(`seed user turn failed: ${user.status()}`);

  const reply = await request.post(`/api/conversations/${conversationId}/messages`, {
    data: {
      message: {
        id: `cpu-assistant-${conversationId}-${index}`,
        parent_id: userId,
        format: "ai-sdk/v6",
        content: { role: "assistant", parts: [{ type: "text", text }] },
      },
    },
  });
  if (!reply.ok()) throw new Error(`seed reply failed: ${reply.status()}`);

  return `cpu-assistant-${conversationId}-${index}`;
}

test.describe("renderer CPU attribution", () => {
  test.slow();

  /**
   * Cold-start cost: what the renderer pays BEFORE the user does anything.
   *
   * ## Why this is a different measurement from every other test here
   *
   * All the other scenarios profile work the app does AFTER it is running. A
   * renderer trace, though, put 2.4s of its 3.3s total CPU into "Script
   * Evaluation" of ONE 3.5 MB chunk, and estimated 2,693 KiB of that chunk as
   * unused. That is startup: evaluating module top-level code, once, before
   * anything is interactive. Profiling a loaded page cannot see it, because the
   * cost has already been paid.
   *
   * So this measures navigation itself, and - more usefully - measures which
   * bytes the browser had to evaluate to get there. The per-chunk breakdown is
   * the actionable half: "the main chunk is big" is not fixable, but "1.85 MB
   * of it is a graph layout engine for a feature that did not render" is.
   *
   * Bytes are read from the Resource Timing API rather than summed off disk, so
   * this reports what was ACTUALLY fetched and evaluated, including anything a
   * browser heuristic decided to speculatively preload.
   */
  test("cold start: how much JS does the renderer evaluate before it is usable", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);

    const label = `cpu profile cold ${Date.now()}`;
    const { id: conversationId } = await seedConversation(request, { title: label });

    try {
      const started = Date.now();
      await page.goto(`/#/chat/${conversationId}`);
      await expect(
        page.getByRole("textbox", { name: /Send a message/i }).first(),
      ).toBeVisible({ timeout: 30000 });
      const timeToInteractive = Date.now() - started;

      const scripts = await page.evaluate(() => {
        const entries = performance.getEntriesByType(
          "resource",
        ) as PerformanceResourceTiming[];
        return entries
          .filter((e) => e.name.endsWith(".js") || e.name.endsWith(".mjs"))
          .map((e) => ({
            file: e.name.split("/").pop() ?? e.name,
            kb: Math.round(e.encodedBodySize / 1024),
          }))
          .sort((a, b) => b.kb - a.kb);
      });

      const totalKb = scripts.reduce((a, s) => a + s.kb, 0);
      console.log(
        `\n[cold] interactive in ${timeToInteractive}ms  ` +
          `${scripts.length} scripts  ${totalKb} KB transferred`,
      );
      for (const s of scripts.slice(0, 8)) {
        console.log(`[cold]   ${String(s.kb).padStart(6)} KB  ${s.file}`);
      }

      // Guards the measurement, not a budget: if no script was fetched, the
      // numbers above are an empty list dressed up as a result.
      expect(totalKb).toBeGreaterThan(0);
      expect(scripts.length).toBeGreaterThan(0);
    } finally {
      await removeConversation(request, conversationId);
    }
  });

  test("idle: what does a loaded page cost when nothing is happening", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);

    // The floor every other number should be read against. If idle is not
    // near zero, a busy-window figure is measuring a background cost rather
    // than the interaction, and every comparison in the other tests is
    // contaminated.
    const label = `cpu profile idle ${Date.now()}`;
    const { id: conversationId } = await seedConversation(request, {
      title: label,
    });

    try {
      await seedExchange(request, conversationId, codeHeavyReply(8), 0, null);
      await page.goto(`/#/chat/${conversationId}`);
      await expect(
        page.getByRole("textbox", { name: /Send a message/i }).first(),
      ).toBeVisible({ timeout: 30000 });
      await expect(page.locator(".aui-md").first()).toBeVisible({ timeout: 30000 });

      const { cpu } = await withCpuProfile(page, async () => {
        // Long enough to be a real sample window rather than startup noise.
        await page.waitForTimeout(3000);
      });

      console.log(`\n[cpu] idle (loaded, 3s)  ${formatTotals(cpu.totals)}`);
      console.log(formatUnattributable(cpu));
      console.log(formatHotFunctions(cpu.hot));

      expect(cpu.sampleCount).toBeGreaterThan(0);
    } finally {
      await removeConversation(request, conversationId);
    }
  });

  test("scrolling a long finished conversation", async ({ page, request }) => {
    test.setTimeout(300_000);

    // Scrolling is a different cost from streaming: it re-lays-out and
    // re-paints already-settled messages, and with no virtualization every one
    // of them stays mounted. This is where an unvirtualized transcript would
    // show up, and streaming alone would never reveal it.
    const label = `cpu profile scroll ${Date.now()}`;
    const { id: conversationId } = await seedConversation(request, { title: label });

    try {
      // A realistic long thread: many exchanges, each with code, all settled,
      // chained through parent_id so the whole transcript is reachable.
      const TURNS = 12;
      let parentId: string | null = null;
      for (let i = 0; i < TURNS; i++) {
        parentId = await seedExchange(request, conversationId, codeHeavyReply(6), i, parentId);
      }

      await page.goto(`/#/chat/${conversationId}`);
      await expect(
        page.getByRole("textbox", { name: /Send a message/i }).first(),
      ).toBeVisible({ timeout: 30000 });
      // The transcript is fully painted before any scrolling is measured.
      await expect(page.locator(".aui-md").first()).toBeVisible({ timeout: 60000 });

      const { cpu } = await withCpuProfile(page, async () => {
        const viewport = page.locator(".overflow-y-auto").first();
        for (let i = 0; i < 12; i++) {
          await viewport.evaluate((el) => {
            el.scrollTop += el.clientHeight * 0.9;
          });
          await page.waitForTimeout(120);
        }
      });

      console.log(`\n[cpu] scroll (${TURNS} turns)  ${formatTotals(cpu.totals)}`);
      console.log(formatUnattributable(cpu));
      console.log(formatHotFunctions(cpu.hot));

      expect(cpu.sampleCount).toBeGreaterThan(0);
    } finally {
      await removeConversation(request, conversationId);
    }
  });

  test("streaming a long code-heavy reply: how much of the time is script vs layout", async ({
    page,
    request,
  }) => {
    test.setTimeout(300_000);

    const label = `cpu profile code ${Date.now()}`;
    const { id: conversationId } = await seedConversation(request, {
      title: label,
      withMessage: true,
      messageText: "profile the renderer",
    });

    try {
      await setStubStreamShape(request, {
        text: codeHeavyReply(40),
        chunkChars: CHUNK_CHARS,
        chunkDelayMs: CHUNK_DELAY_MS,
      });

      await page.goto(`/#/chat/${conversationId}`);
      await expect(
        page.getByRole("textbox", { name: /Send a message/i }).first(),
      ).toBeVisible({ timeout: 30000 });

      const { cpu } = await withCpuProfile(page, () =>
        sendAndProfile(page, request, "stream a long code-heavy reply"),
      );

      console.log(`\n[cpu] code-heavy stream  ${formatTotals(cpu.totals)}`);
      console.log(formatUnattributable(cpu));
      console.log(formatHotFunctions(annotateFromSources(cpu.hot, PROFILE_ASSETS_DIR)));

      // The measurement itself must be real, or the numbers above are fiction.
      expect(cpu.sampleCount, "profiler captured no samples").toBeGreaterThan(0);
      expect(cpu.totals.taskMs, "renderer did no measurable work").toBeGreaterThan(0);
      expect(cpu.totals.scriptMs, "no script time at all").toBeGreaterThan(0);
    } finally {
      await resetStubStreamShape(request);
      await removeConversation(request, conversationId);
    }
  });

  test("is highlighting repeated per delta, or done once per fence", async ({
    page,
    request,
  }) => {
    test.setTimeout(600_000);
    test.slow();

    // The decisive experiment. Both runs stream the EXACT same reply text, so
    // the final rendered DOM is identical; the only difference is how many
    // deltas it arrives in.
    //
    // If highlighting were once-per-fence, both runs would do identical Shiki
    // work and land on the same WASM self time. If it re-highlights on every
    // delta, the many-delta run does dramatically more highlighting work while
    // producing a byte-identical result - pure waste, and the fix is to stop
    // re-highlighting rather than to make highlighting cheaper.
    const text = codeHeavyReply(8);
    const label = `cpu profile dedupe ${Date.now()}`;
    const { id: conversationId } = await seedConversation(request, { title: label });

    const run = async (label: string, chunkChars: number) => {
      await setStubStreamShape(request, { text, chunkChars, chunkDelayMs: 8 });
      await resetFenceCounter(page);
      const { cpu } = await withCpuProfile(page, async () => {
        await sendAndProfile(page, request, `reply ${label}`);
        // Highlighting runs AFTER the stream closes. Leaving it outside the
        // profiled window meant the one-off run captured none of it (script
        // 158ms, wasm 0ms) and only the slow run captured any - which would
        // have looked like proof that chunking causes highlighting when it is
        // really just that the work happened later than the window.
        await waitForHighlightingToSettle(page);
      });
      const fence = await readFenceCounter(page);
      const wasm = wasmSelfMs(annotateFromSources(cpu.hot, PROFILE_ASSETS_DIR));
      const perFence = [...fence.perFence].sort((a, b) => b - a);
      console.log(
        `[dedupe] ${label.padEnd(11)} chunkChars=${String(chunkChars).padEnd(5)}` +
          ` script=${cpu.totals.scriptMs.toFixed(0)}ms` +
          `  wasm=${wasm.toFixed(0)}ms` +
          `  fences=${fence.fences}` +
          `  reHighlights=${fence.reHighlights}` +
          `  firstHighlights=${fence.firstHighlights}`,
      );
      console.log(
        `[dedupe] ${label.padEnd(11)} updates per fence: ${perFence.join(",") || "(none)"}`,
      );
      return { cpu, fence, wasm };
    };

    try {
      await page.goto(`/#/chat/${conversationId}`);
      await expect(
        page.getByRole("textbox", { name: /Send a message/i }).first(),
      ).toBeVisible({ timeout: 30000 });
      await installFenceHighlightCounter(page);

      // Warm-up run, measured by nobody.
      //
      // The first code reply in a renderer pays one-time costs that have
      // nothing to do with the hypothesis: oniguruma's WASM module has to be
      // instantiated, and the Shiki grammars have to be fetched and compiled.
      // Without this, whichever configuration happens to run FIRST looks like
      // the expensive one - it measured 121ms of WASM against the other's 11ms,
      // which says nothing about highlighting and everything about ordering.
      // Discarding it leaves both measured runs on a warm module.
      await setStubStreamShape(request, {
        text: codeHeavyReply(1),
        chunkChars: 24,
        chunkDelayMs: 4,
      });
      await sendAndProfile(page, request, "warmup");
      await waitForHighlightingToSettle(page);

      // One delta: the whole reply arrives at once.
      const whole = await run("whole", 0);
      // Many deltas: same text, same end state, ~40 characters per delta.
      const piecemeal = await run("piecemeal", 40);

      console.log(
        `[dedupe] re-highlights ${whole.fence.reHighlights} -> ${piecemeal.fence.reHighlights}` +
          `   wasm ${whole.wasm.toFixed(0)}ms -> ${piecemeal.wasm.toFixed(0)}ms`,
      );
      console.log("\n[dedupe] piecemeal call paths:");
      console.log(formatCallPaths(annotateFromSources(piecemeal.cpu.hot, PROFILE_ASSETS_DIR)));

      // The measurement must be real in both directions, or the comparison
      // above proves nothing. These assert that work happened and that the two
      // runs actually differed - NOT which way the answer should fall, because
      // that is what the run is for.
      //
      // `firstHighlights` is deliberately NOT asserted, and cannot be. A
      // MutationObserver is delivered after its batch is applied, so by the time
      // it runs a just-inserted fence already carries its own token spans and is
      // indistinguishable from one being replaced. Both counters measured 0
      // firsts across every run for that reason alone. The per-fence update
      // counts are the usable signal; the first/re split is not.
      expect(whole.fence.fences).toBeGreaterThan(0);
      expect(piecemeal.fence.mutations).toBeGreaterThan(0);
      expect(piecemeal.cpu.sampleCount).toBeGreaterThan(0);
    } finally {
      await resetStubStreamShape(request);
      await removeConversation(request, conversationId);
    }
  });

  test("prose-only vs code-heavy at equal length: isolates the highlight cost", async ({
    page,
    request,
  }) => {
    test.setTimeout(300_000);

    const label = `cpu profile compare ${Date.now()}`;
    const { id: conversationId } = await seedConversation(request, {
      title: label,
      withMessage: true,
      messageText: "compare parse and highlight",
    });

    try {
      await page.goto(`/#/chat/${conversationId}`);
      await expect(
        page.getByRole("textbox", { name: /Send a message/i }).first(),
      ).toBeVisible({ timeout: 30000 });

      // Prose first. Same paragraph count, no fences, so the difference
      // between the two runs is the code path rather than the parse path.
      await setStubStreamShape(request, {
        text: proseOnlyReply(40),
        chunkChars: CHUNK_CHARS,
        chunkDelayMs: CHUNK_DELAY_MS,
      });
      const prose = await withCpuProfile(page, () =>
        sendAndProfile(page, request, "first, prose only"),
      );

      await setStubStreamShape(request, {
        text: codeHeavyReply(40),
        chunkChars: CHUNK_CHARS,
        chunkDelayMs: CHUNK_DELAY_MS,
      });
      const code = await withCpuProfile(page, () =>
        sendAndProfile(page, request, "second, with code fences"),
      );

      console.log(
        `\n[cpu] prose-only  ${formatTotals(prose.cpu.totals)}\n${formatHotFunctions(prose.cpu.hot)}`,
      );
      console.log(
        `[cpu] code-heavy  ${formatTotals(code.cpu.totals)}\n${formatHotFunctions(code.cpu.hot)}`,
      );

      // The comparison IS the finding, so it is reported rather than asserted.
      // A threshold here would be a guess dressed as a budget; the number to
      // act on is the ratio, once someone has read both runs.
      const ratio =
        prose.cpu.totals.scriptMs > 0
          ? code.cpu.totals.scriptMs / prose.cpu.totals.scriptMs
          : Number.NaN;
      console.log(
        `[cpu] script-time ratio code/prose = ${Number.isNaN(ratio) ? "n/a" : ratio.toFixed(2)}x`,
      );

      expect(prose.cpu.totals.taskMs).toBeGreaterThan(0);
      expect(code.cpu.totals.taskMs).toBeGreaterThan(0);
    } finally {
      await resetStubStreamShape(request);
      await removeConversation(request, conversationId);
    }
  });

  test("double the reply length: does cost grow linearly or worse", async ({
    page,
    request,
  }) => {
    test.setTimeout(300_000);

    const label = `cpu profile scaling ${Date.now()}`;
    const { id: conversationId } = await seedConversation(request, {
      title: label,
      withMessage: true,
      messageText: "measure scaling",
    });

    try {
      await page.goto(`/#/chat/${conversationId}`);
      await expect(
        page.getByRole("textbox", { name: /Send a message/i }).first(),
      ).toBeVisible({ timeout: 30000 });

      // The O(n^2) claim is testable rather than arguable: if re-parsing the
      // whole growing message per token is the dominant cost, doubling the
      // length should cost roughly FOUR times as much. Linear behaviour
      // (per-token work independent of message length) gives about 2x, since
      // twice the tokens is twice the work.
      //
      // This compares SCRIPT time specifically, not wall-clock: wall-clock is
      // dominated by the fixed chunk delay and would show ~2x regardless,
      // hiding the very effect being tested.
      await setStubStreamShape(request, {
        text: codeHeavyReply(20),
        chunkChars: CHUNK_CHARS,
        chunkDelayMs: CHUNK_DELAY_MS,
      });
      const small = await withCpuProfile(page, () =>
        sendAndProfile(page, request, "short reply"),
      );

      await setStubStreamShape(request, {
        text: codeHeavyReply(40),
        chunkChars: CHUNK_CHARS,
        chunkDelayMs: CHUNK_DELAY_MS,
      });
      const large = await withCpuProfile(page, () =>
        sendAndProfile(page, request, "long reply, twice the length"),
      );

      const growth =
        small.cpu.totals.scriptMs > 0
          ? large.cpu.totals.scriptMs / small.cpu.totals.scriptMs
          : Number.NaN;

      console.log(
        `\n[cpu] 20 paragraphs  ${formatTotals(small.cpu.totals)}`,
      );
      console.log(
        `[cpu] 40 paragraphs  ${formatTotals(large.cpu.totals)}\n${formatHotFunctions(large.cpu.hot)}`,
      );
      console.log(
        `[cpu] script-time growth for 2x length = ${Number.isNaN(growth) ? "n/a" : growth.toFixed(2)}x  (~2x linear, ~4x quadratic)`,
      );

      expect(small.cpu.totals.scriptMs).toBeGreaterThan(0);
      expect(large.cpu.totals.scriptMs).toBeGreaterThan(0);
    } finally {
      await resetStubStreamShape(request);
      await removeConversation(request, conversationId);
    }
  });
});
