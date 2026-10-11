/**
 * Test-location policy: every test file lives under the root `tests/` directory.
 *
 * Run via `bun run test:locations` (wired into the `verify` CI job). Exits 0
 * when the tree obeys the rule, non-zero listing every offending repo-relative
 * path when it does not.
 *
 * ## Why this exists
 *
 * The repository grew ten separate test roots (`tests/unit`, `web/e2e`,
 * `web/tests-dom`, `web/tests`, plus tests colocated inside `web/src` and
 * `src/`). Colocated tests inside production trees are the worst case: they are
 * typechecked by a different tsconfig than the rest of `tests/`, they are not
 * linted by the same rules, and nothing makes a newcomer look in `tests/` first.
 * One canonical root plus an automated gate is cheaper than a convention.
 *
 * ## Design notes
 *
 * - **Filesystem scan, not `git ls-files`.** The policy must catch a test that
 *   has been created but not yet committed, which is exactly when it is easiest
 *   to move.
 * - **Patterns, never substring matching.** `contest.ts` and `latest.ts` contain
 *   "test" and are not tests. Every pattern below is anchored on a segment
 *   boundary.
 * - **Normalized repo-relative POSIX paths.** Windows separators are normalized
 *   so a violation prints the same string locally and in CI, and so paths
 *   containing spaces are handled (path arithmetic never splits on them).
 * - **No silent exemptions.** If this repo ever needs one it must be a named,
 *   commented entry in EXCLUDED_DIRS with a stated reason.
 */
import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root: this file lives at `<root>/scripts/`. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The one directory allowed to contain tests. */
const CANONICAL_TEST_ROOT = "tests";

/** Extensions a test file may use. Order only affects message ordering. */
const TEST_EXTENSIONS = ["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"] as const;

/**
 * Test-file name patterns, anchored on a segment boundary.
 *
 * `*.test.ts` / `*.spec.ts` are the repo's conventions; the `_test` / `test_`
 * infixes are included so a file that follows another ecosystem's convention is
 * still caught rather than quietly permitted.
 */
const TEST_FILE_PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`\.(test|spec)\.(${TEST_EXTENSIONS.join("|")})$`),
  new RegExp(String.raw`(^|/)(test|tests)_[^/]*\.(${TEST_EXTENSIONS.join("|")})$`),
  new RegExp(String.raw`^[^/]*_(test|spec)\.(${TEST_EXTENSIONS.join("|")})$`),
];

/**
 * Directory names whose contents are tests by definition.
 *
 * `__tests__` is the cross-ecosystem convention. `e2e` is included because an
 * E2E suite is a test suite regardless of what its files are named.
 */
const TEST_DIRECTORY_NAMES: ReadonlySet<string> = new Set(["__tests__", "e2e", "test", "spec"]);

/**
 * Directories never descended into: dependencies, build output, VCS internals,
 * and runtime data. `tests/dist` is covered by the `dist` entry.
 */
const EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  ".git",
  ".agents",
  ".tmp-p2",
  "data",
  "workspace",
  "build",
  "coverage",
  "test-results",
  "playwright-report",
]);

/** Convert an absolute path to a repo-relative POSIX path (`a\b` -> `a/b`). */
export function toRepoRelative(absolutePath: string, root: string = REPO_ROOT): string {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

/** True when `relativePath` is inside the one permitted test root. */
export function isInsideCanonicalRoot(relativePath: string): boolean {
  return relativePath === CANONICAL_TEST_ROOT || relativePath.startsWith(`${CANONICAL_TEST_ROOT}/`);
}

/** True when the file name marks this as a test file. */
export function isTestFileName(fileName: string): boolean {
  return TEST_FILE_PATTERNS.some((pattern) => pattern.test(fileName));
}

/** True when any path segment is a directory whose contents are tests. */
export function hasTestDirectorySegment(relativePath: string): boolean {
  return relativePath.split("/").slice(0, -1).some((segment) => TEST_DIRECTORY_NAMES.has(segment));
}

/** One violation, with enough context for a human to act without re-deriving it. */
export interface Violation {
  /** Repo-relative POSIX path. */
  readonly path: string;
  /** Why it was flagged, in plain words. */
  readonly reason: string;
}

/**
 * Collect every test file outside `tests/`.
 *
 * Walks the real filesystem, so untracked files are included.
 */
export function findViolations(root: string = REPO_ROOT): Violation[] {
  const violations: Violation[] = [];

  const walk = (absoluteDir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(absoluteDir, { withFileTypes: true });
    } catch {
      // Unreadable directory (permissions, a race with another process). Not a
      // violation; skipping keeps the checker from failing on the environment.
      return;
    }

    for (const entry of entries) {
      const absolute = path.join(absoluteDir, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;

      const relative = toRepoRelative(absolute, root);
      if (isInsideCanonicalRoot(relative)) continue;

      if (isTestFileName(entry.name)) {
        violations.push({ path: relative, reason: "test file naming convention" });
      } else if (hasTestDirectorySegment(relative)) {
        violations.push({ path: relative, reason: "file inside a test-only directory" });
      }
    }
  };

  walk(root);
  violations.sort((a, b) => a.path.localeCompare(b.path));
  return violations;
}

/**
 * Fail if a file in a WEB layer imports through the bare `@/` alias.
 *
 * `@/*` means `src/*` from the ROOT tsconfig but `web/src/*` from the web
 * tsconfig, so its meaning depends on which project compiles the file. In the
 * BACKEND layers (`unit/`, `integration/`) `@/` is correct and expected — those
 * suites test backend code. In the WEB layers (`dom/`, `e2e/`, `unit/web/`) it
 * would silently resolve to the backend tree, where a same-named module often
 * exists: `@/lib/logger` exists at BOTH `src/lib/logger.ts` and
 * `web/src/lib/logger.ts`. The import then compiles, and the test passes against
 * the wrong module. Those must use `@web/*`.
 *
 * Scoping by layer is what makes this rule correct rather than merely loud.
 */
const WEB_LAYER_DIRS: ReadonlySet<string> = new Set(["dom", "e2e"]);

function isWebLayerFile(relativePath: string): boolean {
  const segments = relativePath.split("/");
  const layer = segments[1];
  if (WEB_LAYER_DIRS.has(layer)) return true;
  return layer === "unit" && segments[2] === "web";
}

/**
 * The module specifiers of a file's real import statements.
 *
 * A textual search for `from "@/` is not enough: these guard files assert on the
 * SOURCE TEXT of other modules, so the sequence `from "@/lib/focus"` appears
 * inside an assertion string as readily as inside an import. Matching the former
 * reports a false violation; ignoring it would miss a real one. So the file is
 * scanned as code - comments and string bodies are recognised as such and only
 * a string in an import position is returned.
 */
export function extractImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];

  // Strip comments first, while preserving offsets so string scanning stays aligned.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
    .replace(/(^|[^:])\/\/.*$/gm, (_m, lead: string) => lead + " ".repeat(Math.max(0, _m.length - lead.length)));

  let i = 0;
  while (i < code.length) {
    const ch = code[i];

    if (ch === '"' || ch === "'" || ch === "`") {
      const start = i;
      i++;
      while (i < code.length && code[i] !== ch) i += code[i] === "\\" ? 2 : 1;
      i++;
      const body = code.slice(start + 1, i - 1);
      // Keep this literal only when it is an import specifier, i.e. when the
      // code immediately before it names an import.
      const before = code.slice(0, start);
      if (/\b(?:from|import|require|import\s*\()\s*$/i.test(before)) specifiers.push(body);
      continue;
    }
    i++;
  }
  return specifiers;
}

export function findMisresolvedAliasImports(
  root: string = REPO_ROOT,
  extensionPattern: RegExp = /\.(ts|tsx|mts|cts)$/,
): string[] {
  const offenders: string[] = [];
  const testsRoot = path.join(root, CANONICAL_TEST_ROOT);
  const exists = (relative: string): boolean =>
    [".ts", ".tsx", ".js", ".jsx", ""].some((ext) => existsSync(path.join(root, relative + ext)));

  const walk = (absoluteDir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(absoluteDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = path.join(absoluteDir, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        walk(absolute);
        continue;
      }
      if (!entry.isFile() || !extensionPattern.test(entry.name)) continue;

      const relative = toRepoRelative(absolute, root);
      if (!isWebLayerFile(relative)) continue;

      let source: string;
      try {
        source = readFileSync(absolute, "utf8");
      } catch {
        continue;
      }

      for (const specifier of extractImportSpecifiers(source)) {
        if (!specifier.startsWith("@/")) continue;
        const bare = specifier.slice("@/".length);
        // Only AMBIGUOUS specifiers are a hazard. When the same module exists in
        // both trees the bare alias silently changes meaning; when it exists only
        // under src/ there is nothing to confuse it with, and `@/db` is simply
        // the correct spelling for a backend module a DOM-layer test drives.
        if (!exists(`web/src/${bare}`)) continue;
        offenders.push(`${relative}  (${specifier} also exists at web/src/${bare})`);
        break;
      }
    }
  };

  walk(testsRoot);
  offenders.sort((a, b) => a.localeCompare(b));
  return offenders;
}

/** CLI entry. Prints a report and sets the exit code. */
function main(): void {
  const violations = findViolations();
  const aliasOffenders = findMisresolvedAliasImports();

  if (violations.length === 0 && aliasOffenders.length === 0) {
    console.log("[test:locations] OK — every test file lives under ./tests");
    return;
  }

  if (violations.length > 0) {
    console.error(
      `\n[test:locations] ${violations.length} test file(s) outside ./${CANONICAL_TEST_ROOT}:\n`,
    );
    for (const violation of violations) {
      console.error(`  ${violation.path}  (${violation.reason})`);
    }
    console.error(
      `\n  Move them under ./${CANONICAL_TEST_ROOT}/<layer>/<feature>/ and update imports` +
        ` and runner discovery. Do not leave a copy, wrapper, or alias behind.\n`,
    );
  }

  if (aliasOffenders.length > 0) {
    console.error(
      `\n[test:locations] ${aliasOffenders.length} file(s) under ./${CANONICAL_TEST_ROOT} ` +
        `import through the bare "@/" alias:\n`,
    );
    for (const offender of aliasOffenders) {
      console.error(`  ${offender}`);
    }
    console.error(
      `\n  "@/*" means src/* (backend) from the root tsconfig. Web sources must be` +
        ` imported as "@web/..." so the module cannot silently change meaning.\n`,
    );
  }

  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}