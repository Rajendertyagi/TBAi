import { describe, it, expect, beforeAll } from "bun:test";
import { functionBody, stripComments } from "@/testing/source-scope";

/**
 * Guards the fix for the reason Code mode never showed a rich tool UI.
 *
 * `AuiConfig` is scoped to the provider it is passed to, and `OpenCodeView`
 * mounts its OWN `AssistantRuntimeProvider` (the OpenCode runtime, not the chat
 * one). The tool registry that `part.toolUI` reads lives in that scope, so
 * without a config here it is EMPTY and every Code tool part falls through to
 * the generic `ToolFallback` — which is exactly what the browser showed
 * (`Used tool: read`) even with the toolkit correctly populated and shipped.
 *
 * Verified in the browser after the fix: the same real part renders
 * `read · D:\Temp\ai-chat-app`.
 *
 * This is a source-level guard because the component cannot be rendered here:
 * `AgentRuntime` needs a live OpenCode runtime, and `web/` has no DOM harness.
 * Assertions are scoped to the component's own body with comments stripped, so
 * a match has to be real code — not an import line, and not a comment that
 * merely describes the wiring.
 */
let body = "";
let source = "";

beforeAll(async () => {
  source = await Bun.file(new URL("./OpenCodeView.tsx", import.meta.url)).text();
  body = functionBody(stripComments(source), "AgentRuntime");
});

describe("Code mode tool registry", () => {
  it("gives its runtime provider a config", () => {
    // Without `config` the tools scope is empty and every renderer is ignored.
    expect(body).toContain("config={config}");
  });

  it("registers the shared tool registry in that config", () => {
    // The SAME registry the chat view uses — one toolkit, not a second copy
    // that could drift.
    expect(body).toContain("Tools({ toolkit: appToolkit })");
  });

  it("builds the config through AuiConfig", () => {
    // The official constructor; a hand-rolled object would bypass the scopes
    // the resource needs to attach.
    expect(body).toContain("AuiConfig(");
  });

  it("takes appToolkit from the shared toolkit module", () => {
    // Scoped to the import statement itself, so a comment cannot satisfy it.
    expect(stripComments(source)).toMatch(
      /import\s*\{[^}]*\bappToolkit\b[^}]*\}\s*from\s*"@\/tools\/toolkit"/,
    );
  });
});
