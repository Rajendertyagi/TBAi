import type { OpenCodeServiceCapabilities } from "./compatibility";
import {
  captureOpenCodeRequestContext,
  createManagedFallbackTransport,
  OpenCodeNotReadyError,
  readConnectionState,
  readShutdownState,
  type OpenCodeTransport,
} from "./connectionState";
import type { OpenCodeTarget } from "./connectionState";
import { openCodeServerManager } from "./serverManager";

/**
 * The one resolver for "which service does this server-wide call talk to?".
 *
 * Session, history and configuration calls are conversation-scoped and resolve
 * through `serviceAccess.ts`, which refuses a conversation bound to a service
 * that is not installed. The server-wide surfaces — the model/agent catalogue,
 * the command feed, the configuration page and the browser proxy — belong to
 * whichever service the runtime is bound to, and this is where that binding is
 * read.
 *
 * ## Why a transport, not a URL plus headers
 *
 * The credential belongs to exactly one origin (§1.9.3). Returning a bare
 * `baseUrl` and letting each caller pair it with `getOpenCodeAuthHeaders()` is
 * how an adopted conversation could end up sending TBAi's managed password to
 * somebody else's service. {@link OpenCodeRuntimeTarget.transport} carries the
 * credential for the installed target and enforces that origin, so a caller
 * cannot separate the two. That is also why no raw header record is returned
 * beside it: `baseUrl` and the credential travel only inside one transport.
 *
 * `transport` is REQUIRED. The one legacy case — a managed start that returned
 * without publishing a target (a test double or an old manager) — still gets a
 * real transport, built from the managed credential by
 * {@link createManagedFallbackTransport}. Production publishes before
 * `ensureBaseUrl()` resolves, so that fallback is a compatibility path, not a
 * normal one.
 *
 * ## What this does NOT do
 *
 * It never adopts, probes or starts an ADOPTED service: an unresolved target
 * with a running adopted service simply means the startup attempt has not run
 * yet. {@link describeOpenCodeRuntime} never starts anything either, so the
 * status surface cannot spawn a managed child as a side effect.
 */

/** The service current server-wide calls must use. Immutable. */
export interface OpenCodeRuntimeTarget {
  readonly mode: "managed" | "adopted";
  /** Canonical, slash-free origin. */
  readonly baseUrl: string;
  /**
   * The captured, origin-bound transport. Required, so a caller can never
   * separate the origin from the credential that belongs to it.
   */
  readonly transport: OpenCodeTransport;
  /** What adoption proved about an adopted service (B7); null when not assessed. */
  readonly capabilities: OpenCodeServiceCapabilities | null;
}

/** What the UI may learn about the runtime: a mode, never a credential. */
export type OpenCodeRuntimeStatus =
  | Readonly<{ mode: "unresolved" }>
  | Readonly<{ mode: "managed" }>
  | Readonly<{ mode: "adopted"; capabilities: OpenCodeServiceCapabilities | null }>;

export interface OpenCodeRuntimeTargetOptions {
  /** Test seam; production starts the managed child through the manager. */
  readonly ensureManaged?: () => Promise<string>;
}

/** Projects an installed target into the resolver's shape. */
function captureInstalled(target: OpenCodeTarget & { mode: "managed" | "adopted" }) {
  const context = captureOpenCodeRequestContext();
  return Object.freeze<OpenCodeRuntimeTarget>({
    mode: target.mode,
    baseUrl: context.baseUrl,
    transport: context.transport,
    capabilities: target.mode === "adopted" ? target.capabilities : null,
  });
}

/**
 * Resolves the service server-wide calls must use.
 *
 * When nothing is installed this starts the managed child, exactly as the
 * pre-adoption call sites did. Startup attempts adoption first (`startup.ts`),
 * so by the time a request arrives an eligible adopted service is already
 * installed and this never starts a managed child beside it.
 *
 * @throws {OpenCodeNotReadyError} after shutdown.
 */
export async function resolveOpenCodeRuntimeTarget(
  options: OpenCodeRuntimeTargetOptions = {},
): Promise<OpenCodeRuntimeTarget> {
  if (readShutdownState().shutdownStarted) throw new OpenCodeNotReadyError();
  const installed = readConnectionState().target;
  if (installed.mode !== "unresolved") return captureInstalled(installed);

  const ensureManaged = options.ensureManaged ?? (() => openCodeServerManager.ensureBaseUrl());
  const baseUrl = await ensureManaged();

  // The managed start publishes a target before it resolves. Re-read rather
  // than assume, so an adopted target installed concurrently still wins.
  const published = readConnectionState().target;
  if (published.mode !== "unresolved") return captureInstalled(published);

  return Object.freeze<OpenCodeRuntimeTarget>({
    mode: "managed",
    baseUrl,
    transport: createManagedFallbackTransport(baseUrl),
    capabilities: null,
  });
}

/**
 * Describes the runtime for the browser, without starting or probing anything.
 *
 * The status a page may render is deliberately this small: a mode, and for an
 * adopted service the capability snapshot that decides which optional surfaces
 * to hide. The origin, the password, the registration path and the probe
 * result body never leave the backend.
 */
export function describeOpenCodeRuntime(): OpenCodeRuntimeStatus {
  if (readShutdownState().shutdownStarted) return { mode: "unresolved" };
  const target = readConnectionState().target;
  if (target.mode === "unresolved") return { mode: "unresolved" };
  if (target.mode === "managed") return { mode: "managed" };
  return { mode: "adopted", capabilities: target.capabilities };
}
