/**
 * Route path constants, typed URL builders, and path-segment parsing.
 *
 * Core routing contracts are separated from UI navigation configuration (navigation.ts).
 * Components, router, and tab state consume these contracts as the single source
 * of truth for application URLs.
 */

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
   */
  parseConversationId: (pathname: string): string | null => {
    const chatPrefix = `${ROUTES.CHAT}/`;
    if (pathname.startsWith(chatPrefix)) {
      const raw = pathname.slice(chatPrefix.length);
      return raw ? decodeURIComponent(raw) : null;
    }
    const codePrefix = `${ROUTES.CODE}/`;
    if (pathname.startsWith(codePrefix)) {
      const raw = pathname.slice(codePrefix.length);
      return raw ? decodeURIComponent(raw) : null;
    }
    return null;
  },
} as const;
