import { OPENCODE_CONFIG, type OpenCodeConfig } from "../../config/opencode";

/**
 * The managed child's own listening announcement (managed startup only).
 *
 * ## Why stdout and not an allocated port
 *
 * The manager used to pick a free port by binding `:0` and closing the probe
 * socket, then pass that number to `opencode serve`. Between the release and
 * the child's bind, any process on the machine could take the port, and the
 * child's failure would look like a readiness timeout. Measured on 2.0.15 and
 * 2.2.5, `opencode serve --port 0` lets the kernel choose the port and prints
 *
 *     server listening on http://127.0.0.1:<port>
 *
 * so the address the manager uses is the address the child actually bound.
 *
 * ## What this module refuses
 *
 * The announcement is read **only** from the pipe of the child this manager
 * spawned. Nothing is inferred from a previous start, a configuration value or
 * any other process's output. Before the URL is accepted it must be
 * `http://127.0.0.1:<nonzero port>` with no userinfo, path, query or fragment;
 * a wrong host, an external address, a missing/zero/out-of-range port or
 * malformed text is refused rather than repaired. Two different announcements
 * read together are a conflict before either is accepted, because neither can
 * be shown to be the one the manager should talk to; after acceptance the
 * address already handed out cannot change, so later announcements are ignored.
 * A repeat of the same announcement is benign.
 *
 * ## Secrets
 *
 * `opencode serve` with no password env var prints `server password <token>`
 * on the same stream, and the stream also lands in the bounded diagnostic
 * tail. {@link redactServerAnnouncementLine} removes that value before any
 * line is retained, and no error message produced here carries a raw URL.
 */

/** A validated loopback address announced by the managed child. */
export interface OpenCodeListeningTarget {
  readonly baseUrl: string;
  readonly port: number;
}

/** Why an announced URL was refused. Never includes the offending text. */
export type OpenCodeListeningUrlReason =
  | "malformed"
  | "protocol"
  | "userinfo"
  | "hostname"
  | "port"
  | "path";

/** Thrown when an announcement's URL is not a usable loopback target. */
export class OpenCodeListeningUrlError extends Error {
  readonly reason: OpenCodeListeningUrlReason;

  constructor(reason: OpenCodeListeningUrlReason) {
    super(
      `OpenCode announced an invalid listening URL (${reason}); expected http://127.0.0.1:<port>`,
    );
    this.name = "OpenCodeListeningUrlError";
    this.reason = reason;
  }
}

/** Thrown when one child announces two different listening URLs. */
export class OpenCodeListeningConflictError extends Error {
  constructor(
    readonly firstBaseUrl: string,
    readonly secondBaseUrl: string,
  ) {
    super(`OpenCode announced conflicting listening URLs (${firstBaseUrl}, ${secondBaseUrl})`);
    this.name = "OpenCodeListeningConflictError";
  }
}

/** Thrown when the child's output ends without a usable announcement. */
export class OpenCodeListeningMissingError extends Error {
  constructor() {
    super("OpenCode output ended without announcing a listening URL");
    this.name = "OpenCodeListeningMissingError";
  }
}

/* biome-ignore-start lint/suspicious/noControlCharactersInRegex: matching the ESC byte IS the point - the pattern strips SGR colour wrappers a build may put around its log lines, so it must match a literal control character. A range suppression, not a line one, so re-wrapping cannot detach it. */
const ANSI_ESCAPE = /\u001b\[[0-9;]*[A-Za-z]/g;
/* biome-ignore-end lint/suspicious/noControlCharactersInRegex: end of the ANSI escape pattern, which must match literal control bytes. */
const URL_SHAPE = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)(.*)$/i;
const TCP_PORT = /^[1-9]\d{0,4}$/;
const SERVER_PASSWORD_ANNOUNCEMENT = /\bserver password\b.*$/i;
const REDACTED_PASSWORD_ANNOUNCEMENT = "server password [redacted]";

/** Strips SGR colour sequences a build may wrap its log lines in. Pure. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, "");
}

/**
 * Removes a server-generated password from one captured stdout/stderr line.
 *
 * `opencode serve` prints `server password <token>` when it generates its own
 * credential. The line is retained for exit diagnostics, so the value is
 * replaced rather than the whole line dropped: its presence is useful, the
 * secret is not.
 */
export function redactServerAnnouncementLine(line: string): string {
  return line.replace(SERVER_PASSWORD_ANNOUNCEMENT, REDACTED_PASSWORD_ANNOUNCEMENT);
}

/**
 * Validates the URL token an announcement carries.
 *
 * The authority is parsed directly instead of through `URL`, because `URL`
 * normalises an explicit default port (`http://127.0.0.1:80` reports an empty
 * `port`), which would make "no port" and "port 80" indistinguishable. The
 * announcement is a single token, so an exact authority comparison is both
 * simpler and stricter.
 *
 * @throws {OpenCodeListeningUrlError} naming the failed rule, never the input.
 */
export function validateListeningUrl(
  token: string,
  config: OpenCodeConfig = OPENCODE_CONFIG,
): OpenCodeListeningTarget {
  const url = URL_SHAPE.exec(stripAnsi(token).trim());
  if (url === null) throw new OpenCodeListeningUrlError("malformed");
  const scheme = url[1].toLowerCase();
  if (scheme !== "http") throw new OpenCodeListeningUrlError("protocol");
  const authority = url[2];
  const rest = url[3] ?? "";
  // A single trailing slash is how some builds render the root; anything else
  // is a path, query or fragment the manager did not ask for.
  if (rest !== "" && rest !== "/") throw new OpenCodeListeningUrlError("path");
  if (authority === "") throw new OpenCodeListeningUrlError("malformed");
  if (authority.includes("@")) throw new OpenCodeListeningUrlError("userinfo");
  const separator = authority.lastIndexOf(":");
  if (separator <= 0) throw new OpenCodeListeningUrlError("port");
  const host = authority.slice(0, separator).toLowerCase();
  if (host !== config.managedBindHostname) throw new OpenCodeListeningUrlError("hostname");
  const portText = authority.slice(separator + 1);
  if (!TCP_PORT.test(portText)) throw new OpenCodeListeningUrlError("port");
  const port = Number(portText);
  if (port > 65_535) throw new OpenCodeListeningUrlError("port");
  return Object.freeze({ baseUrl: `http://${config.managedBindHostname}:${port}`, port });
}

/**
 * Extracts the listening announcement from one output line.
 *
 * @returns The validated target, or null when the line is not an announcement.
 * @throws {OpenCodeListeningUrlError} for an announcement that is not usable.
 */
export function parseListeningAnnouncement(
  line: string,
  config: OpenCodeConfig = OPENCODE_CONFIG,
): OpenCodeListeningTarget | null {
  const text = stripAnsi(line).trim();
  const marker = config.listeningAnnouncementPrefix;
  const at = text.toLowerCase().indexOf(marker.toLowerCase());
  if (at === -1) return null;
  // One token after the marker: any log decoration before or after it is not
  // part of the URL, and the URL itself is still validated as a whole.
  const token = text
    .slice(at + marker.length)
    .trim()
    .split(/\s+/, 1)[0];
  if (!token) throw new OpenCodeListeningUrlError("malformed");
  return validateListeningUrl(token, config);
}

/** Splits accumulated text into complete lines, returning the unterminated rest. */
export function splitCompleteLines(buffer: string): { lines: string[]; rest: string } {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  return { lines: lines.map((line) => line.replace(/\r$/, "")), rest };
}

/** The announcement state machine the manager feeds its child's stdout into. */
export interface OpenCodeListeningDiscovery {
  /** Resolves once with the announced target, or rejects with a typed error. */
  readonly promise: Promise<OpenCodeListeningTarget>;
  /** Feeds one decoded stdout chunk; chunks may split a line or a URL. */
  push(chunk: string): void;
  /** Flushes a trailing unterminated line and fails when nothing was announced. */
  end(): void;
}

/**
 * Creates the bounded announcement reader for one managed child.
 *
 * The line buffer is capped at {@link OpenCodeConfig.listeningLineMaxBytes}; an
 * over-long line is discarded up to its newline rather than truncated, so a
 * partial URL or a partial secret can never be matched or retained.
 */
export function createOpenCodeListeningDiscovery(
  config: OpenCodeConfig = OPENCODE_CONFIG,
): OpenCodeListeningDiscovery {
  let pending = "";
  let discarding = false;
  let settled = false;
  let resolveTarget!: (value: OpenCodeListeningTarget) => void;
  let rejectTarget!: (error: unknown) => void;
  const promise = new Promise<OpenCodeListeningTarget>((resolve, reject) => {
    resolveTarget = resolve;
    rejectTarget = reject;
  });
  // The manager may not await this promise when the reservation was superseded;
  // that is an handled outcome, not an unhandled rejection.
  void promise.catch(() => undefined);

  const fail = (error: unknown): void => {
    if (settled) return;
    settled = true;
    rejectTarget(error);
  };

  const acceptLine = (line: string): OpenCodeListeningTarget | null | undefined => {
    // An over-long line is not an announcement and is never partially matched.
    if (line.length > config.listeningLineMaxBytes) return null;
    try {
      return parseListeningAnnouncement(line, config);
    } catch (error) {
      fail(error);
      return undefined;
    }
  };

  /**
   * Scans one read's lines together, so two different addresses delivered in
   * the same chunk are a conflict BEFORE either is accepted. Once a URL has
   * been resolved, later pushes are ignored (the manager already holds it).
   */
  const acceptBatch = (lines: string[]): void => {
    let announcedInBatch: OpenCodeListeningTarget | null = null;
    for (const line of lines) {
      const announced = acceptLine(line);
      if (announced === undefined) return;
      if (announced === null) continue;
      if (announcedInBatch !== null && announced.baseUrl !== announcedInBatch.baseUrl) {
        fail(new OpenCodeListeningConflictError(announcedInBatch.baseUrl, announced.baseUrl));
        return;
      }
      announcedInBatch ??= announced;
    }
    if (announcedInBatch === null) return;
    settled = true;
    resolveTarget(announcedInBatch);
  };

  const consume = (text: string): void => {
    pending += text;
    const split = splitCompleteLines(pending);
    pending = split.rest;
    const lines: string[] = [];
    for (const line of split.lines) {
      if (discarding) {
        discarding = false;
        continue;
      }
      lines.push(line);
    }
    if (lines.length > 0) acceptBatch(lines);
    if (pending.length > config.listeningLineMaxBytes) {
      pending = "";
      discarding = true;
    }
  };

  return {
    promise,
    push(chunk: string): void {
      if (settled) return;
      consume(chunk);
    },
    end(): void {
      if (settled) return;
      if (pending) {
        const line = pending;
        pending = "";
        if (!discarding) acceptBatch([line]);
      }
      fail(new OpenCodeListeningMissingError());
    },
  };
}
