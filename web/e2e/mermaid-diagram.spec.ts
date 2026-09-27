import { expect, test } from "@playwright/test";

/**
 * A fenced mermaid block in an assistant reply renders as a diagram.
 *
 * This is the first real browser coverage for the element. Everything before it
 * was structural: typecheck plus a read of the generated source. The assertions
 * that matter here are behavioural and could not be proven any other way:
 *
 * 1. The diagram MOUNTS and produces an actual SVG element. Upstream renders
 *    synchronously via beautiful-mermaid, so a real render is observable in the
 *    DOM. A missing svg means the renderer silently produced nothing.
 * 2. The fence is consumed as a diagram, NOT left as a code block. Both can be
 *    true at once if the language override fails to apply, which would look
 *    like success on assertion 1 alone.
 * 3. Malformed source degrades to the raw source plus a notice instead of
 *    blanking the message. That is the whole reason the parse is guarded.
 *
 * The message is SEEDED through the conversations API rather than streamed,
 * because the streaming path needs a live provider. Seeding also means the part
 * is already complete, so this measures the settled render; the streaming
 * skeleton is a property of the element, not of this wiring.
 *
 * NOTE: no backticks in this comment - the spec transform mis-parses them and
 * reports the file as unbuildable.
 *
 * SYNTAX CAVEAT, measured not assumed and now handled: the element renders
 * through beautiful-mermaid, which accepts a SUBSET of mermaid and validates the
 * diagram header strictly. Probed directly against the installed package:
 *
 *   graph TD                     -> renders
 *   graph TD;                    -> Invalid mermaid header
 *   graph TD\n  A --> B;         -> renders (semicolons in the BODY are fine)
 *   sequenceDiagram;             -> renders (only graph/flowchart are strict)
 *
 * mermaid-source.tsx normalises the header before it reaches the renderer, so
 * the semicolon form models commonly emit now renders. The last test is the
 * regression guard for that. The one form still not handled is a body sharing
 * the header line, which the renderer rejects outright.
 */
const FENCE = "```";
const MERMAID_BLOCK = [
  FENCE + "mermaid",
  "flowchart TD",
  "  A[Start] --> B[Done]",
  FENCE,
].join("\n");

/** A valid diagram that this renderer REJECTS, to pin the limitation. */
const SEMICOLON_BLOCK = [
  FENCE + "mermaid",
  "graph TD;",
  "  A[Start] --> B[Done];",
  FENCE,
].join("\n");

const BROKEN_BLOCK = [FENCE + "mermaid", "graph TD; A[[[-->", FENCE].join("\n");

/** Create a Direct conversation and append one user turn. */
async function seedConversation(
  request: import("@playwright/test").APIRequestContext,
  label: string,
): Promise<string> {
  const created = await request.post("/api/conversations", {
    data: { title: label, workspaceMode: "simple", engine: "direct" },
  });
  expect(created.ok()).toBe(true);
  const conversation = (await created.json()) as { id: string };
  const user = await request.post(`/api/conversations/${conversation.id}/messages`, {
    data: {
      message: {
        id: `seed-user-${conversation.id}`,
        parent_id: null,
        format: "ai-sdk/v6",
        content: { role: "user", parts: [{ type: "text", text: "draw the flow" }] },
      },
    },
  });
  expect(user.ok()).toBe(true);
  return conversation.id;
}

/** Append a completed assistant turn carrying `text`. */
async function seedAssistantReply(
  request: import("@playwright/test").APIRequestContext,
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
  expect(reply.ok()).toBe(true);
}

test("a mermaid fence renders as a diagram, not a code block", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);

  const label = `mermaid diagram ${Date.now()}`;
  const conversationId = await seedConversation(request, label);

  try {
    await seedAssistantReply(
      request,
      conversationId,
      `Here is the flow.\n\n${MERMAID_BLOCK}\n`,
    );

    await page.goto(`/#/chat/${conversationId}`);
    await expect(
      page.getByRole("textbox", { name: /Send a message/i }).first(),
    ).toBeVisible({ timeout: 30000 });

    // 1. The diagram mounts and yields a real SVG.
    const diagram = page.locator('[data-slot="mermaid-diagram"]');
    await expect(diagram).toBeVisible({ timeout: 30000 });
    await expect(diagram.locator("svg")).toHaveCount(1, { timeout: 30000 });

    // 2. The fence was consumed as a diagram, not also left as a code block.
    await expect(page.locator("code.language-mermaid")).toHaveCount(0);

    // The prose around the fence still renders as ordinary markdown.
    await expect(page.getByText("Here is the flow.")).toBeVisible();

    // The zoom affordance is part of the element, so its presence also proves
    // the full component mounted rather than a bare SVG.
    await expect(
      page.getByRole("button", { name: "Expand diagram" }),
    ).toBeAttached();
  } finally {
    await request.delete(`/api/conversations/${conversationId}`).catch(() => {});
  }
});

test("malformed mermaid falls back to the source instead of blanking", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);

  const label = `mermaid broken ${Date.now()}`;
  const conversationId = await seedConversation(request, label);

  try {
    await seedAssistantReply(
      request,
      conversationId,
      `Broken one.\n\n${BROKEN_BLOCK}\n`,
    );

    await page.goto(`/#/chat/${conversationId}`);
    await expect(
      page.getByRole("textbox", { name: /Send a message/i }).first(),
    ).toBeVisible({ timeout: 30000 });

    // The fallback carries the notice AND the original source, so the reader can
    // see what failed. The message must not be swallowed.
    await expect(page.locator('[data-slot="mermaid-fallback"]')).toBeVisible({
      timeout: 30000,
    });
    await expect(
      page.getByText("diagram could not be rendered"),
    ).toBeVisible();
    // The surrounding text still renders, proving the failure was contained.
    await expect(page.getByText("Broken one.")).toBeVisible();
  } finally {
    await request.delete(`/api/conversations/${conversationId}`).catch(() => {});
  }
});

test("a semicolon-terminated header renders (normalised, not rejected)", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);

  // Previously this asserted the FALLBACK: the renderer rejects a "graph TD;"
  // header and models emit that form constantly, so the user saw the fallback
  // panel for a perfectly valid diagram. mermaid-source.tsx now normalises the
  // header before it reaches the renderer, so the same input must render.
  //
  // This is the regression guard for that fix: if the normaliser is removed or
  // narrowed too far, this goes back to the fallback and fails here.
  const label = `mermaid semicolon ${Date.now()}`;
  const conversationId = await seedConversation(request, label);

  try {
    await seedAssistantReply(request, conversationId, `Semi.\n\n${SEMICOLON_BLOCK}\n`);

    await page.goto(`/#/chat/${conversationId}`);
    await expect(
      page.getByRole("textbox", { name: /Send a message/i }).first(),
    ).toBeVisible({ timeout: 30000 });

    const diagram = page.locator('[data-slot="mermaid-diagram"]');
    await expect(diagram).toBeVisible({ timeout: 30000 });
    await expect(diagram.locator("svg")).toHaveCount(1, { timeout: 30000 });
    // And it must NOT have degraded on the way through.
    await expect(page.locator('[data-slot="mermaid-fallback"]')).toHaveCount(0);
  } finally {
    await request.delete(`/api/conversations/${conversationId}`).catch(() => {});
  }
});
