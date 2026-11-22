/**
 * Workspace panel arrangement (device-local UI state).
 *
 * The invariant these tests pin: a panel's identity (its `id`) is stable across
 * moves, so a runtime-bearing host keyed by that id is never reparented or
 * remounted when its visual position changes. Closing removes only the named
 * panel; opening is idempotent per tab key.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { useWorkspacePanels } from "@web/features/workspace/state/workspacePanels";

function reset(): void {
  useWorkspacePanels.setState({ panels: [] });
}

beforeEach(reset);

describe("workspace panels", () => {
  it("opens a panel for a tab key and dedupes repeats", () => {
    const s = useWorkspacePanels.getState();
    s.openPanel("chat:conv-A");
    s.openPanel("chat:conv-A");
    expect(useWorkspacePanels.getState().panels).toHaveLength(1);
    expect(useWorkspacePanels.getState().panels[0]?.tabKey).toBe("chat:conv-A");
  });

  it("keeps panel identity stable when moved", () => {
    const s = useWorkspacePanels.getState();
    s.openPanel("chat:conv-A");
    s.openPanel("chat:conv-B");
    const before = useWorkspacePanels.getState().panels;
    const [a, b] = before;
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    if (!a || !b) return;

    useWorkspacePanels.getState().movePanel(a.id, 1);
    const after = useWorkspacePanels.getState().panels;
    // Same ids, same objects' identity by id — only `order` changed.
    expect(after.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
    expect(after.find((p) => p.id === a.id)?.order).toBe(1);
    expect(after.find((p) => p.id === b.id)?.order).toBe(0);
  });

  it("ignores out-of-range moves", () => {
    useWorkspacePanels.getState().openPanel("chat:conv-A");
    const before = useWorkspacePanels.getState().panels[0];
    useWorkspacePanels.getState().movePanel(before?.id ?? "", 5);
    expect(useWorkspacePanels.getState().panels[0]).toEqual(before);
  });

  it("closing one panel leaves the other alive", () => {
    const s = useWorkspacePanels.getState();
    s.openPanel("chat:conv-A");
    s.openPanel("chat:conv-B");
    const [a, b] = useWorkspacePanels.getState().panels;
    if (!a || !b) throw new Error("expected two panels");

    useWorkspacePanels.getState().closePanel(a.id);
    const after = useWorkspacePanels.getState().panels;
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(b.id);
    expect(after[0]?.tabKey).toBe("chat:conv-B");
  });

  it("rejects draft and non-chat tab keys", () => {
    useWorkspacePanels.getState().openPanel("chat:new");
    useWorkspacePanels.getState().openPanel("agent:conv-X");
    useWorkspacePanels.getState().openPanel("garbage");
    expect(useWorkspacePanels.getState().panels).toEqual([]);
  });

  it("reopening a closed tab creates a fresh panel id", () => {
    useWorkspacePanels.getState().openPanel("chat:conv-A");
    const firstId = useWorkspacePanels.getState().panels[0]?.id;
    useWorkspacePanels.getState().closePanel(firstId ?? "");
    useWorkspacePanels.getState().openPanel("chat:conv-A");
    const reopenedId = useWorkspacePanels.getState().panels[0]?.id;
    expect(reopenedId).toBeDefined();
    expect(reopenedId).not.toBe(firstId);
  });
});
