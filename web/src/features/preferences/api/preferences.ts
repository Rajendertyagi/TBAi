import { apiFetch } from "../../../lib/platform";
import type { WorkspacePreferencesSnapshot } from "../state/types";

export interface PreferencesConflictResponse {
  error: string;
  conflict: true;
  revision: number;
  snapshot: WorkspacePreferencesSnapshot;
}

export class PreferencesConflictError extends Error {
  readonly revision: number;
  readonly snapshot: WorkspacePreferencesSnapshot;

  constructor(response: PreferencesConflictResponse) {
    super(response.error);
    this.name = "PreferencesConflictError";
    this.revision = response.revision;
    this.snapshot = response.snapshot;
  }
}

function getOriginWindowId(): string {
  if (typeof window === "undefined") return "server";
  try {
    const key = "tbai:window-id";
    const existing = window.sessionStorage.getItem(key);
    if (existing) return existing;
    const id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `w_${Math.random().toString(36).slice(2)}`;
    window.sessionStorage.setItem(key, id);
    return id;
  } catch {
    return `w_${Math.random().toString(36).slice(2)}`;
  }
}

export const originWindowId = getOriginWindowId();

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function handleSnapshotResponse(res: Response): Promise<WorkspacePreferencesSnapshot> {
  const data = await readJson<WorkspacePreferencesSnapshot | PreferencesConflictResponse | { error?: string; code?: string }>(res);
  if (res.status === 409 && data && typeof data === "object" && "conflict" in data && (data as any).conflict) {
    throw new PreferencesConflictError(data as PreferencesConflictResponse);
  }
  if (!res.ok) {
    const msg =
      data && typeof data === "object" && "error" in data && typeof (data as any).error === "string"
        ? (data as any).error
        : `Preferences request failed (${res.status})`;
    throw new Error(msg);
  }
  return data as WorkspacePreferencesSnapshot;
}

export async function fetchPreferences(): Promise<WorkspacePreferencesSnapshot> {
  const res = await apiFetch("/api/preferences");
  return handleSnapshotResponse(res);
}

export async function patchPreferences(input: {
  baseRevision: number;
  preferences: Record<string, unknown>;
}): Promise<WorkspacePreferencesSnapshot> {
  const res = await apiFetch("/api/preferences", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...input, originWindowId }),
  });
  return handleSnapshotResponse(res);
}

export async function openSharedTab(input: {
  baseRevision: number;
  conversationId: string;
  kind: "chat" | "agent";
}): Promise<WorkspacePreferencesSnapshot> {
  const res = await apiFetch("/api/preferences/tabs/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...input, originWindowId }),
  });
  return handleSnapshotResponse(res);
}

export async function closeSharedTab(input: {
  baseRevision: number;
  conversationId: string;
}): Promise<WorkspacePreferencesSnapshot> {
  const res = await apiFetch("/api/preferences/tabs/close", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...input, originWindowId }),
  });
  return handleSnapshotResponse(res);
}

export async function closeSharedTabsBatch(input: {
  baseRevision: number;
  mode: "others" | "right" | "all";
  anchorConversationId?: string;
}): Promise<WorkspacePreferencesSnapshot> {
  const res = await apiFetch("/api/preferences/tabs/close-batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...input, originWindowId }),
  });
  return handleSnapshotResponse(res);
}

export async function reorderSharedTab(input: {
  baseRevision: number;
  conversationId: string;
  toIndex: number;
}): Promise<WorkspacePreferencesSnapshot> {
  const res = await apiFetch("/api/preferences/tabs/reorder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...input, originWindowId }),
  });
  return handleSnapshotResponse(res);
}
