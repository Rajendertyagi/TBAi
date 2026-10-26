/**
 * The ONLY reporter configuration used in E2E JSON mode.
 *
 * `scripts/run-e2e.ts` selects this file with `--config=` when
 * `TBAI_E2E_JSON_DIR` is set, and adds no `--reporter` flag of its own. One
 * mechanism, because two would either compete for the output file or leave the
 * run with no report at all — and both look like evidence.
 *
 * Everything except the reporter is inherited from the revision's own
 * `playwright.config.ts`. That is deliberate: the comparison measures the app's
 * real configuration, not a harness copy of it that could silently drift. What
 * the two revisions' configs actually resolve to is recorded separately by
 * `scripts/dump-playwright-settings.ts` and compared before results are.
 */
import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

/** Absolute path the child writes its report to; the runner sets it per spec. */
const outputFile = process.env.TBAI_E2E_JSON_FILE;

export default defineConfig({
  ...base,
  // `line` keeps the operator-facing output; `json` is what the aggregate reads.
  // Passing `undefined` as Playwright's own default is not an option here: the
  // runner always sets TBAI_E2E_JSON_FILE before spawning, so a missing value is
  // a harness bug and should fail loudly rather than silently write elsewhere.
  reporter: outputFile
    ? [
        ["line"],
        ["json", { outputFile }],
      ]
    : [["line"]],
});
