/**
 * SPIKE module resolver. TEMPORARY, removable.
 *
 * `@ai-sdk/react` and `@assistant-ui/core` are nested under their parents in
 * bun's isolated store, not hoisted into `web/node_modules`, so a file under
 * `web/spikes/` cannot import them by bare specifier. Production code never
 * needs to: `web/src` imports `@assistant-ui/react` (hoisted) and gets
 * `@ai-sdk/react` transitively through `@assistant-ui/ai-sdk`.
 *
 * This re-exports the two nested packages by their resolved paths so the
 * composition spike can import the SAME installed code the runtime uses.
 */

const AI_SDK_REACT =
  "D:/Temp/ai-chat-app/node_modules/.bun/@assistant-ui+ai-sdk@0.0.11+4c71a919fb8f23d6/node_modules/@ai-sdk/react/dist/index.js";

const CORE_INTERNAL =
  "D:/Temp/ai-chat-app/node_modules/.bun/@assistant-ui+core@0.3.24+924560ce4712ad63/node_modules/@assistant-ui/core/dist/internal.js";

/** `useChat`, `Chat` — the AI SDK execution layer. */
export const { useChat, Chat } = (await import(AI_SDK_REACT)) as {
  useChat: unknown;
  Chat: unknown;
};

/** `ExportedMessageRepository` — the bounded-repository primitive. */
export const { ExportedMessageRepository } = (await import(CORE_INTERNAL)) as {
  ExportedMessageRepository: unknown;
};