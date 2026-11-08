import { describe, expect, it, beforeAll } from "bun:test";
import { REPO_ROOT } from "../../../helpers/repo-root";
import path from "node:path";
import { stripComments } from "@web/testing/source-scope";

/**
 * One formatter for every rendered duration.
 *
 * `formatDuration` exists because a real 3618-second call rendered as `3618.8s`.
 * Fixing it in one place is not enough if another place formats its own duration,
 * and one did: the message footer computed `(ms / 1000).toFixed(1)` inline, so a
 * real 299-second turn read `299.0s` there while the tool badge on the same card
 * read `4m 59s`. Two spellings of the same fact, one screen, one of them
 * unreadable.
 *
 * It was found by looking at a live capture, not by a failing test — which is
 * exactly why it needs a source guard now. Nothing else in the repo knows a
 * duration is formatted in more than one place.
 */

let source = "";

beforeAll(async () => {
  source = stripComments(
    await Bun.file(path.join(REPO_ROOT, "web/src/components/ChatWindow.tsx")).text(),
  );
});

describe("the message footer does not format its own duration", () => {
  it("routes the settled duration through the shared formatter", () => {
    // The settled span comes from the server's turn record (`custom.turnTiming`),
    // which is what makes it survive a reload; how it is written is still the one
    // formatter's business. Matched with slack for whitespace so a formatter
    // re-wrap cannot fail a contract that never changed.
    expect(source).toMatch(/formatDuration\(\s*settledDurationMs\s*\)/);
  });

  it("routes the live ticking duration through it too", () => {
    // The tick is the one that grows without bound during a long turn, so it is
    // the one that reads `299.0s` if it formats itself. It counts from the
    // server's start stamp, so it never restarts at zero when the row remounts.
    expect(source).toMatch(
      /formatDuration\(\s*Math\.max\(\s*0\s*,\s*now\s*-\s*liveAnchor\s*\)\s*\)/,
    );
  });

  it("has no inline seconds conversion left", () => {
    // The exact expression that caused it, in either spelling.
    expect(source).not.toMatch(/\(\s*\w+(?:\.\w+)*\s*\/\s*1000\s*\)\.toFixed\(1\)/);
    expect(source).not.toMatch(/`\$\{\(\s*\w+(?:\.\w+)*\s*\/\s*1000\s*\)\.toFixed\(1\)\}s`/);
  });

  it("imports the one owner rather than redeclaring the rule", () => {
    expect(source).toMatch(/import\s*\{[^}]*formatDuration[^}]*\}\s*from\s*"@\/tools\/elapsed"/);
  });
});
