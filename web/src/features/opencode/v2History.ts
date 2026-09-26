import type {
  MessageListInput,
  SessionMessageInfo,
  SessionMessagesResponse,
} from "@opencode/client";
import { OPENCODE_V2_HISTORY_PAGE_SIZE } from "@/config/opencode";
import type { V2HistoryReader } from "./v2Client";
import type {
  V2HistorySnapshot,
  V2MessagePartState,
  V2MessageState,
} from "./v2Types";
import { deriveV2ToolCallId, type V2PermissionView } from "./v2Permissions";
import type { V2HistoryProjection } from "./v2MessageProjection";

/** Loads every history page through the generation-bound reader. */
export async function loadV2History(
  reader: V2HistoryReader,
  options: { readonly signal?: AbortSignal } = {},
): Promise<V2HistorySnapshot> {
  const pages: SessionMessageInfo[][] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pageCount = 0;

  do {
    if (options.signal?.aborted) throw new DOMException("History load aborted", "AbortError");
    const input: MessageListInput = cursor === undefined
      ? { sessionID: reader.sessionId, order: "desc", limit: OPENCODE_V2_HISTORY_PAGE_SIZE }
      : { sessionID: reader.sessionId, cursor };
    const response: SessionMessagesResponse = await reader.list(input);
    if (options.signal?.aborted) throw new DOMException("History load aborted", "AbortError");
    pages.push(response.data);
    pageCount += 1;
    const next = response.cursor.next ?? undefined;
    if (next !== undefined) {
      if (seenCursors.has(next)) throw new Error("OpenCode V2 history returned a repeated cursor");
      seenCursors.add(next);
    }
    cursor = next;
  } while (cursor !== undefined);

  const byId = new Map<string, SessionMessageInfo>();
  for (const page of pages) {
    for (const message of page) byId.set(message.id, message);
  }
  return {
    messages: [...byId.values()].reverse(),
    pages: pageCount,
  };
}

function roleForMessage(message: SessionMessageInfo): V2MessageState["role"] {
  switch (message.type) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "system":
    case "shell":
      return "system";
    default:
      return "record";
  }
}

function messageTime(message: SessionMessageInfo): number {
  return "time" in message && message.time && typeof message.time.created === "number"
    ? message.time.created
    : 0;
}

function partsForMessage(message: SessionMessageInfo): readonly V2MessagePartState[] {
  if (message.type === "system") {
    return [{
      kind: "text",
      id: `text:${message.id}:0`,
      order: 0,
      value: message.text,
      status: "complete",
    }];
  }
  if (message.type === "shell") {
    const output = message.output?.output ?? "";
    return [{
      kind: "text",
      id: `text:${message.id}:0`,
      order: 0,
      value: output.length > 0 ? `${message.command}\n${output}` : message.command,
      status: message.time.completed === undefined ? "streaming" : "complete",
    }];
  }
  if (message.type === "user") {
    return message.text.length > 0
      ? [{ kind: "text", id: `text:${message.id}:0`, order: 0, value: message.text, status: "complete" }]
      : [];
  }
  if (message.type !== "assistant") return [];
  const parts: V2MessagePartState[] = [];
  message.content.forEach((content, index) => {
    if (content.type === "text") {
      parts.push({ kind: "text", id: `text:${message.id}:${index}`, order: index, value: content.text, status: "complete" });
    } else if (content.type === "reasoning") {
      parts.push({ kind: "reasoning", id: `reasoning:${message.id}:${index}`, order: index, value: content.text, status: content.time?.completed === undefined ? "streaming" : "complete" });
    } else if (content.type === "tool") {
      const status = content.state.status === "completed" ? "complete" : content.state.status === "error" ? "error" : content.state.status === "running" || content.state.status === "streaming" ? "running" : "pending";
      const metadata = "metadata" in content.state ? content.state.metadata : undefined;
      parts.push({
        kind: "tool",
        id: `tool:${message.id}:${content.id}`,
        order: index,
        name: content.name,
        input: typeof content.state.input === "string"
          ? { text: content.state.input }
          : content.state.input ?? {},
        output: content.state.status === "completed"
           ? content.state.content
           : content.state.status === "error"
             ? {
                 error: content.state.error.message,
                 type: content.state.error.type,
                 ...(content.state.content === undefined ? {} : { content: content.state.content }),
               }
             : undefined,
         ...(metadata === undefined ? {} : { metadata }),
        status,
        permissionId: null,
      });
    }
  });
  if (message.retry !== undefined) {
    parts.push({ kind: "retry", id: `retry:${message.id}`, order: parts.length, value: message.retry.error.message });
  }
  return parts;
}

function attachPermissions(
  message: V2MessageState,
  permissions: readonly V2PermissionView[],
): V2MessageState {
  if (message.role !== "assistant") return message;
  return {
    ...message,
    parts: message.parts.map((part) => {
      if (part.kind !== "tool" || part.id === null) return part;
      const permission = permissions.find((candidate) => {
        if (candidate.sourceMessageID !== message.id || candidate.sourceToolId === null) return false;
        return deriveV2ToolCallId(message.id, candidate.sourceToolId) === deriveV2ToolCallId(message.id, part.id.replace(`tool:${message.id}:`, ""));
      });
      return permission ? { ...part, permissionId: permission.id } : part;
    }),
  };
}

/** Projects one official history snapshot into normalized chronological state. */
export function projectV2History(
  snapshot: V2HistorySnapshot,
  permissions: readonly V2PermissionView[],
): V2HistoryProjection {
  let parentId: string | null = null;
  const messages = snapshot.messages.map((source) => {
    const message: V2MessageState = {
      id: source.id,
      parentId,
      role: roleForMessage(source),
      createdAt: messageTime(source),
      parts: partsForMessage(source),
      source,
    };
    parentId = source.id;
    return attachPermissions(message, permissions);
  });
  return {
    messages,
    messageOrder: messages.map((message) => message.id),
    pages: snapshot.pages,
  };
}
