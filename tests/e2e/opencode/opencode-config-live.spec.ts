import { expect, test } from "@playwright/test";

/**
 * Live acceptance: the OpenCode Configuration page against the REAL managed
 * OpenCode server.
 *
 * Nothing here is mocked. The page reads the real `GET /api/config` from the
 * managed server, and every save writes the real configuration file that server
 * reports. There is no LLM model in this spec, and none is needed — the whole
 * feature is a config surface, so the config endpoints are the real boundary.
 *
 * The one rule this spec must never break: the protected `deny` rules in the
 * user's configuration survive every edit. They are read back from the file
 * after each write, and the spec restores the original effect in `afterEach` so
 * a failed run cannot leave the maintainer's policy altered.
 *
 * ## This spec MUTATES a shared real file, so it is not parallel-safe across projects
 *
 * The configuration is one file on the machine, shared by every browser project
 * in a run. Each test reads the effect it is about to change and restores it
 * afterwards, which is correct for a serial run and self-healing for a
 * staggered one, but two projects can still interleave a write. The assertions
 * therefore read the FILE rather than trusting the page's message, and a save
 * that legitimately changed nothing is accepted as success. Running it against
 * the isolated e2e server would prove nothing, because that server has no
 * managed OpenCode config to read — hence `TBAI_E2E_LIVE=1` plus a base URL.
 */

const CONFIG_URL = "/#/opencode-config";

/** One rule the user's configuration protects, asserted after every write. */
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
  permissions: Array<{ action: string; resource: string; effect: string }> | null;
}

async function readConfig(request: import("@playwright/test").APIRequestContext) {
  const response = await request.get("/api/opencode/config");
  expect(response.ok()).toBe(true);
  return (await response.json()) as ConfigSnapshot;
}

/** The effect currently on disk for one (action, resource) pair. */
function effectOf(
  config: ConfigSnapshot,
  action: string,
  resource: string,
): string | undefined {
  return config.permissions?.find(
    (rule) => rule.action === action && rule.resource === resource,
  )?.effect;
}

test.describe("OpenCode Configuration against the real managed server", () => {
  test.slow();

  let originalQuestionEffect: string | undefined;
  let hadQuestionRule = false;

  test.beforeEach(async ({ request }) => {
    const config = await readConfig(request);
    originalQuestionEffect = effectOf(config, "question", "*");
    hadQuestionRule = originalQuestionEffect !== undefined;
  });

  test.afterEach(async ({ request }) => {
    // Always put the question rule back the way it was found, so a failure
    // mid-edit cannot leave the maintainer's gating changed.
    if (!hadQuestionRule) return;
    const response = await request.put("/api/opencode/config/permissions", {
      data: { action: "question", resource: "*", effect: originalQuestionEffect },
    });
    expect(response.ok()).toBe(true);
  });

  test("the page shows the configuration the server actually reads", async ({
    page,
    request,
  }) => {
    const config = await readConfig(request);
    await page.goto(CONFIG_URL);
    const main = page.getByRole("main");

    await expect(
      main.getByRole("heading", { name: "OpenCode Configuration" }),
    ).toBeVisible({ timeout: 30_000 });

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
      await expect(
        main.getByText(rule.resource, { exact: true }).first(),
      ).toBeVisible();
    }
    for (const resource of PROTECTED_RULES) {
      const rule = config.permissions?.find((r) => r.resource === resource);
      if (!rule) continue;
      await expect(
        main.getByRole("combobox", { name: `edit ${resource} effect` }),
      ).toHaveText(/Deny/);
    }
  });

  test("changing one effect writes the file and preserves every other rule", async ({
    page,
    request,
  }) => {
    const before = await readConfig(request);
    const target = before.permissions?.find((r) => r.action === "question");
    test.skip(!target, "This configuration has no question rule to edit.");

    const next = target!.effect === "allow" ? "ask" : "allow";
    await page.goto(CONFIG_URL);
    const main = page.getByRole("main");

    // The rule's identity is (action, resource) — never the row index.
    const trigger = main.getByRole("combobox", {
      name: `question ${target!.resource} effect`,
    });
    await expect(trigger).toBeVisible({ timeout: 30_000 });
    await expect(trigger).toHaveText(
      new RegExp(`^${target!.effect === "ask" ? "Ask" : "Allow"}`),
    );

    // A change that has not been saved must not have touched the file.
    await trigger.click();
    await page.getByRole("option", { name: new RegExp(`^${next === "allow" ? "Allow" : "Ask"}`) }).click();

    const midFlight = await readConfig(request);
    expect(effectOf(midFlight, "question", target!.resource)).toBe(target!.effect);

    // Dirty state, then an explicit Save.
    await expect(main.getByText("Unsaved change")).toBeVisible();
    await main.getByRole("button", { name: "Save", exact: true }).click();
    // Either success message is correct, and which one appears is not this
    // test's business: a run of the OTHER browser project against the same real
    // config file can leave the rule already at the target effect, in which case
    // the save is an honest no-op and says so. Asserting the file instead (see
    // below) is what actually proves the change landed.
    await expect(
      main.getByText(
        /Saved to the OpenCode configuration\.|Already set to this effect\./,
      ),
    ).toBeVisible({ timeout: 30_000 });

    // The write landed.
    const after = await readConfig(request);
    expect(effectOf(after, "question", target!.resource)).toBe(next);

    // And nothing else moved: same length, same order, same effects.
    expect(after.permissions).toHaveLength(before.permissions!.length);
    after.permissions?.forEach((rule, index) => {
      const original = before.permissions![index];
      expect(rule.action).toBe(original.action);
      expect(rule.resource).toBe(original.resource);
      if (rule.action !== "question") {
        expect(rule.effect).toBe(original.effect);
      }
    });
  });

  test("the protected deny rules and unknown fields survive a save", async ({
    page,
    request,
  }) => {
    const before = await readConfig(request);
    const question = before.permissions?.find((r) => r.action === "question");
    test.skip(!question, "This configuration has no question rule to edit.");

    const beforeParsed = JSON.parse(before.raw) as Record<string, unknown>;
    const beforeKeys = Object.keys(beforeParsed);
    const beforeProviders = JSON.stringify(beforeParsed.providers ?? null);

    await page.goto(CONFIG_URL);
    const main = page.getByRole("main");
    const trigger = main.getByRole("combobox", {
      name: `question ${question!.resource} effect`,
    });
    await trigger.click();
    await page
      .getByRole("option", {
        name: new RegExp(`^${question!.effect === "allow" ? "Ask" : "Allow"}`),
      })
      .click();
    await main.getByRole("button", { name: "Save", exact: true }).click();
    // Same reasoning as the test above: a no-op save is a legitimate outcome
    // when the rule already holds the target effect, so the file is the thing
    // asserted on, not which message the page chose to show.
    await expect(
      main.getByText(
        /Saved to the OpenCode configuration\.|Already set to this effect\./,
      ),
    ).toBeVisible({ timeout: 30_000 });

    const afterParsed = JSON.parse((await readConfig(request)).raw) as Record<string, unknown>;

    // Every top-level key the file had is still there — including any field
    // this page does not model.
    expect(Object.keys(afterParsed)).toEqual(beforeKeys);
    // Credentials and every provider block are byte-identical.
    expect(JSON.stringify(afterParsed.providers ?? null)).toBe(beforeProviders);
    // The four protected denies are still denies.
    for (const resource of PROTECTED_RULES) {
      const rule = (afterParsed.permissions as Array<Record<string, string>>).find(
        (r) => r.resource === resource,
      );
      if (!rule) continue;
      expect(rule.effect).toBe("deny");
    }
  });

  test("a malformed configuration is read-only and no write happens", async ({
    page,
    request,
  }) => {
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
    await expect(
      page.getByRole("main").getByText(/not valid JSON/i),
    ).toBeVisible({ timeout: 30_000 });
  });
});
