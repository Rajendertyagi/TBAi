# TBAi — Provider-Agnostic AI Chat App

A modern, local-first AI chat application with support for multiple AI providers.

## Tech Stack

| Layer | Technology |
|-------|------------|
| UI | React + TypeScript + Tailwind CSS + shadcn/ui |
| AI Integration | Vercel AI SDK + @assistant-ui/react |
| Backend | Hono + Bun |
| Database | SQLite (via bun:sqlite) |
| State Management | Zustand |
| Validation | Zod |

## Features (V1)

- **Multi-provider support**: OpenAI, Anthropic, Google Gemini, Ollama, and custom endpoints
- **Persistent conversations**: SQLite database with local storage
- **Memory system**: Store important context across conversations
- **Streaming responses**: Real-time token-by-token display
- **Markdown rendering**: Code blocks, formatting, syntax highlighting
- **Search**: Find conversations and messages
- **Portable**: No installer required, data stays local

## Quick Start

### Prerequisites
- Bun runtime installed: https://bun.sh

### Run the app

```bash
# Terminal 1: Start backend
cd D:\Temp\ai-chat-app
bun run dev

# Terminal 2: Start frontend
cd D:\Temp\ai-chat-app\web
bun run dev
```

### Access the app
- Frontend: http://localhost:5173
- Backend API: http://localhost:3000

## API Endpoints

### Providers
- `GET /api/providers` — List all providers
- `POST /api/providers` — Create a new provider
- `PUT /api/providers/:id` — Update a provider
- `DELETE /api/providers/:id` — Delete a provider
- `POST /api/providers/:id/set-active` — Set active provider

### Conversations
- `GET /api/conversations` — List all conversations
- `POST /api/conversations` — Create a new conversation
- `GET /api/conversations/:id` — Get conversation with messages
- `PATCH /api/conversations/:id` — Update conversation
- `DELETE /api/conversations/:id` — Delete conversation

### Chat
- `POST /api/chat` — Send message and receive streaming response

### Memories
- `GET /api/memories` — List all memories
- `POST /api/memories` — Add a memory
- `DELETE /api/memories/:id` — Delete a memory

## Provider Configuration

Add a provider via the Settings panel or API:

```json
{
  "name": "OpenAI",
  "type": "openai",
  "model": "gpt-4o",
  "apiKey": "sk-...",
  "endpoint": "https://api.openai.com/v1"
}
```

Supported types: `openai`, `anthropic`, `google`, `ollama`, `custom`

## Database Location

All data is stored in `./data/chat.db` (relative to the app root).

## Structure

```
ai-chat-app/
├── src/                    # Backend (Bun/Hono)
│   ├── index.ts           # Server entry point
│   ├── db/                # Database setup
│   ├── routes/            # API routes
│   ├── services/          # Business logic
│   ├── config/            # Provider registry
│   └── lib/               # Utilities
├── web/                    # Frontend (React/Vite)
│   ├── src/
│   │   ├── components/    # UI components
│   │   ├── hooks/         # React hooks
│   │   ├── stores/        # Zustand stores
│   │   └── styles/        # CSS
│   └── package.json
├── data/                   # SQLite database
└── package.json
```

## Notes

- API keys are stored locally and never exposed to the browser
- All data stays on your machine (no cloud sync in V1)
- Supports local models via Ollama/LM Studio
- Easy to extend with new providers
