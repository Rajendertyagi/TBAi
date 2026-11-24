/**
 * What the backend reports about the selected OpenCode runtime, and how the
 * feature's surface presents it.
 *
 * Managed-only runtime: TBAi owns exactly one managed `opencode serve` process.
 * The browser is told a mode and target identity, never credentials or origins.
 */

import { create } from "zustand";
import { useAvailabilityStore } from "../availability/availabilityStore";

/** The routes the capability probe checks. Mirrors the backend's capability ids. */
export type OpenCodeCapabilityId = "session" | "events" | "config" | "agent" | "model" | "command";

/** Target identity for invalidation when the active OpenCode runtime changes. */
export interface OpenCodeRuntimeTargetIdentity {
  readonly backendInstanceId: string;
  readonly targetRevision: number;
  readonly targetId: number | null;
}

/** The stable status `GET /api/opencode/status` answers with. */
export type OpenCodeRuntimeStatus =
  | Readonly<{ mode: "unresolved" } & OpenCodeRuntimeTargetIdentity>
  | Readonly<{ mode: "managed" } & OpenCodeRuntimeTargetIdentity>;

/** The single sentence the error surface shows when no service can be reached. */
export const OPENCODE_UNAVAILABLE_NOTICE = "OpenCode is not available";

/** What the status surface shows for one mode. */
export interface OpenCodeRuntimeView {
  /** The word for the Runtime row. */
  readonly label: string;
  /** One sentence explaining the selection, or null when the label says enough. */
  readonly detail: string | null;
  /** True when the backend reports no installed target. */
  readonly unresolved: boolean;
}

function toTargetIdentity(input: unknown): OpenCodeRuntimeTargetIdentity {
  if (input === null || typeof input !== "object") {
    return { backendInstanceId: "", targetRevision: 0, targetId: null };
  }
  const backendInstanceId = Reflect.get(input, "backendInstanceId");
  const targetRevision = Reflect.get(input, "targetRevision");
  const targetId = Reflect.get(input, "targetId");
  return {
    backendInstanceId: typeof backendInstanceId === "string" ? backendInstanceId : "",
    targetRevision:
      typeof targetRevision === "number" && Number.isFinite(targetRevision)
        ? Math.max(0, Math.floor(targetRevision))
        : 0,
    targetId:
      typeof targetId === "number" && Number.isFinite(targetId) ? Math.floor(targetId) : null,
  };
}

/**
 * Parses a status payload.
 *
 * @throws {Error} When the payload is not a status this build understands.
 */
export function parseOpenCodeRuntimeStatus(input: unknown): OpenCodeRuntimeStatus {
  if (input === null || typeof input !== "object") {
    throw new Error("OpenCode returned an unreadable runtime status");
  }
  const mode = Reflect.get(input, "mode");
  const identity = toTargetIdentity(input);
  if (mode === "unresolved") return { mode, ...identity };
  if (mode === "managed") return { mode, ...identity };
  throw new Error("OpenCode returned an unknown runtime status");
}

/**
 * Reads the status response.
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

/** Maps a status to the chip's Runtime row. */
export function runtimeStatusView(status: OpenCodeRuntimeStatus): OpenCodeRuntimeView {
  if (status.mode === "unresolved") {
    return { label: "Not started", detail: null, unresolved: true };
  }
  return { label: "Managed service", detail: null, unresolved: false };
}

/** True when two runtime statuses refer to the same target identity. */
export function sameOpenCodeRuntimeTarget(
  a: OpenCodeRuntimeTargetIdentity | null | undefined,
  b: OpenCodeRuntimeTargetIdentity | null | undefined,
): boolean {
  if (!a || !b) return false;
  return (
    a.backendInstanceId === b.backendInstanceId &&
    a.targetRevision === b.targetRevision &&
    a.targetId === b.targetId
  );
}

interface RuntimeTargetState {
  /** Latest successfully observed runtime status (shared invalidation signal). */
  status: OpenCodeRuntimeStatus | null;
  /** Message from the last failed status read; null after a successful read. */
  error: string | null;
  /** Recovery epoch associated with the last accepted runtime status publication. */
  acceptedRecoveryEpoch: number;
  /** Backend process instance of the last accepted runtime status publication. */
  acceptedBackendInstanceId: string | null;
  /** Previous backend instance superseded by the accepted instance (stale in-flight guard). */
  supersededBackendInstanceId: string | null;
}

export const useRuntimeTargetStore = create<RuntimeTargetState>()(() => ({
  status: null,
  error: null,
  acceptedRecoveryEpoch: -1,
  acceptedBackendInstanceId: null,
  supersededBackendInstanceId: null,
}));

function isNewerRuntimePublication(
  current: OpenCodeRuntimeStatus | null,
  currentEpoch: number,
  currentInstanceId: string | null,
  supersededInstanceId: string | null,
  next: OpenCodeRuntimeStatus,
  nextEpoch: number,
): boolean {
  if (!current) return true;

  const nextInstanceId = next.backendInstanceId;
  if (currentInstanceId && nextInstanceId) {
    if (nextInstanceId === supersededInstanceId) {
      return false;
    }
    if (nextInstanceId !== currentInstanceId) {
      return true;
    }
    if (next.targetRevision !== current.targetRevision) {
      return next.targetRevision > current.targetRevision;
    }
  } else if (nextEpoch !== currentEpoch) {
    return nextEpoch > currentEpoch;
  } else if (next.targetRevision !== current.targetRevision) {
    return next.targetRevision > current.targetRevision;
  }

  if (next.targetId !== current.targetId || next.mode !== current.mode) {
    return false;
  }
  return true;
}

/** Publishes the latest observed runtime status for cross-store invalidation. */
export function publishRuntimeStatus(
  status: OpenCodeRuntimeStatus,
  recoveryEpoch = useAvailabilityStore.getState().recoveryEpoch,
): void {
  useRuntimeTargetStore.setState((state) => {
    if (
      !isNewerRuntimePublication(
        state.status,
        state.acceptedRecoveryEpoch,
        state.acceptedBackendInstanceId,
        state.supersededBackendInstanceId,
        status,
        recoveryEpoch,
      )
    ) {
      return state;
    }
    const nextInstanceId = status.backendInstanceId || state.acceptedBackendInstanceId;
    const supersededBackendInstanceId =
      state.acceptedBackendInstanceId &&
      nextInstanceId &&
      nextInstanceId !== state.acceptedBackendInstanceId
        ? state.acceptedBackendInstanceId
        : state.supersededBackendInstanceId;
    return {
      status,
      acceptedRecoveryEpoch: recoveryEpoch,
      acceptedBackendInstanceId: nextInstanceId,
      supersededBackendInstanceId,
    };
  });
}

/** Publishes a runtime target identity update (e.g. from lifecycle events). */
export function publishRuntimeTargetIdentity(
  identity: OpenCodeRuntimeTargetIdentity & { mode: OpenCodeRuntimeStatus["mode"] },
  recoveryEpoch = useAvailabilityStore.getState().recoveryEpoch,
): void {
  const next: OpenCodeRuntimeStatus =
    identity.mode === "managed"
      ? {
          mode: "managed",
          backendInstanceId: identity.backendInstanceId,
          targetRevision: identity.targetRevision,
          targetId: identity.targetId,
        }
      : {
          mode: "unresolved",
          backendInstanceId: identity.backendInstanceId,
          targetRevision: identity.targetRevision,
          targetId: identity.targetId,
        };
  publishRuntimeStatus(next, recoveryEpoch);
}

/** Test-only reset for the shared runtime target signal. */
export function resetRuntimeTargetStoreForTests(): void {
  useRuntimeTargetStore.setState({
    status: null,
    error: null,
    acceptedRecoveryEpoch: -1,
    acceptedBackendInstanceId: null,
    supersededBackendInstanceId: null,
  });
}

/**
 * Managed-only runtime: capabilities are not gated by an adopted snapshot.
 */
export function openCodeCapabilitySupported(
  _status: OpenCodeRuntimeStatus,
  _id: OpenCodeCapabilityId,
): boolean {
  return true;
}
