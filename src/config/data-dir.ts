/**
 * The application's data directory — ONE definition, anchored to the repository.
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
 * ## The anchor
 *
 * `import.meta.dir` is this module's own directory, which is fixed by the code's
 * location on disk and cannot be changed by launching from anywhere else. One
 * `../..` from `src/config/` is the repository root, so the default resolves to
 * the same absolute path for the server, for tests, and for a compiled binary.
 *
 * `DATA_DIR` still overrides everything — the E2E harness sets it to
 * `tests/.artifacts/e2e-data` precisely so the suite can never touch the
 * maintainer's live database.
 */
import path from "node:path";

/** Repository root, fixed by module location rather than by working directory. */
export const REPO_ROOT = path.resolve(import.meta.dir, "../..");

/**
 * Where the application keeps its database, logs and OpenCode home directory.
 *
 * Absolute by construction: either the explicit `DATA_DIR` override or a path
 * resolved from {@link REPO_ROOT}. Never relative, so no caller can resolve it
 * differently by changing directory.
 */
export const DATA_DIR = process.env.DATA_DIR ?? path.join(REPO_ROOT, "data");

/**
 * The data directory this install WOULD use with no `DATA_DIR` override.
 *
 * Distinct from {@link DATA_DIR} on purpose, and the difference is load-bearing:
 * the relocated-install safety checks compare the two to decide whether an
 * operator has pointed the app at a scratch location. Collapsing them would make
 * "was this relocated?" permanently false and silently disable those guards.
 *
 * Anchored to the repository like {@link DATA_DIR}, so it is a stable baseline
 * rather than a function of the working directory.
 */
export const DEFAULT_DATA_DIR = path.join(REPO_ROOT, "data");

/** The SQLite database inside {@link DATA_DIR}. */
export const DB_PATH = path.join(DATA_DIR, "chat.db");

/** The structured application log inside {@link DATA_DIR}. */
export const LOG_PATH = path.join(DATA_DIR, "tbai.log");