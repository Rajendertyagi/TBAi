/**
 * Typed construction helpers for test fixtures.
 *
 * Several services take a `Pick<Conversation, ...>` in which every picked field
 * is REQUIRED, because the picker is about "which fields may be supplied", not
 * "which are mandatory". Tests that only care about a title and a provider were
 * written against the runtime (JavaScript has no such distinction) and pass a
 * two-field literal that does not typecheck.
 *
 * The fix is not `as never` at each site - that would silence the very check that
 * catches a service adding a new required field - but a factory that produces a
 * complete, valid value so a test states only what it actually cares about:
 *
 *     const conv = await conversationService.create(
 *       conversationInput({ title: "Test conv", providerId: "p1" }),
 *     );
 *
 * If the service later requires another field, the factory is the single place
 * that changes, and TypeScript points at it.
 */
// `Conversation` is declared in `src/types`, not re-exported from the storage
// service; importing it from where it is DEFINED keeps the factory tied to the
// contract rather than to a re-export that may be dropped.
import type { Conversation } from "@/types";

/** The shape `conversationService.create` accepts. */
export type ConversationCreateInput = Pick<
  Conversation,
  | "title"
  | "clientRequestId"
  | "providerId"
  | "modelId"
  | "engine"
  | "reasoningLevel"
  | "systemPrompt"
  | "workspaceMode"
  | "workspaceFolderId"
  | "opencodeSessionId"
  | "opencodeAgent"
  | "opencodeModel"
  | "opencodeVariant"
  | "opencodeAutoApprove"
>;

/**
 * Monotonic, so every generated value is unique within a run AND reproducible:
 * no clock and no randomness, which keeps failures reproducible and lets a test
 * assert on an id it created.
 */
let sequence = 0;

function nextClientRequestId(): string {
  sequence += 1;
  return `test-conversation-${sequence}`;
}

/**
 * A complete, valid conversation-creation input.
 *
 * @param overrides Only the fields this test actually exercises; everything else
 *   takes the default that a plain Direct chat would have.
 */
export function conversationInput(overrides: Partial<ConversationCreateInput> = {}): ConversationCreateInput {
  return {
    title: "Test conversation",
    clientRequestId: nextClientRequestId(),
    providerId: null,
    modelId: null,
    engine: "direct",
    reasoningLevel: null,
    systemPrompt: null,
    workspaceMode: "simple",
    workspaceFolderId: null,
    opencodeSessionId: null,
    opencodeAgent: null,
    opencodeModel: null,
    opencodeVariant: null,
    opencodeAutoApprove: false,
    ...overrides,
  };
}