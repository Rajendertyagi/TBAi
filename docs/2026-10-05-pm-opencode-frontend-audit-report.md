# PM Focused Audit — OpenCode Frontend Event Pipeline (Report)

**Date:** 2026-10-05
**Answers to:** `docs/pm-opencode-frontend-audit.md`
**Method:** read-only; every answer below is quoted from the working tree on disk (files: `web/src/features/opencode/v2ThreadController.ts` — 953 lines, `v2Runtime.tsx` — 40 lines, `v2Types.ts`, `web/src/config/opencode.ts`, `web/package.json`). No fixes, no suggestions.

---

## 1. The Event Loop

`consumeEvents` — `web/src/features/opencode/v2ThreadController.ts:424-437` (full body):

```ts
async function consumeEvents(currentGeneration: OpenCodeV2Generation): Promise<void> {
  try {
    while (!disposed && generation === currentGeneration) {
      const result = await currentGeneration.events.next();
      if (result.done) throw new Error("OpenCode V2 event stream closed");
      if (disposed || generation !== currentGeneration) return;
      const eventOrdinal = ++ordinal;
      applyEvent(result.value, eventOrdinal);
    }
  } catch (error) {
    if (disposed || generation !== currentGeneration) return;
    scheduleReconnect(safeError(error, "OpenCode V2 event stream failed"));
  }
}
```

Facts around it:
- One consumer loop per connection generation, launched fire-and-forget at `:641` (`void consumeEvents(currentGeneration)`).
- `currentGeneration.events` is the async iterator over the SSE subscription (`web/src/features/opencode/v2Client.ts:178-210`).
- A closed/failed stream (including `result.done`) funnels into `scheduleReconnect` (`:439+`), which aborts the connection, closes the failed generation's iterator, dispatches `connection_changed { type: "reconnecting" }` + `load_failed`, and re-arms a stored timer with capped exponential delay (capped at `OPENCODE_V2_MAX_RECONNECT_DELAY_MS = 10_000`, `web/src/config/opencode.ts:10`). No attempt-count cap exists in this controller.
- Stale-generation guard: after every `await`, the loop re-checks `disposed`/`generation` before touching state.

## 2. The Dispatch Function

`applyEvent` — `web/src/features/opencode/v2ThreadController.ts:405-422` (full body; 17 lines):

```ts
function applyEvent(event: V2Event, eventOrdinal: number): void {
  dispatch({ type: "v2_event", event, ordinal: eventOrdinal, mode: "observe-only" });
  if (isAssistantMessageEvent(event)) {
    if (isHydrating) {
      eventBuffer.push({ ordinal: eventOrdinal, event });
      if (eventBuffer.length > OPENCODE_V2_EVENT_BUFFER_LIMIT) {
        eventBuffer = eventBuffer.filter((entry) => !isAssistantMessageEvent(entry.event)).slice(-OPENCODE_V2_EVENT_BUFFER_LIMIT);
      }
      return;
    }
    dispatch({ type: "v2_event", event, ordinal: eventOrdinal, mode: "observe-and-apply" });
    return;
  }
  dispatch({ type: "v2_event", event, ordinal: eventOrdinal, mode: "observe-and-apply" });
  applyAdmissionEvent(event);
  applyAutoApproveEvent(event);
  applyCompactionLifecycleEvent(event);
}
```

Facts around it:
- Every event first goes through the reducer in `observe-only` mode (identity bookkeeping), then either applies (second dispatch) or is buffered.
- Side-effect handlers run after the applying dispatch: `applyAdmissionEvent` (`:330-355`), `applyAutoApproveEvent` (`:378-403`, fire-and-forget `replyToPermission`), `applyCompactionLifecycleEvent` (`:315-328`).
- `dispatch` itself (`:248-254`): `reduceV2ThreadState(state, action)` → **if the reducer returns the same reference, it returns without notifying** (`if (next === state) return;`) — the no-op identity checks documented at `v2Events.ts:128-132` are what keep the React bridge quiet on events that change nothing.

## 3. The External Store

`web/src/features/opencode/v2Runtime.tsx:16-20` (the whole hook is 10 lines; shown in full):

```tsx
const state = useSyncExternalStore(
  controller.subscribe,
  controller.getState,
  controller.getState,
);
```

- `getSnapshot` is `controller.getState`, which is `() => state` (`v2ThreadController.ts:926`) — it returns the current `V2ThreadState` object (the immutable reducer state held in the closure variable initialized at `:219`).
- `getServerSnapshot` is the same function.
- `subscribe` (`:927-930`): adds the listener to a `Set`, returns a function that removes it:
```ts
subscribe: (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
},
```
- Notification happens in `notify()` (`:242-246`), called only from `dispatch` when the reducer produced a new reference — so a re-render occurs only when the state object's identity actually changed.

## 4. The Adapter Rebuild

`web/src/features/opencode/v2Runtime.tsx:21-25` (full):

```tsx
const adapter = useMemo(
  () => createV2RuntimeStore(controller, state, conversationId),
  [controller, state, conversationId],
);
return useExternalStoreRuntime(adapter);
```

- Depends on: `controller`, `state` (the `V2ThreadState` from §3 — a **new reference on every effective event**), and `conversationId`.
- Returns: the `createV2RuntimeStore(...)` adapter passed to `useExternalStoreRuntime` — i.e. a rebuilt assistant-ui external-store runtime each time `state`'s identity changes. That is the mechanism the codebase documents at `v2Events.ts:128-132` (a fresh array would "rebuild the assistant-ui adapter and re-render the whole transcript").

## 5. Existing Hydration Buffer

Declaration — `v2ThreadController.ts:236`:

```ts
let eventBuffer: Array<{ readonly ordinal: number; readonly event: V2Event }> = [];
```

Buffering (during `isHydrating`, in `applyEvent`, `:408-414`): assistant-message events are pushed with their ordinal; when the buffer exceeds the limit, **non-assistant entries are filtered out and only the last `LIMIT` entries are kept**:

```ts
eventBuffer.push({ ordinal: eventOrdinal, event });
if (eventBuffer.length > OPENCODE_V2_EVENT_BUFFER_LIMIT) {
  eventBuffer = eventBuffer.filter((entry) => !isAssistantMessageEvent(entry.event)).slice(-OPENCODE_V2_EVENT_BUFFER_LIMIT);
}
```

Limit — `web/src/config/opencode.ts:7`:

```ts
export const OPENCODE_V2_EVENT_BUFFER_LIMIT = 512;
```

Flushing (after history load, `:548-557`): before the history fetch, the current ordinal is captured as `historyRequestOrdinal`; after the snapshot is projected and `history_loaded` is dispatched, only buffered events **newer than the history fetch** are replayed, each as `observe-and-apply`, then the buffer is cleared and `isHydrating` set false:

```ts
const historyRequestOrdinal = ordinal;
const snapshot = await loadV2History(currentGeneration.history, { signal: signals.connectionSignal });
…
const buffered = eventBuffer.filter((entry) => entry.ordinal > historyRequestOrdinal);
for (const entry of buffered) dispatch({ type: "v2_event", event: entry.event, ordinal: entry.ordinal, mode: "observe-and-apply" });
eventBuffer = [];
isHydrating = false;
```

Facts: the buffer re-orders events that raced ahead of the history snapshot; it is a re-ordering guard, not a throttle (no batch/coalesce anywhere in `web/src/features/opencode`).

## 6. React Version & Concurrent Features

- Installed: **React 19.2.8** — declared `^19.2.8` in `web/package.json` (`react` and `react-dom`), resolved `19.2.8` in `web/node_modules/react/package.json`.
- `startTransition` / `useTransition` in `web/src/features/opencode/`: **No** — zero matches (grep `startTransition|useTransition` across all `.ts`/`.tsx` in the feature: none).
- `ReactDOM.flushSync` in `web/src/features/opencode/`: **No** — zero matches.

## 7. The State Shape

`V2ThreadState` — `web/src/features/opencode/v2Types.ts:216-268` (interface shown in full; the two doc comments on `occupancyTokens`/`occupancyStale` are abbreviated to keep the snippet short — their content is on disk at :236-263):

```ts
export interface V2ThreadState {
  readonly sessionId: string;
  readonly connection: V2ConnectionState;
  readonly load: V2LoadState;
  readonly execution: V2ExecutionState;
  readonly compaction: V2CompactionState;
  readonly revertRecovery: V2RevertRecoveryState;
  readonly eventIdentity: V2EventIdentityState;
  readonly session: SessionInfo | null;
  readonly model: V2ModelSelection | null;
  readonly agent: string | null;
  readonly desiredModel: V2ModelSelection | null;
  readonly desiredAgent: string | null;
  readonly selectionGeneration: number;
  readonly messages: Readonly<Record<string, V2MessageState>>;
  readonly messageOrder: readonly string[];
  readonly permissions: readonly PermissionRequest[];
  readonly forms: readonly FormInfo[];
  readonly inboxById: Readonly<Record<string, V2InboxRecord>>;
  readonly usage: V2UsageSnapshot | null;
  /** Tokens of the NEWEST assistant response … null until a response reports tokens; not consulted while occupancyStale. */
  readonly occupancyTokens: TokenUsageInfo | null;
  /** True when a compaction has settled and `usage` therefore describes the PRE-compaction prompt. */
  readonly occupancyStale: boolean;
  readonly optimisticMessageIds: readonly string[];
  readonly answeredPermissionIds: readonly string[];
  readonly diagnosticCount: number;
}
```

Facts: the reducer's initial value is `createInitialV2ThreadState(client.sessionId)` (`v2ThreadController.ts:219`); every transition is `reduceV2ThreadState(state, action)` (`:250`); the action vocabulary is the `V2ThreadAction` union in the same file (`v2Types.ts:270+`: `v2_event`, `connection_changed`, `load_*`, `history_loaded`, `compaction_*`, …). All fields are `readonly`; the store hands out the whole object, so any field change is a new reference and (via §3/§4) one full adapter rebuild + provider subtree re-render.
