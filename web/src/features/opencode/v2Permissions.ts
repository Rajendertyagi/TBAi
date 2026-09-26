import type { PermissionRequest } from "@opencode/client";
import type {
  RespondToToolApprovalOptions,
  ToolApprovalOption,
  ToolCallMessagePart,
} from "@assistant-ui/react";
import {
  bindApprovalOptions,
  hostResponseFor,
} from "@/features/permissions/approvalOptionMapping";

/** The stable host option ids used by the native V2 permission bridge. */
export const V2_PERMISSION_OPTION_IDS = {
  once: "tbai-v2-permission-once",
  always: "tbai-v2-permission-always",
  reject: "tbai-v2-permission-reject",
} as const;

/** Prefix for assistant-ui tool-call ids derived from official OpenCode identities. */
export const V2_TOOL_CALL_ID_PREFIX = "tbai-v2-tool:";

/** A permission projected into the fields consumed by the Code surfaces. */
export interface V2PermissionView {
  readonly id: string;
  readonly sessionId: string;
  readonly sourceMessageID: string | null;
  readonly sourceToolId: string | null;
  readonly toolCallId: string | null;
  readonly action: string;
  readonly resources: readonly string[];
  readonly savePatterns: readonly string[];
  readonly message: string | null;
}

/** Error raised when assistant-ui approval state is inconsistent with the wire request. */
export class V2PermissionResponseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "V2PermissionResponseError";
  }
}

/** Derives a collision-safe assistant-ui tool-call id from official identities. */
export function deriveV2ToolCallId(
  assistantMessageId: string,
  officialToolId: string,
): string {
  return `${V2_TOOL_CALL_ID_PREFIX}${encodeURIComponent(assistantMessageId)}:${encodeURIComponent(officialToolId)}`;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Projects a valid official permission, preserving linked tool identity. */
export function projectV2Permission(
  request: PermissionRequest,
): V2PermissionView | null {
  if (
    typeof request.id !== "string" ||
    typeof request.sessionID !== "string" ||
    typeof request.action !== "string" ||
    !isStringArray(request.resources) ||
    (request.save !== undefined && !isStringArray(request.save))
  ) {
    return null;
  }

  const source = request.source?.type === "tool" ? request.source : null;
  const sourceMessageID = source?.messageID ?? null;
  const sourceToolId = source?.id ?? null;
  return {
    id: request.id,
    sessionId: request.sessionID,
    sourceMessageID,
    sourceToolId,
    toolCallId:
      sourceMessageID !== null && sourceToolId !== null
        ? deriveV2ToolCallId(sourceMessageID, sourceToolId)
        : null,
    action: request.action,
    resources: [...request.resources],
    savePatterns: request.save ? [...request.save] : [],
    message: request.message ?? null,
  };
}

function permissionOptions(savePatterns: readonly string[]): readonly ToolApprovalOption[] {
  if (savePatterns.length === 0) return [];
  return [
    {
      id: V2_PERMISSION_OPTION_IDS.once,
      kind: "allow-once",
      grants: [],
    },
    {
      id: V2_PERMISSION_OPTION_IDS.always,
      kind: "allow-always",
      grants: [...savePatterns],
    },
    {
      id: V2_PERMISSION_OPTION_IDS.reject,
      kind: "reject-once",
      grants: [],
    },
  ];
}

/** Builds the assistant-ui approval object for a projected permission. */
export function projectV2PermissionApproval(
  request: V2PermissionView,
): ToolCallMessagePart["approval"] {
  const approval: ToolCallMessagePart["approval"] = {
    id: request.id,
    prompt: request.message ?? request.action,
    ...(request.savePatterns.length > 0
      ? { options: permissionOptions(request.savePatterns) }
      : {}),
  };
  return approval;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function optionFor(
  approval: ToolCallMessagePart["approval"],
  id: string,
): ToolApprovalOption | null {
  return approval?.options?.find((option) => option.id === id) ?? null;
}

/** Converts one assistant-ui approval response into the official decision. */
export function toV2PermissionReply(
  request: V2PermissionView,
  response: RespondToToolApprovalOptions,
): "once" | "always" | "reject" {
  const approval = projectV2PermissionApproval(request);
  const hasOptions = (approval?.options?.length ?? 0) > 0;

  if (response.approved === false) {
    if (response.optionId === undefined) return "reject";
    const reject = optionFor(approval, response.optionId);
    if (
      response.optionId === V2_PERMISSION_OPTION_IDS.reject &&
      reject?.kind === "reject-once" &&
      (reject.grants === undefined || reject.grants.length === 0)
    ) {
      return "reject";
    }
    throw new V2PermissionResponseError("Permission rejection does not match the projected reject option.");
  }

  if (response.approved !== true) {
    throw new V2PermissionResponseError("Permission response must explicitly approve or reject.");
  }
  if (response.optionId === undefined) {
    if (!hasOptions) return "once";
    throw new V2PermissionResponseError("An approval option is required for this permission.");
  }

  const selected = optionFor(approval, response.optionId);
  if (!selected) {
    throw new V2PermissionResponseError("The selected permission option is not available.");
  }
  if (
    response.optionId === V2_PERMISSION_OPTION_IDS.once &&
    selected.kind === "allow-once" &&
    (selected.grants === undefined || selected.grants.length === 0)
  ) {
    return "once";
  }
  if (
    response.optionId === V2_PERMISSION_OPTION_IDS.always &&
    selected.kind === "allow-always" &&
    selected.grants !== undefined &&
    selected.grants.length > 0 &&
    sameStrings(selected.grants, request.savePatterns)
  ) {
    return "always";
  }
  throw new V2PermissionResponseError("The selected permission option does not match its projected grants.");
}

/** Returns the assistant-ui option mapping used by the native approval renderer. */
export function bindV2PermissionOptions(
  request: V2PermissionView,
): ReturnType<typeof bindApprovalOptions> {
  const approval = projectV2PermissionApproval(request);
  const binding = bindApprovalOptions(approval?.options);
  for (const presentation of binding.presentation) {
    hostResponseFor(binding, presentation);
  }
  return binding;
}
