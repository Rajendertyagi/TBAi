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

/**
 * Persisted message ids must be unique across the WHOLE database, not merely
 * within a conversation. The shared `seedTextConversation` helper namespaces
 * them with `seedPrefix()` for exactly this reason; this spec's own seeder did
 * not, and it also ignored the POST result entirely, so a rejected write was
 * invisible and simply left a hole in the history. A missing `seeded-body-79`
 * is indistinguishable at the assertion site from a row that never mounted, so
 * the write is verified here rather than assumed.
 */
async function seedConversation(request: APIRequestContext): Promise<string> {
  const created = await request.post("/api/conversations", {
    data: { title: `scroll to latest ${Date.now()}`, workspaceMode: "simple", engine: "direct" },
  });
  if (!created.ok()) throw new Error(`seed conversation failed: ${created.status()}`);
  const { id } = (await created.json()) as { id: string };

  const failures: string[] = [];
  // One prefix per seed call, so ids are unique across the whole database while
  // the parent chain stays linear - the Direct history window pages by parent id.
  const prefix = `stl-${Math.random().toString(36).slice(2, 10)}`;
  for (let batch = 0; batch < SEEDED_MESSAGES; batch += 10) {
    await Promise.all(
      Array.from({ length: Math.min(10, SEEDED_MESSAGES - batch) }, (_, offset) => {
        const index = batch + offset;
        return request
          .post(`/api/conversations/${id}/messages`, {
            data: {
              message: storedMessage(
                `${prefix}-${index}`,
                index === 0 ? null : `${prefix}-${index - 1}`,
                `seeded-body-${index}`,
                index % 2 === 0 ? "user" : "assistant",
              ),
            },
          })
          .then((res) => {
            if (!res.ok()) failures.push(`seeded-body-${index}: HTTP ${res.status()}`);
          });
      }),
    );
  }
  if (failures.length > 0) {
    throw new Error(`history seeding rejected ${failures.length} write(s): ${failures.join(", ")}`);
  }
  return id;
}

test("scroll-to-latest moves the real virtualized scroller", async ({ page, request }) => {
  // Sibling virtualizer specs budget 180-240s. This one seeds 80 messages over
  // HTTP before it navigates, and its expectations below are generous on their
  // own; without an explicit budget it silently inherits Playwright's 30s
  // default, which is the SAME number as the largest `expect` timeout below -
  // so the test can hit the harness limit while an expectation is still polling
  // and report a timeout instead of the real cause.
  test.setTimeout(180_000);

  // Every non-2xx response the page sees, so a failure can say whether the
  // history ever arrived rather than only that the text was not on screen.
  const httpFailures: string[] = [];
  page.on("response", (res) => {
    if (res.status() >= 400) httpFailures.push(`${res.status()} ${res.url()}`);
  });

  const conversationId = await seedConversation(request);

  try {
    await page.goto(`/#/chat/${conversationId}`);

    const scroller = page.locator('[data-testid="virtual-transcript-scroller"]');
    try {
      // Wait on the newest message's TEXT, not on a row element: the last row of
      // a thread is often a `turn-end` row, which TBAi renders empty, so it has
      // no box and would never satisfy a visibility check.
      await expect(page.getByText(`seeded-body-${SEEDED_MESSAGES - 1}`)).toBeVisible({
        timeout: 30000,
      });
    } catch (cause) {
      // "element not found" has two very different causes: the message was never
      // persisted, or it was persisted but its row never mounted because the
      // transcript is not at the live end. They need opposite fixes, so the
      // diagnosis is attached rather than left to a retry.
      const mounted = await rows(page).count();
      const geometry = await page
        .locator('[data-testid="virtual-transcript-scroller"]')
        .evaluate((el) => ({
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          distanceFromEnd: el.scrollHeight - el.scrollTop - el.clientHeight,
        }))
        .catch(() => null);
      const persisted = await request
        .get(`/api/conversations/${conversationId}/messages?direction=backward&limit=100`)
        .then((res) => (res.ok() ? res.text() : `HTTP ${res.status()}`))
        .catch((e: unknown) => `request failed: ${String(e)}`);

      throw new Error(
        `the newest seeded message never became visible.\n` +
          `mountedRows=${mounted} geometry=${JSON.stringify(geometry)}\n` +
          `httpFailures=${JSON.stringify(httpFailures)}\n` +
          `newestTextPresent=${persisted.includes(`seeded-body-${SEEDED_MESSAGES - 1}`)}\n` +
          `windowResponse(first 400)=${persisted.slice(0, 400)}\n` +
          `cause=${String(cause)}`,
      );
    }
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
