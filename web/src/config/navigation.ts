import { Circle, Search, Plug, ScrollText, Clock, MessageSquare, Palette, FolderCog, Server, Monitor, type LucideIcon } from "lucide-react";

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
  /** Sort order (ascending) within the navigation group. */
  order: number;
  /** Optional nested navigation items. */
  children?: NavItem[];
}

export interface AppConfig {
  branding: {
    appName: string;
    logoText: string;
    newWorkspaceLabel: string;
    historyLabel: string;
  };
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

export const appConfig: AppConfig = {
  branding: {
    appName: "TBAi",
    logoText: "T",
    newWorkspaceLabel: "New Workspace",
    historyLabel: "History",
  },
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
      order: 10,
    },
  ],
};

/** Nav items that should actually render, sorted by `order`. */
export function getVisibleNav(): NavItem[] {
  return appConfig.nav
    .filter((item) => item.visible)
    .sort((a, b) => a.order - b.order);
}

/** Views that belong to the settings area (sub-sidebar source of truth). */
const SETTINGS_VIEWS: ViewId[] = [
  "providers",
  "appearance",
  "workspace",
  "desktop",
  "mcp",
  "scheduler",
  "memories",
  "logs",
];

/** Settings-area entries for the settings sub-sidebar, sorted by `order`. */
export function getSettingsNav(): NavItem[] {
  return appConfig.nav
    .filter((item) => item.visible && SETTINGS_VIEWS.includes(item.view))
    .sort((a, b) => a.order - b.order);
}
