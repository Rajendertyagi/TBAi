import { useAuiState } from "@assistant-ui/react";
import type { FormInfo, SessionFormReplyInput, SessionInfo } from "@opencode/client";
import type { V2PermissionView } from "./v2Permissions";
import type { OpenCodeTodo } from "./v2Todos";
import type {
  V2DesiredSelection,
  V2ThreadState,
} from "./v2Types";
import type {
  V2PromptAdmissionResult,
  V2ThreadController,
} from "./v2ThreadController";

/** The typed native runtime surface exposed through assistant-ui extras. */
export interface V2RuntimeExtras {
  readonly kind: "tbai-opencode-v2";
  readonly sessionId: string;
  readonly session: SessionInfo | null;
  readonly state: V2ThreadState;
  readonly model: V2ThreadState["model"];
  readonly agent: string | null;
  readonly desiredModel: V2ThreadState["desiredModel"];
  readonly desiredAgent: string | null;
  readonly permissions: readonly V2PermissionView[];
  readonly forms: readonly FormInfo[];
  readonly todos: readonly OpenCodeTodo[];
  setDesiredSelection(selection: V2DesiredSelection): void;
  awaitReady(): Promise<void>;
  refresh(): Promise<void>;
  reconcileStagedRevert(): Promise<void>;
  reconcilePendingPrompt(messageId: string): Promise<"admitted" | "absent" | "unresolved">;
  awaitPromptAdmission(messageId: string): Promise<V2PromptAdmissionResult>;
  cancel(): Promise<void>;
  compact(): Promise<void>;
  regenerate(selectedAssistantParentId: string | null): Promise<void>;
  replyToPermission(requestId: string, decision: "once" | "always" | "reject"): Promise<void>;
  reconcileAutoApprove(): Promise<number>;
  replyToForm(formId: string, answer: SessionFormReplyInput["answer"]): Promise<void>;
  rejectForm(formId: string): Promise<void>;
}

/** Creates the stable extras object for one controller snapshot. */
export function createV2RuntimeExtras(
  controller: V2ThreadController,
  state: V2ThreadState,
  permissions: readonly V2PermissionView[],
  todos: readonly OpenCodeTodo[],
): V2RuntimeExtras {
  return {
    kind: "tbai-opencode-v2",
    sessionId: controller.getState().sessionId,
    session: state.session,
    state,
    model: state.model,
    agent: state.agent,
    desiredModel: state.desiredModel,
    desiredAgent: state.desiredAgent,
    permissions,
    forms: state.forms,
    todos,
    setDesiredSelection: (selection) => controller.setDesiredSelection(selection),
    awaitReady: () => controller.awaitReady(),
    refresh: () => controller.refresh(),
    reconcileStagedRevert: () => controller.reconcileStagedRevert(),
    reconcilePendingPrompt: (messageId) => controller.reconcilePendingPrompt(messageId),
    awaitPromptAdmission: (messageId) => controller.awaitPromptAdmission(messageId),
    cancel: () => controller.cancel(),
    compact: () => controller.compact(),
    regenerate: (parentId) => controller.regenerate(parentId),
    replyToPermission: (requestId, decision) => controller.replyToPermission(requestId, decision),
    reconcileAutoApprove: () => controller.reconcileAutoApprove(),
    replyToForm: (formId, answer) => controller.replyToForm(formId, answer),
    rejectForm: (formId) => controller.rejectForm(formId),
  };
}

/** Narrows an assistant-ui extras value to the native OpenCode V2 contract. */
export function isV2RuntimeExtras(value: unknown): value is V2RuntimeExtras {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as { readonly kind?: unknown };
  return candidate.kind === "tbai-opencode-v2";
}

/** Reads native extras when the surrounding Code provider is mounted. */
export function useOptionalV2RuntimeExtras(): V2RuntimeExtras | null {
  const extras = useAuiState((state) => state.thread.extras);
  return isV2RuntimeExtras(extras) ? extras : null;
}

/** Reads native extras and fails visibly for Code-only consumers. */
export function useV2RuntimeExtras(): V2RuntimeExtras {
  const extras = useOptionalV2RuntimeExtras();
  if (extras === null) throw new Error("Native OpenCode V2 runtime extras are unavailable");
  return extras;
}
