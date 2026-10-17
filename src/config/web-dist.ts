/**
 * Where the built SPA is served from — ONE definition, anchored to the install.
 *
 * ## Why this module exists
 *
 * The served directory defaulted to `process.cwd()/dist/web`, so it depended on
 * where the process was launched rather than where the files are. In a source
 * checkout launched from the repository root that happens to be right, which is
 * why the defect went unnoticed; every other launch shape is wrong:
 *
 *   - `dist/tbai-server.exe` run from inside `dist/` resolved `dist/dist/web`
 *     and answered `GET /` with 404 while the UI sat next to the executable;
 *   - `bun src/index.ts` run from `web/` served a directory that does not exist.
 *
 * The layout is fixed and identical in both shapes: `tbai-server` sits in the
 * directory that also holds `web/`, so a packaged install resolves
 * `<dirname(process.execPath)>/web` — exactly beside the binary — and never
 * falls back to a directory that is not there.
 *
 * `WEB_DIST_DIR` remains the only seam that redirects this, which is what lets
 * the e2e suite and the CPU-profiling run serve a different artifact without
 * touching production code.
 *
 * ADR: `docs/decisions.md` "The SPA builds into `dist/web`, beside the server
 * binary, not into `web/dist`".
 */
import path from "node:path";
import { ANCHOR_IS_CHECKOUT, REPO_ROOT, resolveInstallRoot } from "./install-root";

/**
 * The served directory this install uses with no `WEB_DIST_DIR` override.
 *
 * Pure, so BOTH branches are unit-testable in process: the packaged branch
 * cannot be reached by importing this module (it needs `import.meta.dir` to be a
 * virtual path), only by calling it with explicit inputs.
 */
export function resolveDefaultWebDistDir(input: {
  /** Repository-root candidate derived from the module's location. */
  anchor: string;
  /** Whether {@link anchor} is a real checkout; when false, `execPath` decides. */
  anchorIsCheckout: boolean;
  /** `process.execPath` — the executable actually running. */
  execPath: string;
}): string {
  // A checkout keeps the build output under `<repo>/dist/web`; a packaged
  // install keeps `web/` beside the binary, in the very directory the binary
  // was compiled into.
  return input.anchorIsCheckout
    ? path.join(resolveInstallRoot(input), "dist", "web")
    : path.join(resolveInstallRoot(input), "web");
}

/**
 * The served directory this install WOULD use with no `WEB_DIST_DIR` override.
 *
 * Distinct from {@link WEB_DIST_DIR} on purpose: the E2E harness sets the env
 * override, and the default must stay anchored to the install so it can be
 * asserted independently of that override.
 */
export const DEFAULT_WEB_DIST_DIR = resolveDefaultWebDistDir({
  anchor: REPO_ROOT,
  anchorIsCheckout: ANCHOR_IS_CHECKOUT,
  execPath: process.execPath,
});

/** Absolute by construction: either the explicit override or the anchored default. */
export const WEB_DIST_DIR = process.env.WEB_DIST_DIR ?? DEFAULT_WEB_DIST_DIR;
