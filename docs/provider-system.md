# Provider System

Providers are configured at runtime and stored in SQLite. The backend resolves the
correct model server-side; the browser only references a provider by `id`.

## Storage

Table `provider_configs` (see `src/db/index.ts`):

| column              | type    | notes                                                  |
|---------------------|---------|--------------------------------------------------------|
| id                  | TEXT PK | generated id                                           |
| name                | TEXT    | unique, user-facing label                              |
| type                | TEXT    | `openai|anthropic|google|ollama|custom`                |
| encrypted_api_key   | TEXT    | AES-256-GCM envelope (`{v,nonce,ct}`); **never** plaintext, **never** returned to the browser |
| credential_version  | INTEGER | envelope format version                                |
| endpoint            | TEXT    | optional base URL (Ollama / custom)                   |
| model               | TEXT    | **saved default** model id, e.g. `gpt-4o`             |
| models              | TEXT    | JSON array of **enabled** `ModelOption`s (user-selected). Discovered-but-unselected models are NOT persisted |
| is_active           | INTEGER | one active provider                                    |
| created_at          | INTEGER |                                                        |
| updated_at          | INTEGER |                                                        |

The Data Encryption Key (DEK) lives in a separate `credential_key` table (single row,
`key_hex` + `version`). It is generated once on first use and persists with the
database, so the portable app folder is self-contained. See `docs/security.md` for the
threat model.

## Credential store (`src/services/credentials.ts`)

`CredentialStore` is the **only** place that touches key material:
- `initialize()` — load the DEK, generating and persisting it on first use. Called at
  server startup (`src/server.ts`).
- `set(id, secret)` / `get(id)` / `has(id)` / `delete(id)` — encrypt/decrypt against the
  DEK; `get`/`set` happen entirely server-side in memory.
- No master password, unlock, or lock. The user enters a key once; it is remembered
  automatically.

## Registry (`src/config/providers.ts`)

`ProviderRegistry` is a singleton:
- `loadFromDb(db)` — reloads all providers (metadata only; **no secret**) from SQLite into memory.
- `list()` — public view; **omits the secret** and adds `credentialConfigured`.
- `get(id)` / `getActive()` — metadata config (no secret) for server use; the secret is
  fetched from `CredentialStore` only when a chat request needs it.
- `add` / `update` / `remove` / `setActive` — in-memory helpers (DB is source of truth; call `loadFromDb` after writes).

The registry is the single boundary between "configuration" and "provider logic".

## Adapter (`src/services/ai.ts`)

`getModel(config)` is the only place that knows about provider SDKs. It maps
`config.type` → the matching AI SDK factory and returns a `LanguageModel`:

```ts
switch (config.type) {
  case "openai":    return createOpenAI(settings)(config.model);
  case "anthropic": return createAnthropic(settings)(config.model);
  case "google":    return createGoogle(settings)(config.model);
  case "ollama":    return createOpenAI({ baseURL: "http://localhost:11434/v1", apiKey: "ollama" })(config.model);
  case "custom":    return createOpenAI({ baseURL: config.endpoint, apiKey: config.apiKey })(config.model);
}
```

Adding a new provider type means: (1) extend the `type` union in the Zod schema
(`src/lib/validation.ts`) and DB `CHECK` constraint, (2) add a `case` in
`getModel`. No chat/UI code changes.

## API

| method | path                              | purpose                              |
|--------|-----------------------------------|--------------------------------------|
| GET    | `/api/providers`                  | list (metadata + `credentialConfigured`; no key, no ciphertext) |
| POST   | `/api/providers`                  | create (validated); encrypts `apiKey` server-side |
| PUT    | `/api/providers/:id`              | update (omitted fields preserved); encrypts `apiKey` if provided |
| DELETE | `/api/providers/:id`              | delete (also removes the encrypted credential) |
| POST   | `/api/providers/test`             | validate a provider connection (entered or stored key); returns `{ok, error?}` only |
| POST   | `/api/providers/discover`         | list available models from a provider (entered or stored key); returns `{ok, models?}` only, persists nothing |
| POST   | `/api/providers/:id/set-active`   | mark active                          |

All bodies are validated with Zod. `PUT` only updates fields that are present, so
editing a provider without re-entering the key does **not** wipe the stored key.
`/api/providers/test` never returns the key; any provider error that might echo it is
redacted.

## Model Discovery

Users do not type model IDs by hand. They **discover** the models a provider exposes,
then **select** which to enable.

### Data model

```ts
type ModelOption = { id: string; label?: string; provider: string; contextWindow?: number };
```

`ProviderConfig.models` holds only the **enabled** (user-selected) models. The
discovery response is ephemeral — it is never written to SQLite unless the user
explicitly adds it. There is **no** hardcoded model catalog; live discovery is always
used when the provider supports it, with manual entry as the universal fallback.

### Flow

1. **Find models** → `POST /api/providers/discover` with `{ id?, type, endpoint?, apiKey? }`.
   The key is taken from the inline `apiKey` or, when `id` is supplied, from the stored
   credential. Nothing is persisted.
2. The returned `models` are shown as a checklist.
3. The user checks the models they want and clicks **Add selected** → those become
   **enabled** and are saved on the next provider `POST`/`PUT` (in `models`).
4. A **manual** entry field is always available for providers that don't support
   discovery or when it fails.

### Discovery endpoints (`src/services/modelDiscovery.ts`)

| type       | request                                                        | normalization                         |
|------------|----------------------------------------------------------------|--------------------------------------|
| openai     | `GET {base}/models` (`Authorization: Bearer`)                  | `data[].id`                          |
| custom     | `GET {base}/models` (`Authorization: Bearer`)                  | `data[].id` (OpenAI-compatible)       |
| anthropic  | `GET {base}/v1/models` (`X-Api-Key`, `anthropic-version`)      | `id`, `label=display_name`, `contextWindow=max_input_tokens` |
| google     | `GET {base}/v1beta/models?key=…`                              | `models[].name` (strip `models/`)     |
| ollama     | `GET {base}/api/tags` (no auth)                               | `models[].name`                       |

`base` = the configured `endpoint`, or the provider default (OpenAI `https://api.openai.com/v1`,
Anthropic `https://api.anthropic.com`, Google `https://generativelanguage.googleapis.com`,
Ollama `http://localhost:11434`). Custom providers require an `endpoint`. All requests use a
timeout and throw on non-2xx; the route catches and returns `{ ok: false, error }`.

### Chat model selection

- `provider.model` is the **saved default** for that provider (the last-resort
  fallback).
- **Each conversation owns a persisted default** (`conversations.model_id` /
  `conversations.reasoning_level` in SQLite, source of truth). On create it
  inherits the active provider's `model` / `thinking`; the composer chips
  (`PaseoComposer`) update it via the adapter's `updateCustom` (PATCH
  `/api/conversations/:id`) so it survives reloads and is the baseline for
  subsequent messages in that conversation.
- The composer picker sets a **one-shot** override (`selectedModelId` /
  `selectedProviderId` / `selectedReasoningLevel` in the settings store) that is
  sent as `model` / `providerId` / `reasoningLevel` in the `/api/chat` body and
  overrides the conversation default for that request only — it is cleared after
  send (`revertChatTarget`) and never writes back to `provider.model`.
- **Resolution order** (`src/routes/chat-model.ts`, mirrored in `web/src/runtime.ts`):
  one-shot override → conversation persisted default (`threadListItem.custom`) →
  global active provider default. An absent request field falls back to the
  conversation row so a missing header never silently drops the user's config.
- An explicit **Set as default** action persists the current selection to `provider.model`
  via `PUT /api/providers/:id`.


