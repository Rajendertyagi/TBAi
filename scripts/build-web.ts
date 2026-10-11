/**
 * The ONE supported way to build the web bundle for E2E.
 *
 * ## Why this exists
 *
 * The E2E suite serves `dist/web`, a build output. Building it was a separate,
 * optional step the operator was expected to remember, so a source edit followed
 * by `bun run test:e2e` silently exercised the PREVIOUS bundle and reported a
 * confident, wrong result. Worse, a failed build left the old bundle in place, so
 * the failure was invisible too.
 *
 * This script closes that by owning both halves of the guarantee:
 *
 *   1. it CLEARS the provenance stamp before building, so a failed or partial
 *      build can never leave an artifact that still looks trustworthy;
 *   2. it writes the stamp only after a fully successful build.
 *
 * So "stamped" means exactly "built from the current source, successfully". There
 * is no window in which a stale or half-written bundle carries a valid stamp.
 *
 * ## Why not just build inside `run-e2e.ts`
 *
 * Because the stamp has to be written by whoever performs the build, and the
 * stamp has to be checked by whoever serves it. Keeping that in one place means
 * `bun run build:web` (a developer at a terminal) and `bun run test:e2e` produce
 * byte-identical provenance, instead of two code paths that can drift.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clearBuildStamp, hashWebSource, writeBuildStamp } from "./web-build-provenance";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB_ROOT = path.join(REPO_ROOT, "web");
const WEB_DIST = path.join(REPO_ROOT, "dist", "web");

/** The real build. `web`'s own script is the single definition of it. */
const BUILD_LABEL = "cd web && bun run build";

/** Optional target paths for isolated tests. Production calls use repository defaults. */
export interface BuildWebAndStampOptions {
  readonly webRoot?: string;
  readonly webDist?: string;
  readonly buildLabel?: string;
}

/**
 * Build the web bundle and stamp it on success.
 *
 * Exported with an injectable build function so the orchestration can be tested
 * by EXECUTING it — including the failure path — instead of asserting that two
 * lines of code appear in the right order. A test that reads the source proves
 * nothing about what happens when the build fails.
 *
 * @param build - Runs the actual build. Throwing or returning a non-zero code
 * both count as failure.
 * @param onLog - Progress output; defaults to stderr.
 * @param options - Optional test-only target paths. Defaults to the repository's
 *   real web source and build-output directories.
 * @returns True when the build succeeded AND the stamp was written.
 */
export function buildWebAndStamp(
  build: () => number | undefined,
  onLog: (message: string) => void = (m) => process.stderr.write(`[build:web] ${m}\n`),
  options: BuildWebAndStampOptions = {},
): boolean {
  const webRoot = options.webRoot ?? WEB_ROOT;
  const webDist = options.webDist ?? WEB_DIST;
  const buildLabel = options.buildLabel ?? BUILD_LABEL;
  // Before, not after: see the module docblock. This is what makes a failed
  // build safe rather than merely noisy.
  const hadStamp = clearBuildStamp(webDist);
  if (hadStamp) onLog("cleared the previous build stamp before rebuilding");

  let code: number | undefined;
  try {
    code = build();
  } catch (error) {
    onLog(`build threw: ${String(error)}`);
    code = 1;
  }

  if (typeof code === "number" && code !== 0) {
    onLog(
      `build failed (exit ${code}); dist/web is left unstamped and will be refused by the E2E server`,
    );
    return false;
  }

  // Hashed AFTER the build, not before: a build can legitimately rewrite a
  // tracked-looking input (a generated file, an updated tsconfig), and the stamp
  // must describe the source that actually produced THIS artifact.
  const sourceHash = hashWebSource(webRoot);
  writeBuildStamp(webDist, sourceHash, buildLabel);
  onLog(`built and stamped dist/web (source ${sourceHash.slice(0, 12)}…)`);
  return true;
}

/**
 * Run the real web build synchronously.
 *
 * Exported so there is exactly ONE definition of the build command in the
 * repository: a second copy here would be free to drift, and a drifted build is
 * a bundle nobody is testing.
 */
export function runWebBuild(): number {
  const result = spawnSync("bun", ["run", "build"], {
    cwd: WEB_ROOT,
    // Inherited so `tsc` diagnostics reach the operator verbatim — a swallowed
    // build error is the exact failure mode this script exists to prevent.
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  return result.status ?? 1;
}

if (import.meta.main) {
  const ok = buildWebAndStamp(runWebBuild);
  process.exit(ok ? 0 : 1);
}
