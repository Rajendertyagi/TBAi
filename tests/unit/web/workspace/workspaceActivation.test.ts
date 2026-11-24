/**
 * Workspace activation contract (plan §3a / §3c).
 *
 * Pins the "has this panel's runtime been started" lifecycle, kept distinct
 * from Direct history recovery: start-once per canonical tab key, no-op on
 * repeated activation, cleared on genuine disposal, and never for the draft.
 */
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import path from "node:path";
import { REPO_ROOT } from "../../../helpers/repo-root";
import {
  activateWorkspacePanel,
  disposeWorkspacePanel,
  disposeWorkspacePanelById,
  getWorkspaceActivationGeneration,
  isWorkspacePanelStarted,
  registerPanelCanonicalKey,
  resetWorkspaceActivationForTests,
  subscribeWorkspaceActivation,
} from "@web/features/workspace/state/workspaceActivation";

beforeAll(() => {
  resetWorkspaceActivationForTests();
});

afterEach(() => {
  resetWorkspaceActivationForTests();
});

describe("workspace activation — start-once lifecycle", () => {
  it("first activation marks the panel started; repeated activation is a no-op", () => {
    expect(isWorkspacePanelStarted("chat:a")).toBe(false);
    expect(getWorkspaceActivationGeneration("chat:a")).toBe(0);

    activateWorkspacePanel("chat:a");
    expect(isWorkspacePanelStarted("chat:a")).toBe(true);
    expect(getWorkspaceActivationGeneration("chat:a")).toBe(1);

    activateWorkspacePanel("chat:a");
    activateWorkspacePanel("chat:a");
    expect(isWorkspacePanelStarted("chat:a")).toBe(true);
    expect(getWorkspaceActivationGeneration("chat:a")).toBe(1);
  });

  it("activates both chat: and agent: keys, but never the chat:new draft", () => {
    activateWorkspacePanel("chat:real");
    activateWorkspacePanel("agent:real");
    activateWorkspacePanel("chat:new");

    expect(isWorkspacePanelStarted("chat:real")).toBe(true);
    expect(isWorkspacePanelStarted("agent:real")).toBe(true);
    expect(isWorkspacePanelStarted("chat:new")).toBe(false);
    expect(getWorkspaceActivationGeneration("chat:new")).toBe(0);
  });

  it("ignores malformed keys", () => {
    activateWorkspacePanel("garbage");
    activateWorkspacePanel("");
    expect(isWorkspacePanelStarted("garbage")).toBe(false);
    expect(isWorkspacePanelStarted("")).toBe(false);
  });

  it("dispose clears started state; re-activation yields a new generation", () => {
    activateWorkspacePanel("agent:x");
    expect(getWorkspaceActivationGeneration("agent:x")).toBe(1);

    disposeWorkspacePanel("agent:x");
    expect(isWorkspacePanelStarted("agent:x")).toBe(false);
    // Generation is retained across dispose so the next activation is NEW.
    expect(getWorkspaceActivationGeneration("agent:x")).toBe(1);

    // Disposing an already-disposed panel is a no-op.
    disposeWorkspacePanel("agent:x");
    expect(getWorkspaceActivationGeneration("agent:x")).toBe(1);

    activateWorkspacePanel("agent:x");
    expect(isWorkspacePanelStarted("agent:x")).toBe(true);
    expect(getWorkspaceActivationGeneration("agent:x")).toBe(2);
  });

  it("keeps per-key state independent", () => {
    activateWorkspacePanel("chat:a");
    const aGeneration = getWorkspaceActivationGeneration("chat:a");

    activateWorkspacePanel("agent:b");
    expect(isWorkspacePanelStarted("chat:a")).toBe(true);
    expect(getWorkspaceActivationGeneration("chat:a")).toBe(aGeneration);
    expect(isWorkspacePanelStarted("agent:b")).toBe(true);

    disposeWorkspacePanel("agent:b");
    expect(isWorkspacePanelStarted("chat:a")).toBe(true);
    expect(getWorkspaceActivationGeneration("chat:a")).toBe(aGeneration);
    expect(isWorkspacePanelStarted("agent:b")).toBe(false);
  });

  it("notifies subscribers only on real transitions", () => {
    let notifications = 0;
    const unsubscribe = subscribeWorkspaceActivation(() => {
      notifications += 1;
    });

    activateWorkspacePanel("chat:a"); // started -> 1
    activateWorkspacePanel("chat:a"); // no-op
    disposeWorkspacePanel("chat:a"); // started -> 2
    disposeWorkspacePanel("chat:a"); // no-op
    expect(notifications).toBe(2);

    unsubscribe();
    activateWorkspacePanel("chat:b");
    expect(notifications).toBe(2);
  });
});

describe("workspace activation — materialized draft disposal (auditor regression)", () => {
  it("disposing the draft panel clears the materialized canonical key", () => {
    // First send: the panel id stays `chat:new` while activation is recorded
    // under the materialized canonical key `chat:<id>`.
    registerPanelCanonicalKey("chat:new", "chat:materialized-1");
    activateWorkspacePanel("chat:materialized-1");
    expect(isWorkspacePanelStarted("chat:materialized-1")).toBe(true);
    const firstGeneration = getWorkspaceActivationGeneration("chat:materialized-1");

    // Genuine removal of the draft panel (normal close OR canonical
    // reconciliation, which skips onPanelClose) unmounts it with panel id
    // `chat:new`. The resolver must clear `chat:<id>`, not the draft id.
    disposeWorkspacePanelById("chat:new");
    expect(isWorkspacePanelStarted("chat:materialized-1")).toBe(false);
    expect(isWorkspacePanelStarted("chat:new")).toBe(false);

    // Reopening starts dormant; re-activation yields a NEW generation.
    activateWorkspacePanel("chat:materialized-1");
    expect(isWorkspacePanelStarted("chat:materialized-1")).toBe(true);
    expect(getWorkspaceActivationGeneration("chat:materialized-1")).toBe(firstGeneration + 1);
  });

  it("survives alias clearing before a fresh-draft replacement", () => {
    // The fresh-draft path calls alias.clear() BEFORE replacePanel unmounts the
    // old panel. The mapping is independent of the alias, so disposal still
    // resolves the old materialized key.
    registerPanelCanonicalKey("chat:new", "chat:old-materialized");
    activateWorkspacePanel("chat:old-materialized");

    // Simulate alias.clear(): a later activation of the fresh draft must not
    // overwrite the mapping with the non-activatable `chat:new`.
    registerPanelCanonicalKey("chat:new", "chat:new");
    activateWorkspacePanel("chat:new");
    expect(isWorkspacePanelStarted("chat:new")).toBe(false);

    disposeWorkspacePanelById("chat:new");
    expect(isWorkspacePanelStarted("chat:old-materialized")).toBe(false);
  });

  it("falls back to the raw panel id for ordinary (non-aliased) panels", () => {
    activateWorkspacePanel("agent:plain");
    disposeWorkspacePanelById("agent:plain");
    expect(isWorkspacePanelStarted("agent:plain")).toBe(false);
  });

  it("consumes the mapping once so a later fresh draft cannot reuse it", () => {
    registerPanelCanonicalKey("chat:new", "chat:first");
    activateWorkspacePanel("chat:first");
    disposeWorkspacePanelById("chat:new");
    expect(isWorkspacePanelStarted("chat:first")).toBe(false);

    // A fresh draft panel with the same id disposes only the draft id (no-op).
    activateWorkspacePanel("chat:second");
    disposeWorkspacePanelById("chat:new");
    expect(isWorkspacePanelStarted("chat:second")).toBe(true);
  });
});

describe("workspace activation — wiring guards", () => {
  it("DockviewWorkspace activates both engines and the initially selected key", async () => {
    const source = await Bun.file(
      path.join(REPO_ROOT, "web/src/features/workspace/components/DockviewWorkspace.tsx"),
    ).text();
    expect(source).toContain("activateWorkspacePanel(canonicalKey)");
    expect(source).toContain("activateWorkspacePanel(activeTabKey)");
    // The panel-id -> canonical-key mapping is registered on both activation
    // paths so a materialized draft's disposal resolves `chat:<id>`.
    expect(source).toContain('registerPanelCanonicalKey(panelId ?? "", canonicalKey)');
    expect(source).toContain("registerPanelCanonicalKey(panelIdFor(activeTabKey), activeTabKey)");
    // Direct history recovery stays chat-only and untouched.
    expect(source).toContain('parsed?.kind === "chat" && parsed.ref !== NEW_DRAFT_TAB_ID');
    expect(source).toContain("activateHistoryConversation(parsed.ref)");
  });

  it("both runtime-bearing panels dispose by immutable panel id on unmount", async () => {
    for (const relative of [
      "web/src/features/workspace/components/OpenCodePanel.tsx",
      "web/src/features/workspace/components/DirectPanel.tsx",
    ]) {
      const source = await Bun.file(path.join(REPO_ROOT, relative)).text();
      expect(source).toContain("useDisposeWorkspacePanelOnUnmount(panelId)");
    }
  });
});
