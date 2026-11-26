/**
 * Canonical tab-key validation at the chatTabs boundary.
 *
 * Every workspace consumer treats `parseTabKey(...) === null` as "ignore".
 * An empty ref must therefore be rejected here, not passed downstream where
 * it would silently open no panel or alias the wrong conversation.
 */
import { describe, it, expect } from "bun:test";
import { agentKey, chatKey, parseTabKey } from "@web/features/chat/state/chatTabs";

describe("parseTabKey — canonical key validation", () => {
  it("accepts a chat key with a non-empty ref", () => {
    expect(parseTabKey(chatKey("abc123"))).toEqual({ kind: "chat", ref: "abc123" });
  });

  it("accepts an agent key with a non-empty ref", () => {
    expect(parseTabKey(agentKey("abc123"))).toEqual({ kind: "agent", ref: "abc123" });
  });

  it("rejects an empty chat ref", () => {
    expect(parseTabKey("chat:")).toBeNull();
  });

  it("rejects an empty agent ref", () => {
    expect(parseTabKey("agent:")).toBeNull();
  });

  it("rejects a non-canonical key", () => {
    expect(parseTabKey("other:abc")).toBeNull();
  });
});
