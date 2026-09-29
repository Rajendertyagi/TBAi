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

/**
 * The precomputed change on a pending request, read from `metadata.files`.
 *
 * `metadata` is free-form on the wire, so these cases are the ones that decide
 * whether a reviewer sees a diff or silently gets the find/replace pair. The
 * good case is the payload captured from the live server.
 */
describe("native V2 permission file diffs", () => {
  const PATCH = [
    "Index: src/a.ts",
    "===================================================================",
    "--- src/a.ts",
    "+++ src/a.ts",
    "@@ -1,3 +1,3 @@",
    " const before = 1;",
    "-const target = 1;",
    "+const target = 2;",
    " export { before };",
    "",
  ].join("\n");

  const edit = (metadata?: PermissionRequest["metadata"]): PermissionRequest => ({
    id: "per_edit_1",
    sessionID: "session-1",
    action: "edit",
    resources: ["src/a.ts"],
    source: { type: "tool", messageID: "assistant-1", id: "tool-1" },
    ...(metadata === undefined ? {} : { metadata }),
  });

  it("reads the patch the server precomputed, with its file", () => {
    const view = projectV2Permission(
      edit({ files: [{ file: "src/a.ts", patch: PATCH, status: "modified", additions: 1, deletions: 1 }] }),
    );
    expect(view?.fileDiffs).toEqual([{ file: "src/a.ts", patch: PATCH }]);
  });

  it("is empty when the request carries no metadata at all", () => {
    expect(projectV2Permission(edit())?.fileDiffs).toEqual([]);
  });

  it("is empty when metadata has no files key", () => {
    expect(projectV2Permission(edit({ somethingElse: true }))?.fileDiffs).toEqual([]);
  });

  it("skips an entry that is not a usable file diff", () => {
    // Every one of these can arrive: metadata is typed `{ [x: string]: JsonValue }`,
    // so nothing about the shape is guaranteed.
    const view = projectV2Permission(
      edit({
        files: [null, "junk", 42, {}, { file: "src/a.ts" }, { patch: PATCH }, { file: "src/a.ts", patch: "   " }],
      }),
    );
    expect(view?.fileDiffs).toEqual([]);
  });

  it("keeps the good entries and drops the broken ones", () => {
    const view = projectV2Permission(
      edit({ files: [null, { file: "src/a.ts", patch: PATCH }, { file: "b.ts" }] }),
    );
    expect(view?.fileDiffs).toEqual([{ file: "src/a.ts", patch: PATCH }]);
  });

  it("is empty for a non-edit action that happens to carry files", () => {
    // The field is read on its own merits, never on the action name: an action
    // that sends a patch is showing something real, and guessing at intent here
    // would be the kind of cleverness that hides a real payload.
    const view = projectV2Permission({
      ...edit({ files: [{ file: "src/a.ts", patch: PATCH }] }),
      action: "patch",
    });
    expect(view?.fileDiffs).toHaveLength(1);
  });
});