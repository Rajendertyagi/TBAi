# Architectural Study & Implementation Plan: Message-Level Error Boundaries & Stream Retry UX

**Date:** 2026-10-10  
**Status:** PROPOSED / STUDY & PLAN COMPLETE  
**Primary Standards:** Official React 19 Error Boundary Specification & `@assistant-ui/react` Primitives  
**Constraints:** Library-first, no external dependencies, zero changes to frozen dependency trees.

---

## 1. Executive Summary & Existing Foundations

TBAi's Direct chat architecture is built on `@assistant-ui/react`, `@assistant-ui/ai-sdk`, AI SDK v7, and SQLite. A comprehensive codebase inspection reveals that the underlying streaming and error-detection plumbing is already functional:

1. **Server-Verified Stream Recovery (`streamRecovery.ts`):**  
   [`web/src/features/chat/state/streamRecovery.ts`](file:///D:/Temp/ai-chat-app/web/src/features/chat/state/streamRecovery.ts) manages run outcomes through `/api/chat/stream-status`. If Bun terminates unexpectedly or a connection drops, the server classifies the terminal status (`interrupted`, `reply_lost`, `request_failed`, etc.) and preserves the prompt for safe re-submission.
2. **Error Presentation Primitive (`ChatWindow.tsx`):**  
   [`web/src/components/ChatWindow.tsx`](file:///D:/Temp/ai-chat-app/web/src/components/ChatWindow.tsx) implements `<AssistantError>` using `@assistant-ui`'s official `<MessagePrimitive.Error>` and `<ErrorPrimitive.Root>`.
3. **Turn Regeneration Primitive (`ChatWindow.tsx`):**  
   [`web/src/components/ChatWindow.tsx`](file:///D:/Temp/ai-chat-app/web/src/components/ChatWindow.tsx) mounts `<ActionBarPrimitive.Reload>` to invoke `aui.message.reload()` and branch the conversation from the message's parent.

### Identified Gaps
* **Gap A (Crash Containment):** There is no React Error Boundary around individual rows inside the virtualized transcript. If malformed Markdown, unhandled tool payloads, or syntax highlighting plugins throw an uncaught JavaScript error during rendering, React 19 bubbles the exception up to the root `<RouteError>`, crashing the entire application window.
* **Gap B (Error Action UX):** The `<AssistantError>` banner currently only displays text (`"Connection lost."` or API messages). The `<ActionBarPrimitive.Reload>` control is located in the message footer as a low-prominence hover icon. Users experiencing a dropped connection must discover the footer icon rather than having an immediate **"Retry"** action inside the error card.

---

## 2. Part A: Message-Level Error Boundaries (Safety Net)

### 2.1 Official Specification
* **React Core Specification:** [React Error Boundaries](https://react.dev/reference/react/Component#catching-rendering-errors-with-an-error-boundary).  
  React requires a class component declaring `static getDerivedStateFromError` and `componentDidCatch`.
* **Assistant-UI Recommendation:** Wrap message rows in standard React error boundaries to isolate plugin rendering failures (Shiki, Mermaid, math) from the thread runtime.

### 2.2 Design & Component Boundary
A lightweight component, `MessageErrorBoundary`, wraps individual rows mounted by the virtualizer:

```text
VirtualizedTranscript (Scroller)
  └── Virtualizer Items (.map)
        └── MessageErrorBoundary (Isolates component crashes)
              └── ThreadPrimitive.Row
                    ├── UserMessage
                    └── AssistantMessage (Markdown, Code, Tools)
```

### 2.3 Failure Mode Behavior
* **Normal Operation:** Passes children through with zero overhead.
* **Component Crash in Message #N:**
  1. Exception is caught and contained within Message #N.
  2. Error is logged through standard structured logging: `logger.error("chat", "message_render_failed", { error })`.
  3. Message #N renders an accessible fallback card:
     ```
     [!] This message could not be displayed. [Try Re-rendering]
     ```
  4. Messages #1 through #(N-1), Message #(N+1), composer input, and navigation remain fully functional.

---

## 3. Part B: Stream Failure & Retry UX (Network Resilience)

### 3.1 Official Specification
* `@assistant-ui/react`:
  * `<MessagePrimitive.Error>`: Conditionally renders when `message.status.type === "incomplete"` and `status.reason === "error"`.
  * `<ErrorPrimitive.Root>`: Renders an accessible container (`role="alert"`).
  * `<ActionBarPrimitive.Reload>`: Native regeneration action that triggers `aui.message.reload()`.

### 3.2 Visual & Interaction Design

#### Current Layout:
```text
┌───────────────────────────────────────────────┐
│ 🔴 Connection lost.                           │  <-- Informational text only
└───────────────────────────────────────────────┘
                                       [📋] [🔄]  <-- Regenerate icon hidden in footer
```

#### Proposed Integrated Layout:
```text
┌────────────────────────────────────────────────────────┐
│ 🔴 Connection lost.                                    │
│    [ 🔄 Retry ]                                        │  <-- Prominent retry trigger
└────────────────────────────────────────────────────────┘
```

* **Interaction Logic:**
  * When a transport drop or provider error occurs, `<ErrorPrimitive.Root>` presents the error classification alongside `<ActionBarPrimitive.Reload asChild>`.
  * Clicking `Retry` triggers runtime regeneration without requiring manual prompt re-entry.
  * The control automatically disables while the thread is active (`thread.isRunning`), preventing concurrent requests.
  * The secondary footer reload icon is retained for general regeneration on completed messages.

---

## 4. Execution Plan (Pending Implementation Authorization)

### Phase 1: Message-Level Error Boundary
1. Create `web/src/components/chat/MessageErrorBoundary.tsx`:
   * Implement class-based boundary with `getDerivedStateFromError` and `componentDidCatch`.
   * Include localized reset state (`handleRetryRender`).
2. Integrate into `web/src/components/ChatWindow.tsx`:
   * Wrap row outputs within `renderRow` in `MessageErrorBoundary`.
   * Enforce boundary around both `UserMessage` and `AssistantMessage`.

### Phase 2: Integrated Error Card Retry Action
1. Modify `AssistantError` in `web/src/components/ChatWindow.tsx`:
   * Compose `<ActionBarPrimitive.Reload asChild>` within `<ErrorPrimitive.Root>`.
   * Apply consistent styling matching the design system (`text-destructive`, border styling).
2. Maintain existing footer actions for non-error turns.

### Phase 3: Verification & Acceptance
1. `bun run typecheck`: Confirm TypeScript compilation across backend and frontend.
2. `bun run test:dom`: Execute full DOM test suite (all 76 tests must pass).
3. `bun run test:e2e p2-measurements.spec.ts`: Verify virtualization layout integrity.
4. `bun run test:e2e scroll-to-latest.spec.ts`: Confirm auto-follow and scroll behavior.
5. `bun run build`: Execute production bundle build to ensure clean asset generation.
