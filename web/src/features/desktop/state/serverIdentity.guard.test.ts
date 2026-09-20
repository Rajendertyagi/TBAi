import { describe, it, expect, beforeAll } from "bun:test";

/**
 * Source-level guards for the shared server-identity hook.
 *
 * Not behavioural — `web/` has no DOM runner. These guards pin the hook's
 * public shape and its reload/poll semantics so a regression (e.g. returning
 * a bare `identity` with no `reachable`/`checkedAt`, or a `reload` that does
 * not refresh `checkedAt`) fails here rather than silently.
 *
 * File guarded: web/src/features/desktop/state/serverIdentity.ts
 */

let source = "";

beforeAll(async () => {
  source = await Bun.file(
    new URL("./serverIdentity.ts", import.meta.url),
  ).text();
});

describe("useServerIdentity — returned shape", () => {
  it("returns { identity, reachable, checkedAt, loadError, reload }", () => {
    expect(source).toMatch(
      /return \{\s*identity,\s*reachable,\s*checkedAt,\s*loadError,\s*reload\s*\}/,
    );
  });

  it("types the hook return as identity: ServerIdentity | null", () => {
    expect(source).toMatch(/identity:\s*ServerIdentity \| null/);
  });

  it("types reachable as boolean | null (unknown until the first check settles)", () => {
    expect(source).toMatch(/reachable:\s*boolean \| null/);
  });

  it("types checkedAt as number | null", () => {
    expect(source).toMatch(/checkedAt:\s*number \| null/);
  });
});

describe("useServerIdentity — reload refreshes reachable and checkedAt", () => {
  it("sets reachable=true and checkedAt on a successful fetch", () => {
    // Both must be updated in the success path.
    expect(source).toMatch(/setReachable\(true\)/);
    expect(source).toMatch(/setCheckedAt\(Date\.now\(\)\)/);
  });

  it("sets reachable=false and checkedAt on failure (the check still ran)", () => {
    // A failed fetch must record liveness as false but still stamp the check
    // time — the poller knows when it last looked.
    expect(source).toMatch(/setReachable\(false\)/);
    // There must be a checkedAt stamp in the failure path too.
    const failIdx = source.indexOf("setReachable(false)");
    expect(failIdx, "failure path must exist").toBeGreaterThan(-1);
    const tail = source.slice(failIdx);
    expect(tail).toMatch(/setCheckedAt\(Date\.now\(\)\)/);
  });

  it("clears loadError on success and records it on failure", () => {
    expect(source).toMatch(/setLoadError\(null\)/);
    expect(source).toMatch(/setLoadError\(\s*err instanceof Error/);
  });

  it("fetches /api/server with no-store cache (live identity, not cached)", () => {
    expect(source).toMatch(
      /fetch\("\/api\/server",\s*\{\s*cache: "no-store"\s*\}\)/,
    );
  });
});

describe("useServerIdentity — polling is cancellable", () => {
  it("clears the interval timer on unmount", () => {
    expect(source).toMatch(/clearInterval\(timer\)/);
  });

  it("guards against stale updates after unmount (cancelled flag)", () => {
    expect(source).toMatch(/let cancelled = false/);
    expect(source).toMatch(/if \(!cancelled\) void reload\(\)/);
  });

  it("respects the poll flag (no timer when poll is false)", () => {
    expect(source).toMatch(/if \(!poll\) return;/);
  });
});

describe("useServerIdentity — poll interval is a named constant", () => {
  it("exposes SERVER_STATUS_POLL_INTERVAL_MS as a single source of truth", () => {
    expect(source).toMatch(/export const SERVER_STATUS_POLL_INTERVAL_MS = \d+/);
    // The setInterval must reference the constant, not a literal.
    expect(source).toMatch(
      /setInterval\(\(\) => \{[\s\S]*?\},\s*SERVER_STATUS_POLL_INTERVAL_MS\)/,
    );
  });
});
