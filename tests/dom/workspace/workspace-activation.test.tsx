/**
 * Workspace activation — genuine panel disposal (plan §3c).
 *
 * The started state is cleared by a React effect cleanup on the panel
 * component's unmount, NOT by `onPanelClose` (which canonical reconciliation
 * deliberately skips). Hidden panels stay mounted and Dockview moves do not
 * unmount, so neither may clear the state. This exercises the shared hook both
 * runtime-bearing panels use.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  activateWorkspacePanel,
  disposeWorkspacePanel,
  getWorkspaceActivationGeneration,
  isWorkspacePanelStarted,
  registerPanelCanonicalKey,
  resetWorkspaceActivationForTests,
  useDisposeWorkspacePanelOnUnmount,
  useIsWorkspacePanelStarted,
} from "@web/features/workspace/state/workspaceActivation";

function Panel({ panelId }: { panelId: string }) {
  useDisposeWorkspacePanelOnUnmount(panelId);
  const started = useIsWorkspacePanelStarted(panelId);
  return <div data-testid="panel" data-started={String(started)} />;
}

let container: HTMLElement;
let root: Root | null = null;

beforeEach(() => {
  resetWorkspaceActivationForTests();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container.remove();
  resetWorkspaceActivationForTests();
});

function render(panelId: string): void {
  act(() => root?.render(<Panel panelId={panelId} />));
}

function unmount(): void {
  if (!root) return;
  const current = root;
  root = null;
  act(() => current.unmount());
}

function remount(): void {
  root = createRoot(container);
}

function startedAttr(): string | null {
  return container.querySelector('[data-testid="panel"]')?.getAttribute("data-started") ?? null;
}

describe("workspace activation disposal on genuine unmount", () => {
  it("clears started state when the panel unmounts", () => {
    activateWorkspacePanel("agent:conv-a");
    expect(isWorkspacePanelStarted("agent:conv-a")).toBe(true);

    render("agent:conv-a");
    expect(startedAttr()).toBe("true");

    unmount();
    expect(isWorkspacePanelStarted("agent:conv-a")).toBe(false);
  });

  it("does not clear started state on a re-render (hide/move keeps the panel mounted)", () => {
    activateWorkspacePanel("chat:conv-b");
    render("chat:conv-b");

    act(() => root?.render(<Panel panelId="chat:conv-b" />));
    expect(isWorkspacePanelStarted("chat:conv-b")).toBe(true);
    expect(startedAttr()).toBe("true");
  });

  it("disposes the previous key when the panel's panelId changes", () => {
    activateWorkspacePanel("chat:conv-c");
    activateWorkspacePanel("agent:conv-d");
    render("chat:conv-c");

    act(() => root?.render(<Panel panelId="agent:conv-d" />));
    expect(isWorkspacePanelStarted("chat:conv-c")).toBe(false);
    expect(isWorkspacePanelStarted("agent:conv-d")).toBe(true);
  });

  it("reopening after disposal starts dormant until re-activated", () => {
    activateWorkspacePanel("agent:conv-e");
    render("agent:conv-e");
    unmount();
    expect(isWorkspacePanelStarted("agent:conv-e")).toBe(false);

    // A fresh mount for the same key reads dormant state.
    remount();
    render("agent:conv-e");
    expect(startedAttr()).toBe("false");
    expect(isWorkspacePanelStarted("agent:conv-e")).toBe(false);

    act(() => activateWorkspacePanel("agent:conv-e"));
    expect(startedAttr()).toBe("true");
  });

  it("dispose is idempotent and safe for a never-activated key", () => {
    disposeWorkspacePanel("agent:never");
    expect(isWorkspacePanelStarted("agent:never")).toBe(false);
  });

  it("a materialized draft panel's unmount clears the canonical chat:<id> state", () => {
    // First send: activation is under the materialized key, but the panel's
    // immutable Dockview id stays `chat:new`.
    registerPanelCanonicalKey("chat:new", "chat:materialized-dom");
    activateWorkspacePanel("chat:materialized-dom");
    expect(isWorkspacePanelStarted("chat:materialized-dom")).toBe(true);
    const before = getWorkspaceActivationGeneration("chat:materialized-dom");

    // Genuine removal (normal close or canonical reconciliation) unmounts the
    // draft panel with id `chat:new`; the resolver must clear `chat:<id>`.
    render("chat:new");
    unmount();
    expect(isWorkspacePanelStarted("chat:materialized-dom")).toBe(false);
    expect(isWorkspacePanelStarted("chat:new")).toBe(false);

    // Reopening starts dormant; re-activation yields a NEW generation.
    activateWorkspacePanel("chat:materialized-dom");
    expect(isWorkspacePanelStarted("chat:materialized-dom")).toBe(true);
    expect(getWorkspaceActivationGeneration("chat:materialized-dom")).toBe(before + 1);
  });
});
