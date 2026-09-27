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
  // UNIQUE path per run, exactly like phase-ua-a's createFolder (the reference
  // pattern). This used to be a FIXED path per tag (`D:/PM/ua-d-${tag}`) with a
  // unique registry name, which is not hermetic: folder rows upsert by PATH, so
  // every run re-registered the same row and got back the ORIGINAL name and the
  // original folder's accumulated conversations. The test then looked for a
  // header/row by a name the server no longer agreed with, and the conversation
  // it had just created was not the row the sidebar rendered under that folder.
  //
  // The directory is created here, idempotently, rather than assumed to exist:
  // registration requires a real path, so a missing scratch dir made
  // POST /api/folders answer 404 (path_missing) and the test failed for a reason
  // unrelated to the code under test. Relying on pre-created directories made
  // the suite depend on out-of-band machine state - D:\PM\ua-d-d2 existed while
  // ua-d-d4 did not, so D4 failed and D2 passed.
  const dir = `${DPM}/${name}`;
  const fs = await import("node:fs");
  fs.mkdirSync(dir, { recursive: true });
  const res = await page.request.post("/api/folders", {
    data: { path: dir, name },
  });
  expect(res.ok(), `mkFolder ${name} → ${res.status()}`).toBe(true);
  // Take the id from the POST response rather than re-reading /api/folders and
  // matching by name. That second lookup was a race: the row exists but the list
  // read could miss it, and `find(...)` returned undefined so `.id` threw
  // "undefined is not an object" instead of a readable failure. The create
  // response is authoritative and saves a round trip - this is what phase-ua-a's
  // equivalent helper already did.
  const folder = (await res.json()) as { id: string; name?: string };
  return { id: folder.id, name: folder.name ?? name, dir };
}

async function rmFolder(page: Page, id: string, dir?: string): Promise<void> {
  await page.request.delete(`/api/folders/${id}`).catch(() => {});
  // Deleting the folder row does NOT remove the scratch directory `mkFolder`
  // created, so without this every run left another `D:/PM/ua-d-<tag>-<suffix>`
  // behind — the folder list stayed clean but the disk accumulated. Measured 9
  // orphans after a handful of runs. Only ever removes the directory this run
  // created, and only after the row is gone, so it can never delete a path that
  // is still registered.
  if (!dir) return;
  const fs = await import("node:fs");
  await fs.promises
    .rm(dir, { recursive: true, force: true, maxRetries: 3 })
    .catch(() => {
      /* best effort on Windows: a locked handle must not fail the test */
    });
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
  // This test does a live draft send, a reload and a history resume. Playwright's
  // default test budget is 30s, and the resume assertion below alone asks for
  // 30s — so the assertion could never win its own race and the failure surfaced
  // only on the slower headed Edge project, where it looked like a product bug.
  // Matched to D2, which does the same class of work.
  test.setTimeout(180_000);
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
    // 60s, not 30s. Measured: D1 passes 3/3 in isolation but intermittently
    // failed at 30s inside the full suite on the headed Edge project, where it
    // runs a live send plus a reload under accumulated machine load. The
    // behaviour under test is "history resumes after a reload", so the budget
    // has to cover a loaded browser rather than an idle one.
    await expect(
      page.getByText("matrix check D1", { exact: false }).first(),
    ).toBeVisible({ timeout: 60000 });
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
  // This leg creates a conversation through the API while the app is already
  // running, waits for a seeded message to render, and then asserts on sidebar
  // state. That is several real page transitions and two slow first paints, so
  // Playwright's 30s default is not enough headroom. Same convention as
  // opencode-v2-code-route.spec.ts.
  test.setTimeout(180_000);
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

    // Unique per run: `folder.name` carries this run's suffix, so the title is a
    // run-scoped identity for the row. Captured once and reused by the
    // highlight assertion below, so the two can never drift apart.
    const exactTitle = `ua-d D2 ${folder.name}`;
    const created = await createConv(page, {
      title: exactTitle,
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
    // The conversation above was created out-of-band, so the sidebar's
    // conversation list — fetched when the app mounts — has never seen it.
    // Navigating from /#/chat/new to /#/chat/<id> is a same-document hash change
    // and does NOT remount, so without a reload the row this test is about to
    // assert on simply does not exist. Measured: post-load folder header visible
    // without reload = false, and the conversation's row = 0.
    //
    // A real user never hits this because they create the conversation THROUGH
    // the UI, which invalidates the list. This test creates it through the API on
    // purpose (no model call, no quota), so it owes the app the same fresh mount
    // a real creation would have produced. Reloading is the honest equivalent —
    // it weakens no assertion below and asserts nothing about reload behaviour.
    await page.reload();
    await expect(
      page.getByText("seed check D2", { exact: false }).first(),
    ).toBeVisible({ timeout: 30000 });

    // Wait for the folder list to actually LOAD before asserting anything about
    // its highlight. `FolderConversationRow` renders `noConversations` whenever
    // `items.length === 0` and never consults `isLoading`, so a fetch still in
    // flight is indistinguishable from an empty folder. On a slow machine the
    // highlight assertions below ran inside that window and failed for a reason
    // that had nothing to do with the highlight.
    //
    // This waits for the row to EXIST; it does not relax any later assertion.
    const titleButton = page.getByRole("button", { name: exactTitle, exact: true });
    await expect(titleButton.first()).toBeVisible({ timeout: 30000 });

    // Folder highlight. The invariant is IDENTITY: the row for THIS conversation
    // is highlighted, and nothing else is.
    //
    // The count is asserted, not dodged. A project conversation legitimately
    // renders in two independent sidebar sections — under its folder, and in the
    // un-scoped Chats list — and both apply `bg-sidebar-accent` when active.
    // Measured on a clean full load (see the probe numbers in the commit that
    // introduced this): 2 accented rows, both carrying this conversation's
    // title, neither nested in the other. So `toHaveCount(1)` asserted a shape
    // the product never had; the correct number is 2, and pinning it means a
    // regression that duplicates or drops a section fails loudly instead of
    // sliding through a `>= 1`.
    //
    // Matching the exact per-run title (not the loose /ua-d D2 /i pattern) is
    // what stops a row left behind by an earlier run from satisfying this.
    const activeRow = page.locator("div.bg-sidebar-accent").filter({
      has: page.getByRole("button", { name: exactTitle, exact: true }),
    });
    const allAccented = page.locator("div.bg-sidebar-accent");
    await expect(allAccented.first()).toBeVisible({ timeout: 15000 });
    // Exactly the two sections that are supposed to mirror this conversation.
    await expect(allAccented).toHaveCount(2);
    // …and every highlighted row IS this conversation: no stale row from an
    // earlier run, and no unrelated conversation that happens to be open.
    await expect(activeRow).toHaveCount(2);
    // …and it is the right one to click: this title is bound to THIS id.
    await titleButton.first().click();
    await expect(page).toHaveURL(new RegExp(`#/chat/${convId}$`));

    await page.reload();
    await expect(
      page.getByText("seed check D2", { exact: false }).first(),
    ).toBeVisible({ timeout: 30000 });
  } finally {
    if (convId) await rmConv(page, convId);
    await rmFolder(page, folder.id, folder.dir);
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
    await rmFolder(page, folder.id, folder.dir);
  }
});
