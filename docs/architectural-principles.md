# TBAi — Durable Architecture Principles

This document is the forward-looking architectural contract for TBAi. It is intentionally
technology-aware but avoids coupling application architecture to any single vendor
implementation.

## Core principle

**TBAi owns orchestration and policy, not infrastructure that is already solved well by
assistant-ui, AI SDK, OpenCode, MCP, or ICM.**

Prefer mature libraries and runtimes. Add custom code only where TBAi has a real application
responsibility, protocol gap, compatibility boundary, or safety policy.

## System boundaries

```
                             TBAi
                              |
             +----------------+----------------+
             |                |                |
        Application       Runtime adapters   MemoryService
             |                |                |
      SQLite application    Direct -> AI SDK   ICM -> shared memory
      state/persistence     OpenCode -> OC     database
                            MCP -> MCP
```

### Responsibilities

| System | Owns |
|---|---|
| TBAi application | orchestration, policy, workspace rules, conversation persistence, scheduler, provider configuration, security, memory policy |
| assistant-ui | chat UI primitives, runtime state, message/tool rendering contracts |
| AI SDK | Direct model execution, streaming, tool execution/continuation contracts |
| OpenCode | coding-agent sessions, coding tools, agent execution, OpenCode protocol |
| MCP | external tool/service protocol |
| ICM | durable memory, semantic recall, embeddings, memory hygiene, memoirs, feedback, optional transcript archive |
| SQLite (TBAi DB) | TBAi-owned application state: conversations, messages, providers, workspaces, scheduler, settings |

## Runtime architecture

TBAi must keep provider/runtime-specific behavior behind runtime and feature boundaries.

```
Direct Chat  -> Direct runtime boundary  -> AI SDK
Code Chat    -> OpenCode V2 feature      -> OpenCode
External     -> MCP boundary             -> MCP servers
```

The rest of TBAi should not depend on provider-specific protocol details.

### Direct Chat

The Direct engine uses AI SDK v7 and the existing assistant-ui runtime/transport.

Do not create a second streaming protocol or application-owned message runtime.

### OpenCode

OpenCode-specific session handling, events, permissions, forms, and
provider-specific mappings stay inside the OpenCode feature boundary.

Do not spread OpenCode wire-format assumptions through generic TBAi UI or application code.

### MCP

Use the official MCP client/protocol implementation. Do not hand-roll JSON-RPC framing or
maintain a second MCP client stack.

## UI architecture

The UI follows a library-first composition model:

```
runtime/tool data
      |
      v
TBAi normalization/adapter
      |
      +--> official assistant-ui element
      |
      +--> small TBAi renderer when a real capability gap exists
```

### Rules

1. assistant-ui is the default UI/runtime layer.
2. Normalize external tool data before rendering.
3. Prefer official assistant-ui elements when their contract is sufficient.
4. Vendored official elements may have small, documented TBAi adaptations for theming,
   compatibility, or real data-shape differences.
5. Do not build a second generic component framework around assistant-ui.
6. Avoid a universal custom tool-card framework that accumulates provider, approval,
   rendering, and lifecycle logic.
7. Custom UI is justified only by an actual application requirement or runtime/protocol gap.

### Tool rendering classes

There are only three conceptual rendering paths:

- **Standard** — ordinary tool fallback/standard assistant-ui rendering.
- **Official rich element** — an assistant-ui element reused through TBAi normalization.
- **TBAi-specific renderer** — only where the official contract cannot represent the needed
  behavior.

This is a presentation decision; tool execution remains owned by the runtime/backend.

## Questions vs permissions

Questions and permissions are different interaction contracts.

### Question

```
Question request
    -> QuestionForm
    -> answers[][]
```

A question may contain multiple questions, single-select or multi-select options, and a
supported custom/freeform response.

Questions must not be represented as approval cards.

### Permission

```
Permission request
    -> approval UI
    -> allow/deny decision
```

Permission/approval infrastructure remains separate.

Do not route question interaction through ApprovalGate, permission APIs, or approval-specific
actions merely because both interactions pause execution.

## Memory architecture

ICM is the durable memory engine.

```
                   MemoryService
                       |
                     ICM
                       |
                shared memory DB
                       |
          +------------+-------------+
          |            |             |
       TBAi Direct  OpenCode      Other agents
        HTTP API    MCP/hooks       MCP/hooks
```

TBAi Direct should use ICM through its persistent local HTTP API. External agents can use
ICM's native MCP/hooks integration. Both paths converge on the same ICM memory corpus.

### Keep databases separate

**TBAi SQLite DB** remains authoritative for application state:

- conversations/messages
- provider configuration
- workspaces/folders
- scheduler
- settings
- other TBAi application metadata

**ICM database** remains authoritative for durable memory:

- memories
- semantic embeddings/search
- memoir knowledge graphs
- feedback/corrections
- optional transcript archive

Never merge these schemas merely for convenience.

### Memory boundary

TBAi owns memory policy:

- what to recall
- when to recall
- scope/project selection
- what is worth storing
- sensitivity/privacy policy

ICM owns memory mechanics:

- storage
- deduplication
- embedding
- ranking
- decay
- consolidation
- retrieval

Expose a TBAi-owned `MemoryService` interface so the application does not depend directly on
ICM implementation details.

## Persistence ownership

Keep these concerns separate:

```
Conversation history -> TBAi SQLite + assistant-ui history adapters
Durable memory     -> ICM
Transient UI state -> React local state / Zustand where appropriate
Runtime liveness   -> assistant-ui / runtime state
```

Do not duplicate conversation/message state in another client store.

Do not replace TBAi conversation persistence with ICM transcript storage.

## Dependency discipline

Before adding code or a dependency:

1. Check whether the required capability already exists in the current runtime/library.
2. Check whether a small adapter/normalization solves the problem.
3. Add a dependency only if it materially reduces application complexity or supplies a
   required capability.
4. Record meaningful architectural dependency decisions in `docs/decisions.md`.

Avoid framework multiplication:
- no second chat runtime
- no second state framework
- no second router
- no second MCP implementation
- no unnecessary agent framework
- no Redis/PostgreSQL/Docker unless a future architectural decision explicitly requires one

## Change strategy

When upstream components evolve:

- keep provider/vendor code behind adapters;
- keep official UI elements isolated from TBAi business logic;
- keep protocol compatibility code narrow and deletable;
- prefer replacing custom implementations with upstream capabilities when they become
  sufficient;
- do not preserve existing custom architecture merely because it already exists.

The desired end state is **thin TBAi composition around mature runtimes**.
