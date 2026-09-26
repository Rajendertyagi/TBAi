import type {
  AppendMessage,
  ThreadMessageLike,
} from "@assistant-ui/react";
import type {
  SessionMessageUser,
  SessionPromptInput,
} from "@opencode/client";
import {
  deriveV2ToolCallId,
  projectV2Permission,
  projectV2PermissionApproval,
  type V2PermissionView,
} from "./v2Permissions";
import type { V2MessagePartState, V2MessageState, V2ThreadState } from "./v2Types";

/** A branchable assistant-ui message item with its explicit parent. */
export interface V2BranchableMessageItem {
  readonly message: ThreadMessageLike;
  readonly parentId: string | null;
}

/** The normalized result of one complete history read. */
export interface V2HistoryProjection {
  readonly messages: readonly V2MessageState[];
  readonly messageOrder: readonly string[];
  readonly pages: number;
}

/** Prompt data derived from assistant-ui input without crossing the wire boundary. */
export interface V2PromptPayload {
  readonly text: string;
  readonly files: NonNullable<SessionPromptInput["files"]>;
  readonly agents: NonNullable<SessionPromptInput["agents"]>;
  readonly skills: NonNullable<SessionPromptInput["skills"]>;
}

type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
type JsonObject = Readonly<Record<string, JsonValue>>;

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === "object") return Object.values(value).every(isJsonValue);
  return false;
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) && isJsonValue(value);
}

function jsonObject(value: Readonly<Record<string, unknown>>): JsonObject {
  return isJsonObject(value) ? value : {};
}

function fileUri(value: string, mimeType?: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("OpenCode prompt attachments must use a valid data: or file: URI");
  }
  if (parsed.protocol !== "data:" && parsed.protocol !== "file:") {
    throw new TypeError("OpenCode prompt attachments must use data: or file: URIs");
  }
  if (parsed.protocol === "data:" && !mimeType && !value.startsWith("data:")) {
    throw new TypeError("Inline prompt data requires a MIME type");
  }
  return value;
}

function historyFileUri(file: NonNullable<SessionMessageUser["files"]>[number]): string {
  if (file.source.type === "uri") return fileUri(file.source.uri);
  if (!file.mime || file.mime.length === 0) {
    throw new TypeError("Inline prompt files require a MIME type");
  }
  return `data:${file.mime};base64,${file.data}`;
}

function textFromAppendMessage(message: AppendMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part): part is Extract<typeof part, { readonly type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function filesFromAppendMessage(message: AppendMessage): V2PromptPayload["files"] {
  if (typeof message.content === "string") return [];
  return message.content.flatMap((part) => {
    if (part.type === "file") {
      return [{
        uri: fileUri(part.data, part.mimeType),
        ...(part.filename ? { name: part.filename } : {}),
      }];
    }
    if (part.type === "image") {
      if (!part.image.startsWith("data:") && !part.image.startsWith("file:")) {
        throw new TypeError("OpenCode prompt images must use data: or file: URIs");
      }
      return [{ uri: fileUri(part.image) }];
    }
    return [];
  });
}

/** Converts an assistant-ui append message to the official V2 prompt shape. */
export function toV2PromptInput(message: AppendMessage): V2PromptPayload {
  return {
    text: textFromAppendMessage(message),
    files: filesFromAppendMessage(message),
    agents: [],
    skills: [],
  };
}

/** Converts one official history user message for regenerate/admission. */
export function toV2PromptPayloadFromHistory(message: SessionMessageUser): V2PromptPayload {
  return {
    text: message.text,
    files: (message.files ?? []).map((file) => ({
      uri: historyFileUri(file),
      ...(file.name ? { name: file.name } : {}),
      ...(file.description ? { description: file.description } : {}),
      ...(file.mention ? { mention: file.mention } : {}),
    })),
    agents: (message.agents ?? []).map((agent) => ({
      name: agent.name,
      ...(agent.mention ? { mention: agent.mention } : {}),
    })),
    skills: (message.skills ?? []).map((skill) => ({
      id: skill.id,
      ...(skill.mention ? { mention: skill.mention } : {}),
    })),
  };
}

type AssistantContent = Exclude<ThreadMessageLike["content"], string>[number];

function partToAssistantContent(
  part: V2MessagePartState,
  message: V2MessageState,
  permissions: readonly V2PermissionView[],
): AssistantContent {
  if (part.kind === "text") return { type: "text", text: part.value, status: { type: part.status === "streaming" ? "running" : "complete" } };
  if (part.kind === "reasoning") return { type: "reasoning", text: part.value, status: { type: part.status === "streaming" ? "running" : "complete" } };
  if (part.kind === "step") return { type: "text", text: "", status: { type: "complete" } };
  if (part.kind === "retry") return { type: "text", text: part.value, status: { type: "complete" } };
  const sourceContent = message.source?.type === "assistant" ? message.source.content : [];
  const sourceTool = sourceContent.find(
    (content) => content.type === "tool" && `tool:${message.id}:${content.id}` === part.id,
  );
  const toolPartPrefix = `tool:${message.id}:`;
  const officialToolId = sourceTool?.type === "tool"
    ? sourceTool.id
    : part.id.startsWith(toolPartPrefix)
      ? part.id.slice(toolPartPrefix.length)
      : undefined;
  const toolCallId = officialToolId === undefined
    ? part.id
    : deriveV2ToolCallId(message.id, officialToolId);
  const permission = permissions.find((candidate) => candidate.toolCallId === toolCallId);
  return {
    type: "tool-call",
    toolCallId,
    toolName: part.name,
    args: jsonObject(part.input),
    argsText: JSON.stringify(part.input),
    result: part.status === "running" || part.status === "pending" ? undefined : part.output,
    isError: part.status === "error",
    ...(permission ? { approval: projectV2PermissionApproval(permission) } : {}),
  };
}

function openCodePartsForMessage(message: V2MessageState): readonly unknown[] {
  if (message.source?.type === "assistant") return message.source.content;
  return message.parts.flatMap((part) => {
    if (part.kind !== "tool") return [];
    const prefix = `tool:${message.id}:`;
    const id = part.id.startsWith(prefix) ? part.id.slice(prefix.length) : part.id;
    const status = part.status === "complete"
      ? "completed"
      : part.status === "error"
        ? "error"
        : "running";
    const content = Array.isArray(part.output) ? part.output : [];
    return [{
      type: "tool",
      id,
      name: part.name,
      state: {
        status,
        input: part.input,
        ...(content.length > 0 ? { content } : {}),
        ...(part.metadata === undefined ? {} : { metadata: part.metadata }),
      },
    }];
  });
}

function messageToAssistant(
  message: V2MessageState,
  permissions: readonly V2PermissionView[],
): ThreadMessageLike | null {
  if (message.role === "record") return null;
  const openCodeParts = openCodePartsForMessage(message);
  const content = message.parts.flatMap((part) => {
    const projected = partToAssistantContent(part, message, permissions);
    return Array.isArray(projected) ? projected : [projected];
  });
  return {
    id: message.id,
    role: message.role,
    content,
    createdAt: new Date(message.createdAt),
    ...(message.role === "assistant" && openCodeParts.length > 0
      ? { metadata: { custom: { opencode: { parts: openCodeParts } } } }
      : {}),
  };
}

/** Projects the current state into branchable assistant-ui repository items. */
export function projectV2RepositoryItems(
  state: V2ThreadState,
): readonly V2BranchableMessageItem[] {
  const permissions: readonly V2PermissionView[] = state.permissions
    .map(projectV2Permission)
    .filter((permission): permission is V2PermissionView => permission !== null);
  const result: V2BranchableMessageItem[] = [];
  let parentId: string | null = null;
  for (const id of state.messageOrder) {
    const message = state.messages[id];
    if (message === undefined) continue;
    const projected = messageToAssistant(message, permissions);
    if (projected === null) continue;
    result.push({ message: projected, parentId });
    parentId = message.id;
  }
  return result;
}

/** Returns the explicit assistant-ui repository head id. */
export function repositoryHeadId(
  items: readonly V2BranchableMessageItem[],
): string | null {
  return items.at(-1)?.message.id ?? null;
}
