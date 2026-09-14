import { expect, test } from "@playwright/test";

/** Seed two snippets directly (isolated marker for cleanup). */
async function seed(
  request: import("@playwright/test").APIRequestContext,
  title: string,
  content: string,
): Promise<string> {
  const res = await request.post("/api/quick-messages", {
    data: { title, content },
  });
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { id: string };
  return body.id;
}

async function cleanup(
  request: import("@playwright/test").APIRequestContext,
): Promise<void> {
  const list = await request.get("/api/quick-messages");
  const items = (await list.json()) as Array<{ id: string; title: string }>;
  for (const item of items) {
    if (item.title.startsWith("e2e-")) {
      await request.delete(`/api/quick-messages/${item.id}`);
    }
  }
}

test("quick messages page manages snippets end to end", async ({ page }) => {
  // Idempotent: clear leftovers from aborted runs before starting.
  await cleanup(page.request);
  await page.goto("/#/quick-messages");
  await expect(
    page.getByRole("heading", { name: "Quick Messages", level: 2 }),
  ).toBeVisible({ timeout: 15000 });

  // Create via UI. Creation is async (POST + reload): wait until the new
  // trailing row (appended last by sort order) is selected before touching
  // the editor, or the fill lands in the previous row's editor and is wiped
  // on selection. Other rows may exist — never assert absolute counts.
  const rows = page.locator('[role="button"][aria-pressed]');
  await page.getByRole("button", { name: "New", exact: true }).click();
  const fresh = rows.last();
  await expect(fresh).toHaveAttribute("aria-pressed", "true", {
    timeout: 15000,
  });
  await expect(fresh).toContainText("Untitled");
  const titleBox = page.getByLabel("Title", { exact: true });
  await expect(titleBox).toBeVisible();
  await titleBox.fill("e2e-hello");
  await page.getByLabel("Content", { exact: true }).fill("Hello from e2e!");
  // Save is dirty-gated: wait for the fill to register as a state change.
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeEnabled({ timeout: 15000 });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("button", { name: "e2e-hello", exact: true })).toBeVisible();

  // Search narrows the list.
  await page.getByPlaceholder("Search by title or content").fill("e2e-hello");
  await expect(page.getByRole("button", { name: "e2e-hello", exact: true })).toBeVisible();

  // Edit + persist across reload.
  await page.getByLabel("Title", { exact: true }).fill("e2e-hello-2");
  // The first save's success toast renders bottom-right over the Save
  // button. Park the mouse away first: Sonner pauses auto-dismiss while
  // hovered, which deadlocks the next click otherwise.
  await page.mouse.move(8, 8);
  await expect(page.getByText("Quick message saved")).toBeHidden({
    timeout: 15000,
  });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("button", { name: "e2e-hello-2", exact: true })).toBeVisible({
    timeout: 15000,
  });

  // Reorder via grip drag: move the second row above the first.
  const secondId = await seed(page.request, "e2e-second", "second body");
  try {
    await page.reload();
    await expect(
      page.getByRole("button", { name: "e2e-second", exact: true }),
    ).toBeVisible({ timeout: 15000 });
    await page.getByPlaceholder("Search by title or content").fill("");
    // Rows locator is shared with the creation step above. Locate our two
    // rows by label (other rows may exist from earlier runs).
    const first = page.getByRole("button", {
      name: "e2e-hello-2",
      exact: true,
    });
    const second = page.getByRole("button", {
      name: "e2e-second",
      exact: true,
    });
    await expect(first).toBeVisible();
    const firstBox = await first.boundingBox();
    const secondBox = await second.boundingBox();
    // Drag the second ROW itself onto the first row. The row div (not the
    // grip button) is the draggable source; dropping onto the first row
    // fires its onDrop with the dragged id.
    await second.hover();
    await page.mouse.down();
    await page.mouse.move(
      firstBox!.x + firstBox!.width / 2,
      firstBox!.y + firstBox!.height / 2,
      { steps: 10 },
    );
    await page.mouse.up();
    await page.waitForTimeout(1000);
    // Relative order of our two rows (other rows may exist — assert
    // adjacency-invariant relative positions, not absolute slots).
    const order = await rows.evaluateAll((els) =>
      els.map((el) => el.getAttribute("aria-label")),
    );
    const firstAt = order.indexOf("e2e-hello-2");
    const secondAt = order.indexOf("e2e-second");
    expect(firstAt).toBeGreaterThanOrEqual(0);
    expect(secondAt).toBeGreaterThanOrEqual(0);
    expect(secondAt).toBeLessThan(firstAt);
  } finally {
    await page.request.delete(`/api/quick-messages/${secondId}`);
  }

  // Delete with confirm.
  await page.getByRole("button", { name: "e2e-hello-2", exact: true }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).last().click();
  // Other rows may exist from earlier runs — assert our row is gone,
  // not that the list is empty.
  await expect(
    page.getByRole("button", { name: "e2e-hello-2", exact: true }),
  ).toHaveCount(0, { timeout: 15000 });

  await cleanup(page.request);
});

test("composer submenu lists saved snippets and inserts one", async ({
  page,
}) => {
  const id = await seed(page.request, "e2e-insert-me", "Inserted snippet body");
  try {
    await page.goto("/#/chat/new");
    await expect(
      page.getByRole("heading", { name: /what do you want to build/i }),
    ).toBeVisible({ timeout: 15000 });

    const box = page.getByRole("textbox", { name: /Send a message/ });
    await box.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Quick messages" }).hover();
    await page.getByRole("menuitem", { name: "e2e-insert-me" }).click();
    await expect(box).toHaveValue("Inserted snippet body");
  } finally {
    await page.request.delete(`/api/quick-messages/${id}`);
  }
});

