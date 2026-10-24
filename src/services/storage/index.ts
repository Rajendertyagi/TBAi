/**
 * Persistence barrel.
 *
 * Three independent conversation aggregates over three tables -
 * conversations, messages and memories - plus the OpenCode session recovery
 * journal, which is its own table and its own obligation. They are exported
 * from one module so that `@/services/storage` keeps naming the whole
 * persistence layer for callers that legitimately touch more than one of them
 * (the chat route assembles a run and persists its messages in the same step).
 *
 * Each aggregate lives in its own module - `conversations.ts`,
 * `messages.ts`, `memories.ts`, `opencodeSessionOrphans.ts` - because none of
 * them references another. Import the specific module when that is all you
 * need.
 */
export * from "./conversations";
export * from "./messages";
export * from "./memories";
export * from "./opencodeSessionOrphans";
