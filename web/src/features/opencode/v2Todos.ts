import type { V2MessageState, V2ThreadState } from "./v2Types";

/** A normalized todo item from the latest usable OpenCode `todowrite` call. */
export interface OpenCodeTodo {
  readonly content: string;
  readonly status: "pending" | "in_progress" | "completed" | "cancelled";
  readonly priority: "high" | "medium" | "low";
}

function isTodoStatus(value: unknown): value is OpenCodeTodo["status"] {
  return value === "pending" || value === "in_progress" || value === "completed" || value === "cancelled";
}

function isTodoPriority(value: unknown): value is OpenCodeTodo["priority"] {
  return value === "high" || value === "medium" || value === "low";
}

function projectTodo(value: unknown): OpenCodeTodo | null {
  if (value === null || typeof value !== "object") return null;
  if (!("content" in value) || !("status" in value) || !("priority" in value)) return null;
  if (
    typeof value.content !== "string" ||
    !isTodoStatus(value.status) ||
    !isTodoPriority(value.priority)
  ) {
    return null;
  }
  return { content: value.content, status: value.status, priority: value.priority };
}

function todosFromMessage(message: V2MessageState): readonly OpenCodeTodo[] | null {
  for (const part of message.parts) {
    if (part.kind !== "tool" || part.name !== "todowrite") continue;
    if (part.input === null || typeof part.input !== "object") continue;
    const todos = part.input.todos;
    if (!Array.isArray(todos)) continue;
    const projected: OpenCodeTodo[] = [];
    for (const todo of todos) {
      const item = projectTodo(todo);
      if (item !== null) projected.push(item);
    }
    return projected;
  }
  return null;
}

/** Derives todos only from the newest valid `todowrite` tool input in history/live state. */
export function deriveLatestOpenCodeTodos(
  state: V2ThreadState,
): readonly OpenCodeTodo[] {
  for (let index = state.messageOrder.length - 1; index >= 0; index -= 1) {
    const message = state.messages[state.messageOrder[index]];
    if (message === undefined) continue;
    const todos = todosFromMessage(message);
    if (todos !== null) return todos;
  }
  return [];
}
