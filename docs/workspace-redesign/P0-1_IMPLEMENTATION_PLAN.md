# P0-1 — Foundation Correctness and Documentation Honesty: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing Dockview workspace behave consistently at its identity edges and make the Workspace settings copy match what the backend actually guarantees — without adding any feature, dependency, or layout change.

**Architecture:** Three narrow frontend fixes: (1) make `parseTabKey` reject empty refs so every consumer agrees on what a canonical key is; (2) stop `registerPanelCanonicalKey` from recording an empty panel id, and guard the call site; (3) correct the Workspace settings copy to distinguish model-driven per-conversation scoping from the global-root manual tool surface. No backend contract changes. No new dependencies.

**Tech Stack:** React 19 + TypeScript, Bun test runner, `@web/*` path alias to `web/src/*`, existing Hono backend (unchanged).

**Spec:** `docs/workspace-redesign/WORKSPACE_PRODUCT_PLAN_AND_ROADMAP.md` §11 Phase P0-1, §3 mandatory rules, §10 stable architecture, §13 verification strategy.

## Global Constraints

- Dockview remains the sole layout engine. No second layout tree, splitter, or workspace DnD.
- Direct Chat and OpenCode remain separate runtimes; no merged runtime or universal chat manager.
- No new dependency. The assistant-ui dependency train is frozen.
- Layout state carries identity and geometry only — no message text, drafts, credentials, paths, or runtime instances.
- Every test file lives under `tests/` (`bun run test:locations` is a hard gate).
- No `any`, no `as unknown as`, no `@ts-ignore`, no weakened assertions (`bun run lint` uses `--error-on-warnings`).
- Source-text guards must assert an invariant, not formatting, and must be able to fail.
- Definition of done: `bun run typecheck` and `bun run build` exit 0 independently re-run; full `bun run verify` green; affected tests pass with real counts; UI copy reviewed; no commit/push before end-to-end verification.
- The pre-existing untracked `docs/workspace-redesign/prototype/screenshots/` directory must never be committed or removed.

## Review Focus

These are the inputs and failure modes the spec implies but no task's happy-path test fully exercises. Each is pinned to a task below.

1. A deep link with an empty ref (`/chat/`, `/code/`) must not open a phantom panel — pinned in Task 1 step 1.
2. A non-canonical key (`other:abc`) must be rejected by every consumer, not just `dockviewParams` — pinned in Task 1 step 1.
3. An empty Dockview panel id must never alias a real canonical key on disposal — pinned in Task 2 step 1.
4. The Workspace settings page must not claim all file tools are confined to one folder when the manual `/api/tools/*` surface uses the global root — pinned in Task 3 step 1.
5. Floating/popout groups must remain dropped on restore (the owner decision is on hold); the existing test must still pass after these changes — pinned in Task 3 step 5.

---

### Task 1: Reject empty refs in `parseTabKey`

**Files:**
- Modify: `web/src/features/chat/state/chatTabs.ts:104-108`
- Test: `tests/unit/web/chat/chatTabs-parse.test.ts` (new)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `parseTabKey(key: string): { kind: "chat" | "agent"; ref: string } | null` — now returns `null` for `chat:`, `agent:`, and non-canonical keys. Consumed by `dockviewParams.ts`, `dockviewController.ts`, `panelRegistry.ts`, `workspaceActivation.ts`, `useWorkspaceFocusSync.ts`, `AppShell.tsx`, `TabStrip.tsx`, and `chatTabs.ts` internals. All existing consumers already treat `null` as "ignore", and `panelRegistry.ts:55` already rejects empty refs independently, so no consumer change is required.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/web/chat/chatTabs-parse.test.ts`:

```ts
/**
 * Canonical tab-key validation at the chatTabs boundary.
 *
 * Every workspace consumer treats `parseTabKey(...) === null` as "ignore".
 * An empty ref must therefore be rejected here, not passed downstream where
 * it would silently open no panel or alias the wrong conversation.
 */
import { describe, it, expect } from "bun:test";
import {
  agentKey,
  chatKey,
  parseTabKey,
} from "@web/features/chat/state/chatTabs";

describe("parseTabKey — canonical key validation", () => {
  it("accepts a chat key with a non-empty ref", () => {
    expect(parseTabKey(chatKey("abc123"))).toEqual({ kind: "chat", ref: "abc123" });
  });

  it("accepts an agent key with a non-empty ref", () => {
    expect(parseTabKey(agentKey("abc123"))).toEqual({ kind: "agent", ref: "abc123" });
  });

  it("rejects an empty chat ref", () => {
    expect(parseTabKey("chat:")).toBeNull();
  });

  it("rejects an empty agent ref", () => {
    expect(parseTabKey("agent:")).toBeNull();
  });

  it("rejects a non-canonical key", () => {
    expect(parseTabKey("other:abc")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/web/chat/chatTabs-parse.test.ts`
Expected: 2 failures — `parseTabKey("chat:")` returns `{ kind: "chat", ref: "" }` and `parseTabKey("agent:")` returns `{ kind: "agent", ref: "" }` instead of `null`. The other 3 cases pass.

- [ ] **Step 3: Write the minimal implementation**

Replace `web/src/features/chat/state/chatTabs.ts:104-108` with:

```ts
export function parseTabKey(key: string): { kind: "chat" | "agent"; ref: string } | null {
  if (key.startsWith("chat:")) {
    const ref = key.slice(5);
    return ref.length > 0 ? { kind: "chat", ref } : null;
  }
  if (key.startsWith("agent:")) {
    const ref = key.slice(6);
    return ref.length > 0 ? { kind: "agent", ref } : null;
  }
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/unit/web/chat/chatTabs-parse.test.ts`
Expected: 5 pass / 0 fail.

- [ ] **Step 5: Run the affected existing suites**

Run: `bun test tests/unit/web/workspace/ tests/dom/workspace/`
Expected: no new failures. These suites exercise every `parseTabKey` consumer; a regression here means a consumer relied on an empty ref and must be fixed before continuing.

No commit here. Per `AGENTS.md`, no commit is made until end-to-end verification passes for the whole phase. Commit once, after all three tasks and the final gate — see "Final verification" below.

---

### Task 2: Stop empty panel ids from aliasing canonical keys

**Files:**
- Modify: `web/src/features/workspace/state/workspaceActivation.ts:96-100`
- Modify: `web/src/features/workspace/components/DockviewWorkspace.tsx:248`
- Test: `tests/unit/web/workspace/workspaceActivation.test.ts` (modify existing)
- Test: `tests/dom/workspace/workspace-activation.test.tsx` (modify existing — DOM regression)

**Interfaces:**
- Consumes: `parseTabKey` from Task 1 (unchanged signature; `isActivatableKey` already rejects malformed keys).
- Produces: `registerPanelCanonicalKey(panelId, canonicalKey)` now ignores `panelId === ""`. `disposeWorkspacePanelById("")` therefore resolves to `""` and cannot clear a real canonical key.

- [ ] **Step 1: Write the failing test**

Add this case inside the `describe("workspace activation — materialized draft disposal ...")` block in `tests/unit/web/workspace/workspaceActivation.test.ts`, after the existing `disposing the draft panel clears the materialized canonical key` case:

```ts
  it("ignores an empty panel id so it cannot alias a real canonical key", () => {
    activateWorkspacePanel("chat:materialized-empty");
    registerPanelCanonicalKey("", "chat:materialized-empty");
    disposeWorkspacePanelById("");
    // The real key survives: the empty id was never registered as an alias.
    expect(isWorkspacePanelStarted("chat:materialized-empty")).toBe(true);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/web/workspace/workspaceActivation.test.ts`
Expected: the new case fails — before the fix, `panelCanonicalKeys.set("", "chat:materialized-empty")` makes `disposeWorkspacePanelById("")` clear the real key, so `isWorkspacePanelStarted("chat:materialized-empty")` is `false`.

- [ ] **Step 3: Write the minimal implementation**

In `web/src/features/workspace/state/workspaceActivation.ts`, replace lines 96-100 with:

```ts
export function registerPanelCanonicalKey(panelId: string, canonicalKey: string): void {
  if (panelId.length === 0) return;
  if (panelId === canonicalKey) return;
  if (!isActivatableKey(canonicalKey)) return;
  panelCanonicalKeys.set(panelId, canonicalKey);
}
```

In `web/src/features/workspace/components/DockviewWorkspace.tsx`, replace line 248 with:

```ts
          if (panelId) registerPanelCanonicalKey(panelId, canonicalKey);
```

- [ ] **Step 4: Update the source-text guard**

In `tests/unit/web/workspace/workspaceActivation.test.ts:181`, replace:

```ts
    expect(source).toContain('registerPanelCanonicalKey(panelId ?? "", canonicalKey)');
```

with:

```ts
    expect(source).toContain("if (panelId) registerPanelCanonicalKey(panelId, canonicalKey)");
```

This asserts the invariant (the call site never passes an empty id) rather than the old sloppy fallback.

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test tests/unit/web/workspace/workspaceActivation.test.ts`
Expected: all cases pass, including the new empty-id case and the updated wiring guard.

- [ ] **Step 6: Add the DOM regression (required by the P0-1 roadmap)**

Add this case inside `describe("workspace activation disposal on genuine unmount")` in `tests/dom/workspace/workspace-activation.test.tsx`, after the materialized-draft case:

```tsx
  it("an empty panel id cannot dispose a real conversation's activation state", () => {
    // The real DockviewWorkspace passes its immutable panel id to the same
    // useDisposeWorkspacePanelOnUnmount hook this harness mounts. An empty id
    // must never resolve through the alias map to a real conversation.
    registerPanelCanonicalKey("", "chat:real-conversation");
    activateWorkspacePanel("chat:real-conversation");
    expect(isWorkspacePanelStarted("chat:real-conversation")).toBe(true);

    render("");   // mounts <Panel panelId="" /> with the real disposal hook
    unmount();    // cleanup calls disposeWorkspacePanelById("")

    expect(isWorkspacePanelStarted("chat:real-conversation")).toBe(true);
  });
```

This is a DOM test: it mounts a component with the real `useDisposeWorkspacePanelOnUnmount` hook and exercises the actual unmount cleanup path, not just the pure function. Before the fix it fails — the empty id is registered as an alias, so unmount clears `chat:real-conversation`. After the fix it passes.

- [ ] **Step 7: Run the DOM activation suite**

Run: `bun test tests/dom/workspace/workspace-activation.test.tsx`
Expected: all cases pass, including the new empty-panel-id DOM regression.

---

### Task 3: Correct the Workspace settings copy

**Files:**
- Modify: `web/src/features/workspace/WorkspacePage.tsx:50` and `:55`
- Test: `tests/unit/web/workspace/workspace-page-copy.test.ts` (new)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: no code interface; a documentation invariant in the rendered copy.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/web/workspace/workspace-page-copy.test.ts`:

```ts
/**
 * The Workspace settings copy must not overstate tool scoping.
 *
 * Model-driven file tools resolve inside the active conversation's workspace
 * root (routes/chat/assemble-run.ts:119-135). The manual /api/tools/* surface
 * uses the global WORKSPACE_DIR (routes/tools.ts:65-120), and runBash is not
 * sandboxed (services/tools.ts:5-13). The page must say so.
 */
import { describe, it, expect } from "bun:test";
import path from "node:path";
import { REPO_ROOT } from "../../../helpers/repo-root";

const PAGE = path.join(REPO_ROOT, "web/src/features/workspace/WorkspacePage.tsx");

describe("Workspace settings copy", () => {
  it("does not claim every file tool is confined to one folder", async () => {
    const source = await Bun.file(PAGE).text();
    expect(source).not.toContain("Every file tool is confined here");
  });

  it("distinguishes the global folder from per-conversation workspaces", async () => {
    const source = await Bun.file(PAGE).text();
    expect(source).toContain("manual /api/tools/* endpoints");
    expect(source).toContain("private chat folder");
    expect(source).toContain("registered project folder");
  });

  it("states that shell commands are not sandboxed", async () => {
    const source = await Bun.file(PAGE).text();
    expect(source).toContain("not sandboxed");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/web/workspace/workspace-page-copy.test.ts`
Expected: 3 failures — the current copy contains "Every file tool is confined here" and none of the three required phrases.

- [ ] **Step 3: Write the minimal implementation**

In `web/src/features/workspace/WorkspacePage.tsx`, replace line 50 with:

```tsx
      description="The default folder used by the manual /api/tools/* endpoints. Model-driven tools instead use a per-conversation workspace: a private chat folder, or the registered project folder when the conversation has one."
```

and line 55 with:

```tsx
        description="Model-driven file tools resolve inside the active conversation's workspace — its private chat folder or its registered project folder. Path traversal and symlink escapes are rejected before any IO. Shell commands are not sandboxed — the command body runs with the server's own privileges."
```

This states the distinction explicitly: the global Workspace folder belongs to the manual tool surface; model-driven tools are scoped per conversation.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/unit/web/workspace/workspace-page-copy.test.ts`
Expected: 3 pass / 0 fail.

- [ ] **Step 5: Confirm the floating-group behavior is still pinned**

Run: `bun test tests/unit/web/workspace/layout-persistence.test.ts`
Expected: all cases pass, including `intentionally drops floating/popout/edge groups in V1` at line 144. No production change is needed — the owner decision remains on hold and the existing test already documents it. If this case fails, stop: a prior change altered the on-hold behavior and must be reverted before continuing.

- [ ] **Step 6: Run the full gate**

Run: `bun run verify`
Expected: exit 0. Record the exact pass/skip/fail counts and exit code.

No commit here. Commit once, after all three tasks and the final gate — see "Final verification" below.

---

## Final verification (after all tasks)

Run independently, not from an agent summary:

```
bun run typecheck
bun run build
bun run verify
bun run test:e2e --project=chromium-headless dockview-workspace.spec.ts
```

Record exact exit codes and counts. Review the complete `git diff` like you have never seen it before. Confirm it contains only the files listed in Tasks 1–3. Confirm the screenshots directory is still untracked and untouched.

Only after every gate is green and the diff review is clean, request commit/push authorization from the owner. Do not commit or push before that authorization. When authorized, commit all changes together:

```bash
git add web/src/features/chat/state/chatTabs.ts \
  tests/unit/web/chat/chatTabs-parse.test.ts \
  web/src/features/workspace/state/workspaceActivation.ts \
  web/src/features/workspace/components/DockviewWorkspace.tsx \
  tests/unit/web/workspace/workspaceActivation.test.ts \
  tests/dom/workspace/workspace-activation.test.tsx \
  web/src/features/workspace/WorkspacePage.tsx \
  tests/unit/web/workspace/workspace-page-copy.test.ts
git commit -m "fix(workspace): close identity and copy gaps in P0-1

Reject empty tab-key refs at the canonical boundary; never alias an empty
Dockview panel id to a real conversation; correct Workspace settings copy to
distinguish the global manual tool folder from per-conversation workspaces."
```

## Definition of done

- `parseTabKey("chat:")` and `parseTabKey("agent:")` return `null`; all 5 new cases pass.
- No empty panel id is registered; the new unit case, the updated wiring guard, and the new DOM unmount regression all pass.
- Workspace settings copy no longer overstates scoping and states the shell caveat; all 3 copy cases pass.
- The existing floating-group drop test still passes; no behavior change was made to it.
- `bun run typecheck` and `bun run build` exit 0 independently re-run; `bun run verify` exit 0; Dockview E2E green.
- No new dependency, no backend change, no layout change. No commit or push before verification passes and the owner authorizes it; one commit covers all three tasks.
