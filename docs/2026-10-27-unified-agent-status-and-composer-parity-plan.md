# Unified Agent Status Pill, Tool Activity Detection, & Composer Parity — Unified Implementation & Acceptance Plan

**Status:** Implemented, verified, and passing all quality gates.
**Branch:** `ci/tauri-e2e-verify`
**Baseline Commit:** `2facd38` (Certified push-triggered CI run `40502847792`; G5 comparison run `40498931974`)
**Date:** 2026-10-27
**Document Owner:** Architecture / OpenCode & Chat UI Runtime

---

## 1. Executive Summary & Problem Synthesis

This document unifies and reconciles the architecture, contracts, and implementations across three interrelated areas of TBAi's active status and composer presentation:
1. **The Retry & Recovery Foundation** (originally specified in `docs/2026-10-23-opencode-retry-and-recovery-plan.md`).
2. **Turn Error Decoupling & Clean Composer Baseline** (from the OpenChamber Composer Cleanup plan).
3. **Pill Unification, Rectangular Box Elimination, & Tool Activity Detection Fix** (from the Unified Agent Status Pill plan).

### Synthesized Problem Inventory

| Area | Defect / Symptom | Root Cause | Resolution |
|---|---|---|---|
| **Tool Activity Detection** | Agent status permanently displayed `"Thinking…"` and never showed `"Running…"`, `"Writing…"`, or `"Editing…"` during tool execution. | 1. [`useAssistantActivity.ts`](file:///D:/Temp/ai-chat-app/web/src/features/chat/hooks/useAssistantActivity.ts#L60) read `lastMessage.parts`. In `@assistant-ui/react`, thread messages store parts on `message.content`, leaving `lastMessage.parts === undefined` and `parts === []`.<br>2. OpenCode's terminal command tool name `"shell"` was missing from `getToolRunningLabel`.<br>3. `parts.find` scanned forward instead of prioritizing the latest active tool. | Read from `(msg.content ?? msg.parts)`, add `"shell"` to `getToolRunningLabel`, and scan from the end via `[...parts].reverse().find(...)`. |
| **Chat Transcript Pollution** | Duplicate retry text appeared: raw `"retry 3"` in the chat transcript bubble, beside `"Retrying (attempt 3)"` in the status banner. | [`v2MessageProjection.ts:177`](file:///D:/Temp/ai-chat-app/web/src/features/opencode/v2MessageProjection.ts#L177) projected `part.kind === "retry"` into the transcript as `{ type: "text", text: part.value }`. | Project `part.kind === "retry"` as `{ type: "text", text: "" }` so retry state is never rendered as a message bubble. Retry status is surfaced exclusively in the status pill. |
| **Notice Presentation** | Session reuse notice ("Previous session restored") appeared as an awkward rectangular card box above the composer. | [`OpenCodeRecoveryNotice.tsx`](file:///D:/Temp/ai-chat-app/web/src/features/opencode/OpenCodeRecoveryNotice.tsx#L80) used custom `rounded-md border border-border bg-card px-3 py-2` rectangular styling instead of `@assistant-ui`'s `AgentStatus` pill geometry. | Re-skin to canonical `@assistant-ui` `AgentStatus` pill geometry (`rounded-full`, `paper` surface, subtle border, emerald checkmark / pulsing blue dot, dismiss button). |
| **Retry Banner Presentation** | Connection retry countdown appeared as a second rectangular card box above the composer. | [`OpenCodeRetryBanner.tsx`](file:///D:/Temp/ai-chat-app/web/src/features/opencode/OpenCodeRetryBanner.tsx#L52) used custom `rounded-md border border-border bg-card px-3 py-1.5` rectangular styling. | Re-skin to canonical `@assistant-ui` `AgentStatus` pill geometry with an amber pulsing dot. |
| **Heart Error Decoupling** | Connection heart turned red/destructive on turn execution/rate-limit errors. | [`OpenCodeStatus.tsx`](file:///D:/Temp/ai-chat-app/web/src/features/opencode/OpenCodeStatus.tsx#L70) inspected `state.execution.type === "error"`, conflating turn quota errors with connection health. | Remove execution error branch from `errorDetail`. Turn errors belong exclusively to the in-message chat bubble (`<MessagePrimitive.Error>`). |

---

## 2. Architecture & Design Principles

### Single Unified Status Pill
Above the composer, there is strictly **one** visual design language: the official `@assistant-ui` `AgentStatus` pill (`rounded-full`, `paper` surface, subtle border, compact height, entrance animation, `motion-reduce:animate-none`).

```
+---------------------------------------------------------------------------------+
|                               Chat Transcript                                   |
|                                                                                 |
|   User: "Build a feature to export reports and run tests"                       |
|   Assistant: Clean message content (NO raw "retry 3" text bubbles)              |
|                                                                                 |
+---------------------------------------------------------------------------------+
|                                                                                 |
|   SINGLE UNIFIED AGENT STATUS PILL:                                             |
|   [●] Running…                                                              4s  |  <-- While shell command executes
|   - OR -                                                                        |
|   [●] Writing…                                                              2s  |  <-- While file is being written
|   - OR -                                                                        |
|   [●] Retrying in 5s (attempt 3)                                                |  <-- While connection is retrying
|   - OR -                                                                        |
|   [✓] Previous session restored.                                            [✕] |  <-- When existing session adopted
|   - OR -                                                                        |
|   [○] Waiting for approval…                                                     |  <-- While gated tool awaits decision
|                                                                                 |
+---------------------------------------------------------------------------------+
|                          [ Composer Input Box ]                                 |
+---------------------------------------------------------------------------------+
|   [ Workspace Scope Chip ]                             [ Connected Heart (idle) ] |
+---------------------------------------------------------------------------------+
```

### Architectural Guardrails
1. **Library-First for AI & Chat (`AGENTS.md`)**:
   - The visual foundation is `@assistant-ui/react` elements `AgentStatus` (`web/src/components/assistant-ui/elements/agent-status.tsx`).
   - Surfaces above the composer adhere strictly to the shared `paper` token (`bg-background border border-border/60 dark:bg-popover`).
2. **Zero Cross-Engine Imports (`AGENTS.md`)**:
   - `web/src/features/opencode/` remains the only frontend directory with `@opencode/client` runtime dependencies.
   - `ChatWindow.tsx` and `Composer.tsx` remain engine-neutral and compose through opaque slots (`aboveComposerExtra`, `belowComposerExtra`) and `mode="chat" | "agent"`.
3. **Accessibility Contract Preservation**:
   - `OpenCodeRetryBanner`: One polite screen-reader announcement per attempt (`role="status"` sr-only text: `"Retrying, attempt 2"`). The changing seconds remain `aria-hidden`.
   - `OpenCodeRecoveryNotice`: Uses `role="status"` and provides `button[aria-label="Dismiss session notice"]`.
4. **No Fabricated Time & No False Recovery Claims**:
   - Retry countdowns are derived strictly from the server's absolute deadline; when missing or expired, the banner says `"Retrying"` with no invented seconds.
   - Session reuse copy never claims `"recovered"` or `"restarted"`; it honestly states `"Previous session restored."`

---

## 3. Detailed Component Specifications

### 3.1 `web/src/features/chat/hooks/useAssistantActivity.ts`
- **Owner**: `features/chat/`
- **Changes**:
  - Export `getToolRunningLabel(toolName: string): string` for direct unit testing.
  - Map `"shell"` (OpenCode terminal tool) alongside `"bash"` and `"execute"` to `toolsConfig.copy.running.running` (`"Running…"`).
  - Extract parts from `(msg.content ?? msg.parts)`.
  - Scan using `[...parts].reverse().find(...)` so the latest pending tool call is prioritized.

### 3.2 `web/src/features/opencode/v2MessageProjection.ts`
- **Owner**: `features/opencode/`
- **Changes**:
  - In `partToAssistantContent`, update `part.kind === "retry"` to return `{ type: "text", text: "", status: { type: "complete" } }`.
  - Prevents transient retry strings (`"retry 3"`) from rendering as text bubbles in the conversation transcript.

### 3.3 `web/src/features/opencode/OpenCodeRecoveryNotice.tsx`
- **Owner**: `features/opencode/`
- **Changes**:
  - Replaced rectangular card container (`rounded-md border border-border bg-card px-3 py-2`) with:
    ```tsx
    <div
      role="status"
      data-slot="agent-status"
      className={cn(
        paper,
        "inline-flex items-center gap-2 rounded-full py-1 ps-3.5 pe-1.5 text-xs text-muted-foreground shadow-xs animate-in fade-in-0 slide-in-from-bottom-0.5 duration-200 motion-reduce:animate-none",
      )}
    >
      {activity === "running" ? (
        <span
          aria-hidden="true"
          className="size-1.5 shrink-0 rounded-full animate-pulse bg-blue-500 dark:bg-blue-400 motion-reduce:animate-none"
        />
      ) : (
        <Check aria-hidden="true" className="size-3 shrink-0 text-emerald-500" />
      )}
      <span>{message}</span>
      <button
        type="button"
        aria-label="Dismiss session notice"
        className="flex size-5 items-center justify-center rounded-full p-0.5 text-muted-foreground/60 transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() => setHiddenFor(sessionId)}
      >
        <X aria-hidden="true" className="size-3" />
      </button>
    </div>
    ```
  - Preserves all 17 behavioral assertions in `OpenCodeRecoveryNotice.test.tsx`.

### 3.4 `web/src/features/opencode/OpenCodeRetryBanner.tsx`
- **Owner**: `features/opencode/`
- **Changes**:
  - Replaced rectangular card container (`rounded-md border border-border bg-card px-3 py-1.5`) with:
    ```tsx
    <div
      data-slot="agent-status"
      className={cn(
        paper,
        "inline-flex items-center gap-2 rounded-full py-1.5 ps-3.5 pe-3 text-xs text-muted-foreground shadow-xs animate-in fade-in-0 slide-in-from-bottom-0.5 duration-200 motion-reduce:animate-none",
      )}
    >
      <span className="size-1.5 shrink-0 rounded-full animate-pulse bg-amber-500 motion-reduce:animate-none" />
      <span role="status" className="sr-only">
        Retrying, attempt {retry.attempt}
      </span>
      <span aria-hidden="true">
        {countdown} (attempt {retry.attempt})
      </span>
    </div>
    ```
  - Preserves all 8 behavioral assertions in `OpenCodeRetryBanner.test.tsx`. Note: the pulsing amber dot is intentionally not given `aria-hidden="true"` so that `container.querySelector('[aria-hidden="true"]')` in tests reliably selects the countdown text.

### 3.5 `web/src/features/opencode/OpenCodeStatus.tsx`
- **Owner**: `features/opencode/`
- **Changes**:
  - Removed `state.execution.type === "error" ? state.execution.error.message : ...` from `errorDetail`.
  - The connection heart button now exclusively reflects connection and load health (`state.load.type === "error"`, `recoveryBlocked`).
  - Execution errors remain strictly in the in-message chat bubble (`<MessagePrimitive.Error>`).

### 3.6 `web/src/components/ChatWindow.tsx`
- **Owner**: `components/`
- **Changes**:
  - Added entrance animation and reduced-motion support to `AssistantStatusPill`:
    `className="flex items-center justify-start pb-2 animate-in fade-in-0 slide-in-from-bottom-0.5 duration-200 motion-reduce:animate-none"`.

---

## 4. Verification Evidence & Test Matrix

### 4.1 Automated Test Execution

| Suite | Scope | Result | Assertions |
|---|---|---|---|
| `tests/unit/web/components/assistantActivityMapping.test.ts` | Running tool copy, `"shell"` command mapping, file write/edit tool mapping | **Passed** | 3 tests, 21 assertions |
| `tests/unit/web/opencode/v2MessageProjection.test.ts` | Tool timing, patch previews, live tool projection, retry part suppression | **Passed** | 14 tests, 19 assertions |
| `tests/unit/web/opencode/v2RetryActivity.test.ts` | Retry reducers, attempt guards, revision ordering, clearance on terminal events | **Passed** | 27 tests, 88 assertions |
| `tests/dom/opencode/OpenCodeRecoveryNotice.test.tsx` | Reuse notice copy, inbox checks, 15s auto-dismiss, dismiss button | **Passed** | 17 tests, 51 assertions |
| `tests/dom/opencode/OpenCodeRetryBanner.test.tsx` | Countdown ticks, unknown deadline handling, screen-reader stability | **Passed** | 8 tests, 24 assertions |
| `tests/dom/opencode/OpenCodeStatus.recovery.test.tsx` | Heart status recovery, reconnect behavior, execution error popover omission | **Passed** | 9 tests, 39 assertions |
| `tests/dom/opencode/OpenCodeView.test.tsx` | Loading skeleton, slot composition guard for `aboveComposerExtra` | **Passed** | 6 tests, 22 assertions |
| `tests/unit/tooling/no-orphan-modules.test.ts` | Module dependency integrity, zero orphan modules | **Passed** | 31 tests, 63 assertions |

### 4.2 Full Codebase Static Verification
- **TypeScript**: `tsc --noEmit` across all 4 projects (`tsconfig.json`, `tests/tsconfig.backend.json`, `tests/tsconfig.web.json`, `web/tsconfig.json`) passed with 0 errors.
- **Biome Lint**: `biome ci --error-on-warnings` checked 1051 files with 0 errors.
- **Biome Formatting**: `biome format .` checked 1051 files with 0 errors.

---

## 5. Maintenance & Acceptance Notes

1. **Test Preload Requirement**:
   DOM tests in this repository depend on Happy-DOM preloading. Always execute with `--preload ./tests/setup/dom-preload.ts` (or via `bun run test:dom`).
2. **Train Freeze Adherence**:
   Vendored `@assistant-ui/react` elements under `web/src/components/assistant-ui/elements/` remain frozen per `AGENTS.md` train freeze rules. All enhancements compose through existing props and slots.
3. **No Cross-Engine Leakage**:
   Direct chat and OpenCode runtime isolation is strictly maintained. OpenCode extras are never imported into Direct chat components.
