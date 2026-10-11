import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * The scroll-to-latest control must drive the REAL virtualized scroll container.
 *
 * This spec exists because the control was briefly bound to an assistant-ui
 * viewport context that no longer existed: the button rendered, was clickable,
 * and did nothing. It asserts the control moves the element the transcript
 * actually renders into, so that class of silent no-op cannot come back.
 */

/** Enough persisted messages that the transcript is genuinely scrollable. */
const SEEDED_MESSAGES = 80;

function storedMessage(id: string, parentId: string | null, text: string, role: "user" | "assistant") {
  return {
    id,
    parent_id: parentId,
    format: "ai-sdk/v6",
    content: { role, parts: [{ type: "text", text }] },
  };
}

async function seedConversation(request: APIRequestContext): Promise<string> {
  const created = await request.post("/api/conversations", {
    data: { title: `scroll to latest ${Date.now()}`, workspaceMode: "simple", engine: "direct" },
  });
  const { id } = (await created.json()) as { id: string };
  for (let batch = 0; batch < SEEDED_MESSAGES; batch += 10) {
    await Promise.all(
      Array.from({ length: Math.min(10, SEEDED_MESSAGES - batch) }, (_, offset) => {
        const index = batch + offset;
        return request.post(`/api/conversations/${id}/messages`, {
          data: {
            message: storedMessage(
              `seed-${index}`,
              index === 0 ? null : `seed-${index - 1}`,
              `seeded-body-${index}`,
              index % 2 === 0 ? "user" : "assistant",
            ),
          },
        });
      }),
    );
  }
  return id;
}

test("scroll-to-latest moves the real virtualized scroller", async ({ page, request }) => {
  const conversationId = await seedConversation(request);

  try {
    await page.goto(`/#/chat/${conversationId}`);

    const scroller = page.locator('[data-testid="virtual-transcript-scroller"]');
    // Wait on the newest message's TEXT, not on a row element: the last row of
    // a thread is often a `turn-end` row, which TBAi renders empty, so it has no
    // box and would never satisfy a visibility check.
    await expect(page.getByText(`seeded-body-${SEEDED_MESSAGES - 1}`)).toBeVisible({
      timeout: 30000,
    });
    // Virtualization is active: the mounted rows are a fraction of the logical
    // history, which is the whole point of the architecture.
    const mounted = await rows(page).count();
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(SEEDED_MESSAGES);

    // Park the timeline away from the live end so the control has work to do.
    await page.mouse.move(600, 400);
    await page.mouse.wheel(0, -40000);
    await page.waitForTimeout(400);

    const awayFromEnd = await scroller.evaluate((el) => ({
      top: el.scrollTop,
      height: el.scrollHeight,
      client: el.clientHeight,
    }));
    const distanceFromEnd =
      awayFromEnd.height - awayFromEnd.top - awayFromEnd.client;
    expect(distanceFromEnd, "timeline is away from the live end").toBeGreaterThan(24);

    const control = page.getByRole("button", { name: /scroll to bottom/i });
    await expect(control).toBeVisible();
    await control.click();

    // The SAME element the transcript renders into must now be at its end.
    // `scrollToEnd` is the library's own call, and it is smooth, so the
    // assertion polls rather than sampling once.
    await expect
      .poll(
        async () =>
          scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight),
        { timeout: 8000 },
      )
      .toBeLessThanOrEqual(24);
  } finally {
    await request.delete(`/api/conversations/${conversationId}`).catch(() => undefined);
  }
});

/** Mounted virtual rows. Far fewer than the logical history, by design. */
const rows = (page: import("@playwright/test").Page) =>
  page.locator("[data-row-key]");
