import { describe, it, expect, beforeAll } from "bun:test";

describe("CodeShell architecture guard", () => {
  let source = "";

  beforeAll(async () => {
    source = await Bun.file(
      new URL("./CodeShell.tsx", import.meta.url),
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
