import { Circle, Search, Plug, ScrollText, Clock, MessageSquare, Palette, FolderCog, Server, Monitor, Settings, type LucideIcon } from "lucide-react";

/**
 * Single source of truth for application navigation and branding.
 * Components (Sidebar, App shell) consume this config — they must not contain
 * hardcoded navigation definitions (labels, icons, ordering, visibility, etc.).
 * Add, remove, reorder, hide, rename, or flag a navigation item here only.
 *
 * Each item maps to exactly one route (see web/src/app/router.tsx).
 * Route <-> nav correspondence is 1:1; the router owns pages, this config
 * owns how pages appear in navigation.
 */

export type ViewId =
  | "chat"
  | "settings"
  | "memories"
  | "search"
  | "mcp"
  | "logs"
  | "scheduler"
  | "workspace"
  | "providers"
  | "appearance"
  | "desktop";

export interface NavItem {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Route the app shell switches to when this item is activated. */
  view: ViewId;
  /** Optional badge text rendered next to the label. */
  badge?: string;
  /** Hash-router route for this item (single source of truth for links). */
  route: string;
  /** One-line description for dashboard cards and settings index. */
  description?: string;
  /** Whether the item is rendered. Gated by a feature flag where appropriate. */
  visible: boolean;
  /**
   * Whether the item renders on the icon rail. Settings areas live in the
   * dedicated settings surface (single rail gear) — never as rail icons.
   * Defaults to true; set false for settings-area items.
   */
  railVisible?: boolean;
  /** Sort order (ascending) within the navigation group. */
  order: number;
  /** Optional nested navigation items. */
  children?: NavItem[];
}

export interface AppConfig {
  branding: {
    appName: string;
    logoText: string;
  };
  /**
   * Fallback route for generic "Settings" entry points (corner chrome,
   * page menu). There is no settings-index page; this picks the settings
   * area that opens instead. Change here only.
   */
  settingsIndexRoute: string;
  features: {
    /** When false, the Search navigation item is hidden. */
    search: boolean;
  };
  /** Bottom navigation items (Settings / Memory / Search ...). */
  nav: NavItem[];
}

const features = {
  search: false,
};

/** Fallback settings route (no settings-index page exists). */
const SETTINGS_INDEX_ROUTE = "/providers";

export const appConfig: AppConfig = {
  branding: {
    appName: "TBAi",
    logoText: "T",
  },
  settingsIndexRoute: SETTINGS_INDEX_ROUTE,
  features,
  nav: [
    {
      id: "chat",
      label: "Chat",
      icon: MessageSquare,
      view: "chat",
      route: "/chat",
      description: "Conversations with any provider",
      visible: true,
      order: 1,
    },
    {
      id: "providers",
      label: "Providers",
      icon: Server,
      view: "providers",
      route: "/providers",
      description: "Models, endpoints, API keys",
      visible: true,
      railVisible: false,
      order: 2,
    },
    {
      id: "appearance",
      label: "Appearance",
      icon: Palette,
      view: "appearance",
      route: "/appearance",
      description: "Theme and display",
      visible: true,
      railVisible: false,
      order: 3,
    },
    {
      id: "workspace",
      label: "Workspace",
      icon: FolderCog,
      view: "workspace",
      route: "/workspace",
      description: "Working folder and tools",
      visible: true,
      railVisible: false,
      order: 4,
    },
    {
      id: "desktop",
      label: "Desktop",
      icon: Monitor,
      view: "desktop",
      route: "/desktop",
      description: "Window layout and desktop options",
      visible: true,
      railVisible: false,
      order: 5,
    },
    {
      id: "memories",
      label: "Memory",
      icon: Circle,
      view: "memories",
      route: "/memory",
      description: "Long-term memories",
      visible: true,
      railVisible: false,
      order: 6,
    },
    {
      id: "search",
      label: "Search",
      icon: Search,
      view: "search",
      route: "/memory",
      visible: features.search,
      order: 7,
    },
    {
      id: "mcp",
      label: "MCP",
      icon: Plug,
      view: "mcp",
      route: "/mcp",
      description: "External model tools",
      visible: true,
      railVisible: false,
      order: 8,
    },
    {
      id: "scheduler",
      label: "Scheduler",
      icon: Clock,
      view: "scheduler",
      route: "/scheduler",
      description: "Automated scheduled runs",
      visible: true,
      order: 9,
    },
    {
      id: "logs",
      label: "Logs",
      icon: ScrollText,
      view: "logs",
      route: "/logs",
      description: "Application logs",
      visible: true,
      railVisible: false,
      order: 10,
    },
    {
      id: "settings",
      label: "Settings",
      icon: Settings,
      view: "settings",
      route: SETTINGS_INDEX_ROUTE,
      description: "All settings in one place",
      visible: true,
      order: 11,
    },
  ],
};

/** Nav items that should actually render, sorted by `order`. */
export function getVisibleNav(): NavItem[] {
  return appConfig.nav
    .filter((item) => item.visible)
    .sort((a, b) => a.order - b.order);
}

/** Rail icons: visible items not opted out (settings areas live behind the single gear). */
export function getRailNav(): NavItem[] {
  return getVisibleNav().filter((item) => item.railVisible !== false);
}

/** Views that belong to the settings area (sub-sidebar source of truth). */
const SETTINGS_VIEWS: ViewId[] = [
  "providers",
  "appearance",
  "workspace",
  "desktop",
  "mcp",
  "memories",
  "logs",
];

/** Settings-area entries for the settings sub-sidebar, sorted by `order`. */
export function getSettingsNav(): NavItem[] {
  return appConfig.nav
    .filter((item) => item.visible && SETTINGS_VIEWS.includes(item.view))
    .sort((a, b) => a.order - b.order);
}

/** Nav item by id (labels/routes for strips and titles — never literals). */
export function getNavItem(id: string): NavItem | undefined {
  return appConfig.nav.find((item) => item.id === id);
}
