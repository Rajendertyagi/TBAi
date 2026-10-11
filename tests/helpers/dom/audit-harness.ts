/**
 * PERMANENT P2 contract harness (promoted from the Candidate-D spike).
 *
 * Drives the REAL installed Candidate D stack with no React and no DOM:
 *
 * Drives the REAL installed Candidate D stack with no React and no DOM:
 *
 *   - `Chat` (`@ai-sdk/react@4.0.131`) — the real execution object.
 *   - `AssistantChatTransport` (`@assistant-ui/ai-sdk@0.0.11`) — the real
 *     transport, with only `fetch` replaced by a capturing stub so the exact
 *     outbound payload can be recorded.
 *   - `ExternalStoreThreadRuntimeCore` (`@assistant-ui/core@0.3.24`) — the real
 *     runtime core, unmodified.
 *   - `sliceMessagesUntil` and `toCreateMessage` — the real functions the
 *     wrapper uses, imported from the package's own dist so the audit cannot
 *     drift from what ships.
 *
 * ## What is transcribed, and why that is still evidence
 *
 * The store callbacks (`onNew`/`onEdit`/`onReload`/`onDelete`) are transcribed
 * from `@assistant-ui/ai-sdk/dist/runtime/useAISDKRuntime.js` lines 545-597.
 * They cannot be imported: the wrapper builds them inside a React hook that
 * requires the full `useChatRuntime` context tree. The two functions they call
 * (`sliceMessagesUntil`, `toCreateMessage`) ARE imported from the package, so
 * the only thing under audit that is transcription is the ~12 lines of
 * control flow that decides *which* of those functions runs.
 *
 * The P1' splice is transcribed from `src/context/assemble.ts` lines 227-245 for
 * the same reason: `assembleContext` is not callable without the whole provider
 * pipeline. `tests/integration/p2-candidate-d-p1p-reconstruction.test.ts`
 * executes the same rule against the REAL `messageService.getHeadChain`.
 */

import { AssistantChatTransport } from "@assistant-ui/ai-sdk";
// Real shipped functions, resolved portably (no machine-specific paths).
import {
  AISDKMessageConverter,
  Chat,
  ExternalStoreThreadRuntimeCore,
  ExportedMessageRepository,
  MessageRepository,
  coreInternalAll as core,
  getExternalStoreMessages,
  sliceMessagesUntil,
  toCreateMessage,
} from "./resolve";

export {
  ExternalStoreThreadRuntimeCore,
  MessageRepository,
  ExportedMessageRepository,
  getExternalStoreMessages,
  sliceMessagesUntil,
  toCreateMessage,
};

/* ------------------------------------------------------------------ *
 * Chain construction
 * ------------------------------------------------------------------ */

/** A message id in the AUTHORITATIVE chain, e.g. `m451`. */
export const msgId = (n: number): string => `m${n}`;

export const chainFromTo = (from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => msgId(from + i));

/** AI SDK `UIMessage` — the shape `chat.messages` holds. */
export type AiUiMessage = {
  id: string;
  role: "user" | "assistant";
  parts: Array<{ type: "text"; text: string }>;
};

export function aiMessages(ids: readonly string[]): AiUiMessage[] {
  return ids.map((id, index) => ({
    id,
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    parts: [{ type: "text" as const, text: `body ${id}` }],
  }));
}

/* ------------------------------------------------------------------ *
 * Transport capture
 * ------------------------------------------------------------------ */

/** One recorded outbound request. */
export type Submission = {
  /** Message ids in `messages`, in submission order. */
  readonly ids: readonly string[];
  /** The raw `messages` array, for parts-level assertions. */
  readonly messages: readonly unknown[];
  readonly trigger: string;
};

export type AuditHarness = {
  /** The real AI SDK execution object. */
  readonly chat: Chat<AiUiMessage[]>;
  /** The real runtime core. */
  readonly runtime: InstanceType<typeof ExternalStoreThreadRuntimeCore>;
  readonly repository: InstanceType<typeof MessageRepository>;
  /** Every outbound submission, in order. */
  readonly submissions: Submission[];
  /**
   * Every runtime-initiated push-back into `chat.messages`, in order, with the
   * ids that actually survived `getExternalStoreMessages`. A length-0 entry
   * means the runtime tried to write back and the binding recovered nothing.
   */
  readonly writeBacks: string[][];
  /** Authoritative tip, known to the host but not necessarily to the runtime. */
  readonly authoritativeTip: string;
  /** Ids currently visible in the assistant-ui repository. */
  visibleIds: () => string[];
  /** The repository's semantic head. */
  headId: () => string | null;
  /** Replace the visible window (what a bounded-history host would do). */
  setWindow: (ids: readonly string[]) => void;
  /**
   * Publish a different window WITHOUT changing the mutation mode.
   *
   * The synchronization-only operation a historical-view host must still be
   * able to perform: repository replacement and streaming updates. It belongs
   * here because it is part of the harness's public surface — `createAudit`
   * implements it, `AuditOptions` requires it, and the DOM contracts call it —
   * but the returned type never declared it, so every call site was a TS2353.
   */
  republishWindow: (ids: readonly string[]) => void;
  /** Switch the published store between `active` and `historicalView`. */
  setMutationMode: (mode: "active" | "historicalView") => void;
  /** The runtime's derived capability flags, as the host observes them. */
  capabilities: () => Record<string, boolean>;
  /** Replace the visible window with arbitrary AI SDK messages, preserving parts. */
  seed: (messages: readonly unknown[]) => void;
  /** Ids the AI SDK Chat holds — the submission source. */
  chatIds: () => string[];
  /**
   * Append exactly as the composer does: at the CURRENT semantic head.
   *
   * `parentId` is not optional in practice. `append` classifies
   * `sourceId != null || parentId !== lastVisibleId` as an EDIT
   * (external-store-thread-runtime-core.js:431), and omitting it yields
   * `parentId: null`, which routes to `onEdit` and then
   * `sliceMessagesUntil(_, null)` returns `[]` — silently discarding the whole
   * conversation. The audit hit exactly that; the helper makes the discipline
   * explicit rather than leaving it to each test.
   */
  send: (text: string) => Promise<void>;
  /** Append naming an explicit parent — used to probe head/branch semantics. */
  appendAt: (parentId: string | null, text: string) => Promise<void>;
  dispose: () => void;
};

export type AuditOptions = {
  /** The AUTHORITATIVE chain, e.g. m1..m500. The tip is the last id. */
  readonly authoritative: readonly string[];
  /** Which ids the window initially shows. */
  readonly window: readonly string[];
  /**
   * How the host converts AI SDK messages for assistant-ui.
   *
   *  - `realWrapper` (default) — what `@assistant-ui/ai-sdk@0.0.11` does today:
   *    the host runs the real `AISDKMessageConverter` and hands over fully
   *    formed assistant-ui `ThreadMessage`s, carrying `symbolInnerMessage`.
   *  - `convertMessage` — the lighter path the core also supports: the host
   *    hands raw AI SDK messages plus a per-message converter, and the runtime
   *    performs `fromThreadMessageLike` normalization itself.
   */
  readonly conversion?: "realWrapper" | "convertMessage";
  /**
   * How much of the store's mutation surface to publish.
   *
   *  - `active` (default) — the full store, exactly as
   *    `@assistant-ui/ai-sdk` composes it today.
   *  - `historicalView` — the store a HISTORICAL_VIEW window would publish:
   *    no `onEdit`, `onReload`, `onDelete`, and no `setMessages`. The runtime
   *    derives every mutation capability from the PRESENCE of these callbacks
   *    (external-store-thread-runtime-core.js:190-206), so omitting them is
   *    the mechanism — not a flag.
   *
   * `messages` / `convertMessage` / `isRunning` are retained in both modes:
   * those are the host→runtime SYNCHRONIZATION direction and must keep working.
   */
  readonly mutation?: "active" | "historicalView";
  // `republishWindow`, `setMutationMode` and `capabilities` are deliberately NOT
  // options. They are what the harness PRODUCES — `createAudit` implements each
  // one from the runtime it builds — so declaring them here made every
  // `createAudit({ authoritative, window })` call site a type error demanding the
  // caller supply the harness's own outputs. They are declared on `AuditHarness`.
};

/**
 * The MINIMAL `ThreadMessageLike` the core normalizes on the `convertMessage`
 * path. It exists only to probe that lighter path (Question 5) — production
 * never uses it, and the audit reports why.
 */
const minimalThreadMessageLike = (m: {
  id: string;
  role: string;
  parts: Array<{ type: string; text?: string; toolCallId?: string; state?: string }>;
}) => ({
  id: m.id,
  role: m.role,
  // Pass every part class through with only its type discriminator, so the
  // measurement isolates what the RUNTIME derives from what the CONVERTER
  // chose to keep. Dropping tool parts here would make the lighter path look
  // worse than it is.
  content: m.parts.map((p) =>
    p.type === "text"
      ? { type: "text" as const, text: p.text ?? "" }
      : { type: p.type, toolCallId: p.toolCallId, state: p.state },
  ),
});

/**
 * The REAL conversion the wrapper performs.
 *
 * `useAISDKRuntime.js:323` calls exactly this:
 *   `AISDKMessageConverter.toThreadMessages(sourceMessages, false, metadata)`
 *
 * It returns fully-formed assistant-ui `ThreadMessage`s that carry
 * `symbolInnerMessage`, the back-reference `getVercelAIMessages` needs to
 * reconstruct the original AI SDK message on write-back. A hand-built
 * `ThreadMessageLike` has no such binding, which is why the write-back path
 * below returns nothing for it.
 */
const realConversion = (messages: readonly unknown[]): unknown[] =>
  AISDKMessageConverter.toThreadMessages(messages as never, false, {} as never) as never;

/**
 * Build the audit stack.
 *
 * The initial `chat.messages` is the WINDOW, not the authoritative chain. That
 * is the whole point: Candidate D makes the Chat's array the submission source,
 * so the window and the submission conversation are the same array unless the
 * architecture proves otherwise.
 */
export function createAudit(options: AuditOptions): AuditHarness {
  const submissions: Submission[] = [];
  const writeBacks: string[][] = [];
  let mutationMode: "active" | "historicalView" = options.mutation ?? "active";
  const authoritativeTip = options.authoritative.at(-1) ?? null;
  const conversion = options.conversion ?? "realWrapper";

  const transport = new AssistantChatTransport({
    api: "/api/chat",
    fetch: (async (_url: unknown, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      submissions.push({
        ids: (body.messages ?? []).map((m: { id: string }) => m.id),
        messages: body.messages ?? [],
        trigger: body.trigger ?? "submit-message",
      });
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch,
  });

  const chat = new Chat<AiUiMessage[]>({
    id: "audit-thread",
    transport,
    messages: aiMessages(options.window) as never,
    onError: () => {},
  });

  /**
   * The real `setMessages`.
   *
   * `setMessages` is added by the `useChat` HOOK, not by the `Chat` class, so it
   * does not exist on a directly-constructed Chat. Its entire implementation
   * (`@ai-sdk/react@4.0.131/dist/index.js`) is:
   *
   *   const setMessages = useCallback(messagesParam => {
   *     if (typeof messagesParam === "function") messagesParam = messagesParam(chat.messages);
   *     chat.messages = messagesParam;
   *   }, [chat]);
   *
   * and `AbstractChat` exposes `set messages(messages)` (`ai@7.0.93` line 5645).
   * This helper IS that code. Using it here keeps the audit on the real
   * mechanism rather than a stand-in.
   */
  const setMessages = (
    messages: AiUiMessage[] | ((current: AiUiMessage[]) => AiUiMessage[]),
  ): void => {
    // Typed as an array-or-updater union rather than `unknown`, so the updater
    // callbacks below get `current` from context instead of an implicit `any`.
    chat.messages = typeof messages === "function" ? messages(chat.messages) : messages;
  };

  // ── Store callbacks, transcribed from useAISDKRuntime.js:545-597 ──────────
  const makeStore = () => {
    const chatMessages = chat.messages as unknown as AiUiMessage[];
    return {
      // ── the conversion question (Question 5) ──
      ...(conversion === "realWrapper"
        ? { messages: realConversion(chatMessages) }
        : {
            // The lighter path the core also supports: hand raw AI SDK messages
            // plus a converter, and let the runtime run `fromThreadMessageLike`
            // itself (external-store-thread-runtime-core.js:235-254).
            messages: chatMessages as never,
            convertMessage: (m: unknown) => minimalThreadMessageLike(m as never),
          }),
      isRunning: false,
      hasEarlier: false,

      // useAISDKRuntime.js:545
      onNew: async (message: never) => {
        const m = message as unknown as {
          role: string;
          content: unknown[];
          startRun?: boolean;
          runConfig?: unknown;
          metadata?: unknown;
        };
        const createMessage = toCreateMessage(m as never);
        if (!(m.startRun ?? m.role === "user")) {
          setMessages(
            (current) =>
              [
                ...(current as unknown as AiUiMessage[]),
                {
                  id: `local-${current.length + 1}`,
                  role: m.role as "user",
                  parts: createMessage.parts,
                },
              ] as never,
          );
          return;
        }
        await chat.sendMessage(createMessage as never, {
          metadata: m.runConfig as never,
        });
      },

      // useAISDKRuntime.js:555
      onEdit: async (message: never) => {
        const m = message as unknown as {
          role: string;
          parentId: string | null;
          content: unknown[];
          startRun?: boolean;
          runConfig?: unknown;
          metadata?: unknown;
        };
        const createMessage = toCreateMessage(m as never);
        if (!(m.startRun ?? m.role === "user")) {
          setMessages(
            (current) =>
              [...sliceMessagesUntil(current as never, m.parentId), createMessage] as never,
          );
          return;
        }
        setMessages((current) => sliceMessagesUntil(current as never, m.parentId) as AiUiMessage[]);
        await chat.sendMessage(createMessage as never, { metadata: m.runConfig as never });
      },

      // useAISDKRuntime.js:592
      onReload: async (parentId: string | null, config?: unknown) => {
        const newMessages = sliceMessagesUntil(chat.messages as never, parentId);
        setMessages(newMessages as never);
        await chat.regenerate({
          metadata: (config as { runConfig?: unknown })?.runConfig as never,
        });
      },

      // useAISDKRuntime.js:565
      onDelete: async (messageId: string) => {
        setMessages(
          (current) =>
            (current as unknown as AiUiMessage[]).filter((m) => m.id !== messageId) as never,
        );
      },

      // useAISDKRuntime.js:496, verbatim in behaviour:
      //   setMessages: (m) => chatHelpers.setMessages(m.map(getVercelAIMessages).filter(Boolean).flat())
      // and `getVercelAIMessages` IS `getExternalStoreMessages` — it unwraps
      // the `symbolInnerMessage` back-reference. A message with no binding
      // yields nothing, so the array can legitimately come back EMPTY. That is
      // measured in the audit, not assumed.
      setMessages: (messages: readonly unknown[]) => {
        const recovered = (messages as never[])
          .map((m) => getExternalStoreMessages(m))
          .filter(Boolean)
          .flat();
        writeBacks.push(recovered.map((m) => (m as { id: string }).id));
        setMessages(recovered as AiUiMessage[]);
      },

      unstable_enableToolInvocations: true,
    };
  };

  /**
   * The store as published for the requested mode.
   *
   * HISTORICAL_VIEW is expressed by OMITTING callbacks, because the runtime
   * derives every mutation capability from their presence
   * (external-store-thread-runtime-core.js:190-206):
   *
   *   edit           <- onEdit   !== undefined
   *   reload         <- onReload !== undefined
   *   delete         <- onDelete !== undefined || setMessages !== undefined
   *   switchToBranch <- setMessages !== undefined
   *
   * `messages`, `convertMessage` and `isRunning` are deliberately RETAINED in
   * both modes: those carry the host->runtime synchronization direction
   * (streaming, tool state, approval state) and must keep working.
   */
  const publishStore = (): Record<string, unknown> => {
    const store = makeStore() as unknown as Record<string, unknown>;
    if (mutationMode !== "historicalView") return store;
    const published = { ...store };
    for (const key of ["onEdit", "onReload", "onDelete", "setMessages"]) {
      delete published[key];
    }
    return published;
  };

  // BaseThreadRuntimeCore reads getModelContext() during append.
  const contextProvider = {
    getModelContext: () => ({ tools: {}, callSettings: {}, system: undefined, config: {} }),
    registerModelContextProvider: () => () => {},
  } as never;

  const runtime = new ExternalStoreThreadRuntimeCore(contextProvider, publishStore() as never);

  return {
    chat,
    runtime,
    repository: runtime.repository as InstanceType<typeof MessageRepository>,
    submissions,
    writeBacks,
    authoritativeTip,
    visibleIds: () => runtime.messages.map((m) => m.id),
    headId: () => runtime.repository.canonicalHeadId,
    setWindow(ids) {
      // What a bounded-history host does on navigation: replace the visible
      // window. The Chat is the submission source, so the host must be able to
      // replace it too — which is the capability under test.
      setMessages(aiMessages(ids) as never);
      runtime.__internal_setAdapter(publishStore() as never);
    },
    seed(messages) {
      // Same as setWindow but keeps each message's real `parts`, so the audit
      // can exercise tool / reasoning / file parts rather than only text.
      setMessages(messages as never);
      runtime.__internal_setAdapter(publishStore() as never);
    },
    chatIds: () => (chat.messages as unknown as AiUiMessage[]).map((m) => m.id),
    republishWindow(ids) {
      // Synchronization-only: replace the window and re-publish the store
      // WITHOUT touching the mutation mode. This is what a HISTORICAL_VIEW host
      // must still be able to do (repository replacement / streaming).
      setMessages(aiMessages(ids) as never);
      runtime.__internal_setAdapter(publishStore() as never);
    },
    setMutationMode(mode) {
      mutationMode = mode;
      runtime.__internal_setAdapter(publishStore() as never);
    },
    capabilities: () => ({ ...(runtime.capabilities as Record<string, boolean>) }),
    async send(text: string) {
      await runtime.append({
        role: "user",
        parentId: runtime.repository.canonicalHeadId,
        content: [{ type: "text", text }],
      } as never);
      await new Promise((r) => setTimeout(r, 40));
    },
    async appendAt(parentId: string | null, text: string) {
      await runtime.append({
        role: "user",
        parentId,
        content: [{ type: "text", text }],
      } as never);
      await new Promise((r) => setTimeout(r, 40));
    },
    dispose() {
      (
        core as unknown as { invalidateThreadRuntime?: (r: unknown) => void }
      ).invalidateThreadRuntime?.(runtime);
    },
  };
}

/* ------------------------------------------------------------------ *
 * P1' reconstruction, transcribed from src/context/assemble.ts:227-245
 * ------------------------------------------------------------------ */

/**
 * The P1' prefix splice.
 *
 * `headChain` is the REAL output of `messageService.getHeadChain` in the
 * integration test; here it is supplied so the in-memory audit can run without
 * SQLite. `src/context/assemble.ts` lines 227-245:
 *
 *   if (headChain.complete && submittedMessages.length > 0) {
 *     const boundaryChainIndex = headChain.messages.findIndex(m => m.id === submitted[0].id);
 *     if (boundaryChainIndex >= 0) {
 *       effectiveMessages = [...headChain.messages.slice(0, boundaryChainIndex), ...submitted];
 *     }
 *   }
 *
 * Note what this can and cannot repair: only the PREFIX before the oldest
 * submitted message. Anything the client omitted from the middle or the tail is
 * not restored.
 */
export function p1pReconstruct(
  headChain: { messages: readonly { id: string }[]; complete: boolean },
  submitted: readonly { id: string }[],
): { applied: boolean; effective: readonly string[] } {
  if (!(headChain.complete && submitted.length > 0)) {
    return { applied: false, effective: submitted.map((m) => m.id) };
  }
  const boundary = headChain.messages.findIndex((m) => m.id === submitted[0].id);
  if (boundary < 0) {
    return { applied: false, effective: submitted.map((m) => m.id) };
  }
  return {
    applied: true,
    effective: [
      ...headChain.messages.slice(0, boundary).map((m) => m.id),
      ...submitted.map((m) => m.id),
    ],
  };
}

/** Compare a reconstruction against the authoritative chain. */
export function missingFrom(
  authoritative: readonly string[],
  effective: readonly string[],
): string[] {
  const present = new Set(effective);
  return authoritative.filter((id) => !present.has(id));
}
