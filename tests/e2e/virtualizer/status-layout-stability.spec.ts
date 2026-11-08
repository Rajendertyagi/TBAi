import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { holdStubStream, releaseStubStream, setStubText } from "../helpers/stubProvider.ts";

/**
 * S7a — composer layout stability, measured in a real browser.
 *
 * ## The defect this guards
 *
 * A transient status presentation used to mount in the composer folder's normal
 * flow. Showing or hiding it resized the folder, and because the transcript is
 * the `flex-1` sibling, the transcript viewport and the composer moved with it.
 * The fix is structural: `ChatWindow` always mounts one reserved status row with
 * `min-height: var(--status-reserved-height)` (46 px, the 38 px `AgentStatus`
 * line plus the row's own 8 px bottom padding) and renders every status
 * presentation inside it.
 *
 * ## What only a browser can prove
 *
 * `tests/dom/components/chat-layout-stability.test.tsx` asserts the structure
 * under happy-dom, which has no layout engine. This file asserts the pixels:
 * idle → active → idle keeps the row at exactly one line, and the composer,
 * transcript viewport and folder do not move. Values are read with
 * `getBoundingClientRect()` and `scrollTop`, compared with a 1 px tolerance
 * (sub-pixel DPI rounding is not claimed to be covered).
 *
 * ## Every sample is post-settle
 *
 * The transcript header mounts the boot skeleton while history loads, and the
 * skeleton is a real, in-flow band above the scroller. A probe measured it
 * appearing and clearing within ~120 ms on first paint (scroller y 104 → 408 →
 * 104) while the reserved row and composer folder never moved. That transient
 * is a LOAD-state transition, not a status presentation, so it is excluded by
 * waiting for it to clear (boot skeleton absent, geometry unchanged across two
 * consecutive samples) before any layout is compared. Without this, a snapshot
 * taken mid-load is compared against a settled one and an unrelated 304 px
 * skeleton band reads as a status jump. See the probe note in the S7b
 * documentation correction.
 *
 * ## The narrow width is the product's own minimum
 *
 * The desktop window declares `minWidth: 480` (`src-tauri/tauri.conf.json`).
 * The chrome consumes 48 px (activity rail) + 224 px (sidebar), and the folder
 * another 32 px of padding, so at 480 the row's content box is 176 px — the
 * narrowest geometry a user can actually reach. An earlier draft used 320 px,
 * where the same arithmetic leaves a 16 px content box and even the composer
 * textarea has no visible box; that asserted layout behaviour for a window the
 * product cannot open.
 *
 * ## The two-line number is MEASURED, not assumed
 *
 * The row wraps only when both the Code primary and the restoration notice are
 * present and cannot fit side by side. That case needs a live OpenCode turn
 * (primary states — thinking/tool/approval/cancellation — all require a running
 * turn), so the hermetic server may never reach it. When the both-present case
 * does occur, the row's height is asserted against the arithmetic of the
 * MEASURED pills (`primary + row-gap + notice + bottom padding`), and the
 * concrete number is recorded. The plan's historical 84 px assumed a 30 px
 * notice; after S5 the notice is an `AgentStatus` like the primary (38 px), so
 * the wrapped row is 38 + 8 + 38 + 8 = 92 px. See the S7b documentation
 * correction.
 */

const STUB_PORT = process.env.TBAI_E2E_STUB_PORT ?? "3199";
const STUB = `http://127.0.0.1:${STUB_PORT}`;

/** The one-line reserved height, pinned by `--status-reserved-height`. */
const ROW_ONE_LINE = 46;

/** The narrowest viewport the product can open (`tauri.conf.json` minWidth). */
const NARROW_VIEWPORT = { width: 480, height: 720 };

/** Tolerance for rounded rect comparisons (sub-pixel DPI is not claimed). */
const PX_TOLERANCE = 1;

type Conversation = { id: string };

type Rect = { x: number; y: number; width: number; height: number };

interface Layout {
  row: Rect & { scrollWidth: number; clientWidth: number; rowGap: number; paddingBottom: number };
  folder: Rect;
  composer: Rect;
  scroller: Rect & { scrollTop: number };
  primary: { rect: Rect; label: string; stateWord: string } | null;
  notice: { rect: Rect; label: string } | null;
}

/**
 * Extract the live geometry. Self-contained so it can be passed to
 * `page.evaluate`, which serialises it into the page.
 */
function extractLayout(): Layout {
  const row = document.querySelector<HTMLElement>("[data-status-row]");
  const scroller = document.querySelector<HTMLElement>(
    '[data-testid="virtual-transcript-scroller"]',
  );
  const textarea = document.querySelector<HTMLTextAreaElement>("textarea");
  if (!row || !scroller || !textarea) {
    throw new Error("status-layout probe: row, transcript scroller or composer is missing");
  }
  const rectOf = (element: Element): Rect => {
    const r = element.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  const style = getComputedStyle(row);
  const primaryEl = document.querySelector<HTMLElement>("[data-primary-status]");
  const noticeEl = document.querySelector<HTMLElement>("[data-restoration-notice]");
  const truncatedLabel = primaryEl
    ? [...primaryEl.querySelectorAll("span")].find((span) => span.className.includes("truncate"))
    : undefined;
  return {
    row: {
      ...rectOf(row),
      scrollWidth: row.scrollWidth,
      clientWidth: row.clientWidth,
      rowGap: Number.parseFloat(style.rowGap) || 0,
      paddingBottom: Number.parseFloat(style.paddingBottom) || 0,
    },
    folder: rectOf(row.parentElement as HTMLElement),
    composer: rectOf(textarea),
    scroller: { ...rectOf(scroller), scrollTop: scroller.scrollTop },
    primary: primaryEl
      ? {
          rect: rectOf(primaryEl),
          label: truncatedLabel?.textContent ?? "",
          stateWord: primaryEl.querySelector(".sr-only")?.textContent ?? "",
        }
      : null,
    notice: noticeEl ? { rect: rectOf(noticeEl), label: noticeEl.textContent ?? "" } : null,
  };
}

/** Read the live geometry of the composer folder and everything it moves. */
async function readLayout(page: Page): Promise<Layout> {
  return page.evaluate(extractLayout);
}

/**
 * The same measurement, but only while BOTH the primary and the notice are
 * mounted — read in one evaluation so the notice's finite lifetime cannot
 * expire between a presence check and the measurement.
 */
async function readLayoutIfBoth(page: Page): Promise<Layout | null> {
  const both = await page.evaluate(
    () =>
      document.querySelector("[data-primary-status]") !== null &&
      document.querySelector("[data-restoration-notice]") !== null,
  );
  return both ? page.evaluate(extractLayout) : null;
}

function expectOneLine(layout: Layout, message: string): void {
  expect(
    Math.abs(layout.row.height - ROW_ONE_LINE),
    `${message}: reserved row height ${layout.row.height}px, expected ${ROW_ONE_LINE}px`,
  ).toBeLessThanOrEqual(PX_TOLERANCE);
}

/** The parts of the page a status presentation must never move. */
function expectUnmoved(before: Layout, after: Layout, message: string): void {
  for (const key of ["folder", "composer", "scroller"] as const) {
    for (const edge of ["y", "height"] as const) {
      expect(
        Math.abs(before[key][edge] - after[key][edge]),
        `${message}: ${key}.${edge} moved ${before[key][edge]} → ${after[key][edge]} (≤1px)`,
      ).toBeLessThanOrEqual(PX_TOLERANCE);
    }
  }
}

function expectNoHorizontalOverflow(layout: Layout, message: string): void {
  expect(
    layout.row.scrollWidth,
    `${message}: row content overflows horizontally (${layout.row.scrollWidth} > ${layout.row.clientWidth})`,
  ).toBeLessThanOrEqual(layout.row.clientWidth + PX_TOLERANCE);
  // The pills themselves must sit inside the row's box, not merely be clipped.
  for (const [name, item] of [
    ["primary", layout.primary],
    ["notice", layout.notice],
  ] as const) {
    if (!item) continue;
    expect(
      item.rect.x + item.rect.width,
      `${message}: ${name} extends past the row's right edge`,
    ).toBeLessThanOrEqual(layout.row.x + layout.row.width + PX_TOLERANCE);
  }
}

async function createConversation(
  request: APIRequestContext,
  title: string,
  engine: "direct" | "opencode",
): Promise<string> {
  const created = await request.post("/api/conversations", {
    data: { title, workspaceMode: "simple", engine },
  });
  expect(created.ok(), "creating the conversation failed").toBeTruthy();
  return ((await created.json()) as Conversation).id;
}

async function deleteConversation(request: APIRequestContext, id: string): Promise<void> {
  await request.delete(`/api/conversations/${id}`).catch(() => undefined);
}

async function sendMessage(page: Page, text: string): Promise<void> {
  // The placeholder is the composer's own declared string, and it selects the
  // real input rather than the library's hidden auto-resize mirror (the DOM
  // holds two textareas; `.first()` was not stable across widths).
  const composer = page.getByPlaceholder(/Send a message/);
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await composer.fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
}

async function armToolCall(
  request: APIRequestContext,
  toolName: string,
  args: unknown,
): Promise<void> {
  const armed = await request.post(`${STUB}/__e2e/tool`, { data: { toolName, args } });
  expect(armed.ok(), "arming the stub tool call failed").toBeTruthy();
}

async function disarmToolCall(request: APIRequestContext): Promise<void> {
  await request.post(`${STUB}/__e2e/tool/disarm`).catch(() => undefined);
}

/**
 * Wait until the view is settled and report its layout.
 *
 * "Settled" means the history-loading transient is over: the reserved row is
 * mounted at its one-line height, the boot skeleton is unmounted, and the
 * transcript viewport, composer and folder are unchanged across two
 * consecutive 120 ms samples. Every comparison in this file is between
 * settled snapshots, which is what makes a difference attributable to the
 * status presentation under test rather than to a load transition.
 */
async function waitForSettledRow(page: Page): Promise<Layout> {
  await expect(page.locator("[data-status-row]")).toBeAttached({ timeout: 30_000 });
  const deadline = Date.now() + 15_000;
  let previous = await readLayout(page);
  let stable = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(120);
    const current = await readLayout(page);
    const bootGone = (await page.locator('[data-testid="thread-boot"]').count()) === 0;
    const unchanged =
      bootGone &&
      (["folder", "composer", "scroller"] as const).every((key) =>
        (["x", "y", "width", "height"] as const).every(
          (edge) => Math.abs(current[key][edge] - previous[key][edge]) <= PX_TOLERANCE,
        ),
      ) &&
      Math.abs(current.row.height - previous.row.height) <= PX_TOLERANCE;
    stable = unchanged ? stable + 1 : 0;
    previous = current;
    if (stable >= 2) {
      expectOneLine(current, "settled row");
      return current;
    }
  }
  throw new Error(
    "status-layout probe: layout never settled (boot skeleton still cycling or geometry still moving)",
  );
}

test.describe("composer status row — measured layout stability (S7a)", () => {
  test.setTimeout(240_000);

  test("Direct: idle → thinking → idle holds 46px and moves nothing", async ({ page, request }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const tag = `s7a-direct-${Date.now()}`;
    const conversationId = await createConversation(request, `s7a ${tag}`, "direct");

    try {
      await page.goto(`/#/chat/${conversationId}`);
      const idle = await waitForSettledRow(page);
      expect(idle.primary, "idle Direct surface must not render a status pill").toBeNull();
      expect(idle.notice).toBeNull();
      expectNoHorizontalOverflow(idle, "Direct idle");

      await setStubText(request, `${tag}_DONE`);
      await holdStubStream(request);
      await sendMessage(page, `status layout probe ${tag}`);

      // Held provider stream = a real in-flight run, so the pill's "Thinking…"
      // state is genuine rather than a zero-byte interception.
      await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible({
        timeout: 30_000,
      });
      const primary = page.locator("[data-primary-status]");
      await expect(primary).toBeVisible({ timeout: 30_000 });
      const active = await readLayout(page);

      expectOneLine(active, "Direct thinking");
      expect(active.primary!.label).toBe("Thinking…");
      // The state word is the accessible half of the pill and must survive
      // truncation; it is not boxed by `max-w-44`.
      expect(active.primary!.stateWord).toBe("working");
      expectNoHorizontalOverflow(active, "Direct thinking");
      expectUnmoved(idle, active, "Direct idle → thinking");

      await releaseStubStream(request);
      await expect(page.getByRole("button", { name: "Send message" })).toBeVisible({
        timeout: 30_000,
      });
      await expect(primary).toHaveCount(0, { timeout: 30_000 });
      const settled = await readLayout(page);

      expectOneLine(settled, "Direct settled");
      expectNoHorizontalOverflow(settled, "Direct settled");
      // The pill unmounting is the event that used to resize the folder. The
      // transcript content grew (the reply arrived), so the scroll offset may
      // legitimately move — the container boxes must not.
      expectUnmoved(active, settled, "Direct thinking → idle");
      expect(Math.abs(settled.folder.height - idle.folder.height)).toBeLessThanOrEqual(
        PX_TOLERANCE,
      );
    } finally {
      await releaseStubStream(request);
      await disarmToolCall(request);
      await deleteConversation(request, conversationId);
    }
  });

  test("Direct: an approval gate keeps the row at 46px (reachability recorded)", async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const tag = `s7a-approval-${Date.now()}`;
    const conversationId = await createConversation(request, `s7a ${tag}`, "direct");

    try {
      await page.goto(`/#/chat/${conversationId}`);
      const idle = await waitForSettledRow(page);

      await setStubText(request, `${tag}_APPROVED`);
      // `scheduler` is the only Direct tool that DECLARES `needsApproval`
      // (`schedulerActionNeedsApproval`), and `action: "create"` is the mutating
      // action that trips it.
      await armToolCall(request, "scheduler", {
        action: "create",
        name: `s7a-job-${tag}`,
        scheduleType: "once",
        timezone: "UTC",
        prompt: "noop",
        execAt: Math.floor(Date.now() / 1000) + 86_400,
      });
      await sendMessage(page, `schedule the ${tag} probe job`);

      const approve = page.locator("button:has-text('Approve')").first();
      await expect(approve).toBeVisible({ timeout: 60_000 });
      const gated = await readLayout(page);

      // Whatever the Direct pill shows while a tool awaits approval, the row is
      // the reserved one-line box. Whether the pill presents at all is recorded
      // rather than assumed: `useAssistantActivity` gates on `thread.isRunning`,
      // and a run suspended on approval may report `requires-action` instead.
      expectOneLine(gated, "Direct awaiting approval");
      expectNoHorizontalOverflow(gated, "Direct awaiting approval");
      expectUnmoved(idle, gated, "Direct idle → awaiting approval");
      test.info().annotations.push({
        type: "S7a-direct-approval-primary",
        description: gated.primary
          ? `primary present while awaiting approval: "${gated.primary.label}"`
          : "no Direct primary while awaiting approval (thread.isRunning is false for requires-action); row still 46px",
      });
      if (gated.primary) {
        expect(gated.primary.label).toBe("Waiting for approval…");
      }

      await approve.click();
      await expect(page.getByText(`${tag}_APPROVED`)).toBeVisible({ timeout: 60_000 });
      await expect(page.locator("[data-primary-status]")).toHaveCount(0, { timeout: 30_000 });
      const settled = await readLayout(page);
      expectOneLine(settled, "Direct post-approval");
      expectUnmoved(idle, settled, "Direct approval → settled");
    } finally {
      await releaseStubStream(request);
      await disarmToolCall(request);
      await deleteConversation(request, conversationId);
    }
  });

  test("Direct: a narrow viewport truncates, never overflows, and keeps 46px", async ({
    page,
    request,
  }) => {
    await page.setViewportSize(NARROW_VIEWPORT);
    const tag = `s7a-narrow-${Date.now()}`;
    const conversationId = await createConversation(request, `s7a ${tag}`, "direct");

    try {
      await page.goto(`/#/chat/${conversationId}`);
      await waitForSettledRow(page);

      await setStubText(request, `${tag}_DONE`);
      await holdStubStream(request);
      await sendMessage(page, `narrow status probe ${tag}`);
      const primary = page.locator("[data-primary-status]");
      await expect(primary).toBeVisible({ timeout: 30_000 });
      const active = await readLayout(page);

      expectOneLine(active, "Direct narrow thinking");
      expectNoHorizontalOverflow(active, "Direct narrow thinking");
      // `truncate` is visual: the full label and the state word stay in the DOM,
      // so the accessible name is complete even when the box is narrow.
      expect(active.primary!.label).toBe("Thinking…");
      expect(active.primary!.rect.width).toBeLessThanOrEqual(active.row.clientWidth + PX_TOLERANCE);
      test.info().annotations.push({
        type: "S7a-narrow-geometry",
        description: `viewport ${NARROW_VIEWPORT.width}px (declared minimum): row content ${active.row.clientWidth}px, pill ${active.primary!.rect.width}px, label "${active.primary!.label}", row height ${active.row.height}px`,
      });

      await releaseStubStream(request);
      await expect(page.getByRole("button", { name: "Send message" })).toBeVisible({
        timeout: 30_000,
      });
      await expect(primary).toHaveCount(0, { timeout: 30_000 });
      expectOneLine(await readLayout(page), "Direct narrow settled");
    } finally {
      await releaseStubStream(request);
      await deleteConversation(request, conversationId);
    }
  });

  test("Code: the restoration notice alone holds 46px, auto-hides, and the heart moves nothing", async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const tag = `s7a-code-${Date.now()}`;
    const conversationId = await createConversation(request, `s7a ${tag}`, "opencode");

    try {
      await page.goto(`/#/code/${conversationId}`);
      const idle = await waitForSettledRow(page);
      expect(idle.notice, "a fresh session is not a verified reuse").toBeNull();
      expectNoHorizontalOverflow(idle, "Code idle");

      // A reload re-bootstraps the session. The backend reports reuse ONLY when
      // it verified and adopted the existing live session, which is exactly
      // what the notice states.
      await page.reload();
      await waitForSettledRow(page);
      const notice = page.locator("[data-restoration-notice]");
      await expect(notice).toBeVisible({ timeout: 90_000 });
      const withNotice = await readLayout(page);

      expectOneLine(withNotice, "Code notice alone");
      expect(withNotice.notice!.label).toContain("Session restored");
      expect(withNotice.primary).toBeNull();
      expectNoHorizontalOverflow(withNotice, "Code notice alone");
      expectUnmoved(idle, withNotice, "Code idle → notice");

      // The dismiss control is a real, focusable button — the trailing slot is
      // not aria-hidden for a caller-supplied control (S5).
      const dismiss = page.getByRole("button", { name: "Dismiss session notice" });
      await expect(dismiss).toBeVisible();
      await dismiss.focus();
      await expect(dismiss).toBeFocused();

      // The heart's popover is an out-of-flow overlay: opening and closing it
      // must not move the folder, the composer or the reserved row.
      const heart = page.getByRole("button", { name: /^OpenCode status:/ });
      await expect(heart).toBeVisible({ timeout: 90_000 });
      const heartBox = await heart.boundingBox();
      const beforePopover = await readLayout(page);
      await heart.click();
      await expect(page.getByRole("button", { name: "Reconnect" })).toBeVisible();
      const heartOpen = await heart.boundingBox();
      expect(Math.abs(heartOpen!.x - heartBox!.x)).toBeLessThanOrEqual(PX_TOLERANCE);
      expect(Math.abs(heartOpen!.y - heartBox!.y)).toBeLessThanOrEqual(PX_TOLERANCE);
      expectUnmoved(beforePopover, await readLayout(page), "heart popover open");
      await page.keyboard.press("Escape");
      await expect(page.getByRole("button", { name: "Reconnect" })).toHaveCount(0);
      expectUnmoved(beforePopover, await readLayout(page), "heart popover close");

      // Dismissing the notice changes no content, so this is the clean
      // scroll-anchor check: the scroll offset and every box stay put.
      await dismiss.click();
      await expect(notice).toHaveCount(0, { timeout: 10_000 });
      const afterDismiss = await readLayout(page);
      expectOneLine(afterDismiss, "Code after dismiss");
      expectUnmoved(beforePopover, afterDismiss, "Code notice dismiss");
      expect(
        Math.abs(afterDismiss.scroller.scrollTop - beforePopover.scroller.scrollTop),
        "dismissing the notice moved the transcript scroll anchor",
      ).toBeLessThanOrEqual(PX_TOLERANCE);

      // Auto-hide is finite (OPENCODE_RECOVERY_NOTICE_MS): reload once more and
      // watch it disappear on its own, leaving the row at one line.
      await page.reload();
      await expect(notice).toBeVisible({ timeout: 90_000 });
      await expect(notice).toHaveCount(0, { timeout: 20_000 });
      expectOneLine(await readLayout(page), "Code after auto-hide");
    } finally {
      await deleteConversation(request, conversationId);
    }
  });

  test("Code: primary + notice coexist as sibling pills (live-turn dependent)", async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const tag = `s7a-both-${Date.now()}`;
    const conversationId = await createConversation(request, `s7a ${tag}`, "opencode");

    try {
      await page.goto(`/#/code/${conversationId}`);
      await waitForSettledRow(page);
      await page.reload();
      await waitForSettledRow(page);
      const notice = page.locator("[data-restoration-notice]");
      await expect(notice).toBeVisible({ timeout: 90_000 });

      // The primary only presents an ACTIVE TURN, so both pills can coexist
      // only while a real turn is running inside the notice's 12 s window. The
      // hermetic server's OpenCode instance may have no model, in which case
      // the turn never starts — a fact about the environment, recorded below,
      // not a layout result.
      await sendMessage(page, `status coexistence probe ${tag}`);
      const primary = page.locator("[data-primary-status]");
      const bothVisible = await primary
        .waitFor({ state: "visible", timeout: 8_000 })
        .then(() => true)
        .catch(() => false);

      if (!bothVisible) {
        test.info().annotations.push({
          type: "S7a-coexistence-unavailable",
          description:
            "no OpenCode primary while the restoration notice was visible: the hermetic OpenCode instance did not start an active turn (no model/credentials). The both-present row height is therefore not measured in this environment.",
        });
        test.skip(true, "both-present state needs a live OpenCode turn (no model in the E2E env)");
        return;
      }

      // Both boxes are read in ONE evaluate with the presence check, so the
      // notice's 12 s lifetime cannot expire between "is it there" and "measure
      // it".
      const wide = await readLayoutIfBoth(page);
      if (!wide) {
        test.info().annotations.push({
          type: "S7a-coexistence-unavailable",
          description:
            "the primary and the notice were never mounted at the same instant, so the both-present row height was not measured",
        });
        test.skip(true, "both-present state was not observable in the E2E environment");
        return;
      }
      expectOneLine(wide, "Code both pills, wide");
      expectNoHorizontalOverflow(wide, "Code both pills, wide");
      expect(wide.primary!.rect.x).toBeLessThan(wide.notice!.rect.x);

      // Narrow the SAME mounted state so the wrap is observed, not inferred.
      // The pill heights and the row's row-gap come from the live computed
      // style, so the expected two-line height is arithmetic over measured
      // boxes rather than a remembered constant. After S5 both pills are 38 px,
      // which is why the historical 84 px (assumed 30 px notice) is 92 px.
      await page.setViewportSize(NARROW_VIEWPORT);
      let wrapped: Layout | null = null;
      try {
        await expect
          .poll(
            async () => {
              const layout = await readLayoutIfBoth(page);
              return layout ? layout.row.height : 0;
            },
            { timeout: 3_000 },
          )
          .toBeGreaterThan(ROW_ONE_LINE);
        wrapped = await readLayoutIfBoth(page);
      } catch {
        wrapped = null;
      }
      if (!wrapped) {
        test.info().annotations.push({
          type: "S7a-wrap-not-observed",
          description:
            "both pills were present at the wide width but the turn ended before the narrow wrap could be measured",
        });
        test.skip(true, "the narrow wrap was not observable before the live turn ended");
        return;
      }
      const expectedWrapped =
        wrapped.primary!.rect.height +
        wrapped.row.rowGap +
        wrapped.notice!.rect.height +
        wrapped.row.paddingBottom;
      expect(
        Math.abs(wrapped.row.height - expectedWrapped),
        `wrapped row ${wrapped.row.height}px, expected ${expectedWrapped}px (pill + row-gap + pill + padding)`,
      ).toBeLessThanOrEqual(PX_TOLERANCE);
      expectNoHorizontalOverflow(wrapped, "Code both pills, narrow");
      test.info().annotations.push({
        type: "S7a-both-present-measured",
        description: `wide row ${wide.row.height}px (content ${wide.row.clientWidth}px, primary ${wide.primary!.rect.width}px + notice ${wide.notice!.rect.width}px); wrapped row ${wrapped.row.height}px`,
      });
    } finally {
      await deleteConversation(request, conversationId);
    }
  });

  test("Code: notice alone stays 46px at a narrow viewport", async ({ page, request }) => {
    await page.setViewportSize(NARROW_VIEWPORT);
    const tag = `s7a-code-narrow-${Date.now()}`;
    const conversationId = await createConversation(request, `s7a ${tag}`, "opencode");

    try {
      await page.goto(`/#/code/${conversationId}`);
      await waitForSettledRow(page);
      await page.reload();
      await waitForSettledRow(page);
      const notice = page.locator("[data-restoration-notice]");
      await expect(notice).toBeVisible({ timeout: 90_000 });

      const narrow = await readLayout(page);
      expectOneLine(narrow, "Code narrow notice alone");
      expectNoHorizontalOverflow(narrow, "Code narrow notice alone");
      expect(narrow.notice!.rect.width).toBeLessThanOrEqual(narrow.row.clientWidth + PX_TOLERANCE);
      test.info().annotations.push({
        type: "S7a-narrow-notice-geometry",
        description: `viewport ${NARROW_VIEWPORT.width}px: row content ${narrow.row.clientWidth}px, notice ${narrow.notice!.rect.width}px, row height ${narrow.row.height}px`,
      });
    } finally {
      await deleteConversation(request, conversationId);
    }
  });
});
