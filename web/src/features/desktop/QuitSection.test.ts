import { describe, it, expect } from "bun:test";
import { stripComments } from "@/testing/source-scope";

/**
 * Wiring guards for the Settings Quit path (additional proof only).
 *
 * Clicking through the confirm dialog needs a DOM runner, which `web/`
 * doesn't have — so these assert the wiring that makes it work: the Tauri
 * gate, the exact command name, the confirm dialog structure, and the mount
 * point. Comments are stripped first so prose can never satisfy a test.
 */
async function sourceOf(relativeFile: string): Promise<string> {
  return stripComments(
    await Bun.file(new URL(relativeFile, import.meta.url)).text(),
  );
}

describe("QuitSection wiring", () => {
  it("only renders inside the Tauri shell", async () => {
    const source = await sourceOf("./QuitSection.tsx");
    expect(source).toContain("isTauri()");
    expect(source).toContain("if (!isTauri()) return null;");
  });

  it("invokes the backend quit_app command on confirm", async () => {
    const source = await sourceOf("./QuitSection.tsx");
    expect(source).toContain('invoke("quit_app")');
    expect(source).toContain("AlertDialogAction");
    expect(source).toContain("AlertDialogCancel");
  });

  it("mounts on the Desktop settings page", async () => {
    const source = await sourceOf("./DesktopSettings.tsx");
    expect(source).toContain("<QuitSection />");
  });
});
