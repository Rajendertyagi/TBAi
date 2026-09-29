import { describe, expect, it, beforeAll } from "bun:test";
import { stripComments } from "@/testing/source-scope";

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
    await Bun.file(new URL("../components/ChatWindow.tsx", import.meta.url)).text(),
  );
});

describe("the message footer does not format its own duration", () => {
  it("routes the completed duration through the shared formatter", () => {
    expect(source).toContain("formatDuration(timing.totalStreamTime)");
  });

  it("routes the live ticking duration through it too", () => {
    // The tick is the one that grows without bound during a long turn, so it is
    // the one that reads `299.0s` if it formats itself.
    expect(source).toContain("formatDuration(liveMs)");
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
