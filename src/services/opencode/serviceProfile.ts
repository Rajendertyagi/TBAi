import {
  canonicalizeServiceOwner,
  isLoopbackHost,
  canonicalizeRemoteOrigin,
  LOCAL_HISTORY_OWNER,
  REMOTE_OWNER_PREFIX,
} from "./historyBoundary";
import type { OpenCodeConfig } from "../../config/opencode";

export const DEFAULT_PROFILE_ID = "default";
export const LEGACY_MANAGED_OWNER = "managed";
export const ADOPTED_OWNER_PREFIX = "adopted:";
export const PROFILE_OWNER_PREFIX = "profile:";

export type ServiceProfileKind = "local-default" | "explicit" | "channel" | "custom-registration";

export interface ServiceProfile {
  readonly id: string;
  readonly kind: ServiceProfileKind;
  readonly displayName: string;
  readonly registrationPath?: string;
  readonly dataLocation?: string;
  readonly origin?: string;
}

export interface ResolveProfileOptions {
  readonly mode: "managed" | "adopted";
  readonly origin?: string;
  readonly registrationPath?: string;
  readonly channel?: string;
  readonly explicit?: boolean;
  readonly dataLocation?: string;
  readonly config?: OpenCodeConfig;
}

/**
 * Resolves a service profile description.
 * Explicit configurations (e.g. OPENCODE_URL) or non-loopback endpoints map to "explicit".
 * Default registered local services map to "default" (local).
 */
export function resolveServiceProfile(options: ResolveProfileOptions): ServiceProfile {
  if (options.origin) {
    try {
      const url = new URL(options.origin);
      if (options.explicit || !isLoopbackHost(url.hostname)) {
        const canonical = canonicalizeRemoteOrigin(url.origin);
        return Object.freeze({
          id: `explicit:${canonical}`,
          kind: "explicit",
          displayName: `Explicit OpenCode Service (${canonical})`,
          origin: canonical,
          dataLocation: options.dataLocation,
        });
      }
    } catch {
      // Fall through to default
    }
  }

  return Object.freeze({
    id: DEFAULT_PROFILE_ID,
    kind: "local-default",
    displayName: "Default Local OpenCode Service",
    registrationPath: options.registrationPath,
    origin: options.origin,
    dataLocation: options.dataLocation,
  });
}

/**
 * Resolves the logical profile ID from an arbitrary stored owner string.
 */
export function resolveProfileIdFromOwner(ownerKey: string | null | undefined): string {
  const canonical = canonicalizeServiceOwner(ownerKey);
  if (canonical === LOCAL_HISTORY_OWNER) {
    return DEFAULT_PROFILE_ID;
  }
  if (canonical.startsWith(REMOTE_OWNER_PREFIX)) {
    return `explicit:${canonical.slice(REMOTE_OWNER_PREFIX.length)}`;
  }
  if (canonical.startsWith("profile:")) {
    return canonical.slice("profile:".length);
  }
  return DEFAULT_PROFILE_ID;
}

/**
 * Checks whether two service owner keys represent the same logical service scope.
 */
export function isCompatibleServiceOwner(
  recordedOwner: string | null | undefined,
  activeOwnerOrProfile: string | null | undefined,
): boolean {
  if (recordedOwner === activeOwnerOrProfile) return true;
  return canonicalizeServiceOwner(recordedOwner) === canonicalizeServiceOwner(activeOwnerOrProfile);
}
