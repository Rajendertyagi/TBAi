/**
 * Structural contract for the production DockviewWorkspace React adapter.
 *
 * The controller is intentionally not mounted in AppShell until Phase E, so
 * this source-level guard gives the module a real inbound reference (the
 * no-orphan-modules gate) and pins the adapter boundary. Behavioral invariants
 * (move/close/restore/reconcile) are exercised in `dockview-controller.test.ts`.
 * Assertions match stable code tokens, never line wrapping.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import path from "node:path";
import { REPO_ROOT } from "../../../helpers/repo-root";
import { DockviewWorkspace } from "@web/features/workspace/components/DockviewWorkspace";

let source = "";

beforeAll(async () => {
  source = await Bun.file(
    path.join(REPO_ROOT, "web/src/features/workspace/components/DockviewWorkspace.tsx"),
  ).text();
});

describe("DockviewWorkspace adapter contract", () => {
  it("is a named export", () => {
    expect(typeof DockviewWorkspace).toBe("function");
  });

  it("hosts DockviewReact with the official theme and registered components", () => {
    expect(source).toContain("<DockviewReact");
    expect(source).toContain("theme={themeAbyss}");
    expect(source).toContain("components={COMPONENTS}");
    expect(source).toContain("dockview-react/dist/styles/dockview.css");
  });

  it("delegates the event state machine to DockviewController via a thin API adapter", () => {
    expect(source).toContain("toControllerApi(event.api)");
    expect(source).toContain("new DockviewController");
    expect(source).toContain("controller.start()");
    expect(source).toContain("controllerRef.current?.dispose()");
  });

  it("wires canonical-close and persistence defaults at the adapter boundary", () => {
    // M1: close is canonicalized before reaching chatTabs so an aliased draft
    // panel closes the materialized conversation, not just draft-local state.
    expect(source).toContain("const canonicalKey = canonicalKeyFor(panelId)");
    expect(source).toContain("useChatTabsStore.getState().close(canonicalKey)");
    expect(source).toContain("saveLayout(layout, storageKeyRef.current)");
    expect(source).toContain("loadLayout(storageKeyRef.current, openTabKeysRef.current)");
  });

  it("never subscribes to a non-existent DockviewApi visibility event", () => {
    expect(source).not.toContain("api.onDidVisibilityChange");
  });
});
