# Plan: MCP Management (living document)

> **Status:** Draft — round 1. Will be updated across multiple rounds.
> **Created:** 2026-10-14
> **Owner:** TBD

This document captures the plan for MCP management across Direct chat and OpenCode
chat. It is a living document — updated each round as decisions are made.

---

## Round 1 — Decisions locked

### MCP management

**Decision:** Each system manages its own MCP servers independently. No sync.

| | Direct Chat | OpenCode Chat |
|---|---|---|
| MCP management | TBAi's MCP panel (`/api/mcp`) | OpenCode's own config/UI |
| MCP servers | TBAi's SQLite | OpenCode's config |
| MCP tools | Merged into AI SDK tools | OpenCode's own tool system |
| Connection lifecycle | TBAi's `mcpManager` | OpenCode's own |

**Why no sync:** Sync between two MCP systems creates coupling, config format
mapping, deferred sync, dual connection lifecycle. Each system is independent and
works standalone. Simpler and safer.

**OpenCode settings in TBAi:** `OpenCodeConfigPage` (permissions only, not MCP).
MCP for OpenCode is managed through OpenCode's own UI/config.

**What stays as-is:**
- TBAi's MCP panel, manager, routes, encryption — all unchanged
- OpenCode's MCP support — used through OpenCode's own UI/config
- No new code needed for "unification" — just accept that they're separate

---

## Round 2 — (pending)

_To be filled in next round._

### Open questions
- [ ] Should TBAi surface OpenCode's MCP config in its own UI (read-only view)?
- [ ] Should TBAi's MCP panel show which servers are also configured in OpenCode?
- [ ] OpenCode MCP config format — does it match TBAi's? (need to verify)

### Per-tool enable/disable (client-side filtering)

**Problem:** An MCP server offers N tools, but the user only wants M of them.
Sending all N tools to the LLM wastes tokens and confuses the model.

**How the ecosystem does it:**
- **Cursor/VS Code/Claude Desktop:** Client-side `disabledTools`/`enabledTools` in config.
  Server still advertises all tools; client filters before sending to LLM.
- **MCP spec:** No standard filtering mechanism. `tools/list` returns all tools.
  SEP-1300 (Groups/Tags) is a proposal, not yet adopted.
- **Server-side dynamic registration:** TypeScript SDK has `RegisteredTool.enable()`/
  `disable()` + `notifications/tools/list_changed`. But this is server-side only
  and the Python SDK maintainers rejected it (needs a SEP).

**Recommended approach for TBAi (client-side filtering):**
1. Add `disabled_tools` (or `enabled_tools`) column to `mcp_servers` table
   (or a separate `mcp_server_tool_filters` table).
2. In `mcpManager.getAiTools()`, filter out disabled tools before returning.
3. Add UI in the MCP panel: per-server tool list with checkboxes to enable/disable.
4. Store the filter in SQLite (encrypted? No — tool names are not secrets).
5. On `tools/list` from the server, apply the filter before merging into AI SDK tools.

**Why client-side (not server-side):**
- Works with any MCP server (no server changes needed)
- Matches what Cursor/VS Code/Claude Desktop do
- No protocol changes needed
- Server still advertises all tools (filtering is TBAi's concern)

**Implementation notes:**
- Tool names are namespaced: `mcp__<serverId>__<toolName>`
- Filter should use the raw tool name (not namespaced) for storage
- When a server's tools change (new tools added), new tools default to enabled
- `notifications/tools/list_changed` could trigger a re-fetch + re-filter

**Effort:** Medium. Requires:
- DB migration (add filter column/table)
- Update `getAiTools()` to apply filter
- MCP panel UI: tool list with checkboxes per server
- REST endpoint for updating tool filters

### MCP SDK upgrade — completed (now on 2.3.1)

TBAi uses `@modelcontextprotocol/client` v2.3.1.

**Key changes in v2.1.0–v2.3.1:**
- **v2.1.0:** List calls (`listTools`, `listPrompts`, `listResources`, `listResourceTemplates`)
  now follow `nextCursor` automatically (returns whole list). `listMaxPages` caps the walk.
  OAuth improvements: `expectedIssuer` on M2M providers, `AuthorizationServerMismatchError`.
- **v2.2.0:** CommonJS type-check fix, `Client.listen()` no longer hangs, `_meta` preserved
  on `input_required`, hostnames ending in `.localhost` count as loopback for OAuth.
- **v2.3.0:** Redirects stay on same origin (HTTP client transports). New options:
  `maxToolInputElements` on McpServer, `expectedResource` on auth. `prompts/get` without
  arguments validated as `{}`. `registerTool` no longer converts schemas up front.
- **v2.3.1:** Minor fixes (`requireBearerAuth` expectedResource, npm page notes).

**Impact on TBAi (client-only):**
- List calls returning whole list could change tool discovery behavior (more tools
  discovered if server paginates). Need to verify `getAiTools` handles this.
- Redirect handling could affect HTTP transport connections to MCP servers.
- No breaking changes for client usage (the "one server per request" change is
  server-side only).

**Recommendation:** Upgrade to 2.3.1. Low risk for client-only usage. Verify tool
discovery and HTTP transport connections after upgrade.

### Deferred items
- ~~Record MCP decision in `docs/decisions.md` (pending)~~ — done
- ~~Upgrade MCP SDK to 2.3.1 (pending)~~ — done
- Progressive discovery, programmatic tool calling, dynamic server management — see `docs/plan-mcp-deferred.md`

---

## Change log

| Round | Date | Changes |
|---|---|---|
| 1 | 2026-10-14 | Initial plan: MCP independent, no sync |
| 2 | 2026-10-14 | Added MCP SDK upgrade analysis |
| 3 | 2026-10-14 | Added per-tool enable/disable (client-side filtering) plan |
### Industry-standard ideas for MCP tool management & UI

Research from official MCP client best practices (2026-07-28 spec) and MCP UI
design patterns (2026). These are ideas to make TBAi's MCP management better and
industry-standard.

#### A. Tool management (backend)

1. **Progressive tool discovery** (official MCP best practice)
   - Don't load all tool definitions upfront. Use a `search_tools` meta-tool.
   - Load full definitions only when the model needs them.
   - Threshold: switch to progressive discovery when tool definitions exceed 1-5%
     of the context window.
   - Reduces token usage dramatically (150K to 2K tokens in examples).
   - TBAi currently loads ALL tools from ALL servers into every request.
   - **Idea:** Add a `search_tools` meta-tool that searches across all connected
     MCP servers. Only inject full schemas for tools the model selects.

2. **Dynamic server management** (official MCP best practice)
   - Connect/disconnect servers on demand, not all at startup.
   - Start with minimal always-on servers; connect others as needed.
   - **Idea:** Add `enable_server`/`disable_server` meta-tools. Agent starts with
     no MCP servers connected; connects them when the task requires.
   - Frees context when servers are no longer relevant.

3. **Programmatic tool calling / Code Mode** (official MCP best practice)
   - Model writes code that calls tools in a sandbox. Only final results return.
   - Reduces token usage for chained tool calls (100K+ to ~15 tokens).
   - **Idea:** TBAi already has a code execution tool. Could route MCP tool calls
     through it for chained operations.
   - Requires sandbox (Deno, isolated-vm, Wasmtime). TBAi already has bash tool.

4. **Caching** (official MCP best practice)
   - Cache tool definitions host-side. Follow `ttlMs` and `cacheScope` hints.
   - Invalidate on `notifications/tools/list_changed`.
   - **Idea:** Memoize `tools/list` results. Re-fetch only on list_changed or TTL expiry.
   - Separate from what's in the model's context (cache vs context).

5. **Prompt caching interaction** (official MCP best practice)
   - Adding/removing tools mid-conversation invalidates prompt cache.
   - Append new definitions after cache breakpoint, or use stable `call_tool`
     meta-tool so the tools array never changes.
   - **Idea:** Use a single `call_tool({name, args})` meta-tool instead of
     injecting individual tool definitions. Tools array stays stable, cache preserved.

6. **Group tools by server** (official MCP best practice)
   - Present tools organized by source server so model can reason about related
     capabilities.
   - **Idea:** Namespace tools as `mcp__<server>__<tool>` (already done) and
     group in the tools array by server.

7. **Offer multiple detail levels** (official MCP best practice)
   - Let model choose between name-only, name+description, or full-schema.
   - **Idea:** `search_tools` returns name+description; `get_tool_details` returns
     full schema. Model only pays for what it needs.

8. **Refresh on `list_changed`** (official MCP best practice)
   - Re-index search catalog when server sends `notifications/tools/list_changed`.
   - **Idea:** Listen for list_changed notifications and re-fetch + re-filter tools.

#### B. UI patterns (frontend)

From MCP UI design patterns (2026) - 7 patterns, ranked by trust impact:

1. **Server connection status surface** (trust: high, difficulty: low, score: 9/10)
   - Persistent UI showing connected servers, health, transport, tool count.
   - One-click access from main chat. Per-server enable/disable toggle.
   - Show last error inline with copy button.
   - **TBAi status:** Has MCP panel. Could improve with health dots, transport badge,
     tool count, last error inline.

2. **Tool call previews with parameter inspection** (trust: high, difficulty: medium, score: 9/10)
   - Show what tool model wants to invoke, with params, before execution.
   - Approve/edit/cancel. Distinguish read-only vs destructive visually.
   - **TBAi status:** Has approval cards. Could improve with destructive highlighting,
     parameter editing before approval.

3. **Local vs remote server distinction** (trust: high, difficulty: low, score: 8/10)
   - Badge showing local/remote. Show endpoint (file path or URL).
   - Warning before connecting to new remote server.
   - **TBAi status:** Not implemented. Add local/remote badge + endpoint display.

4. **Resource browsers** (trust: medium, difficulty: medium, score: 7/10)
   - Show resources (files, docs, tables) alongside tools. Preview without invoking.
   - Show total scope ("this server can read 2,400 files").
   - **TBAi status:** Not implemented. Add resource panel to MCP server detail.

5. **Prompt template galleries** (trust: medium, difficulty: low, score: 7/10)
   - Surface server-provided prompts as slash commands.
   - Show name, source server, description. Required params explicit.
   - **TBAi status:** Not implemented. Add prompt picker.

6. **Per-tool permission scopes** (trust: high, difficulty: high, score: 8/10)
   - Permission matrix: ask every time / auto-approve / never allow.
   - Default destructive tools to ask. Surface policy in tool call preview.
   - **TBAi status:** Partially implemented (approval system). Could add per-tool
     permission matrix in MCP panel.

7. **MCP audit log and replay** (trust: high, difficulty: high, score: 8/10)
   - Record every tool call, resource read, connection. Chronological.
   - Filter by tool/server. Undo where possible. Mark irreversible.
   - **TBAi status:** Has logs panel. Could add MCP-specific audit view.

#### C. Per-tool enable/disable (from earlier research)

- Client-side filtering (Cursor/VS Code/Claude Desktop pattern).
- `disabled_tools` column in `mcp_servers` table.
- Filter in `getAiTools()` before returning.
- New tools default to enabled.
- `notifications/tools/list_changed` triggers re-fetch + re-filter.

#### D. Additional ideas

- **Tool usage analytics:** Track which tools are used most/least. Surface in MCP panel.
- **Tool categories/tags:** Group tools by category (read, write, delete, etc.).
- **Bulk enable/disable:** Enable/disable all tools on a server at once.
- **Tool presets:** Save named sets of enabled tools per server (e.g., "read-only mode").
- **Import/export tool filters:** Share configurations between TBAi instances.
- **Tool search in MCP panel:** Search/filter tools by name or description.
- **Server health monitoring:** Periodic health checks with status history.
- **Tool call cost estimation:** Show estimated token cost per tool call.

#### E. Priority ranking (recommended order)

| Priority | Feature | Effort | Impact |
|---|---|---|---|
| 1 | Per-tool enable/disable (client-side filtering) | Medium | High |
| 2 | Server connection status surface (health, transport, tool count) | Low | High |
| 3 | Local vs remote server distinction | Low | High |
| 4 | Progressive tool discovery (search_tools meta-tool) | High | High |
| 5 | Per-tool permission scopes (ask/auto/never) | Medium | High |
| 6 | Tool call previews with destructive highlighting | Medium | High |
| 7 | Caching (memoize tools/list, invalidate on list_changed) | Low | Medium |
| 8 | Resource browsers | Medium | Medium |
| 9 | Prompt template galleries | Low | Medium |
| 10 | Dynamic server management (connect on demand) | High | Medium |
| 11 | MCP audit log (MCP-specific view) | Medium | Medium |
| 12 | Programmatic tool calling (code mode) | High | Medium |
| 13 | Tool usage analytics | Low | Low |
| 14 | Tool presets / import-export | Low | Low |
### Code study findings (from disk)

Thorough read of all MCP-related code. Key findings for implementation planning.

#### Backend files

| File | Lines | Purpose |
|---|---|---|
| `src/services/mcp/manager.ts` | 1334 | McpManager singleton: lifecycle, discovery, AI SDK bridge |
| `src/services/mcp/store.ts` | 216 | SQLite persistence: McpServerRow ? McpServerConfig |
| `src/services/mcp/transport.ts` | 167 | Transport construction (stdio/http/sse) + SSE probe |
| `src/services/mcp/types.ts` | 188 | All MCP types (config, status, tool info, etc.) |
| `src/services/mcp/classify.ts` | ~100 | SSE failure classification |
| `src/services/mcp/tool-content.ts` | ~50 | MCP content ? text extraction |
| `src/routes/mcp.ts` | 165 | REST boundary: CRUD, connect/disconnect, refresh, test, resource/prompt read, elicitation |
| `src/lib/validation.ts` (MCP section) | ~30 | mcpServerCreateSchema, mcpServerUpdateSchema, mcpServerTestSchema |
| `src/db/index.ts` (mcp_servers) | ~20 | Table DDL + roots migration |

#### DB schema: mcp_servers table

Columns: id, name, transport, command, args, url, env, headers, auth_type, auth_token,
enabled, auto_connect, notes, roots, created_at, updated_at.

**No `disabled_tools` column yet.** Need to add for per-tool filtering.

#### Key code paths for per-tool filtering

1. **`getAiTools()` (manager.ts:1123-1157)** � builds AI SDK tools from connected servers.
   Iterates all connections, all tools. No filtering. This is where disabled-tool
   filtering would go.

2. **`discoverCapabilities()` (manager.ts:687-742)** � discovers tools via `listTools()`.
   Populates `conn.tools`. No filtering at discovery time.

3. **`notifications/tools/list_changed` handler (manager.ts:761-764)** � re-discovers
   capabilities when server sends list_changed. Already triggers re-discovery.

4. **Tool naming:** `mcp__${conn.config.id}__${t.name}` � namespaced by server ID + tool name.

#### Frontend files

| File | Lines | Purpose |
|---|---|---|
| `web/src/features/mcp/components/McpPanel.tsx` | 923 | Full MCP management UI |
| `web/src/features/mcp/state/mcpStore.ts` | 104 | Zustand store for MCP state |
| `web/src/types/index.ts` (MCP section) | ~120 | McpStatus, McpServerDraft, McpTool, etc. |

#### Frontend types: McpStatus

Already includes: tools, resources, prompts, toolCount, resourceCount, promptCount,
status, error, failureReason, serverCapabilities, protocolEra, events, etc.
**No `disabledTools` or `enabledTools` field yet.**

#### Frontend types: McpServerDraft

Fields: name, transport, command, args, url, env, headers, authType, authToken,
enabled, autoConnect, notes, roots.
**No `disabledTools` field yet.**

#### What needs to change for per-tool enable/disable

**Backend:**
1. DB: Add `disabled_tools TEXT` column to `mcp_servers` (JSON array of tool names)
2. store.ts: Add `disabledTools` to McpServerRow, rowToConfig, insertConfig, updateConfigRow
3. types.ts: Add `disabledTools?: string[]` to McpServerConfig and McpStatus
4. validation.ts: Add `disabledTools: z.array(z.string()).optional()` to mcpServerCreateSchema
5. manager.ts: Filter in `getAiTools()` � skip tools whose name is in `conn.config.disabledTools`
6. manager.ts: Include `disabledTools` in `getStatuses()` output
7. routes/mcp.ts: No new endpoint needed � update via existing PUT /servers/:id

**Frontend:**
1. types/index.ts: Add `disabledTools?: string[]` to McpStatus and McpServerDraft
2. mcpStore.ts: No changes needed (uses existing updateServer)
3. McpPanel.tsx: Add per-tool checkboxes in the expanded ServerCard view
   - Show tool list with enable/disable toggle
   - "Enable all" / "Disable all" bulk actions
   - Save disabled tools via updateServer

#### What needs to change for other industry-standard ideas

**Progressive tool discovery (priority 4):**
- Add `search_tools` meta-tool that searches across all connected MCP servers
- Only inject full schemas for tools the model selects
- Requires: new tool definition in src/tools/, new route or integration into chat route
- High effort: changes the tool injection model in the chat route

**Server connection status surface (priority 2):**
- Already mostly implemented: StatusBadge, tool/resource/prompt counts, error display
- Missing: health dots (color-coded), transport badge (already has), last error inline (already has)
- Low effort: minor UI improvements

**Local vs remote distinction (priority 3):**
- Add `isLocal` or `origin` field based on transport type
- stdio = local, http/sse = remote
- Add badge in ServerCard
- Low effort

**Caching (priority 7):**
- Memoize `tools/list` results in discoverCapabilities
- Invalidate on `notifications/tools/list_changed` (already re-discovers)
- Low effort: add a cache map in McpConnection

**Resource browsers (priority 8):**
- Already implemented: ResourceSection with read + insert
- Missing: scope summary ("this server can read 2,400 files")
- Low effort: add scope count display

**Prompt template galleries (priority 9):**
- Already implemented: PromptSection with args + use
- Missing: slash-command picker integration
- Medium effort: integrate with composer

**Per-tool permission scopes (priority 5):**
- Permission matrix: ask/auto/never per tool
- Requires: new DB column or table, new UI, integration with approval system
- Medium-high effort

**MCP audit log (priority 11):**
- Already has events array per server
- Missing: MCP-specific filtered view, undo for reversible actions
- Medium effort

#### Architecture notes

- `getAiTools()` is called per-request in the chat route (need to verify)
- No caching of tool definitions between requests
- All tools from all connected servers are loaded into every request
- Tool execution uses `conn.client.callTool()` with 120s timeout
- `instrumentedExecute` wraps tool execution for logging/metrics
- `notifications/tools/list_changed` already triggers re-discovery

#### Key observations

1. The codebase is well-structured with clear separation: store (DB), manager (lifecycle), transport (construction), types, routes, UI.
2. The lifecycle generation system is sophisticated � handles concurrent connect/disconnect safely.
3. Auth token handling is secure: encrypted at rest, never returned to client, presence-only flag.
4. The UI already shows tools/resources/prompts with expand/collapse.
5. No per-tool filtering exists yet � all discovered tools are exposed.
6. No caching of tool definitions � re-discovered on every list_changed and on connect.
7. The `getAiTools()` method is the single point where tools are exposed to the AI SDK � ideal place for filtering.

---

## Change log (updated)

| Round | Date | Changes |
|---|---|---|
| 1 | 2026-10-14 | Initial plan: MCP independent, no sync |
| 2 | 2026-10-14 | Added MCP SDK upgrade analysis |
| 3 | 2026-10-14 | Added per-tool enable/disable (client-side filtering) plan |
| 4 | 2026-10-14 | Added industry-standard ideas from MCP client best practices + UI patterns |
| 5 | 2026-10-14 | Added code study findings from disk (all MCP files read) |

---

## Round 2 � Code study complete, official docs next

### Status
- Code study: COMPLETE (all MCP files read, findings documented above)
- Official API/docs study: PENDING
- Online research: PENDING

### Next steps
1. Deep study official MCP specification (2026-07-28) and SDK docs
2. Search online for additional patterns and best practices
3. Update plan with findings
4. Begin implementation of priority #1 (per-tool enable/disable)
### Official MCP spec study (2026-07-28)

Key findings from the official MCP specification that affect TBAi's MCP implementation.

#### Tools spec

1. **Model-controlled**: LLM discovers and invokes tools automatically based on context.
2. **Human in the loop**: SHOULD always have human confirmation for tool invocations.
   Applications SHOULD: provide UI showing exposed tools, visual indicators on invocation,
   confirmation prompts for sensitive operations.
3. **Capabilities**: Servers declare `tools` capability with `listChanged` boolean.
4. **Tool list MUST NOT vary per-connection** � but MAY vary by authorization (credentials
   are per-request input, not connection state).
5. **Deterministic ordering**: Servers SHOULD return tools in deterministic order.
   Enables client caching and improves LLM prompt cache hit rates.
6. **Pagination**: `tools/list` supports cursor-based pagination. Clients MUST treat
   cursors as opaque tokens.
7. **Caching**: `ttlMs` (freshness hint) and `cacheScope` ("public"/"private") on list results.
   - `ttlMs: 0` = immediately stale. Positive = fresh for that many ms. Absent = assume 0.
   - `cacheScope: "public"` = no user-specific data, can be shared. `"private"` = user-specific.
   - Notifications invalidate cache immediately (even before TTL expires).
8. **List changed notification**: `notifications/tools/list_changed` when tools change.
   Clients re-fetch `tools/list` on notification.
9. **Tool names**: 1-128 chars, case-sensitive. Allowed: A-Z, a-z, 0-9, _, -, .
   Unique within a server. Clients aggregating from multiple servers MAY encounter
   collisions and SHOULD implement disambiguation (prefixing with server identifier).
   TBAi already does this: `mcp__${serverId}__${toolName}`.
10. **x-mcp-header**: Extension for mirroring tool params into HTTP headers (Streamable HTTP).
    Clients MUST reject tools with invalid x-mcp-header values (exclude from list).
11. **Structured content**: `structuredContent` field in tool results (JSON value).
12. **Output schema**: Optional JSON Schema for tool output validation.
13. **Error handling**: Protocol errors (JSON-RPC, -32602) vs tool execution errors (isError: true).
    Clients SHOULD provide tool execution errors to LLM for self-correction.
14. **Security**: Validate inputs, access controls, rate limiting, sanitize outputs,
    prompt for confirmation, show inputs before calling, validate results, timeouts, audit logging.

#### Caching spec

- Cacheable results: `server/discover`, `tools/list`, `prompts/list`, `resources/list`,
  `resources/templates/list`, `resources/read`.
- Cache key: request method + parameters that affect result.
- TTL: freshness hint, not guarantee. `now < t_received + ttlMs` = fresh.
- Cache scope: "public" (shareable) vs "private" (per-authorization-context).
- Notifications invalidate cache immediately.
- Each paginated page is independently cacheable with its own TTL.
- Clients MAY serve stale responses on re-fetch errors.

#### Pagination spec

- Opaque cursor-based. Page size determined by server.
- Clients MUST treat cursors as opaque tokens (don't parse/modify).
- Missing `nextCursor` = end of results.
- Invalid cursors ? error -32602.

### Online research findings (industry patterns)

#### Client-side filtering (Cursor/VS Code/Claude Desktop/Cline)

Config-based `disabledTools`/`enabledTools` arrays. Zero server changes.
- `disabledTools`: blacklist (all on except listed)
- `enabledTools`: whitelist (all off except listed)
- Both specified ? `enabledTools` takes precedence (whitelist wins)
- Cursor v0.50+ has UI toggle per tool

#### Server-side dynamic registration

Server conditionally registers tools based on role/session/env.
Sends `notifications/tools/list_changed` when list changes.
Client re-fetches `tools/list` without reconnecting.
- Role-based access control (admins see delete_record, users don't)
- Environment variable kill switches (`DISABLED_TOOLS` env var)

#### Activepieces lesson (allowlist ? denylist)

Switched from `enabledTools` (allowlist) to `disabledTools` (denylist) because:
- New tools added later never appeared for users who customized their list
- Only users who never customized (null) got new tools
- Denylist: new tools auto-appear (not in anyone's disabled set)
- Migration: inverted enabledTools ? disabledTools via set-complement SQL

#### oh-my-pi implementation (most comprehensive)

- Both `enabledTools` and `disabledTools` with glob support (`*`, `?`, `[...]`, `{a,b}`)
- Deny-wins precedence (deny subtracts from allow)
- Match against raw server-advertised tool names (not namespaced)
- Unknown entries warned and ignored (typo is loud, upstream rename degrades gracefully)
- Filter-empty: server stays connected but contributes no tools, surfaced as error
- Applies on every registration path (initial, reconnect, refresh, list_changed)
- `isSameMCPConnection` includes normalized filter sets for dedup
- Uses picomatch for glob matching (not hand-rolled fnmatch?regex)

#### OpenAI Agents SDK

- `ToolFilterStatic` with `allowed_tool_names` and `blocked_tool_names`
- Also supports callable filters (function-based)
- `create_static_tool_filter()` convenience function

#### GitHub MCP server

- Three-tier: `EnabledToolsets`, `EnabledTools`, `ExcludeTools`
- Toolsets group related tools; individual tools can be enabled/excluded

#### Key design decisions from research

1. **Denylist vs allowlist**: Support both. Denylist (disabledTools) for auto-appearing new tools.
   Allowlist (enabledTools) for security (new tools don't auto-appear).
   Both specified ? deny-wins (deny subtracts from allow).

2. **Glob support**: Optional but valuable. Start with exact names, add globs later.
   Use a maintained library (picomatch) not hand-rolled fnmatch?regex.

3. **Filter-empty handling**: Server stays connected but contributes no tools.
   Surface as per-server error. Never flip back to connected while empty.

4. **Apply on every path**: Initial connect, reconnect, refresh, list_changed.
   Excluded tools can never be restored into the session.

5. **Match against raw tool names**: Not namespaced names. Server rename doesn't break filter.

6. **Unknown entries**: Warn and ignore (typo is loud, upstream rename degrades gracefully).

7. **Caching**: Follow MCP spec caching hints (ttlMs, cacheScope). Invalidate on list_changed.
   TBAi currently has no caching � re-discovers on every list_changed and on connect.

8. **Progressive discovery**: For large tool sets, use search_tools meta-tool instead of
   loading all definitions upfront. Threshold: 1-5% of context window.

9. **Dynamic server management**: Connect/disconnect servers on demand. Start with minimal
   always-on servers.

10. **Programmatic tool calling**: Model writes code that calls tools in sandbox.
    Only final results return. Reduces token usage for chained calls.

---

## Change log (final)

| Round | Date | Changes |
|---|---|---|
| 1 | 2026-10-14 | Initial plan: MCP independent, no sync |
| 2 | 2026-10-14 | Added MCP SDK upgrade analysis |
| 3 | 2026-10-14 | Added per-tool enable/disable (client-side filtering) plan |
| 4 | 2026-10-14 | Added industry-standard ideas from MCP client best practices + UI patterns |
| 5 | 2026-10-14 | Added code study findings from disk (all MCP files read) |
| 6 | 2026-10-14 | Added official MCP spec study (2026-07-28) + online research findings |

---

## Logging Addendum

All MCP-related code must use the project's logging infrastructure per AGENTS.md:
- **Server:** `src/lib/logger.ts` � `logger.<level>(scope, event, fields)`
- **Frontend:** `web/src/lib/logger.ts` � same pattern
- Stable snake_case event names, structured fields only
- Never `console.log`, never log secrets/tokens/message text
- Every request carries `requestId` (AsyncLocalStorage) � include in new boundaries

### New Log Events by Phase

#### Phase 1 (Per-Tool Filtering) — COMPLETED

| Event | Level | Scope | Fields | When |
|---|---|---|---|---|
| `mcp.tool_filtered` | debug | `mcp` | `mcpServer`, `toolName`, `reason: "disabled"` | When a tool is skipped due to disabled list |
| `mcp.filter_empty` | warn | `mcp` | `mcpServer`, `totalTools`, `disabledCount` | When all tools are filtered out |
| `mcp.filter_unknown_entry` | warn | `mcp` | `mcpServer`, `entry` | When a disabled_tools entry doesn't match any discovered tool |
| `mcp.filter_applied` | debug | `mcp` | `mcpServer`, `totalTools`, `exposedTools`, `disabledCount` | When filter is applied during getAiTools() |

**Files changed:**
- `src/db/index.ts` — added `disabled_tools` column + migration
- `src/services/mcp/types.ts` — added `disabledTools?: string[]` to `McpServerConfig` and `McpStatus`
- `src/lib/validation.ts` — added `disabledTools` to `mcpServerCreateSchema`
- `src/services/mcp/store.ts` — added `disabled_tools` to `McpServerRow`, `rowToConfig`, `insertConfig`, `updateConfigRow`
- `src/services/mcp/manager.ts` — filter in `getAiTools()`, include in `getStatuses()`, log events
- `web/src/types/index.ts` — added `disabledTools?: string[]` to `McpStatus` and `McpServerDraft`
- `web/src/features/mcp/components/McpServerForm.tsx` — per-tool toggle UI (denylist checkboxes)
- `web/src/features/mcp/components/McpPanel.tsx` — pass tools to form, populate disabledTools in startEdit, include in buildPayload

**Verification:** Typecheck exit 0, lint exit 0, build exit 0.

#### Phase 2 (Connection Status and Local/Remote) — COMPLETED

| Event | Level | Scope | Fields | When |
|---|---|---|---|---|
| `mcp.locality_classified` | debug | `mcp` | `mcpServer`, `transport`, `host`, `isLocal` | When local/remote classification is computed |

#### Phase 3 (SDK Upgrade) — COMPLETED

| Event | Level | Scope | Fields | When |
|---|---|---|---|---|
| `mcp.sdk_version` | info | `mcp` | `from=2.0.0`, `to=2.3.1` | On startup after upgrade, log SDK version change |

**Files affected:** `src/services/mcp/manager.ts` (log SDK version on init())

### What NOT to Log

- Tool input arguments (may contain sensitive data)
- Tool output content (may contain sensitive data)
- Auth tokens or credentials
- Full URLs with query parameters (log host/port/path only, per existing `safeEndpointMeta`)
- User messages or conversation content

### Existing Logging to Preserve

The following existing log events must not be removed or changed:
- `mcp.operation` (connect, disconnect, reconnect, sampling, elicitation, resource_read, prompt)
- `mcp.operation` (roots_notify)
- All `logger.info`, `logger.warn`, `logger.error`, `logger.debug` calls in manager.ts, store.ts, transport.ts

---

## Evidence Correction (Round 3)

### SDK Release Page Verification (Direct Inspection)

The following claims were verified by direct inspection of official GitHub release pages:

| Release | Verified Claims | Source | Label |
|---|---|---|---|
| v2.2.0 | Automatic pagination (listTools follows nextCursor), listMaxPages caps walk, CommonJS type-check fix, Client.listen() no longer hangs, _meta preserved on input_required, .localhost counts as loopback for OAuth | GitHub release page (direct inspection) | **Verified** |
| v2.3.0 | Same-origin redirect handling (HTTP client transports), maxToolInputElements on McpServer, expectedResource on auth, prompts/get without args validated as {}, registerTool no longer converts schemas up front, one-server-per-request change (Server.connect() rejects while already connected) | GitHub release page (direct inspection) | **Verified** |
| v2.3.1 | Release date (2026-10-05), package versions (2.3.1 for client/server/core/server-legacy/codemod) | GitHub release page (direct inspection) | **Verified** |
| v2.1.0 | Direct page retrieval failed. Exact claims (list calls follow nextCursor, listMaxPages, OAuth improvements) remain **Unverified**. | GitHub release page (retrieval failed) | **Unverified** |

### Caching Behavior Correction

**Important correction:** The official SDK migration guide documents client-side caching based on `ttlMs` and `cacheScope` for the 2026 protocol. This caching behavior was introduced by the SDK upgrade and is not used by TBAi.

**Current v2.3.1 behavior (Verified):**
- TBAi's `discoverCapabilities()` calls `listTools()` which auto-follows `nextCursor` (v2.3.1 follows pagination automatically)
- No caching of tool definitions � re-discovers on every `list_changed` and on connect
- No reading of `ttlMs` or `cacheScope` from list results

**Future behavior:**
- `listTools()` automatically follows `nextCursor` (returns whole list)
- SDK may provide caching utilities based on `ttlMs` and `cacheScope`
- TBAi would need to decide whether to use SDK-provided caching or implement its own

**Implication:** The plan must distinguish between:
1. What TBAi does today (v2.3.1, auto-pagination, no caching)
2. What TBAi could do next (use SDK-provided caching, implement its own caching)

The caching-spec interpretations in the plan (ttlMs, cacheScope, notification invalidation) are **Verified** as protocol requirements, but TBAi's current client behavior does not implement them. The SDK now supports auto-pagination and caching utilities; TBAi has not yet adopted the caching hints.

### Updated Verification Status

| Claim | Previous Label | Updated Label | Reason |
|---|---|---|---|
| v2.2.0 automatic pagination | Partially Verified | **Verified** | Direct GitHub release page inspection |
| v2.2.0 listMaxPages | Partially Verified | **Verified** | Direct GitHub release page inspection |
| v2.2.0 CommonJS type-check fix | Partially Verified | **Verified** | Direct GitHub release page inspection |
| v2.2.0 Client.listen() no longer hangs | Partially Verified | **Verified** | Direct GitHub release page inspection |
| v2.2.0 _meta preserved on input_required | Partially Verified | **Verified** | Direct GitHub release page inspection |
| v2.3.0 same-origin redirect handling | Partially Verified | **Verified** | Direct GitHub release page inspection |
| v2.3.0 maxToolInputElements | Partially Verified | **Verified** | Direct GitHub release page inspection |
| v2.3.0 expectedResource on auth | Partially Verified | **Verified** | Direct GitHub release page inspection |
| v2.3.0 prompts/get without args | Partially Verified | **Verified** | Direct GitHub release page inspection |
| v2.3.0 registerTool no longer converts schemas | Partially Verified | **Verified** | Direct GitHub release page inspection |
| v2.3.0 one-server-per-request | Partially Verified | **Verified** | Direct GitHub release page inspection |
| v2.3.1 release date and versions | Partially Verified | **Verified** | Direct GitHub release page inspection |
| v2.1.0 all claims | Partially Verified | **Unverified** | Direct page retrieval failed |
| Caching spec (ttlMs, cacheScope, invalidation) | Verified | **Verified** (protocol) / **Unverified** (TBAi client behavior) | Spec is verified; TBAi doesn't implement caching hints |
| TBAi client caching behavior | Not addressed | **Unverified** | TBAi v2.3.1 does not read ttlMs/cacheScope |

### Remaining Gap

v2.1.0 release page could not be retrieved. Its claims (list calls follow nextCursor, listMaxPages, OAuth improvements) remain **Unverified**. However, v2.2.0 and v2.3.0 release notes confirm the same pagination behavior, providing indirect evidence.

### Recommendation

Keep implementation on hold. The evidence report has been corrected. No repository changes or tests have been performed. Awaiting independent review and explicit authorization before any implementation.

---

## Modularity and Scalability Guidelines

### File Size Principle

Per AGENTS.md maintainability protocol: "Do not add a line-count lint rule and do not split a file because it is long." Review is triggered by two conditions: (1) a single function over ~400 lines or a module over ~1000 lines, AND (2) no automated test that would fail if behavior changed during the split.

The current `manager.ts` is 1334 lines. It is a single-owner module with explicit section markers. Splitting it would add indirection and risk regressions. **Do not split manager.ts.**

### Modular Design for New Features

When implementing new MCP features, follow these rules:

1. **One file per concern.** New functionality goes in its own module under `src/services/mcp/`, not appended to manager.ts. Examples:
   - `src/services/mcp/filter.ts` � per-tool filtering logic (pure functions, unit-testable)
   - `src/services/mcp/cache.ts` � discovery caching (if implemented)
   - `src/services/mcp/permissions.ts` � per-tool permission scopes (if implemented)

2. **Manager delegates, doesn't accumulate.** McpManager calls into specialized modules rather than growing. New methods in manager.ts should be thin delegates.

3. **Store stays focused.** `store.ts` owns persistence only. New columns/tables are added via migration, but business logic stays in service modules.

4. **Route stays thin.** `routes/mcp.ts` handles HTTP boundary only. New endpoints delegate to manager or specialized services.

5. **Frontend features are self-contained.** Each UI feature (filtering, status, permissions) lives in its own component under `web/src/features/mcp/components/`. Shared state in `mcpStore.ts`.

6. **No giant files.** If a new module exceeds ~500 lines, consider splitting by sub-concern. If a component exceeds ~300 lines, extract sub-components.

### Scalability Considerations

1. **Tool count scaling:** `getAiTools()` iterates all connections and all tools. For servers with 100+ tools, this is O(n) per request. Filtering reduces the set but doesn't change complexity. If tool counts grow significantly, consider:
   - Caching the filtered tool set (not the raw discovery)
   - Lazy loading tool definitions (progressive discovery) � but only if measured need

2. **Connection count scaling:** `getStatuses()` iterates all configs and connections. For 10+ servers, this is fine. For 100+, consider pagination.

3. **Event history:** `MAX_EVENTS = 50` per connection. Bounded. No scaling concern.

4. **Discovery caching:** If implemented, cache should be per-connection, bounded by TTL, and invalidated on `list_changed`. No global cache.

### Anti-Patterns to Avoid

- Do not create a "utils" or "helpers" file that accumulates unrelated functions
- Do not add 200+ lines to an existing file for a new feature
- Do not create parallel abstractions (e.g., a second MCP manager)
- Do not duplicate filtering logic between backend and frontend
- Do not create a "god component" in the frontend that handles all MCP UI

### File Size Targets for New Modules

| Module | Target Size | Rationale |
|---|---|---|
| `src/services/mcp/filter.ts` | < 150 lines | Pure filtering functions, unit-testable |
| `src/services/mcp/cache.ts` | < 200 lines | Cache implementation, if needed |
| `src/services/mcp/permissions.ts` | < 250 lines | Permission scope logic, if needed |
| `web/src/features/mcp/components/ToolFilter.tsx` | < 200 lines | Per-tool checkbox UI |
| `web/src/features/mcp/components/ServerStatus.tsx` | < 150 lines | Status badge + endpoint display |

### Plan Document Size

This plan document (`docs/plan-mcp.md`) is now 531+ lines. Consider splitting into:
- `docs/plan-mcp.md` � executive summary + phase overview (keep under 200 lines)
- `docs/plan-mcp-phase0.md` � SDK compatibility investigation
- `docs/plan-mcp-phase1.md` � per-tool filtering
- `docs/plan-mcp-phase2.md` � connection status
- `docs/plan-mcp-phase3.md` � SDK upgrade
- `docs/plan-mcp-deferred.md` � deferred features

This keeps each document focused and reviewable.

---

## Code Quality Refactoring (Added)

### Inline Zod Schema Move (Completed)

**What:** Moved inline `z.object({ enabled: z.boolean() })` from `src/routes/mcp.ts` to `src/lib/validation.ts` as `mcpServerEnableSchema`.

**Files changed:**
- `src/lib/validation.ts` � added `mcpServerEnableSchema`
- `src/routes/mcp.ts` � imported and used new schema, removed `z` import

**Verification:** Typecheck passes, no `z` references remain in routes/mcp.ts.

### McpPanel.tsx Refactoring (Completed)

**What:** Extracted the form JSX from `McpPanel()` into a separate `McpServerForm` component. `McpPanel()` is now under 400 lines.

**Files created:**
- `web/src/features/mcp/components/McpServerForm.tsx` — extracted form component (DraftState, emptyDraft, McpServerForm)

**Files modified:**
- `web/src/features/mcp/components/McpPanel.tsx` — imports from McpServerForm, removed unused imports

**Verification:** Typecheck passes, build passes, lint passes.
