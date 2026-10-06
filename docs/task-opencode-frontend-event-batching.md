# Task: Eliminate OpenCode UI Churn via Stable Repository & Adapter Memoization

## Background & Root Cause
From the deep audit of `@assistant-ui/core` (`external-store-thread-runtime-core.js`):
1. assistant-ui has a built-in shortcut:
   ```js
   if (oldStore && !repositoryChanged && oldStore.isRunning === store.isRunning && oldStore.messageRepository === store.messageRepository && previousIsRunning === isRunning) {
       this._notifySubscribers();
       return;
   }
   ```
2. When `messageRepository` is identical (`===`), assistant-ui skips the expensive O(N) `addOrUpdateMessage`, `export()`, and `deleteMessage` loops entirely.
3. Currently, `createV2RuntimeStore` (`web/src/features/opencode/v2RuntimeStore.ts`) constructs a brand new `ExportedMessageRepository` literal and new `extras` on every dispatch.
4. Because `messageRepository` identity changes on every event, assistant-ui runs the full O(N) rebuild on every single event/token delta, pinning CPU at 20-25%.

---

## Scope & Constraints
- **Frontend only:** `web/src/features/opencode/`
- **Zero data loss:** Do not alter the event iterator, `consumeEvents`, or stream reading.
- **Immediate execution:** No frame latency or deferral for permissions, forms, or tool approvals.
- **Clean tests:** Delete `web/src/features/opencode/__probe_drain.test.ts`. All existing tests must pass.

---

## Implementation Details

### 1. Memoize `messageRepository` in `v2RuntimeStore.ts`
The repository items only depend on:
- `state.messages`
- `state.messageOrder`
- `state.permissions`

Create a pure cache/memoization helper for the repository:
- Cache the previous `(messages, messageOrder, permissions)` references along with the computed `messageRepository`.
- If `state.messages === prevMessages && state.messageOrder === prevMessageOrder && state.permissions === prevPermissions`, **return the existing `messageRepository` reference**.
- When any of these 3 references change (e.g. streaming token delta updates `state.messages`, or new permission arrives), recompute and update the cache.

### 2. Stabilize `extras` in `v2RuntimeStore.ts`
Currently `createV2RuntimeExtras` attaches the entire `state` (`extras.state = state`).
- Stabilize the `extras` object reference when the inputs to `createV2RuntimeExtras` have not meaningfully changed, OR ensure shallow equality on `extras` fields so assistant-ui's `this.extras = store.extras` does not cause unnecessary churn.
- Ensure `permissions` passed to `createV2RuntimeExtras` uses the same memoized `permissionViews(state)` reference if `state.permissions === prevPermissions`.

### 3. Verify Adapter Identity Check
With `messageRepository` memoized:
- Events that DO NOT touch messages (e.g. background telemetry, diagnostic counts, status updates that do not alter messages) will now hit the fast path `oldStore.messageRepository === store.messageRepository`, skipping the entire O(N) message sync in assistant-ui.
- Events that DO alter messages (e.g. streaming deltas) update `state.messages` reference cleanly, producing the new repository and rendering smoothly.

### 4. Cleanup
- Remove the temporary probe file: `web/src/features/opencode/__probe_drain.test.ts`.

---

## Verification Steps
1. Run `bun run typecheck` across root and `web`.
2. Run focused tests: `bun test web/src/features/opencode`.
3. Verify that all permission, compaction, and message projection tests pass without regressions.
