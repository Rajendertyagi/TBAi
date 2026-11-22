/**
 * The TBAi ↔ Dockview params boundary. Dockview types params as `any`; these
 * guards prove the closed, serializable `{ tabKey, contentType }` contract is
 * enforced at our boundary so `toJSON()`/`fromJSON()` cannot be corrupted.
 */
import { describe, it, expect } from "bun:test";
import {
  componentForContentType,
  contentTypeForTabKey,
  createPanelParams,
  DIRECT_COMPONENT,
  isJsonSerializable,
  OPENCODE_COMPONENT,
  parsePanelParams,
} from "@web/features/workspace/dockviewParams";

describe("isJsonSerializable", () => {
  it("accepts plain JSON-safe values", () => {
    expect(isJsonSerializable({ a: 1, b: ["x", true, null] })).toBe(true);
    expect(isJsonSerializable("text")).toBe(true);
  });

  it("rejects values that break a JSON round-trip", () => {
    expect(isJsonSerializable(undefined)).toBe(false);
    expect(isJsonSerializable({ a: () => 1 })).toBe(false);
    expect(isJsonSerializable({ a: undefined })).toBe(false);
    expect(isJsonSerializable({ a: Number.NaN })).toBe(false);
    expect(isJsonSerializable({ a: new Date() })).toBe(false);
    expect(isJsonSerializable(Symbol("x"))).toBe(false);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(isJsonSerializable(cycle)).toBe(false);
  });
});

describe("contentTypeForTabKey / componentForContentType", () => {
  it("maps canonical keys to content types", () => {
    expect(contentTypeForTabKey("chat:abc")).toBe("direct");
    expect(contentTypeForTabKey("agent:xyz")).toBe("opencode");
    expect(contentTypeForTabKey("garbage")).toBeNull();
    expect(contentTypeForTabKey("chat:")).toBeNull();
  });

  it("maps content types to stable component ids", () => {
    expect(componentForContentType("direct")).toBe(DIRECT_COMPONENT);
    expect(componentForContentType("opencode")).toBe(OPENCODE_COMPONENT);
  });
});

describe("createPanelParams", () => {
  it("builds params only for canonical keys", () => {
    expect(createPanelParams("chat:abc")).toEqual({ tabKey: "chat:abc", contentType: "direct" });
    expect(createPanelParams("agent:xyz")).toEqual({
      tabKey: "agent:xyz",
      contentType: "opencode",
    });
    expect(createPanelParams("bad")).toBeNull();
  });
});

describe("parsePanelParams", () => {
  it("accepts a valid direct/agent params bag", () => {
    expect(parsePanelParams({ tabKey: "chat:abc", contentType: "direct" })).toEqual({
      tabKey: "chat:abc",
      contentType: "direct",
    });
    expect(parsePanelParams({ tabKey: "agent:xyz", contentType: "opencode" })).toEqual({
      tabKey: "agent:xyz",
      contentType: "opencode",
    });
  });

  it("rejects mismatched content type and non-canonical keys", () => {
    expect(parsePanelParams({ tabKey: "chat:abc", contentType: "opencode" })).toBeNull();
    expect(parsePanelParams({ tabKey: "agent:xyz", contentType: "direct" })).toBeNull();
    expect(parsePanelParams({ tabKey: "garbage", contentType: "direct" })).toBeNull();
    expect(parsePanelParams({ tabKey: "chat:", contentType: "direct" })).toBeNull();
  });

  it("rejects extra/missing fields and non-serializable values", () => {
    expect(parsePanelParams({ tabKey: "chat:abc", contentType: "direct", extra: 1 })).toBeNull();
    expect(parsePanelParams({ tabKey: "chat:abc" })).toBeNull();
    expect(parsePanelParams(null)).toBeNull();
    expect(parsePanelParams([])).toBeNull();
    expect(parsePanelParams({ tabKey: () => "chat:abc", contentType: "direct" })).toBeNull();
  });
});
