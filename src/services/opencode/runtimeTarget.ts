import { DEFAULT_PROFILE_ID } from "./serviceProfile";
import {
  captureOpenCodeRequestContext,
  createManagedFallbackTransport,
  OpenCodeNotReadyError,
  readBackendInstanceId,
  readConnectionState,
  readShutdownState,
  type OpenCodeTransport,
} from "./connectionState";
import type { OpenCodeTarget } from "./connectionState";
import { openCodeServerManager } from "./serverManager";

/**
 * The one resolver for "which service does this server-wide call talk to?".
 *
 * TBAi owns exactly one managed OpenCode runtime. Server-wide surfaces resolve to
 * the installed managed target or start the managed child on demand.
 */

/** The service current server-wide calls must use. Immutable. */
export interface OpenCodeRuntimeTarget {
  readonly mode: "managed";
  /** Unique target identity when installed. */
  readonly targetId?: number;
  /** Connection-state revision of the resolved target snapshot. */
  readonly targetRevision: number;
  /** Canonical, slash-free origin. */
  readonly baseUrl: string;
  /** The captured, origin-bound transport. */
  readonly transport: OpenCodeTransport;
  /** Managed-only runtime has no adopted capability snapshot. */
  readonly capabilities: null;
  readonly profileId?: string;
}

/** Target identity for runtime-target transition detection. */
export interface OpenCodeRuntimeTargetIdentity {
  readonly backendInstanceId: string;
  readonly targetRevision: number;
  readonly targetId: number | null;
}

/** What the UI may learn about the runtime: a mode, never a credential. */
export type OpenCodeRuntimeStatus =
  | Readonly<{ mode: "unresolved" } & OpenCodeRuntimeTargetIdentity>
  | Readonly<{ mode: "managed" } & OpenCodeRuntimeTargetIdentity>;

export interface OpenCodeRuntimeTargetOptions {
  /** Test seam; production starts the managed child through the manager. */
  readonly ensureManaged?: () => Promise<string>;
}

function captureInstalled(target: OpenCodeTarget & { mode: "managed" }) {
  const context = captureOpenCodeRequestContext();
  return Object.freeze<OpenCodeRuntimeTarget>({
    mode: "managed",
    targetId: target.targetId,
    targetRevision: context.revision,
    baseUrl: context.baseUrl,
    transport: context.transport,
    capabilities: null,
    profileId: target.profileId ?? context.profileId,
  });
}

/**
 * Resolves the managed service server-wide calls must use.
 *
 * @throws {OpenCodeNotReadyError} after shutdown.
 */
export async function resolveOpenCodeRuntimeTarget(
  options: OpenCodeRuntimeTargetOptions = {},
): Promise<OpenCodeRuntimeTarget> {
  if (readShutdownState().shutdownStarted) throw new OpenCodeNotReadyError();
  const installed = readConnectionState().target;
  if (installed.mode === "managed") return captureInstalled(installed);

  const ensureManaged = options.ensureManaged ?? (() => openCodeServerManager.ensureBaseUrl());
  const baseUrl = await ensureManaged();

  const publishedState = readConnectionState();
  const published = publishedState.target;
  if (published.mode === "managed") return captureInstalled(published);

  return Object.freeze<OpenCodeRuntimeTarget>({
    mode: "managed",
    targetRevision: publishedState.revision,
    baseUrl,
    transport: createManagedFallbackTransport(baseUrl),
    capabilities: null,
    profileId: DEFAULT_PROFILE_ID,
  });
}

/**
 * Describes the runtime for the browser, without starting or probing anything.
 */
export function describeOpenCodeRuntime(): OpenCodeRuntimeStatus {
  const state = readConnectionState();
  const backendInstanceId = readBackendInstanceId();
  const targetRevision = state.revision;
  if (readShutdownState().shutdownStarted) {
    return { mode: "unresolved", backendInstanceId, targetRevision, targetId: null };
  }
  const target = state.target;
  if (target.mode === "managed") {
    return { mode: "managed", backendInstanceId, targetRevision, targetId: target.targetId };
  }
  return { mode: "unresolved", backendInstanceId, targetRevision, targetId: null };
}
