/**
 * Enforces `POST /api/chat` parity: every log event and every `c.json` response
 * body must survive the extraction unchanged.
 *
 * Collected by `bun run test` (scoped to ./tests/unit ./tests/integration), so a
 * dropped event or a changed error body fails the normal suite rather than
 * needing a separate manual step.
 *
 * Baseline: `tests/helpers/chat-route-parity.baseline.json`, captured before the
 * extraction started.
 *
 * WHAT THIS DOES NOT PROVE — stated plainly, because it is the limit of a
 * static check. It proves the captured SOURCE text is unchanged. It cannot see
 * a settlement race, a reordered control-flow branch, or a value computed
 * differently. The behavioural suites remain the real gate; this is the
 * tripwire that catches an accidental edit during the move.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { capture, diff, type Parity } from "../../helpers/chat-route-parity";
import { REPO_ROOT } from "../../helpers/repo-root";

const BASELINE_PATH = join(REPO_ROOT, "tests/helpers/chat-route-parity.baseline.json");

const baseline: Parity = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Parity;
const current = capture(REPO_ROOT);

const report = (removed: string[], added: string[]) =>
  [
    removed.length ? `  removed:\n${removed.map((m) => `    - ${m}`).join("\n")}` : "",
    added.length ? `  gained:\n${added.map((a) => `    + ${a}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

describe("POST /api/chat static parity", () => {
  it("scans a non-empty source set", () => {
    // An empty scan would make every other assertion below vacuously true.
    expect(current.files.length, "sources were scanned").toBeGreaterThan(0);
    expect(current.files, "the route is always among them").toContain("src/routes/chat/index.ts");
  });

  it("keeps every log event: same level, scope and event name", () => {
    const { removed, added } = diff(baseline.logEvents, current.logEvents);
    expect(
      removed.length === 0 && added.length === 0,
      `log events changed\n${report(removed, added)}`,
    ).toBe(true);
  });

  it("keeps every c.json response body byte-for-byte after normalization", () => {
    const { removed, added } = diff(baseline.responses, current.responses);
    expect(
      removed.length === 0 && added.length === 0,
      `c.json bodies changed\n${report(removed, added)}`,
    ).toBe(true);
  });

  it("keeps the captured counts identical", () => {
    expect(current.logEvents.length, "log event count").toBe(baseline.logEvents.length);
    expect(current.responses.length, "c.json body count").toBe(baseline.responses.length);
  });

  // ── Non-vacuity ────────────────────────────────────────────────────────
  // A harness that cannot fail protects nothing. These four cases run against
  // synthetic input so the detection is proven WITHOUT mutating src/, which
  // would be the one thing the harness exists to prevent.
  describe("the comparator detects change", () => {
    it("flags a dropped log event", () => {
      const base = ["warn|chat|a", "warn|chat|b"];
      expect(diff(base, ["warn|chat|a"]).removed).toEqual(["warn|chat|b"]);
    });

    it("flags a renamed log event even at the same call site", () => {
      const base = ["warn|chat|chat_request_rejected"];
      const { removed, added } = diff(base, ["warn|chat|chat_request_refused"]);
      expect(removed).toEqual(["warn|chat|chat_request_rejected"]);
      expect(added).toEqual(["warn|chat|chat_request_refused"]);
    });

    it("flags a changed status code in a c.json body", () => {
      const base = ["return c.json( { error: `x`, requestId }, 400, )"];
      const { removed, added } = diff(base, ["return c.json( { error: `x`, requestId }, 500, )"]);
      expect(removed).toHaveLength(1);
      expect(added).toHaveLength(1);
    });

    it("flags a body that silently lost requestId", () => {
      const base = ["return c.json( { error: `x`, requestId }, 400, )"];
      const { removed } = diff(base, ["return c.json( { error: `x` }, 400, )"]);
      expect(removed).toHaveLength(1);
    });

    it("does not hide a lost duplicate behind a set-like comparison", () => {
      // Two identical events baseline, one now: the loss must still surface.
      const base = ["warn|chat|a", "warn|chat|a"];
      expect(diff(base, ["warn|chat|a"]).removed).toEqual(["warn|chat|a"]);
    });
  });
});
