/**
 * The Direct context-window AUTHORITY boundary.
 *
 * ## The defect these tests exist to prevent
 *
 * Direct's effective context window is resolved exactly once, on the server, in
 * `src/context/limits.ts` (`resolveContextLimit`). The frontend used to carry a second
 * resolver - `resolveContextWindow` in `config/modelContext.ts` - which
 * `DirectContextRing` used as a fallback with its own precedence and its own 128k
 * default.
 *
 * That was not a harmless duplicate. The backend could resolve X while the meter
 * divided by Y, and when the frontend supplied the fallback it reported NO provenance,
 * so the ring could display "... / 128k" directly above the words "Context limit
 * unknown". A user reading that cannot tell the number is invented, and an engineer
 * reading it cannot tell the budget disagrees with the display.
 *
 * ## What is asserted here
 *
 *  1. STATICALLY: no Direct frontend module resolves or defaults a context window. A
 *     grep-based guard, because this is an architectural rule about which module may
 *     decide what - not a runtime behaviour, so no render can prove it.
 *  2. The server's resolved value, with its provenance, survives the transport to the
 *     UI unchanged, for every source - including the two cases that used to go wrong
 *     (fallback, and unknown).
 *
 * Resolution-side assertions (identity, conflict, configured override, budget parity)
 * belong to the server and live in `src/context/limits-authority.test.ts`. They are not
 * duplicated here, because importing backend modules from a web test pulls them into
 * the web TypeScript program and checks them under different settings.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseCurrentContext } from "../features/chat/context/useCurrentContext";

/**
 * The server's documented fallback ceiling (`UNKNOWN_LIMIT_CEILING`).
 *
 * Written as a transport FIXTURE, not application logic. The authoritative assertion
 * that this is the server's actual fallback lives in
 * `src/context/limits-authority.test.ts`, which imports the constant itself. Repeating
 * the number here is deliberate: the frontend contract under test is "whatever the
 * server sends arrives intact with its provenance", which is what a fixture expresses.
 */
const SERVER_FALLBACK_WINDOW = 128_000;

const WEB_SRC = path.resolve(import.meta.dir, "..");

/** Read a frontend source file as text. Fails loudly rather than skipping a guard. */
function readSource(relative: string): string {
  const file = path.join(WEB_SRC, relative);
  if (!fs.existsSync(file)) throw new Error(`guard cannot read ${relative} - the rule it enforces moved`);
  return fs.readFileSync(file, "utf8");
}

/** Strip comments so a prohibition cannot be satisfied by merely mentioning a symbol. */
function code(relative: string): string {
  return readSource(relative)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// ---------------------------------------------------------------------------
// Test 10: the structural rule
// ---------------------------------------------------------------------------

describe("no frontend module resolves a DIRECT context window", () => {
  it("DirectContextRing consumes the server reading and nothing else", () => {
    const src = code("components/context-ring.tsx");
    // It must not reach for a frontend resolver or a frontend default...
    expect(src).not.toContain("resolveContextWindow");
    expect(src).not.toContain("DEFAULT_MODEL_CONTEXT_WINDOW");
    // ...and must not resolve a window from provider config itself either.
    expect(src).not.toContain("contextWindow");
    expect(src).not.toContain("buildModelGroups");
    expect(src).not.toContain("findModelOption");
  });

  it("DirectContextRing takes its denominator from the server reading", () => {
    const src = code("components/context-ring.tsx");
    expect(src).toContain("useCurrentContext");
    // The denominator IS the server's resolved window, with its provenance.
    expect(src).toContain("modelContextWindow={serverContext.windowTokens}");
    expect(src).toContain("windowSource={serverContext.windowSource}");
  });

  it("renders nothing rather than substituting a value when the server has no reading", () => {
    // The honest state. A placeholder or a local estimate here is exactly the defect.
    const src = code("components/context-ring.tsx");
    expect(src).toContain("if (!serverContext) return null");
    // No `??` fallback anywhere in the component.
    expect(src).not.toMatch(/\?\?\s*[A-Za-z_$]/);
  });

  it("no module outside the designated Code resolver declares a window fallback", () => {
    // A new Direct surface must not reintroduce its own ceiling. Exactly ONE file may
    // hold such a constant - the Code-side resolver - because Code's window genuinely
    // comes from Code sources. The companion test below asserts that file is documented
    // as CODE-ONLY, so this exemption cannot quietly become a second Direct authority.
    const CODE_ONLY_HOME = "config/modelContext.ts";
    const offenders: string[] = [];
    const roots = ["components", "features/chat", "config", "hooks", "stores"];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "assistant-ui" || entry.name === "opencode") continue;
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        if (/\.test\.tsx?$/.test(entry.name)) continue;
        const relative = path.relative(WEB_SRC, full).split(path.sep).join("/");
        if (relative === CODE_ONLY_HOME) continue;
        if (/=\s*128_000\b/.test(code(relative))) offenders.push(relative);
      }
    };
    for (const root of roots) {
      const dir = path.join(WEB_SRC, root);
      if (fs.existsSync(dir)) walk(dir);
    }
    expect(offenders).toEqual([]);
  });

  it("the surviving frontend resolver is Code-only and says so", () => {
    // It still exists for the OpenCode ring, which is a different provenance chain.
    // What must not recur is Direct using it.
    const src = readSource("config/modelContext.ts");
    expect(src).toContain("resolveContextWindow");
    expect(src).toMatch(/CODE-ONLY fallback window/);
    expect(src).toMatch(/NOT for Direct/);
  });
});

// ---------------------------------------------------------------------------
// Tests 1-5: the server result survives transport, provenance intact
// ---------------------------------------------------------------------------

describe("the server's resolved window reaches the UI unchanged", () => {
  /**
   * The transport the route uses: `ChatContextState` on message metadata.
   *
   * Each case is a resolution the SERVER already made. The frontend's only job is to
   * carry the number and its stance across unmodified.
   */
  const transport = (windowTokens: number, windowSource: string) => ({
    usedTokens: 10_000,
    windowTokens,
    windowSource,
    usableInputTokens: Math.floor(windowTokens * 0.75),
    occupancyKind: "provider",
  });

  it("Tests 1/2/3 - configured, provider-reported and fallback all survive verbatim", () => {
    const configured = parseCurrentContext({ context: transport(512_000, "configured") });
    expect(configured?.windowTokens).toBe(512_000);
    expect(configured?.windowSource).toBe("configured");

    const provider = parseCurrentContext({ context: transport(1_000_000, "provider_reported") });
    expect(provider?.windowTokens).toBe(1_000_000);
    expect(provider?.windowSource).toBe("provider_reported");

    const fallback = parseCurrentContext({ context: transport(SERVER_FALLBACK_WINDOW, "conservative_default") });
    expect(fallback?.windowTokens).toBe(SERVER_FALLBACK_WINDOW);
    expect(fallback?.windowSource).toBe("conservative_default");
  });

  it("Test 4 - a fallback is distinguishable from a verified figure", () => {
    const fallback = parseCurrentContext({
      context: transport(SERVER_FALLBACK_WINDOW, "conservative_default"),
    });
    // Same NUMBER the Code-side default uses, but a different, honest stance - which is
    // precisely what the old frontend fallback could not express: it supplied the
    // number with no stance at all.
    expect(fallback?.windowTokens).toBe(128_000);
    expect(fallback?.windowSource).not.toBe("provider_reported");
    expect(fallback?.windowSource).not.toBe("configured");
  });

  it("Test 5 - unknown yields no reading at all, and the UI invents nothing", () => {
    // The server publishes no window when it has no authoritative one, and the ring
    // then renders nothing rather than substituting a value.
    expect(parseCurrentContext({ context: { usedTokens: 10_000 } })).toBeUndefined();
    expect(parseCurrentContext({})).toBeUndefined();
    // An unrecognised stance degrades to unknown rather than to a confident default.
    const downgraded = parseCurrentContext({ context: transport(128_000, "totally_made_up") });
    expect(downgraded?.windowSource).toBe("unknown");
  });

  it("Test 5 - a malformed window is refused rather than rounded into place", () => {
    for (const bad of [0, -1, Number.NaN, "128000", null]) {
      expect(parseCurrentContext({ context: { usedTokens: 1, windowTokens: bad } })).toBeUndefined();
    }
  });
});
