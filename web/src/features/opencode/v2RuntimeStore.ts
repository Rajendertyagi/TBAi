import {
  ExportedMessageRepository,
  MessageNotSentError,
  type AppendMessage,
  type ExternalStoreAdapter,
  type ThreadMessage,
} from "@assistant-ui/react";
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

/**
 * Builds the external-store adapter for one native controller snapshot.
 *
 * Kept private: callers go through `createV2RuntimeStoreFactory`, which is
 * what makes the returned references stable across events.
 */
function buildV2RuntimeStore(
  controller: V2ThreadController,
  state: V2ThreadState,
  conversationId: string | null,
  messageRepository: ExportedMessageRepository,
  permissions: readonly V2PermissionView[],
): ExternalStoreAdapter<ThreadMessage> & { readonly extras: V2RuntimeExtras } {
  const extras = createV2RuntimeExtras(controller, state, permissions);
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

/**
 * The three state references the message projection reads, held so an
 * unchanged transcript can be recognised without re-deriving it.
 *
 * `projectV2RepositoryItems` reads exactly `messages`, `messageOrder` and
 * `permissions` (see `v2MessageProjection.ts`), and the reducer builds every
 * state with `{ ...state }`, so all three keep their identity across events
 * that do not touch them. That identity is what lets the repository be reused.
 */
type RepositoryCacheEntry = {
  readonly messages: V2ThreadState["messages"];
  readonly messageOrder: V2ThreadState["messageOrder"];
  readonly permissions: V2ThreadState["permissions"];
  readonly repository: ExportedMessageRepository;
  readonly permissionViews: readonly V2PermissionView[];
};

/**
 * Creates a per-session adapter builder that keeps its references stable
 * across events.
 *
 * assistant-ui compares the incoming adapter against the previous one by
 * reference (`external-store-thread-runtime-core.js:181`) and, when the
 * repository matches, skips the O(messages) `addOrUpdateMessage` /
 * `export` / `deleteMessage` walk entirely. Building a fresh repository on
 * every event defeated that check and ran the full walk on every token delta.
 *
 * The cache lives in this closure rather than at module scope so two open
 * sessions cannot evict each other's entry, and it is discarded with the
 * controller it was built for.
 *
 * `extras` is deliberately NOT memoized: it embeds the whole
 * `V2ThreadState`, and the context ring and status chip read
 * `extras.state.*` live. Holding it stable would hand them a stale snapshot.
 * A new extras object is a plain assignment in assistant-ui (line 159) and
 * costs nothing next to the repository walk it gates.
 *
 * @param controller - The controller whose state this builder is fed.
 * @param conversationId - Conversation identity for the thread-list adapter.
 * @returns A function mapping one state snapshot to an adapter.
 */
export function createV2RuntimeStoreFactory(
  controller: V2ThreadController,
  conversationId: string | null,
): (state: V2ThreadState) => ExternalStoreAdapter<ThreadMessage> & { readonly extras: V2RuntimeExtras } {
  let cache: RepositoryCacheEntry | null = null;

  return (state: V2ThreadState) => {
    if (
      cache === null
      || cache.messages !== state.messages
      || cache.messageOrder !== state.messageOrder
      || cache.permissions !== state.permissions
    ) {
      const items = projectV2RepositoryItems(state);
      cache = {
        messages: state.messages,
        messageOrder: state.messageOrder,
        permissions: state.permissions,
        repository: ExportedMessageRepository.fromBranchableArray(items, {
          headId: repositoryHeadId(items),
        }),
        // Derived from the same `permissions` reference the repository was
        // built from, so both stay in step: one arrival invalidates both.
        permissionViews: permissionViews(state),
      };
    }
    return buildV2RuntimeStore(
      controller,
      state,
      conversationId,
      cache.repository,
      cache.permissionViews,
    );
  };
}
