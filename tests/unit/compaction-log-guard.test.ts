/**
 * The compaction summary must never be logged.
 *
 * ## Why this needs a guard
 *
 * Change 1 made the summary text part of `ManualCompactData`, which is the payload
 * delivered to the UI. The route's `chat_compact_*` log lines sit next to that payload
 * and already log its sibling fields — `compactionReason`, `compactionGeneration`,
 * `compactionSummarySize`. Spreading `data` into a log call, or adding
 * `summary: data.summary` to one, is a one-token change that would ship every user's
 * conversation content to disk.
 *
 * AGENTS.md forbids logging message text. A summary is conversation content by
 * definition: it is a model-authored description of what the user said.
 *
 * ## What this asserts
 *
 * Not that the summary is absent from the codebase — it is deliberately present in the
 * payload and in the stored divider. It asserts that no LOG CALL mentions it, by
 * checking every field name and value expression inside a `logger.*` invocation in the
 * two files that write compaction logs.
 *
 * Source-level rather than behavioural because `web/` has no DOM runner and the server
 * logs are not observable in-process; this is the same convention as
 * `web/src/features/availability/recoveryGuards.test.ts`.
 */

import { describe, expect, it } from "bun:test";
import fs from "fs";
import path from "path";

/** Files permitted to log about compaction, and therefore the ones checked. */
const LOGGING_FILES: Record<string, string> = {
  chat: "src/routes/chat.ts",
  command: "src/routes/direct-compact-command.ts",
};

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");

function readSource(relative: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relative), "utf8");
}

/**
 * The body of every `logger.<level>(...)` / `log.<level>(...)` call.
 *
 * Balanced-paren scan rather than a regex: a call can span many lines and nest
 * arbitrarily, and a line-based match would both miss long calls and match the word
 * `log` inside a string.
 */
function loggerCallBodies(source: string): string[] {
  const bodies: string[] = [];
  const pattern = /\b(?:logger|log|chatLog|assemblyLog)\s*\.\s*(?:trace|debug|info|warn|error)\s*\(/g;
  for (const match of source.matchAll(pattern)) {
    const open = source.indexOf("(", match.index);
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === "(") depth += 1;
      else if (source[i] === ")") {
        depth -= 1;
        if (depth === 0) {
          bodies.push(source.slice(open + 1, i));
          break;
        }
      }
    }
  }
  return bodies;
}

/** Strip comments, so prose about a rule is not mistaken for breaking it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("compaction logs carry counts, never content", () => {
  const sources = Object.fromEntries(
    Object.entries(LOGGING_FILES).map(([key, file]) => [key, stripComments(readSource(file))]),
  );

  it("finds the compaction log calls at all, so the checks below cannot pass vacuously", () => {
    // If this fails, every other assertion in this file is meaningless.
    const total = Object.values(sources).reduce((n, src) => n + loggerCallBodies(src).length, 0);
    expect(total).toBeGreaterThan(0);
  });

  it("never names the summary as a log field", () => {
    for (const [name, source] of Object.entries(sources)) {
      for (const body of loggerCallBodies(source)) {
        expect(`${name}: ${body}`).not.toMatch(/\bsummaryText\b/);
        // `compactionSummarySize` is the permitted form — counts only.
        expect(`${name}: ${body}`).not.toMatch(/(?<!Size)\bsummary\s*:/);
      }
    }
  });

  it("never passes the payload itself into a log call", () => {
    // Spreading `data` would carry every sibling field too, including any future one.
    for (const [name, source] of Object.entries(sources)) {
      for (const body of loggerCallBodies(source)) {
        expect(`${name}: ${body}`).not.toMatch(/\.\.\.\s*data\b/);
        expect(`${name}: ${body}`).not.toMatch(/\bdata\s*,/);
      }
    }
  });

  it("logs the summary's SIZE, which is the fact that is safe", () => {
    // Positive assertion: the safe substitute must actually be there, or the guards
    // above could be satisfied by simply logging nothing.
    const chat = loggerCallBodies(sources.chat).join("\n");
    expect(chat).toContain("compactionSummarySize");
    expect(chat).toContain("compactionReclaimedSize");
  });

  it("keeps the summary out of the stored-content helper's log-free contract", () => {
    // `buildDividerStoredContent` is where the summary legitimately lives. Asserting it
    // is reachable from here documents that the two are the same fact, not two copies.
    const command = readSource(LOGGING_FILES.command);
    expect(command).toContain("summary: data.summary");
  });
});
