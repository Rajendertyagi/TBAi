import { expect, test } from "@playwright/test";
import {
  DEFAULT_SEED_TITLE,
  removeConversation,
  seedConversation,
} from "./helpers/seedConversation";

/**
 * Regression specs for the single-screen new-chat flow:
 * - opening a thread from a non-chat route must keep /chat/<id>
 *   (TabUrlSync used to bounce it to /chat/new — single-writer fix);
 * - the welcome draft shows the engine switch, and the OpenCode engine
 *   swaps the Direct chips for the Agent chip.
 * Read-only navigation + draft UI: no conversation is created here.
 */

test("sidebar thread click from a settings route keeps /chat/<id>", async ({
  page,
}) => {
  // Seeded rather than borrowed. This used to read the conversation list and
  // skip when it was empty, which only worked because an earlier spec had left
  // a conversation behind. Under per-spec isolation the list is always empty, so
  // the spec skipped on every run while still reporting green.
  const { id: target, title } = await seedConversation(page.request);

  try {
    // Start somewhere the chat tab is NOT active, so a lagging TabUrlSync
    // would previously have bounced the navigation to /chat/new.
    await page.goto("/#/providers");
    await expect(page).toHaveURL(/#\/providers/);

    // Scoped to the seeded conversation by its exact title, so the assertion
    // cannot be satisfied by an unrelated row.
    const row = page
      .getByRole("button", { name: title || DEFAULT_SEED_TITLE })
      .first();
    await expect(row).toBeVisible({ timeout: 15000 });
    await row.click();

    await expect(page).toHaveURL(new RegExp(`#/chat/${target}$`), {
      timeout: 15000,
    });
    await expect(
      page.getByRole("textbox", { name: /Send a message/ }),
    ).toBeVisible({ timeout: 15000 });
  } finally {
    await removeConversation(page.request, target);
  }
});

test("welcome draft engine switch swaps Direct chips for the Agent chip", async ({
  page,
}) => {
  await page.goto("/#/chat/new");
  await expect(
    page.getByRole("heading", { name: /what do you want to build/i }),
  ).toBeVisible({ timeout: 15000 });

  // Engine switch above the composer (CodeG agent-selector slot).
  const engineGroup = page.getByRole("group", { name: "Engine" });
  await expect(engineGroup).toBeVisible();
  await expect(
    engineGroup.getByRole("button", { name: "Direct" }),
  ).toHaveAttribute("aria-pressed", "true");

  // Direct draft: exactly one Bot chip (the Direct model chip; thinking is
  // Brain), Agent chip absent. OpenCode's Agent + Model chips both render
  // Bot, so the engine swap reads as Bot count 1 → 2 — asserted structurally
  // below, not by icon identity.
  await expect(page.locator("button:has(.lucide-bot)")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Agent" })).toHaveCount(0);

  // Switch to OpenCode: Agent chip appears, Bot count doubles (Agent +
  // OpenCode-model chips), Brain stays single (one thinking chip either way).
  await engineGroup.getByRole("button", { name: "OpenCode" }).click();
  await expect(
    page.getByRole("button", { name: "Agent" }),
  ).toBeVisible({ timeout: 15000 });
  await expect(page.locator("button:has(.lucide-bot)")).toHaveCount(2);
});

test("opencode capabilities without a CLI reports 503, not a hang", async ({
  page,
}) => {
  // Documents the missing-binary surface the Agent chip renders. Passes
  // whether or not `opencode` is installed: either live capabilities…
  const res = await page.request.get("/api/opencode/capabilities");
  if (res.ok()) {
    const data = (await res.json()) as { agents: unknown[]; models: unknown[] };
    expect(Array.isArray(data.agents)).toBe(true);
    expect(Array.isArray(data.models)).toBe(true);
    return;
  }
  // …or the actionable 503 the preflight produces (never a hang/500).
  expect(res.status()).toBe(503);
  const data = (await res.json()) as { error?: string };
  expect(data.error ?? "").toMatch(/OpenCode CLI not found/);
});
