# AI Integration

The AI layer is **AI SDK v7** on the backend and **@assistant-ui** on the frontend.
There is no custom streaming protocol.

## Frontend

`web/src/runtime.ts` builds the assistant-ui runtime:

```ts
const transport = new AssistantChatTransport({
  api: "/api/chat",
  prepareSendMessagesRequest: async ({ messages, id, trigger, messageId, requestMetadata }) => {
    const { providerId, model } = resolveDirectSelection();
    return {
      body: {
        providerId,
        model,
        id,
        messages,
        trigger,
        messageId,
        metadata: requestMetadata,
      },
    };
  },
});
return useChatRuntime({ transport });
```

Key points:
- The browser sends the selected provider/model identifiers and transport metadata,
  never an API key, system directive, or client tool definition.
- `src/routes/chat.ts` validates the envelope and UI messages with AI SDK v7,
  then applies the persisted conversation `systemPrompt` as server-owned
  `instructions`.
- `ChatWindow.tsx` renders `AssistantRuntimeProvider` + `ThreadPrimitive` /
  `ComposerPrimitive` / `MessagePrimitive`. No custom message rendering.

## OpenCode V2 Code surface

Code mode uses the official `@opencode/client@2.0.16` behind
`web/src/features/opencode/v2Client.ts`. The client is scoped to the
backend-minted session and directory, subscribes before hydration, and exposes
only generation-bound operations. `v2ThreadController.ts` owns the single event
loop, authoritative paginated history, prompt admission, cancellation, recovery,
permissions, forms, and compaction. `v2RuntimeStore.ts` projects that state into
assistant-ui's external-store repository; OpenCode wire formats never cross into
`ChatWindow` or generic chat state. The managed server compatibility gate is
`>=2.0.15 <2.1.0`.

## Backend

`src/routes/chat.ts` (`POST /api/chat`):

```ts
const parsed = chatRequestSchema.safeParse(await c.req.json());
const validation = await safeValidateUIMessages({ messages: parsed.data.messages });
if (!validation.success) return invalidMessages();

const result = streamText({
  model: getModel(providerConfig),
  messages: await prepareModelMessages(validation.data, tools),
  ...(conversation?.systemPrompt
    ? { instructions: conversation.systemPrompt }
    : {}),
  tools,
  experimental_toolApprovalSecret: approvalSecret,
  providerOptions,
});

return createUIMessageStreamResponse({
  stream: toUIMessageStream({ stream: result.stream, onEnd: settleRun }),
});
```

Key points:
- `safeValidateUIMessages()` validates the assistant-ui `UIMessage[]` before the
  existing approval-aware pruning/conversion path.
- `instructions` comes from the persisted conversation, never from a client
  system-message/tool override.
- `toUIMessageStream()` emits the UI-message stream protocol that
  `@assistant-ui/react` consumes, and its producer `onEnd` outcome settles the
  server-owned run. This replaces any hand-rolled SSE loop.
- `getModel(config)` (in `src/services/ai.ts`) is the **provider adapter**: it
  builds the correct `LanguageModel` per provider type using
  `createOpenAI` / `createAnthropic` / `createGoogle`, passing `apiKey` and
  `baseURL` (endpoint) from the server-side config.
- Direct request/stream retry budgets are explicitly zero. Once any output has
  arrived, replaying the call can duplicate text, reasoning, or tool effects;
  recovery is an explicit user action.

## Provider stream conformance

Custom OpenAI-compatible providers must follow the Chat Completions SSE
contract. A successful response includes a terminal chunk with a non-null
`choices[0].finish_reason` (`stop`, `length`, `tool_calls`, or `content_filter`)
followed by the proper `[DONE]` sequence. Reasoning fields such as
`reasoning_content` must remain available when the provider supports them.

TBAi intentionally does not convert a missing finish reason into success. The
AI SDK reports a truncated/invalid provider stream as a failure, the Direct route
records the failed outcome and sanitized error category, and the user can retry
explicitly. Provider-specific fixes belong at the provider/gateway boundary;
there is no Agnes- or model-specific fallback in the application.

## Thinking models

Thinking is **opt-in per request**, and it is the only thing that produces a
reasoning ("thinking") block in the UI. The effective level resolves in
`src/routes/chat-model.ts`:

```
request `reasoningLevel`  →  conversation default (SQLite)
  →  provider's saved `thinking`  →  "off"
```

`src/routes/chat-provider-options.ts` translates the level into provider options.
Every branch is a documented provider quirk whose failure mode is **silence** —
the request succeeds, the model thinks, and the UI renders nothing — so the
rules live in one readable, unit-testable module rather than inline in the route.

| provider type | option |
|---|---|
| `google`, Gemini 3+ | `thinkingConfig.thinkingLevel` = low / medium / high |
| `google`, Gemini 2.5 | `thinkingConfig.thinkingBudget` = 1024 / 4096 / 8192 |
| `google` (any) | **plus `thinkingConfig.includeThoughts: true`** |
| `anthropic` | `thinking: { type: "enabled", budgetTokens }` |
| `openai` / `custom` | `reasoningEffort` under the factory's namespace |

Three things that each silently produce no thinking block:

- **`includeThoughts` is mandatory for Google.** Without it the model still
  thinks, but the summaries the UI renders are withheld. Every other option is
  moot if this one is missing.
- **Gemini's control changed at generation 3.** `thinkingBudget` is a Gemini 2.5
  option; Gemini 3 and later take `thinkingLevel`. Sending the wrong one is
  ignored. `lite`/`nano` variants of **2.5** reject a budget, which is what the
  lite gate is for — it deliberately does **not** apply to Gemini 3, whose Flash
  models support every level.
- **`reasoning_content` needs the right factory.** `@ai-sdk/openai`'s
  chat-completions delta schema declares only `role`, `content`, `tool_calls` and
  `annotations`, so a gateway streaming DeepSeek/Qwen-style `reasoning_content`
  has its reasoning discarded. `custom`/`ollama` (and an `openai` provider set to
  chat-completions) are therefore built with `@ai-sdk/openai-compatible`. That
  factory also changes the `providerOptions` namespace — ask
  `providerOptionsNamespace()` rather than assuming `openai`.

At `"off"` the options object is empty and omitted from `streamText`, so the
provider is never asked to think and no reasoning part can exist.

### Two chips, deliberately different vocabularies

The Direct composer chip offers **Off / Low / Medium / High** — a fixed enum the
app owns and maps to provider options. The Code-mode chip offers **Default** plus
whatever *variants* the OpenCode model advertises, because those are
server-defined and model-specific; "Default" means "omit the variant field and
let OpenCode decide". They cannot share one enum without discarding the
server-driven half, so the difference is intentional, not drift.

### Verifying it

`bun run scripts/verify-reasoning.ts` prints the option shape for every provider
type × model generation (no key needed) and, with `--live`, makes one real call
per configured provider and reports the reasoning-delta count. **Use a
substantial probe prompt**: reasoning models skip thinking on trivial questions,
so an easy prompt reports a false negative.

The reasoning panel renders **expanded** and stays expanded (`ChatWindow.tsx`,
`ReasoningRoot ... defaultOpen`); a manual toggle still wins.

## `assistant-stream` boundary

The old `createAssistantStreamResponse` application path is not used: it emits
the older Assistant Stream Protocol, while `AssistantChatTransport` consumes the
AI SDK UI-message stream. The dependency is retained for the official
`assistant-stream/resumable` context/store used by `/api/chat` and
`/api/chat/resume`, plus the adapter's no-op `generateTitle` stream. It is not a
second chat runtime or message protocol. It is aligned to `0.3.43` with the
assistant-ui packages. See `docs/decisions.md`.