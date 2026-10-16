/**
 * Route path constants, typed URL builders, and path-segment parsing.
 *
 * Core routing contracts are separated from UI navigation configuration (navigation.ts).
 * Components, router, and tab state consume these contracts as the single source
 * of truth for application URLs.
 */

export const ROUTE_PATTERNS = {
  INDEX: "/",
  CHAT: "chat/:threadId?",
  CODE: "code/:agentId?",
  SCHEDULER: "scheduler",
  ARCHIVED: "archived",
  FOLDERS: "folders",
  MEMORY: "memory",
  MCP: "mcp",
  LOGS: "logs",
  QUICK_MESSAGES: "quick-messages",
  PROVIDERS: "providers",
  APPEARANCE: "appearance",
  DESKTOP: "desktop",
  WORKSPACE: "workspace",
  OPENCODE_CONFIG: "opencode-config",
  THEME_LAB: "/theme-lab",
  KEYBOARD_LAB: "/keyboard-lab",
  CATCH_ALL: "*",
} as const;

export const ROUTES = {
  INDEX: "/",
  CHAT: "/chat",
  CHAT_NEW: "/chat/new",
  CODE: "/code",
  SCHEDULER: "/scheduler",
  ARCHIVED: "/archived",
  FOLDERS: "/folders",
  SETTINGS: {
    ROOT: "/providers", // Default fallback settings entry point
    PROVIDERS: "/providers",
    APPEARANCE: "/appearance",
    WORKSPACE: "/workspace",
    OPENCODE: "/opencode-config",
    DESKTOP: "/desktop",
    MEMORY: "/memory",
    MCP: "/mcp",
    LOGS: "/logs",
    FOLDERS: "/folders",
    QUICK_MESSAGES: "/quick-messages",
  },

  /**
   * Safe URL builder for a chat thread. Normalizes empty, undefined, or 'new' to CHAT_NEW.
   */
  chat: (threadId?: string | null): string => {
    if (!threadId || threadId === "new") return ROUTES.CHAT_NEW;
    return `${ROUTES.CHAT}/${encodeURIComponent(threadId)}`;
  },

  /**
   * Safe URL builder for an OpenCode Code session. Strictly requires a non-empty agentId.
   * Code draft URLs are engine-agnostic and must route through the chat draft.
   */
  code: (agentId: string): string => {
    const trimmed = typeof agentId === "string" ? agentId.trim() : "";
    if (!trimmed) {
      throw new Error("ROUTES.code requires a valid agentId; Code draft URLs are not supported.");
    }
    return `${ROUTES.CODE}/${encodeURIComponent(trimmed)}`;
  },

  /**
   * Safe conversation ID parser for both Chat and Code surfaces.
   * Inverse of ROUTES.chat and ROUTES.code, safely decoding path segments.
   *
   * Rules:
   * - /chat/new is the fresh draft route and returns null.
   * - Valid Chat and Code paths must decode exactly one encoded path segment.
   * - Empty suffixes, extra raw path segments, malformed percent encoding,
   *   and non-conversation paths return null without throwing.
   */
  parseConversationId: (pathname: string): string | null => {
    const chatPrefix = `${ROUTES.CHAT}/`;
    if (pathname.startsWith(chatPrefix)) {
      const raw = pathname.slice(chatPrefix.length);
      if (!raw || raw.includes("/")) return null;
      try {
        const decoded = decodeURIComponent(raw);
        return decoded === "new" || decoded.length === 0 ? null : decoded;
      } catch {
        return null;
      }
    }
    const codePrefix = `${ROUTES.CODE}/`;
    if (pathname.startsWith(codePrefix)) {
      const raw = pathname.slice(codePrefix.length);
      if (!raw || raw.includes("/")) return null;
      try {
        const decoded = decodeURIComponent(raw);
        return decoded.length === 0 ? null : decoded;
      } catch {
        return null;
      }
    }
    return null;
  },
} as const;
