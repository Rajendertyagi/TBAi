/**
 * SPIKE HARNESS — P2 Candidate D. TEMPORARY, REMOVABLE.
 *
 * Builds a deterministic synthetic thread and drives the REAL installed
 * assistant-ui runtime core against it. No React, no DOM, no network, and no
 * copied assistant-ui internals: everything goes through the package's own
 * `internal` barrel.
 *
 * Purpose: answer, by execution rather than by reading source,
 *   - can a bounded external store replace the repository (evict)?
 *   - can older messages be prepended with stable ids?
 *   - does eviction remove messages the store still needs?
 *   - what does append/edit/regenerate do against a bounded window?
 */

import * as core from "D:/Temp/ai-chat-app/node_modules/.bun/@assistant-ui+core@0.3.24+924560ce4712ad63/node_modules/@assistant-ui/core/dist/internal.js";

export const { ExternalStoreThreadRuntimeCore, MessageRepository, ExportedMessageRepository } =
  core;

/* ------------------------------------------------------------------ *
 * Synthetic thread
 * ------------------------------------------------------------------ */

export const CHAIN_LENGTH = 500;

export type UiMessage = {
  id: string;
  role: "user" | "assistant";
  content: Array<{ type: "text"; text: string }>;
};

/** m1..mN, alternating user/assistant. */
export function buildChain(length = CHAIN_LENGTH): UiMessage[] {
  const out: UiMessage[] = [];
  for (let i = 1; i <= length; i += 1) {
    out.push({
      id: `m${i}`,
      role: i % 2 === 1 ? "user" : "assistant",
      content: [{ type: "text", text: `body ${i}` }],
    });
  }
  return out;
}

/** Inclusive 1-based slice, matching the spike's notation [451..500]. */
export function sliceChain(chain: readonly UiMessage[], from: number, to: number): UiMessage[] {
  return chain.slice(from - 1, to);
}

/**
 * Build a repository from a contiguous slice, parent-linking each message to
 * the previous one — exactly what a bounded window holds.
 *
 * The first message has parentId null: it is the root of the *window*, not of
 * the conversation. That distinction is measured, not assumed.
 */
export function toBranchableRepository(slice: readonly UiMessage[]) {
  const items = slice.map((message, index) => ({
    message,
    parentId: index === 0 ? null : slice[index - 1].id,
  }));
  return ExportedMessageRepository.fromBranchableArray(items as never, {
    headId: slice.length > 0 ? slice[slice.length - 1].id : null,
  });
}

/* ------------------------------------------------------------------ *
 * Store doubles — the fields a real host would own.
 * ------------------------------------------------------------------ */

export type StoreCall = { readonly name: string; readonly args: readonly unknown[] };

export type SpikeStore = {
  messages?: readonly UiMessage[];
  messageRepository?: unknown;
  isRunning?: boolean;
  hasEarlier?: boolean;
  onLoadEarlier?: () => Promise<void>;
  onRefetchThread?: () => Promise<void>;
  setMessages?: (messages: readonly UiMessage[]) => void;
  onNew?: (message: unknown) => Promise<void>;
  onEdit?: (message: unknown) => Promise<void>;
  onReload?: (parentId: string | null, config?: unknown) => Promise<void>;
  onDelete?: (messageId: string) => Promise<void>;
  unstable_enableToolInvocations?: boolean;
};

export type SpikeHarness = {
  readonly core: InstanceType<typeof ExternalStoreThreadRuntimeCore>;
  readonly repository: InstanceType<typeof MessageRepository>;
  readonly calls: StoreCall[];
  setStore: (next: SpikeStore) => void;
  visibleIds: () => string[];
  visibleMessages: () => readonly UiMessage[];
  dispose: () => void;
};

const RECORDED: ReadonlyArray<keyof SpikeStore> = [
  "setMessages",
  "onNew",
  "onEdit",
  "onReload",
  "onDelete",
  "onLoadEarlier",
  "onRefetchThread",
];

/** Construct the real thread runtime core with a store we control. */
export function createSpike(initial: SpikeStore): SpikeHarness {
  const calls: StoreCall[] = [];

  const makeStore = (source: SpikeStore) => {
    const wrapped: Record<string, unknown> = { ...source };
    for (const key of RECORDED) {
      const original = source[key] as ((...args: unknown[]) => unknown) | undefined;
      if (typeof original !== "function") continue;
      wrapped[key] = (...args: unknown[]) => {
        calls.push({ name: String(key), args });
        return (original as (...a: unknown[]) => unknown).apply(null, args);
      };
    }
    return wrapped;
  };

  // BaseThreadRuntimeCore calls getModelContext() during append (for
  // enrichAppend metadata). The first spike run proved this is required.
  const contextProvider = {
    getModelContext: () => ({ tools: {}, callSettings: {}, system: undefined, config: {} }),
    registerModelContextProvider: () => () => {},
  } as never;

  const spikeCore = new ExternalStoreThreadRuntimeCore(contextProvider, makeStore(initial) as never);

  return {
    core: spikeCore,
    repository: spikeCore.repository as InstanceType<typeof MessageRepository>,
    calls,
    setStore(next: SpikeStore) {
      spikeCore.__internal_setAdapter(makeStore(next) as never);
    },
    visibleIds: () => spikeCore.messages.map((m) => m.id),
    visibleMessages: () => spikeCore.messages as unknown as readonly UiMessage[],
    dispose: () => {
      const { invalidateThreadRuntime } = core as unknown as {
        invalidateThreadRuntime?: (r: unknown) => void;
      };
      invalidateThreadRuntime?.(spikeCore);
    },
  };
}