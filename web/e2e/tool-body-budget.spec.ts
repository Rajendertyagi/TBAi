import { expect, test, type APIRequestContext } from "@playwright/test";
import { toolsConfig } from "../src/config/tools";
import { removeConversation, seedConversation } from "./helpers/seedConversation";

/**
 * A tool RESULT body is bounded before the card paints it.
 *
 * The browser proof for `body-budget.tsx`. The unit suite and the source guards
 * cover the arithmetic and the seam, and both kinds can be green while the card
 * still paints an unbounded body - which is exactly what happened on the code
 * fence, where the budget was registered in the one place the chat surface
 * overrode, and nothing failed until a browser looked at it.
 *
 * What each assertion proves:
 *
 * 1. An oversized `read_file` result is SHORTENED, and the omission is visible.
 *    `read_file` is the motivating case: it returned the whole file into a
 *    `<pre>` with no limit, and the `max-h-64` on that element only clipped
 *    text that had already been serialised and laid out.
 * 2. The tail of the body is genuinely ABSENT from the document. Clipping
 *    leaves the node in the DOM and still pays for it, so this is the assertion
 *    that separates a bound from a visual trick.
 * 3. The head of the body is present, so the card is not empty and still leads
 *    with the start of the file.
 * 4. The note names what is missing and says the result was shortened, so the
 *    card can never be read as the complete output.
 *
 * The message is SEEDED through the conversations API rather than streamed, for
 * the reason the other specs give: the streaming path needs a live provider, and
 * seeding also guarantees the part is settled.
 *
 * NOTE: no backticks in this comment - the spec transform mis-parses them and
 * reports the file as unbuildable.
 */

/** A row we can look for by content, to tell the head from the tail. */
function bodyLine(i: number): string {
  return `row-${i}`;
}

function numberedBody(n: number): string {
  return Array.from({ length: n }, (_, i) => bodyLine(i)).join("\n");
}

/**
 * Append a completed assistant turn carrying `parts`, verbatim.
 *
 * The tool part is written in the AI SDK UIMessage shape the store reads back:
 * a `tool-<name>` part with its call id, input, output and
 * `output-available` state.
 */
async function seedAssistantTurn(
  request: APIRequestContext,
  conversationId: string,
  parts: unknown[],
): Promise<void> {
  const reply = await request.post(`/api/conversations/${conversationId}/messages`, {
    data: {
      message: {
        id: `seed-assistant-${conversationId}`,
        parent_id: `seed-user-${conversationId}`,
        format: "ai-sdk/v6",
        content: { role: "assistant", parts },
      },
    },
  });
  if (!reply.ok()) throw new Error(`seed reply failed: ${reply.status()}`);
}

/**
 * Expand the collapsed tool group.
 *
 * A seeded tool call loads as a collapsed "1 tool call" summary, so the body is
 * not in the DOM until the group is opened. A live run auto-opens it; a reloaded
 * history does not, so the spec opens it rather than assuming.
 */
async function expandToolGroup(page: import("@playwright/test").Page): Promise<void> {
  const trigger = page.getByRole("button", { name: /tool call/i }).first();
  await expect(trigger).toBeVisible({ timeout: 30000 });
  await trigger.click();
  await expect(page.locator(".aui-tool-body").first()).toBeAttached({ timeout: 30000 });
}

test("an oversized tool result is shortened, and says so", async ({ page, request }) => {
  test.setTimeout(180_000);

  const rows = toolsConfig.limits.toolBodyMaxLines + 300;
  const label = `tool body budget ${Date.now()}`;
  const { id: conversationId } = await seedConversation(request, {
    title: label,
    withMessage: true,
    messageText: "read the file",
  });

  try {
    await seedAssistantTurn(request, conversationId, [
      {
        type: "tool-read_file",
        toolCallId: "call-read-1",
        input: { path: "big.txt" },
        output: { content: numberedBody(rows) },
        state: "output-available",
      },
    ]);

    await page.goto(`/#/chat/${conversationId}`);
    await expect(
      page.getByRole("textbox", { name: /Send a message/i }).first(),
    ).toBeVisible({ timeout: 30000 });
    await expandToolGroup(page);

    const note = page.locator(".aui-tool-body-truncated");
    await expect(note).toHaveCount(1, { timeout: 60000 });
    await expect(note).toBeVisible();

    // 4. The note names what is missing and that the result was shortened, so
    //    the card cannot be read as the complete output.
    await expect(note).toContainText("300 more lines");
    await expect(note).toContainText("shortened");

    const rendered = (await page.locator(".aui-tool-body pre").innerText()) ?? "";

    // 2. The tail is genuinely absent from the document.
    expect(rendered).not.toContain(bodyLine(rows - 1));
    // 3. The head is present, so the card leads with the start of the file.
    expect(rendered).toContain(bodyLine(0));
    // And the bound itself held, in the DOM and not merely in a claim.
    expect(rendered.split("\n").length).toBeLessThanOrEqual(
      toolsConfig.limits.toolBodyMaxLines,
    );
  } finally {
    await removeConversation(request, conversationId);
  }
});

test("an ordinary small tool result is untouched - no note, nothing dropped", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);

  const label = `tool body untouched ${Date.now()}`;
  const { id: conversationId } = await seedConversation(request, {
    title: label,
    withMessage: true,
    messageText: "read the file",
  });

  try {
    await seedAssistantTurn(request, conversationId, [
      {
        type: "tool-read_file",
        toolCallId: "call-read-1",
        input: { path: "small.txt" },
        output: { content: numberedBody(4) },
        state: "output-available",
      },
    ]);

    await page.goto(`/#/chat/${conversationId}`);
    await expect(
      page.getByRole("textbox", { name: /Send a message/i }).first(),
    ).toBeVisible({ timeout: 30000 });

    await expandToolGroup(page);

    // The budget costs nothing when it is not needed: no note at all, and every
    // row still present.
    await expect(page.locator(".aui-tool-body-truncated")).toHaveCount(0);
    const rendered = (await page.locator(".aui-tool-body pre").innerText()) ?? "";
    for (let i = 0; i < 4; i += 1) expect(rendered).toContain(bodyLine(i));
  } finally {
    await removeConversation(request, conversationId);
  }
});
