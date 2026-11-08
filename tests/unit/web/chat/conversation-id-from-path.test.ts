/**
 * Phase 5 — chatTabs.ts: path→id extraction via per-prefix ROUTES constants.
 *
 * Tests 21–22 from tests/test-prompts-phase5.md.
 *
 * `conversationIdFromPath` and `routeStillReferencesRef` were rewritten to
 * build their prefix from the `ROUTES` constants, so the path rules live in
 * the same place as the route definitions. These tests pin the extraction
 * behaviour on both engine surfaces.
 */
import { describe, it, expect } from "bun:test";
import { conversationIdFromPath, routeStillReferencesRef } from "@web/features/chat/state/chatTabs";

describe("Test 21 — conversationIdFromPath extracts per prefix", () => {
  it("returns the id for a /chat/<id> path", () => {
    expect(conversationIdFromPath("/chat/t1")).toBe("t1");
  });

  it("returns the id for a /code/<id> path", () => {
    expect(conversationIdFromPath("/code/a1")).toBe("a1");
  });

  it("returns null for an empty id immediately after the prefix", () => {
    expect(conversationIdFromPath("/chat/")).toBeNull();
    expect(conversationIdFromPath("/code/")).toBeNull();
  });

  it("returns null for non-conversation routes", () => {
    expect(conversationIdFromPath("/scheduler")).toBeNull();
    expect(conversationIdFromPath("/providers")).toBeNull();
  });

  it("returns null when the prefix has no trailing slash + id", () => {
    expect(conversationIdFromPath("/chat")).toBeNull();
    expect(conversationIdFromPath("/code")).toBeNull();
  });
});

describe("Test 22 — routeStillReferencesRef matches chat and code routes", () => {
  it("is true while the route names the ref on either surface", () => {
    expect(routeStillReferencesRef("/chat/t1", "t1")).toBe(true);
    expect(routeStillReferencesRef("/code/a1", "a1")).toBe(true);
  });

  it("is false once the route no longer names the ref", () => {
    expect(routeStillReferencesRef("/chat/t1", "t2")).toBe(false);
    expect(routeStillReferencesRef("/scheduler", "t1")).toBe(false);
  });

  it("is exact-match: a deeper path never counts", () => {
    // The guard compares the whole pathname; a sub-route is a different location.
    expect(routeStillReferencesRef("/chat/t1/extra", "t1")).toBe(false);
  });
});
