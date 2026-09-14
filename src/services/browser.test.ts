import { describe, it, expect } from "bun:test";
import { todoSchema, browserReadSchema, browserActionSchemaFull } from "../lib/validation";
import { runBrowserRead, runBrowserAction, normalizeBrowserUrl } from "./browser";

describe("todo schema", () => {
  it("accepts a valid add", () => {
    expect(todoSchema.safeParse({ action: "add", text: "x" }).success).toBe(true);
  });
  it("rejects add without text", () => {
    expect(todoSchema.safeParse({ action: "add" }).success).toBe(false);
  });
  it("rejects toggle without id", () => {
    expect(todoSchema.safeParse({ action: "toggle" }).success).toBe(false);
  });
  it("accepts list with a filter", () => {
    expect(todoSchema.safeParse({ action: "list", filter: "active" }).success).toBe(true);
  });
  it("rejects an unknown action", () => {
    expect(todoSchema.safeParse({ action: "explode" }).success).toBe(false);
  });
});

describe("browser read schema", () => {
  it("requires a url for open", () => {
    expect(browserReadSchema.safeParse({ action: "open" }).success).toBe(false);
    expect(browserReadSchema.safeParse({ action: "open", url: "https://example.com" }).success).toBe(true);
  });
  it("requires a prompt for extract", () => {
    expect(browserReadSchema.safeParse({ action: "extract" }).success).toBe(false);
    expect(browserReadSchema.safeParse({ action: "extract", prompt: "summary" }).success).toBe(true);
  });
  it("allows snapshot/get/screenshot with no extra args", () => {
    expect(browserReadSchema.safeParse({ action: "snapshot" }).success).toBe(true);
    expect(browserReadSchema.safeParse({ action: "get" }).success).toBe(true);
    expect(browserReadSchema.safeParse({ action: "screenshot" }).success).toBe(true);
  });
});

describe("browser action schema", () => {
  it("requires a ref for click", () => {
    expect(browserActionSchemaFull.safeParse({ action: "click" }).success).toBe(false);
    expect(browserActionSchemaFull.safeParse({ action: "click", ref: "e1" }).success).toBe(true);
  });
  it("requires ref and text for fill", () => {
    expect(browserActionSchemaFull.safeParse({ action: "fill", ref: "e1" }).success).toBe(false);
    expect(
      browserActionSchemaFull.safeParse({ action: "fill", ref: "e1", text: "hi" }).success,
    ).toBe(true);
  });
  it("requires a key for press", () => {
    expect(browserActionSchemaFull.safeParse({ action: "press", key: "Enter" }).success).toBe(true);
  });
  it("requires a prompt for act", () => {
    expect(browserActionSchemaFull.safeParse({ action: "act", prompt: "do it" }).success).toBe(true);
  });
});

const agentBrowserInstalled = !!Bun.which("agent-browser");

describe("browser adapter binary handling", () => {
  // These assertions only hold when the binary is absent; skip them once
  // agent-browser is installed in the environment.
  it.skipIf(agentBrowserInstalled)("reports a missing binary for read operations", async () => {
    const r = await runBrowserRead({ action: "snapshot" });
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("agent-browser");
  });
  it.skipIf(agentBrowserInstalled)("reports a missing binary for action operations", async () => {
    const r = await runBrowserAction({ action: "click", ref: "e1" });
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("agent-browser");
  });
});

describe("normalizeBrowserUrl (open command only)", () => {
  it("prepends http:// to a bare host:port", () => {
    expect(normalizeBrowserUrl("localhost:3000")).toBe("http://localhost:3000");
  });
  it("prepends http:// to a bare IP:port", () => {
    expect(normalizeBrowserUrl("127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
  });
  it("prepends http:// to a bare domain", () => {
    expect(normalizeBrowserUrl("example.com")).toBe("http://example.com");
  });
  it("leaves an http:// URL unchanged", () => {
    expect(normalizeBrowserUrl("http://example.com")).toBe("http://example.com");
  });
  it("leaves an https:// URL unchanged", () => {
    expect(normalizeBrowserUrl("https://example.com")).toBe("https://example.com");
  });
});
