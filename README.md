# TBAi — Provider-Agnostic AI Chat App

A local-first AI chat application with support for multiple AI providers, MCP servers, and a
built-in scheduler. One Hono/Bun process serves both the HTTP API and the built web app, so the
browser talks to a single origin.

## Tech Stack

| Layer | Technology |
|-------|------------|
| UI | React 19 + TypeScript + Vite + Tailwind CSS v4 + shadcn/ui |
| AI Integration | AI SDK v7 (`ai`) + `@assistant-ui/react` |
| Backend | Hono + Bun |
| Database | SQLite (via `bun:sqlite`) |
| State Management | Zustand (UI state only) + assistant-ui thread runtime |
| Validation | Zod |
| Code mode | OpenCode v2 client |
| Desktop shell | Tauri 2 (built in CI only — see [Desktop](#desktop-tauri-shell)) |

## Features

- **Multi-provider support**: OpenAI, Anthropic, Google Gemini, Ollama, and custom OpenAI-compatible
  endpoints
- **Persistent conversations**: SQLite-backed thread and message history that survives reload
- **Code mode**: OpenCode sessions with tools, permissions, forms, terminal and diffs
- **MCP**: register, test, connect and disconnect MCP servers; their tools are exposed to the model
- **Built-in scheduler**: SQLite-backed cron jobs with run history
- **Memory**: store context that persists across conversations
- **Streaming responses**: real-time token-by-token display with reasoning and tool-call rendering
- **Markdown rendering**: code blocks with syntax highlighting, tables, task lists
- **Search**: full-text search across conversation titles and message content
- **Portable**: no installer required; application data is stored locally

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) (this is the only runtime the app needs)

### Install

```bash
bun install
```

### Build and run

The backend serves the compiled web bundle, so build it first:

```bash
# Build the compiled backend and the web bundle
bun run build

# Start the backend (serves the API and the web app on one origin)
bun run dev
```

Then open **http://localhost:3000**.

The port is configurable: an explicit `PORT` environment variable wins, then the value saved in
Settings, then `3000`. If the chosen port is busy the server moves up to the next free one, writes
the effective port to `data/port`, and the status bar at the bottom of the app shows it.

### Frontend iteration

`web/vite.config.ts` defines no dev-server proxy, so the browser is always served by the backend.
To iterate on the frontend, rebuild the bundle on change while the backend keeps serving it:

```bash
# Terminal 1
bun run dev

# Terminal 2
cd web && bun run dev:watch
```

## Development

```bash
bun run typecheck      # tsc across backend, tests and web
bun run lint           # biome ci --error-on-warnings
bun run format:check   # formatting gate
bun run test           # unit + integration (tests/unit, tests/integration)
bun run test:dom       # React/happy-dom suites (tests/dom)
bun run test:e2e       # Playwright against the built app (tests/e2e)
bun run test:locations # asserts every test file lives under tests/
bun run verify         # aggregate gate: typecheck + lint + format:check + tests + build
```

`bun run test:shutdown` is deliberately excluded from `bun run test`: it closes the shared database
singleton and poisons every test file that sorts after it. Run it on its own.

All test files live under `tests/`. `bun run test:locations` enforces this, and it is a CI gate —
a test written anywhere else is collected by no runner and would silently never execute.

## API Endpoints

All routes are served by the same process as the web app.

### System

- `GET /healthz` — liveness
- `GET /readyz` — readiness (pings SQLite)
- `GET /metrics` — metrics
- `GET /api/health` — JSON status

### Chat and conversations

- `POST /api/chat` — send a message, receive a streaming response
- `GET /api/conversations` — list conversations
- `POST /api/conversations` — create a conversation
- `GET /api/conversations/:id` — one conversation record
- `GET /api/conversations/:id/messages` — message history
- `POST /api/conversations/:id/messages` — append a message
- `PATCH /api/conversations/:id` — update title / status / model config
- `DELETE /api/conversations/:id` — delete a conversation

### Providers

- `GET /api/providers` — list providers
- `POST /api/providers` — create a provider
- `PUT /api/providers/:id` — update a provider
- `DELETE /api/providers/:id` — delete a provider
- `POST /api/providers/:id/set-active` — set the active provider
- `POST /api/providers/test` — test a connection
- `POST /api/providers/discover` — list models offered by an endpoint

### Memories

- `GET /api/memories` — list memories
- `POST /api/memories` — add a memory
- `PATCH /api/memories/:id` — update a memory
- `DELETE /api/memories/:id` — delete a memory

### Other feature areas

These are route families mounted in `src/routes/index.ts`. **Methods and exact paths differ per
route** — each entry below describes the area, not a method contract. For the authoritative list,
read the matching file in `src/routes/`.

- `/api/mcp/*` — MCP server registration, connection lifecycle, and capability access
- `/api/scheduler/*` — scheduled jobs, run history, and cron preview
- `/api/folders/*` — conversation folders, groups, and links
- `/api/logs/*` — live log stream, recent entries, log-file listing, and log settings
- `/api/opencode/*` — OpenCode session proxy and Code mode configuration
- `/api/server/*` — active port, port availability check, restart, and startup preferences
- `/api/tools/*` — manual tool surface; normal tool execution is driven by the chat route
- `/api/quick-messages/*` — quick message snippets
- `GET /api/workspace` — workspace info

### Security notes

- API keys and MCP auth tokens are stored encrypted with AES-256-GCM under a per-install key, and
  are not returned to the browser — responses expose only whether a credential is configured. The
  browser sends a provider `id`, never a key.
- The encryption key lives in the same local database as the data it protects, so it guards against
  casual inspection, not against someone who already holds the data file. That trade-off is
  deliberate and documented in `docs/security.md` and in `src/services/credentials.ts`.
- MCP servers are executed **server-side**; the browser only drives configuration and status.

## Provider Configuration

Add a provider in Settings → Providers, or over the API:

```json
{
  "name": "OpenAI",
  "type": "openai",
  "model": "gpt-4o",
  "apiKey": "sk-...",
  "endpoint": "https://api.openai.com/v1"
}
```

Supported types: `openai`, `anthropic`, `google`, `ollama`, `custom`.

## Data Location

Application state lives in `data/chat.db` inside the repository. The path is anchored to the
repository root rather than the process working directory, and can be redirected with the
`DATA_DIR` environment variable — which is how the test suites keep their databases isolated from a
real install.

## Structure

```
ai-chat-app/
├── src/                       # Backend (Bun + Hono)
│   ├── index.ts               # entry point: resolves the port and starts the server
│   ├── server.ts              # startup, shutdown, signal handling
│   ├── routes/                # HTTP boundary, one module per concern, composed in index.ts
│   │   └── chat/              # /api/chat: index.ts is the route entry, the rest are its phases
│   ├── services/              # business logic and orchestration
│   │   ├── storage/           # conversations, messages, memories
│   │   ├── mcp/               # MCP client, connection lifecycle
│   │   ├── chat-streams/      # durable resumable stream store
│   │   ├── scheduler/         # cron jobs and unattended execution
│   │   └── opencode/          # OpenCode process and session boundary
│   ├── db/                    # SQLite ownership
│   │   ├── index.ts           # connection + schema
│   │   └── schema/chat-streams.ts
│   ├── tools/                 # server-side tool definitions
│   ├── context/               # context assembly, budgeting and compaction
│   ├── config/                # provider registry and configuration
│   ├── lib/                   # shared utilities (logging, validation, model messages)
│   └── types/
├── web/                       # Frontend (React + Vite)
│   └── src/
│       ├── main.tsx, App.tsx   # shell and router wiring
│       ├── runtime.ts         # chat runtime + transport to /api/chat
│       ├── app/               # routing, adapters and app shells
│       ├── features/          # feature-owned UI and state (chat, mcp, memories,
│       │                      #   opencode, scheduler, sidebar, providers, …)
│       ├── components/        # shared components, UI primitives, vendored elements
│       ├── adapters/          # thread-list and history adapters (HTTP)
│       ├── config/            # navigation and view configuration
│       ├── lib/               # browser utilities, logging, platform
│       └── tools/             # tool renderers
├── tests/                     # every test file and test-only asset
│   ├── unit/ integration/ dom/ e2e/
│   └── helpers/ fixtures/ harness/ setup/
├── scripts/                   # build, verification and profiling tooling
├── docs/                      # architecture and engineering documentation
├── src-tauri/                 # Tauri desktop shell
├── data/                      # SQLite database and logs (gitignored)
└── package.json
```

## Documentation

Start with these before changing anything:

- `AGENTS.md` — the development rules this repository is held to
- `docs/architectural-principles.md` — the forward-looking architecture contract
- `docs/architecture.md` — the current architecture as implemented
- `docs/engineering-quality.md` — the mandatory local and CI checks
- `docs/state-management.md` — who owns which state
- `docs/decisions.md` — architectural decision records
- `tests/README.md` — how tests are organized and why

`docs/performance-baseline.md` and `docs/TBAiPERFORMANCEAUDIT.md` are historical records. They
contain statements known to be out of date and are kept only for their decision history.

## Desktop (Tauri shell)

Ordinary application development is local and needs only Bun — every command in
[Development](#development) above runs on your machine with no extra toolchain.

**The desktop shell cannot be built or run locally as things stand.** There is no local Rust or
Tauri toolchain, and `package.json` defines no script that builds the shell. The Tauri CLI is
present only as a devDependency, and `tauri build` additionally needs Rust plus the Windows
WebView2 build tools.

The shell is therefore built **exclusively in CI**, by `.github/workflows/tauri-build.yml`, which
runs on `windows-latest`: it installs Bun and Rust, installs dependencies, typechecks, builds the
web bundle and backend, stages the compiled binary for `externalBin`, and finally runs
`tauri build --bundles zip` to produce a portable archive.

The desktop app is a Tauri 2 window that loads the same web app and spawns the compiled backend as
a sidecar. `bun run build:backend` compiles that binary to `dist/tbai-server` (with a platform
suffix such as `.exe` on Windows); `tauri.conf.json` declares it under `externalBin` as
`binaries/tbai-server`, with `beforeBuildCommand: bun run build`.

## Notes

- Application data — conversations, messages, settings and credentials — is stored locally in
  `data/chat.db`. This app performs no cloud sync.
- Sending a message transmits that turn's content to whichever provider endpoint is configured. An
  endpoint running on your own machine (for example a local Ollama server) receives the request
  locally. Any endpoint on another machine — a hosted provider's API, or a self-hosted or custom
  OpenAI-compatible server on someone else's infrastructure — receives the request over the
  network, so that turn's content leaves your machine. Being "custom" or "OpenAI-compatible" does
  not make an endpoint local; what matters is where the server runs. Once a request has left your
  machine, its handling is outside this application's control.
- Stored memories are not included in prompts unless `TBAI_MEMORY_ENABLED` is set to exactly `1`
  or `true`. It is unset by default, and with it off no memory is retrieved or injected. When it is
  on, selected memories become model-visible context and are sent to whichever provider handles
  the turn.
- Supports local models via Ollama and any OpenAI-compatible endpoint
- Easy to extend with new providers
