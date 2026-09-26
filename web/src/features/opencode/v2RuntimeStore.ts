import {
  ExportedMessageRepository,
  MessageNotSentError,
  type AppendMessage,
  type ExternalStoreAdapter,
  type ThreadMessage,
} from "@assistant-ui/react";
import { deriveLatestOpenCodeTodos } from "./v2Todos";
import {
  projectV2Permission,
  toV2PermissionReply,
  type V2PermissionView,
} from "./v2Permissions";
import {
  createV2RuntimeExtras,
  type V2RuntimeExtras,
} from "./v2RuntimeExtras";
import {
  projectV2RepositoryItems,
  repositoryHeadId,
} from "./v2MessageProjection";
import { createV2ThreadListAdapter } from "./v2ThreadList";
import type { V2ThreadController } from "./v2ThreadController";
import type { V2ThreadState } from "./v2Types";

function executionIsRunning(state: V2ThreadState): boolean {
  return state.execution.type === "submitting" || state.execution.type === "admitted" || state.execution.type === "reconciling" || state.execution.type === "executing" || state.execution.type === "streaming" || state.execution.type === "cancelling";
}

function permissionViews(state: V2ThreadState): readonly V2PermissionView[] {
  return state.permissions
    .map(projectV2Permission)
    .filter((permission): permission is V2PermissionView => permission !== null);
}

function toMessageNotSentError(error: unknown): MessageNotSentError {
  if (error instanceof MessageNotSentError) return error;
  const message = error instanceof Error ? error.message : "OpenCode V2 prompt could not be sent";
  return new MessageNotSentError(message);
}

/** Builds the external-store adapter for one native controller snapshot. */
export function createV2RuntimeStore(
  controller: V2ThreadController,
  state: V2ThreadState,
  conversationId: string | null,
): ExternalStoreAdapter<ThreadMessage> & { readonly extras: V2RuntimeExtras } {
  const repositoryItems = projectV2RepositoryItems(state);
  const messageRepository = ExportedMessageRepository.fromBranchableArray(repositoryItems, {
    headId: repositoryHeadId(repositoryItems),
  });
  const permissions = permissionViews(state);
  const extras = createV2RuntimeExtras(controller, state, permissions, deriveLatestOpenCodeTodos(state));
  const adapter: ExternalStoreAdapter<ThreadMessage> & { readonly extras: V2RuntimeExtras } = {
    messageRepository,
    isLoading: state.load.type !== "ready",
    isRunning: executionIsRunning(state),
    isSendDisabled: state.revertRecovery.type !== "none",
    extras,
    adapters: { threadList: createV2ThreadListAdapter(state, conversationId) },
    setMessages: (messages) => {
      controller.reconcileRuntimeMessageIds(messages.map((message) => message.id));
    },
    onNew: async (message: AppendMessage) => {
      try {
        await controller.sendMessage(message);
      } catch (error) {
        throw toMessageNotSentError(error);
      }
    },
    onCancel: () => controller.cancel(),
    onReload: async (parentId: string | null) => {
      await controller.regenerate(parentId);
    },
    onRefetchThread: () => controller.refresh(),
    onRespondToToolApproval: async (options) => {
      const request = state.permissions.find((candidate) => candidate.id === options.approvalId);
      const permission = request === undefined ? null : projectV2Permission(request);
      if (permission === null) throw new Error("OpenCode V2 permission is unavailable");
      await controller.replyToPermission(permission.id, toV2PermissionReply(permission, options));
    },
  };
  return adapter;
}
