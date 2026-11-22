/**
 * Duplicate-mount guard + canonical reconciliation helpers. These pin the
 * invariant that one conversation (canonical tab key) can own at most one live
 * host, and that reconciliation is an idempotent add/remove diff.
 */
import { describe, it, expect } from "bun:test";
import {
  createPanelRegistry,
  desiredPanelKeys,
  diffPanelKeys,
} from "@web/features/workspace/panelRegistry";

describe("createPanelRegistry", () => {
  it("claims a tab key once and refuses a second claim", () => {
    const registry = createPanelRegistry();
    expect(registry.claim("chat:a")).toBe(true);
    expect(registry.claim("chat:a")).toBe(false);
    expect(registry.has("chat:a")).toBe(true);
    expect(registry.claimed).toEqual(["chat:a"]);
  });

  it("releases a claim idempotently", () => {
    const registry = createPanelRegistry();
    registry.claim("agent:x");
    registry.release("agent:x");
    registry.release("agent:x");
    expect(registry.has("agent:x")).toBe(false);
    expect(registry.claim("agent:x")).toBe(true);
  });
});

describe("desiredPanelKeys", () => {
  it("keeps canonical keys, drops malformed/empty/duplicate keys", () => {
    expect(
      desiredPanelKeys(["chat:a", "agent:b", "chat:a", "garbage", "chat:", "agent:"]),
    ).toEqual(["chat:a", "agent:b"]);
  });
});

describe("diffPanelKeys", () => {
  it("computes the add/remove diff", () => {
    expect(diffPanelKeys(["chat:a", "chat:gone"], ["chat:a", "chat:new"])).toEqual({
      toAdd: ["chat:new"],
      toRemove: ["chat:gone"],
    });
  });

  it("is idempotent when current equals desired", () => {
    expect(diffPanelKeys(["chat:a"], ["chat:a"])).toEqual({ toAdd: [], toRemove: [] });
  });
});
