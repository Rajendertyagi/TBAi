# Plan: Deferred MCP Features (Progressive Discovery, Programmatic Tool Calling, Dynamic Server Management)

> **Status:** Draft — planning only, no implementation.
> **Created:** 2026-10-15
> **Owner:** TBD
> **Prerequisite:** Phases 1-3 complete (per-tool filtering, local/remote, SDK upgrade).

This document captures the plan for three deferred MCP features identified in
`docs/plan-mcp.md` §Industry-standard ideas. Each is high-effort, high-impact,
and requires careful design before implementation.

---

## 1. Progressive Tool Discovery

### Problem

TBAi loads ALL tools from ALL connected MCP servers into every request via
`mcpManager.getAiTools()`. When servers expose many tools, tool definitions
can consume 150K+ tokens — often exceeding the context window or leaving
little room for conversation history.

**Current behavior:**
- `buildToolLayer()` (context/assemble.ts:161) calls `mcpManager.getAiTools()`
- All discovered tools (filtered by disabledTools) are injected as individual
  AI SDK tool definitions
- Tool definitions are measured and budgeted (measureToolDefinitions)
- If budget exceeded, request is rejected or reduced

**Evidence:** Official MCP best practice recommends progressive discovery when
tool definitions exceed 1-5% of the context window. TBAi currently has no
threshold — it always loads everything.

### Solution: `search_tools` + `get_tool_details` meta-tools

Instead of injecting all tool definitions, inject two lightweight meta-tools:

1. **`search_tools(query)`** — searches across all connected MCP servers.
   Returns tool names + descriptions (no schemas). Lightweight (~2K tokens).

2. **`get_tool_details(toolNames[])`** — returns full JSON schemas for
   selected tools. Only pays for what the model needs.

The model calls `search_tools` → picks relevant tools → calls `get_tool_details`
→ then calls the actual tool via the existing `mcp__<server>__<tool>` name.

### Architecture

```
┌─────────────────────────────────────────────────┐
│  buildToolLayer()                               │
│                                                 │
│  if (totalToolDefTokens < threshold) {          │
│    // Current behavior: inject all tools        │
│    tools = { ...native, ...mcpTools }           │
│  } else {                                       │
│    // Progressive: inject meta-tools only       │
│    tools = {                                    │
│      ...native,                                 │
│      search_tools: searchToolsMetaTool,          │
│      get_tool_details: getToolDetailsMetaTool,   │
│    }                                            │
│  }                                              │
└─────────────────────────────────────────────────┘
```

**Meta-tool implementations:**

```typescript
// search_tools: returns name + description for all tools across all servers
const searchTools = tool({
  description: "Search available MCP tools by keyword. Returns tool names and descriptions.",
  inputSchema: z.object({ query: z.string() }),
  execute: async ({ query }) => {
    const allTools = mcpManager.getToolCatalog(); // name + description only
    const matches = allTools.filter(t =>
      t.name.includes(query) || t.description?.includes(query)
    );
    return matches.map(t => ({ name: t.name, description: t.description }));
  },
});

// get_tool_details: returns full schemas for selected tools
const getToolDetails = tool({
  description: "Get full input schemas for specific MCP tools.",
  inputSchema: z.object({ toolNames: z.array(z.string()) }),
  execute: async ({ toolNames }) => {
    const schemas = mcpManager.getToolSchemas(toolNames);
    return schemas;
  },
});
```

### Key Design Decisions

1. **Threshold-based switching:** Only use progressive discovery when tool
   definitions exceed 1-5% of the context window. Below threshold, inject all
   tools (simpler, better cacheability).

2. **Two-pass vs single meta-tool:** The two-pass approach (search → details →
   call) requires the model to make multiple round-trips. An alternative is a
   single `call_tool({name, args})` meta-tool that takes a tool name and
   arguments, looks up the schema internally, and calls the tool. This keeps
   the tools array stable (better cache) but loses type safety in the schema.

3. **Per-conversation activation:** Once a tool is activated (schema fetched),
   it should remain available for the rest of the conversation. Track activated
   tools per conversation in SQLite or in-memory.

4. **Cache interaction:** Adding/removing tools mid-conversation invalidates
   prompt cache. The `call_tool` meta-tool approach avoids this by keeping the
   tools array stable.

### Files to Modify

| File | Change |
|---|---|
| `src/services/mcp/manager.ts` | Add `getToolCatalog()` (name+desc) and `getToolSchemas(names)` methods |
| `src/context/assemble.ts` | Add threshold check in `buildToolLayer()`; inject meta-tools when exceeded |
| `src/tools/` | Add `search_tools` and `get_tool_details` tool definitions |
| `src/context/types.ts` | Add `progressiveDiscovery` flag to assembly input |
| `src/db/index.ts` | Add `activated_tools` column to conversations (or separate table) |

### Effort: High

- Requires new meta-tools with proper schemas
- Requires threshold logic in assembly
- Requires per-conversation state tracking
- Requires testing with large tool sets
- Cache interaction needs careful handling

### Risks

- Two-pass approach increases latency (extra round-trips)
- Model may not use search_tools effectively (needs good descriptions)
- Threshold tuning requires experimentation
- Cache invalidation if tools array changes

---

## 2. Programmatic Tool Calling (Code Mode)

### Problem

Chained tool calls waste tokens. Each intermediate result goes through the
model's context. A chain of 5 tool calls can consume 100K+ tokens when only
the final result matters.

**Current behavior:**
- Model calls tool A → result in context → model calls tool B → result in context → ...
- Each intermediate result is part of the conversation history
- `reduceToolResults` (context/assemble.ts) reduces large results but doesn't
  eliminate intermediate steps

**Evidence:** Official MCP best practice shows 100K+ → ~15 tokens reduction
with programmatic tool calling.

### Solution: Code execution sandbox with MCP tool access

The model writes code that calls MCP tools in a sandbox. Only the final
output returns to the model.

```typescript
// Model writes:
const users = await mcp.call("github", "list_users", { org: "acme" });
const active = users.filter(u => u.active);
const details = await Promise.all(
  active.map(u => mcp.call("github", "get_user", { id: u.id }))
);
return details.map(d => ({ name: d.name, email: d.email }));
```

Only the final array returns to the model — not the intermediate user lists.

### Architecture

```
┌─────────────────────────────────────────────────┐
│  New tool: execute_code                         │
│                                                 │
│  input: { code: string }                        │
│  execute: async ({ code }) => {                 │
│    const sandbox = createSandbox({               │
│      mcp: mcpManager,  // tool access           │
│      timeout: 30000,                            │
│    });                                          │
│    const result = await sandbox.run(code);      │
│    return result;                               │
│  }                                              │
└─────────────────────────────────────────────────┘
```

**Sandbox requirements:**
- Isolated execution (no filesystem, no network, no process spawning)
- Access to MCP tools via a controlled API (`mcp.call(server, tool, args)`)
- Timeout enforcement
- Memory limits
- No access to TBAi internals or secrets

### Sandbox Technology Options

| Option | Pros | Cons |
|---|---|---|
| **Deno** (subprocess) | Strong isolation, TypeScript support, permission flags | Requires Deno binary, subprocess overhead |
| **isolated-vm** (npm) | In-process, V8 isolates, fast | Native addon, memory limits tricky |
| **Wasmtime** (WASM) | True sandbox, language-agnostic | Complex setup, limited JS support |
| **QuickJS** (WASM) | Lightweight, fast, WASM-based | Limited API surface, no async/await natively |
| **Node vm module** | Built-in, no deps | NOT a security boundary (can escape) |

**Recommendation:** Deno subprocess with `--allow-none` (no permissions) and
a controlled MCP bridge via stdin/stdout. This provides true isolation while
supporting TypeScript/JavaScript with async/await.

### MCP Bridge Protocol

The sandbox communicates with TBAi's backend via a simple JSON-RPC over
stdin/stdout:

```
Sandbox → TBAi: { "method": "mcp.call", "params": { "server": "github", "tool": "list_users", "args": { "org": "acme" } } }
TBAi → Sandbox: { "result": [...] }
```

TBAi's backend handles the actual MCP tool call and returns the result.

### Files to Modify

| File | Change |
|---|---|
| `src/tools/execute-code.ts` | New tool definition with sandbox execution |
| `src/services/sandbox/` | New directory: sandbox manager, Deno subprocess, MCP bridge |
| `src/services/mcp/manager.ts` | Add `callTool(serverId, toolName, args)` public method (already exists internally) |
| `src/context/assemble.ts` | Add `execute_code` to native tools when enabled |
| `src/config/` | Add sandbox config (timeout, memory, enabled flag) |

### Effort: High

- Requires sandbox infrastructure (Deno or alternative)
- Requires MCP bridge protocol
- Requires security review
- Requires testing with various code patterns
- Deno binary dependency

### Risks

- Security: sandbox escape could compromise the server
- Performance: subprocess overhead for each code execution
- Complexity: maintaining sandbox + bridge protocol
- Model may write incorrect code (needs good error messages)
- TBAi already has bash tool that runs with server privileges — this is
  a different (safer) execution path

### Relationship to Existing Bash Tool

TBAi's `run_command` tool runs shell commands with the server's own
privileges (not sandboxed). `execute_code` would be a separate, sandboxed
path for programmatic tool calling. The two coexist:

- `run_command`: shell access, server privileges, for system tasks
- `execute_code`: sandboxed, MCP tool access, for chained tool calls

---

## 3. Dynamic Server Management

### Problem

All enabled+autoConnect MCP servers connect at startup (`init()` in manager.ts).
This wastes resources and context when servers aren't needed for the current task.

**Current behavior:**
- `init()` connects all enabled+autoConnect servers
- `getAiTools()` returns tools from all connected servers
- Servers stay connected until manually disconnected
- No on-demand connect/disconnect

**Evidence:** Official MCP best practice recommends starting with minimal
always-on servers and connecting others as needed.

### Solution: Meta-tools for server lifecycle

Add three meta-tools that the model can use to manage MCP servers:

1. **`list_mcp_servers()`** — returns all configured servers with status,
   tool count, and whether they're connected.

2. **`enable_mcp_server(serverId)`** — connects the server, discovers tools,
   adds to active set. Returns tool count.

3. **`disable_mcp_server(serverId)`** — disconnects, removes tools from
   active set. Frees context.

The agent starts with only "always-on" servers connected. When a task requires
a server's tools, the model calls `enable_mcp_server` to connect it.

### Architecture

```
┌─────────────────────────────────────────────────┐
│  init()                                         │
│                                                 │
│  // Only connect "always-on" servers            │
│  for (const cfg of configs) {                   │
│    if (cfg.enabled && cfg.autoConnect &&        │
│        cfg.alwaysOn) {                          │
│      void this.connect(cfg.id);                 │
│    }                                            │
│  }                                              │
│                                                 │
│  // Non-always-on servers are available but     │
│  // not connected until explicitly enabled      │
└─────────────────────────────────────────────────┘
```

**Meta-tool implementations:**

```typescript
const listMcpServers = tool({
  description: "List all configured MCP servers with their status and tool count.",
  inputSchema: z.object({}),
  execute: async () => {
    return mcpManager.getStatuses().map(s => ({
      id: s.id,
      name: s.name,
      status: s.status,
      toolCount: s.toolCount,
      connected: s.status === "connected",
    }));
  },
});

const enableMcpServer = tool({
  description: "Connect to an MCP server and make its tools available.",
  inputSchema: z.object({ serverId: z.string() }),
  execute: async ({ serverId }) => {
    await mcpManager.connect(serverId);
    const status = mcpManager.getStatus(serverId);
    return { connected: true, toolCount: status?.toolCount ?? 0 };
  },
});

const disableMcpServer = tool({
  description: "Disconnect from an MCP server and free its tools from context.",
  inputSchema: z.object({ serverId: z.string() }),
  execute: async ({ serverId }) => {
    await mcpManager.disconnect(serverId);
    return { disconnected: true };
  },
});
```

### Key Design Decisions

1. **`alwaysOn` flag:** Add `always_on` column to `mcp_servers` table.
   Servers with `alwaysOn=true` connect at startup (like current behavior).
   Others are available but not connected until explicitly enabled.

2. **Cache interaction:** Connecting/disconnecting servers changes the tools
   array, which invalidates prompt cache. To mitigate:
   - Use a stable `call_tool` meta-tool (single tool definition that takes
     name + args) instead of injecting individual tool definitions
   - Or accept cache invalidation for dynamic management (simpler)

3. **Per-conversation vs global:** Server connections are global (shared across
   conversations). Enabling a server in one conversation makes its tools
   available in all conversations. This is simpler but may not be ideal.

4. **Auto-disconnect:** Optionally disconnect servers after a period of
   inactivity to free resources. Configurable timeout.

### Files to Modify

| File | Change |
|---|---|
| `src/db/index.ts` | Add `always_on` column to `mcp_servers` + migration |
| `src/services/mcp/types.ts` | Add `alwaysOn?: boolean` to `McpServerConfig` and `McpStatus` |
| `src/services/mcp/store.ts` | Handle `always_on` in row mapping, insert, update |
| `src/services/mcp/manager.ts` | Modify `init()` to only connect always-on servers; add `getStatus(id)` method |
| `src/lib/validation.ts` | Add `alwaysOn` to `mcpServerCreateSchema` |
| `src/tools/` | Add `list_mcp_servers`, `enable_mcp_server`, `disable_mcp_server` tool definitions |
| `src/context/assemble.ts` | Inject meta-tools when dynamic management is enabled |
| `web/src/types/index.ts` | Add `alwaysOn` to `McpStatus` and `McpServerDraft` |
| `web/src/features/mcp/components/McpServerForm.tsx` | Add "Always on" checkbox |

### Effort: High

- Requires new meta-tools
- Requires DB migration
- Requires init() changes
- Requires cache interaction handling
- Requires UI changes

### Risks

- Cache invalidation when tools array changes
- Model may not use enable/disable effectively
- Global vs per-conversation state confusion
- Complexity of tracking active server set

---

## Combined Architecture: Meta-Tool Layer

All three features share a common pattern: replacing individual tool definitions
with meta-tools that the model uses to discover and invoke tools dynamically.

```
┌─────────────────────────────────────────────────────────────┐
│  buildToolLayer()                                           │
│                                                             │
│  const mcpTools = mcpManager.getAiTools(signal);            │
│  const toolDefTokens = measureToolDefinitions(mcpTools);    │
│                                                             │
│  if (dynamicManagementEnabled) {                            │
│    // Dynamic: meta-tools for server lifecycle + search      │
│    tools = {                                                │
│      ...native,                                             │
│      list_mcp_servers, enable_mcp_server,                   │
│      disable_mcp_server, search_tools,                       │
│      get_tool_details, call_tool,                            │
│    };                                                       │
│  } else if (toolDefTokens > threshold) {                    │
│    // Progressive: search + details + call_tool              │
│    tools = {                                                │
│      ...native,                                             │
│      search_tools, get_tool_details, call_tool,              │
│    };                                                       │
│  } else {                                                   │
│    // Current: inject all tools directly                     │
│    tools = { ...native, ...mcpTools };                      │
│  }                                                          │
└─────────────────────────────────────────────────────────────┘
```

### The `call_tool` Meta-Tool

A single stable tool definition that takes a tool name and arguments:

```typescript
const callTool = tool({
  description: "Call an MCP tool by name. Use search_tools to find available tools.",
  inputSchema: z.object({
    name: z.string().describe("Tool name (mcp__<server>__<tool>)"),
    args: z.record(z.unknown()).optional().describe("Tool arguments"),
  }),
  execute: async ({ name, args }) => {
    const tool = mcpTools[name];
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    return tool.execute(args);
  },
});
```

This keeps the tools array stable (one definition) regardless of how many
MCP tools are available, preserving prompt cache.

### Implementation Order (Recommended)

| Priority | Feature | Effort | Impact | Dependencies |
|---|---|---|---|---|
| 1 | Dynamic server management | High | Medium | `alwaysOn` flag, meta-tools |
| 2 | Progressive discovery | High | High | `search_tools`, `get_tool_details`, threshold logic |
| 3 | Programmatic tool calling | High | Medium | Sandbox infrastructure, MCP bridge |

**Rationale:** Dynamic server management is the foundation — it controls which
servers are connected, which affects how many tools need discovery. Progressive
discovery builds on top. Programmatic tool calling is independent but requires
the most infrastructure (sandbox).

### Shared Infrastructure Needed

1. **Meta-tool framework:** A way to register meta-tools that have access to
   `mcpManager`. Currently tools are defined in `src/tools/` and imported
   statically. Meta-tools need runtime access to the manager.

2. **Threshold configuration:** A config value for the progressive discovery
   threshold (default: 1% of context window). Stored in `src/config/`.

3. **Per-conversation state:** Track which tools/servers are activated per
   conversation. Could use SQLite (conversations table) or in-memory with
   conversation ID as key.

4. **Sandbox (for programmatic tool calling):** Deno subprocess or alternative.
   Requires security review and testing.

### What NOT to Do

- Do not implement all three at once. Each is a separate, large piece of work.
- Do not change the default behavior. Current "inject all tools" remains the
  default. New features are opt-in via config.
- Do not break existing tests. All current tests must continue to pass.
- Do not add a second MCP client library. Use the existing `@modelcontextprotocol/*`.
- Do not merge Direct Chat and OpenCode MCP. They remain independent.

---

## Change log

| Date | Changes |
|---|---|
| 2026-10-15 | Initial plan for three deferred features |
