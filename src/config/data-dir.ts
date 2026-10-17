/**
 * The application's data directory — ONE definition, anchored to the install.
 *
 * ## Why this module exists
 *
 * Four modules each computed this independently:
 *
 *   process.env.DATA_DIR || path.join(process.cwd(), "data")
 *
 * `process.cwd()` is the bug. The data directory then depends on where the
 * process happened to be launched rather than where the code lives, and each of
 * those call sites `mkdirSync`s the result, so the wrong one is created
 * silently. Launching from `web/` produced `web/data/chat.db`; launching from
 * `src/context/` produced `src/context/data/chat.db`. Both were real, populated
 * databases sitting next to the source, each holding a different slice of a
 * developer's conversations, and neither reachable from the other.
 *
 * The failure mode is not tidiness. A developer who launches from a
 * subdirectory gets an EMPTY database and reasonably concludes their history was
 * lost; one who writes into it has their work somewhere no UI points at. The
 * repository had already been bitten hard enough to leave a note in `.gitignore`
 * about "11 of them" accumulating by the same mechanism.
 *
 * ## The anchor, and why there are two of them
 *
 * The anchor itself now lives in `./install-root.ts`, because the served SPA
 * directory (`./web-dist.ts`) needs the same one. This module keeps the rule it
 * derives from it.
 *
 * In a source checkout, `import.meta.dir` is this module's own directory, fixed
 * by the code's location on disk and unmovable by changing directory. One
 * `../..` from `src/config/` is the repository root.
 *
 * That anchor is meaningless inside a `bun build --compile` bundle: there
 * `import.meta.dir` is Bun's VIRTUAL filesystem (`B:\~BUN\root` on Windows,
 * `/$bunfs/root` elsewhere), not the source tree. `../..` from it collapses to a
 * drive root, so a single-anchor version resolved the default data directory to
 * `<root>\data` and `src/db/index.ts`'s `mkdirSync` died with EPERM at module
 * init — the standalone `dist/tbai-server.exe` could not start. The Tauri shell
 * masks this, because `src-tauri/src/main.rs` passes `DATA_DIR` explicitly; the
 * defect only surfaced when the binary was run directly.
 *
 * A packaged binary therefore anchors to the directory it is installed in —
 * `dirname(process.execPath)/data` — which is the same rule the Tauri shell's
 * `resolve_data_dir()` already applies (`exe.parent().join("data")`), so the
 * desktop app and a standalone binary agree on one portable folder.
 *
 * `DATA_DIR` still overrides everything — the E2E harness sets it to
 * `tests/.artifacts/e2e-data` precisely so the suite can never touch the
 * maintainer's live database.
 */
import path from "node:path";
import { ANCHOR_IS_CHECKOUT, REPO_ROOT, resolveInstallRoot } from "./install-root";

/**
 * The data directory this install uses with no `DATA_DIR` override.
 *
 * Pure, so BOTH branches are unit-testable in process: the packaged branch
 * cannot be reached by importing this module (it needs `import.meta.dir` to be a
 * virtual path), only by calling it with explicit inputs.
 */
export function resolveDefaultDataDir(input: {
  /** Repository-root candidate derived from this module's location. */
  anchor: string;
  /** Whether {@link anchor} is a real checkout; when false, the packaged branch is used. */
  anchorIsCheckout: boolean;
  /** `process.execPath` — the executable actually running. */
  execPath: string;
}): string {
  return path.join(resolveInstallRoot(input), "data");
}

/**
 * The data directory this install WOULD use with no `DATA_DIR` override.
 *
 * Distinct from {@link DATA_DIR} on purpose, and the difference is load-bearing:
 * the relocated-install safety checks compare the two to decide whether an
 * operator has pointed the app at a scratch location. Collapsing them would make
 * "was this relocated?" permanently false and silently disable those guards.
 *
 * Sharing {@link resolveDefaultDataDir} with `DATA_DIR` is what keeps that
 * comparison honest in a packaged build. Before, the default came from a virtual
 * path while `DATA_DIR` came from the shell, so every packaged install looked
 * "relocated" and the orphan sweep stood down permanently
 * (`evaluateOrphanSweepSafety` in `src/services/workspace.ts`).
 *
 * Absolute by construction: a path resolved from a fixed anchor, never relative,
 * so no caller can resolve it differently by changing directory.
 */
export const DEFAULT_DATA_DIR = resolveDefaultDataDir({
  anchor: REPO_ROOT,
  anchorIsCheckout: ANCHOR_IS_CHECKOUT,
  execPath: process.execPath,
});

/**
 * Where the application keeps its database, logs and OpenCode home directory.
 *
 * Absolute by construction: either the explicit `DATA_DIR` override or
 * {@link DEFAULT_DATA_DIR}.
 */
export const DATA_DIR = process.env.DATA_DIR ?? DEFAULT_DATA_DIR;

/** The SQLite database inside {@link DATA_DIR}. */
export const DB_PATH = path.join(DATA_DIR, "chat.db");

/** The structured application log inside {@link DATA_DIR}. */
export const LOG_PATH = path.join(DATA_DIR, "tbai.log");
