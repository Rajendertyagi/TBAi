import { useSyncExternalStore } from "react";
import type { OpenCodeRuntimeClient } from "./eventScope";
import type { OpenCodeScope } from "./opencodeScope";
import { logger } from "@/lib/logger";

/**
 * Canonical OpenCode Todo item.
 *
 * Grounded in OpenCode 1.18.31 V2 runtime contract:
 * GET /experimental/tool schema and @opencode-ai/sdk/v2/gen/types.gen.d.ts
 * No ID exists on wire; array order is authoritative.
 */
export interface OpenCodeTodo {
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  priority: "high" | "medium" | "low";
}

export interface OpenCodeTodoState {
  sessionId: string;
  todos: OpenCodeTodo[];
}

type TodoListener = () => void;

/**
 * In-memory projection store for active OpenCode session todos.
 *
 * Lifecycle & Concurrency Guarantees:
 * - Scoped strictly by sessionID.
 * - Monotonic generation: increments on each attachSession / clearSession, never resets.
 * - Monotonic revision: increments on each applied live event (todo.updated).
 * - Hydration safety: captures (generation, revision) at request dispatch. May ONLY apply
 *   if session is still active, generation matches, and revision matches.
 * - Detach safety: clearSession invalidates generation, clears snapshot, and prevents late
 *   hydration or event resurrection.
 * - Reattach safety: increments generation so previous in-flight hydrations cannot write into
 *   the newly attached session.
 * - undefined = no snapshot loaded yet.
 * - [] = authoritative empty state (cleared or initialized with zero todos).
 * - Full replacement snapshot on every update, never merged.
 */
export class OpenCodeTodoStore {
  private snapshots = new Map<string, OpenCodeTodo[]>();
  private activeSessions = new Set<string>();
  private generations = new Map<string, number>();
  private revisions = new Map<string, number>();
  private listeners = new Set<TodoListener>();

  /** Returns whether a session is currently actively attached. */
  isActive(sessionId: string): boolean {
    return this.activeSessions.has(sessionId);
  }

  /** Gets the current monotonic generation for a session. */
  getGeneration(sessionId: string): number {
    return this.generations.get(sessionId) ?? 0;
  }

  /** Gets the current snapshot revision for a session. */
  getRevision(sessionId: string): number {
    return this.revisions.get(sessionId) ?? 0;
  }

  /**
   * Attaches a session to the store.
   * Increments the monotonic generation so any previous in-flight requests cannot apply.
   */
  attachSession(sessionId: string): void {
    const nextGen = (this.generations.get(sessionId) ?? 0) + 1;
    this.generations.set(sessionId, nextGen);
    this.activeSessions.add(sessionId);
    logger.debug("opencode", "todo.session_attached", { sessionId, generation: nextGen });
  }

  /**
   * Detaches a session from the store.
   * Invalidates generation, removes from active sessions, clears snapshot, and notifies listeners.
   */
  clearSession(sessionId: string): void {
    const nextGen = (this.generations.get(sessionId) ?? 0) + 1;
    this.generations.set(sessionId, nextGen);
    this.activeSessions.delete(sessionId);
    const hadSnapshot = this.snapshots.has(sessionId);
    if (hadSnapshot) {
      this.snapshots.delete(sessionId);
      logger.debug("opencode", "todo.session_cleared", { sessionId, generation: nextGen });
      this.notify();
    }
  }

  getSnapshot(sessionId: string | undefined): OpenCodeTodo[] | undefined {
    if (!sessionId) return undefined;
    return this.snapshots.get(sessionId);
  }

  /**
   * Applies a live event update (e.g. from `todo.updated` SSE frame).
   * Only applies if the session is currently active.
   * Replaces the snapshot completely and increments revision.
   */
  applyEventUpdate(sessionId: string, todos: OpenCodeTodo[]): boolean {
    if (!this.activeSessions.has(sessionId)) {
      logger.debug("opencode", "todo.event_ignored_inactive", { sessionId });
      return false;
    }

    const existing = this.snapshots.get(sessionId);
    const nextRev = (this.revisions.get(sessionId) ?? 0) + 1;
    this.revisions.set(sessionId, nextRev);
    this.snapshots.set(sessionId, [...todos]);

    logger.debug("opencode", "todo.snapshot_updated_by_event", {
      sessionId,
      count: todos.length,
      previousCount: existing?.length,
      revision: nextRev,
    });
    this.notify();
    return true;
  }

  /**
   * Applies a hydration result from `client.session.todo()`.
   * May apply ONLY if:
   * 1. session is still active
   * 2. generation matches initial generation (no detach/reattach occurred)
   * 3. revision matches initial revision (no newer live event arrived in the interim)
   */
  applyHydration(
    sessionId: string,
    todos: OpenCodeTodo[],
    capturedGen: number,
    capturedRev: number,
  ): boolean {
    if (!this.activeSessions.has(sessionId)) {
      logger.debug("opencode", "todo.hydration_ignored_inactive", { sessionId });
      return false;
    }

    const currentGen = this.getGeneration(sessionId);
    if (currentGen !== capturedGen) {
      logger.debug("opencode", "todo.hydration_ignored_stale_generation", {
        sessionId,
        capturedGen,
        currentGen,
      });
      return false;
    }

    const currentRev = this.getRevision(sessionId);
    if (currentRev !== capturedRev) {
      logger.debug("opencode", "todo.hydration_ignored_stale_revision", {
        sessionId,
        capturedRev,
        currentRev,
      });
      return false;
    }

    const existing = this.snapshots.get(sessionId);
    this.snapshots.set(sessionId, [...todos]);

    logger.debug("opencode", "todo.snapshot_hydrated", {
      sessionId,
      count: todos.length,
      previousCount: existing?.length,
      generation: currentGen,
      revision: currentRev,
    });
    this.notify();
    return true;
  }

  subscribe(listener: TodoListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (e) {
        logger.error("opencode", "todo.listener_error", {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }
}

export const openCodeTodoStore = new OpenCodeTodoStore();

/**
 * React hook to read the current authoritative OpenCode todos for a session.
 *
 * Returns:
 * - `undefined` while loading / not hydrated yet.
 * - `OpenCodeTodo[]` (possibly `[]`) once hydrated.
 */
export function useOpenCodeTodos(
  sessionId: string | undefined,
): OpenCodeTodo[] | undefined {
  return useSyncExternalStore(
    (callback) => openCodeTodoStore.subscribe(callback),
    () => openCodeTodoStore.getSnapshot(sessionId),
    () => undefined,
  );
}

/**
 * Hydrates authoritative todos for a session directly from `client.session.todo()`.
 * Captures generation and revision at start, and only commits if both remain unchanged.
 */
export async function hydrateSessionTodos(
  client: OpenCodeRuntimeClient,
  scope: OpenCodeScope,
): Promise<void> {
  if (!scope.sessionId || !scope.directory) return;
  const sessionId = scope.sessionId;

  // Capture generation and revision before dispatching async request
  const capturedGen = openCodeTodoStore.getGeneration(sessionId);
  const capturedRev = openCodeTodoStore.getRevision(sessionId);

  try {
    const res = await client.session.todo(
      {
        sessionID: sessionId,
        directory: scope.directory,
      },
      { throwOnError: false },
    );
    if (Array.isArray(res.data)) {
      openCodeTodoStore.applyHydration(
        sessionId,
        res.data as OpenCodeTodo[],
        capturedGen,
        capturedRev,
      );
    }
  } catch (err) {
    logger.debug("opencode", "todo.hydrate_error", {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Checks whether an incoming SSE frame is `todo.updated`, and if so,
 * updates the in-memory projection store with the authoritative snapshot.
 */
export function observeTodoEvent(frame: unknown): void {
  if (frame === null || typeof frame !== "object") return;
  const outer = frame as { type?: unknown; properties?: unknown; payload?: unknown };
  let candidate: { type?: unknown; properties?: unknown } = outer;
  if (outer.payload && typeof outer.payload === "object") {
    candidate = outer.payload as { type?: unknown; properties?: unknown };
  }

  if (candidate.type === "todo.updated" && candidate.properties && typeof candidate.properties === "object") {
    const props = candidate.properties as { sessionID?: unknown; todos?: unknown };
    if (typeof props.sessionID === "string" && Array.isArray(props.todos)) {
      openCodeTodoStore.applyEventUpdate(props.sessionID, props.todos as OpenCodeTodo[]);
    }
  }
}

/**
 * Intercepts the single client event subscription to observe `todo.updated` events
 * in real-time and hydrates the initial snapshot on `server.connected`.
 */
export function applyTodoCompat(
  client: OpenCodeRuntimeClient,
  scope: OpenCodeScope,
): void {
  if (!scope.sessionId || !scope.directory) return;

  const event = client.event;
  const subscribe = event.subscribe.bind(event);

  const todoSubscribe = async (
    parameters?: Parameters<OpenCodeRuntimeClient["event"]["subscribe"]>[0],
    options?: Parameters<OpenCodeRuntimeClient["event"]["subscribe"]>[1],
  ) => {
    const subscription = (await subscribe(parameters, options)) as {
      stream: AsyncIterable<unknown>;
    };

    async function* observeStream(stream: AsyncIterable<unknown>): AsyncGenerator<unknown> {
      for await (const frame of stream) {
        observeTodoEvent(frame);
        yield frame;
      }
    }

    return { ...subscription, stream: observeStream(subscription.stream) };
  };

  event.subscribe = todoSubscribe as unknown as OpenCodeRuntimeClient["event"]["subscribe"];
}
