import { beforeAll, describe, expect, it } from "bun:test";
import { REPO_ROOT } from "../../helpers/repo-root";
import path from "node:path";

describe("OpenCode session import frontend integration guards", () => {
  let dialogSource = "";
  let sidebarSource = "";
  let apiSource = "";

  beforeAll(async () => {
    dialogSource = await Bun.file(
      path.join(REPO_ROOT, "web/src/features/opencode/OpenCodeImportDialog.tsx"),
    ).text();
    sidebarSource = await Bun.file(path.join(REPO_ROOT, "web/src/components/Sidebar.tsx")).text();
    apiSource = await Bun.file(
      path.join(REPO_ROOT, "web/src/features/opencode/opencodeImportApi.ts"),
    ).text();
  });

  describe("OpenCodeImportDialog component", () => {
    it("renders dialog primitives with title and informative description", () => {
      expect(dialogSource).toContain("<Dialog");
      expect(dialogSource).toContain("Import from OpenCode");
      expect(dialogSource).toContain("Attach to an existing OpenCode session");
    });

    it("supports search/filter bar over session title and directory", () => {
      expect(dialogSource).toContain("searchFilter");
      expect(dialogSource).toContain("Filter by title, directory, or session ID...");
    });

    it("displays session title, directory, and formatted relative activity time", () => {
      expect(dialogSource).toContain("displayTitle");
      expect(dialogSource).toContain("s.directory");
      expect(dialogSource).toContain("formatRelativeTime(s.lastActivityAt)");
    });

    it("handles loading, empty, and error states", () => {
      expect(dialogSource).toContain("Scanning available OpenCode sessions...");
      expect(dialogSource).toContain("No importable OpenCode sessions found");
      expect(dialogSource).toContain("Retry");
    });

    it("supports cursor-based pagination and load more sessions button", () => {
      expect(dialogSource).toContain("loadMoreSessions");
      expect(dialogSource).toContain("nextCursor");
      expect(dialogSource).toContain("Load more sessions");
    });

    it("displays rich session metadata: project, branch, prompt preview, root/subagent badges", () => {
      expect(dialogSource).toContain("s.projectName");
      expect(dialogSource).toContain("s.gitBranch");
      expect(dialogSource).toContain("firstPromptPreview");
      expect(dialogSource).toContain("Subagent");
      expect(dialogSource).toContain("Root");
      expect(dialogSource).toContain("shortSessionId");
      expect(dialogSource).toContain("truncateMiddle");
    });

    it("handles successful 201 import by opening agent tab and navigating to code surface", () => {
      expect(dialogSource).toContain(
        "useChatTabsStore.getState().openAgent(result.conversationId)",
      );
      expect(dialogSource).toContain("navigate(ROUTES.code(result.conversationId))");
    });

    it("handles 409 duplicate import by offering navigation to the existing conversation", () => {
      expect(dialogSource).toContain('errorKind === "already_imported"');
      expect(dialogSource).toContain("openExistingConversation(duplicateConflict.conversationId)");
      expect(dialogSource).toContain("Open Conversation");
    });

    it("handles 409 stale target/source by explaining connection change with refresh option", () => {
      expect(dialogSource).toContain('errorKind === "stale_source"');
      expect(dialogSource).toContain("Refresh");
    });

    it("handles 404 missing session by refreshing the list", () => {
      expect(dialogSource).toContain('errorKind === "session_not_found"');
    });
  });

  describe("Sidebar integration", () => {
    it("renders the OpenCodeImportDialog component", () => {
      expect(sidebarSource).toContain("<OpenCodeImportDialog");
      expect(sidebarSource).toContain("importOpenCodeOpen");
    });

    it("provides 'Import from OpenCode' button in the fixed actions bar", () => {
      expect(sidebarSource).toContain("Import from OpenCode");
      expect(sidebarSource).toContain("setImportOpenCodeOpen(true)");
    });

    it("provides 'Import from OpenCode' option in the Chats section menu", () => {
      expect(sidebarSource).toContain(
        "<DropdownMenuItem onSelect={() => setImportOpenCodeOpen(true)}",
      );
    });
  });

  describe("Frontend import API boundary", () => {
    it("sends only sessionId and sourceRef in import request body", () => {
      expect(apiSource).toContain("body: JSON.stringify({ sessionId, sourceRef })");
      // Never sends client-chosen directory or owner
      expect(apiSource).not.toContain("opencodeDirectory: ");
      expect(apiSource).not.toContain("opencodeServiceOwner: ");
    });

    it("does not import @opencode/client into frontend import api", () => {
      expect(apiSource).not.toContain("@opencode/client");
    });
  });
});
