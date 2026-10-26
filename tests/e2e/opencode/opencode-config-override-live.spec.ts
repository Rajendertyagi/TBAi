import { expect, test } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * G3: the override notice, rendered from the REAL managed OpenCode server.
 *
 * ## Why this is a live spec with a driver
 *
 * The notice ("Never applies — row 2 wins for every request." / "Partly
 * overridden — row 2 wins for the resources it matches.") is a claim about the
 * rule ORDER in the configuration file. Proving it needs a file whose order is
 * known, and the maintainer's own configuration is neither guaranteed to contain
 * such an order nor safe to rewrite for a test.
 *
 * `scripts/run-g3-override-evidence.ts` therefore supplies a fixture through
 * `OPENCODE_CONFIG`, starts the app with isolated `DATA_DIR`, `WORKSPACE_DIR`
 * and XDG roots, and runs exactly this spec against it. Each case gets its own
 * fixture and its own server; nothing here writes to any file.
 *
 * Running the spec any other way is a no-op, not a failure: without the driver's
 * environment variables there is no fixture to make claims about.
 *
 * ## What is asserted
 *
 *   - the server reports the fixture path, not some other discovered document,
 *     and reports exactly the fixture's rules, in order;
 *   - row 1 renders the exact notice for its case, with the explanatory title;
 *   - row 2 — the rule that wins — renders no notice at all;
 *   - the opposite notice does not appear anywhere, so a notice that leaked into
 *     the wrong row cannot satisfy the assertions.
 *
 * The observation file written at the end is what the orchestrator embeds in its
 * evidence, and it is written only after every assertion has passed.
 */

type G3Case = "full" | "partial";

interface Rule {
  action: string;
  resource: string;
  effect: string;
}

interface ConfigSnapshot {
  path: string;
  discoveredPaths: string[];
  raw: string;
  malformed: boolean;
  editable: boolean;
  permissions: Rule[] | null;
}

const CASE = process.env.G3_CASE;
const RUN_ID = process.env.G3_RUN_ID;
const FIXTURE = process.env.G3_FIXTURE;
const EXPECTED_NOTICE = process.env.G3_EXPECTED_NOTICE;
const EXPECTED_TITLE = process.env.G3_EXPECTED_TITLE;
const OBSERVATION_OUT = process.env.G3_OBSERVATION_OUT;

function isCase(value: string | undefined): value is G3Case {
  return value === "full" || value === "partial";
}

/** Path equality for a server-reported path; case-insensitive on Windows only. */
function sameFile(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

test.describe("override notice against the real managed server", () => {
  test.slow();

  test("row 1 reports the override the fixture actually causes", async ({ page, request }) => {
    test.skip(
      !isCase(CASE) ||
        !RUN_ID ||
        !FIXTURE ||
        !EXPECTED_NOTICE ||
        !EXPECTED_TITLE ||
        !OBSERVATION_OUT,
      "G3 runs only through scripts/run-g3-override-evidence.ts, which supplies the fixture.",
    );
    const caseName = CASE as G3Case;
    const fixturePath = FIXTURE as string;
    const expectedNotice = EXPECTED_NOTICE as string;
    const expectedTitle = EXPECTED_TITLE as string;
    const observationOut = OBSERVATION_OUT as string;

    // The fixture is the oracle for what the server should report. Reading it
    // here — rather than trusting a copy shipped in this file — is what ties the
    // assertion to the bytes the server was pointed at.
    const fixtureDocument = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      permissions: Rule[];
    };
    const [first, second] = fixtureDocument.permissions;
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    const response = await request.get("/api/opencode/config");
    expect(response.ok()).toBe(true);
    const snapshot = (await response.json()) as ConfigSnapshot;

    expect(snapshot.malformed).toBe(false);
    expect(snapshot.editable).toBe(true);
    expect(sameFile(snapshot.path, fixturePath)).toBe(true);
    expect(snapshot.permissions).toEqual(fixtureDocument.permissions);
    expect(snapshot.discoveredPaths.some((entry) => sameFile(entry, fixturePath))).toBe(true);

    await page.goto("/#/opencode-config");
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: "OpenCode Configuration" })).toBeVisible({
      timeout: 30_000,
    });
    // The page must name the same document the server reported.
    await expect(main.getByText(snapshot.path, { exact: true }).first()).toBeVisible();

    // Row 1 is located by its resource text, not by a row number or a layout
    // assumption: the resource span carries the rule's resource in its `title`.
    const row1Resource = main.getByTitle(first.resource, { exact: true });
    await expect(row1Resource).toBeVisible({ timeout: 30_000 });
    const row1Notice = row1Resource.locator("xpath=following-sibling::span");
    await expect(row1Notice).toHaveCount(1);
    await expect(row1Notice).toHaveText(expectedNotice);
    await expect(row1Notice).toHaveAttribute("title", expectedTitle);

    // Row 2 is the rule that wins, so it must carry no notice at all.
    const row2Resource = main.getByTitle(second.resource, { exact: true });
    await expect(row2Resource).toBeVisible();
    await expect(row2Resource.locator("xpath=following-sibling::span")).toHaveCount(0);

    // The notice for the OTHER case must not appear anywhere on the page, so a
    // notice rendered on the wrong row cannot satisfy the assertions above.
    const opposite = caseName === "full" ? "^Partly overridden" : "^Never applies";
    await expect(main.getByText(new RegExp(opposite))).toHaveCount(0);

    const observation = {
      runId: RUN_ID,
      case: caseName,
      fixture: fixturePath,
      reportedPath: snapshot.path,
      discoveredPaths: snapshot.discoveredPaths,
      permissions: snapshot.permissions,
      expectedNotice,
      expectedTitle,
      pageOrigin: new URL(page.url()).origin,
      row1: {
        action: first.action,
        resource: first.resource,
        effect: first.effect,
        notice: (await row1Notice.textContent())?.trim() ?? null,
        noticeTitle: await row1Notice.getAttribute("title"),
      },
      row2: {
        action: second.action,
        resource: second.resource,
        effect: second.effect,
        notice: null,
      },
    };
    writeFileSync(observationOut, `${JSON.stringify(observation, null, 2)}\n`, "utf8");
  });
});
