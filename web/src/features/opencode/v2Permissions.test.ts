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

/**
 * The prompt is the QUESTION put to the user, so it must never be invented.
 *
 * The V2 bridge used to fall back to the action name
 * (`prompt: request.message ?? request.action`), which put the literal string
 * `"shell"` into `prompt`. The approval card shows the prompt in place of the
 * argument preview, so on the Code engine the arguments a permission was
 * actually about never reached the screen: the card read `shell` instead of
 * `{"command":"echo CARD-TEST-1"}`.
 *
 * With no message, the card must fall back to its own args preview — which
 * requires the approval to carry NO `prompt` key at all, not `prompt: undefined`
 * and certainly not the action name.
 */

/** A real observed V2 shell permission: an action name, and no question. */
const shellRequest: PermissionRequest = {
  id: "permission-shell",
  sessionID: "session-1",
  action: "shell",
  resources: ["D:/workspace"],
  save: ["D:/workspace/**"],
  source: { type: "tool", messageID: "assistant-1", id: "tool-1" },
};

/** The option ids every save-pattern permission projects, in order. */
const EXPECTED_OPTION_IDS = [
  V2_PERMISSION_OPTION_IDS.once,
  V2_PERMISSION_OPTION_IDS.always,
  V2_PERMISSION_OPTION_IDS.reject,
];

/** Project a wire permission into the concrete approval object under test. */
function approvalFor(wire: PermissionRequest) {
  const view = projectV2Permission(wire);
  if (!view) throw new Error("expected a projected permission");
  const approval = projectV2PermissionApproval(view);
  if (!approval) throw new Error("expected an approval object");
  return approval;
}

describe("V2 approval prompt — only a real message qualifies", () => {
  it("a permission with no message carries no prompt key at all", () => {
    const approval = approvalFor(shellRequest);

    // The load-bearing assertion: the key is ABSENT, so the card cannot find a
    // prompt to show and falls through to the argument preview.
    expect("prompt" in approval).toBe(false);
    expect(approval.prompt).toBeUndefined();
    // Nothing is smuggled in under another name — notably not the action.
    expect(Object.keys(approval).sort()).toEqual(["id", "options"]);
    // Options are projected exactly as before, message or not.
    expect(approval.options?.map((option) => option.id)).toEqual(EXPECTED_OPTION_IDS);
  });

  it("an explicitly undefined message is treated the same as an absent one", () => {
    // `??` means only null/undefined are absorbed, so this is the boundary the
    // fix depends on; pin it separately from the omitted-key case.
    const approval = approvalFor({ ...shellRequest, message: undefined });
    expect("prompt" in approval).toBe(false);
  });

  it("a real message becomes the prompt and changes nothing else", () => {
    const withoutMessage = approvalFor(shellRequest);
    const withMessage = approvalFor({
      ...shellRequest,
      message: "Which database?",
    });

    expect(withMessage.prompt).toBe("Which database?");
    // Same request, same decisions: `prompt` is the ONLY key a message adds.
    expect(withMessage.id).toBe(withoutMessage.id);
    expect(withMessage.options).toEqual(withoutMessage.options);
    expect(Object.keys(withMessage).sort()).toEqual([
      "id",
      "options",
      "prompt",
    ]);
  });

  it("a blank message is kept verbatim — normalising it is the card's job", () => {
    // Deliberate division of responsibility, pinned so it cannot drift:
    // the projection reports what the wire carried, and `ApprovalGate` owns
    // "is this renderable" (a blank prompt renders no paragraph). If the
    // projection started dropping blank strings, `prompt` would have to become
    // optional-only-by-trimming and this test would say so.
    const approval = approvalFor({ ...shellRequest, message: "   " });
    expect(approval.prompt).toBe("   ");
    expect(approval.options?.map((option) => option.id)).toEqual(EXPECTED_OPTION_IDS);
  });

  it("the message never changes how a reply maps to a decision", () => {
    // The prompt is presentation; the wire→decision mapping must not depend on
    // it, or "show the question" would silently change what Allow means.
    const view = projectV2Permission({
      ...shellRequest,
      message: "Which database?",
    });
    if (!view) throw new Error("expected permission");
    expect(
      toV2PermissionReply(view, {
        approvalId: view.id,
        approved: true,
        optionId: V2_PERMISSION_OPTION_IDS.always,
      }),
    ).toBe("always");
  });
});
