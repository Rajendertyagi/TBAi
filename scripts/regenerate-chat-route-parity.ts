/**
 * Regenerate the POST /api/chat static-parity baseline from the current source.
 *
 * Run ONLY after auditing the diff: capture the current parity, compare it with
 * the committed baseline with whitespace normalized away, and confirm every
 * difference is a formatting change. Regenerating over a real behavioural diff
 * would silently bless it, which is the one thing this tripwire exists to catch.
 *
 *   bun run scripts/regenerate-chat-route-parity.ts
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { capture } from "../tests/helpers/chat-route-parity";

/** Repository root: this file lives at `<root>/scripts/`. */
const REPO_ROOT = path.resolve(import.meta.dir, "..");
const BASELINE_PATH = path.join(REPO_ROOT, "tests/helpers/chat-route-parity.baseline.json");

const parity = capture(REPO_ROOT);

writeFileSync(BASELINE_PATH, `${JSON.stringify(parity, null, 2)}\n`, "utf8");
console.log(
  `Regenerated ${path.relative(REPO_ROOT, BASELINE_PATH)}: ` +
    `${parity.logEvents.length} log events, ${parity.responses.length} c.json bodies.`,
);
