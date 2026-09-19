import { describe, it, expect } from "bun:test";
import { autoAcceptPendingPermissions } from "./permissionCompat";
import { AUTO_RESPONSE, type PermissionMode } from "@/features/permissions/permissionPolicy";

/**
 * The Auto shield's only behaviour.
 *
 * The helper calls `client.permission.reply`, which in production is the patched
 * `replyCompat`. Here it is a recording fake, so these tests pin the helper's own
 * contract: manual is a no-op, auto replies `AUTO_RESPONSE` only, successful
 * replies are recorded in the shared answered set, failed replies stay retryable,
 * and repeated reconciliation never answers the same request twice.
 */

type ReplyCall = { requestID: string; reply: unknown };

/** A client whose `permission.reply` records calls; `fail` ids throw. */
function fakeClient(calls: ReplyCall[], fail: ReadonlySet<string> = new Set()) {
  return {
    permission: {
      reply: async (parameters: ReplyCall) => {
        calls.push(parameters);
        if (fail.has(parameters.requestID)) throw new Error("gone");
        return true;
      },
    },
  } as unknown as Parameters<typeof autoAcceptPendingPermissions>[0];
}

const pending = (...ids: string[]) => ids.map((id) => ({ id }));

describe("autoAcceptPendingPermissions", () => {
  it("manual mode returns zero and sends no response", async () => {
    const calls: ReplyCall[] = [];
    const handled = await autoAcceptPendingPermissions(
      fakeClient(calls),
      pending("p1", "p2"),
      "manual",
      new Set(),
    );
    expect(handled).toBe(0);
    expect(calls).toEqual([]);
  });

  it("auto mode answers a pending permission", async () => {
    const calls: ReplyCall[] = [];
    const handled = await autoAcceptPendingPermissions(
      fakeClient(calls),
      pending("p1"),
      "auto",
      new Set(),
    );
    expect(handled).toBe(1);
    expect(calls.map((c) => c.requestID)).toEqual(["p1"]);
  });

  it("the automatic response is exactly AUTO_RESPONSE", async () => {
    const calls: ReplyCall[] = [];
    await autoAcceptPendingPermissions(fakeClient(calls), pending("p1"), "auto", new Set());
    expect(calls[0]!.reply).toBe(AUTO_RESPONSE);
    expect(AUTO_RESPONSE).toBe("once");
  });

  it("never produces \"always\"", async () => {
    const calls: ReplyCall[] = [];
    await autoAcceptPendingPermissions(
      fakeClient(calls),
      pending("p1", "p2", "p3"),
      "auto",
      new Set(),
    );
    expect(calls.every((c) => c.reply !== "always")).toBe(true);
    expect(calls.map((c) => c.reply)).toEqual(["once", "once", "once"]);
  });

  it("alreadyAnswered ids are skipped", async () => {
    const calls: ReplyCall[] = [];
    const handled = await autoAcceptPendingPermissions(
      fakeClient(calls),
      pending("p1", "p2"),
      "auto",
      new Set(["p1"]),
    );
    expect(handled).toBe(1);
    expect(calls.map((c) => c.requestID)).toEqual(["p2"]);
  });

  it("successful replies are recorded in the shared answered set", async () => {
    const calls: ReplyCall[] = [];
    const answered = new Set<string>();
    await autoAcceptPendingPermissions(fakeClient(calls), pending("p1"), "auto", answered);
    expect(answered.has("p1")).toBe(true);
  });

  it("duplicate reconciliation cannot answer the same request twice", async () => {
    const calls: ReplyCall[] = [];
    const answered = new Set<string>();
    const client = fakeClient(calls);

    for (let pass = 0; pass < 3; pass++) {
      const handled = await autoAcceptPendingPermissions(
        client,
        pending("p1", "p2"),
        "auto",
        answered,
      );
      if (pass > 0) expect(handled).toBe(0);
    }

    expect(calls.map((c) => c.requestID)).toEqual(["p1", "p2"]);
  });

  it("multiple pending permissions are each handled exactly once", async () => {
    const calls: ReplyCall[] = [];
    const handled = await autoAcceptPendingPermissions(
      fakeClient(calls),
      pending("a", "b", "c"),
      "auto",
      new Set(),
    );
    expect(handled).toBe(3);
    expect([...calls.map((c) => c.requestID)].sort()).toEqual(["a", "b", "c"]);
    expect(new Set(calls.map((c) => c.requestID)).size).toBe(3);
  });

  it("a failing reply is not counted as handled and does not stop the rest", async () => {
    const calls: ReplyCall[] = [];
    const answered = new Set<string>();
    const handled = await autoAcceptPendingPermissions(
      fakeClient(calls, new Set(["b"])),
      pending("a", "b", "c"),
      "auto",
      answered,
    );
    expect(handled).toBe(2);
    expect(calls.length).toBe(3);
    // The failed reply is NOT recorded — it stays retryable.
    expect(answered.has("b")).toBe(false);
    expect(answered.has("a")).toBe(true);
    expect(answered.has("c")).toBe(true);
  });

  it("a failed reply is retried on a later pass", async () => {
    const calls: ReplyCall[] = [];
    const answered = new Set<string>();
    // A transient failure: `b` fails only while it is in the mutable set.
    const failing = new Set<string>(["b"]);
    const client = fakeClient(calls, failing);

    const first = await autoAcceptPendingPermissions(client, pending("a", "b"), "auto", answered);
    expect(first).toBe(1);

    // The failure clears; a second pass retries b and succeeds.
    failing.delete("b");
    const second = await autoAcceptPendingPermissions(client, pending("a", "b"), "auto", answered);
    expect(second).toBe(1);
    expect(calls.map((c) => c.requestID)).toEqual(["a", "b", "b"]);
  });

  it("missing or malformed mode behaves as manual", async () => {
    for (const bad of [undefined, null, "", "AUTO", "always", 1, {}]) {
      const calls: ReplyCall[] = [];
      const handled = await autoAcceptPendingPermissions(
        fakeClient(calls),
        pending("p1"),
        bad as unknown as PermissionMode,
        new Set(),
      );
      expect(handled).toBe(0);
      expect(calls).toEqual([]);
    }
  });

  it("session identity is the request's own id — nothing is derived", async () => {
    const calls: ReplyCall[] = [];
    await autoAcceptPendingPermissions(
      fakeClient(calls),
      [{ id: "ses_A#perm_1" }],
      "auto",
      new Set(),
    );
    // The id is passed through verbatim; the helper invents and rewrites nothing.
    expect(calls[0]!.requestID).toBe("ses_A#perm_1");
  });
});