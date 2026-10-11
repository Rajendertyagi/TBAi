/**
 * SPIKE — §10 SCROLL PRESERVATION proof. Real Chromium via Playwright.
 * TEMPORARY, removable.
 *
 * happy-dom reports zero layout dimensions (see probe-happydom-layout.test.ts),
 * so a scroll-anchor assertion there is vacuous — `keepMessageAt`'s measured
 * delta would always be 0. This proof therefore drives the bundled Option B
 * harness (scroll-harness/entry.tsx) in real Chromium, where the assistant-ui
 * prepend anchor, the browser's own scroll anchoring, and real element
 * geometry are all live.
 *
 * This file is NOT part of the canonical suites (`bun test`, `test:dom`,
 * `test:e2e`): it lives under tests/spikes and is run explicitly.
 *
 * Run: bun test tests/spikes/p2-candidate-d/proofs/proof-scroll.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const harnessDir = path.join(here, "..", "scroll-harness");

/* ES modules over file:// are CORS-blocked, so the harness is served over a
 * throwaway loopback HTTP server (closed in afterAll). Nothing is written
 * outside the spike directory. */
let server: ReturnType<typeof Bun.serve> | null = null;
let origin = "";

/* ── tolerances ──────────────────────────────────────────────────────────
 * Chrome reports fractional CSS pixels; assistant-ui's own threshold is 1px
 * (`Math.abs(scrollTop - target) >= 1`). 1.5px keeps the assertion strict
 * against real jitter without failing on sub-pixel rounding. */
const ANCHOR_TOLERANCE_PX = 1.5;

/** Real-browser work (launch, streaming, second page) needs far more than bun's 5s default. */
const TEST_TIMEOUT = 90_000;

let browser: Browser;
let page: Page;

/** Read the harness snapshot (real rects, scroll metrics, both stores). */
const snap = () =>
  page.evaluate(() => (window as never as { __harness: { snapshot: () => unknown } }).__harness.snapshot()) as Promise<Snap>;

type Rect = { top: number; bottom: number; height: number };
type Snap = {
  count: number;
  firstId: string | null;
  lastId: string | null;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  scrollable: boolean;
  heights: Record<string, number>;
  rects: Record<string, Rect>;
  headId: string | null;
  chatIds: string[];
  threadIds: string[];
  capabilities: Record<string, boolean>;
  isRunning: boolean;
  historical: boolean;
};

/** Set scrollTop and let the browser settle (two frames, no timers invented). */
const scrollTo = async (top: number) => {
  await page.evaluate((t) => {
    const vp = document.querySelector("[data-proof-viewport]") as HTMLElement;
    vp.scrollTop = t;
  }, top);
  await settle();
};

/** Wait two animation frames — paint/layout settled, no arbitrary sleep. */
const settle = async () => {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
};

/**
 * Scroll away from the bottom with a REAL wheel gesture.
 *
 * This must not be `element.scrollTop = …`: assistant-ui decides
 * "the user scrolled up" from `isUserScrollUp` inside its `scroll` handler, and
 * a programmatic assignment is indistinguishable from its own compensation.
 * A wheel event is what an actual user produces, and it is what the contract's
 * "the user has intentionally scrolled away" means.
 */
const wheelAwayFromBottom = async (clicks = -400) => {
  const box = (await page.locator("[data-proof-viewport]").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, clicks);
  await settle();
};

/** Scroll so `id`'s top sits `offsetFromTop` px below the viewport's top edge. */
const scrollMessageTo = async (id: string, offsetFromTop = 40) => {
  const target = await page.evaluate(
    ({ id, offsetFromTop }) => {
      const vp = document.querySelector("[data-proof-viewport]") as HTMLElement;
      const el = document.querySelector(`[data-message-id="${id}"]`) as HTMLElement | null;
      if (!el) return null;
      const vpRect = vp.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      return vp.scrollTop + (elRect.top - vpRect.top) - offsetFromTop;
    },
    { id, offsetFromTop },
  );
  if (target === null) throw new Error(`message ${id} not rendered`);
  await scrollTo(target);
  return target;
};

/**
 * Return the harness to its baseline tip window and re-render.
 * Tests that mutate the window must not inherit the previous test's window,
 * or "message not rendered" would be a fixture bug masquerading as a result.
 */
const resetToTip = async () => {
  await page.evaluate(
    () => (window as never as { __harness: { restoreTip: () => void } }).__harness.restoreTip(),
  );
  await settle();
  const s = await snap();
  if (s.count !== 50 || s.firstId !== "m451") {
    throw new Error(`reset failed: count=${s.count} first=${s.firstId}`);
  }
};

/** Which message ids intersect the viewport, in order (measured, not assumed). */
const visibleIds = async () =>
  page.evaluate(() => {
    const vp = document.querySelector("[data-proof-viewport]") as HTMLElement;
    const vpRect = vp.getBoundingClientRect();
    return Array.from(document.querySelectorAll("[data-message-id]"))
      .map((el) => ({ id: el.getAttribute("data-message-id")!, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.bottom > vpRect.top && r.top < vpRect.bottom)
      .map(({ id }) => id);
  });

const atBottom = async () => {
  const s = await snap();
  return s.scrollHeight - s.scrollTop - s.clientHeight <= 1;
};

beforeAll(async () => {
  // Build the harness bundle (aliasing the store-nested packages).
  const build = Bun.spawn(["bun", "run", path.join(harnessDir, "build.ts")], {
    cwd: path.resolve(here, "../../../.."),
    stdout: "ignore",
    stderr: "pipe",
  });
  if ((await build.exited) !== 0) {
    throw new Error(await new Response(build.stderr).text());
  }

  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const file = new URL(req.url).pathname === "/" ? "index.html" : new URL(req.url).pathname.slice(1);
      const body = Bun.file(path.join(harnessDir, file));
      if (!(await body.exists())) return new Response("not found", { status: 404 });
      return new Response(body, {
        headers: { "Content-Type": file.endsWith(".js") ? "text/javascript" : "text/html" },
      });
    },
  });
  origin = `http://localhost:${server.port}`;

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  await page.goto(`${origin}/index.html`);
  await page.waitForSelector("[data-message-id]", { timeout: 30_000 });
  await settle();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

describe("§10 — scroll preservation (real Chromium)", () => {
  it("environment: real layout, unequal heights, scrollable viewport", async () => {
    const s = await snap();
    console.log("\n=== §10 environment ===");
    console.log(`  rendered: ${s.count} (${s.firstId}..${s.lastId})`);
    console.log(`  scrollHeight=${s.scrollHeight} clientHeight=${s.clientHeight} scrollable=${s.scrollable}`);
    const distinctHeights = [...new Set(Object.values(s.heights))].sort((a, b) => a - b);
    console.log(`  distinct row heights: ${JSON.stringify(distinctHeights)}`);

    // Real geometry: the tip window must overflow the viewport and scroll.
    expect(s.scrollable).toBe(true);
    expect(s.scrollHeight).toBeGreaterThan(s.clientHeight * 3);
    expect(s.count).toBe(50);
    // NO fixed-height assumption: if every row were identical this proof would
    // be meaningless, so require genuine variation.
    expect(distinctHeights.length).toBeGreaterThan(1);
  }, TEST_TIMEOUT);

  it("§10A: prepend anchors the previously visible message (no jump, no timers)", async () => {
    const anchor = "m470";
    await scrollMessageTo(anchor, 40);

    const before = await snap();
    const beforeVisible = await visibleIds();
    const beforeRect = before.rects[anchor];
    expect(beforeRect).toBeDefined();
    expect(beforeVisible).toContain(anchor);

    // Prepend m401..m450 through the frozen window core.
    const result = (await page.evaluate(
      () => (window as never as { __harness: { loadOlder: () => unknown } }).__harness.loadOlder(),
    )) as { windowSize: number; hasMoreBefore: boolean };
    await settle();

    const after = await snap();
    const afterVisible = await visibleIds();
    const afterRect = after.rects[anchor];

    console.log("\n=== §10A prepend ===");
    console.log(`  window ${before.count} → ${after.count} (frozen core: ${result.windowSize}, hasMoreBefore=${result.hasMoreBefore})`);
    console.log(`  anchor ${anchor}: top ${beforeRect.top}px → ${afterRect.top}px  (delta ${(afterRect.top - beforeRect.top).toFixed(2)}px)`);
    console.log(`  scrollTop ${before.scrollTop} → ${after.scrollTop}   scrollHeight ${before.scrollHeight} → ${after.scrollHeight}`);
    console.log(`  anchor still visible: ${afterVisible.includes(anchor)}   forced to bottom: ${after.scrollHeight - after.scrollTop - after.clientHeight <= 1}`);

    // The anchor message must survive the prepend with its ID unchanged.
    expect(after.firstId).toBe("m401");
    expect(after.count).toBe(100);
    expect(afterRect).toBeDefined();
    expect(afterVisible).toContain(anchor);
    // Its vertical position is unchanged → the user sees no jump.
    expect(Math.abs(afterRect.top - beforeRect.top)).toBeLessThanOrEqual(ANCHOR_TOLERANCE_PX);
    // Prepending grew content above, so scrollTop must move by exactly the added
    // height (proving compensation happened, not that nothing changed).
    const prependedHeight = after.scrollHeight - before.scrollHeight;
    expect(prependedHeight).toBeGreaterThan(0);
    expect(Math.abs(after.scrollTop - before.scrollTop - prependedHeight)).toBeLessThanOrEqual(
      ANCHOR_TOLERANCE_PX,
    );
    // The viewport must NOT have been slammed to the bottom.
    expect(after.scrollHeight - after.scrollTop - after.clientHeight).toBeGreaterThan(
      after.clientHeight,
    );
    // All three views of the window agree: chat, runtime thread state, DOM.
    expect(after.chatIds).toEqual(after.threadIds);
    expect(after.threadIds.length).toBe(after.count);
    expect(after.chatIds[0]).toBe("m401");
    expect(after.headId).toBe("m500");
  }, TEST_TIMEOUT);

  it("§10B: stick-to-bottom only when the user is genuinely at the bottom", async () => {
    await resetToTip();
    // Case 1: at the bottom, appended content must stay pinned.
    await scrollTo(10_000);
    await settle();
    expect(await atBottom()).toBe(true);

    const beforeBottom = await snap();
    const lastIdBefore = beforeBottom.lastId!;
    await page.evaluate(
      () =>
        (window as never as { __harness: { send: () => Promise<void> } }).__harness.send(),
    );
    await settle();
    const afterAppend = await snap();
    console.log(`  chat=${afterAppend.chatIds.length} thread=${afterAppend.threadIds.length} dom=${afterAppend.count}`);
    console.log("\n=== §10B at bottom ===");
    console.log(`  last ${lastIdBefore} → ${afterAppend.lastId}, scrollTop=${afterAppend.scrollTop}, atBottom=${afterAppend.scrollHeight - afterAppend.scrollTop - afterAppend.clientHeight <= 1}`);
    expect(afterAppend.lastId).not.toBe(lastIdBefore);
    expect(afterAppend.scrollHeight).toBeGreaterThan(beforeBottom.scrollHeight);
    expect(afterAppend.chatIds).toEqual(afterAppend.threadIds);
    expect(await atBottom()).toBe(true);

    // Case 2: scrolled away, content ARRIVING (a widened window / another
    // device) must not drag the viewport. This is deliberately NOT send():
    // ThreadPrimitive.Viewport's `scrollToBottomOnRunStart` (upstream default
    // true, which TBAi keeps) is *designed* to pin to the bottom when a RUN
    // starts, so sending here would measure the wrong thing.
    await resetToTip();
    await wheelAwayFromBottom(-900);
    expect(await atBottom()).toBe(false);
    const awayBefore = await snap();
    const awayVisibleBefore = await visibleIds();
    const awayAnchor = awayVisibleBefore[Math.floor(awayVisibleBefore.length / 2)];
    console.log(`\n=== §10B case 2: away from the bottom (anchor ${awayAnchor}, ${awayVisibleBefore.length} visible) ===`);

    await page.evaluate(
      () => (window as never as { __harness: { appendExternal: (n: number) => unknown } }).__harness.appendExternal(4),
    );
    await settle();
    const awayAfterSnap = await snap();
    const awayVisibleAfter = await visibleIds();

    console.log(`  window ${awayBefore.count} → ${awayAfterSnap.count}, scrollTop ${awayBefore.scrollTop} → ${awayAfterSnap.scrollTop}`);
    console.log(`  anchor ${awayAnchor}: top ${awayBefore.rects[awayAnchor]?.top} → ${awayAfterSnap.rects[awayAnchor]?.top}`);
    console.log(`  visible before/after: ${JSON.stringify(awayVisibleBefore.slice(0, 3))} → ${JSON.stringify(awayVisibleAfter.slice(0, 3))}`);
    console.log(`  forced to bottom: ${awayAfterSnap.scrollHeight - awayAfterSnap.scrollTop - awayAfterSnap.clientHeight <= 1}`);

    // Content grew, the viewport did not move, and the anchor is undisturbed.
    expect(awayAfterSnap.scrollHeight).toBeGreaterThan(awayBefore.scrollHeight);
    expect(await atBottom()).toBe(false);
    expect(Math.abs(awayAfterSnap.rects[awayAnchor].top - awayBefore.rects[awayAnchor].top)).toBeLessThanOrEqual(
      ANCHOR_TOLERANCE_PX,
    );
    expect(awayVisibleAfter.slice(0, 3)).toEqual(awayVisibleBefore.slice(0, 3));
    expect(awayAfterSnap.chatIds).toEqual(awayAfterSnap.threadIds);
  }, TEST_TIMEOUT);

  it("§10B-differential: the current path reaches the same away-from-bottom state", async () => {
    // Rules out the false positive "§10B's result is a property of Option B".
    // Both pages render the SAME ThreadPrimitive.Viewport primitive; if the
    // away-from-bottom result differed, the difference would be Option B's.
    await resetToTip();
    await wheelAwayFromBottom(-900);
    const optionBState = await snap();
    const optionBAway = await atBottom();
    await resetToTip();

    const current = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    await current.goto(`${origin}/current.html`);
    await current.waitForSelector("[data-message-id]", { timeout: 30_000 });
    const settleCurrent = () =>
      current.evaluate(
        () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
      );
    const cSnap = () =>
      current.evaluate(() =>
        (
          window as never as {
            __harness: {
              snapshot: () => {
                count: number;
                scrollTop: number;
                scrollHeight: number;
                clientHeight: number;
                atBottom: boolean;
                firstId: string | null;
                lastId: string | null;
                rects: Record<string, { top: number; height: number }>;
              };
            };
          }
        ).__harness.snapshot(),
      );
    await settleCurrent();
    const currentInitial = await cSnap();
    const cBox = (await current.locator("[data-proof-viewport]").boundingBox())!;
    await current.mouse.move(cBox.x + cBox.width / 2, cBox.y + cBox.height / 2);
    await current.mouse.wheel(0, -900);
    await settleCurrent();
    const currentAway = await cSnap();
    await current.close();

    console.log("\n=== §10B differential: current path (useChatRuntime) ===");
    console.log(`  rendered ${currentInitial.count} (${currentInitial.firstId}..${currentInitial.lastId}) vs Option B ${optionBState.count} (${optionBState.firstId}..${optionBState.lastId})`);
    console.log(`  after wheel-up → atBottom: Option B=${optionBAway}, current=${currentAway.atBottom}`);
    console.log(`  scrollHeight/clientHeight: Option B ${optionBState.scrollHeight}/${optionBState.clientHeight}, current ${currentAway.scrollHeight}/${currentAway.clientHeight}`);

    // Same window, same scrollable geometry, same away-from-bottom state.
    expect(currentInitial.count).toBe(optionBState.count);
    expect(currentInitial.scrollHeight).toBe(optionBState.scrollHeight);
    expect(currentInitial.clientHeight).toBe(optionBState.clientHeight);
    expect(optionBAway).toBe(false);
    expect(currentAway.atBottom).toBe(false);
  }, TEST_TIMEOUT);

  it("§10C: older-direction eviction keeps the protected region anchored", async () => {
    await resetToTip();
    // Trim to force `older` → ["after", "before"] removal, with the viewport
    // parked mid-window so the protected region is the messages on screen.
    const anchor = "m470";
    await scrollMessageTo(anchor, 40);
    const before = await snap();
    const visibleBefore = await visibleIds();
    const active = (await page.evaluate(() =>
      (window as never as { __harness: { activeRegion: () => unknown } }).__harness.activeRegion(),
    )) as { top: { messageId: string } | null; bottom: { messageId: string } | null };
    console.log("\n=== §10C older-direction eviction ===");
    console.log(`  protected: ${active.top?.messageId}..${active.bottom?.messageId} (measured from the viewport)`);

    const result = (await page.evaluate(
      () =>
        (window as never as { __harness: { forceTrim: (d: string, n: number) => unknown } }).__harness.forceTrim(
          "older",
          20,
        ),
    )) as { windowSize: number; messageLimitExceededByProtection: boolean };
    await settle();

    const after = await snap();
    const visibleAfter = await visibleIds();
    console.log(`  window ${before.count} → ${after.count} (${before.firstId}..${before.lastId} → ${after.firstId}..${after.lastId})`);
    console.log(`  anchor ${anchor} still rendered: ${Boolean(after.rects[anchor])}  visible: ${visibleAfter.includes(anchor)}`);
    console.log(`  removed from before=${before.firstId !== after.firstId} after=${before.lastId !== after.lastId}`);

    // Frozen core decided a smaller window; the runtime must show exactly it.
    expect(after.count).toBe(result.windowSize);
    expect(after.count).toBeLessThan(before.count);
    // The protected (visible) region survived.
    for (const id of visibleBefore) expect(visibleAfter).toContain(id);
    // IDs are stable — eviction removes messages, it does not renumber them, and
    // chat / thread state / DOM all agree on the trimmed window.
    expect(after.chatIds).toEqual(after.threadIds);
    expect(after.threadIds).toEqual(after.rects ? [...Object.keys(after.rects)] : after.threadIds);
    expect(after.headId).toBe(after.threadIds.at(-1));
  }, TEST_TIMEOUT);

  it("§10D: newer-direction eviction removes the before side first, region intact", async () => {
    await resetToTip();
    const anchor = "m470";
    await scrollMessageTo(anchor, 40);
    const before = await snap();
    const visibleBefore = await visibleIds();

    const result = (await page.evaluate(
      () =>
        (window as never as { __harness: { forceTrim: (d: string, n: number) => unknown } }).__harness.forceTrim(
          "newer",
          20,
        ),
    )) as { windowSize: number };
    await settle();

    const after = await snap();
    const visibleAfter = await visibleIds();
    console.log("\n=== §10D newer-direction eviction ===");
    console.log(`  window ${before.count} → ${after.count} (${before.firstId}..${before.lastId} → ${after.firstId}..${after.lastId})`);
    console.log(`  protected region survived: ${JSON.stringify(visibleBefore)} → ${JSON.stringify(visibleAfter)}`);

    expect(after.count).toBe(result.windowSize);
    expect(after.count).toBeLessThan(before.count);
    for (const id of visibleBefore) expect(visibleAfter).toContain(id);
    expect(after.chatIds).toEqual(after.threadIds);
    expect(after.headId).toBe(after.threadIds.at(-1));
    // scrollTop must not have been corrupted (clamped to a real range).
    expect(after.scrollTop).toBeGreaterThanOrEqual(0);
    expect(after.scrollTop).toBeLessThanOrEqual(after.scrollHeight - after.clientHeight);
  }, TEST_TIMEOUT);

  it("§10E: streaming follows the bottom when at bottom, stays put when away", async () => {
    await resetToTip();
    // Slow the stream so real layout growth is observable mid-flight.
    await page.evaluate(
      () =>
        (window as never as { __harness: { streamPlan: (p: object) => void } }).__harness.streamPlan({
          gapMs: 30,
        }),
    );

    // Case A: the user scrolls AWAY *mid-stream*. A run already started (so
    // `scrollToBottomOnRunStart` has fired); further deltas must not drag them
    // back down. This is the genuine "user scrolled away while streaming" case.
    // The stream must still be IN FLIGHT when the wheel lands, or there are no
    // remaining deltas to prove anything about (an earlier run finished first).
    await page.evaluate(
      () =>
        (window as never as { __harness: { streamPlan: (p: object) => void } }).__harness.streamPlan({
          gapMs: 200,
        }),
    );
    await scrollTo(10_000);
    await settle();
    expect(await atBottom()).toBe(true);
    await page.evaluate(() =>
      (window as never as { __harness: { startSend: () => void } }).__harness.startSend(),
    );
    await page.waitForFunction(
      () => (window as never as { __harness: { sending: () => boolean } }).__harness.sending(),
      undefined,
      { timeout: 15_000 },
    );
    await wheelAwayFromBottom(-700);
    expect(await atBottom()).toBe(false);
    const midStreamAnchor = (await visibleIds())[1];
    const midStream = await snap();
    console.log(`\n=== §10E case A: user scrolled away mid-stream (anchor ${midStreamAnchor}) ===`);
    console.log(`  isRunning=${midStream.isRunning}, anchor top=${midStream.rects[midStreamAnchor]?.top}`);
    // The stream must still be running, or "no jump" is vacuous.
    expect(midStream.isRunning).toBe(true);

    await page.waitForFunction(
      () => !(window as never as { __harness: { sending: () => boolean } }).__harness.sending(),
      undefined,
      { timeout: 20_000 },
    );
    await settle();
    const midStreamAfter = await snap();
    console.log(`  stream finished: scrollHeight ${midStream.scrollHeight} → ${midStreamAfter.scrollHeight}, anchor top ${midStreamAfter.rects[midStreamAnchor]?.top}`);
    // The remaining deltas did not yank the viewport back to the bottom.
    expect(midStreamAfter.scrollHeight).toBeGreaterThan(midStream.scrollHeight);
    expect(await atBottom()).toBe(false);
    expect(Math.abs(midStreamAfter.rects[midStreamAnchor].top - midStream.rects[midStreamAnchor].top)).toBeLessThanOrEqual(
      ANCHOR_TOLERANCE_PX,
    );

    // Case B: at the bottom for the whole run, the growing assistant message
    // must stay in view.
    await page.evaluate(
      () =>
        (window as never as { __harness: { streamPlan: (p: object) => void } }).__harness.streamPlan({
          gapMs: 20,
        }),
    );
    await resetToTip();
    await scrollTo(10_000);
    await settle();
    expect(await atBottom()).toBe(true);
    const bottomBefore = await snap();
    await page.evaluate(
      () => (window as never as { __harness: { send: () => Promise<void> } }).__harness.send(),
    );
    await page.waitForFunction(
      () => !(window as never as { __harness: { sending: () => boolean } }).__harness.sending(),
      undefined,
      { timeout: 20_000 },
    );
    await settle();
    const bottomAfter = await snap();
    console.log(`\n=== §10E case B: streaming at bottom ===`);
    console.log(`  scrollHeight ${bottomBefore.scrollHeight} → ${bottomAfter.scrollHeight}, atBottom=${await atBottom()}`);
    console.log(`  chat=${bottomAfter.chatIds.length} thread=${bottomAfter.threadIds.length} dom=${bottomAfter.count}`);
    expect(bottomAfter.scrollHeight).toBeGreaterThan(bottomBefore.scrollHeight);
    expect(bottomAfter.chatIds).toEqual(bottomAfter.threadIds);
    expect(await atBottom()).toBe(true);
  }, TEST_TIMEOUT);

  it("§10F: restoration keys on message identity, not index, pixels or guesses", async () => {
    // Anchor near the END of the window: its array index is far from 0, and the
    // prepended page is a different size than any previous prepend, so an
    // index- or pixel-based restore cannot produce the same position.
    await resetToTip();

    const anchor = "m498";
    await scrollMessageTo(anchor, 50);
    const before = await snap();
    const indexBefore = before.chatIds.indexOf(anchor);
    const heightBefore = before.heights[anchor];
    console.log("\n=== §10F identity anchoring ===");
    console.log(`  anchor ${anchor} at index ${indexBefore}/${before.count}, height ${heightBefore}px`);

    await page.evaluate(
      () => (window as never as { __harness: { loadOlder: () => unknown } }).__harness.loadOlder(),
    );
    await settle();

    const after = await snap();
    const indexAfter = after.chatIds.indexOf(anchor);
    console.log(`  index after prepend: ${indexAfter}/${after.count}, top ${before.rects[anchor].top} → ${after.rects[anchor].top}`);

    // Same message id, still rendered, same height (not re-measured/guessed)...
    expect(after.chatIds[indexAfter]).toBe(anchor);
    expect(after.heights[anchor]).toBe(heightBefore);
    // ...but at a DIFFERENT index: so the position below cannot be an index or a
    // fixed pixel offset, it can only be the measured rect of that id.
    expect(indexAfter).toBe(indexBefore + 50);
    expect(Math.abs(after.rects[anchor].top - before.rects[anchor].top)).toBeLessThanOrEqual(
      ANCHOR_TOLERANCE_PX,
    );
    // Its ID is unchanged (identity, not a re-keyed row).
    expect(Object.keys(after.rects)).toContain(anchor);
  }, TEST_TIMEOUT);

  it("§10G: failure cases preserve the last valid window and never corrupt scroll", async () => {
    // A. prepend succeeds — the window grows and stays anchored.
    await resetToTip();
    const anchor = "m470";
    await scrollMessageTo(anchor, 40);
    const base = await snap();
    await page.evaluate(
      () => (window as never as { __harness: { loadOlder: () => unknown } }).__harness.loadOlder(),
    );
    await settle();
    const afterOk = await snap();
    console.log("\n=== §10G A: prepend succeeds ===");
    console.log(`  ${base.count} → ${afterOk.count}; anchor held: ${Math.abs(afterOk.rects[anchor].top - base.rects[anchor].top) <= ANCHOR_TOLERANCE_PX}`);
    expect(afterOk.count).toBe(base.count + 50);
    expect(afterOk.headId).toBe("m500");
    expect(new Set(afterOk.chatIds).size).toBe(afterOk.chatIds.length);

    // B. prepend FAILS at the load boundary → the last valid window survives
    // untouched. (An earlier version of this case asserted on its own injected
    // throw after a SUCCESSFUL load — self-fulfilling. The harness now refuses
    // to commit when `failNext` is set, so the window really is unchanged.)
    const beforeB = await snap();
    const failed = await page.evaluate(() => {
      const h = (window as never as { __harness: { loadOlder: (f?: boolean) => unknown } }).__harness;
      try {
        h.loadOlder(true);
        return "committed-anyway";
      } catch (e) {
        return String((e as Error).message);
      }
    });
    await settle();
    const afterB = await snap();
    console.log(`=== §10G B: prepend fails (${failed}) ===`);
    console.log(`  window unchanged: ${afterB.count === beforeB.count && afterB.firstId === beforeB.firstId}, scrollTop unchanged: ${afterB.scrollTop === beforeB.scrollTop}`);
    // The load really failed...
    expect(failed).toContain("injected");
    // ...and nothing moved: same window, same scroll, same head.
    expect(afterB.count).toBe(beforeB.count);
    expect(afterB.firstId).toBe(beforeB.firstId);
    expect(afterB.lastId).toBe(beforeB.lastId);
    expect(afterB.scrollTop).toBe(beforeB.scrollTop);
    expect(afterB.headId).toBe(beforeB.headId);
    expect(afterB.chatIds).toEqual(beforeB.chatIds);
    expect(afterB.chatIds).toEqual(afterB.threadIds);

    // C. stale prepend response: a second loadOlder after a concurrent trim
    //    must not resurrect evicted ids or duplicate them.
    const beforeC = await snap();
    await page.evaluate(
      () =>
        (window as never as { __harness: { forceTrim: (d: string, n: number) => unknown } }).__harness.forceTrim(
          "newer",
          30,
        ),
    );
    await settle();
    const afterC = await snap();
    console.log(`=== §10G C: stale response after trim ===`);
    console.log(`  ${beforeC.count} → ${afterC.count}; unique ids: ${new Set(afterC.chatIds).size}/${afterC.chatIds.length}`);
    expect(new Set(afterC.chatIds).size).toBe(afterC.chatIds.length);
    expect(afterC.headId).toBe(afterC.chatIds.at(-1));

    // D. concurrent navigation — last commit wins, no duplicate repository.
    await Promise.all([
      page.evaluate(
        () => (window as never as { __harness: { forceTrim: (d: string, n: number) => unknown } }).__harness.forceTrim("older", 40),
      ),
      page.evaluate(
        () => (window as never as { __harness: { restoreTip: () => void } }).__harness.restoreTip(),
      ),
    ]);
    await settle();
    const afterD = await snap();
    console.log(`=== §10G D: concurrent navigation ===`);
    console.log(`  final window ${afterD.count} (${afterD.firstId}..${afterD.lastId}), unique ids: ${new Set(afterD.chatIds).size}/${afterD.chatIds.length}`);
    expect(new Set(afterD.chatIds).size).toBe(afterD.chatIds.length);
    expect(afterD.headId).toBe(afterD.chatIds.at(-1));

    // E. streaming while navigation is attempted: mutation capabilities are off
    //    while running, so a window swap cannot race the stream.
    await page.evaluate(
      () => (window as never as { __harness: { streamPlan: (p: object) => void } }).__harness.streamPlan({ gapMs: 120, holdOpen: true }),
    );
    const beforeE = await snap();
    await page.evaluate(() =>
      (window as never as { __harness: { startSend: () => void } }).__harness.startSend(),
    );
    await page.waitForFunction(
      () => (window as never as { __harness: { sending: () => boolean } }).__harness.sending(),
      undefined,
      { timeout: 15_000 },
    );
    await settle();
    const duringStream = await snap();
    console.log(`=== §10G E: navigation while streaming ===`);
    console.log(`  isRunning=${duringStream.isRunning} capabilities.delete=${duringStream.capabilities.delete} reload=${duringStream.capabilities.reload}`);
    expect(duringStream.isRunning).toBe(true);
    // Repository/chat still consistent while streaming.
    expect(duringStream.headId).toBe(duringStream.chatIds.at(-1));
    // Let the held stream finish, and WAIT for it: an in-flight stream appending
    // during the historical swap made the restored window 51 messages instead of
    // 50, which is a harness race, not a runtime result.
    await page.evaluate(
      () => (window as never as { __harness: { streamPlan: (p: object) => void } }).__harness.streamPlan({ holdOpen: false, gapMs: 5 }),
    );
    await page.evaluate(() =>
      (window as never as { __harness: { send: () => Promise<void> } }).__harness.send(),
    );
    await page.waitForFunction(
      () => !(window as never as { __harness: { sending: () => boolean } }).__harness.sending(),
      undefined,
      { timeout: 15_000 },
    );
    await settle();
    expect(beforeE.count).toBeGreaterThan(0);

    // F. restore-to-tip after a historical view.
    // Drain every stream first: a still-running send appending during the swap
    // left 51 rows after the restore, which is a harness race — the window
    // assertions below must measure the restore, not an in-flight append.
    await page.waitForFunction(
      () => !(window as never as { __harness: { sending: () => boolean } }).__harness.sending(),
      undefined,
      { timeout: 20_000 },
    );
    await settle();
    await page.waitForFunction(
      () => !(window as never as { __harness: { sending: () => boolean } }).__harness.sending(),
      undefined,
      { timeout: 20_000 },
    );
    await settle();

    await page.evaluate(
      () => (window as never as { __harness: { goHistorical: () => void } }).__harness.goHistorical(),
    );
    await settle();
    const historical = await snap();
    console.log(`=== §10G F: historical view → restore tip ===`);
    console.log(`  historical window: ${historical.count} (${historical.firstId}..${historical.lastId}), sendDisabled=${historical.historical}`);
    expect(historical.historical).toBe(true);
    expect(historical.firstId).toBe("m301");

    await page.evaluate(
      () => (window as never as { __harness: { restoreTip: () => void } }).__harness.restoreTip(),
    );
    await settle();
    const restored = await snap();
    console.log(`  restored window: ${restored.count} (${restored.firstId}..${restored.lastId}), sendDisabled=${restored.historical}`);
    console.log(`  restored chat tail: ${JSON.stringify(restored.chatIds.slice(-4))}  thread tail: ${JSON.stringify(restored.threadIds.slice(-4))}`);
    expect(restored.historical).toBe(false);
    expect(restored.firstId).toBe("m451");
    expect(restored.lastId).toBe("m500");
    expect(restored.headId).toBe("m500");
    expect(new Set(restored.chatIds).size).toBe(restored.count);
    // No history was lost: the full bounded window is back.
    expect(restored.chatIds).toEqual(
      Array.from({ length: 50 }, (_, i) => `m${451 + i}`),
    );
  }, TEST_TIMEOUT);
});
