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

  it("projected user, no assistant → resubmit user (crash before assistant)", () => {
    const action = classifyRecovery({
      messages: [msg("u1", "user")],
      inbox: [],
      truncated: false,
    });
    expect(action.kind).toBe("resubmit-user");
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
});
