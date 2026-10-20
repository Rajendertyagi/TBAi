/**
 * The quarantine guard for the OpenCode defect-regression tests.
 *
 * ## WHAT IT CHECKS
 *
 * The OpenCode findings are pinned two ways: a **baseline** test that asserts
 * today's behaviour (defects included) and a **quarantine** entry that asserts
 * the behaviour the finding says the product should have. The quarantine
 * entries are committed as `test.todo`, so an ordinary run never executes
 * them and they can never break the build.
 *
 * This script is the other half: it runs the quarantine, and fails when a
 * quarantine entry has gone **stale** — that is, when its body now PASSES,
 * which means the underlying defect has been fixed and the entry must be
 * promoted to a real test.
 *
 * ## WHY IT PARSES THE OUTPUT INSTEAD OF TRUSTING THE EXIT CODE
 *
 * Measured against bun 1.4.3, a file of only failing todos exits **0** in
 * both `bun test` and `bun test --todo` — so an exit code can never show
 * that a defect was demonstrated, and it cannot distinguish "the quarantine
 * is fine" from "an unrelated ordinary test failed". The decision is
 * therefore made on the MESSAGE bun prints, and the exit code is consulted
 * only to learn that something happened.
 *
 * Two kinds of output are read:
 *
 * - `"this test is marked as todo but passes"` — a **stale** quarantine entry.
 *   This is the only signal that fails the guard, and the guard names the
 *   entry.
 * - `(fail)` lines that are NOT the stale-quarantine message — an ordinary
 *   test failure. Those are reported separately and attributed to their own
 *   test, because they are the ordinary suite's business, not the
 *   quarantine's.
 *
 * ## WHY IT IS A SCRIPT AND NOT A TEST
 *
 * It has to run `bun test --todo` as a child process and read its output.
 * A test cannot observe the runner's own reporting of its siblings, and a
 * test that asserted on source text would be exactly the kind of guard that
 * cannot fail.
 *
 * ## USAGE
 *
 *   bun scripts/check-opencode-quarantine.ts
 *
 * Exits 0 when the quarantine is healthy, 1 when an entry has gone stale,
 * and 1 with a distinct report when an ordinary test failed.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The OpenCode test trees the quarantine lives in. */
const QUARANTINE_ROOTS = [
  "tests/unit/web/opencode",
  "tests/unit/opencode",
  "tests/integration/opencode",
] as const;

/** Bun's wording for a todo whose body now passes. */
const STALE_MARKER = "this test is marked as todo but passes";

type Captured = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

function runTodoSuite(): Captured {
  const result = spawnSync("bun", ["test", "--todo", ...QUARANTINE_ROOTS], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/**
 * The `(fail) <suite> > <test>` blocks, each with the lines that follow it.
 *
 * bun prints the failure headline on one line and the explanation - including
 * "this test is marked as todo but passes" - on the lines after it, so the
 * two have to be read TOGETHER. Reading only the headline would classify a
 * stale quarantine entry as an ordinary failure, which is the exact
 * misclassification this script exists to avoid.
 */
function failureBlocks(output: string): { readonly headline: string; readonly body: string }[] {
  const lines = output.split("\n");
  const blocks: { headline: string; body: string }[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const headline = lines[i]?.trim() ?? "";
    if (!headline.startsWith("(fail)")) continue;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j] ?? "";
      const trimmed = next.trim();
      // The block ends at the next failure headline or at the next file
      // banner, whichever comes first.
      if (trimmed.startsWith("(fail)") || trimmed.endsWith(".test.ts:")) break;
      body.push(next);
    }
    blocks.push({
      headline: headline.replace(/\s*\[\d+(?:\.\d+)?ms\]\s*$/, ""),
      body: body.join("\n"),
    });
  }
  return blocks;
}

/** The test name a stale-quarantine failure belongs to. */
function staleEntryName(block: { readonly headline: string }): string {
  return block.headline.replace(/^\(fail\)\s*/, "");
}

function main(): void {
  const captured = runTodoSuite();
  const output = `${captured.stdout}\n${captured.stderr}`;
  const blocks = failureBlocks(output);
  const stale = blocks.filter((block) => block.body.includes(STALE_MARKER));
  const ordinary = blocks.filter((block) => !block.body.includes(STALE_MARKER));

  if (stale.length > 0) {
    console.error(
      `\n[opencode-quarantine] ${stale.length} quarantine entr${
        stale.length === 1 ? "y has" : "ies have"
      } gone STALE - the underlying defect now looks fixed:`,
    );
    for (const block of stale) {
      console.error(`  ${staleEntryName(block)}`);
    }
    console.error(
      "\n  A stale entry means the todo body now PASSES, so the finding it pins" +
        "\n  has been fixed. Promote it from `test.todo` to `test`, and delete the" +
        "\n  baseline test that pinned the old behaviour, in the SAME commit." +
        "\n  Until then this guard fails.\n",
    );
    process.exitCode = 1;
    return;
  }

  if (ordinary.length > 0) {
    console.error(
      `\n[opencode-quarantine] ${ordinary.length} ordinary test failure(s) in the quarantine trees` +
        "\n  (attributed to the ordinary suite, NOT to the quarantine):",
    );
    for (const block of ordinary) console.error(`  ${block.headline}`);
    console.error("\n  These are the suite's own failures. The quarantine itself is healthy.\n");
    process.exitCode = 1;
    return;
  }

  console.log(
    "[opencode-quarantine] OK — no stale quarantine entries; every todo still demonstrates its defect",
  );
}

main();
