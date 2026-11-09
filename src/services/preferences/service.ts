import { db } from "../../db";
import {
  WORKSPACE_PREFERENCES_SNAPSHOT_KEY,
  defaultSnapshot,
  mergePortablePreferences,
  parseStoredSnapshot,
} from "./registry";
import type { PreferencesPatchResult, SharedTabRef, WorkspacePreferencesSnapshot } from "./types";
import { WorkspacePreferencesCorruptError } from "./types";

export interface PreferencesChangeEvent {
  revision: number;
  changedKeys?: string[];
  originWindowId?: string;
  ts: number;
}

type PreferencesSubscriber = (event: PreferencesChangeEvent) => void;

const subscribers = new Set<PreferencesSubscriber>();

/** Subscribes to post-commit workspace preference revision hints. */
export function subscribePreferencesChanges(fn: PreferencesSubscriber): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function emitPreferencesChange(event: PreferencesChangeEvent): void {
  for (const fn of subscribers) {
    try {
      fn(event);
    } catch {
      /* subscriber errors must not break the commit path */
    }
  }
}

type SnapshotRead =
  | { state: "absent" }
  | { state: "valid"; snapshot: WorkspacePreferencesSnapshot }
  | { state: "corrupt"; error: WorkspacePreferencesCorruptError };

function readSnapshotRow(): SnapshotRead {
  const row = db
    .query("SELECT value FROM app_settings WHERE key = ?")
    .get(WORKSPACE_PREFERENCES_SNAPSHOT_KEY) as { value: string } | undefined;
  if (!row) return { state: "absent" };
  try {
    const parsed = JSON.parse(row.value) as unknown;
    return { state: "valid", snapshot: parseStoredSnapshot(parsed) };
  } catch (err) {
    if (err instanceof WorkspacePreferencesCorruptError) return { state: "corrupt", error: err };
    return { state: "corrupt", error: new WorkspacePreferencesCorruptError("snapshot JSON is malformed") };
  }
}

// (reserved helper removed; read path is explicit via get/transactions)

function writeSnapshotRow(snapshot: WorkspacePreferencesSnapshot): void {
  db.run(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [WORKSPACE_PREFERENCES_SNAPSHOT_KEY, JSON.stringify(snapshot), Date.now()],
  );
}

/**
 * Authoritative shared workspace preferences snapshot.
 * - Absent row: canonical defaults (valid uninitialized), no write.
 * - Valid row: authoritative saved state.
 * - Corrupt row: throws WorkspacePreferencesCorruptError (row preserved).
 */
export function getWorkspacePreferences(): WorkspacePreferencesSnapshot {
  const read = readSnapshotRow();
  if (read.state === "corrupt") throw read.error;
  if (read.state === "absent") return defaultSnapshot();
  return read.snapshot;
}

function commitSnapshot(next: WorkspacePreferencesSnapshot): PreferencesPatchResult {
  writeSnapshotRow(next);
  return { conflict: false, snapshot: next };
}

function emitAfterCommit(
  result: PreferencesPatchResult,
  changedKeys: string[] | undefined,
  originWindowId: string | undefined,
  previousRevision: number,
): PreferencesPatchResult {
  if (!result.conflict && result.snapshot.revision > previousRevision) {
    emitPreferencesChange({
      revision: result.snapshot.revision,
      changedKeys,
      originWindowId,
      ts: Date.now(),
    });
  }
  return result;
}

function sameSharedTabs(a: SharedTabRef[], b: SharedTabRef[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]?.kind !== b[i]?.kind || a[i]?.ref !== b[i]?.ref) return false;
  }
  return true;
}

/**
 * Atomically applies an allowlisted portable-preferences patch (settings only)
 * using workspace revision CAS. Leaf-field merge; omitted fields unchanged.
 * Corrupt snapshot => throws (no overwrite). Stale => conflict, no mutation.
 * Identical merged result => no revision bump/write.
 */
export function patchWorkspacePreferences(input: {
  baseRevision: number;
  preferences: unknown;
  originWindowId?: string;
}): PreferencesPatchResult {
  if (input.preferences === null || typeof input.preferences !== "object" || Array.isArray(input.preferences)) {
    throw new Error("preferences must be an object");
  }
  const patch = input.preferences as Record<string, unknown>;
  // Allowlist groups only; reject unknown top-level groups.
  for (const key of Object.keys(patch)) {
    if (!["appearance", "desktop", "welcome", "navigation"].includes(key)) {
      throw new Error(`Unknown preferences group: ${key}`);
    }
  }

  const tx = db.transaction((baseRevision: number): PreferencesPatchResult => {
    const read = readSnapshotRow();
    if (read.state === "corrupt") throw read.error;
    const current = read.state === "absent" ? defaultSnapshot() : read.snapshot;
    if (current.revision !== baseRevision) {
      return { conflict: true, revision: current.revision, snapshot: current };
    }

    const merged = mergePortablePreferences(current.preferences, patch as any);
    if (JSON.stringify(merged) === JSON.stringify(current.preferences)) {
      return { conflict: false, snapshot: current };
    }

    const next: WorkspacePreferencesSnapshot = {
      revision: current.revision + 1,
      sharedTabs: current.sharedTabs,
      preferences: merged,
    };
    return commitSnapshot(next);
  });

  const result = tx(input.baseRevision);
  return emitAfterCommit(result, ["preferences"], input.originWindowId, input.baseRevision);
}

/** Adds a real conversation to shared tab membership (idempotent). No shared active pointer. */
export function openSharedTab(input: {
  baseRevision: number;
  kind: SharedTabRef["kind"];
  conversationId: string;
  originWindowId?: string;
}): PreferencesPatchResult {
  const tx = db.transaction((baseRevision: number): PreferencesPatchResult => {
    const read = readSnapshotRow();
    if (read.state === "corrupt") throw read.error;
    const current = read.state === "absent" ? defaultSnapshot() : read.snapshot;
    if (current.revision !== baseRevision) {
      return { conflict: true, revision: current.revision, snapshot: current };
    }
    const exists = current.sharedTabs.some((t) => t.ref === input.conversationId);
    if (exists) return { conflict: false, snapshot: current };
    const sharedTabs = [...current.sharedTabs, { kind: input.kind, ref: input.conversationId }];
    const next: WorkspacePreferencesSnapshot = {
      revision: current.revision + 1,
      sharedTabs,
      preferences: current.preferences,
    };
    return commitSnapshot(next);
  });
  const result = tx(input.baseRevision);
  return emitAfterCommit(result, ["sharedTabs"], input.originWindowId, input.baseRevision);
}

/** Removes a real conversation from shared tab membership (idempotent). Never deletes conversation data. */
export function closeSharedTab(input: {
  baseRevision: number;
  conversationId: string;
  originWindowId?: string;
}): PreferencesPatchResult {
  const tx = db.transaction((baseRevision: number): PreferencesPatchResult => {
    const read = readSnapshotRow();
    if (read.state === "corrupt") throw read.error;
    const current = read.state === "absent" ? defaultSnapshot() : read.snapshot;
    if (current.revision !== baseRevision) {
      return { conflict: true, revision: current.revision, snapshot: current };
    }
    const sharedTabs = current.sharedTabs.filter((t) => t.ref !== input.conversationId);
    if (sameSharedTabs(sharedTabs, current.sharedTabs)) {
      return { conflict: false, snapshot: current };
    }
    const next: WorkspacePreferencesSnapshot = {
      revision: current.revision + 1,
      sharedTabs,
      preferences: current.preferences,
    };
    return commitSnapshot(next);
  });
  const result = tx(input.baseRevision);
  return emitAfterCommit(result, ["sharedTabs"], input.originWindowId, input.baseRevision);
}

/** Atomically applies a batch close mutation to shared tab membership (server-computed). */
export function closeSharedTabsBatch(input: {
  baseRevision: number;
  mode: "others" | "right" | "all";
  anchorConversationId?: string;
  originWindowId?: string;
}): PreferencesPatchResult {
  const tx = db.transaction((baseRevision: number): PreferencesPatchResult => {
    const read = readSnapshotRow();
    if (read.state === "corrupt") throw read.error;
    const current = read.state === "absent" ? defaultSnapshot() : read.snapshot;
    if (current.revision !== baseRevision) {
      return { conflict: true, revision: current.revision, snapshot: current };
    }
    let sharedTabs = current.sharedTabs;
    if (input.mode === "all") {
      sharedTabs = [];
    } else if (input.anchorConversationId) {
      const idx = current.sharedTabs.findIndex((t) => t.ref === input.anchorConversationId);
      if (idx >= 0) {
        sharedTabs =
          input.mode === "others" ? [current.sharedTabs[idx]!] : current.sharedTabs.slice(0, idx + 1);
      } else {
        // Anchor not found: no-op (authoritative state wins).
        return { conflict: false, snapshot: current };
      }
    } else {
      return { conflict: false, snapshot: current };
    }
    if (sameSharedTabs(sharedTabs, current.sharedTabs)) {
      return { conflict: false, snapshot: current };
    }
    const next: WorkspacePreferencesSnapshot = {
      revision: current.revision + 1,
      sharedTabs,
      preferences: current.preferences,
    };
    return commitSnapshot(next);
  });
  const result = tx(input.baseRevision);
  return emitAfterCommit(result, ["sharedTabs"], input.originWindowId, input.baseRevision);
}

/** Reorders a shared tab by conversation id (CAS, server-computed). */
export function reorderSharedTab(input: {
  baseRevision: number;
  conversationId: string;
  toIndex: number;
  originWindowId?: string;
}): PreferencesPatchResult {
  const tx = db.transaction((baseRevision: number): PreferencesPatchResult => {
    const read = readSnapshotRow();
    if (read.state === "corrupt") throw read.error;
    const current = read.state === "absent" ? defaultSnapshot() : read.snapshot;
    if (current.revision !== baseRevision) {
      return { conflict: true, revision: current.revision, snapshot: current };
    }
    const fromIndex = current.sharedTabs.findIndex((t) => t.ref === input.conversationId);
    if (fromIndex < 0) return { conflict: false, snapshot: current };
    const toIndex = Math.max(0, Math.min(input.toIndex, current.sharedTabs.length - 1));
    if (fromIndex === toIndex) return { conflict: false, snapshot: current };
    const sharedTabs = current.sharedTabs.slice();
    const [moved] = sharedTabs.splice(fromIndex, 1);
    if (!moved) return { conflict: false, snapshot: current };
    sharedTabs.splice(toIndex, 0, moved);
    const next: WorkspacePreferencesSnapshot = {
      revision: current.revision + 1,
      sharedTabs,
      preferences: current.preferences,
    };
    return commitSnapshot(next);
  });
  const result = tx(input.baseRevision);
  return emitAfterCommit(result, ["sharedTabs"], input.originWindowId, input.baseRevision);
}

export const workspacePreferencesService = {
  get: getWorkspacePreferences,
  patch: patchWorkspacePreferences,
  subscribe: subscribePreferencesChanges,
  openTab: openSharedTab,
  closeTab: closeSharedTab,
  closeTabsBatch: closeSharedTabsBatch,
  reorderTab: reorderSharedTab,
};
