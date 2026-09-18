import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { OPENCODE_CONFIG } from "../../config/opencode";

/**
 * V2-only source guard.
 *
 * The architectural invariant for TBAi-owned backend code is: **the official
 * `@opencode/client` V2 API is the only OpenCode API**. The legacy
 * `@opencode-ai/sdk` may survive only as the frozen frontend adapter's
 * transitive dependency — never as something backend code imports or calls.
 *
 * This test is deliberately a *focused* scan, not a broad string search: it
 * reads the backend OpenCode sources, strips comments (so prose may discuss V1
 * freely while code may not use it), and asserts the invariant. The single
 * permitted legacy-looking request is the OpenCode 1.18.29 delete fallback,
 * which lives in exactly one file and is asserted to be there.
 */

const OPENCODE_DIR = import.meta.dir;
const SRC_DIR = path.resolve(import.meta.dir, "..", "..");

/**
 * Removes `//` line comments and `/* *\/` block comments while leaving string
 * and template literals intact, so a `//` inside a URL is not mistaken for a
 * comment and prose in comments cannot trip the guard.
 */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;

  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];

    if (quote) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Every `.ts` file under a directory, recursively, excluding tests. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name))
    .filter((p) => p.endsWith(".ts") && !p.endsWith(".test.ts"));
}

/** Legacy V1 SDK service calls that must never reappear in backend code. */
const FORBIDDEN_CALLS: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /client\.app\./, why: "V1 agent namespace (use agent.list)" },
  { pattern: /client\.v2\./, why: "the legacy SDK's transitional V2 namespace" },
  { pattern: /client\.event\./, why: "V1 event namespace (use event.subscribe)" },
  { pattern: /client\.permission\./, why: "V1 permission namespace" },
  { pattern: /client\.question\./, why: "V1 question namespace (V2 uses session.form)" },
  { pattern: /\.session\.abort\(/, why: "V1 abort (V2 uses session.interrupt)" },
  { pattern: /\.session\.delete\(/, why: "V1 delete (V2 uses session.remove)" },
];

describe("V2-only guard — backend OpenCode sources", () => {
  const opencodeSources = sourceFiles(OPENCODE_DIR);

  it("finds the backend OpenCode sources to guard", () => {
    expect(opencodeSources.length).toBeGreaterThan(0);
  });

  it("H. no backend source imports the legacy @opencode-ai/sdk", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC_DIR)) {
      const code = stripComments(readFileSync(file, "utf8"));
      if (/from\s+["']@opencode-ai\/sdk/.test(code)) {
        offenders.push(path.relative(SRC_DIR, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("H. no backend source calls a legacy V1 service method", () => {
    const offenders: string[] = [];
    for (const file of opencodeSources) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const { pattern, why } of FORBIDDEN_CALLS) {
        if (pattern.test(code)) {
          offenders.push(`${path.basename(file)}: ${pattern} — ${why}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("H. the only legacy-looking request is the documented 1.18.29 delete fallback", () => {
    // Every backend OpenCode source except the transport must be free of V1
    // paths. `client.ts` owns the one unavoidable exception.
    const offenders: string[] = [];
    for (const file of opencodeSources) {
      if (path.basename(file) === "client.ts") continue;
      const code = stripComments(readFileSync(file, "utf8"));
      if (/["'`]\/session\//.test(code) || /\/api\/session\/:/.test(code)) {
        offenders.push(path.basename(file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("H. the fallback is confined to client.ts and is documented there", () => {
    const raw = readFileSync(path.join(OPENCODE_DIR, "client.ts"), "utf8");
    expect(raw).toContain("/session/");
    // The justification must be present, not just the code.
    expect(raw).toContain("1.18.29");
    expect(raw.toLowerCase()).toContain("has no route at all");
  });
});

describe("F. readiness probe", () => {
  it("uses a V2-named endpoint, not the V1 /session/status", () => {
    expect(OPENCODE_CONFIG.readinessProbePath.startsWith("/api/")).toBe(true);
    expect(OPENCODE_CONFIG.readinessProbePath).not.toContain("/session/");
  });

  it("probes the health endpoint", () => {
    expect(OPENCODE_CONFIG.readinessProbePath).toBe("/api/health");
  });
});
