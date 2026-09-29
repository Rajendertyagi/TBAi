import { expect, test, type APIRequestContext } from "@playwright/test";
import { toolsConfig } from "../src/config/tools";
import { removeConversation, seedConversation } from "./helpers/seedConversation";

/**
 * A settled Markdown code fence is bounded BEFORE it reaches the highlighter.
 *
 * This is the browser proof for `code-budget.tsx`. Everything else about that
 * fix is a pure-function or source-level test, and both of those kinds can be
 * green while the marker never reaches the screen - a wrapper that computes a
 * bound and forgets to render it, or a slot registered somewhere the library
 * never reads. Only a real render distinguishes those from a working fix, and
 * this is the same reasoning the mermaid spec records.
 *
 * What each assertion proves, and why it could not be proven elsewhere:
 *
 * 1. A fence exactly AT the line limit renders complete with no marker. This is
 *    the off-by-one case: a fence that only just fits is the one most likely to
 *    be cut by a wrong comparison, and the least likely to be noticed.
 * 2. A fence over the limit is cut and the marker is VISIBLE. A CSS
 *    `max-height` would satisfy "the tall block looks shorter" while still
 *    paying the full Shiki tokenization, so the marker - not the height - is
 *    what proves the bound ran in the data.
 * 3. The first OMITTED line is absent from the document. Clipping leaves the
 *    node in the DOM and still pays for it, so this is the assertion that
 *    separates truncation from any visual trick.
 * 4. The kept prefix is still SYNTAX HIGHLIGHTED, so bounding did not degrade
 *    into a plain pre - the tempting shortcut.
 * 5. Copy still returns the whole fence, because the library renders the code
 *    header from the original text. The marker claims this; the browser
 *    confirms it rather than taking the copy's word for it.
 *
 * The limits are imported from the app's own budget config rather than repeated
 * here, so retuning the budget does not silently leave this spec asserting a
 * number that no longer applies.
 *
 * Messages are SEEDED through the conversations API rather than streamed, for
 * the reason the mermaid spec gives: the streaming path needs a live provider,
 * and seeding also guarantees the part is settled, which is the state this
 * budget protects.
 *
 * NOTE: no backticks in this comment - the spec transform mis-parses them and
 * reports the file as unbuildable.
 */

const FENCE = "```";
const { codeBlockMaxLines } = toolsConfig.limits;

/** `n` numbered lines, so a specific line can be looked for by its content. */
function numberedLines(n: number): string {
  return Array.from({ length: n }, (_, i) => `const v${i} = ${i};`).join("\n");
}

/** A fenced block, so individual lines stay findable in the rendered text. */
function block(body: string, language = "ts"): string {
  return [FENCE + language, body, FENCE].join("\n");
}

/** Append a completed assistant turn carrying `text`. */
async function seedAssistantReply(
  request: APIRequestContext,
  conversationId: string,
  text: string,
): Promise<void> {
  const reply = await request.post(`/api/conversations/${conversationId}/messages`, {
    data: {
      message: {
        id: `seed-assistant-${conversationId}`,
        parent_id: `seed-user-${conversationId}`,
        format: "ai-sdk/v6",
        content: { role: "assistant", parts: [{ type: "text", text }] },
      },
    },
  });
  if (!reply.ok()) throw new Error(`seed reply failed: ${reply.status()}`);
}

test("a fence at the budget renders complete, and one over is cut with a visible marker", async ({
  page,
  request,
  context,
}) => {
  test.setTimeout(180_000);

  // The marker tells the reader that copying is unaffected, so this spec proves
  // it rather than taking the copy's word for it. Reading the clipboard is
  // permission-gated in Chromium, hence the grant.
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  const label = `code fence budget ${Date.now()}`;
  const { id: conversationId } = await seedConversation(request, {
    title: label,
    withMessage: true,
    messageText: "show me the code",
  });

  try {
    // A fence exactly AT the line limit and one well over it, in one message.
    // Two fences is itself part of the contract: the policy is per fence, so the
    // at-limit one must survive unharmed beside the oversized one.
    const lastAtLimit = `const v${codeBlockMaxLines - 1} = ${codeBlockMaxLines - 1};`;
    const firstOmitted = `const v${codeBlockMaxLines} = ${codeBlockMaxLines};`;

    await seedAssistantReply(
      request,
      conversationId,
      [
        "Prose before both blocks.",
        "",
        block(numberedLines(codeBlockMaxLines)),
        "",
        block(numberedLines(codeBlockMaxLines + 500)),
        "",
        "Prose after both blocks.",
      ].join("\n"),
    );

    await page.goto(`/#/chat/${conversationId}`);
    await expect(
      page.getByRole("textbox", { name: /Send a message/i }).first(),
    ).toBeVisible({ timeout: 30000 });

    // Rendering 2500 lines did not wedge the page. Without a real pre-render
    // bound this is where the tab stops responding, so reaching this line is
    // itself part of the assertion.
    const marker = page.locator(".aui-code-truncated");
    await expect(marker).toHaveCount(1, { timeout: 60000 });
    await expect(marker).toBeVisible();

    // The note belongs to its own block, not floating in the message.
    await expect(marker.locator("xpath=..")).toHaveClass(/aui-code-block/);

    // The marker is honest about what is missing, and says the copy button is
    // unaffected - which assertion 5 then confirms rather than assumes.
    await expect(marker).toContainText("500 more lines");
    await expect(marker).toContainText("Copying still gives the full code");

    const rendered = (await page.locator(".aui-md").innerText()) ?? "";

    // The omitted content is genuinely absent from the document.
    expect(rendered).not.toContain(firstOmitted);

    // The kept prefix is present, and so is the last line of the at-limit
    // fence - the off-by-one case, in the direction that would silently cut
    // code that only just fit.
    expect(rendered).toContain("const v0 = 0;");
    expect(rendered).toContain(lastAtLimit);

    // Prose around the fences is untouched: the budget bounds one fence's own
    // text and cannot reach anything else in the message.
    expect(rendered).toContain("Prose before both blocks.");
    expect(rendered).toContain("Prose after both blocks.");

    // The truncated prefix still went through the highlighter rather than
    // being swapped for a plain pre - the tempting shortcut. Asserted on the
    // Shiki container and its per-line rows: the library's unhighlighted
    // fallback (`DefaultCodeBlockContent`) renders a bare <pre><code> with
    // neither, so their presence is what distinguishes the two.
    //
    // Polled, not read once: Shiki loads a WASM tokenizer, and until it
    // resolves the element renders plain code by design. Reading once caught
    // that race and reported zero rows on some browsers.
    const truncatedBlock = marker.locator("xpath=..");
    const highlightedLines = truncatedBlock.locator(".aui-shiki-base .line");
    await expect.poll(() => highlightedLines.count()).toBeGreaterThan(0);
    expect(await highlightedLines.count()).toBeLessThanOrEqual(
      toolsConfig.limits.codeBlockMaxLines,
    );

    // Copy still yields the whole fence, omitted lines included. The LAST copy
    // button, not the first: the library renders each fence's header as a
    // sibling of the code rather than inside a shared container, so the only
    // way to pick a specific block's button is by position. The message is
    // built above in a known order, so the last button belongs to the oversized
    // fence - which is the one whose completeness is being claimed.
    await page.evaluate(() => navigator.clipboard.writeText(""));
    await page.getByRole("button", { name: /copy/i }).last().click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toContain(firstOmitted);
  } finally {
    await removeConversation(request, conversationId);
  }
});

test("ordinary small code is untouched - no marker, no truncation", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);

  const label = `code fence untouched ${Date.now()}`;
  const { id: conversationId } = await seedConversation(request, {
    title: label,
    withMessage: true,
    messageText: "show me the code",
  });

  try {
    await seedAssistantReply(
      request,
      conversationId,
      ["A short snippet.", "", block("const a = 1;\nconst b = 2;")].join("\n"),
    );

    await page.goto(`/#/chat/${conversationId}`);
    await expect(
      page.getByRole("textbox", { name: /Send a message/i }).first(),
    ).toBeVisible({ timeout: 30000 });

    // The budget costs nothing when it is not needed: no marker at all.
    await expect(page.locator(".aui-code-truncated")).toHaveCount(0);
    await expect(page.getByText("A short snippet.")).toBeVisible();
    await expect(page.getByText("const a = 1;")).toBeVisible();
    await expect(page.getByText("const b = 2;")).toBeVisible();

    // Still highlighted, and the language label is unchanged. Polled for the
    // same WASM reason as the other spec.
    await expect
      .poll(() => page.locator(".aui-shiki-base .line").count())
      .toBe(2);
    await expect(page.locator(".aui-code-header-language")).toHaveText("ts");
  } finally {
    await removeConversation(request, conversationId);
  }
});
