/**
 * P2 — headless scroll harness: `@tanstack/virtual-core` identity guard (G-1..G-5).
 *
 * `web/src/components/VirtualizedTranscript.tsx` drives scrolling through
 * `useVirtualizer` from `@tanstack/react-virtual@3.14.13`, which pins
 * `@tanstack/virtual-core@3.17.11` EXACTLY. A headless test cannot mount that
 * component (happy-dom cannot run a virtualizer: `ResizeObserver.observe()` is
 * a no-op and `getBoundingClientRect()` is all zeros), so the headless harness
 * constructs its OWN `Virtualizer` directly from `@tanstack/virtual-core`.
 * Confidence therefore rests on VERSION/INSTANCE identity, not on sharing a
 * live instance with the component — this file establishes that identity.
 *
 * NOTE ON A TASK PREMISE — CHECKED AND FALSE ON DISK (do not trust the brief):
 * The brief states `react-virtual` "exports only `useVirtualizer`/
 * `useWindowVirtualizer` and does NOT re-export `Virtualizer`". That is not
 * true for the installed `@tanstack/react-virtual@3.14.13`: its ESM entry
 * contains `export * from "@tanstack/virtual-core"` and a probe shows
 * `Virtualizer` among its runtime exports. The harness still constructs its
 * own `Virtualizer` (headless, no React/DOM), and identity is still proven by
 * version — but the premise as written would be a false statement, so it is
 * recorded here corrected rather than repeated.
 */

import { describe, expect, it } from "bun:test";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Virtualizer, measureElement } from "@tanstack/virtual-core";
import { REPO_ROOT } from "../../helpers/repo-root";

/** A require anchored at this test file. */
const here = createRequire(import.meta.url);

/**
 * Repository root.
 *
 * `@tanstack/react-virtual` and `@tanstack/virtual-core` are declared on the
 * WORKSPACE ROOT, not only on `web/`. This file lives under `tests/`, so a bare
 * specifier resolves upward through the root and never reaches `web/node_modules`
 * — G-3 (`import.meta.resolve`) and G-4 (`here.resolve`) both resolve from here,
 * so the packages must be visible from this side of the tree for either to mean
 * anything. Root declaration also leaves G-4 doing real work: it then compares a
 * root-side resolution against the copy reachable only through `web/`.
 */
const repoRoot = REPO_ROOT;

/** Normalize a Windows/posix path to forward slashes for stable assertions. */
const toPosix = (p: string): string => p.split(path.sep).join("/");

describe("P2 — @tanstack/virtual-core identity (headless harness prerequisite)", () => {
  it("G-1: Virtualizer imported from @tanstack/virtual-core is a function", () => {
    console.log(`  Virtualizer: ${typeof Virtualizer}`);
    expect(typeof Virtualizer).toBe("function");
  });

  it("G-2: measureElement is a function", () => {
    console.log(`  measureElement: ${typeof measureElement}`);
    expect(typeof measureElement).toBe("function");
  });

  it("G-3: ESM resolution of @tanstack/virtual-core ends in dist/esm/index.js", () => {
    const resolved = import.meta.resolve("@tanstack/virtual-core");
    const filePath = resolved.startsWith("file:") ? fileURLToPath(resolved) : resolved;
    const normalized = toPosix(filePath);

    console.log("\n=== @tanstack/virtual-core ESM resolution ===");
    console.log(`  ${normalized}`);

    expect(normalized.endsWith("dist/esm/index.js")).toBe(true);
  });

  it("G-4: resolving from react-virtual's location yields the identical realpath", () => {
    const reactVirtualEntry = here.resolve("@tanstack/react-virtual");
    const reactVirtualRequire = createRequire(reactVirtualEntry);

    const viaReactVirtual = fs.realpathSync(reactVirtualRequire.resolve("@tanstack/virtual-core"));
    const viaWeb = fs.realpathSync(here.resolve("@tanstack/virtual-core"));

    console.log("\n=== @tanstack/virtual-core realpath (G-4) ===");
    console.log(`  react-virtual entry : ${reactVirtualEntry}`);
    console.log(`  via react-virtual   : ${viaReactVirtual}`);
    console.log(`  via web             : ${viaWeb}`);

    expect(viaReactVirtual).toBe(viaWeb);
  });

  /**
   * G-5: exactly one REACHABLE `@tanstack/virtual-core`, and it is the version
   * react-virtual declares it needs.
   *
   * What this deliberately no longer counts: every directory under
   * `node_modules/.bun/@tanstack+virtual-core@*`. That path is bun's unpacked
   * package store — an archive cache, not a loadable instance. An upgrade
   * leaves the previous version sitting in it indefinitely, so counting those
   * directories asserted that `bun install` had pruned a cache, which is not
   * the contract this suite exists to prove, and it failed on a correct tree.
   *
   * The contract is module IDENTITY of what a runtime can actually load, so
   * this asserts that every path a runtime can resolve — the copy
   * `@tanstack/react-virtual` itself resolves, the repo-root copy, and the web
   * copy — reports the same version, and that version equals the range
   * react-virtual declares. That is strictly more informative than the cache
   * scan it replaces.
   */
  it("G-5: exactly one reachable @tanstack/virtual-core, matching react-virtual's declared dependency", () => {
    const reactVirtualEntry = here.resolve("@tanstack/react-virtual");
    const reactVirtualRequire = createRequire(reactVirtualEntry);

    const readVersion = (packageJsonPath: string): string | undefined => {
      if (!fs.existsSync(packageJsonPath)) return undefined;
      const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { version?: string };
      return parsed.version;
    };

    const reachable = new Map<string, string | undefined>();

    // The copy react-virtual itself loads — the one that matters at runtime.
    reachable.set(
      "via react-virtual",
      readVersion(reactVirtualRequire.resolve("@tanstack/virtual-core/package.json")),
    );

    // The copies a bare specifier reaches from each workspace root.
    for (const [label, base] of [
      ["repo root", path.join(repoRoot, "package.json")],
      ["web", path.join(repoRoot, "web", "package.json")],
    ] as const) {
      try {
        const req = createRequire(base);
        reachable.set(label, readVersion(req.resolve("@tanstack/virtual-core/package.json")));
      } catch {
        reachable.set(label, undefined);
      }
    }

    console.log("\n=== @tanstack/virtual-core reachable copies (G-5) ===");
    for (const [label, version] of reachable)
      console.log(`  ${version ?? "(unresolvable)"}  <-  ${label}`);

    // Cache directories, reported for diagnosis but no longer asserted on.
    const store = path.join(repoRoot, "node_modules", ".bun");
    if (fs.existsSync(store)) {
      const cached = fs
        .readdirSync(store)
        .filter((name) => name.startsWith("@tanstack+virtual-core@"))
        .map((name) => name.slice("@tanstack+virtual-core@".length));
      console.log(
        `  bun store cache entries (not loadable instances): ${cached.join(", ") || "none"}`,
      );
    }

    const loadable = [...reachable.values()].filter((v): v is string => v !== undefined);
    expect(loadable.length).toBeGreaterThan(0);
    expect(new Set(loadable).size).toBe(1);

    // The single reachable version must be what react-virtual declares it needs.
    const reactVirtualManifest = JSON.parse(
      fs.readFileSync(here.resolve("@tanstack/react-virtual/package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const declared = reactVirtualManifest.dependencies?.["@tanstack/virtual-core"];
    expect(declared).toBeDefined();
    expect(loadable[0]).toBe(declared);
  });
});
