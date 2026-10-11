/**
 * Repository root for test code.
 *
 * Tests that assert on repository SHAPE — architecture guards, source-scope
 * checks, provenance tests — need the repo root so they can read real source
 * files. Almost every one of those used to compute it by counting `..` segments
 * from its own location:
 *
 *     const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
 *
 * That is correct exactly once and silently wrong the moment the file moves. The
 * tests-centralization migration moved several hundred files up to five levels
 * deeper, and every such expression started resolving to `tests/` instead of the
 * repository root — producing ENOENTs against perfectly good source, in files
 * that had no other connection to the change.
 *
 * Walking up to a marker file is depth-independent, so it cannot break again the
 * next time a test is re-bucketed.
 */
import { existsSync } from "node:fs";
import path from "node:path";

/** Files that only exist at the repository root. */
const ROOT_MARKERS = ["bun.lock", "package.json"] as const;

/**
 * Resolve the repository root by walking upward from `startDir` until a marker
 * file is found. Falls back to the parent of `tests/` if the walk escapes the
 * filesystem without finding one, so the failure is a wrong-but-defined path
 * rather than an exception at import time.
 */
export function resolveRepoRoot(startDir: string = path.dirname(import.meta.url)): string {
  let current = path.resolve(startDir);
  // Bounded so a misconfigured checkout cannot spin forever.
  for (let depth = 0; depth < 12; depth++) {
    if (ROOT_MARKERS.some((marker) => existsSync(path.join(current, marker)))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(startDir, "..", "..");
}

/** The repository root, resolved once per process. */
export const REPO_ROOT = resolveRepoRoot();

/** Resolve a repo-relative path to an absolute one. */
export function repoPath(...segments: string[]): string {
  return path.join(REPO_ROOT, ...segments);
}
