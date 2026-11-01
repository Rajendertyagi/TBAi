import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { OPENCODE_CONFIG, type OpenCodeConfig } from "../../config/opencode";
import { assertLoopbackOrigin, canonicalizeOpenCodeOrigin } from "./connectionState";
import { isStableReleaseVersion, parseOpenCodeVersion } from "./runtime";

/**
 * The registration read (§2.2–§2.7).
 *
 * A registration is a **discovery hint**, never an authority. This module
 * locates the record at the client's own fallback path, reads it through one
 * opened handle under a byte cap, and validates those exact bytes before any
 * credential is used. It deliberately does not call `Service.discover()`,
 * `ensure()` or `stop()` (B1): the lifecycle calls would reintroduce a second
 * parse/timing authority and, for `ensure()`/`stop()`, take over a process TBAi
 * does not own (§2.10).
 *
 * Failure vocabulary is typed and leaves the previous connection state
 * untouched (§2.4.1). No error message contains the password.
 */

/** Every way one registration read can be refused. */
export type OpenCodeRegistrationRefusalCode =
  | "registration_missing"
  | "registration_not_regular"
  | "registration_read_failed"
  | "registration_too_large"
  | "registration_read_timeout"
  | "registration_malformed"
  | "registration_invalid_shape"
  | "registration_invalid_url"
  | "registration_non_loopback"
  | "registration_invalid_pid"
  | "missing_credential"
  | "registration_unsupported_version";

/** A typed refusal from the registration read. Never carries the password. */
export class OpenCodeRegistrationRefusalError extends Error {
  readonly code = "OPENCODE_REGISTRATION_REFUSED";

  constructor(
    readonly refusal: OpenCodeRegistrationRefusalCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "OpenCodeRegistrationRefusalError";
  }
}

/**
 * Validated registration data.
 *
 * `origin` is canonical (`scheme://host:port`, §8.1); the raw `url` is not
 * retained, so nothing downstream can send a credential to an uncanonicalized
 * destination. `version` is the record's own stable version, kept as a hint;
 * the live `/api/info` probe and the capability read decide adoption.
 */
export type OpenCodeRegistrationRecord = Readonly<{
  readonly path: string;
  readonly origin: string;
  readonly pid: number;
  readonly password: string;
  readonly version: string;
}>;

/**
 * The minimal handle surface the read needs. A test seam supplies a wrapper so
 * the lstat-versus-fstat swap and the byte-count bound are deterministic
 * without patching `node:fs`; production always opens through
 * {@link defaultRegistrationFileOpener}.
 */
export interface RegistrationReadHandle {
  stat(): Promise<{ isFile(): boolean }>;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export type RegistrationFileOpener = (file: string) => Promise<RegistrationReadHandle>;

export interface OpenCodeRegistrationReadOptions {
  /** Explicit record path; otherwise resolved from `channel`/`env`/`homeDir`. */
  readonly path?: string;
  /**
   * Channel used for the filename selection only. TBAi does not detect a
   * channel from the record — it carries none (§2.2).
   */
  readonly channel?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  /** Cancels the read between operations; a supersede or shutdown abort. */
  readonly signal?: AbortSignal;
  /** Injected clock for the post-parse deadline (§2.4.1 step 7). */
  readonly now?: () => number;
  /** Test seam; production never supplies one. */
  readonly openFile?: RegistrationFileOpener;
  readonly config?: OpenCodeConfig;
}

/** The client's `filename(channel)` selection, reproduced rather than guessed (§2.2). */
export function registrationFilenameForChannel(
  channel: string = "latest",
  config: OpenCodeConfig = OPENCODE_CONFIG,
): string {
  if (channel === "latest" || channel === "beta" || channel === "next") {
    return config.registrationDefaultFilename;
  }
  const sanitized = channel.replace(/[^a-zA-Z0-9._-]/g, "-");
  return `${config.registrationChannelFilenamePrefix}${sanitized}.json`;
}

/** The client's own fallback path: `XDG_STATE_HOME` (or `~/.local/state`) + `opencode/`. */
export function resolveRegistrationPath(
  options: {
    readonly channel?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly homeDir?: string;
    readonly config?: OpenCodeConfig;
  } = {},
): string {
  const config = options.config ?? OPENCODE_CONFIG;
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  const stateRoot =
    env[config.registrationStateHomeEnvVar] ??
    path.join(home, ...config.registrationFallbackStateSegments);
  return path.join(
    stateRoot,
    config.registrationStateDirName,
    registrationFilenameForChannel(options.channel, config),
  );
}

const CHUNK_BYTES = 8_192;

/** Opens the record readonly through the real filesystem. */
const defaultRegistrationFileOpener: RegistrationFileOpener = (file) => fs.open(file, "r");

function refuse(
  refusal: OpenCodeRegistrationRefusalCode,
  message: string,
  options?: ErrorOptions,
): never {
  throw new OpenCodeRegistrationRefusalError(refusal, message, options);
}

function isNotFound(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Reads, validates and returns one registration record.
 *
 * The sequence is the one in §2.4: `lstat` (a regular-file check and a size
 * hint only), one open, `fstat` on that handle, an incremental read capped at
 * `registrationFileMaxBytes + 1` **actual** bytes, a `finally` close, then
 * `JSON.parse` and shape validation of the handle's own buffer, then the
 * post-parse elapsed check. Nothing re-opens the path.
 *
 * @throws {OpenCodeRegistrationRefusalError} for every refusal.
 */
export async function readOpenCodeRegistration(
  options: OpenCodeRegistrationReadOptions = {},
): Promise<OpenCodeRegistrationRecord> {
  const config = options.config ?? OPENCODE_CONFIG;
  const now = options.now ?? Date.now;
  const openFile = options.openFile ?? defaultRegistrationFileOpener;
  const signal = options.signal;
  const file = options.path ?? resolveRegistrationPath(options);
  const startedAt = now();
  const maxBytes = config.registrationFileMaxBytes;

  if (signal?.aborted) refuse("registration_read_failed", "registration read was cancelled");

  let hint: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    hint = await fs.lstat(file);
  } catch (error) {
    if (isNotFound(error)) refuse("registration_missing", "no OpenCode registration was found");
    refuse("registration_read_failed", "the OpenCode registration could not be inspected", {
      cause: error,
    });
  }
  if (!hint.isFile()) {
    refuse("registration_not_regular", "the OpenCode registration is not a regular file");
  }
  if (hint.size > maxBytes) {
    refuse("registration_too_large", "the OpenCode registration exceeds the size limit");
  }

  const handle = await openRegistration(openFile, file);
  let record: Omit<OpenCodeRegistrationRecord, "path"> | null = null;
  let closeError: unknown = null;
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      refuse("registration_not_regular", "the opened OpenCode registration is not a regular file");
    }

    const bytes = await readBounded(handle, maxBytes, signal, now, startedAt, config);
    if (bytes === null) {
      refuse("registration_too_large", "the OpenCode registration exceeds the size limit");
    }

    record = validateRegistration(decodeRegistration(bytes));
    if (now() - startedAt > config.registrationReadTimeoutMs) {
      refuse("registration_read_timeout", "the OpenCode registration read exceeded its deadline");
    }
  } finally {
    try {
      await handle.close();
    } catch (error) {
      closeError = error;
    }
  }

  // A close error is never converted into a successful read (§2.4.1): the
  // bytes are not used, and the outcome is the typed read-failure refusal.
  if (closeError !== null || record === null) {
    refuse("registration_read_failed", "the OpenCode registration handle could not be closed", {
      cause: closeError,
    });
  }
  return Object.freeze({ path: file, ...record });
}

async function openRegistration(
  openFile: RegistrationFileOpener,
  file: string,
): Promise<RegistrationReadHandle> {
  if (!file) refuse("registration_missing", "no OpenCode registration was found");
  try {
    return await openFile(file);
  } catch (error) {
    if (isNotFound(error)) refuse("registration_missing", "no OpenCode registration was found");
    refuse("registration_read_failed", "the OpenCode registration could not be opened", {
      cause: error,
    });
  }
}

/**
 * Reads from the opened handle in 8 KiB steps, stopping at `maxBytes + 1`.
 *
 * Returns `null` when the actual bytes exceed the cap. The caller's own close
 * runs in a `finally` regardless of outcome. An in-flight `read` is not raced:
 * cancellation is observed between operations, and whether an `AbortSignal`
 * cancels a pending handle read on Windows is the unmeasured part §2.4 already
 * records — it is not claimed here.
 */
async function readBounded(
  handle: RegistrationReadHandle,
  maxBytes: number,
  signal: AbortSignal | undefined,
  now: () => number,
  startedAt: number,
  config: OpenCodeConfig,
): Promise<Uint8Array | null> {
  const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, maxBytes + 1));
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    if (signal?.aborted) {
      refuse("registration_read_failed", "the OpenCode registration read was cancelled");
    }
    if (now() - startedAt > config.registrationReadTimeoutMs) {
      refuse("registration_read_timeout", "the OpenCode registration read exceeded its deadline");
    }
    const remaining = maxBytes + 1 - total;
    if (remaining <= 0) return null;

    let bytesRead: number;
    try {
      ({ bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, remaining), total));
    } catch (error) {
      refuse("registration_read_failed", "the OpenCode registration could not be read", {
        cause: error,
      });
    }
    if (bytesRead === 0) break;
    chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
    total += bytesRead;
    if (total > maxBytes) return null;
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of chunks) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

function decodeRegistration(bytes: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    refuse("registration_malformed", "the OpenCode registration is not valid UTF-8", {
      cause: error,
    });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    refuse("registration_malformed", "the OpenCode registration is not valid JSON", {
      cause: error,
    });
  }
}

/**
 * Validates the `Service.Info` shape from those bytes (§2.3). A syntactically
 * valid object of the wrong shape is refused here, before any probe — the
 * client's Promise path would accept it (§2.7).
 */
function validateRegistration(value: unknown): Omit<OpenCodeRegistrationRecord, "path"> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    refuse("registration_invalid_shape", "the OpenCode registration is not an object");
  }
  const record = value as Record<string, unknown>;

  const url = record.url;
  if (typeof url !== "string") {
    refuse("registration_invalid_shape", "the OpenCode registration has no url");
  }
  const origin = parseRegistrationOrigin(url);

  const pid = record.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    refuse("registration_invalid_pid", "the OpenCode registration has no usable pid");
  }

  const password = record.password;
  if (typeof password !== "string" || password.trim() === "") {
    refuse("missing_credential", "the OpenCode registration carries no usable credential");
  }

  // D2 (stable-only). B7 deliberately drops BOTH managed bounds here: the
  // record's version is a hint, and the live `/api/info` probe re-checks the
  // build that is actually running. The `minimumVersion` floor is an evidence
  // boundary (the oldest build TBAi has checked), not a proven incompatibility,
  // so refusing an older stable record here would be arbitrary; the capability
  // read in `./compatibility` decides, with the approved managed fallback when
  // an essential route is absent.
  const version = record.version;
  if (
    typeof version !== "string" ||
    parseOpenCodeVersion(version) === null ||
    !isStableReleaseVersion(version)
  ) {
    refuse(
      "registration_unsupported_version",
      "the OpenCode registration does not carry a parseable stable version",
    );
  }

  return { origin, pid, password, version };
}

/**
 * An origin with no userinfo, path, query or fragment, on a loopback host.
 * A trailing `/` is the URL parser's representation of "no path" and is
 * accepted; anything else is refused (§2.3, §8.3).
 */
function parseRegistrationOrigin(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (error) {
    refuse("registration_invalid_url", "the OpenCode registration url is not absolute", {
      cause: error,
    });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    refuse("registration_invalid_url", "the OpenCode registration url is not HTTP(S)");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    refuse("registration_invalid_url", "the OpenCode registration url carries user information");
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    refuse("registration_invalid_url", "the OpenCode registration url carries a query or fragment");
  }
  if (parsed.pathname !== "" && parsed.pathname !== "/") {
    refuse("registration_invalid_url", "the OpenCode registration url carries a path");
  }

  const origin = canonicalizeOpenCodeOrigin(raw);
  try {
    assertLoopbackOrigin(origin);
  } catch (error) {
    refuse("registration_non_loopback", "the OpenCode registration url is not on a loopback host", {
      cause: error,
    });
  }
  return origin;
}
