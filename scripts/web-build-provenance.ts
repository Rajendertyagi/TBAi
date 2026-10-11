/**
 * Build provenance for the web bundle the E2E suite serves.
 *
 * ## The failure this exists to make impossible
 *
 * `dist/web` is a BUILD OUTPUT, but nothing tied it to the source it came from.
 * `start-e2e-server.ts` checked only that `dist/web/index.html` existed, so a
 * stale-but-present bundle was served silently and the whole suite reported
 * results for code that was not in the tree. That is the worst possible failure
 * mode for a test suite: it does not fail, it lies.
 *
 * The fix is not "remember to build first" — a comment is not a mechanism. It is
 * a STAMP: after a successful build, the exact hash of the build inputs is
 * written next to the artifact. The server refuses to start unless that stamp
 * still matches the source on disk. So the question "is the served bundle
 * current?" is answered by comparing two values, not by trusting the operator.
 *
 * ## Why content hashing, not mtimes
 *
 * An mtime comparison looks equivalent and is not. It breaks on clock skew, on
 * checkouts that rewrite mtimes, on a `git stash` that moves a file's mtime
 * backwards, and on any build that preserves timestamps. Hashing the bytes makes
 * "is this current?" a pure function of content, so the same source always
 * produces the same stamp on any machine.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * The inputs that determine `dist/web`, as an explicit allow-list.
 *
 * Deliberately an allow-list and not an exclusion list. `web/` also holds
 * `node_modules`, `dist-profile`, `test-results`, logs and scratch dirs, none of
 * which affect the bundle; enumerating what is excluded would rot as new
 * directories appear, and a stray file slipping into the hash would make every
 * run report a false "stale".
 */
export const WEB_BUILD_INPUT_DIRS = ["src", "public"] as const;

/** Single files that also determine the bundle (config, entry HTML, manifest). */
export const WEB_BUILD_INPUT_FILES = [
  "index.html",
  "package.json",
  "vite.config.ts",
  "tsconfig.json",
] as const;

/**
 * Where the stamp lives.
 *
 * A SIBLING of the bundle, not a file inside it. `dist/web` is the shipping
 * layout — the static catch-all serves every file in it — so a build-metadata
 * file placed there would be deployed with the app. Provenance is a property of
 * the build, not part of the product, so it sits beside the artifact it
 * describes and `dist/web` stays exactly what ships.
 */
export const BUILD_STAMP_FILE = "web-build-stamp.json";

export interface BuildStamp {
  /**
   * Hash of every build input's path and content. Compared against a freshly
   * computed hash to decide whether the artifact is current.
   */
  readonly sourceHash: string;
  /** When the build succeeded. Diagnostic only — never used to decide currency. */
  readonly builtAt: string;
  /** The build command that produced the artifact, for the log line. */
  readonly builtWith: string;
}

const isDirectory = (target: string): boolean => {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
};

const isFile = (target: string): boolean => {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
};

/**
 * Every build-input file, as repo-relative POSIX paths, sorted.
 *
 * Sorting is what makes the hash order-independent: two machines that walk the
 * tree in different filesystem orders must still agree.
 */
export function webBuildInputFiles(webRoot: string): string[] {
  const files: string[] = [];

  for (const dir of WEB_BUILD_INPUT_DIRS) {
    const absolute = path.join(webRoot, dir);
    if (!isDirectory(absolute)) continue;
    const stack = [absolute];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const child = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(child);
        else if (entry.isFile()) {
          files.push(path.relative(webRoot, child).split(path.sep).join("/"));
        }
      }
    }
  }

  for (const file of WEB_BUILD_INPUT_FILES) {
    if (isFile(path.join(webRoot, file))) files.push(file);
  }

  return files.sort();
}

/**
 * Hash the build inputs' paths AND their bytes.
 *
 * Both matter. The path is what distinguishes `a.tsx` from `b.tsx` when their
 * contents happen to match, and it records a deletion as well as an edit —
 * content-only hashing would miss a removed file whose bytes were also present
 * elsewhere in the tree.
 *
 * @param webRoot - The `web` project directory.
 * @returns A hex digest, stable across machines and filesystem orderings.
 */
export function hashWebSource(webRoot: string): string {
  const hash = createHash("sha256");
  for (const relative of webBuildInputFiles(webRoot)) {
    hash.update(relative);
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(webRoot, relative)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * Absolute path of the stamp describing the bundle in `webDistDir`.
 *
 * @param webDistDir - The built bundle directory, e.g. `<repo>/dist/web`.
 * @returns The stamp path, in the bundle's parent directory.
 */
export const buildStampPath = (webDistDir: string): string =>
  path.join(path.dirname(webDistDir), BUILD_STAMP_FILE);

/**
 * Read the stamp written by a successful build.
 *
 * @returns The stamp, or `null` when it is absent or unreadable. A malformed
 * stamp is treated as absent rather than trusted: an artifact whose provenance
 * cannot be established is exactly the artifact that must not be served.
 */
export function readBuildStamp(webDistDir: string): BuildStamp | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(buildStampPath(webDistDir), "utf8")) as Partial<BuildStamp>;
    if (typeof parsed?.sourceHash !== "string" || parsed.sourceHash.length === 0) return null;
    return {
      sourceHash: parsed.sourceHash,
      builtAt: typeof parsed.builtAt === "string" ? parsed.builtAt : "",
      builtWith: typeof parsed.builtWith === "string" ? parsed.builtWith : "",
    };
  } catch {
    return null;
  }
}

/** Record that `webDistDir` was built from the current source. */
export function writeBuildStamp(
  webDistDir: string,
  sourceHash: string,
  builtWith: string,
  now: Date = new Date(),
): void {
  fs.mkdirSync(webDistDir, { recursive: true });
  const stamp: BuildStamp = { sourceHash, builtAt: now.toISOString(), builtWith };
  fs.mkdirSync(path.dirname(buildStampPath(webDistDir)), { recursive: true });
  fs.writeFileSync(buildStampPath(webDistDir), `${JSON.stringify(stamp, null, 2)}\n`, "utf8");
}

/**
 * Remove any stamp for `webDistDir`.
 *
 * Called BEFORE a build starts, and that ordering is the whole point. If a build
 * fails halfway it may leave a partial bundle behind; without removing the stamp
 * first, the stale stamp would still claim the previous successful build and the
 * server would happily serve a half-written bundle. Deleting first means a failed
 * build can only ever leave an UNSTAMPED artifact, which is refused.
 *
 * @returns True when a stamp was present and removed.
 */
export function clearBuildStamp(webDistDir: string): boolean {
  const target = buildStampPath(webDistDir);
  if (!fs.existsSync(target)) return false;
  fs.rmSync(target, { force: true });
  return true;
}

/** How an artifact compares to the source on disk. */
export type BuildFreshness =
  | { readonly status: "current"; readonly stamp: BuildStamp }
  | { readonly status: "missing-artifact" }
  | { readonly status: "missing-stamp" }
  | { readonly status: "stale"; readonly stamp: BuildStamp; readonly currentHash: string };

/**
 * Decide whether the artifact in `webDistDir` was built from `webRoot`.
 *
 * Every non-current outcome is named rather than collapsed into a boolean,
 * because each needs a different instruction: a missing artifact means "build
 * it", a missing stamp means "it was not built by the supported path", and a
 * stale stamp means "the source moved since it was built". Collapsing them
 * produces exactly the useless error message this module was written to replace.
 *
 * @param webRoot - The `web` project directory (build inputs live here).
 * @param webDistDir - The built bundle directory (`dist/web`).
 */
export function assessWebBuild(webRoot: string, webDistDir: string): BuildFreshness {
  if (!fs.existsSync(path.join(webDistDir, "index.html"))) {
    return { status: "missing-artifact" };
  }
  const stamp = readBuildStamp(webDistDir);
  if (!stamp) return { status: "missing-stamp" };
  const currentHash = hashWebSource(webRoot);
  if (stamp.sourceHash !== currentHash) {
    return { status: "stale", stamp, currentHash };
  }
  return { status: "current", stamp };
}

/** The operator-facing explanation for a non-current artifact. */
export function describeBuildFreshness(freshness: BuildFreshness): string {
  switch (freshness.status) {
    case "missing-artifact":
      return "dist/web does not exist. Run `bun run build:web`.";
    case "missing-stamp":
      return (
        "dist/web has no build stamp, so its provenance cannot be established. " +
        "It was not produced by `bun run build:web`. Run `bun run build:web`."
      );
    case "stale":
      return (
        "dist/web was built from different source than the tree now contains " +
        `(stamp ${freshness.stamp.sourceHash.slice(0, 12)}…, source ${freshness.currentHash.slice(0, 12)}…). ` +
        "Run `bun run build:web`."
      );
    case "current":
      return `dist/web matches the current source (${freshness.stamp.sourceHash.slice(0, 12)}…).`;
  }
}
