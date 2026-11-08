/**
 * The local record of a prompt the server has not acknowledged yet.
 *
 * ## WHAT THIS OWNS
 *
 * The **local identity** of a prompt (its stable message id, and the way that
 * id travels with assistant-ui's append metadata) and the **optimistic
 * message** the transcript shows while the prompt is still in flight.
 *
 * ## WHAT THIS DOES NOT OWN
 *
 * - **Admission.** Whether the server took the prompt is
 *   `sync/promptsInFlight.ts`'s business, and only the server can settle it.
 * - **Domain state.** The optimistic record this module builds is handed to
 *   the controller, which dispatches it into the reducer. This module holds
 *   no state of its own and mutates nothing.
 *
 * ## WHY THE IDENTITY LIVES HERE
 *
 * A prompt's message id is the thing that ties a local optimistic record to
 * the inbox record the server later sends back. It has to be allocated before
 * the request is sent and it has to survive a round trip through assistant-ui's
 * append metadata, so it is allocated and attached in one place.
 *
 * This module was extracted from `v2ThreadController.ts` as part of Phase 2 of
 * the OpenCode runtime remediation plan. The extraction is behaviour
 * preserving: the same values, the same names, the same exports — the
 * controller re-exports the public symbols, so every importer is unaffected.
 */

import type { AppendMessage, CreateAppendMessage } from "@assistant-ui/react";
import { toV2PromptInput } from "../v2MessageProjection";
import type { V2ThreadState } from "../v2Types";

/** The metadata key the prompt's local message id travels under. */
export const V2_PROMPT_MESSAGE_ID_KEY = "opencodeV2MessageId";

/** The prefix every locally allocated prompt message id carries. */
const V2_MESSAGE_ID_PREFIX = "msg_";

/**
 * Allocates the stable local identity used for prompt admission.
 *
 * @returns A fresh message id, e.g. `msg_<uuid>`.
 */
export function createV2MessageId(): string {
  return `${V2_MESSAGE_ID_PREFIX}${crypto.randomUUID()}`;
}

/**
 * Whether a message id is one this client allocated.
 *
 * The prefix is the client's own vocabulary, so the check belongs with the
 * allocator rather than with the caller that validates a message id.
 *
 * @param messageId - The id to check.
 * @returns True when the id carries the local prefix.
 */
export function isLocalV2MessageId(messageId: string): boolean {
  return messageId.startsWith(V2_MESSAGE_ID_PREFIX);
}

/**
 * Copies a preallocated message id into assistant-ui's append metadata.
 *
 * @param message - The message, or its metadata carrier.
 * @param messageId - The id to attach.
 * @returns The message with the id in its custom metadata.
 */
export function attachV2PromptMessageId(message: string, messageId: string): string;
export function attachV2PromptMessageId<T extends CreateAppendMessage>(
  message: T,
  messageId: string,
): T;
export function attachV2PromptMessageId(
  message: CreateAppendMessage,
  messageId: string,
): CreateAppendMessage {
  if (typeof message === "string") return message;
  return {
    ...message,
    metadata: {
      ...message.metadata,
      custom: {
        ...message.metadata?.custom,
        [V2_PROMPT_MESSAGE_ID_KEY]: messageId,
      },
    },
  };
}

/**
 * Builds the transcript record shown for a prompt that is still in flight.
 *
 * The record is the LOCAL view of the user's message: the server's own
 * message arrives later, with the same id, and replaces it.
 *
 * @param message - The user's message.
 * @param messageId - The locally allocated id of the prompt.
 * @returns The optimistic transcript record.
 */
export function optimisticMessage(
  message: AppendMessage,
  messageId: string,
): V2ThreadState["messages"][string] {
  const payload = toV2PromptInput(message);
  return {
    id: messageId,
    parentId: message.parentId,
    role: "user",
    createdAt: Date.now(),
    parts:
      payload.text.length > 0
        ? [
            {
              kind: "text",
              id: `text:${messageId}:0`,
              order: 0,
              value: payload.text,
              status: "complete",
            },
          ]
        : [],
    source: null,
  };
}
