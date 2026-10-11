import { describe, it, expect, beforeAll } from "bun:test";
import { REPO_ROOT } from "../../helpers/repo-root";
import path from "node:path";

describe("CodeShell architecture guard", () => {
  let source = "";

  beforeAll(async () => {
    source = await Bun.file(
      path.join(REPO_ROOT, "web/src/features/opencode/CodeShell.tsx"),
    ).text();
  });

  it("renders via unified AppShell", () => {
    expect(source).toContain('import { AppShell } from "@/app/layout/AppShell";');
    expect(source).toContain("<AppShell>");
  });

  it("does not instantiate a duplicate chat runtime or AssistantRuntimeProvider", () => {
    expect(source).not.toContain("useAppChatRuntime");
    expect(source).not.toContain("AssistantRuntimeProvider");
  });
});
