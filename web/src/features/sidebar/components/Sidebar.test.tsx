import { describe, it, expect, beforeAll } from "bun:test";

describe("Sidebar architectural guard (Step 1B)", () => {
  let sidebarSource = "";
  let rowSource = "";
  let viewMenuSource = "";
  let folderRowSource = "";
  let syncSource = "";

  beforeAll(async () => {
    sidebarSource = await Bun.file(
      new URL("../../../components/Sidebar.tsx", import.meta.url),
    ).text();
    rowSource = await Bun.file(
      new URL("./SidebarThreadRow.tsx", import.meta.url),
    ).text();
    viewMenuSource = await Bun.file(
      new URL("./SidebarViewMenu.tsx", import.meta.url),
    ).text();
    folderRowSource = await Bun.file(
      new URL("./FolderConversationRow.tsx", import.meta.url),
    ).text();
    syncSource = await Bun.file(
      new URL("../hooks/useThreadListQuerySync.ts", import.meta.url),
    ).text();
  });

  it("Sidebar.tsx does not import or depend on assistant-ui", () => {
    expect(sidebarSource).not.toContain("@assistant-ui/react");
    expect(sidebarSource).not.toContain("useAuiState");
    expect(sidebarSource).not.toContain("useAui");
    expect(sidebarSource).not.toContain("ThreadListPrimitive");
  });

  it("SidebarThreadRow.tsx does not import or depend on assistant-ui", () => {
    expect(rowSource).not.toContain("@assistant-ui/react");
    expect(rowSource).not.toContain("useAuiState");
    expect(rowSource).not.toContain("useAui");
    expect(rowSource).not.toContain("ThreadListItemPrimitive");
  });

  it("SidebarViewMenu.tsx does not import or depend on assistant-ui", () => {
    expect(viewMenuSource).not.toContain("@assistant-ui/react");
    expect(viewMenuSource).not.toContain("useAui");
  });

  it("FolderConversationRow.tsx does not import or depend on assistant-ui", () => {
    expect(folderRowSource).not.toContain("@assistant-ui/react");
    expect(folderRowSource).not.toContain("useAuiState");
    expect(folderRowSource).not.toContain("useAui");
  });

  it("useThreadListQuerySync.ts does not import or depend on assistant-ui", () => {
    expect(syncSource).not.toContain("@assistant-ui/react");
    expect(syncSource).not.toContain("useAui");
    expect(syncSource).not.toContain("reloadThreadList");
  });

  it("Sidebar uses useConversationsList for thread state", () => {
    expect(sidebarSource).toContain("useConversationsList");
  });
});
