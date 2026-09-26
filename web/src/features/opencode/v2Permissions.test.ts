import { describe, expect, it } from "bun:test";
import type { PermissionRequest } from "@opencode/client";
import {
  deriveV2ToolCallId,
  projectV2Permission,
  projectV2PermissionApproval,
  toV2PermissionReply,
  V2_PERMISSION_OPTION_IDS,
} from "./v2Permissions";

const request: PermissionRequest = {
  id: "permission-1",
  sessionID: "session-1",
  action: "bash",
  resources: ["D:/workspace"],
  save: ["D:/workspace/**"],
  source: { type: "tool", messageID: "assistant-1", id: "tool-1" },
};

describe("native V2 permission projection", () => {
  it("preserves source identity and derives a stable tool-call id", () => {
    const view = projectV2Permission(request);
    expect(view?.sourceMessageID).toBe("assistant-1");
    expect(view?.sourceToolId).toBe("tool-1");
    expect(view?.toolCallId).toBe(deriveV2ToolCallId("assistant-1", "tool-1"));
  });

  it("projects exact save-pattern options and maps approved replies", () => {
    const view = projectV2Permission(request);
    if (!view) throw new Error("expected permission");
    const approval = projectV2PermissionApproval(view);
    expect(approval?.options?.map((option) => option.id)).toEqual([
      V2_PERMISSION_OPTION_IDS.once,
      V2_PERMISSION_OPTION_IDS.always,
      V2_PERMISSION_OPTION_IDS.reject,
    ]);
    expect(toV2PermissionReply(view, { approvalId: view.id, approved: true, optionId: V2_PERMISSION_OPTION_IDS.once })).toBe("once");
    expect(toV2PermissionReply(view, { approvalId: view.id, approved: true, optionId: V2_PERMISSION_OPTION_IDS.always })).toBe("always");
    expect(toV2PermissionReply(view, { approvalId: view.id, approved: false, optionId: V2_PERMISSION_OPTION_IDS.reject })).toBe("reject");
  });

  it("rejects an unknown or mismatched option instead of defaulting to once", () => {
    const view = projectV2Permission(request);
    if (!view) throw new Error("expected permission");
    expect(() => toV2PermissionReply(view, { approvalId: view.id, approved: true, optionId: "unknown" })).toThrow();
  });
});
