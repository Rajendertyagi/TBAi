import { describe, expect, it } from "bun:test";
import { ROUTE_PATTERNS, ROUTES } from "@web/config/routes.ts";

describe("ROUTES contract and URL builders", () => {
  it("normalizes chat draft routes to CHAT_NEW", () => {
    expect(ROUTES.chat()).toBe(ROUTES.CHAT_NEW);
    expect(ROUTES.chat(undefined)).toBe(ROUTES.CHAT_NEW);
    expect(ROUTES.chat(null)).toBe(ROUTES.CHAT_NEW);
    expect(ROUTES.chat("")).toBe(ROUTES.CHAT_NEW);
    expect(ROUTES.chat("new")).toBe(ROUTES.CHAT_NEW);
  });

  it("builds parameterized chat thread routes safely", () => {
    expect(ROUTES.chat("conv-123")).toBe("/chat/conv-123");
    expect(ROUTES.chat("test:folder/item")).toBe("/chat/test%3Afolder%2Fitem");
  });

  it("builds parameterized code routes and strictly requires agentId", () => {
    expect(ROUTES.code("agent-abc")).toBe("/code/agent-abc");
    expect(ROUTES.code("test:special/agent")).toBe("/code/test%3Aspecial%2Fagent");
    expect(() => ROUTES.code("")).toThrow("ROUTES.code requires a valid agentId");
    expect(() => ROUTES.code("   ")).toThrow("ROUTES.code requires a valid agentId");
  });

  it("parses conversation IDs from pathname and decodes segments", () => {
    expect(ROUTES.parseConversationId("/chat/conv-123")).toBe("conv-123");
    expect(ROUTES.parseConversationId("/chat/test%3Afolder%2Fitem")).toBe("test:folder/item");
    expect(ROUTES.parseConversationId("/code/agent-abc")).toBe("agent-abc");
    expect(ROUTES.parseConversationId("/code/test%3Aspecial%2Fagent")).toBe("test:special/agent");

    // Non-conversation routes or empty suffixes
    expect(ROUTES.parseConversationId("/chat/")).toBeNull();
    expect(ROUTES.parseConversationId("/code/")).toBeNull();
    expect(ROUTES.parseConversationId("/providers")).toBeNull();
    expect(ROUTES.parseConversationId("/scheduler")).toBeNull();
    expect(ROUTES.parseConversationId("/")).toBeNull();
    expect(ROUTES.parseConversationId("/chat")).toBeNull();
    expect(ROUTES.parseConversationId("/code")).toBeNull();
  });

  it("treats /chat/new as the fresh draft route and returns null", () => {
    expect(ROUTES.parseConversationId("/chat/new")).toBeNull();
    expect(ROUTES.parseConversationId("/chat/%6E%65%77")).toBeNull();
    expect(ROUTES.parseConversationId("/chat/new/")).toBeNull();
  });

  it("safely handles malformed percent encoding without throwing", () => {
    expect(ROUTES.parseConversationId("/chat/%E0%A4%A")).toBeNull();
    expect(ROUTES.parseConversationId("/code/%E0%A4%A")).toBeNull();
    expect(ROUTES.parseConversationId("/chat/%")).toBeNull();
    expect(ROUTES.parseConversationId("/chat/%2")).toBeNull();
    expect(ROUTES.parseConversationId("/code/%99%ZZ")).toBeNull();
  });

  it("rejects extra raw path segments", () => {
    expect(ROUTES.parseConversationId("/chat/conv-123/extra")).toBeNull();
    expect(ROUTES.parseConversationId("/code/agent-abc/extra")).toBeNull();
    expect(ROUTES.parseConversationId("/chat/conv-123/sub/path")).toBeNull();
  });

  it("round-trips encode and decode including encoded slashes", () => {
    const ids = [
      "conv-1",
      "user:session-42",
      "path/with/slashes",
      "symbols_!~*()",
      "deep/nested/path/name",
    ];
    for (const id of ids) {
      expect(ROUTES.parseConversationId(ROUTES.chat(id))).toBe(id);
      expect(ROUTES.parseConversationId(ROUTES.code(id))).toBe(id);
    }
  });

  it("defines centralized ROUTE_PATTERNS constants", () => {
    expect(ROUTE_PATTERNS.INDEX).toBe("/");
    expect(ROUTE_PATTERNS.CHAT).toBe("chat/:threadId?");
    expect(ROUTE_PATTERNS.CODE).toBe("code/:agentId?");
    expect(ROUTE_PATTERNS.SCHEDULER).toBe("scheduler");
    expect(ROUTE_PATTERNS.ARCHIVED).toBe("archived");
    expect(ROUTE_PATTERNS.PROVIDERS).toBe("providers");
    expect(ROUTE_PATTERNS.CATCH_ALL).toBe("*");
  });

  it("defines standard application routes", () => {
    expect(ROUTES.INDEX).toBe("/");
    expect(ROUTES.CHAT).toBe("/chat");
    expect(ROUTES.CHAT_NEW).toBe("/chat/new");
    expect(ROUTES.CODE).toBe("/code");
    expect(ROUTES.SCHEDULER).toBe("/scheduler");
    expect(ROUTES.ARCHIVED).toBe("/archived");
    expect(ROUTES.FOLDERS).toBe("/folders");
    expect(ROUTES.SETTINGS.PROVIDERS).toBe("/providers");
    expect(ROUTES.SETTINGS.APPEARANCE).toBe("/appearance");
    expect(ROUTES.SETTINGS.WORKSPACE).toBe("/workspace");
    expect(ROUTES.SETTINGS.OPENCODE).toBe("/opencode-config");
    expect(ROUTES.SETTINGS.DESKTOP).toBe("/desktop");
    expect(ROUTES.SETTINGS.MEMORY).toBe("/memory");
    expect(ROUTES.SETTINGS.MCP).toBe("/mcp");
    expect(ROUTES.SETTINGS.LOGS).toBe("/logs");
    expect(ROUTES.SETTINGS.FOLDERS).toBe("/folders");
    expect(ROUTES.SETTINGS.QUICK_MESSAGES).toBe("/quick-messages");
  });
});
