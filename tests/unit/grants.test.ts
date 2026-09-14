import { describe, it, expect, beforeEach } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { mintGrant, consumeGrant, grantCounts } from "../../src/services/grants";
import { resolveSafe, inspectTarget, OutsideWorkspaceError } from "../../src/services/tools";

let root = "";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-grants-"));
  fs.mkdirSync(path.join(root, "proj"), { recursive: true });
  fs.writeFileSync(path.join(root, "proj", "a.txt"), "hi\n");
});

describe("grant store", () => {
  it("mints and consumes exactly once", () => {
    const g = mintGrant({ conversationId: "c1", tool: "read_file", resolvedTarget: "/x/y" });
    expect(g.consumed).toBe(false);
    expect(consumeGrant("c1", "read_file", "/x/y")).not.toBeNull();
    expect(consumeGrant("c1", "read_file", "/x/y")).toBeNull();
  });

  it("rejects wrong tool, conversation, or target", () => {
    mintGrant({ conversationId: "c1", tool: "read_file", resolvedTarget: "/x/y" });
    expect(consumeGrant("c1", "write_file", "/x/y")).toBeNull();
    expect(consumeGrant("c2", "read_file", "/x/y")).toBeNull();
    expect(consumeGrant("c1", "read_file", "/x/z")).toBeNull();
    // Original still live (failed matches don't consume).
    expect(consumeGrant("c1", "read_file", "/x/y")).not.toBeNull();
  });

  it("expires grants past TTL", () => {
    mintGrant({ conversationId: "c1", tool: "read_file", resolvedTarget: "/x", ttlMs: -1 });
    expect(consumeGrant("c1", "read_file", "/x")).toBeNull();
  });

  it("counts live grants", () => {
    const before = grantCounts().live;
    mintGrant({ conversationId: "c1", tool: "read_file", resolvedTarget: "/a" });
    mintGrant({ conversationId: "c1", tool: "read_file", resolvedTarget: "/b" });
    expect(grantCounts().live).toBe(before + 2);
  });
});

describe("resolveSafe with grants", () => {
  it("admits an outside path once with a matching grant, then fails closed", () => {
    const scope = { conversationId: "c9", tool: "read_file" };
    const outside = path.join(root, "..", path.basename(root) + "-other");
    fs.mkdirSync(outside, { recursive: true });
    const target = path.relative(root, path.join(outside, "f.txt"));
    // No grant: structured refusal, same historic message.
    try {
      resolveSafe(target, root, scope);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(OutsideWorkspaceError);
      expect((e as OutsideWorkspaceError).code).toBe("OUTSIDE_WORKSPACE");
      expect((e as Error).message).toContain("outside the workspace");
    }
    // Mint via the canonical target the server itself derives.
    const { real } = inspectTarget(target, root);
    mintGrant({ conversationId: "c9", tool: "read_file", resolvedTarget: real });
    fs.writeFileSync(path.join(outside, "f.txt"), "data\n");
    // First execution admitted…
    expect(() => resolveSafe(target, root, scope)).not.toThrow();
    // …second execution (same call retried, replay, or next turn) refused.
    try {
      resolveSafe(target, root, scope);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(OutsideWorkspaceError);
    }
  });

  it("ignores grants for a different conversation", () => {
    const target = path.join(root, "..", "nope.txt");
    const { real } = inspectTarget(target, root);
    mintGrant({ conversationId: "other", tool: "read_file", resolvedTarget: real });
    expect(() =>
      resolveSafe(target, root, { conversationId: "c9", tool: "read_file" }),
    ).toThrow(OutsideWorkspaceError);
  });
});
