# AI Integration

The AI layer is **AI SDK v7** on the backend and **@assistant-ui** on the frontend.
There is no custom streaming protocol.

## Frontend

`web/src/runtime.ts` builds the assistant-ui runtime:

```ts
const transport = new AssistantChatTransport({
  api: "/api/chat",
  prepareSendMessagesRequest: async ({ body }) => {
    const { activeProviderId, providers } = useSettingsStore.getState();
    const provider = providers.find(p => p.id === activeProviderId) ?? providers[0];
    return { body: { ...body, providerId: provider?.id ?? "" } };
  },
});
return useChatRuntime({ transport });
```

Key points:
- The transport sends the **`providerId` only** — never the API key.
- `ChatWindow.tsx` renders `AssistantRuntimeProvider` + `ThreadPrimitive` /
  `ComposerPrimitive` / `MessagePrimitive`. No custom message rendering.

## Backend

`src/routes/index.ts` (`POST /api/chat`):

```ts
const parsed = chatRequestSchema.safeParse(await c.req.json());
const { providerId, messages } = parsed.data;
const provider = (providerId && registry.get(providerId)) || registry.getActive();
const model = getModel(provider);
const isLite = /lite|nano/i.test(provider.model || "");

const result = streamText({
  model,
  messages: convertToModelMessages(messages),
  ...(isLite ? {} : { providerOptions: { google: { thinkingConfig: { thinkingBudget: 0 } } } }),
});
return result.toUIMessageStreamResponse();
```

Key points:
- `convertToModelMessages()` turns the assistant-ui `UIMessage[]` (role + parts)
  into the `ModelMessage[]` that `streamText` expects.
- `toUIMessageStreamResponse()` emits the UI-message stream protocol that
  `@assistant-ui/react` consumes. This replaces any hand-rolled SSE loop.
- `getModel(config)` (in `src/services/ai.ts`) is the **provider adapter**: it
  builds the correct `LanguageModel` per provider type using
  `createOpenAI` / `createAnthropic` / `createGoogle`, passing `apiKey` and
  `baseURL` (endpoint) from the server-side config.

## Thinking models

`gemini-flash-latest` currently resolves to a *thinking* model that adds latency.
For non-lite Google models we disable thinking with
`providerOptions.google.thinkingConfig.thinkingBudget = 0`. Lite/nano models do
not support this option, so it is skipped for them. This is a performance
workaround, not a permanent design — revisit if the provider changes behavior.

## Why not `assistant-stream`?

`assistant-stream`'s `createAssistantStreamResponse` emits the older *Assistant
Stream Protocol*, which is **not** what `AssistantChatTransport` consumes (it
expects the AI SDK UI-message stream). Its only consumer (`createProviderStream`)
was dead code. It was removed; `toUIMessageStreamResponse()` is the correct,
library-provided equivalent. See `docs/decisions.md`.
