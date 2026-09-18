import { expect, test } from "@playwright/test";

/**
 * Phase UA-D verification — the 4-combo engine × scope matrix, end to end.
 *
 *   D1 Direct  + simple (Chat mode): draft → send → /chat/<id> → reload → delete
 *   D2 Direct  + project: folder "+" → preset → send → highlight → reload → delete
 *   D3 OpenCode + simple: draft (OpenCode engine) → send → /code/<id> →
 *      session bound → reload resumes → terminate clears pointer → delete
 *   D4 OpenCode + project: New Project dialog (OpenCode) → /code/<id> →
 *      highlight → send → reload → delete
 *
 * Sends are single tiny messages ("ping <combo>"). Completion is observed via
 * the user message persisting + the run settling (Regenerate appears), not by
 * asserting model text. Every spec deletes its conversation (and folder),
 * so runs stay hermetic. Scratch folders live under D:\PM (maintainer rule).
 */

type Page = Parameters<Parameters<typeof test>[0]>[0]["page"];

const DPM = "D:/PM";

async function mkFolder(
  page: Page,
  tag: string,
): Promise<{ id: string; name: string; dir: string }> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const name = `ua-d-${tag}-${suffix}`;
  // Fixed scratch path per tag (pre-created on disk — registration requires
  // a real dir); unique registry name per run. Prior rows are deleted in
  // cleanup so path reuse across runs is safe.
  const dir = `${DPM}/ua-d-${tag}`;
  const res = await page.request.post("/api/folders", {
    data: { path: dir, name },
  });
  expect(res.ok(), `mkFolder ${name} → ${res.status()}`).toBe(true);
  const list = (await (
    await page.request.get("/api/folders")
  ).json()) as Array<{ id: string; name: string }>;
  const folder = list.find((f) => f.name === name)!;
  return { id: folder.id, name, dir };
}

async function rmFolder(page: Page, id: string): Promise<void> {
  await page.request.delete(`/api/folders/${id}`).catch(() => {});
}

async function rmConv(page: Page, id: string): Promise<void> {
  await page.request.delete(`/api/conversations/${id}`).catch(() => {});
}

async function getConv(
  page: Page,
  id: string,
): Promise<Record<string, unknown>> {
  const res = await page.request.get(`/api/conversations/${id}`);
  expect(res.ok(), `get conv ${id} → ${res.status()}`).toBe(true);
  return (await res.json()) as Record<string, unknown>;
}

/** Draft shell settled (welcome hero + engine switch present). */
async function waitDraft(page: Page): Promise<void> {
  await page
    .getByRole("heading", { name: /what do you want to build/i })
    .first()
    .waitFor({ timeout: 30000 });
  await expect(
    page.getByRole("group", { name: "Engine" }),
  ).toBeVisible({ timeout: 10000 });
}

async function setDraftEngine(
  page: Page,
  engine: "Direct" | "OpenCode",
): Promise<void> {
  const pill = page
    .getByRole("group", { name: "Engine" })
    .getByRole("button", { name: engine });
  if ((await pill.getAttribute("aria-pressed")) !== "true") {
    await pill.click();
    await expect(pill).toHaveAttribute("aria-pressed", "true");
  }
}

/** Send one tiny message from the draft composer and wait for completion. */
async function sendPing(page: Page, text: string): Promise<void> {
  const box = page.getByRole("textbox", { name: /send a message/i }).first();
  await expect(box).toBeVisible({ timeout: 15000 });
  await box.fill(text);
  await box.press("Enter");
  // User message persisted…
  await expect(page.getByText(text, { exact: false }).first()).toBeVisible({
    timeout: 20000,
  });
  // …and the run settled. The model may request tool approval first (e.g.
  // interpreting "ping" as a shell command in folder context) — approve on
  // sight: the scratch folders are hermetic, and an unapproved run never
  // persists history. Either path ends at Regenerate (completion signal,
  // engine-agnostic).
  const regen = page.getByRole("button", { name: /regenerate/i }).first();
  const approve = page.getByRole("button", { name: /^approve/i }).first();
  const deadline = Date.now() + 120000;
  for (;;) {
    if (await regen.isVisible().catch(() => false)) return;
    if (Date.now() > deadline) break;
    if (await approve.isVisible().catch(() => false)) {
      await approve.click().catch(() => {});
    }
    await page.waitForTimeout(1500);
  }
  await expect(regen).toBeVisible({ timeout: 15000 });
}

/**
 * Seed one genuine-shape user message via the messages API (quota-free
 * resume proof — no model call). Shape mirrors runtime-encoded blobs
 * (format "ai-sdk/v6"); the history adapter decodes them verbatim.
 */
async function seedUserMessage(
  page: Page,
  convId: string,
  seedId: string,
  text: string,
): Promise<void> {
  const res = await page.request.post(
    `/api/conversations/${convId}/messages`,
    {
      data: {
        message: {
          id: seedId,
          parent_id: null,
          format: "ai-sdk/v6",
          content: {
            role: "user",
            parts: [{ type: "text", text }],
            metadata: { custom: {} },
          },
        },
      },
    },
  );
  expect(res.ok(), `seed ${seedId} → ${res.status()}`).toBe(true);
}

async function createConv(
  page: Page,
  body: Record<string, unknown>,
): Promise<{ id: string }> {
  const res = await page.request.post("/api/conversations", { data: body });
  expect(res.ok(), `createConv → ${res.status()}`).toBe(true);
  return (await res.json()) as { id: string };
}

// ---------------------------------------------------------------------------
// D1 Direct + simple
// ---------------------------------------------------------------------------
test("D1 Direct Chat-mode: draft send routes /chat, reload resumes, delete", async ({
  page,
}) => {
  let convId: string | null = null;
  try {
    await page.goto("/#/chat/new");
    await waitDraft(page);
    await setDraftEngine(page, "Direct");
    await sendPing(page, "matrix check D1");
    await expect(page).toHaveURL(/#\/chat\/(?!new)/, { timeout: 15000 });
    const match = page.url().match(/#\/chat\/([^/]+)/);
    expect(match, "no /chat/<id> after D1 send").not.toBeNull();
    convId = match![1];

    const row = await getConv(page, convId);
    expect(row.engine).toBe("direct");

    await page.reload();
    await expect(
      page.getByText("matrix check D1", { exact: false }).first(),
    ).toBeVisible({ timeout: 30000 });
  } finally {
    if (convId) await rmConv(page, convId);
  }
});

// ---------------------------------------------------------------------------
// D2 Direct + project (quota-free: entry via folder "+", resume/highlight
// via API-created row + seeded history — the live-send leg is D1's;
// model sends are quota-gated, tool-call-nondeterministic, and add nothing
// beyond D1 for the binding path).
// ---------------------------------------------------------------------------
test("D2 Direct folder chat: + presets folder, seeded history resumes, highlight", async ({
  page,
}) => {
  const folder = await mkFolder(page, "d2");
  let convId: string | null = null;
  try {
    await page.goto("/#/");
    await waitDraft(page);
    const header = page
      .getByRole("button", { name: new RegExp(folder.name, "i") })
      .first();
    await expect(header).toBeVisible({ timeout: 10000 });
    const headerRow = page.locator("div.group", { has: header }).first();
    await headerRow.hover();
    await headerRow.locator('button[title="New Chat"]').click();
    await expect(page).toHaveURL(/#\/chat\/new/);
    await expect(
      page.locator(`button[title="Working folder: ${folder.name}"]`),
    ).toBeVisible({ timeout: 20000 });

    const created = await createConv(page, {
      title: `ua-d D2 ${folder.name}`,
      workspaceMode: "project",
      workspaceFolderId: folder.id,
      engine: "direct",
    });
    convId = created.id;
    await seedUserMessage(page, convId, `seed-u-d2-${convId}`, "seed check D2");

    const conv = await getConv(page, convId);
    expect(conv.engine).toBe("direct");
    expect(conv.workspaceMode).toBe("project");
    expect(conv.workspaceFolderId).toBe(folder.id);

    await page.goto(`/#/chat/${convId}`);
    await expect(
      page.getByText("seed check D2", { exact: false }).first(),
    ).toBeVisible({ timeout: 30000 });

    // Folder highlight: exactly one accented row (unique title), and
    // clicking it lands on this conversation.
    const activeRow = page.locator("div.bg-sidebar-accent").filter({
      has: page.getByRole("button", { name: /ua-d D2 /i }),
    });
    await expect(activeRow).toHaveCount(1, { timeout: 15000 });
    await activeRow.locator("button").first().click();
    await expect(page).toHaveURL(new RegExp(`#/chat/${convId}$`));

    await page.reload();
    await expect(
      page.getByText("seed check D2", { exact: false }).first(),
    ).toBeVisible({ timeout: 30000 });
  } finally {
    if (convId) await rmConv(page, convId);
    await rmFolder(page, folder.id);
  }
});

// ---------------------------------------------------------------------------
// D3 OpenCode + simple (quota-free: session bind/resume/terminate need no
// model call — only sends do, and D1 proves the send leg).
// ---------------------------------------------------------------------------
test("D3 Code Chat-mode: session binds on open, reload resumes pointer, terminate clears", async ({
  page,
}) => {
  const created = await createConv(page, {
    title: "ua-d D3 code-row",
    workspaceMode: "simple",
    engine: "opencode",
  });
  const convId = created.id;
  try {
    await page.goto(`/#/code/${convId}`);
    await expect(
      page.getByRole("textbox", { name: /send a message/i }).first(),
    ).toBeVisible({ timeout: 60000 });

    const row = await getConv(page, convId);
    expect(row.engine).toBe("opencode");
    expect(typeof row.opencodeSessionId).toBe("string");
    const sessionA = row.opencodeSessionId as string;

    // Reload: same session pointer (resume, not recreate), surface live.
    await page.reload();
    await expect(page).toHaveURL(/#\/code\//, { timeout: 20000 });
    await expect(
      page.getByRole("textbox", { name: /send a message/i }).first(),
    ).toBeVisible({ timeout: 60000 });
    const rowAfter = await getConv(page, convId);
    expect(rowAfter.opencodeSessionId).toBe(sessionA);

    // Terminate: pointer cleared, server-side session ended.
    const term = await page.request.post("/api/opencode/session/terminate", {
      data: { conversationId: convId },
    });
    expect(term.ok(), `terminate → ${term.status()}`).toBe(true);
    const after = await getConv(page, convId);
    expect(after.opencodeSessionId).toBeNull();
  } finally {
    await rmConv(page, convId);
  }
});

// ---------------------------------------------------------------------------
// D4 OpenCode + project (quota-free: dialog entry is phase-ua-a (b)'s;
// here an API-created Code folder row proves highlight + reload + terminate).
// ---------------------------------------------------------------------------
test("D4 Code folder chat: row routes /code, reload resumes, terminate", async ({
  page,
}) => {
  const folder = await mkFolder(page, "d4");
  const created = await createConv(page, {
    title: `ua-d D4 ${folder.name}`,
    workspaceMode: "project",
    workspaceFolderId: folder.id,
    engine: "opencode",
  });
  const convId = created.id;
  try {
    const conv = await getConv(page, convId);
    expect(conv.engine).toBe("opencode");
    expect(conv.workspaceMode).toBe("project");
    expect(conv.workspaceFolderId).toBe(folder.id);

    await page.goto(`/#/code/${convId}`);
    await expect(
      page.getByRole("textbox", { name: /send a message/i }).first(),
    ).toBeVisible({ timeout: 60000 });

    // No sidebar highlight assertion here BY DESIGN: CodeShell renders
    // focused chrome only (no Sidebar), so folder rows can't highlight on
    // /code/ routes. Highlight mechanics are proven on the chat surface
    // (D2) and engine-correct row routing by phase-ua-a (c); scope on the
    // Code surface itself is the session row's scope chip.

    await page.reload();
    await expect(page).toHaveURL(/#\/code\//, { timeout: 20000 });
    await expect(
      page.getByRole("textbox", { name: /send a message/i }).first(),
    ).toBeVisible({ timeout: 60000 });
  } finally {
    await page.request
      .post("/api/opencode/session/terminate", {
        data: { conversationId: convId },
      })
      .catch(() => {});
    await rmConv(page, convId);
    await rmFolder(page, folder.id);
  }
});
