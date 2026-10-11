/**
 * Tests for the test-location policy checker (`scripts/check-test-location.ts`).
 *
 * The checker is the enforcement mechanism for "all tests live under `tests/`",
 * so it is itself tested: a checker that silently passes is worse than no
 * checker, because CI would report the rule as satisfied.
 *
 * These run against throwaway fixture trees rather than the real repository, so
 * they assert behaviour rather than the repository's current contents — the repo
 * will legitimately change over time and the checker must keep passing.
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  findMisresolvedAliasImports,
  findViolations,
  hasTestDirectorySegment,
  isInsideCanonicalRoot,
  isTestFileName,
  toRepoRelative,
} from "../../../scripts/check-test-location";

/** Build a throwaway tree from a `path -> contents` map and return its root. */
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "test-location-"));
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents, "utf8");
  }
  return root;
}

/** Run `body` with a fixture root, cleaning up afterwards whatever happens. */
function withFixture(files: Record<string, string>, body: (root: string) => void): void {
  const root = fixture(files);
  try {
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("isTestFileName", () => {
  it("accepts the repo's .test. and .spec. conventions", () => {
    expect(isTestFileName("foo.test.ts")).toBe(true);
    expect(isTestFileName("foo.test.tsx")).toBe(true);
    expect(isTestFileName("foo.spec.ts")).toBe(true);
    expect(isTestFileName("p2-live-runtime.spec.ts")).toBe(true);
  });

  it("accepts the alternate infixes so another ecosystem's convention is still caught", () => {
    expect(isTestFileName("test_foo.ts")).toBe(true);
    expect(isTestFileName("foo_test.tsx")).toBe(true);
    expect(isTestFileName("foo_spec.ts")).toBe(true);
  });

  it("scopes detection to this repository's languages", () => {
    // The checker guards TBAi, which is TypeScript/JavaScript. A .go or .rb file
    // is not something this repo can contain, so flagging it would be noise from
    // an extension list nobody maintains.
    expect(isTestFileName("foo_test.go")).toBe(false);
    expect(isTestFileName("foo_test.rb")).toBe(false);
  });

  it("does not flag production files that merely contain the word test", () => {
    // The regression this guards: a substring check would flag all three.
    expect(isTestFileName("contest.ts")).toBe(false);
    expect(isTestFileName("latest.ts")).toBe(false);
    expect(isTestFileName("attestation.tsx")).toBe(false);
    expect(isTestFileName("manifest.ts")).toBe(false);
  });

  it("rejects a test-looking name with an unsupported extension", () => {
    expect(isTestFileName("foo.test.tsbuildinfo")).toBe(false);
    expect(isTestFileName("foo.test.txt")).toBe(false);
  });
});

describe("hasTestDirectorySegment", () => {
  it("detects files living under a test-only directory", () => {
    expect(hasTestDirectorySegment("web/e2e/helpers/stubProvider.ts")).toBe(true);
    expect(hasTestDirectorySegment("pkg/__tests__/render.test.tsx")).toBe(true);
  });

  it("does not fire on a path with no test directory", () => {
    expect(hasTestDirectorySegment("web/src/lib/log-entries.ts")).toBe(false);
  });

  it("only inspects directory segments, never the file name", () => {
    // "e2e" as the final segment is a file name, so it must not match.
    expect(hasTestDirectorySegment("src/e2e")).toBe(false);
  });
});

describe("isInsideCanonicalRoot", () => {
  it("accepts the tests root and anything under it", () => {
    expect(isInsideCanonicalRoot("tests")).toBe(true);
    expect(isInsideCanonicalRoot("tests/unit/history/a.test.ts")).toBe(true);
  });

  it("rejects lookalikes that are not actually inside it", () => {
    expect(isInsideCanonicalRoot("tests-dom/a.test.ts")).toBe(false);
    expect(isInsideCanonicalRoot("src/a.test.ts")).toBe(false);
    expect(isInsideCanonicalRoot("web/tests/a.test.ts")).toBe(false);
  });
});

describe("toRepoRelative", () => {
  it("produces forward slashes regardless of platform separator", () => {
    // Built from a real root: path.relative needs two absolute paths on the same
    // volume, and "/repo" is not absolute on Windows.
    const root = mkdtempSync(path.join(tmpdir(), "rel-"));
    try {
      expect(toRepoRelative(path.join(root, "a", "b", "c.ts"), root)).toBe("a/b/c.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps spaces intact rather than splitting the path", () => {
    const root = mkdtempSync(path.join(tmpdir(), "rel-"));
    try {
      expect(toRepoRelative(path.join(root, "my tests", "a b.test.ts"), root)).toBe(
        "my tests/a b.test.ts",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("findViolations", () => {
  it("reports a test file outside tests/ and leaves a correct one alone", () => {
    withFixture(
      {
        "tests/unit/ok.test.ts": "",
        "src/lib/bad.test.ts": "",
      },
      (root) => {
        const violations = findViolations(root);
        expect(violations.map((v) => v.path)).toEqual(["src/lib/bad.test.ts"]);
        expect(violations[0].reason).toContain("naming convention");
      },
    );
  });

  it("flags test-only assets inside an e2e directory even when not named as tests", () => {
    withFixture({ "web/e2e/helpers/stubProvider.ts": "" }, (root) => {
      const violations = findViolations(root);
      expect(violations.map((v) => v.path)).toEqual(["web/e2e/helpers/stubProvider.ts"]);
    });
  });

  it("catches untracked files, because it scans the filesystem rather than git", () => {
    // Both files are created directly on disk; neither is in any VCS.
    withFixture({ "src/new/thing.test.ts": "" }, (root) => {
      expect(findViolations(root)).toHaveLength(1);
    });
  });

  it("ignores dependency, build-output and VCS directories", () => {
    withFixture(
      {
        "node_modules/pkg/src/thing.test.ts": "",
        "dist/web/src/thing.test.ts": "",
        ".git/thing.test.ts": "",
        "tests/dist/leftover.test.ts": "",
      },
      (root) => {
        expect(findViolations(root)).toEqual([]);
      },
    );
  });

  it("does not flag production files that merely contain 'test'", () => {
    withFixture(
      {
        "src/lib/latest.ts": "",
        "src/ui/contest.tsx": "",
        "web/src/lib/manifest.ts": "",
      },
      (root) => {
        expect(findViolations(root)).toEqual([]);
      },
    );
  });

  it("returns a stable, sorted list", () => {
    withFixture(
      { "z/last.test.ts": "", "a/first.test.ts": "", "m/middle.spec.ts": "" },
      (root) => {
        expect(findViolations(root).map((v) => v.path)).toEqual([
          "a/first.test.ts",
          "m/middle.spec.ts",
          "z/last.test.ts",
        ]);
      },
    );
  });

  it("handles a repository path containing spaces", () => {
    const outer = mkdtempSync(path.join(tmpdir(), "space-"));
    const root = path.join(outer, "my repo");
    try {
      mkdirSync(path.join(root, "src"), { recursive: true });
      writeFileSync(path.join(root, "src", "a.test.ts"), "", "utf8");
      expect(findViolations(root).map((v) => v.path)).toEqual(["src/a.test.ts"]);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });
});

describe("findMisresolvedAliasImports", () => {
  it("flags a bare @/ import in a WEB layer, where it repoints to the backend", () => {
    withFixture(
      {
        "src/lib/logger.ts": "export const x = 1;\n",
        // The same module name on the web side is what makes the alias ambiguous.
        "web/src/lib/logger.ts": "export const x = 1;\n",
        "tests/dom/components/a.test.ts": 'import { x } from "@/lib/logger";\n',
      },
      (root) => {
        expect(findMisresolvedAliasImports(root)).toEqual([
          "tests/dom/components/a.test.ts  (@/lib/logger also exists at web/src/lib/logger)",
        ]);
      },
    );
  });

  it("accepts an unambiguous bare @/ import in a web layer", () => {
    // A DOM-layer test may legitimately drive backend services. `@/db` names only
    // a backend module, so there is nothing for the alias to be confused with and
    // flagging it would be noise on correct code.
    withFixture(
      {
        "src/db.ts": "export const db = 1;\n",
        "tests/dom/persistence/a.test.ts": 'import { db } from "@/db";\n',
      },
      (root) => {
        expect(findMisresolvedAliasImports(root)).toEqual([]);
      },
    );
  });

  it("ignores a bare @/ sequence that appears inside a string, not an import", () => {
    // Source guards assert on the TEXT of other modules, so `from "@/lib/logger"`
    // occurs inside assertion strings. Only real imports are policed.
    withFixture(
      {
        "src/lib/logger.ts": "export const x = 1;\n",
        "web/src/lib/logger.ts": "export const x = 1;\n",
        "tests/dom/components/a.test.ts":
          'const expected = `from "@/lib/logger"`;\nexpect(source).toContain(expected);\n',
      },
      (root) => {
        expect(findMisresolvedAliasImports(root)).toEqual([]);
      },
    );
  });

  it("accepts a bare @/ import in a BACKEND layer, where it is correct", () => {
    // `@/*` means the backend from the root tsconfig, so backend suites must use
    // it. Flagging these would be a false positive on ~400 legitimate imports.
    withFixture(
      {
        "tests/unit/core/a.test.ts": 'import { x } from "@/lib/logger";\n',
        "tests/integration/core/b.test.ts": 'import { y } from "@/routes/index";\n',
      },
      (root) => {
        expect(findMisresolvedAliasImports(root)).toEqual([]);
      },
    );
  });

  it("flags tests/unit/web, which is a web layer despite living under unit/", () => {
    withFixture(
      {
        "src/lib/logger.ts": "export const x = 1;\n",
        "web/src/lib/logger.ts": "export const x = 1;\n",
        "tests/unit/web/a.test.ts": 'import { x } from "@/lib/logger";\n',
      },
      (root) => {
        expect(findMisresolvedAliasImports(root)).toEqual([
          "tests/unit/web/a.test.ts  (@/lib/logger also exists at web/src/lib/logger)",
        ]);
      },
    );
  });

  it("accepts the explicit @web/ alias", () => {
    withFixture({ "tests/dom/a.test.ts": 'import { x } from "@web/lib/logger";\n' }, (root) => {
      expect(findMisresolvedAliasImports(root)).toEqual([]);
    });
  });

  it("does not flag a relative import", () => {
    withFixture({ "tests/dom/a.test.ts": 'import { x } from "./helper";\n' }, (root) => {
      expect(findMisresolvedAliasImports(root)).toEqual([]);
    });
  });
});

describe("the real repository satisfies the policy", () => {
  // These are the load-bearing end-state assertions: they are what makes the CI
  // gate mean something. They were parked while the migration was in flight so
  // the suite stayed green for one understood reason instead of ~280
  // unexplained ones, and re-enabled once `bun run test:locations` came back
  // clean. A future test created outside `tests/` now fails HERE as well as in
  // the dedicated gate.
  it("has no violations outside tests/", () => {
    expect(findViolations()).toEqual([]);
  });

  it("has no bare @/ imports in web layers", () => {
    expect(findMisresolvedAliasImports()).toEqual([]);
  });
});