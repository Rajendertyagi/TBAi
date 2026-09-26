# MCP — Model Context Protocol Client

TBAi includes a **standards-based generic MCP client** built on the official
[`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk). It
connects to **any** compliant MCP server over **STDIO**, **Streamable HTTP**, or **legacy SSE**,
discovers its capabilities (tools, resources, prompts, server info), and exposes those tools to the
chat model via **AI SDK v7** `tool()` wrappers. No server-specific code is required — point TBAi at
a server and its tools become model-callable automatically.

## Design principles

- **Library-first / minimum custom code.** We use the official MCP TypeScript SDK for the wire
  protocol, transports, and notification schemas. We do **not** hand-roll JSON-RPC or MCP framing.
- **AI SDK v7 for the model surface.** MCP tools are wrapped with AI SDK v7 `tool()` (input schema +
  `execute`), then merged into the `streamText({ tools })` call in the chat route. We intentionally
  did **not** use `@ai-sdk/mcp` so we retain full control over connection lifecycle, status,
  cancellation, and capability surfacing in the GUI.
- **Server-side execution.** MCP tools run on the backend (the MCP `Client` lives in the Node/Bun
  process). The browser never talks to an MCP server directly; it only drives the config/status GUI
  over the `/api/mcp` REST API.
- **Portable config.** Server definitions are stored in SQLite (`mcp_servers` table). Auth tokens are
  encrypted at rest with the same local DEK as provider keys (see `security.md`).
- **Non-coder-friendly GUI.** The MCP panel (`web/src/components/McpPanel.tsx`) lets a user add a
  server by name + transport + command/URL, test the connection, watch live status, browse the
  discovered tools/resources/prompts, and see recent server notifications — no JSON, no CLI.

## Architecture

```
Browser (McpPanel + mcpStore)
  └─ HTTP REST /api/mcp/*  (CRUD, enable, connect/disconnect, refresh, test)
         ▼
Backend (Hono + Bun)
  ├─ src/routes/mcp.ts            → /api/mcp sub-app (Zod-validated)
  ├─ src/services/mcp/manager.ts  → McpManager singleton (mcpManager)
  │    ├─ buildTransport()        → Stdio / StreamableHTTP / SSE transports
  │    ├─ connect/disconnect/refresh/reconnect
  │    ├─ notification handlers   → progress, tool/resource/prompt list-changed,
  │    │                            resource-updated, logging (buffered per connection)
  │    ├─ discovery               → listTools / listResources / listPrompts / server capabilities
  │    ├─ getAiTools()            → Record<mcp__<id>__<tool>, AI SDK tool()>
  │    └─ testConnection(input)   → one-off connect, no persistence
  ├─ src/services/mcp/types.ts    → MCP shared types
  ├─ src/lib/validation.ts        → mcpServerCreate/Update/TestSchema
  ├─ src/services/credentials.ts  → encryptSecret/decryptSecret (auth tokens)
  ├─ src/db/index.ts              → mcp_servers table
  └─ src/routes/index.ts          → chat route merges mcpManager.getAiTools() into tools
```

The chat route builds the tool set as:

```ts
tools: { ...nativeTools, run_command: withTerminalOutput(...), ...mcpManager.getAiTools() }
// plus a matching toolsContext map (native tools only) for streamText
```

`nativeTools` are server-executed tools (native AI SDK `tool()` defs with zod
schemas + `execute` in `src/tools/index.ts`, sandboxed `services/tools.ts`;
privileged ones gated by server `toolApproval`, rendered by the client
toolkit in `web/src/tools/`).
MCP tools are distinct: they are **server-executed** through the
`Client.callTool()` call inside each `execute` function. Namespacing
(`mcp__<serverId>__<toolName>`) prevents collisions between servers and keeps tool names stable
across reconnects.

## McpManager (`src/services/mcp/manager.ts`)

A singleton (`mcpManager`) that owns all MCP connections for the process.

- **Transports**
  - `stdio`: `StdioClientTransport` with `command`, `args[]`, `env`, `stderr: "pipe"`. `env` is
    merged over `process.env` (so `PATH` is inherited and server CLIs resolve).
  - `http`: `StreamableHTTPClientTransport` with `url`, `requestInit.headers` built from
    `auth_type`/`auth_token` (bearer → `Authorization: Bearer …`, basic → `Authorization: Basic
    base64(token)`, oauth → bearer).
  - `sse`: `SSEClientTransport` (legacy MCP servers) with the same auth header construction.
- **Connection lifecycle.** `connect(config)` builds a `Client` (`@modelcontextprotocol/sdk/client`),
  passes client capabilities `{ sampling: {}, elicitation: {}, roots: { listChanged: false } }`
  (these are **client** capabilities — do not set `tools/resources/prompts` here; those are server
  capabilities), attaches notification handlers, calls `client.connect()`, then discovers tools /
  resources / prompts and stores `serverInfo` + `capabilities`.
- **Reconnect.** On an unexpected transport close, the manager attempts to reconnect up to
  `MAX_RECONNECT_ATTEMPTS` (5) with a `RECONNECT_DELAY_MS` (5000) backoff, unless the disconnect was
  intentional. Reconnect re-runs discovery so the GUI stays in sync.
- **Status.** Each connection tracks `status` (`disconnected|connecting|connected|error`),
  `toolCount`/`resourceCount`/`promptCount`, `error`, `serverInfo`, `capabilities`, `lastConnectedAt`,
  and a rolling `events[]` buffer of recent notifications (progress, list-changed, logging, errors).
- **Cancellation.** `execute` forwards the AI SDK `abortSignal` into `client.callTool({ ..., abortSignal })`
  so a cancelled tool call propagates to the MCP server.
- **`testConnection(input)`** builds a throwaway client, connects, lists capabilities, and returns
  `{ ok, toolCount, resourceCount, promptCount, serverInfo, capabilities, error? }`. It persists
  nothing and always closes the client — used by the GUI "Test connection" button and the
  `/api/mcp/servers/test` route.
- **`init()`** (called once in `src/server.ts`) connects every stored server with `enabled` **and**
  `autoConnect` set. Failures are recorded as a connection `error` rather than crashing startup
  (fire-and-forget, errors logged/redacted).

## REST API (`/api/mcp`)

All bodies validated with Zod. Errors are redacted (see `src/lib/redact.ts`).

| method | path                              | purpose                                                  |
|--------|-----------------------------------|----------------------------------------------------------|
| GET    | `/api/mcp/servers`                | list all configured servers (status echoed)              |
| POST   | `/api/mcp/servers`                | create (validated); if `enabled`+`autoConnect`, connects |
| PUT    | `/api/mcp/servers/:id`            | update (partial; preserves omitted fields)               |
| DELETE | `/api/mcp/servers/:id`            | delete (also disconnects)                                |
| POST   | `/api/mcp/servers/:id/enable`     | body `{ enabled: boolean }` — set enabled, connect/disconnect |
| POST   | `/api/mcp/servers/:id/connect`    | connect now                                              |
| POST   | `/api/mcp/servers/:id/disconnect` | disconnect now                                           |
| POST   | `/api/mcp/servers/:id/refresh`    | re-discover tools/resources/prompts                      |
| POST   | `/api/mcp/servers/test`           | one-off `testConnection` (no persist) → `{ ok, ... }`    |

The list/detail responses echo a `status` sub-object (`status`, counts, `error`, `serverInfo`,
`capabilities`, `lastConnectedAt`) alongside the stored config so the GUI can render live state
without a second call. Auth tokens are **never** returned; only `authType` is echoed.

## Storage (`mcp_servers` table, `src/db/index.ts`)

| column       | type    | notes                                                              |
|--------------|---------|--------------------------------------------------------------------|
| id           | TEXT PK | generated id (used in tool namespace `mcp__<id>__<tool>`)          |
| name         | TEXT    | user-facing label                                                  |
| transport    | TEXT    | `CHECK` `stdio|http|sse`                                           |
| command      | TEXT    | STDIO command (e.g. `npx`)                                         |
| args         | TEXT    | JSON array of args (e.g. `["-y", "@wonderwhy-er/desktop-commander@latest"]`) |
| url          | TEXT    | HTTP/SSE URL                                                      |
| env          | TEXT    | JSON object of extra env vars                                     |
| headers      | TEXT    | JSON object of extra HTTP headers                                 |
| auth_type    | TEXT    | `none|bearer|basic|oauth`                                          |
| auth_token   | TEXT    | **encrypted** (`encryptSecret`); never returned to the browser    |
| enabled      | INTEGER | whether to connect on startup / when toggled                      |
| auto_connect | INTEGER | connect automatically on `init()`                                 |
| notes        | TEXT    | free text                                                         |
| created_at   | INTEGER |                                                                    |
| updated_at   | INTEGER |                                                                    |

Auth tokens use the same AES-256-GCM local DEK as provider keys (`encryptSecret`/`decryptSecret` in
`src/services/credentials.ts`); only `auth_type` is ever echoed to the browser.

## Frontend

- `web/src/types/index.ts` — `McpServerConfig`, `McpConnectionStatus`, `McpToolInfo`,
  `McpResourceInfo`, `McpPromptInfo`, `McpEvent`, `McpStatus`, `McpTestResult`, and the UI-side
  `McpServerDraft`.
- `web/src/config/navigation.ts` — adds a `mcp` view (`ViewId`) and a bottom-nav entry (Plug icon),
  configuration-driven like every other nav item.
- `web/src/stores/mcpStore.ts` — Zustand store for the server list, selected server, test status, and
  live events; fetches from `/api/mcp`.
- `web/src/components/McpPanel.tsx` — the management GUI: add/edit/delete, enable toggle,
  connect/disconnect/refresh, **Test connection**, and panels for tools / resources / prompts plus a
  recent-events feed. Non-coder-friendly: transport + auth pickers, key-value env/header editors, no
  raw JSON.
- `web/src/App.tsx` — renders `McpPanel` for the `mcp` view.

## Resources & prompts into chat

Discovered resources and prompts are no longer display-only. From a server's expanded card in the MCP
panel:

- **Resources** → **Insert** reads the resource (`client.readResource`) and drops its text into the
  chat composer (prefixed with the resource URI) so you can review/edit before sending. Backed by
  `POST /api/mcp/servers/:id/resource/read`.
- **Prompts** → **Use** resolves the prompt (`client.getPrompt`) — filling in any declared arguments —
  and drops the resulting text into the composer. Backed by
  `POST /api/mcp/servers/:id/prompt/get`.

Both routes are thin wrappers over `McpManager.readResource` / `getPrompt`. The web app watches a
`pendingInsert` value in `mcpStore` and `ChatComposerBridge` (inside `ComposerPrimitive.Root`) writes
it into the composer via `unstable_useComposerInput().setText`.

## Advanced client capabilities (roots, sampling, elicitation)

TBAi advertises the full client capability set and now *consumes* all three:

- **Roots** — a server may call `roots/list`; TBAi answers with the URIs configured per server
  (`roots` field in the add/edit form, stored in `mcp_servers.roots`, e.g.
  `file:///C:/Users/you`). Registered via `client.setRequestHandler(ListRootsRequestSchema, …)`.
- **Sampling** — a server may call `sampling/createMessage`; TBAi fulfills it by generating text with
  the **active provider** (`generateText` via `getModel` + `CredentialStore`). Registered via
  `client.setRequestHandler(CreateMessageRequestSchema, …)`. Requires a configured, keyed provider.
- **Elicitation** — a server may call `elicitation/create` mid-tool-call to ask the *user* a question.
  TBAi holds the request, exposes it via `GET /api/mcp/elicit/pending`, and a global
  `ElicitationModal` (polled every 1.5s) renders the form (or URL confirmation). The user's answer is
  posted to `POST /api/mcp/elicit/resolve`, which resolves the handler. Registered via
  `client.setRequestHandler(ElicitRequestSchema, …)`.

## Verified behavior

- **STDIO** (scripts/minimal-mcp-server.mjs): connect, discover 3 tools / 1 resource / 1 prompt,
  execute `echo` / `add`, error path throws, `readResource` returns text, `getPrompt` returns messages,
  `testConnection` succeeds. Covered by `scripts/test-mcp.ts` (PASSED).
- **Streamable HTTP** (scripts/minimal-mcp-http.mjs on `:8787`): `testConnection` succeeds, 2 tools
  discovered. Covered by `scripts/test-mcp.ts` (PASSED).
- **Live REST API** (scripts/test-mcp-api.mjs and scripts/test-mcp-api2.mjs against a running server):
  create → auto-connect → discover (3/1/1) → `resource/read` → `prompt/get` → `elicit/pending` (null) →
  test → `GET /` serves the web app → delete. PASSED.
- **Typecheck + build** (backend + `web`) pass.

## Known gaps / next

- **SSE transport** is implemented using the official `SSEClientTransport` but not yet exercised
  against a live legacy SSE server.
- **Sampling** requires a configured, keyed active provider; it was verified to compile and route
  correctly but not exercised end-to-end here (no provider key in the test environment).
- **Elicitation** is fully wired (handler + REST + modal) but not exercised end-to-end here because it
  needs a server that issues an elicitation during a tool call plus a live chat to trigger it.
- **Desktop Commander MCP** (`npx -y @wonderwhy-er/desktop-commander@latest`) is the intended first
  real-world test server. It requires Node/npm/npx on `PATH`; those are **not** present in the
  current Windows test environment (only Bun), so it was validated via a Bun-based minimal MCP server
  instead. Run it on a machine with Node to confirm the full file-system tool surface.
- **Resource/prompt invocation from chat** is discoverable in the GUI but not yet auto-wired into the
  composer; only **tools** are currently exposed to the model.
