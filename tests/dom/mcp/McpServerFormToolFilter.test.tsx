/**
 * McpServerForm tool-filtering section (Phase 1 — the denylist UI).
 *
 * The per-tool toggle lives in `McpServerForm`, not in `McpPanel`: the panel
 * passes `tools={draft.id ? <discovered tools> : undefined}` into the form,
 * and the form renders the section only when `tools && tools.length > 0` —
 * so a new server (no discovered tools yet) and a server with zero tools
 * both get no section. Those "no section" cases are asserted at the form
 * level (tools prop absent/empty); the gating itself is McpPanel's.
 *
 * Behavior pinned here:
 *
 *   - section renders with one checkbox row per discovered tool, name and
 *     description shown, checked = exposed, unchecked = disabled;
 *   - all tools start checked when `draft.disabledTools` is empty;
 *   - checking a row REMOVES the tool from `draft.disabledTools` (re-exposes
 *     it); unchecking ADDS it;
 *   - the section's state lives in the draft, not in the form's internals —
 *     the harness observes it through the same `set` contract the panel uses.
 *
 * Not covered (deliberately): "save includes disabledTools in the payload" —
 * that is `McpPanel.buildPayload` logic and needs an McpPanel-level test with
 * a mocked store/fetch.
 */
import { describe, it, expect } from "bun:test";
import { act } from "react";
import { useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  McpServerForm,
  emptyDraft,
  type DraftState,
} from "@web/features/mcp/components/McpServerForm.tsx";
import type { McpTool } from "@web/types/index.ts";

/** Mirror of the fixture server's tool set (name + description copy). */
const TOOLS: McpTool[] = [
  { name: "echo", description: "Echoes the input text back." },
  { name: "fail", description: "Always returns a tool-level error." },
];

const SECTION_HEADER = "Tool filtering (denylist — unchecked tools are hidden from the AI)";

/** The form's tool section, or null when it is not rendered. */
function toolSection(container: HTMLElement): HTMLElement | null {
  const header = [...container.querySelectorAll("div")].find(
    (d) => d.textContent === SECTION_HEADER,
  );
  return header?.parentElement ?? null;
}

/** The checkbox of one tool row (matched by its monospace name span). */
function toolCheckbox(container: HTMLElement, toolName: string): HTMLInputElement {
  const section = toolSection(container);
  if (!section) throw new Error(`tool filtering section is not rendered`);
  const row = [...section.querySelectorAll("label")].find(
    (l) => l.querySelector(".font-mono")?.textContent === toolName,
  );
  if (!row) throw new Error(`no tool row for ${toolName}`);
  const input = row.querySelector("input[type=checkbox]");
  if (!input) throw new Error(`no checkbox in the ${toolName} row`);
  return input as HTMLInputElement;
}

/** `draft.disabledTools` as observed by the harness (empty list → empty string). */
function disabledToolsAttr(container: HTMLElement): string {
  return (
    container.querySelector('[data-testid="disabled-tools"]')?.getAttribute("data-value") ?? ""
  );
}

function mount(element: ReactElement): { root: Root; container: HTMLElement } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return { root, container };
}

/**
 * The form is fully controlled: the panel owns the draft, the form reports
 * patches through `set`. This harness is that panel — one useState, the same
 * contract, plus a data attribute exposing the current disabledTools.
 */
function Harness({
  draft: initialDraft,
  tools,
  isStdio = false,
}: {
  draft: DraftState;
  tools?: McpTool[];
  isStdio?: boolean;
}) {
  const [draft, setDraft] = useState(initialDraft);
  const set = (patch: Partial<DraftState>) => setDraft((d) => ({ ...d, ...patch }));
  return (
    <>
      <div data-testid="disabled-tools" data-value={(draft.disabledTools ?? []).join("|")} />
      <McpServerForm
        draft={draft}
        set={set}
        runTest={async () => {}}
        save={async () => {}}
        cancel={() => {}}
        formError={null}
        testResult={null}
        testing={false}
        saving={false}
        isStdio={isStdio}
        tools={tools}
      />
    </>
  );
}

const editingDraft = (overrides: Partial<DraftState> = {}): DraftState => ({
  ...emptyDraft(),
  id: "srv-1",
  name: "Fixture",
  ...overrides,
});

describe("McpServerForm — tool filtering section visibility", () => {
  it("appears when the form is editing a server with discovered tools", async () => {
    const { root, container } = mount(<Harness draft={editingDraft()} tools={TOOLS} />);
    expect(toolSection(container)).not.toBeNull();
    await act(async () => root.unmount());
  });

  it("does NOT appear when creating a new server (no tools prop — the panel only supplies tools when editing)", async () => {
    const { root, container } = mount(<Harness draft={emptyDraft()} tools={undefined} />);
    expect(toolSection(container)).toBeNull();
    await act(async () => root.unmount());
  });

  it("does NOT appear when the server has no discovered tools", async () => {
    const { root, container } = mount(<Harness draft={editingDraft()} tools={[]} />);
    expect(toolSection(container)).toBeNull();
    await act(async () => root.unmount());
  });
});

describe("McpServerForm — tool rows", () => {
  it("shows every tool's name and description, one checkbox row each", async () => {
    const { root, container } = mount(<Harness draft={editingDraft()} tools={TOOLS} />);
    const section = toolSection(container)!;
    expect(section.textContent).toContain("echo");
    expect(section.textContent).toContain("fail");
    expect(section.textContent).toContain("Echoes the input text back.");
    expect(section.textContent).toContain("Always returns a tool-level error.");
    expect(section.querySelectorAll("input[type=checkbox]").length).toBe(2);
    await act(async () => root.unmount());
  });

  it("renders all tools checked when nothing is disabled", async () => {
    const { root, container } = mount(
      <Harness draft={editingDraft({ disabledTools: [] })} tools={TOOLS} />,
    );
    expect(toolCheckbox(container, "echo").checked).toBe(true);
    expect(toolCheckbox(container, "fail").checked).toBe(true);
    await act(async () => root.unmount());
  });

  it("renders disabled tools unchecked and the rest checked", async () => {
    const { root, container } = mount(
      <Harness draft={editingDraft({ disabledTools: ["echo"] })} tools={TOOLS} />,
    );
    expect(toolCheckbox(container, "echo").checked).toBe(false);
    expect(toolCheckbox(container, "fail").checked).toBe(true);
    await act(async () => root.unmount());
  });
});

describe("McpServerForm — toggling the denylist", () => {
  it("checking an unchecked tool removes it from draft.disabledTools", async () => {
    const { root, container } = mount(
      <Harness draft={editingDraft({ disabledTools: ["echo", "fail"] })} tools={TOOLS} />,
    );
    expect(disabledToolsAttr(container)).toBe("echo|fail");
    act(() => {
      toolCheckbox(container, "echo").click();
    });
    expect(disabledToolsAttr(container)).toBe("fail");
    // The row re-renders as checked: the re-exposure is visible, not just
    // written to the draft.
    expect(toolCheckbox(container, "echo").checked).toBe(true);
    await act(async () => root.unmount());
  });

  it("unchecking a checked tool adds it to draft.disabledTools", async () => {
    const { root, container } = mount(
      <Harness draft={editingDraft({ disabledTools: [] })} tools={TOOLS} />,
    );
    expect(disabledToolsAttr(container)).toBe("");
    act(() => {
      toolCheckbox(container, "fail").click();
    });
    expect(disabledToolsAttr(container)).toBe("fail");
    expect(toolCheckbox(container, "fail").checked).toBe(false);
    expect(toolCheckbox(container, "echo").checked).toBe(true);
    await act(async () => root.unmount());
  });

  it("toggles are independent: two operations in one draft survive", async () => {
    const { root, container } = mount(
      <Harness draft={editingDraft({ disabledTools: ["echo"] })} tools={TOOLS} />,
    );
    // Re-expose "echo", then disable "fail": the list must end up
    // ["fail"], not "echo" re-added or lost.
    act(() => {
      toolCheckbox(container, "echo").click();
    });
    act(() => {
      toolCheckbox(container, "fail").click();
    });
    expect(disabledToolsAttr(container)).toBe("fail");
    await act(async () => root.unmount());
  });
});
