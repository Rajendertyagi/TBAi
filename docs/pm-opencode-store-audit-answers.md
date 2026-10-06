# PM Focused Audit — createV2RuntimeStore Internals (Answers)

Answers to `docs/pm-opencode-store-audit.md`. Facts only. No fixes applied.

All paths verified by reading files on disk. Source locations:

- `web/node_modules/react-dom` → `web/node_modules/react-dom/cjs/react-dom-client.development.js`
- `@assistant-ui/core@0.3.19` → `node_modules/.bun/@assistant-ui+core@0.3.19+d90997b5cb7f8afc/node_modules/@assistant-ui/core/dist/...`
- `@assistant-ui/react@0.15.20` → `web/node_modules/@assistant-ui/react/dist/...` (symlink into `.bun`)

---

## 1. Full code of `createV2RuntimeStore`

`web/src/features/opencode/v2RuntimeStore.ts:41-83`

```ts
function executionIsRunning(state: V2ThreadState): boolean {
  return state.execution.type === "submitting" || state.execution.type === "admitted" || state.execution.type === "reconciling" || state.execution.type === "executing" || state.execution.type === "streaming" || state.execution.type === "cancelling";
}

function permissionViews(state: V2ThreadState): readonly V2PermissionView[] {
  return state.permissions
    .map(projectV2Permission)
    .filter((permission): permission is V2PermissionView => permission !== null);
}

function toMessageNotSentError(error: unknown): MessageNotSentError {
  if (error instanceof MessageNotSentError) return error;
  const message = error instanceof Error ? error.message : "OpenCode V2 prompt could not be sent";
  return new MessageNotSentError(message);
}

/** Builds the external-store adapter for one native controller snapshot. */
export function createV2RuntimeStore(
  controller: V2ThreadController,
  state: V2ThreadState,
  conversationId: string | null,
): ExternalStoreAdapter<ThreadMessage> & { readonly extras: V2RuntimeExtras } {
  const repositoryItems = projectV2RepositoryItems(state);
  const messageRepository = ExportedMessageRepository.fromBranchableArray(repositoryItems, {
    headId: repositoryHeadId(repositoryItems),
  });
  const permissions = permissionViews(state);
  const extras = createV2RuntimeExtras(controller, state, permissions);
  const adapter: ExternalStoreAdapter<ThreadMessage> & { readonly extras: V2RuntimeExtras } = {
    messageRepository,
    isLoading: state.load.type !== "ready",
    isRunning: executionIsRunning(state),
    isSendDisabled: state.revertRecovery.type !== "none",
    extras,
    adapters: { threadList: createV2ThreadListAdapter(state, conversationId) },
    setMessages: (messages) => {
      controller.reconcileRuntimeMessageIds(messages.map((message) => message.id));
    },
    onNew: async (message: AppendMessage) => {
      try {
        await controller.sendMessage(message);
      } catch (error) {
        throw toMessageNotSentError(error);
      }
    },
    onCancel: () => controller.cancel(),
    onReload: async (parentId: string | null) => {
      await controller.regenerate(parentId);
    },
    onRefetchThread: () => controller.refresh(),
    onRespondToToolApproval: async (options) => {
      const request = state.permissions.find((candidate) => candidate.id === options.approvalId);
      const permission = request === undefined ? null : projectV2Permission(request);
      if (permission === null) throw new Error("OpenCode V2 permission is unavailable");
      await controller.replyToPermission(permission.id, toV2PermissionReply(permission, options));
    },
  };
  return adapter;
}
```

---

## 2. Full code of `projectV2RepositoryItems`

`web/src/features/opencode/v2MessageProjection.ts:315-333`

```ts
/** Projects the current state into branchable assistant-ui repository items. */
export function projectV2RepositoryItems(
  state: V2ThreadState,
): readonly V2BranchableMessageItem[] {
  const permissions: readonly V2PermissionView[] = state.permissions
    .map(projectV2Permission)
    .filter((permission): permission is V2PermissionView => permission !== null);
  const result: V2BranchableMessageItem[] = [];
  let parentId: string | null = null;
  for (const id of state.messageOrder) {
    const message = state.messages[id];
    if (message === undefined) continue;
    const projected = messageToAssistant(message, permissions);
    if (projected === null) continue;
    result.push({ message: projected, parentId });
    parentId = message.id;
  }
  return result;
}
```

Companion `repositoryHeadId`, same file, lines 335-340:

```ts
/** Returns the explicit assistant-ui repository head id. */
export function repositoryHeadId(
  items: readonly V2BranchableMessageItem[],
): string | null {
  return items.at(-1)?.message.id ?? null;
}
```

---

## 3. What is `messageRepository` exactly?

Type: **`ExportedMessageRepository`** — a plain (non-class) data type. Declared in
`@assistant-ui/core/dist/runtime/utils/message-repository.d.ts:9-16`:

```ts
type ExportedMessageRepositoryItem = {
  message: ThreadMessage;
  parentId: string | null;
  runConfig?: RunConfig;
};
type ExportedMessageRepository = {
  headId?: string | null;
  messages: Array<{
    message: ThreadMessage;
    parentId: string | null;
    runConfig?: RunConfig;
  }>;
};
```

The `const` carrying its two constructors, lines 17-25:

```ts
declare const ExportedMessageRepository: {
  fromArray: (messages: readonly ThreadMessageLike[]) => ExportedMessageRepository;
  fromBranchableArray: (items: readonly {
    message: ThreadMessageLike;
    parentId: string | null;
  }[], options?: {
    headId?: string | null;
  }) => ExportedMessageRepository;
};
```

Implementation, `message-repository.js:13-24` — builds a brand-new object literal and a
brand-new `messages` array on every call:

```js
fromBranchableArray: (items, options) => {
  return {
    ...options?.headId !== void 0 ? { headId: options.headId } : void 0,
    messages: items.map(({ message, parentId }) => {
      if (!message.id) throw new Error("ExportedMessageRepository.fromBranchableArray: Each message must have an 'id' field set.");
      return {
        parentId,
        message: fromThreadMessageLike(message, message.id, getRepositoryContentAutoStatus(message.content))
      };
    })
  };
}
```

There is a separate class, `MessageRepository` (same file, line 26), but it is **not** what
is passed here — it is the runtime's internal branch store, reachable only via the separate
`unstable_messageRepositoryInstance` adapter field.

---

## 4. assistant-ui `useExternalStoreRuntime` contract

Re-export shim in `@assistant-ui/react/dist/legacy-runtime/runtime-cores/external-store/useExternalStoreRuntime.js`:

```js
import { useExternalStoreRuntime } from "@assistant-ui/core/react";
export { useExternalStoreRuntime };
```

Signature (`@assistant-ui/core/dist/react/runtimes/useExternalStoreRuntime.d.ts`), per the
source map's `sourcesContent`:

```ts
export const useExternalStoreRuntime = <T>(
  store: ExternalStoreAdapter<T>,
): AssistantRuntime => {
```

`ExternalStoreAdapter` is `external-store-adapter.d.ts:211`:

```ts
type ExternalStoreAdapter<T = ThreadMessage> = ExternalStoreAdapterBase<T> & (T extends ThreadMessage ? object : ExternalStoreMessageConverterAdapter<T>);
```

Body (from source map `sourcesContent`), the part that matters for churn:

```ts
const adaptedStore = useMemo(() => {
  if (!feedback || store.adapters?.feedback) return store;
  return { ...store, adapters: { ...store.adapters, feedback } };
}, [feedback, store]);
const [runtime] = useState(() => new ExternalStoreRuntimeCore(adaptedStore));

useEffect(() => {
  runtime.setAdapter(adaptedStore);
});   // <-- no dependency array: runs after every render
```

### Memoization helper: **No**

Nothing exported from `@assistant-ui/core` (checked the full `index.d.ts` export list)
provides an adapter-memoizing hook — no `memo*`, `stableAdapter`, or `useStable*`. The
`useMemo` shown above is internal to the hook and keyed on the adapter identity passed in,
so it cannot help unless a referentially stable adapter is supplied.

---

## 5. The identity check in assistant-ui

### The line numbers in the audit premise are wrong

The check is **not** at `external-store-thread-runtime-core.js:191-196`. Lines 191-196 are
the *expensive* branch the check exists to avoid. The actual checks:

`external-store-thread-runtime-core.js:131-134`

```js
__internal_setAdapter(store) {
    if (this._store === store) return;
    this._updateStoreSnapshot(store);
}
```

`external-store-thread-runtime-core.js:179-197`

```js
let messages;
if (store.messageRepository) {
    if (oldStore && !repositoryChanged && oldStore.isRunning === store.isRunning && oldStore.messageRepository === store.messageRepository && previousIsRunning === isRunning) {
        this._notifySubscribers();
        return;
    }
    const incoming = store.messageRepository.messages;
    const headId = store.messageRepository.headId ?? incoming.at(-1)?.message.id ?? null;
    if (oldStore && !repositoryChanged && oldStore.messageRepository === store.messageRepository) {
        this.repository.resetHead(headId);
        messages = this.repository.getMessages();
    } else {
        const incomingIds = new Set(incoming.map(({ message }) => message.id));
        for (const { message, parentId } of incoming) this.repository.addOrUpdateMessage(parentId, message);
        for (const { message } of this.repository.export().messages) if (!incomingIds.has(message.id)) this.repository.deleteMessage(message.id);
        this._pendingDeleteEvictions.clear();
        this.repository.resetHead(headId);
        messages = this.repository.getMessages();
    }
}
```

### What is compared

- **Outer check (line 132):** `store` is the whole `ExternalStoreAdapter` object; the `===`
  is `this._store === store`.
- **Inner checks (lines 181, 187):** the compared field is
  **`oldStore.messageRepository === store.messageRepository`** — reference identity of the
  `ExportedMessageRepository` value.

### Consequence

`createV2RuntimeStore` builds a fresh repository object on every call (§3), so both checks
are false on every event, and every event executes the `else` branch at 191-196: a `Set` over
all incoming messages, `addOrUpdateMessage` per message, a full `export()` walk, and a
`deleteMessage` sweep.

---

## 6. What parts of `V2ThreadState` does `createV2RuntimeStore` actually use?

### Fields read by `createV2RuntimeStore` itself

| Field | Where |
|---|---|
| `load` | `state.load.type !== "ready"` (isLoading) |
| `execution` | via `executionIsRunning(state)` → `.type` |
| `revertRecovery` | `state.revertRecovery.type !== "none"` |
| `permissions` | `permissionViews()`; also `state.permissions.find(...)` in `onRespondToToolApproval` |
| `sessionId` | `createV2ThreadListAdapter` |
| `messageOrder` | `projectV2RepositoryItems` loop |
| `messages` | `state.messages[id]` in the same loop |

### Fields read by the functions it calls

| Field | Reached via |
|---|---|
| `session` | `createV2RuntimeExtras` (`state.session`) |
| `model`, `agent`, `desiredModel`, `desiredAgent` | `createV2RuntimeExtras` |
| `forms` | `createV2RuntimeExtras` (`state.forms`) |
| entire `state` object | `createV2RuntimeExtras` (`state: state`, passed through as `extras.state`) |
| `controller.getState().sessionId` | `createV2RuntimeExtras`, read off the controller, not the passed `state` |

### Not read

`connection`, `compaction`, `eventIdentity`, `selectionGeneration`, `inboxById`, `usage`,
`occupancyTokens`, `occupancyStale`, `optimisticMessageIds`, `answeredPermissionIds`,
`diagnosticCount`.

---

## Two findings that bear on `docs/task-opencode-frontend-event-batching.md`

### 6a. The `extras.state` pass-through defeats adapter-level memoization on its own

`createV2RuntimeExtras` stores the whole `state` object as `extras.state`
(`web/src/features/opencode/v2RuntimeExtras.ts:50`). Every event produces a new
`V2ThreadState`, so `extras` is a new object every time, and `extras` feeds
`this.extras = store.extras` (`external-store-thread-runtime-core.js:159`) — a separate
invalidation path from the repository one.

Any fix must stabilize **both**, or stabilizing the repository alone buys less than it
appears to. Fields such as `diagnosticCount`, `occupancyTokens`, `usage`, and `compaction`
are not needed for message rendering, so an `extras` that did not carry the whole state
would be materially cheaper.

### 6b. The churn has two independent sources, and the task doc addresses neither

Repository identity (§5) and `extras` identity (§6a) are separate comparisons in
`_updateStoreSnapshot` — lines 181/187 versus line 159. Batching events in `consumeEvents`
reduces how *often* both fire; it does not make either check pass.

Two independently verified problems in the task doc's proposed approach:

1. **The prescribed `Promise.race` drain loses events.** The suggested
   `Promise.race([iterator.next(), Promise.resolve(SENTINEL)])` cannot peek a
   single-consumer async iterator without losing the event: when nothing is buffered the
   sentinel wins and the real `next()` promise is abandoned, but that promise still owns the
   next event to arrive. Verified empirically — see
   `web/src/features/opencode/__probe_drain.test.ts`. The existing test double
   (`createEvents` in `v2ThreadController.test.ts`) masks this because it keeps a `queued[]`
   array; the production `V2EventReader` (`v2Client.ts:199`) delegates straight to
   `iterator.next()` on the SSE stream with no such fallback.

2. **`startTransition` cannot affect these updates.** The subscription path is
   `useSyncExternalStore`. React's `forceStoreRerender`
   (`react-dom-client.development.js:8260-8263`) calls `scheduleUpdateOnFiber(root, fiber, 2)`
   with a hardcoded lane, so the transition context is bypassed regardless of any
   `startTransition` wrapper. Additionally `applyEvent` is not React state at all — it mutates
   a module-closure variable and calls listeners — so React 19 automatic batching does not
   apply to it either.

`useDeferredValue(state)` in `v2Runtime.tsx` would work mechanically (it changes what
`useMemo` sees), but it defers the **entire** state object — including permissions, forms,
and compaction — which contradicts acceptance criterion 4 of the task doc ("permissions,
forms, and compaction events must still apply immediately"). The task doc's "Important Note"
section is incorrect on this point: `applyAdmissionEvent` and `applyCompactionLifecycleEvent`
both call `dispatch`, which mutates the same `state` object `useDeferredValue` wraps. That
note holds only for `applyAutoApproveEvent`'s network call, which genuinely does not touch
React state.

---

## Provenance

- No source file was modified while producing this audit.
- `web/src/features/opencode/__probe_drain.test.ts` is a temporary probe added to
  empirically verify finding 1 above. It is not part of the suite and is pending deletion.