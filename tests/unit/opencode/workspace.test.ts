import { describe, expect, it } from "bun:test";
import { resolveOpenCodeSessionDirectory } from "../../../src/services/opencode/workspace";
import { OpenCodeDirectoryUnavailableError } from "../../../src/services/opencode/errors";
import { conversationService } from "../../../src/services/storage/conversations";

describe("resolveOpenCodeSessionDirectory", () => {
  it("returns opencodeDirectory verbatim when present", async () => {
    const rawRemotePath = "/var/remote/workspace/my-app";
    const dir = await resolveOpenCodeSessionDirectory({
      id: "conv-1",
      opencodeDirectory: rawRemotePath,
      opencodeImported: true,
    });
    expect(dir).toBe(rawRemotePath);

    const windowsPath = "C:\\projects\\app";
    const dir2 = await resolveOpenCodeSessionDirectory({
      id: "conv-2",
      opencodeDirectory: windowsPath,
      opencodeImported: false,
    });
    expect(dir2).toBe(windowsPath);
  });

  it("throws OpenCodeDirectoryUnavailableError when imported session has no directory", async () => {
    await expect(
      resolveOpenCodeSessionDirectory({
        id: "conv-imported-no-dir",
        opencodeDirectory: null,
        opencodeImported: true,
      }),
    ).rejects.toThrow(OpenCodeDirectoryUnavailableError);

    await expect(
      resolveOpenCodeSessionDirectory({
        id: "conv-imported-empty-dir",
        opencodeDirectory: "   ",
        opencodeImported: true,
      }),
    ).rejects.toThrow(OpenCodeDirectoryUnavailableError);
  });

  it("falls back to resolveConversationWorkspace for native conversations without opencodeDirectory", async () => {
    // Create a real native conversation
    const conv = await conversationService.create({
      title: "Native Conversation",
      providerId: null,
      workspaceMode: "simple",
      engine: "opencode",
    });

    const dir = await resolveOpenCodeSessionDirectory(conv);
    expect(typeof dir).toBe("string");
    expect(dir.length).toBeGreaterThan(0);
    // Should be pointing to the conversation's scratch chat directory
    expect(dir).toContain(conv.id);
  });
});
