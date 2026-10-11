import type { APIRequestContext, Page } from "@playwright/test";
import { SCROLL_END_THRESHOLD_PX } from "@web/config/virtualization.ts";

/**
 * Browser-level read helpers for the virtualized chat transcript.
 *
 * Every function here reads REAL geometry - getBoundingClientRect, scrollTop,
 * scrollHeight, offsetParent - out of a mounted page. That is deliberate and not
 * stylistic: tests/dom/virtualizer/virtual-transcript-harness.test.ts recorded a
 * measured mutation-gate finding that the virtualizer's anchorTo option has NO
 * observable effect without a real scroll element (jsdom has no layout, so no
 * scrollTop, no scrollHeight and therefore no anchor). A jsdom harness can prove
 * that a component renders; it cannot prove that a reader's position survived a
 * prepend, an append or a row resize. Those claims are only establishable here.
 *
 * Shared by the regression specs in this directory and by their throwaway
 * negative controls, so the control asserts the SAME measurement path with the
 * opposite expected value.
 */

export { SCROLL_END_THRESHOLD_PX };

/** The transcript's own scroll container, as ChatWindow renders it. */
export const SCROLLER = '[data-testid="virtual-transcript-scroller"]';
/** Every mounted virtual row. */
export const ROW = "[data-row-key]";
/** The collapsed/expanded disclosure header of a tool-call group. */
export const TOOL_GROUP_TRIGGER = '[data-slot="tool-group-trigger"]';

/** One mounted row, measured. */
export interface RowBox {
  readonly key: string;
  readonly index: number;
  /** Viewport-relative top edge, so rows are directly comparable. */
  readonly top: number;
  readonly bottom: number;
  readonly height: number;
  /**
   * False for a row that renders nothing. A turn-end row renders null, so its
   * box is legitimately 0px tall; asserting height > 0 on every row would be
   * asserting that turn-end rows do not exist.
   */
  readonly hasContent: boolean;
}

/** Everything a scroll-anchoring claim needs, read in one round trip. */
export interface Geometry {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly viewTop: number;
  readonly viewBottom: number;
  /** scrollHeight - scrollTop - clientHeight: > 0 means "not at the live end". */
  readonly distanceFromEnd: number;
  /** Height of the total-size container, i.e. the virtualizer's own coordinate space. */
  readonly containerHeight: number;
  readonly rows: readonly RowBox[];
}

/** Read the transcript's live geometry. Fails loudly if the surface is not mounted. */
export async function readGeometry(page: Page): Promise<Geometry> {
  return page.evaluate(
    ({ scrollerSelector, rowSelector }) => {
      const scroller = document.querySelector(scrollerSelector);
      if (!scroller) throw new Error("the virtualized transcript scroller is not mounted");
      const view = scroller.getBoundingClientRect();
      const rowElements = Array.from(
        document.querySelectorAll<HTMLElement>(rowSelector),
      );
      const rows = rowElements.map((row) => {
        const rect = row.getBoundingClientRect();
        return {
          key: row.getAttribute("data-row-key") ?? "",
          index: Number(row.getAttribute("data-index") ?? "-1"),
          top: rect.top,
          bottom: rect.bottom,
          height: rect.height,
          hasContent: row.childElementCount > 0,
        };
      });
      // Rows are position:absolute inside the total-size container, so
      // offsetParent IS the coordinate space the virtualizer laid them out in.
      const container = rowElements[0]?.offsetParent;
      return {
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        viewTop: view.top,
        viewBottom: view.bottom,
        distanceFromEnd: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
        containerHeight: container ? container.getBoundingClientRect().height : 0,
        rows,
      };
    },
    { scrollerSelector: SCROLLER, rowSelector: ROW },
  );
}

/** The first mounted row that is entirely on screen, or null. */
/**
 * Wait until the transcript stops growing, and return the settled scrollHeight.
 *
 * The direct history window loads progressively, so a transcript read a couple of
 * seconds after navigation still has a short `scrollHeight`. Any offset computed
 * from that reading lands near the bottom of the FINAL document and silently
 * measures the wrong scroll position - which looks like a failing assertion
 * rather than a stale measurement.
 */
export async function waitForStableScrollHeight(
  page: Page,
  options: { readonly timeoutMs?: number; readonly stableReads?: number } = {},
): Promise<number> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const stableReads = options.stableReads ?? 3;
  const deadline = Date.now() + timeoutMs;
  let previous = -1;
  let stable = 0;
  for (;;) {
    const current = await page.evaluate(
      (scrollerSelector) =>
        (document.querySelector(scrollerSelector) as HTMLElement).scrollHeight,
      SCROLLER,
    );
    stable = current === previous ? stable + 1 : 0;
    previous = current;
    if (stable >= stableReads) return current;
    if (Date.now() > deadline) return current;
    await page.waitForTimeout(400);
  }
}

export function firstFullyVisibleRow(geometry: Geometry): RowBox | null {
  return (
    geometry.rows.find((row) => row.top >= geometry.viewTop - 1 && row.bottom <= geometry.viewBottom) ??
    null
  );
}

/** The mounted row with this key, or null when it has scrolled out of the mounted range. */
export function rowByKey(geometry: Geometry, key: string): RowBox | null {
  return geometry.rows.find((row) => row.key === key) ?? null;
}

/** Round for the report; never used inside an assertion. */
export const px = (value: number): number => Math.round(value * 100) / 100;

interface StoredSeedMessage {
  readonly id: string;
  readonly parent_id: string | null;
  readonly format: "ai-sdk/v6";
  readonly content: { readonly role: "user" | "assistant"; readonly parts: readonly unknown[] };
}

async function postSeedBatch(
  request: APIRequestContext,
  conversationId: string,
  batch: readonly StoredSeedMessage[],
): Promise<void> {
  await Promise.all(
    batch.map(async (message) => {
      const res = await request.post(`/api/conversations/${conversationId}/messages`, {
        data: { message },
      });
      if (!res.ok()) throw new Error(`seed message ${message.id} failed: ${res.status()}`);
    }),
  );
}

/** Persist a prepared chain in order, in parallel batches, as the other history specs do. */
async function postSeedChain(
  request: APIRequestContext,
  conversationId: string,
  messages: readonly StoredSeedMessage[],
  batchSize = 15,
): Promise<void> {
  for (let offset = 0; offset < messages.length; offset += batchSize) {
    await postSeedBatch(request, conversationId, messages.slice(offset, offset + batchSize));
  }
}

/** Text body used by the seeded turns; unique per index so rows can be identified by content. */
export function seedBody(index: number): string {
  return `seeded-body-${index}`;
}

/**
 * A message-id prefix unique to ONE seed call.
 *
 * Message ids are unique across the database, not merely within a conversation:
 * two conversations seeded with the same "seed-0" collide and the second POST
 * is rejected 409. A spec that seeds two conversations at once has to namespace
 * them, exactly as the conversation id would.
 */
function seedPrefix(): string {
  return `seed-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Seed a linear conversation of alternating text turns.
 *
 * More messages than the bounded history window, so the transcript is genuinely
 * scrollable and a prepend is genuinely available.
 */
export async function seedTextConversation(
  request: APIRequestContext,
  title: string,
  totalMessages: number,
): Promise<string> {
  const created = await request.post("/api/conversations", {
    data: { title, workspaceMode: "simple", engine: "direct" },
  });
  if (!created.ok()) throw new Error(`seed conversation failed: ${created.status()}`);
  const { id } = (await created.json()) as { id: string };
  const prefix = seedPrefix();

  const messages: StoredSeedMessage[] = Array.from({ length: totalMessages }, (_, index) => ({
    id: `${prefix}-${index}`,
    parent_id: index === 0 ? null : `${prefix}-${index - 1}`,
    format: "ai-sdk/v6",
    content: {
      role: index % 2 === 0 ? "user" : "assistant",
      parts: [{ type: "text", text: seedBody(index) }],
    },
  }));
  await postSeedChain(request, id, messages);
  return id;
}

/**
 * Seed a conversation whose turn at `turnIndex` carries `turnParts` verbatim
 * instead of a text part.
 *
 * A seeded reasoning part is the app's own expansion mechanism: ChatWindow
 * renders it through ReasoningRoot with defaultOpen, so a reloaded history shows
 * the thinking block expanded, and its disclosure collapses and re-expands it on
 * a real user gesture. That is a genuine ResizeObserver-driven size change,
 * which is what a dynamic-height regression needs. Nothing is stubbed to get it.
 *
 * The turn sits inside the bounded window (callers keep its index in the last
 * 100 messages) and leaves the newest turns after it, so a reader can park below
 * it with the row itself scrolled out of view above the fold.
 */
export async function seedTurnConversation(
  request: APIRequestContext,
  title: string,
  options: {
    readonly totalMessages: number;
    readonly turnIndex: number;
    readonly turnParts: readonly unknown[];
  },
): Promise<string> {
  const created = await request.post("/api/conversations", {
    data: { title, workspaceMode: "simple", engine: "direct" },
  });
  if (!created.ok()) throw new Error(`seed conversation failed: ${created.status()}`);
  const { id } = (await created.json()) as { id: string };
  const prefix = seedPrefix();

  const messages: StoredSeedMessage[] = Array.from(
    { length: options.totalMessages },
    (_, index) => {
      const base = {
        id: `${prefix}-${index}`,
        parent_id: index === 0 ? null : `${prefix}-${index - 1}`,
        format: "ai-sdk/v6" as const,
      };
      if (index === options.turnIndex) {
        return { ...base, content: { role: "assistant" as const, parts: options.turnParts } };
      }
      return {
        ...base,
        content: {
          role: (index % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
          parts: [{ type: "text", text: seedBody(index) }],
        },
      };
    },
  );
  await postSeedChain(request, id, messages);
  return id;
}

/**
 * A long settled reasoning part.
 *
 * Paragraphs rather than one run-on paragraph, because ReasoningText lays the
 * markdown out as block children, and enough of them that the expanded panel
 * reaches its own max-h and the collapse/expand cycle is a large, unmistakable
 * height change rather than a rounding error.
 */
export function reasoningParts(paragraphs: number): unknown[] {
  return [
    {
      type: "reasoning",
      text: Array.from(
        { length: paragraphs },
        (_, i) =>
          `think-paragraph-${i} ${"reasoning filler words to give the panel real height ".repeat(4)}`,
      ).join("\n\n"),
    },
  ];
}

/** One SSE frame of an AI SDK UI message stream. */
const sse = (chunk: unknown) => `data: ${JSON.stringify(chunk)}\n\n`;

/**
 * How far the park nudges the reader FORWARD once the target row is placed.
 *
 * Small enough that a row parked 30px above the fold stays above it, large
 * enough to register as a scroll event. See parkRowAboveFold for why the
 * direction has to be pinned.
 */
const FORWARD_SETTLE_PX = 10;

/**
 * Intercept the real chat transport and serve a fixed, already-complete reply.
 *
 * Counted when the CLIENT issues the request, which is exactly the claim under
 * test, so fulfilling it locally keeps the run hermetic without touching the
 * runtime. Copied from p2-direct-history-window.spec.ts, which established that
 * this exact stream drives a real assistant turn through the real runtime.
 */
export async function stubChatTransport(page: Page): Promise<{ count: () => number }> {
  let submissions = 0;
  await page.route("**/api/chat", async (route) => {
    submissions += 1;
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "x-vercel-ai-ui-message-stream": "v1" },
      body:
        sse({ type: "start", messageId: "stub-anchoring-1" }) +
        sse({ type: "start-step" }) +
        sse({ type: "text-start", id: "t1" }) +
        sse({ type: "text-delta", id: "t1", delta: "stubbed reply" }) +
        sse({ type: "text-end", id: "t1" }) +
        sse({ type: "finish-step" }) +
        sse({ type: "finish" }),
    });
  });
  return { count: () => submissions };
}

/**
 * Wheel up until a row matching `targetSelector` is mounted, and return its key.
 *
 * Nothing is positioned: this only makes the row exist in the DOM, which a
 * caller needs before it can act on the row's own disclosure. A row that is not
 * mounted cannot be toggled, and toggling it through Playwright's click would
 * scroll it into view and move the position under test.
 */
export async function mountRow(page: Page, targetSelector: string): Promise<string> {
  const box = await page.locator(SCROLLER).boundingBox();
  if (!box) throw new Error("the virtualized transcript has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

  // Coarse steps first (rows that are not mounted are still carrying the 320px
  // estimate, so one step covers a lot of list), then a floor below the
  // overscan reach so the row cannot be stepped over.
  let step = 400;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const key = await page.evaluate(
      ({ rowSelector, selector }) => {
        const rows = Array.from(document.querySelectorAll(rowSelector));
        const target = rows.find((row) => row.querySelector(selector));
        return target?.getAttribute("data-row-key") ?? null;
      },
      { rowSelector: ROW, selector: targetSelector },
    );
    if (key) return key;
    await page.mouse.wheel(0, -step);
    await page.waitForTimeout(120);
    step = Math.max(150, Math.floor(step / 2));
  }
  throw new Error(`no mounted row contains ${targetSelector} after scrolling the whole transcript`);
}

export interface AboveFoldPark {
  readonly targetKey: string;
  readonly targetHeightBefore: number;
  /** The row the reader is looking at: fully on screen, below the growing row. */
  readonly anchorKey: string;
  readonly anchorTopBefore: number;
  readonly scrollTopBefore: number;
  readonly scrollHeightBefore: number;
}

/**
 * Park the transcript so the target row sits ENTIRELY above the fold while the
 * row the reader is looking at stays fully visible below it.
 *
 * Realizes exactly the corrected shape of the dynamic-height claim: the row that
 * changes size is positioned ABOVE the viewport, and the row whose position must
 * be preserved is VISIBLE below it. A growth above a visible anchor is the only
 * case that exercises virtual-core's shouldAdjustScrollPositionOnItemSizeChange
 * default path, which compensates for items entirely above the fold.
 *
 * The row is found by a real wheel scroll and then placed EXACTLY, by writing
 * the scrollTop that puts its bottom edge `minGapPx` above the fold. The final
 * position is therefore measured rather than approximated, and the caller gets
 * the geometry back to assert against.
 */
export async function parkRowAboveFold(
  page: Page,
  options: { readonly targetSelector: string; readonly minGapPx?: number },
): Promise<AboveFoldPark> {
  const minGapPx = options.minGapPx ?? 30;
  const box = await page.locator(SCROLLER).boundingBox();
  if (!box) throw new Error("the virtualized transcript has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

  let step = 400;
  let placements = 0;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const probe = await page.evaluate(
      ({ scrollerSelector, rowSelector, targetSelector, gap }) => {
        const scroller = document.querySelector(scrollerSelector);
        if (!scroller) throw new Error("the virtualized transcript scroller is not mounted");
        const view = scroller.getBoundingClientRect();
        const rows = Array.from(document.querySelectorAll(rowSelector));
        const targetRow = rows.find((row) => row.querySelector(targetSelector));
        if (!targetRow) return { mounted: false as const };
        const rect = targetRow.getBoundingClientRect();
        return {
          mounted: true as const,
          key: targetRow.getAttribute("data-row-key") ?? "",
          // A row's viewport position is (its offset in the content) minus
          // scrollTop, so raising the scroll offset by d lowers the row by d.
          // The delta that lands the row's bottom edge exactly `gap` px above
          // the fold is therefore bottom - (fold - gap).
          correction: rect.bottom - (view.top - gap),
        };
      },
      {
        scrollerSelector: SCROLLER,
        rowSelector: ROW,
        targetSelector: options.targetSelector,
        gap: minGapPx,
      },
    );

    if (!probe.mounted) {
      await page.mouse.wheel(0, -step);
      await page.waitForTimeout(120);
      step = Math.max(150, Math.floor(step / 2));
      continue;
    }

    await page.evaluate(
      ({ scrollerSelector, delta }) => {
        const scroller = document.querySelector(scrollerSelector);
        if (!scroller) throw new Error("the virtualized transcript scroller is not mounted");
        scroller.scrollTop += delta;
      },
      { scrollerSelector: SCROLLER, delta: probe.correction },
    );
    // Let the virtualizer settle on the new range, AND let the scroll go idle.
    // The idle wait is not cosmetic: virtual-core's default
    // shouldAdjustScrollPositionOnItemSizeChange predicate skips compensation
    // while `scrollDirection === "backward"` (it only clears once the scroll
    // ends, because the direction is reset to null on scroll-end). Reading the
    // baseline while the reader's last scroll was still upward would test that
    // documented suppression instead of the compensation path.
    await page.waitForTimeout(900);

    const geometry = await readGeometry(page);
    const target = rowByKey(geometry, probe.key);
    const anchor = firstFullyVisibleRow(geometry);
    if (
      target &&
      anchor &&
      target.bottom <= geometry.viewTop &&
      anchor.key !== target.key &&
      anchor.top >= target.bottom
    ) {
      // Park with a DEFINED scroll direction. virtual-core's default
      // shouldAdjustScrollPositionOnItemSizeChange predicate is
      // `itemStart + itemSize <= scrollOffset && scrollDirection !== "backward"`
      // (virtual-core index.js:936): an upward scroll deliberately suppresses
      // the size-change adjustment, because compensating during an upward
      // scroll is the "items jump while scrolling up" cascade. Reaching the
      // park by wheeling UP leaves exactly that state, which would make this
      // helper silently test the suppression instead of the compensation a
      // caller asked about. One small FORWARD adjustment settles the direction
      // without moving the row out of position, and the geometry is re-read
      // afterwards so the numbers returned are the post-nudge ones.
      await page.evaluate(
        ({ scrollerSelector, delta }) => {
          const scroller = document.querySelector(scrollerSelector);
          if (!scroller) throw new Error("the virtualized transcript scroller is not mounted");
          scroller.scrollTop += delta;
        },
        { scrollerSelector: SCROLLER, delta: FORWARD_SETTLE_PX },
      );
      await page.waitForTimeout(400);
      const settled = await readGeometry(page);
      const settledTarget = rowByKey(settled, probe.key);
      const settledAnchor = firstFullyVisibleRow(settled);
      if (
        settledTarget &&
        settledAnchor &&
        settledTarget.bottom <= settled.viewTop &&
        settledAnchor.key !== settledTarget.key &&
        settledAnchor.top >= settledTarget.bottom
      ) {
        return {
          targetKey: settledTarget.key,
          targetHeightBefore: settledTarget.height,
          anchorKey: settledAnchor.key,
          anchorTopBefore: settledAnchor.top,
          scrollTopBefore: settled.scrollTop,
          scrollHeightBefore: settled.scrollHeight,
        };
      }
    }

    // The exact placement can be re-derived while the row stays mounted, so
    // re-place a few times before falling back to a coarse wheel step.
    placements += 1;
    if (placements >= 4) {
      placements = 0;
      await page.mouse.wheel(0, -step);
      await page.waitForTimeout(100);
      step = Math.max(150, Math.floor(step / 2));
    }
  }

  throw new Error(
    "could not park the transcript with the target row above the fold and a fully visible row below it",
  );
}

/** A target parked fully inside the scrollport and provably reachable by a click. */
export interface InViewPark {
  readonly targetKey: string;
  readonly scrollTop: number;
  /** Viewport-relative rect of the trigger: the point a real click must aim at. */
  readonly triggerBox: {
    readonly left: number;
    readonly right: number;
    readonly top: number;
    readonly bottom: number;
  };
  readonly rowBox: {
    readonly left: number;
    readonly right: number;
    readonly top: number;
    readonly bottom: number;
  };
  readonly viewBox: { readonly top: number; readonly bottom: number };
}

/** Where in the scrollport the target's centre is aimed, as a fraction of its height. */
const IN_VIEW_ANCHOR_RATIO = 0.62;
/** Clearance kept between the target row and each edge of the scrollport. */
const IN_VIEW_EDGE_PX = 2;

/**
 * Park the transcript with the target row FULLY INSIDE the scrollport and with its
 * trigger provably hit-testable.
 *
 * This exists because `parkRowAboveFold` cannot be used for a real-pointer
 * interaction: its contract is that the target sits ENTIRELY above the fold
 * (`target.bottom <= viewTop`), which by definition puts the trigger off screen,
 * and `document.elementFromPoint` then never resolves to it. Driving a click at
 * such a row does not test the application - it tests the harness, and it fails
 * in ways that look like findings.
 *
 * The park is validated by `elementFromPoint` rather than assumed from geometry,
 * because the transcript's sticky header is a normal-flow child of the scrollport
 * and can cover part of the scrollport at scroll offsets no margin model predicts.
 *
 * Throws - rather than returning a park the caller cannot click - so an
 * unusable state can never be mistaken for a test result.
 */
export async function parkRowInView(
  page: Page,
  options: { readonly targetSelector: string; readonly attempts?: number },
): Promise<InViewPark> {
  const attempts = options.attempts ?? 12;
  let lastReason = "the target row never mounted";

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const placement = await page.evaluate(
      ({ scrollerSelector, rowSelector, targetSelector, ratio }) => {
        const scroller = document.querySelector(scrollerSelector) as HTMLElement;
        const view = scroller.getBoundingClientRect();
        const row = Array.from(document.querySelectorAll(rowSelector)).find((candidate) =>
          candidate.querySelector(targetSelector),
        ) as HTMLElement | undefined;
        if (!row) return { mounted: false as const };
        const rect = row.getBoundingClientRect();
        if (rect.height <= 0) return { mounted: false as const };
        return {
          mounted: true as const,
          key: row.getAttribute("data-row-key") ?? "",
          // Raising the scroll offset by d raises the row by -d on screen.
          delta: (rect.top + rect.bottom) / 2 - (view.top + view.height * ratio),
        };
      },
      {
        scrollerSelector: SCROLLER,
        rowSelector: ROW,
        targetSelector: options.targetSelector,
        ratio: IN_VIEW_ANCHOR_RATIO,
      },
    );

    if (!placement.mounted) {
      await page.mouse.wheel(0, 400);
      await page.waitForTimeout(150);
      continue;
    }

    await page.evaluate(
      ({ scrollerSelector, delta }) => {
        const scroller = document.querySelector(scrollerSelector) as HTMLElement;
        scroller.scrollTop += delta;
      },
      { scrollerSelector: SCROLLER, delta: placement.delta },
    );
    await page.waitForTimeout(500);

    const check = await page.evaluate(
      ({ scrollerSelector, rowSelector, targetSelector, key, edge }) => {
        const scroller = document.querySelector(scrollerSelector) as HTMLElement;
        const view = scroller.getBoundingClientRect();
        const row = document.querySelector(
          `${rowSelector}[data-row-key="${CSS.escape(key)}"]`,
        ) as HTMLElement | null;
        const trigger = row?.querySelector(targetSelector) as HTMLElement | null;
        if (!row || !trigger) return { ok: false as const, reason: "row or trigger unmounted" };

        const rowRect = row.getBoundingClientRect();
        const triggerRect = trigger.getBoundingClientRect();
        const insideScrollport =
          rowRect.height > 0 &&
          rowRect.top >= view.top + edge &&
          rowRect.bottom <= view.bottom - edge &&
          triggerRect.height > 0 &&
          triggerRect.top >= view.top &&
          triggerRect.bottom <= view.bottom;
        if (!insideScrollport) {
          return {
            ok: false as const,
            reason: `row ${Math.round(rowRect.top)}..${Math.round(rowRect.bottom)} vs view ${Math.round(view.top)}..${Math.round(view.bottom)}`,
          };
        }

        const x = triggerRect.left + triggerRect.width / 2;
        const y = triggerRect.top + triggerRect.height / 2;
        const hit = document.elementFromPoint(x, y) as HTMLElement | null;
        if (!hit || (hit !== trigger && !trigger.contains(hit))) {
          return {
            ok: false as const,
            reason: `elementFromPoint hit ${
              hit ? `${hit.tagName.toLowerCase()}/${hit.getAttribute("data-slot") ?? "-"}` : "null"
            } at (${Math.round(x)},${Math.round(y)})`,
          };
        }

        return {
          ok: true as const,
          scrollTop: scroller.scrollTop,
          triggerLeft: triggerRect.left,
          triggerRight: triggerRect.right,
          triggerTop: triggerRect.top,
          triggerBottom: triggerRect.bottom,
          rowLeft: rowRect.left,
          rowRight: rowRect.right,
          rowTop: rowRect.top,
          rowBottom: rowRect.bottom,
          viewTop: view.top,
          viewBottom: view.bottom,
        };
      },
      {
        scrollerSelector: SCROLLER,
        rowSelector: ROW,
        targetSelector: options.targetSelector,
        key: placement.key,
        edge: IN_VIEW_EDGE_PX,
      },
    );

    if (check.ok) {
      return {
        targetKey: placement.key,
        scrollTop: check.scrollTop,
        triggerBox: {
          left: check.triggerLeft,
          right: check.triggerRight,
          top: check.triggerTop,
          bottom: check.triggerBottom,
        },
        rowBox: {
          left: check.rowLeft,
          right: check.rowRight,
          top: check.rowTop,
          bottom: check.rowBottom,
        },
        viewBox: { top: check.viewTop, bottom: check.viewBottom },
      };
    }
    lastReason = check.reason;
  }

  throw new Error(
    `could not park a clickable row for ${options.targetSelector} after ${attempts} attempts: ${lastReason}`,
  );
}

/**
 * Toggle a disclosure WITHOUT scrolling it into view.
 *
 * A real click through Playwright scrolls the target into view first, which
 * would move the very position under test. HTMLElement.click() dispatches the
 * same DOM event React and Radix listen for, and never scrolls, so the toggle
 * is a pure height change at a fixed scroll position. That is precisely the
 * situation under test: a row changing size while the reader is somewhere else.
 */
export async function toggleDisclosureInPlace(
  page: Page,
  options: { readonly rowKey: string; readonly triggerSelector: string },
): Promise<boolean> {
  return page.evaluate(
    ({ rowSelector, triggerSelector, key }) => {
      const row = document.querySelector(`${rowSelector}[data-row-key="${CSS.escape(key)}"]`);
      const trigger = row?.querySelector(triggerSelector) as HTMLElement | null;
      if (!trigger) return false;
      trigger.click();
      return true;
    },
    { rowSelector: ROW, triggerSelector: options.triggerSelector, key: options.rowKey },
  );
}

/** The reasoning disclosure header, and the collapsible panel it controls. */
export const REASONING_TRIGGER = '[data-slot="reasoning-trigger"]';
export const REASONING_CONTENT = '[data-slot="reasoning-content"]';

/**
 * Poll until the row has actually grown, so the anchoring assertion can never be
 * satisfied by a height change that never happened.
 */
export async function waitForRowGrowth(
  page: Page,
  rowKey: string,
  minimumGrowthPx: number,
  timeoutMs = 20000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  for (;;) {
    const geometry = await readGeometry(page);
    const row = rowByKey(geometry, rowKey);
    last = row ? row.height : -1;
    if (row && last >= minimumGrowthPx) return last;
    if (Date.now() > deadline) {
      throw new Error(
        `row ${rowKey} never reached ${minimumGrowthPx}px (last measured height ${last}px)`,
      );
    }
    await page.waitForTimeout(100);
  }
}

/**
 * Park mid-history by real wheel scrolling and report the read position.
 *
 * Uses wheel events rather than a scrollTop write so the timeline observes an
 * actual user gesture, which is what disarms follow-on-append, and scrolls in
 * steps until the reader is a REAL distance from the live end. Parking only just
 * outside scrollEndThreshold would make every claim here fragile: a single
 * appended chunk or measurement correction crosses back over it and the test
 * would then be measuring a reader who is, in the app's own terms, pinned to the
 * end.
 */
export async function parkMidHistory(
  page: Page,
  options: {
    readonly wheelStep?: number;
    readonly targetDistanceFromEnd: number;
    readonly settleMs?: number;
  },
): Promise<Geometry> {
  /**
   * A 1000px step, deliberately, and it is load-bearing rather than incidental.
   *
   * The loop stops the moment the reader is `targetDistanceFromEnd` from the end.
   * A coarse step overshoots that target and lands wherever the scroller clamps -
   * and on the seeded regression transcripts (settled ~4,850px in a ~414px
   * viewport, so ~4,476px of travel) a 2,500px step jumped 2,500 -> 5,000 and
   * clamped at scrollTop 0, the very TOP of the transcript. That is a legitimate
   * place to be, but it is an EDGE, and R2 asserts the reader is parked in the
   * interior before it appends output.
   *
   * It also made the result depend on transcript height modulo the step rather
   * than on transcript behaviour: shrinking the scrollport by one header band
   * was enough to move the landing point from scrollTop 271 to scrollTop 0 and
   * fail R2, with no product change involved. With a 1000px step the reader
   * stops near the requested distance (2,000 -> 3,000 -> 4,000) instead of
   * overshooting into a clamp, so parking is a function of the target and not of
   * how tall the seeded conversation happened to be.
   */
  const wheelStep = options.wheelStep ?? 1000;
  const box = await page.locator(SCROLLER).boundingBox();
  if (!box) throw new Error("the virtualized transcript has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

  let geometry = await readGeometry(page);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (geometry.distanceFromEnd >= options.targetDistanceFromEnd) break;
    await page.mouse.wheel(0, -wheelStep);
    await page.waitForTimeout(150);
    geometry = await readGeometry(page);
  }
  // Row heights are MEASURED, not estimated, so let measurement settle before
  // the "before" reading; otherwise the comparison charges the reader's own
  // settling to the change under test.
  await page.waitForTimeout(options.settleMs ?? 1200);
  return readGeometry(page);
}

/** Navigate between threads inside the SPA, so no full document reload occurs. */
export async function switchThread(page: Page, conversationId: string): Promise<void> {
  await page.evaluate((hash) => {
    window.location.hash = hash;
  }, `#/chat/${conversationId}`);
}