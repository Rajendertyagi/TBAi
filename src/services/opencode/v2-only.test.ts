import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { OPENCODE_CONFIG } from "../../config/opencode";

/**
 * Native V2 source guard.
 *
 * Backend OpenCode code must use the official client boundary and the native
 * readiness endpoint. This focused scan keeps the adapter boundary from being
 * bypassed by another client implementation or transport.
 */

const OPENCODE_DIR = import.meta.dir;
const OFFICIAL_CLIENT_PACKAGE = "@opencode/client";
const READINESS_ENDPOINT = "/api/info";

/** Removes line and block comments while preserving quoted source text. */
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

/** Every production TypeScript file under the OpenCode service directory. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((filePath) => filePath.endsWith(".ts") && !filePath.endsWith(".test.ts"));
}

describe("native V2 guard — backend OpenCode sources", () => {
  const opencodeSources = sourceFiles(OPENCODE_DIR);

  it("finds the backend OpenCode sources to guard", () => {
    expect(opencodeSources.length).toBeGreaterThan(0);
  });

  it("uses the official OpenCode client boundary", () => {
    const clientSource = stripComments(
      readFileSync(path.join(OPENCODE_DIR, "client.ts"), "utf8"),
    );
    expect(clientSource).toContain(`from "${OFFICIAL_CLIENT_PACKAGE}"`);
    expect(clientSource).toContain("OpenCode.make");
  });

  it("does not import a second OpenCode client package", () => {
    const offenders: string[] = [];
    const packagePattern = /from\s+["'](@opencode\/[^"']+)["']/g;
    for (const file of opencodeSources) {
      const imports = stripComments(readFileSync(file, "utf8")).match(packagePattern) ?? [];
      for (const declaration of imports) {
        if (!declaration.includes(OFFICIAL_CLIENT_PACKAGE)) {
          offenders.push(`${path.basename(file)}: ${declaration}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("native V2 readiness probe", () => {
  it("uses the native info endpoint", () => {
    expect(OPENCODE_CONFIG.readinessProbePath).toBe(READINESS_ENDPOINT);
  });

  it("requires a readiness path under the API namespace", () => {
    expect(OPENCODE_CONFIG.readinessProbePath.startsWith("/api/")).toBe(true);
  });
});
