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

## Why not `assistant-stream`?

`assistant-stream`'s `createAssistantStreamResponse` emits the older *Assistant
Stream Protocol*, which is **not** what `AssistantChatTransport` consumes (it
expects the AI SDK UI-message stream). Its only consumer (`createProviderStream`)
was dead code. It was removed; `toUIMessageStreamResponse()` is the correct,
library-provided equivalent. See `docs/decisions.md`.
