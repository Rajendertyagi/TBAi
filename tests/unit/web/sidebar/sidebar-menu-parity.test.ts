import { describe, it, expect, beforeAll } from "bun:test";
import path from "node:path";
import { REPO_ROOT } from "../../../helpers/repo-root";
import { stripComments } from "@web/testing/source-scope";
import {
  buildFolderMenuEntries,
  buildThreadRowActions,
  type ThreadRowMenuInput,
} from "@web/features/sidebar/lib/menu-actions";

/**
 * The `⋯` button and the right-click must open ONE list.
 *
 * Both row types render their menu through a shared action builder, so the two
 * entry points cannot drift. These tests pin the list itself (labels, order,
 * grouping, feature switches) and the wiring that guarantees both surfaces use
 * it. The assertion is about the contract, not the formatter's line wrapping:
 * the wiring checks count renderer calls and forbid inline menu items.
 */
const ROW = "web/src/features/sidebar/components/SidebarThreadRow.tsx";
const FOLDER_HEADER = "web/src/features/sidebar/components/FolderHeader.tsx";

const noop = () => {};
const sources = new Map<string, string>();

function countOccurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

function threadActions(overrides: Partial<ThreadRowMenuInput> = {}) {
  return buildThreadRowActions({
    archived: false,
    renameEnabled: true,
    archiveEnabled: true,
    deleteEnabled: true,
    onOpen: noop,
    onRename: noop,
    onToggleArchive: noop,
    onCopyId: noop,
    onCopyUrl: noop,
    onDelete: noop,
    ...overrides,
  });
}

function folderEntries(canOpenInExplorer: boolean) {
  return buildFolderMenuEntries({
    color: "#3b82f6",
    canOpenInExplorer,
    onNewChat: noop,
    onRename: noop,
    onPickColor: noop,
    onManageLinks: noop,
    onOpenInExplorer: noop,
    onCopyPath: noop,
    onRemove: noop,
  });
}

beforeAll(async () => {
  for (const file of [ROW, FOLDER_HEADER]) {
    sources.set(file, await Bun.file(path.join(REPO_ROOT, file)).text());
  }
});

describe("chat row menu", () => {
  it("lists the mockup's actions in order, with delete alone in the last group", () => {
    const actions = threadActions();
    expect(actions.map((a) => a.label)).toEqual([
      "Open in new tab",
      "Rename…",
      "Copy chat ID",
      "Copy URL",
      "Archive",
      "Delete…",
    ]);
    expect(actions.map((a) => a.group)).toEqual([0, 0, 1, 1, 1, 2]);
    expect(actions.at(-1)?.destructive).toBe(true);
  });

  it("offers unarchive in the archive slot for an archived chat", () => {
    const actions = threadActions({ archived: true });
    expect(actions.map((a) => a.label)).toContain("Unarchive");
    expect(actions.map((a) => a.label)).not.toContain("Archive");
  });

  it("drops only the actions its feature switches disable", () => {
    const actions = threadActions({ renameEnabled: false, deleteEnabled: false });
    expect(actions.map((a) => a.label)).toEqual([
      "Open in new tab",
      "Copy chat ID",
      "Copy URL",
      "Archive",
    ]);
  });

  it("is the body of BOTH the ⋯ menu and the right-click menu", () => {
    const code = stripComments(sources.get(ROW) ?? "");
    // Two row variants (active, archived); each renders the list into a ⋯ menu
    // and a right-click menu.
    expect(countOccurrences(code, "renderMenuActions(")).toBe(4);
    // No hand-written item lists: every item comes from the shared builder.
    expect(code).not.toContain("<ContextMenuItem");
    expect(code).not.toContain("<DropdownMenuItem");
    expect(code).toContain('from "./menu-kit"');
  });
});

describe("folder row menu", () => {
  it("lists the in-app actions, then the outside ones, then removal", () => {
    const entries = folderEntries(true);
    expect(
      entries.map((entry) => (entry.kind === "action" ? entry.action.label : entry.label)),
    ).toEqual([
      "New chat in this folder",
      "Rename folder…",
      "Set color",
      "Manage links…",
      "Open folder in Explorer",
      "Copy folder path",
      "Remove from workspace",
    ]);
    expect(
      entries.map((entry) => (entry.kind === "action" ? entry.action.group : entry.group)),
    ).toEqual([0, 0, 0, 0, 1, 1, 2]);
  });

  it("omits the Explorer item where no desktop shell exists", () => {
    const labels = folderEntries(false).map((entry) =>
      entry.kind === "action" ? entry.action.label : entry.label,
    );
    expect(labels).not.toContain("Open folder in Explorer");
    expect(labels.at(-1)).toBe("Remove from workspace");
  });

  it("is the body of BOTH the ⋯ menu and the right-click menu", () => {
    const code = stripComments(sources.get(FOLDER_HEADER) ?? "");
    expect(countOccurrences(code, "renderFolderMenu(")).toBe(2);
    expect(code).not.toContain("<ContextMenuItem");
    expect(code).not.toContain("<DropdownMenuItem");
    // The old implementation forged a contextmenu event to reuse one menu.
    expect(code).not.toContain("new MouseEvent(");
  });
});
