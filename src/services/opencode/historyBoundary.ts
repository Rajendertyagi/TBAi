/**
 * OpenCode conversation history boundary and scope resolution.
 *
 * Provides a simple two-scope history ownership model:
 *
 * 1. "local" (canonical owner key: "local"):
 *    Represents the user's default local OpenCode environment.
 *    Covers:
 *      - TBAi-managed local OpenCode
 *      - Officially registered local OpenCode services (e.g. ~/.local/state/opencode/service.json)
 *      - OpenCode CLI using the same default local environment
 *      - OpenChamber configured for local OpenCode
 *      - Verified loopback endpoints representing the default local service.
 *
 * 2. "remote:<canonical-origin>":
 *    Represents an explicitly configured server (e.g. OPENCODE_URL=http://127.0.0.1:4000)
 *    or remote OpenCode server.
 *    Origins are normalized (lowercase scheme and host, default ports removed,
 *    trailing slashes removed, credentials/query parameters excluded).
 *
 * Port changes on the verified default local environment preserve "local" ownership.
 * Unrelated loopback servers (e.g. running on another port with a separate data directory)
 * do not automatically receive access to local conversations.
 */

import type { Conversation } from "../../types";

export const LOCAL_HISTORY_OWNER = "local";
export const LEGACY_MANAGED_OWNER = "managed";
export const LEGACY_ADOPTED_PREFIX = "adopted:";
export const REMOTE_OWNER_PREFIX = "remote:";

export type HistoryBoundaryRefusal =
  | "cross_service"
  | "adopted_unavailable"
  | "unreadable"
  | "unresolved";

export class OpenCodeHistoryBoundaryError extends Error {
  public readonly refusal: HistoryBoundaryRefusal;
  public readonly conversationId: string;

  public constructor(refusal: HistoryBoundaryRefusal, conversationId: string, message: string) {
    super(message);
    this.name = "OpenCodeHistoryBoundaryError";
    this.refusal = refusal;
    this.conversationId = conversationId;
  }
}

/**
 * Checks whether a hostname is a loopback address.
 * Covers:
 * - "localhost" and "*.localhost" subdomains (RFC 6761)
 * - IPv4 loopback range 127.0.0.0/8 (127.0.0.1 through 127.255.255.254)
 * - IPv6 loopback ("::1", "[::1]")
 * Strictly rejects 0.0.0.0 (bind address, not loopback destination).
 */
export function isLoopbackHost(hostname: string): boolean {
  if (!hostname) return false;
  const bare = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .trim();

  if (bare === "localhost" || bare.endsWith(".localhost")) {
    return true;
  }
  if (bare === "::1") {
    return true;
  }
  // IPv4 dotted decimal check for 127.0.0.0/8
  const parts = bare.split(".");
  if (parts.length === 4) {
    const first = Number(parts[0]);
    if (first === 127) {
      return parts.every((p) => {
        const n = Number(p);
        return !Number.isNaN(n) && n >= 0 && n <= 255;
      });
    }
  }

  return false;
}

/**
 * Canonicalizes a remote origin URL:
 * - Lowercase protocol and hostname
 * - Strips default ports (80 for http, 443 for https)
 * - Strips trailing slashes, path, query, and credentials
 */
export function canonicalizeRemoteOrigin(origin: string): string {
  const url = new URL(origin);
  const protocol = url.protocol.toLowerCase();
  const hostname = url.hostname.toLowerCase();
  let port = url.port;
  if ((protocol === "http:" && port === "80") || (protocol === "https:" && port === "443")) {
    port = "";
  }
  return `${protocol}//${hostname}${port ? `:${port}` : ""}`;
}

/**
 * Canonicalizes an arbitrary persisted or runtime owner string to its canonical scope:
 * - "local"
 * - "remote:<canonical-origin>"
 * Preserves non-default custom profiles and uninterpretable strings as-is.
 */
export function canonicalizeServiceOwner(ownerKey: string | null | undefined): string {
  if (
    ownerKey === null ||
    ownerKey === undefined ||
    ownerKey === "" ||
    ownerKey === LOCAL_HISTORY_OWNER ||
    ownerKey === LEGACY_MANAGED_OWNER ||
    ownerKey === "default" ||
    ownerKey === "profile:default"
  ) {
    return LOCAL_HISTORY_OWNER;
  }

  let raw = ownerKey.trim();
  let isExplicitOrRemote = false;

  if (raw.startsWith("profile:")) {
    const stripped = raw.slice("profile:".length);
    if (stripped === "default") return LOCAL_HISTORY_OWNER;
    if (stripped.startsWith("explicit:")) {
      raw = stripped.slice("explicit:".length);
      isExplicitOrRemote = true;
    } else {
      // Non-default custom profile (e.g. "profile:work", "profile:channel-1")
      // Must be preserved rather than silently assigned to "local"
      return ownerKey;
    }
  }

  if (raw.startsWith(REMOTE_OWNER_PREFIX)) {
    raw = raw.slice(REMOTE_OWNER_PREFIX.length);
    isExplicitOrRemote = true;
  } else if (raw.startsWith("explicit:")) {
    raw = raw.slice("explicit:".length);
    isExplicitOrRemote = true;
  } else if (raw.startsWith(LEGACY_ADOPTED_PREFIX)) {
    raw = raw.slice(LEGACY_ADOPTED_PREFIX.length);
    // Legacy adopted prefix. Loopback maps to local; non-loopback maps to remote.
  }

  const isHttp = raw.startsWith("http://") || raw.startsWith("https://");
  if (!isHttp) {
    return ownerKey;
  }

  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return ownerKey;
    }
    // Explicit remote configurations (even on loopback addresses) must remain isolated
    if (isExplicitOrRemote) {
      return `${REMOTE_OWNER_PREFIX}${canonicalizeRemoteOrigin(url.origin)}`;
    }
    // Legacy adopted loopback addresses were default local services
    if (isLoopbackHost(url.hostname)) {
      return LOCAL_HISTORY_OWNER;
    }
    return `${REMOTE_OWNER_PREFIX}${canonicalizeRemoteOrigin(url.origin)}`;
  } catch {
    return ownerKey;
  }
}

/**
 * Checks whether two service owner keys represent the same logical service scope.
 */
export function isCompatibleServiceOwner(
  recordedOwner: string | null | undefined,
  activeOwner: string | null | undefined,
): boolean {
  if (recordedOwner === activeOwner) return true;
  return canonicalizeServiceOwner(recordedOwner) === canonicalizeServiceOwner(activeOwner);
}

/** The single local owner instance. */
export const LOCAL_OWNER: OpenCodeHistoryOwner = Object.freeze({
  kind: "local" as const,
  profileId: "default",
});

/** Compatibility alias for legacy code and tests. */
export const MANAGED_HISTORY_OWNER: OpenCodeHistoryOwner = LOCAL_OWNER;

/**
 * Creates an adopted history owner for an origin.
 * Loopback origins resolve to LOCAL_OWNER only when not explicitly configured
 * and not belonging to a custom profile.
 */
export function adoptedHistoryOwner(origin: string, profileId?: string): OpenCodeHistoryOwner {
  try {
    const canonical = canonicalizeRemoteOrigin(origin);
    const url = new URL(canonical);
    const isExplicit =
      profileId && (profileId.startsWith("explicit:") || profileId.startsWith("remote:"));
    const isCustomProfile = profileId && profileId !== "default" && profileId !== "local";

    if (isLoopbackHost(url.hostname) && !isExplicit && !isCustomProfile) {
      return LOCAL_OWNER;
    }
    return Object.freeze({
      kind: "remote" as const,
      origin: canonical,
      profileId: profileId ?? `explicit:${canonical}`,
    });
  } catch {
    return LOCAL_OWNER;
  }
}

/** The persisted key for one owner: "local" or "remote:<origin>". */
export function serializeHistoryOwner(owner: OpenCodeHistoryOwner): string {
  return owner.kind === "local" ? LOCAL_HISTORY_OWNER : `${REMOTE_OWNER_PREFIX}${owner.origin}`;
}

/**
 * Parses a persisted owner key into an OpenCodeHistoryOwner.
 */
export function parseHistoryOwnerKey(value: string): OpenCodeHistoryOwner {
  const canonical = canonicalizeServiceOwner(value);
  if (canonical === LOCAL_HISTORY_OWNER) return LOCAL_OWNER;
  if (canonical.startsWith(REMOTE_OWNER_PREFIX)) {
    const origin = canonical.slice(REMOTE_OWNER_PREFIX.length);
    try {
      const url = new URL(origin);
      if (url.protocol === "http:" || url.protocol === "https:") {
        return Object.freeze({
          kind: "remote" as const,
          origin: canonicalizeRemoteOrigin(url.origin),
          profileId: `explicit:${canonicalizeRemoteOrigin(url.origin)}`,
        });
      }
    } catch {
      // invalid URL
    }
  }
  throw new OpenCodeHistoryBoundaryError(
    "unreadable",
    "",
    "The stored OpenCode service owner cannot be interpreted",
  );
}

/** Accepts either an OpenCodeTarget or OpenCodeRuntimeTarget. */
export interface TargetLike {
  readonly mode: "managed" | "adopted" | "unresolved";
  readonly baseUrl?: string;
  readonly origin?: string;
  readonly profileId?: string;
}

/** The owner an installed target represents, or `null` when nothing is installed. */
export function historyOwnerFromTarget(target: TargetLike): OpenCodeHistoryOwner | null {
  if (target.mode === "unresolved") return null;
  if (target.mode === "managed") return LOCAL_OWNER;
  if (target.mode === "adopted") {
    const endpoint = target.origin ?? target.baseUrl;
    if (!endpoint) return LOCAL_OWNER;
    try {
      const url = new URL(endpoint);
      const isExplicit =
        target.profileId &&
        (target.profileId.startsWith("explicit:") || target.profileId.startsWith("remote:"));
      const isCustomProfile =
        target.profileId && target.profileId !== "default" && target.profileId !== "local";

      if (isLoopbackHost(url.hostname) && !isExplicit && !isCustomProfile) {
        return LOCAL_OWNER;
      }
      return Object.freeze({
        kind: "remote" as const,
        origin: canonicalizeRemoteOrigin(url.origin),
        profileId: target.profileId ?? `explicit:${canonicalizeRemoteOrigin(url.origin)}`,
      });
    } catch {
      return LOCAL_OWNER;
    }
  }
  return null;
}

/**
 * The service owner recorded for a conversation, or `null` when it has no session binding.
 */
export function readConversationHistoryOwner(
  conversation: Pick<Conversation, "id" | "opencodeSessionId" | "opencodeServiceOwner">,
): OpenCodeHistoryOwner | null {
  if (!conversation.opencodeSessionId) return null;
  const stored = conversation.opencodeServiceOwner;
  if (stored === null || stored === undefined || stored === "") return LOCAL_OWNER;
  try {
    return parseHistoryOwnerKey(stored);
  } catch (cause) {
    if (cause instanceof OpenCodeHistoryBoundaryError) {
      throw new OpenCodeHistoryBoundaryError(cause.refusal, conversation.id, cause.message);
    }
    throw new OpenCodeHistoryBoundaryError(
      "unreadable",
      conversation.id,
      "The stored OpenCode service owner cannot be interpreted",
    );
  }
}

/** Pure predicate: are two owners the same scope? */
export function sameHistoryOwner(
  a: OpenCodeHistoryOwner | null,
  b: OpenCodeHistoryOwner | null,
): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (a.kind === "local" && b.kind === "local") return true;
  if (a.kind === "remote" && b.kind === "remote") {
    return a.origin === b.origin;
  }
  return false;
}

/**
 * Asserts that the recorded owner matches the active owner.
 * Any local owner is compatible with any other local owner.
 */
export function assertSameHistoryOwner(
  conversationId: string,
  recorded: OpenCodeHistoryOwner | null,
  active: OpenCodeHistoryOwner,
): void {
  if (recorded === null) return;
  if (sameHistoryOwner(recorded, active)) return;

  throw new OpenCodeHistoryBoundaryError(
    "cross_service",
    conversationId,
    `This conversation's OpenCode history belongs to ${describeHistoryOwner(recorded)}, ` +
      `but ${describeHistoryOwner(active)} is in use. TBAi does not move histories between services.`,
  );
}

/** Human-readable description of an owner, without credentials or session IDs. */
export function describeHistoryOwner(owner: OpenCodeHistoryOwner): string {
  if (owner.kind === "local") {
    return "the local OpenCode environment";
  }
  return `the remote service at ${owner.origin}`;
}

export type OpenCodeHistoryOwner =
  | { readonly kind: "local"; readonly profileId?: string }
  | { readonly kind: "remote"; readonly origin: string; readonly profileId?: string };
