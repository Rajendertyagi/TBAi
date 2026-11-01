/**
 * What the backend reports about the selected OpenCode runtime, and how the
 * feature's surface presents it.
 *
 * ## Why the browser reads a status at all
 *
 * Adoption is a server-wide decision: the session, history, catalogue and proxy
 * calls all go to whichever service the backend bound at startup, and only the
 * backend knows whether that service is one TBAi started or one the user was
 * already running. The browser is told a mode and — for an adopted service —
 * the capability snapshot the probe proved, and nothing else. The origin, the
 * password and the registration path never cross this boundary.
 *
 * ## Why the mapping is a pure function
 *
 * The chip and the configuration page both read the mode, and "which service is
 * this?" must not be answered two different ways. The mapping lives here so it
 * can be tested without a DOM, the same way `statusView.ts` keeps the chip's
 * presentation testable.
 *
 * ## Unresolved is not a failure
 *
 * The managed service starts lazily on the first Code request, so a boot that
 * adopted nothing reports `unresolved` until somebody uses Code mode. That is a
 * normal state, not an error: the surface says "Not started", and only a
 * runtime that has actually failed presents the unavailable notice.
 */

/** The routes the adoption probe checks. Mirrors the backend's capability ids. */
export type OpenCodeCapabilityId = "session" | "events" | "config" | "agent" | "model" | "command";

/** What adoption proved about the selected service, as the browser sees it. */
export interface OpenCodeRuntimeCapabilities {
  readonly version: string;
  readonly supported: Readonly<Record<OpenCodeCapabilityId, boolean>>;
}

/** The stable status `GET /api/opencode/status` answers with. */
export type OpenCodeRuntimeStatus =
  | Readonly<{ mode: "unresolved" }>
  | Readonly<{ mode: "managed" }>
  | Readonly<{ mode: "adopted"; capabilities: OpenCodeRuntimeCapabilities | null }>;

/** The single sentence the error surface shows when no service can be reached. */
export const OPENCODE_UNAVAILABLE_NOTICE = "OpenCode is not available";

const CAPABILITY_IDS: readonly OpenCodeCapabilityId[] = Object.freeze([
  "session",
  "events",
  "config",
  "agent",
  "model",
  "command",
]);

/** What the status surface shows for one mode. */
export interface OpenCodeRuntimeView {
  /** The word for the Runtime row. */
  readonly label: string;
  /** One sentence explaining the selection, or null when the label says enough. */
  readonly detail: string | null;
  /** True when the backend reports no installed target. */
  readonly unresolved: boolean;
}

/**
 * Narrows the capability snapshot.
 *
 * A snapshot missing its version or any of the six ids is treated as UNKNOWN
 * (`null`) rather than partially believed: a half-read snapshot would hide a
 * surface the service does serve, and hiding a working control is worse than
 * showing one that reports a clear refusal.
 */
function toCapabilities(input: unknown): OpenCodeRuntimeCapabilities | null {
  if (input === null || typeof input !== "object") return null;
  const version = Reflect.get(input, "version");
  const supported = Reflect.get(input, "supported");
  if (typeof version !== "string" || version.length === 0) return null;
  if (supported === null || typeof supported !== "object") return null;
  const narrowed: Record<OpenCodeCapabilityId, boolean> = {
    session: false,
    events: false,
    config: false,
    agent: false,
    model: false,
    command: false,
  };
  for (const id of CAPABILITY_IDS) {
    const value = Reflect.get(supported, id);
    if (typeof value !== "boolean") return null;
    narrowed[id] = value;
  }
  return Object.freeze({ version, supported: Object.freeze(narrowed) });
}

/**
 * Parses a status payload.
 *
 * Rejects rather than guesses: an unknown mode means this build and the
 * backend disagree, and presenting a mode that was not reported would
 * misdescribe which service the reader's conversations are using.
 *
 * @throws {Error} When the payload is not a status this build understands.
 */
export function parseOpenCodeRuntimeStatus(input: unknown): OpenCodeRuntimeStatus {
  if (input === null || typeof input !== "object") {
    throw new Error("OpenCode returned an unreadable runtime status");
  }
  const mode = Reflect.get(input, "mode");
  if (mode === "unresolved" || mode === "managed") return { mode };
  if (mode === "adopted") {
    return { mode, capabilities: toCapabilities(Reflect.get(input, "capabilities")) };
  }
  throw new Error("OpenCode returned an unknown runtime status");
}

/**
 * Reads the status response.
 *
 * @param response - The response from `GET /api/opencode/status`.
 * @returns The parsed status.
 * @throws {Error} Carrying the server's message, or `HTTP <status>` when the body
 *   is not the expected JSON.
 */
export async function readOpenCodeRuntimeStatus(
  response: Response,
): Promise<OpenCodeRuntimeStatus> {
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const detail =
      body !== null && typeof body === "object" && typeof Reflect.get(body, "error") === "string"
        ? (Reflect.get(body, "error") as string)
        : `HTTP ${response.status}`;
    throw new Error(detail);
  }
  return parseOpenCodeRuntimeStatus(body);
}

/**
 * Maps a status to the chip's Runtime row.
 *
 * The managed label is deliberately "Managed service": the surface must not
 * imply TBAi started anything when it adopted the reader's own service, and
 * vice versa.
 */
export function runtimeStatusView(status: OpenCodeRuntimeStatus): OpenCodeRuntimeView {
  if (status.mode === "unresolved") {
    return { label: "Not started", detail: null, unresolved: true };
  }
  if (status.mode === "managed") {
    return { label: "Managed service", detail: null, unresolved: false };
  }
  return {
    label: "Adopted service",
    detail: "Using the OpenCode service already running on this machine.",
    unresolved: false,
  };
}

/**
 * Whether the selected service is known to support one capability.
 *
 * `true` means "do not hide the surface": a managed service has no snapshot
 * (nothing was assessed) and an adopted service whose snapshot is unknown is
 * equally unproven. Only a snapshot that positively reports the route missing
 * degrades the surface — the backend is still the authority that refuses the
 * call, and its refusal carries the reason.
 */
export function openCodeCapabilitySupported(
  status: OpenCodeRuntimeStatus,
  id: OpenCodeCapabilityId,
): boolean {
  if (status.mode !== "adopted") return true;
  if (status.capabilities === null) return true;
  return status.capabilities.supported[id] === true;
}
