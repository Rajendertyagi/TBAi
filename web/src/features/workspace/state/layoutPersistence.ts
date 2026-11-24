/**
 * Versioned, device-local Dockview layout persistence.
 *
 * Wraps `api.toJSON()` in a versioned envelope and validates/migrates on read.
 * Only IDENTITY + SPATIAL state is stored (panel ids, params, split sizes, group
 * structure, active group). Message content, composer drafts, credentials and
 * absolute paths are never written here. Corrupt or incompatible records fall
 * back to a safe default (null → caller registers canonical panels fresh).
 *
 * Same convention as `composerDraft.ts` / `pendingFirstMessage.ts`: plain
 * localStorage helpers, no new persistence framework, no Zustand store.
 */
import type { SerializedDockview } from "dockview-react";
import { parsePanelParams } from "../dockviewParams";
import { desiredPanelKeys } from "../panelRegistry";

export const DOCKVIEW_LAYOUT_STORAGE_KEY = "tbai:dockview-layout";
export const DOCKVIEW_LAYOUT_VERSION = 1;
/** Coalesce the burst of layout-change reasons into one write. */
export const DOCKVIEW_LAYOUT_PERSIST_DEBOUNCE_MS = 250;

export interface PersistedLayout {
  version: number;
  savedAt: number;
  layout: SerializedDockview;
}

/** Minimal storage surface so tests can inject a fake without a DOM. */
export interface LayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

type SerializedGrid = SerializedDockview["grid"]["root"];
interface GroupLeafState {
  views: string[];
  activeView?: string;
  id: string;
}

function keyFor(storageKey: string | undefined): string {
  return storageKey ?? DOCKVIEW_LAYOUT_STORAGE_KEY;
}

function defaultStorage(): LayoutStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** True for a canonical array index key (not "length", not a named property). */
function isArrayIndex(key: string): boolean {
  const n = Number(key);
  return Number.isInteger(n) && n >= 0 && String(n) === key && n < 2 ** 32 - 1;
}

/**
 * True when JSON.stringify would silently change or drop part of `value`.
 * Undefined object properties are the one allowed exception: Dockview's
 * toJSON() emits them and `normalizeLayout` strips them before the write.
 * Everything else that cannot survive a JSON round-trip is rejected so a
 * corrupt layout is never persisted.
 */
function hasLossyValue(value: unknown, ancestors: Set<object> = new Set()): boolean {
  if (value === undefined) return true;
  if (value === null) return false;
  switch (typeof value) {
    case "string":
    case "boolean":
      return false;
    case "number":
      return !Number.isFinite(value) || Object.is(value, -0);
    case "bigint":
    case "function":
    case "symbol":
      return true;
    case "object":
      break;
    default:
      return true;
  }
  const obj = value as object;
  if (ancestors.has(obj)) return true;
  ancestors.add(obj);
  try {
    if (!Array.isArray(obj) && !isPlainObject(obj)) return true;
    if (typeof (obj as { toJSON?: unknown }).toJSON === "function") return true;
    if (Array.isArray(obj)) {
      const arr: readonly unknown[] = obj;
      for (let i = 0; i < arr.length; i++) {
        if (hasLossyValue(arr[i], ancestors)) return true;
      }
      for (const key of Reflect.ownKeys(obj)) {
        if (key === "length") continue;
        if (typeof key === "symbol" || !isArrayIndex(key)) return true;
      }
      return false;
    }
    for (const key of Reflect.ownKeys(obj)) {
      if (typeof key === "symbol") return true;
      const child = obj[key];
      if (child === undefined) continue;
      if (hasLossyValue(child, ancestors)) return true;
    }
    return false;
  } finally {
    ancestors.delete(obj);
  }
}

/** Deep-copy a value, dropping only undefined object properties. */
function normalizeLayout(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeLayout);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue;
      out[key] = normalizeLayout(child);
    }
    return out;
  }
  return value;
}

function isSerializedDockview(value: unknown): value is SerializedDockview {
  if (!isPlainObject(value) || !isPlainObject(value.grid) || !isPlainObject(value.panels)) {
    return false;
  }
  for (const panel of Object.values(value.panels)) {
    if (!isPlainObject(panel)) return false;
    if (typeof panel.id !== "string" || typeof panel.contentComponent !== "string") return false;
    if (parsePanelParams(panel.params) === null) return false;
  }
  return true;
}

/** Migrate a parsed record to the current version, or null if incompatible. */
export function migrateLayout(raw: unknown): PersistedLayout | null {
  if (!isPlainObject(raw)) return null;
  if (raw.version === DOCKVIEW_LAYOUT_VERSION) {
    if (typeof raw.savedAt !== "number" || !isSerializedDockview(raw.layout)) return null;
    return { version: DOCKVIEW_LAYOUT_VERSION, savedAt: raw.savedAt, layout: raw.layout };
  }
  // v0: a bare SerializedDockview written before the envelope existed.
  if (raw.version === undefined && isSerializedDockview(raw)) {
    return { version: DOCKVIEW_LAYOUT_VERSION, savedAt: 0, layout: raw };
  }
  return null;
}

function pruneNode(node: SerializedGrid, allowed: ReadonlySet<string>): SerializedGrid | null {
  if (node.type === "branch") {
    const children = (node.data as SerializedGrid[])
      .map((child) => pruneNode(child, allowed))
      .filter((child): child is SerializedGrid => child !== null);
    return children.length === 0 ? null : { ...node, data: children };
  }
  const group = node.data as GroupLeafState;
  const views = group.views.filter((id) => allowed.has(id));
  const activeView =
    group.activeView && views.includes(group.activeView) ? group.activeView : views[0];
  return {
    ...node,
    data: { ...group, views, ...(activeView ? { activeView } : {}) },
  };
}

function collectGroupIds(node: SerializedGrid, out: Set<string>): void {
  if (node.type === "branch") {
    for (const child of node.data as SerializedGrid[]) collectGroupIds(child, out);
    return;
  }
  const group = node.data as GroupLeafState;
  if (typeof group.id === "string") out.add(group.id);
}

/**
 * Drop saved panel refs that are no longer canonical (deleted conversations),
 * prune their ids from the grid, and clear a stale active group. Returns null
 * when nothing survives, so the caller uses a safe default layout.
 *
 * Floating/popout/edge groups are intentionally dropped in V1: they can carry
 * absolute screen coordinates and refs that cannot be safely reconciled here.
 * The grid (splits + group structure + placement) and active selection survive.
 */
export function reconcileLayout(
  layout: SerializedDockview,
  allowedTabKeys: readonly string[],
): SerializedDockview | null {
  const allowed = new Set(desiredPanelKeys(allowedTabKeys));
  const panels: SerializedDockview["panels"] = {};
  for (const [id, panel] of Object.entries(layout.panels)) {
    const params = parsePanelParams(panel.params);
    if (!allowed.has(id) || !params || params.tabKey !== id) continue;
    panels[id] = panel;
  }
  if (Object.keys(panels).length === 0) return null;

  const root = pruneNode(layout.grid.root, allowed);
  if (!root) return null;

  const groupIds = new Set<string>();
  collectGroupIds(root, groupIds);
  const activeGroup =
    layout.activeGroup && groupIds.has(layout.activeGroup) ? layout.activeGroup : undefined;

  return {
    grid: { ...layout.grid, root },
    panels,
    ...(activeGroup ? { activeGroup } : {}),
  };
}

/** Persist a validated layout envelope. Never throws into the caller. */
export function saveLayout(
  layout: SerializedDockview,
  storageKey?: string,
  storage?: LayoutStorage,
): void {
  const target = storage ?? defaultStorage();
  if (!target) return;
  try {
    if (!isSerializedDockview(layout)) return;
    if (hasLossyValue(layout)) return;
    const normalized: unknown = normalizeLayout(layout);
    if (!isSerializedDockview(normalized)) return;
    const record: PersistedLayout = {
      version: DOCKVIEW_LAYOUT_VERSION,
      savedAt: Date.now(),
      layout: normalized,
    };
    target.setItem(keyFor(storageKey), JSON.stringify(record));
  } catch {
    /* storage full/blocked — layout stays memory-only for this session */
  }
}

/**
 * Load, migrate, validate and reconcile a saved layout. Returns null for any
 * missing/corrupt/incompatible record or when no panel survives reconciliation.
 */
export function loadLayout(
  storageKey: string | undefined,
  allowedTabKeys: readonly string[],
  storage?: LayoutStorage,
): SerializedDockview | null {
  const target = storage ?? defaultStorage();
  if (!target) return null;
  try {
    const rawText = target.getItem(keyFor(storageKey));
    if (!rawText) return null;
    const migrated = migrateLayout(JSON.parse(rawText) as unknown);
    if (!migrated) return null;
    return reconcileLayout(migrated.layout, allowedTabKeys);
  } catch {
    return null;
  }
}

/** Remove a saved layout (explicit reset). Never throws. */
export function clearLayout(storageKey?: string, storage?: LayoutStorage): void {
  const target = storage ?? defaultStorage();
  if (!target) return;
  try {
    target.removeItem(keyFor(storageKey));
  } catch {
    /* ignore */
  }
}
