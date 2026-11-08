/**
 * Writes the `POST /api/chat` parity baseline from the CURRENT working tree.
 *
 * Run once, before the extraction starts:
 *
 *     bun tests/helpers/chat-route-parity-baseline.ts
 *
 * It is deliberately NOT a package script: this refactor keeps clear of
 * `package.json`. Invoking it directly keeps the change isolated to tests/.
 *
 * Refusing to overwrite silently is the point — if this is run mid-extraction
 * the baseline would capture a half-moved tree and every later check would be
 * meaningless. Pass `--force` only to re-baseline deliberately, and only when
 * the parity change is one you can name.
 */
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { capture } from "./chat-route-parity";
import { REPO_ROOT } from "./repo-root";

const BASELINE_PATH = join(REPO_ROOT, "tests/helpers/chat-route-parity.baseline.json");

const force = process.argv.includes("--force");

if (existsSync(BASELINE_PATH) && !force) {
  console.error(
    "Refusing to overwrite an existing baseline.\n" +
      "A baseline captured mid-extraction would make every later check meaningless.\n" +
      "Re-run with --force only if the parity change is deliberate and nameable.",
  );
  process.exit(1);
}

const snapshot = capture(REPO_ROOT);

if (snapshot.files.length === 0) {
  console.error("Scanned zero files — refusing to write an empty baseline.");
  process.exit(1);
}

writeFileSync(BASELINE_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

console.log(`baseline written: ${BASELINE_PATH}`);
console.log(`  files scanned : ${snapshot.files.length} (${snapshot.files.join(", ")})`);
console.log(`  log events    : ${snapshot.logEvents.length}`);
console.log(`  c.json bodies : ${snapshot.responses.length}`);
