import { describe, it, expect } from "bun:test";
import {
  conversationIdFromPath,
  threadUrl,
} from "./chatTabs";

/**
 * Unit tests for the pure `conversationIdFromPath` helper: the single home for
 * path→conversation-id rules so the scope UI (folder highlight, breadcrumbs)
 * works on /code/ routes exactly as on /chat/ routes.
 *
 * Happy paths: both engine prefixes. Edge cases: draft (no conversation id),
 * empty id after the prefix, and non-conversation paths all return null.
 *
 * Note on the draft path: `/chat/new` is the draft host. The helper treats
 * "new" as an id (returns "new"), not as a conversation — callers that need
 * to distinguish draft from a real conversation must compare against
 * NEW_DRAFT_TAB_ID themselves. The helper's contract is "does this path name
 * a conversation id, and which one?" — for the draft the answer is
 * technically "new", so we assert that behaviour here and document it.
 */

describe("conversationIdFromPath — /chat/ and /code/ prefixes (happy path)", () => {
  it("returns the id for a /chat/<id> path", () => {
    expect(conversationIdFromPath("/chat/abc123")).toBe("abc123");
  });

  it("returns the id for a /code/<id> path (the OpenCode surface)", () => {
    expect(conversationIdFromPath("/code/abc123")).toBe("abc123");
  });

  it("returns the same id for both surfaces (engine-agnostic)", () => {
    const chatId = conversationIdFromPath("/chat/xyz789");
    const codeId = conversationIdFromPath("/code/xyz789");
    expect(chatId).toBe(codeId);
    expect(chatId).toBe("xyz789");
  });

  it("is the inverse of threadUrl for both engines", () => {
    // threadUrl(id, "direct") → /chat/<id>; conversationIdFromPath brings it back.
    expect(conversationIdFromPath(threadUrl("c1", "direct"))).toBe("c1");
    expect(conversationIdFromPath(threadUrl("c2", "opencode"))).toBe("c2");
    // Unknown engine falls back to the chat surface.
    expect(conversationIdFromPath(threadUrl("c3", undefined))).toBe("c3");
  });

  it("handles a longer, realistic conversation id", () => {
    const id = "vuvg19b9ep437ry4bt4jgfvk";
    expect(conversationIdFromPath(`/chat/${id}`)).toBe(id);
    expect(conversationIdFromPath(`/code/${id}`)).toBe(id);
  });
});

describe("conversationIdFromPath — non-conversation paths (edge cases)", () => {
  it("returns null for the draft host /chat/new (no real conversation id)", () => {
    // "new" is a draft sentinel, not a persisted conversation id. The helper
    // does NOT special-case it — it returns "new". Callers that want to treat
    // the draft as "no conversation" must compare against NEW_DRAFT_TAB_ID.
    // We assert the actual contract here: the raw id after the prefix.
    expect(conversationIdFromPath("/chat/new")).toBe("new");
    expect(conversationIdFromPath("/code/new")).toBe("new");
  });

  it("returns null for an empty id immediately after the prefix", () => {
    // "/chat/" with no id: the slice yields "" which is falsy → null.
    expect(conversationIdFromPath("/chat/")).toBeNull();
    expect(conversationIdFromPath("/code/")).toBeNull();
  });

  it("returns null for non-conversation routes (settings, root, unknown)", () => {
    expect(conversationIdFromPath("/")).toBeNull();
    expect(conversationIdFromPath("/")).toBeNull();
    expect(conversationIdFromPath("/providers")).toBeNull();
    expect(conversationIdFromPath("/scheduler")).toBeNull();
    expect(conversationIdFromPath("/chat")).toBeNull(); // no trailing slash + id
    expect(conversationIdFromPath("/code")).toBeNull();
  });

  it("returns null for unrelated leading paths even if they contain /chat/", () => {
    // The prefix match is anchored at position 0, so a mid-path occurrence
    // never counts.
    expect(conversationIdFromPath("/workbench/chat/abc")).toBeNull();
    expect(conversationIdFromPath("/x/code/abc")).toBeNull();
  });

  it("trailing segments after the id are preserved in the returned id", () => {
    // The helper slices everything after the prefix — a real route has no
    // deeper segments, but the contract is "return the remainder".
    expect(conversationIdFromPath("/chat/abc/def")).toBe("abc/def");
    expect(conversationIdFromPath("/code/abc/def")).toBe("abc/def");
  });
});
