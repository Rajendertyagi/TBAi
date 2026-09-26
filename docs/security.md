# Security

Security principles applied to TBAi.

## Design stance

TBAi is a **personal-use, portable** application. Convenience and portability are
prioritized over protection against an attacker who already has full read access to
the application's files / machine. The credential design reflects this:

- Provider API keys are encrypted **at rest** in the local SQLite database.
- There is **no master password, unlock screen, or login**. The user enters a key
  once and TBAi remembers it automatically across restarts.
- There is **no OS keychain / credential-manager dependency** and **no `.env` setup**
  required for normal use. The app remains fully portable (the data folder travels
  with it).

### Threat model / limitations

Because the data-encryption key (DEK) lives in the same local database as the
ciphertext, **anyone with read access to the app's `data/` folder can recover the
API keys**. This is an accepted trade-off for a single-user portable tool. The
encryption defends against:

- accidental plaintext leakage (logs, API responses, browser storage, source control),
- casual file inspection of the database,
- loss/theft of the database file by someone who cannot also read the DEK.

It does **not** defend against a local attacker who can read the full app folder. If
that threat matters, add OS-keychain storage or a master password (deliberately not
used here).

## API keys stay backend-only

- Provider API keys are encrypted with **AES-256-GCM** under a random per-install
  **Data Encryption Key (DEK)**. Ciphertext is stored in
  `provider_configs.encrypted_api_key`; the plaintext is **never** written to SQLite.
- The DEK is generated once and stored in the `credential_key` table (same SQLite
  file), so the portable app folder is self-contained.
- `GET /api/providers` returns metadata plus `credentialConfigured: true/false` only.
  It **never** returns the API key or any ciphertext.
- The frontend sends only the selected `providerId`/`modelId` and transport
  metadata in the chat request. The backend loads the encrypted credential,
  decrypts it **in memory only**, and builds the model.
- `src/services/ai.ts#getModel` reads the key from the transient, in-memory config; it
  is never placed in a response body.
- All crypto is isolated in `src/services/credentials.ts` (the `CredentialStore`).
  No provider/routing/UI code performs encryption.

## MCP auth tokens

MCP servers reached over HTTP/SSE may require auth. The same rules apply:

- `mcp_servers.auth_token` is encrypted at rest with the local DEK via `encryptSecret`/
  `decryptSecret` (same envelope as provider keys). The plaintext is **never** written to
  SQLite and **never** returned to the browser — only `auth_type` (`none|bearer|basic|oauth`)
  is echoed by `GET /api/mcp/servers`.
- Auth headers are constructed server-side from `auth_type`/`auth_token` (bearer →
  `Authorization: Bearer …`, basic → `Authorization: Basic base64(token)`, oauth → bearer)
  and attached to the MCP transport's `requestInit`. The browser never sees the token.
- MCP tools are **server-executed**: the MCP `Client` runs in the backend, so server
  credentials never reach the frontend. See `mcp.md`.

## Input validation (Zod + AI SDK)

All API input is validated with Zod schemas in `src/lib/validation.ts`:
- `chatRequestSchema` — `/api/chat` validates the explicit assistant-ui transport
  envelope, requires a non-empty message array, accepts the routing `id`, and
  rejects non-empty client `system`/`tools`/`callSettings`/`config` directives.
  Message internals are then validated by AI SDK v7 `safeValidateUIMessages`
  before the existing approval-aware pruning/conversion path.
- `providerCreateSchema` / `providerUpdateSchema` — provider CRUD (name, type enum,
  model, optional endpoint/apiKey).
- `providerTestSchema` is `providerCreateSchema` (reused for `/api/providers/test`).
- `mcpServerCreateSchema` / `mcpServerUpdateSchema` / `mcpServerTestSchema` —
  `/api/mcp` server CRUD + test (name, transport enum `stdio|http|sse`, command/args,
  url, env/headers JSON, auth_type enum, optional auth_token).

Invalid input is rejected with `400` before any provider call. A Direct request
uses the persisted conversation `systemPrompt` as server-owned `instructions`;
system-role messages and client tool definitions are not accepted as policy
overrides.

## Direct tool-approval integrity

Direct AI SDK tool approvals use a stable, separately generated 32-byte
per-install HMAC secret. It is encrypted with the existing local DEK and stored
in `app_settings` through `CredentialStore`; it is never returned to the browser
or written to logs. First initialization provisions the setting when absent;
every later Direct request re-reads and validates it, so deletion or corruption
fails closed. `experimental_toolApprovalSecret` is passed to Direct
`streamText` calls, so unsigned or tampered approval responses fail closed.
Historical unsigned approvals are not silently re-signed and require a fresh
approval. OpenCode permissions remain owned by the separate OpenCode boundary.

## Key editing safety

- The Settings UI does **not** echo the stored key back; the API-key field is always
  blank on load.
- Saving a provider edit with an empty key field sends `undefined`, and
  `PUT /api/providers/:id` only updates fields that are present — so the stored
  credential is preserved rather than overwritten with `null`.
- A **Test connection** button (`POST /api/providers/test`) validates a provider
  (with the entered or stored key) without persisting anything.

## Workspace filesystem policy

- Every conversation resolves to its own workspace directory server-side
  (`resolveConversationWorkspace`: simple chats use a per-conversation folder,
  project chats use the registered folder path). The model can never supply a
  different root.
- Path arguments to file tools are confined by `resolveSafe`
  (`src/services/tools.ts`): lexical `..` traversal is rejected, and the
  nearest existing ancestor is canonicalized (`realpath`) so symlinks and
  Windows junctions pointing outside are rejected before any IO. Comparison is
  case-insensitive on Windows. There is no flag to allow escape.
- Unattended scheduler runs resolve against the workspace root and refuse
  outside paths (`verifyJobWorkspace`); destructive tools always refuse there.
- **Shell commands are NOT sandboxed.** `run_command` confines only its
  starting directory; the command body is full PowerShell with the server's
  privileges (absolute paths, `cd`, redirection, network, environment). It is
  gated by interactive approval in chat and refused in scheduler runs.
- MCP tools run at full server-process privilege with no conversation
  workspace context (isolation currently unsupported — see `mcp.md`).
- The manual `/api/tools/*` HTTP surface executes tools without approval;
  it is a local dev/test surface, not a confinement boundary.

## OpenCode agent mode

- "Open in Code" is the explicit opt-in: it launches a managed `opencode serve`
  subprocess for a conversation and renders it as a separate agent chat tab. It is
  never started automatically.
- OpenCode runs with the **app's own OS privileges** and works inside the
  conversation's resolved workspace directory (`resolveConversationWorkspace`).
  It is a separate process: its file and shell access is **not** confined by
  TBAi's `resolveSafe`, so it can read/write/execute beyond TBAi's tool policy.
  This is why Code mode is opt-in and scope-locked at creation.
- OpenCode's tool-permission prompts are answered in-app through the shared
  `ApprovalCard` shell. Approving replies **straight to OpenCode** (`once` /
  `reject` / `always`) — there is **no TBAi grant involved**, and TBAi's native
  `/api/tools/grant` machinery does not govern OpenCode's server-executed tools.
- When OpenCode offers a persist pattern for a request, an **Always** action is
  shown. If accepted, the rule is **remembered by OpenCode across all chats**,
  outside TBAi's scope policy and outside TBAi's ability to revoke it. TBAi
  implements no host-side persistence for this choice.

## Logging / redaction

- Keys are never logged. Error messages that might accidentally include a secret are
  scrubbed by `src/lib/redact.ts` before being written to logs or returned in
  responses (e.g. provider auth errors that echo the key are redacted to
  `sk-…[REDACTED]`).
- No API key is ever written to `localStorage` or other client storage. The frontend
  `ProviderConfig` type does not even include an `apiKey` field.

## Notes / future

- There is currently no auth layer; this is a local/single-user tool. If deployed,
  add authentication before exposing the API.
- If stronger protection is later required, the `CredentialStore` interface is the only
  place that needs to change (e.g. swap the local DEK for an OS keychain or a
  master-password KDF). See `decisions.md`.
