import { getWelcomeScopeSnapshot } from "./welcomeScope";
import { getWelcomeEngineSnapshot } from "./welcomeEngine";
import { useSettingsStore } from "../../../stores";

/**
 * Single owner of draft materialization (Phase 4).
 *
 * Both first-send paths — the Direct runtime's `adapter.initialize()` and
 * the OpenCode draft custom send — converge here, so one draft resolves to
 * exactly one bound conversation. The snapshot is captured ONCE per send
 * (immutable afterwards): the engine chosen for materialization stays stable
 * for that first send, and no mutable welcome-engine state is re-read after
 * the decision. The owner also records id→engine for `handleThreadIdChange`
 * so tab binding cannot observe a different engine than the row was created
 * with (take-once; row reconciliation remains the backstop).
 */

export interface DraftSnapshot {
  engine: "direct" | "opencode";
  providerId: string | null;
  modelId: string | null;
  reasoningLevel: string | null;
  workspaceMode: "simple" | "project";
  workspaceFolderId: string | null;
  opencodeAgent: string | null;
  opencodeModel: string | null;
  opencodeVariant: string | null;
  opencodeAutoApprove: boolean;
  clientRequestId: string;
}

function newClientRequestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `draft-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  }
}

// Stable across retries of the same draft: a failed create that actually
// committed server-side must replay the SAME key so the server resolves it
// to the existing row instead of minting a duplicate. Cleared on success.
// Single draft tab (`chat:new` is a singleton key), so one slot suffices.
let draftClientRequestId: string | null = null;

export function currentDraftClientRequestId(): string {
  if (!draftClientRequestId) draftClientRequestId = newClientRequestId();
  return draftClientRequestId;
}

function clearDraftClientRequestId(): void {
  draftClientRequestId = null;
}

// id→engine record written at materialization. Read nondestructively by
// runtime guards (tab binding, send interception) so independent readers
// never race each other; entries expire via the cap, never by consumption.
const materializedEngines = new Map<string, "direct" | "opencode">();
const ENGINE_RECORD_LIMIT = 50;

/** Engine the single owner used when materializing this conversation (take-once). */
export function takeMaterializedEngine(conversationId: string): "direct" | "opencode" | null {
  const engine = peekMaterializedEngine(conversationId);
  materializedEngines.delete(conversationId);
  return engine;
}

/** Non-destructive read of the owner record (see above). */
export function peekMaterializedEngine(conversationId: string): "direct" | "opencode" | null {
  return materializedEngines.get(conversationId) ?? null;
}

function recordMaterializedEngine(conversationId: string, engine: "direct" | "opencode"): void {
  if (materializedEngines.size >= ENGINE_RECORD_LIMIT) {
    const oldest = materializedEngines.keys().next().value;
    if (oldest !== undefined) materializedEngines.delete(oldest);
  }
  materializedEngines.set(conversationId, engine);
}

/**
 * One immutable read of everything a draft send needs. Direct picks come
 * from the one-shot picker state; OpenCode picks from the welcome-engine
 * store. Absent stays absent (server concretizes nothing — Phase 2).
 */
export function captureDraftSnapshot(): DraftSnapshot {
  let scope: { mode?: string; folderId?: string | null } = {};
  let draft: {
    engine?: string;
    agent?: string | null;
    model?: string | null;
    variant?: string | null;
    autoApprove?: unknown;
  } = {};
  try {
    scope = getWelcomeScopeSnapshot();
    draft = getWelcomeEngineSnapshot();
  } catch {
    /* welcome stores unavailable — fall back to a disposable direct chat */
  }
  const pick = useSettingsStore.getState();
  const engine = draft.engine === "opencode" ? "opencode" : "direct";
  return {
    engine,
    providerId: engine === "direct" ? (pick.selectedProviderId ?? null) : null,
    modelId: engine === "direct" ? (pick.selectedModelId ?? null) : null,
    reasoningLevel: engine === "direct" ? (pick.selectedReasoningLevel ?? null) : null,
    workspaceMode: scope.mode === "project" && scope.folderId ? "project" : "simple",
    workspaceFolderId: scope.mode === "project" && scope.folderId ? scope.folderId : null,
    opencodeAgent: engine === "opencode" ? draft.agent || null : null,
    opencodeModel: engine === "opencode" ? draft.model || null : null,
    opencodeVariant: engine === "opencode" ? draft.variant || null : null,
    // `=== true`, not the value itself: only an explicit boolean true arms
    // the shield (same fail-closed rule as the config read).
    opencodeAutoApprove: engine === "opencode" ? draft.autoApprove === true : false,
    clientRequestId: currentDraftClientRequestId(),
  };
}

async function postConversations(body: Record<string, unknown>): Promise<{ id: string }> {
  const res = await fetch("/api/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(
      `Failed to create conversation (${res.status}): ${(detail as { error?: string }).error ?? "unknown error"}`,
    );
  }
  const conv = (await res.json()) as { id?: string };
  if (!conv.id) throw new Error("Conversation creation returned no id");
  return { id: conv.id };
}

/**
 * Materialize the snapshot into exactly one conversation row. Stale project
 * folders retry once as simple (same fields, same idempotency key).
 * Contract: never resolve with an undefined id; throw so the failure stays
 * visible and the draft (text included) is retained. No thread/runtime
 * binding here — the caller binds after it owns the id.
 */
export async function materializeDraft(snapshot: DraftSnapshot): Promise<{ id: string }> {
  const body: Record<string, unknown> = {
    title: "New Conversation",
    workspaceMode: snapshot.workspaceMode,
    workspaceFolderId: snapshot.workspaceFolderId,
    engine: snapshot.engine,
    providerId: snapshot.providerId,
    modelId: snapshot.modelId,
    reasoningLevel: snapshot.reasoningLevel,
    opencodeAgent: snapshot.opencodeAgent,
    opencodeModel: snapshot.opencodeModel,
    opencodeVariant: snapshot.opencodeVariant,
    opencodeAutoApprove: snapshot.opencodeAutoApprove,
    clientRequestId: snapshot.clientRequestId,
  };
  try {
    if (snapshot.workspaceMode === "project") {
      try {
        const created = await postConversations(body);
        recordMaterializedEngine(created.id, snapshot.engine);
        clearDraftClientRequestId();
        return created;
      } catch {
        // Edge: stale project folder rejected — retry once as simple so the
        // user never sits on a dead draft. Same idempotency key.
        const created = await postConversations({
          ...body,
          workspaceMode: "simple",
          workspaceFolderId: null,
        });
        recordMaterializedEngine(created.id, snapshot.engine);
        clearDraftClientRequestId();
        return created;
      }
    }
    const created = await postConversations(body);
    recordMaterializedEngine(created.id, snapshot.engine);
    clearDraftClientRequestId();
    return created;
  } catch (err) {
    // Key retained: a retry replays the same identity so a commit the client
    // never saw still resolves to one row.
    throw err;
  }
}
