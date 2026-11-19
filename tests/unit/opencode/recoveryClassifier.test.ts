import { describe, expect, it } from "bun:test";
import {
  classifyRecovery,
  type InboxEntry,
  type TimelineMessage,
} from "@/services/opencode/recoveryClassifier";
import { RECOVERY_NOTICE } from "@/config/opencode-recovery";

function msg(
  id: string,
  type: TimelineMessage["type"],
  overrides: Partial<TimelineMessage> = {},
): TimelineMessage {
  return { id, type, timeCreated: 0, ...overrides };
}

function inbox(
  id: string,
  type: InboxEntry["type"],
  delivery: InboxEntry["delivery"] = "steer",
  overrides: Partial<InboxEntry> = {},
): InboxEntry {
  return { id, type, delivery, timeCreated: 0, ...overrides };
}

describe("classifyRecovery — decision table", () => {
  it("latest work-bearing input followed by idle → no recovery", () => {
    const action = classifyRecovery({
      messages: [msg("u1", "user"), msg("a1", "assistant", { completed: true }), msg("i1", "idle")],
      inbox: [],
      truncated: false,
    });
    expect(action.kind).toBe("none");
  });

  it("no work-bearing input after idle → no recovery", () => {
    const action = classifyRecovery({
      messages: [msg("i1", "idle"), msg("a1", "assistant", { completed: true })],
      inbox: [],
      truncated: false,
    });
    expect(action.kind).toBe("none");
  });

  // Defect 2: pending input after idle / empty history must not be skipped.
  it("pending user after idle with no projected input → resubmit by original id and delivery", () => {
    const action = classifyRecovery({
      messages: [msg("u0", "user"), msg("i1", "idle")],
      inbox: [inbox("u-pending", "user", "queue")],
      truncated: false,
    });
    expect(action.kind).toBe("resubmit-user");
    if (action.kind === "resubmit-user") {
      expect(action.id).toBe("u-pending");
      expect(action.delivery).toBe("queue");
    }
  });

  it("empty history with pending user → resubmit by original id and delivery", () => {
    const action = classifyRecovery({
      messages: [],
      inbox: [inbox("u-pending", "user", "steer")],
      truncated: false,
    });
    expect(action.kind).toBe("resubmit-user");
    if (action.kind === "resubmit-user") {
      expect(action.id).toBe("u-pending");
      expect(action.delivery).toBe("steer");
    }
  });

  it("empty history with pending synthetic → repost its id", () => {
    const action = classifyRecovery({
      messages: [],
      inbox: [inbox("s-pending", "synthetic", "steer", { metadata: { notice: RECOVERY_NOTICE } })],
      truncated: false,
    });
    expect(action.kind).toBe("repost-synthetic");
    if (action.kind === "repost-synthetic") expect(action.id).toBe("s-pending");
  });

  it("truncated scan → indeterminate, no auto-resume", () => {
    const action = classifyRecovery({
      messages: [msg("u1", "user")],
      inbox: [],
      truncated: true,
    });
    expect(action.kind).toBe("indeterminate");
  });

  it("pending user prompt → resubmit by original id", () => {
    const action = classifyRecovery({
      messages: [msg("u1", "user")],
      inbox: [inbox("u1", "user", "queue")],
      truncated: false,
    });
    expect(action.kind).toBe("resubmit-user");
    if (action.kind === "resubmit-user") {
      expect(action.id).toBe("u1");
      expect(action.delivery).toBe("queue");
    }
  });

  it("projected user, no assistant → resubmit-user marked projected (crash before assistant)", () => {
    // Verified against OpenCode 2.2.6: re-posting an already-projected user id
    // reconciles (200) but creates no inbox work, so the wake goes idle without
    // an assistant. The action stays resubmit-user (plan semantics) but is marked
    // projected so the executor uses a fresh synthetic to actually wake the turn.
    const action = classifyRecovery({
      messages: [msg("u1", "user")],
      inbox: [],
      truncated: false,
    });
    expect(action.kind).toBe("resubmit-user");
    if (action.kind === "resubmit-user") {
      expect(action.id).toBe("u1");
      expect(action.projected).toBe(true);
    }
  });

  it("user + incomplete assistant, no idle → recovery synthetic", () => {
    const action = classifyRecovery({
      messages: [msg("u1", "user"), msg("a1", "assistant", { completed: false })],
      inbox: [],
      truncated: false,
    });
    expect(action.kind).toBe("repost-synthetic");
    if (action.kind === "repost-synthetic") expect(action.reuseFromHistory).toBe(true);
  });

  it("completed assistant, no idle, no stronger evidence → indeterminate", () => {
    const action = classifyRecovery({
      messages: [msg("u1", "user"), msg("a1", "assistant", { completed: true })],
      inbox: [],
      truncated: false,
    });
    expect(action.kind).toBe("indeterminate");
  });

  it("completed assistant + completed compaction, no continuation/idle → indeterminate (compaction does not override)", () => {
    const action = classifyRecovery({
      messages: [
        msg("u1", "user"),
        msg("a1", "assistant", { completed: true }),
        msg("c1", "compaction", { compactionStatus: "completed" }),
      ],
      inbox: [],
      truncated: false,
    });
    expect(action.kind).toBe("indeterminate");
  });

  it("user → completed compaction → no assistant → no idle → resubmit user", () => {
    const action = classifyRecovery({
      messages: [msg("u1", "user"), msg("c1", "compaction", { compactionStatus: "completed" })],
      inbox: [],
      truncated: false,
    });
    expect(action.kind).toBe("resubmit-user");
  });

  it("TBAi recovery synthetic latest → repost same id", () => {
    const action = classifyRecovery({
      messages: [
        msg("u1", "user"),
        msg("s1", "synthetic", { metadata: { notice: RECOVERY_NOTICE } }),
      ],
      inbox: [],
      truncated: false,
    });
    expect(action.kind).toBe("repost-synthetic");
    if (action.kind === "repost-synthetic") {
      expect(action.id).toBe("s1");
      expect(action.native).toBe(false);
    }
  });

  it("native continuation synthetic latest → repost same id, native, preserve metadata", () => {
    const action = classifyRecovery({
      messages: [
        msg("u1", "user"),
        msg("a1", "assistant", { completed: true }),
        msg("s1", "synthetic", {
          text: "continue",
          description: "d",
          metadata: { source: "native" },
        }),
      ],
      inbox: [],
      truncated: false,
    });
    expect(action.kind).toBe("repost-synthetic");
    if (action.kind === "repost-synthetic") {
      expect(action.id).toBe("s1");
      expect(action.native).toBe(true);
      expect(action.text).toBe("continue");
      expect(action.description).toBe("d");
    }
  });

  it("native continuation synthetic followed by idle → no recovery", () => {
    const action = classifyRecovery({
      messages: [msg("s1", "synthetic"), msg("i1", "idle")],
      inbox: [],
      truncated: false,
    });
    expect(action.kind).toBe("none");
  });

  it("native continuation synthetic followed by later user → resubmit user", () => {
    const action = classifyRecovery({
      messages: [msg("s1", "synthetic"), msg("u2", "user")],
      inbox: [],
      truncated: false,
    });
    expect(action.kind).toBe("resubmit-user");
    if (action.kind === "resubmit-user") expect(action.id).toBe("u2");
  });

  it("pending synthetic + newer projected user → cancel synthetic and resubmit user", () => {
    const action = classifyRecovery({
      messages: [msg("u2", "user")],
      inbox: [inbox("s1", "synthetic", "steer", { metadata: { notice: RECOVERY_NOTICE } })],
      truncated: false,
    });
    expect(action.kind).toBe("cancel-and-resubmit-user");
    if (action.kind === "cancel-and-resubmit-user") {
      expect(action.cancelId).toBe("s1");
      expect(action.userId).toBe("u2");
    }
  });

  it("user promoted before synthetic in inbox order → cancel synthetic before waking user", () => {
    const action = classifyRecovery({
      messages: [msg("u2", "user")],
      inbox: [
        inbox("s1", "synthetic", "steer", { metadata: { notice: RECOVERY_NOTICE } }),
        inbox("u2", "user", "steer"),
      ],
      truncated: false,
    });
    expect(action.kind).toBe("cancel-and-resubmit-user");
  });

  it("synthetic promoted before queued user → repost synthetic, do not cancel parked queue user", () => {
    const action = classifyRecovery({
      messages: [msg("s1", "synthetic", { metadata: { notice: RECOVERY_NOTICE } })],
      inbox: [
        inbox("s1", "synthetic", "steer", { metadata: { notice: RECOVERY_NOTICE } }),
        inbox("u2", "user", "queue"),
      ],
      truncated: false,
    });
    expect(action.kind).toBe("repost-synthetic");
  });

  it("control item in steer set makes ordering race-dependent → conservative user-wins", () => {
    const action = classifyRecovery({
      messages: [msg("u2", "user")],
      inbox: [
        inbox("s1", "synthetic", "steer", { metadata: { notice: RECOVERY_NOTICE } }),
        inbox("c1", "compaction", "steer"),
        inbox("u2", "user", "steer"),
      ],
      truncated: false,
    });
    // user-wins fallback still cancels the pending synthetic, but never claims
    // a deterministic promotion order.
    expect(action.kind).toBe("cancel-and-resubmit-user");
  });

  // Defect 3: projected synthetic vs pending user — user-wins, never cancel a
  // projected synthetic, never bypass the pending user.
  it("projected TBAi recovery synthetic + newer pending user → resubmit user, no cancel of projected", () => {
    const action = classifyRecovery({
      messages: [msg("s-proj", "synthetic", { metadata: { notice: RECOVERY_NOTICE } })],
      inbox: [inbox("u-new", "user", "steer")],
      truncated: false,
    });
    expect(action.kind).toBe("resubmit-user");
    if (action.kind === "resubmit-user") expect(action.id).toBe("u-new");
  });

  it("projected native continuation synthetic + newer pending user → resubmit user, no cancel of projected", () => {
    const action = classifyRecovery({
      messages: [msg("s-native", "synthetic", { text: "continue" })],
      inbox: [inbox("u-new", "user", "queue")],
      truncated: false,
    });
    expect(action.kind).toBe("resubmit-user");
    if (action.kind === "resubmit-user") {
      expect(action.id).toBe("u-new");
      expect(action.delivery).toBe("queue");
    }
  });

  it("projected synthetic + pending user with a separate pending synthetic → cancel only the pending one", () => {
    const action = classifyRecovery({
      messages: [msg("s-proj", "synthetic", { metadata: { notice: RECOVERY_NOTICE } })],
      inbox: [
        inbox("s-pending", "synthetic", "steer", { metadata: { notice: RECOVERY_NOTICE } }),
        inbox("u-new", "user", "steer"),
      ],
      truncated: false,
    });
    expect(action.kind).toBe("cancel-and-resubmit-user");
    if (action.kind === "cancel-and-resubmit-user") {
      expect(action.cancelId).toBe("s-pending"); // never "s-proj"
      expect(action.userId).toBe("u-new");
    }
  });

  // Defect 5: shutdown grace is presence-based, never a timestamp comparison.
  it("busy present + idle absent → shutdownInterruption marker on the action", () => {
    const action = classifyRecovery({
      messages: [msg("u1", "user")],
      inbox: [],
      truncated: false,
      sessionSignal: { busy: true, idle: false },
    });
    expect(action.kind).toBe("resubmit-user");
    if (action.kind === "resubmit-user") expect(action.shutdownInterruption).toBe(true);
  });

  it("busy + idle both present → no shutdownInterruption (no timestamp inference)", () => {
    const action = classifyRecovery({
      messages: [msg("u1", "user")],
      inbox: [],
      truncated: false,
      sessionSignal: { busy: true, idle: true },
    });
    expect(action.kind).toBe("resubmit-user");
    if (action.kind === "resubmit-user") expect(action.shutdownInterruption).toBe(false);
  });

  // Issue A: projected user followed by a DIFFERENT pending user must wake the
  // newer pending user, never the old projected one, and never borrow delivery.
  it("projected user + different pending steer user → resubmit the pending user by its own id/delivery", () => {
    const action = classifyRecovery({
      messages: [msg("u-old", "user")],
      inbox: [inbox("u-new", "user", "steer")],
      truncated: false,
    });
    expect(action.kind).toBe("resubmit-user");
    if (action.kind === "resubmit-user") {
      expect(action.id).toBe("u-new");
      expect(action.delivery).toBe("steer");
    }
  });

  it("projected user + different pending queue user → resubmit the pending user with queue delivery", () => {
    const action = classifyRecovery({
      messages: [msg("u-old", "user")],
      inbox: [inbox("u-new", "user", "queue")],
      truncated: false,
    });
    expect(action.kind).toBe("resubmit-user");
    if (action.kind === "resubmit-user") {
      expect(action.id).toBe("u-new");
      expect(action.delivery).toBe("queue");
    }
  });

  it("projected user + different pending user + pending synthetic → cancel synthetic, resubmit pending user", () => {
    const action = classifyRecovery({
      messages: [msg("u-old", "user")],
      inbox: [
        inbox("s-pending", "synthetic", "steer", { metadata: { notice: RECOVERY_NOTICE } }),
        inbox("u-new", "user", "steer"),
      ],
      truncated: false,
    });
    expect(action.kind).toBe("cancel-and-resubmit-user");
    if (action.kind === "cancel-and-resubmit-user") {
      expect(action.cancelId).toBe("s-pending");
      expect(action.userId).toBe("u-new");
    }
  });
});
