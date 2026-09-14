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
- The frontend sends only the selected `providerId` in the chat request. The backend
  loads the encrypted credential, decrypts it **in memory only**, and builds the model.
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

## Input validation (Zod)

All API input is validated with Zod schemas in `src/lib/validation.ts`:
- `chatRequestSchema` — `/api/chat` (messages required, providerId optional).
- `providerCreateSchema` / `providerUpdateSchema` — provider CRUD (name, type enum,
  model, optional endpoint/apiKey).
- `providerTestSchema` is `providerCreateSchema` (reused for `/api/providers/test`).
- `mcpServerCreateSchema` / `mcpServerUpdateSchema` / `mcpServerTestSchema` —
  `/api/mcp` server CRUD + test (name, transport enum `stdio|http|sse`, command/args,
  url, env/headers JSON, auth_type enum, optional auth_token).

Invalid input is rejected with `400` before any provider call.

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
