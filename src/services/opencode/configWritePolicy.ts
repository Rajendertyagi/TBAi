import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

/** The shape `node:path` exposes for one platform (`path.win32`, `path.posix`). */
type PlatformPath = typeof path.win32;

/**
 * G4/D5 — the policy around writing an OpenCode configuration document.
 *
 * Two separate questions live here, and both currently answer "no":
 *
 *  1. **May this runtime write at all?** No, in either mode, for two different
 *     reasons.
 *     - An ADOPTED service's document is refused until G4 is implemented,
 *       measured and independently verified (H4 authorises the product surface;
 *       it does not prove the write safe).
 *     - The MANAGED service is refused because it has no TBAi-owned config
 *       root. `serverManager.createChild` passes the host environment through
 *       unchanged (`cwd` is TBAi's, but OpenCode resolves its global document
 *       from `XDG_CONFIG_HOME`), so the document the server reports is the
 *       user's own OpenCode configuration. Plan §9.3(1) requires that a
 *       managed write target the config directory TBAi passes to the child;
 *       TBAi passes none, so there is no root to contain a write, and "the
 *       writer targets the server-reported document" cannot be reconciled with
 *       "the managed root is TBAi-owned". Measured on 2.2.5: the reported
 *       permissions document is the user's global file, not
 *       `data/opencode-home`.
 *  2. **If it may, which path may it touch?** The containment policy below is
 *     the proposed §9.3 guard: one root, an absolute-inside-root positive
 *     case, and a refusal list for every Windows form whose meaning depends on
 *     ambient state. It performs no I/O beyond an `lstat` walk.
 *
 * This module deliberately does NOT contain a writer. §9.3's create-only
 * commit is still blocked. Measured on this machine (2026-10-31, disposable
 * NTFS root): `fs.replaceFile` and `fs.renameat2` do not exist and `Bun.ffi`
 * is undefined, so no conditional-replacement primitive is reachable from the
 * runtime at all; a hard link reports the same `dev`/`ino` and raises `nlink`
 * (2, then 3 for a second link), and survives unlinking the original name, so
 * a leaf with `nlink > 1` is genuinely reachable from outside TBAi's root; a
 * directory junction is creatable without elevation and is refused by `lstat`,
 * while a directory symbolic link is `EPERM` here (elevation/Developer Mode is
 * out of scope); a directory can be opened as an fd, but Node/Bun offer no
 * `openat`, so a parent handle cannot anchor a child. Implementing a writer
 * that cannot be enabled would be dead code pretending to be a capability, so
 * the guard and the refusals are the deliverable and the write path stays
 * disabled.
 */

/** Why a configuration write is refused. Each value is a distinct rule. */
export type OpenCodeConfigWriteRefusalReason = "adopted_g4_unproven" | "managed_root_not_owned";

/** Thrown when a document write is refused before any I/O. */
export class OpenCodeConfigWriteDisabledError extends Error {
  readonly code = "OPENCODE_CONFIG_WRITE_DISABLED";

  constructor(
    readonly reason: OpenCodeConfigWriteRefusalReason = "adopted_g4_unproven",
    message: string = reason === "adopted_g4_unproven"
      ? "OpenCode configuration writes are disabled for an adopted service until G4 is proven"
      : "OpenCode configuration writes are disabled for the managed service: it runs with the user's own configuration environment, so the document it reports is not inside a TBAi-owned root",
  ) {
    super(message);
    this.name = "OpenCodeConfigWriteDisabledError";
  }
}

/** Why a path was refused. Each value is a distinct, testable rule. */
export type OpenCodeConfigPathReason =
  | "root_unresolved"
  | "outside_root"
  | "invalid_form"
  | "reparse_point"
  | "short_name_alias"
  | "hard_link"
  | "replace_unverified"
  | "walk_failed";

/** Thrown when a document path fails the §9.3 containment policy. */
export class OpenCodeConfigPathError extends Error {
  readonly code = "OPENCODE_CONFIG_PATH";

  constructor(
    readonly reason: OpenCodeConfigPathReason,
    message: string,
  ) {
    super(message);
    this.name = "OpenCodeConfigPathError";
  }
}

/** Which connection owns the configuration being written. */
export type OpenCodeConfigWriteMode = "managed" | "adopted";

/** The inputs that decide whether a write is permitted. */
export interface OpenCodeConfigWriteDecisionInput {
  readonly mode: OpenCodeConfigWriteMode;
  /**
   * The enablement switch for an ADOPTED write. Passed by nobody today; it is
   * the one place a future, proven G4 implementation turns that capability on.
   * It does not affect the managed answer, which has no root to contain it.
   */
  readonly g4Verified?: boolean;
}

/**
 * The refusal a write of this mode would raise, or `null` when it may proceed.
 *
 * One function answers both the throwing gate and the read projection, so the
 * `editable` the page renders and the refusal the writer raises cannot drift
 * apart.
 */
export function openCodeConfigWriteRefusal(
  input: OpenCodeConfigWriteDecisionInput,
): OpenCodeConfigWriteRefusalReason | null {
  if (input.mode === "adopted") {
    return input.g4Verified === true ? null : "adopted_g4_unproven";
  }
  // The managed child inherits the user's config environment, so there is no
  // TBAi-owned root to contain a write (see the module header).
  return "managed_root_not_owned";
}

/**
 * Refuses a document write before any file or network I/O.
 *
 * @throws {OpenCodeConfigWriteDisabledError} for every mode today: an adopted
 *   document until G4 is proven, a managed document until TBAi passes the child
 *   a config root it owns.
 */
export function assertOpenCodeConfigWriteAllowed(input: OpenCodeConfigWriteDecisionInput): void {
  const refusal = openCodeConfigWriteRefusal(input);
  if (refusal !== null) throw new OpenCodeConfigWriteDisabledError(refusal);
}

const DRIVE_RELATIVE = /^[A-Za-z]:(?![\\/])/;
const DRIVE_LETTER = /^[A-Za-z]:/;
const EXTENDED_LENGTH_PREFIX = /^[\\/]{2}[?.][\\/]/;
const UNC_PREFIX = /^[\\/]{2}/;
const RESERVED_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const TRAILING_DOT_OR_SPACE = /[. ]$/;
const SEGMENT_SEPARATOR = /[\\/]+/;

interface PathResolutionInput {
  readonly root: string;
  readonly documentPath: string;
  /** Defaults to the host platform; tests pin it for deterministic forms. */
  readonly platform?: NodeJS.Platform;
  readonly pathImpl?: PlatformPath;
}

function pathFor(input: PathResolutionInput): PlatformPath {
  if (input.pathImpl) return input.pathImpl;
  const platform = input.platform ?? process.platform;
  return platform === "win32" ? path.win32 : path.posix;
}

function refuse(reason: OpenCodeConfigPathReason, message: string): never {
  throw new OpenCodeConfigPathError(reason, message);
}

/**
 * Refuses the Windows forms whose meaning is not determined by the string.
 *
 * Every rule here comes from a measured case in §9.3 step 4; none is
 * defensive padding. `..` and `.` are exempt from the trailing-dot rule
 * because they are traversal segments, not file names.
 */
function refuseWindowsForms(input: string): void {
  if (EXTENDED_LENGTH_PREFIX.test(input)) {
    refuse("invalid_form", "An extended-length or device path cannot address the config root");
  }
  if (UNC_PREFIX.test(input)) {
    refuse("outside_root", "A UNC path cannot address a local config root");
  }
  if (DRIVE_RELATIVE.test(input)) {
    refuse("invalid_form", "A drive-relative path has no fixed meaning");
  }
  if (
    !DRIVE_LETTER.test(input) &&
    (input.startsWith("\\") || input.startsWith("/")) &&
    !input.startsWith("\\\\") &&
    !input.startsWith("//")
  ) {
    refuse(
      "invalid_form",
      "A rooted path without a drive addresses the current drive, not the root",
    );
  }

  if (input === "") return;
  const withoutDrive = DRIVE_LETTER.test(input) ? input.slice(2) : input;
  for (const segment of withoutDrive.split(SEGMENT_SEPARATOR)) {
    if (segment === "" || segment === "." || segment === "..") continue;
    if (segment.includes(":")) {
      refuse("invalid_form", "A colon in a path segment addresses an alternate data stream");
    }
    if (TRAILING_DOT_OR_SPACE.test(segment)) {
      refuse("invalid_form", "A segment ending in a dot or space is stripped by the filesystem");
    }
    if (RESERVED_DEVICE.test(segment)) {
      refuse("invalid_form", `"${segment}" is a reserved device name`);
    }
  }
}

/**
 * Resolves one document path against the config root (§9.3 steps 2–5).
 *
 * An absolute path inside the root is ACCEPTED — the server reports the
 * document absolutely, and refusing every absolute input would make the guard
 * refuse every legitimate write. An absolute path outside it, a `..` escape,
 * and each ambiguous Windows form are refused before any I/O.
 *
 * @returns The single path a later write may use, rebuilt from the root and
 *   the relative result so the raw input never survives as a second spelling.
 * @throws {OpenCodeConfigPathError} for every refused form.
 */
export function resolveOpenCodeConfigPath(input: PathResolutionInput): string {
  const p = pathFor(input);
  const platform = input.platform ?? process.platform;

  if (typeof input.root !== "string" || input.root.trim().length === 0) {
    refuse("root_unresolved", "No OpenCode configuration root was resolved");
  }
  const rootAbs = p.resolve(input.root);
  if (!p.isAbsolute(input.root)) {
    refuse("root_unresolved", "The OpenCode configuration root is not absolute");
  }

  const documentPath = input.documentPath;
  if (typeof documentPath !== "string" || documentPath.trim().length === 0) {
    refuse("invalid_form", "The document path is empty");
  }
  if (documentPath.includes("\0")) {
    refuse("invalid_form", "The document path contains a NUL character");
  }
  if (platform === "win32") refuseWindowsForms(documentPath);

  const inputAbs = p.isAbsolute(documentPath)
    ? p.resolve(documentPath)
    : p.resolve(rootAbs, documentPath);
  const relative = p.relative(rootAbs, inputAbs);

  if (relative === "") {
    refuse("outside_root", "The document path is the configuration root itself");
  }
  if (p.isAbsolute(relative)) {
    refuse("outside_root", "The document path is on a different volume or a UNC share");
  }
  if (relative === ".." || relative.startsWith(`..${p.sep}`)) {
    refuse("outside_root", "The document path escapes the configuration root");
  }

  return p.resolve(rootAbs, relative);
}

/** The validated root and leaf a write would use. */
export interface OpenCodeConfigWritePath {
  readonly root: string;
  readonly validated: string;
}

export interface OpenCodeConfigWritePathValidationInput extends PathResolutionInput {
  /** Test seam; production uses `node:fs/promises`. */
  readonly lstat?: typeof lstat;
  /**
   * Test seam for canonicalization; production uses `node:fs/promises`.
   * On Windows this is `GetFinalPathNameByHandle`, which returns the stored
   * long name, so an 8.3 alias or a differently-spelled existing component
   * becomes visible here even though `lstat` opened it happily.
   */
  readonly realpath?: (target: string) => Promise<string>;
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT";
}

/** Windows file names are case-insensitive and are stored in their own case. */
function sameName(a: string, b: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function escapesRoot(p: PlatformPath, root: string, candidate: string): boolean {
  const relative = p.relative(root, candidate);
  return p.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${p.sep}`);
}

/**
 * Resolves the path and walks every component from the root to the leaf
 * (§9.3 step 6).
 *
 * A symlink, junction or reparse point anywhere on the path is refused: a
 * junction reports as a symbolic link under `lstat`, and opening it succeeds,
 * so the walk is the only place it can be caught.
 *
 * Every existing component is also canonicalized. A component whose canonical
 * name differs from the spelling that was validated is refused
 * (`short_name_alias`): an 8.3 alias names a real object today but the alias
 * is assigned by the filesystem and can be reused for a different file after
 * the original is deleted, so it is not a stable name to write through. A
 * component that canonicalizes outside the root is refused as well.
 *
 * A leaf that already exists is refused. A leaf with more than one hard link
 * is refused `hard_link` first, because the other name is outside the root and
 * a write through this one would change a file TBAi never approved; the link
 * count is what `lstat` reports (`nlink`), since a hard link is not a reparse
 * attribute and cannot be detected any other way.
 *
 * @throws {OpenCodeConfigPathError} for a refused form, a reparse point, an
 *   alias, a hard-linked leaf, a missing component, or an existing leaf.
 */
export async function validateOpenCodeConfigWritePath(
  input: OpenCodeConfigWritePathValidationInput,
): Promise<OpenCodeConfigWritePath> {
  const p = pathFor(input);
  const platform = input.platform ?? process.platform;
  const lstatImpl = input.lstat ?? lstat;
  const realpathImpl = input.realpath ?? realpath;
  const validated = resolveOpenCodeConfigPath(input);
  const root = p.resolve(input.root);
  const relative = p.relative(root, validated);
  const segments = relative.split(p.sep).filter((segment) => segment.length > 0);

  const rootStats = await lstatOrRefuse(lstatImpl, root, "root_unresolved");
  if (rootStats.isSymbolicLink()) {
    refuse("reparse_point", "The OpenCode configuration root is a link");
  }
  if (!rootStats.isDirectory()) {
    refuse("root_unresolved", "The OpenCode configuration root is not a directory");
  }
  const canonicalRoot = await realpathOrRefuse(realpathImpl, root, "root_unresolved");
  if (!sameName(p.basename(canonicalRoot), p.basename(root), platform)) {
    refuse("short_name_alias", "The OpenCode configuration root is spelled as an alias");
  }

  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined) continue;
    current = p.join(current, segment);
    const isLeaf = index === segments.length - 1;

    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstatImpl(current);
    } catch (error) {
      if (isEnoent(error)) {
        if (isLeaf) return { root, validated };
        refuse("walk_failed", "A parent of the document path does not exist");
      }
      throw new OpenCodeConfigPathError(
        "walk_failed",
        `The document path could not be inspected: ${current}`,
      );
    }

    if (stats.isSymbolicLink()) {
      refuse("reparse_point", `A component of the document path is a link: ${segment}`);
    }

    const canonical = await realpathOrRefuse(realpathImpl, current, "walk_failed");
    if (escapesRoot(p, canonicalRoot, canonical)) {
      refuse("outside_root", `A component resolves outside the configuration root: ${segment}`);
    }
    if (!sameName(p.basename(canonical), segment, platform)) {
      refuse("short_name_alias", `A component is spelled as an alias: ${segment}`);
    }

    if (isLeaf) {
      if (stats.nlink > 1) {
        refuse("hard_link", "The document has another hard-linked name outside the root");
      }
      refuse("replace_unverified", "The document already exists and replacement is not verified");
    }
    if (!stats.isDirectory()) {
      refuse("walk_failed", `A component of the document path is not a directory: ${segment}`);
    }
  }

  // A path with no segments is the root itself, which `resolve` already
  // refused; this is unreachable unless that rule changes.
  return { root, validated };
}

async function realpathOrRefuse(
  realpathImpl: (target: string) => Promise<string>,
  target: string,
  reason: OpenCodeConfigPathReason,
): Promise<string> {
  try {
    return await realpathImpl(target);
  } catch (error) {
    if (isEnoent(error)) refuse(reason, "A component of the document path does not exist");
    throw new OpenCodeConfigPathError(reason, "The document path could not be canonicalized");
  }
}

async function lstatOrRefuse(
  lstatImpl: typeof lstat,
  target: string,
  reason: OpenCodeConfigPathReason,
): Promise<Awaited<ReturnType<typeof lstat>>> {
  try {
    return await lstatImpl(target);
  } catch (error) {
    if (isEnoent(error)) refuse(reason, "The OpenCode configuration root does not exist");
    throw new OpenCodeConfigPathError(reason, `The OpenCode configuration root could not be read`);
  }
}
