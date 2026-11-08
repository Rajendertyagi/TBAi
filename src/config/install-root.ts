/**
 * Where this install lives on disk — the ONE anchor every derived path uses.
 *
 * ## Why this module exists
 *
 * Two paths had to be anchored to the install rather than to the working
 * directory, and each computed the anchor independently:
 *
 *   - the data directory (`./data-dir.ts`), after a compiled binary resolved
 *     `<drive root>\data` and died with EPERM at boot;
 *   - the directory the built SPA is served from (`./web-dist.ts`), which fell
 *     back to `process.cwd()/dist/web`, so a standalone binary served the UI
 *     only when launched from the repository root.
 *
 * Two copies of "is this a checkout, or a bundle?" is one copy too many: they
 * would drift the moment either branch changed, and the failure would show up
 * only in a packaged build.
 *
 * ## The anchor, and why there are two branches
 *
 * In a source checkout, `import.meta.dir` is this module's own directory, fixed
 * by the code's location on disk and unmovable by changing directory. `../..`
 * from `src/config/` is the repository root.
 *
 * That anchor is meaningless inside a `bun build --compile` bundle: there
 * `import.meta.dir` is Bun's VIRTUAL filesystem (`B:\~BUN\root` on Windows,
 * `/$bunfs/root` elsewhere), so `../..` collapses to a drive root. A packaged
 * program has no repository to anchor to, so it anchors to the directory it is
 * installed in — `dirname(process.execPath)` — which is the same rule
 * `src-tauri`'s `resolve_data_dir()` already applies (`exe.parent().join("data")`),
 * so the desktop app and a standalone binary agree on one portable folder.
 *
 * Which branch applies is decided by *whether the anchor is really the
 * repository*, tested the same way `tests/helpers/repo-root.ts` identifies it: a
 * root-level marker file. Deliberately not `$bunfs`/`~BUN` string matching, which
 * would pin Bun's internal layout across platforms and versions.
 */
import fs from "node:fs";
import path from "node:path";

/** Files that only exist at the repository root — see `tests/helpers/repo-root.ts`. */
const ROOT_MARKERS = ["bun.lock", "package.json"] as const;

/** Repository root, fixed by module location rather than by working directory. */
export const REPO_ROOT = path.resolve(import.meta.dir, "../..");

/** Whether {@link REPO_ROOT} is a real checkout rather than a bundler's virtual FS. */
export const ANCHOR_IS_CHECKOUT = ROOT_MARKERS.some((marker) =>
  fs.existsSync(path.join(REPO_ROOT, marker)),
);

/**
 * The directory this install's files sit in: the repository root in a checkout,
 * the executable's own directory when packaged.
 *
 * Pure, so BOTH branches are unit-testable in process: the packaged branch
 * cannot be reached by importing this module (it needs `import.meta.dir` to be a
 * virtual path), only by calling it with explicit inputs.
 */
export function resolveInstallRoot(input: {
  /** Repository-root candidate derived from this module's location. */
  anchor: string;
  /** Whether {@link anchor} is a real checkout; when false, `execPath` decides. */
  anchorIsCheckout: boolean;
  /** `process.execPath` — the executable actually running. */
  execPath: string;
}): string {
  return input.anchorIsCheckout ? input.anchor : path.dirname(input.execPath);
}

/** The install root this running process is using. Absolute by construction. */
export const INSTALL_ROOT = resolveInstallRoot({
  anchor: REPO_ROOT,
  anchorIsCheckout: ANCHOR_IS_CHECKOUT,
  execPath: process.execPath,
});
