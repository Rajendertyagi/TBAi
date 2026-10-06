# PM Focused Audit — OpenCode Frontend Event Pipeline

**Purpose:** Facts only. No fixes. No suggestions. Code snippets max 15 lines each.

---

## 1. The Event Loop

Show the full body of `consumeEvents` in `web/src/features/opencode/v2ThreadController.ts`.

---

## 2. The Dispatch Function

Show the full body of `applyEvent` (or whatever function processes a single event and calls dispatch) in `v2ThreadController.ts`.

---

## 3. The External Store

Show the full body of `useSyncExternalStore` wiring in `web/src/features/opencode/v2Runtime.tsx` — specifically how `getSnapshot` is defined and what it returns.

---

## 4. The Adapter Rebuild

In `v2Runtime.tsx`, show the `useMemo` that rebuilds the adapter. What does it depend on? What does it return?

---

## 5. Existing Hydration Buffer

In `v2ThreadController.ts`, show the `eventBuffer` logic — how events are buffered during hydration, how they are flushed, and what the buffer limit is.

---

## 6. React Version & Concurrent Features

- What React version is installed? Check `web/package.json`.
- Is `startTransition` or `useTransition` used anywhere in `web/src/features/opencode/`? Yes/No + file + line if yes.
- Is `ReactDOM.flushSync` used anywhere in `web/src/features/opencode/`? Yes/No + file + line if yes.

---

## 7. The State Shape

What is the shape of the state object held by the external store in `v2ThreadController.ts`?
Show the TypeScript type/interface definition for the controller state.

---

## Delivery

Return as markdown. One section per question. Facts and code only.
