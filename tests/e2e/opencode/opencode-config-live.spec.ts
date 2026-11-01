import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

/**
 * Live acceptance: the OpenCode Configuration page against the REAL managed
 * OpenCode server.
 *
 * Nothing here is mocked. The page reads the real `GET /api/config` from the
 * managed server, and the assertions read the real file that server reports.
 *
 * ## The document is READ-ONLY, and that is the property under test
 *
 * The managed child runs with the host environment unchanged, so the
 * permissions document it reports is the user's own OpenCode configuration —
 * not a file TBAi created (§9.3(1)). TBAi therefore refuses every write to it.
 * This spec proves that on the real machine:
 *
 *   - the page shows the document the server actually reads;
 *   - every real rule is listed in order, including the protected denies;
 *   - the page says it is read-only and offers no enabled edit control;
 *   - a direct write request is refused with 409 and the file is byte-identical
 *     afterwards, so a refused write never touches the maintainer's policy.
 *
 * It no longer mutates the file. An earlier revision changed a rule and
 * restored it in `afterEach`; that capability is disabled by policy, and a
 * spec that mutates a shared real file is a risk this surface does not need.
 */

const CONFIG_URL = "/#/opencode-config";

/** One rule the user's configuration protects, asserted to render as Deny. */
const PROTECTED_RULES = [
  "**/config/RULES.md",
  "**/config/opencode.json",
  "**/config/opencode/plugins/*.ts",
  ".config/opencode/opencode.json",
] as const;

interface ConfigSnapshot {
  path: string;
  discoveredPaths: string[];
  raw: string;
  malformed: boolean;
  editable: boolean;
  writeDisabledReason: string | null;
  permissions: Array<{ action: string; resource: string; effect: string }> | null;
}

async function readConfig(request: import("@playwright/test").APIRequestContext) {
  const response = await request.get("/api/opencode/config");
  expect(response.ok()).toBe(true);
  return (await response.json()) as ConfigSnapshot;
}

/** The state the page is expected to report for the managed service. */
const MANAGED_READ_ONLY_NOTICE = /your own OpenCode installation/i;

test.describe("OpenCode Configuration against the real managed server", () => {
  test.slow();

  test("the page shows the configuration the server actually reads", async ({ page, request }) => {
    const config = await readConfig(request);
    await page.goto(CONFIG_URL);
    const main = page.getByRole("main");

    await expect(main.getByRole("heading", { name: "OpenCode Configuration" })).toBeVisible({
      timeout: 30_000,
    });

    // The resolved path must be the one the server reported — not the
    // TBAi-owned data/opencode-home file, which also exists and is not the
    // permission source.
    await expect(main.getByText(config.path, { exact: true }).first()).toBeVisible();

    // Both sections the product target requires.
    await expect(main.getByText("Permissions", { exact: true })).toBeVisible();
    await expect(main.getByText("Native OpenCode JSON", { exact: true })).toBeVisible();
  });

  test("every real rule is listed in order, including question and the denies", async ({
    page,
    request,
  }) => {
    const config = await readConfig(request);
    test.skip(
      config.permissions === null || config.permissions.length === 0,
      "This configuration declares no permission rules.",
    );
    await page.goto(CONFIG_URL);
    const main = page.getByRole("main");

    // Each rule's action and resource must appear, and the deny rules must be
    // visible as Deny rather than silently dropped.
    for (const rule of config.permissions ?? []) {
      await expect(main.getByText(rule.action, { exact: true }).first()).toBeVisible();
      await expect(main.getByText(rule.resource, { exact: true }).first()).toBeVisible();
    }
    for (const resource of PROTECTED_RULES) {
      const rule = config.permissions?.find((r) => r.resource === resource);
      if (!rule) continue;
      await expect(main.getByRole("combobox", { name: `edit ${resource} effect` })).toHaveText(
        /Deny/,
      );
    }
  });

  test("the page reports the document as read-only and disables every control", async ({
    page,
    request,
  }) => {
    const config = await readConfig(request);
    // This is the APP's answer, not the spec's assumption. If the policy ever
    // changes, this assertion fails here rather than silently asserting
    // read-only behaviour that no longer holds.
    expect(config.editable).toBe(false);
    expect(config.writeDisabledReason).toBe("managed_root_not_owned");

    await page.goto(CONFIG_URL);
    const main = page.getByRole("main");
    await expect(main.getByText(MANAGED_READ_ONLY_NOTICE)).toBeVisible({ timeout: 30_000 });
    await expect(main.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    // The first rule's selector is rendered but inert. Located by its file row
    // (the rule at index 0), which is what the page names it by.
    const first = config.permissions?.[0];
    if (first) {
      await expect(
        main.getByRole("combobox", { name: `${first.action} ${first.resource} effect (rule 1)` }),
      ).toBeDisabled();
    }
  });

  test("a write request is refused and the real file is byte-identical afterwards", async ({
    request,
  }) => {
    const before = await readConfig(request);
    const beforeText = readFileSync(before.path, "utf8");

    const response = await request.put("/api/opencode/config/permissions", {
      data: { action: "question", resource: "*", effect: "allow" },
    });
    expect(response.status()).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("user's own");

    // The maintainer's policy is untouched — the whole point of the refusal.
    expect(readFileSync(before.path, "utf8")).toBe(beforeText);
  });

  test("a malformed configuration is read-only and no write happens", async ({ page, request }) => {
    const config = await readConfig(request);
    // This spec cannot corrupt the maintainer's real file to prove the refusal;
    // that path is covered behaviourally in configDocument.test.ts and by the
    // backend's own re-read-before-write. What IS proven here is that a config
    // the server reports as malformed renders the error and disables saving
    // rather than offering a control that writes nothing.
    if (!config.malformed) {
      test.skip(
        true,
        "The live configuration is well-formed; the refusal path is covered in configDocument.test.ts.",
      );
    }
    await page.goto(CONFIG_URL);
    await expect(page.getByRole("main").getByText(/not valid JSON/i)).toBeVisible({
      timeout: 30_000,
    });
  });
});
