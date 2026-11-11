import { z } from "zod";
import type { PortablePreferences, SharedTabRef, WorkspacePreferencesSnapshot } from "./types";
import { WorkspacePreferencesCorruptError } from "./types";

/** Reserved app_settings namespace for workspace preferences. */
export const WORKSPACE_PREFERENCES_NAMESPACE = "workspace.preferences.";
export const WORKSPACE_PREFERENCES_SNAPSHOT_KEY = "workspace.preferences.snapshot";

/** Sidebar section IDs (must match web/src/config/sidebar.ts). */
export const SIDEBAR_SECTION_IDS = ["folders", "chats"] as const;
export type SidebarSectionId = (typeof SIDEBAR_SECTION_IDS)[number];
export const DEFAULT_SECTION_ORDER: readonly SidebarSectionId[] = SIDEBAR_SECTION_IDS;

const sharedTabRefSchema = z
  .object({
    kind: z.enum(["chat", "agent"]),
    ref: z.string().min(1).max(200),
  })
  .strict();

/** Read-time normalization for in-flight/WIP snapshot shapes (obsolete field names ignored/normalized). */
function normalizeSharedTabEntry(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const obj = raw as Record<string, unknown>;
  // Legacy WIP shape used `conversationId`; canonical is `ref`. Normalize on read only.
  if (typeof obj.ref !== "string" && typeof obj.conversationId === "string") {
    const { conversationId, ...rest } = obj;
    return { ...rest, ref: conversationId };
  }
  return raw;
}

const appearanceSchema = z
  .object({
    themeMode: z.enum(["light", "dark", "system"]).default("system"),
    lightTheme: z.string().min(1).max(120).default("default"),
    darkTheme: z.string().min(1).max(120).default("default"),
    typography: z.string().min(1).max(20000).default("default"),
  })
  .strict();

/**
 * Strict sectionOrder normalization (canonical, must match frontend semantics).
 * - missing/undefined/null/[] => effective default order ["folders","chats"] (stored as [] in defaults)
 * - array of valid known section ID strings => dedupe (first occurrence), append missing known IDs in default order
 * - non-array / invalid element types / unknown section IDs => corruption/validation error
 */
export function normalizeSectionOrderStrict(value: unknown): string[] {
  if (value === undefined || value === null) return [...DEFAULT_SECTION_ORDER];
  if (!Array.isArray(value)) {
    throw new WorkspacePreferencesCorruptError("desktop.sectionOrder must be an array");
  }
  if (value.length === 0) return [...DEFAULT_SECTION_ORDER];
  const known = new Set<string>(SIDEBAR_SECTION_IDS);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new WorkspacePreferencesCorruptError("desktop.sectionOrder elements must be strings");
    }
    if (!known.has(entry)) {
      throw new WorkspacePreferencesCorruptError(
        `desktop.sectionOrder contains unknown section id: ${entry}`,
      );
    }
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  for (const id of SIDEBAR_SECTION_IDS) {
    if (!seen.has(id)) out.push(id);
  }
  return out;
}

const desktopBaseSchema = z
  .object({
    sidebarVisible: z.boolean().default(true),
    statusBarVisible: z.boolean().default(true),
    chatWidth: z.enum(["narrow", "comfortable", "wide"]).default("comfortable"),
    sidebarSort: z.enum(["updated", "created"]).default("updated"),
    sectionOrder: z.unknown().optional(),
    sectionCollapsed: z.record(z.string().min(1).max(120), z.boolean()).default({}),
    showCompleted: z.boolean().default(false),
    spellCheck: z.boolean().default(true),
  })
  .strict();

const welcomeSchema = z
  .object({
    engine: z.enum(["direct", "opencode"]).default("direct"),
    quickActionTab: z.string().min(1).max(120).default("coding"),
    scopeMode: z.enum(["simple", "project"]).default("simple"),
    folderId: z.string().min(1).max(200).nullable().default(null),
  })
  .strict();

const navigationSchema = z
  .object({
    selectedFolderId: z.string().min(1).max(200).nullable().default(null),
    folderExpanded: z.record(z.string().min(1).max(200), z.boolean()).default({}),
  })
  .strict();

function parseDesktop(raw: unknown): PortablePreferences["desktop"] {
  const parsed = desktopBaseSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new WorkspacePreferencesCorruptError("desktop preferences are invalid");
  }
  const sectionOrder = normalizeSectionOrderStrict(parsed.data.sectionOrder);
  return {
    sidebarVisible: parsed.data.sidebarVisible,
    statusBarVisible: parsed.data.statusBarVisible,
    chatWidth: parsed.data.chatWidth,
    sidebarSort: parsed.data.sidebarSort,
    sectionOrder,
    sectionCollapsed: parsed.data.sectionCollapsed,
    showCompleted: parsed.data.showCompleted,
    spellCheck: parsed.data.spellCheck,
  };
}

function requireGroupObject(
  obj: Record<string, unknown>,
  key: "appearance" | "desktop" | "welcome" | "navigation",
): unknown {
  if (!Object.hasOwn(obj, key) || obj[key] === undefined) return {};
  if (obj[key] === null) {
    throw new WorkspacePreferencesCorruptError(`preferences.${key} must not be null`);
  }
  return obj[key];
}

export function parsePortablePreferences(raw: unknown): PortablePreferences {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new WorkspacePreferencesCorruptError("preferences must be an object");
  }
  const obj = raw as Record<string, unknown>;
  // Ignore obsolete legacy fields (e.g. migration) by not reading them; strict on active canonical fields.
  // Missing/undefined groups use defaults; explicit null is corrupt.
  const appearance = appearanceSchema.safeParse(requireGroupObject(obj, "appearance"));
  if (!appearance.success)
    throw new WorkspacePreferencesCorruptError("appearance preferences are invalid");
  const welcome = welcomeSchema.safeParse(requireGroupObject(obj, "welcome"));
  if (!welcome.success)
    throw new WorkspacePreferencesCorruptError("welcome preferences are invalid");
  const navigation = navigationSchema.safeParse(requireGroupObject(obj, "navigation"));
  if (!navigation.success)
    throw new WorkspacePreferencesCorruptError("navigation preferences are invalid");
  const desktop = parseDesktop(requireGroupObject(obj, "desktop"));
  return {
    appearance: appearance.data,
    desktop,
    welcome: welcome.data,
    navigation: navigation.data,
  };
}

export function defaultPortablePreferences(): PortablePreferences {
  return {
    appearance: appearanceSchema.parse({}),
    desktop: {
      sidebarVisible: true,
      statusBarVisible: true,
      chatWidth: "comfortable",
      sidebarSort: "updated",
      sectionOrder: [],
      sectionCollapsed: {},
      showCompleted: false,
      spellCheck: true,
    },
    welcome: welcomeSchema.parse({}),
    navigation: navigationSchema.parse({}),
  };
}

export function defaultSnapshot(): WorkspacePreferencesSnapshot {
  return {
    revision: 0,
    sharedTabs: [],
    preferences: defaultPortablePreferences(),
  };
}

/**
 * Parses a stored snapshot row. Throws WorkspacePreferencesCorruptError for
 * malformed JSON structure or invalid active canonical fields. Obsolete legacy
 * fields are ignored (no behavior restore).
 */
export function parseStoredSnapshot(raw: unknown): WorkspacePreferencesSnapshot {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new WorkspacePreferencesCorruptError("snapshot must be an object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.revision !== "number" || !Number.isInteger(obj.revision) || obj.revision < 0) {
    throw new WorkspacePreferencesCorruptError("snapshot.revision is invalid");
  }
  const tabsRaw = obj.sharedTabs;
  if (!Array.isArray(tabsRaw)) {
    throw new WorkspacePreferencesCorruptError("snapshot.sharedTabs must be an array");
  }
  const sharedTabs: SharedTabRef[] = [];
  for (const t of tabsRaw) {
    const parsed = sharedTabRefSchema.safeParse(normalizeSharedTabEntry(t));
    if (!parsed.success) {
      throw new WorkspacePreferencesCorruptError("snapshot.sharedTabs contains an invalid entry");
    }
    sharedTabs.push(parsed.data);
  }
  if (Object.hasOwn(obj, "preferences") && obj.preferences === null) {
    throw new WorkspacePreferencesCorruptError("snapshot.preferences must not be null");
  }
  const preferences = parsePortablePreferences(
    Object.hasOwn(obj, "preferences") && obj.preferences !== undefined ? obj.preferences : {},
  );
  return {
    revision: obj.revision,
    sharedTabs,
    preferences,
  };
}

/** Leaf-field merge for allowlisted portable preference groups. Omitted fields unchanged. */
export function mergePortablePreferences(
  current: PortablePreferences,
  patch: {
    appearance?: Partial<PortablePreferences["appearance"]>;
    desktop?: Partial<PortablePreferences["desktop"]>;
    welcome?: Partial<PortablePreferences["welcome"]>;
    navigation?: Partial<PortablePreferences["navigation"]>;
  },
): PortablePreferences {
  const merged = {
    appearance: { ...current.appearance, ...(patch.appearance ?? {}) },
    desktop: { ...current.desktop, ...(patch.desktop ?? {}) },
    welcome: { ...current.welcome, ...(patch.welcome ?? {}) },
    navigation: { ...current.navigation, ...(patch.navigation ?? {}) },
  };
  // Re-validate/normalize (sectionOrder strictness applies).
  return parsePortablePreferences(merged);
}

export function isReservedWorkspaceKey(key: string): boolean {
  return key.startsWith(WORKSPACE_PREFERENCES_NAMESPACE);
}
