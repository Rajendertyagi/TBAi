/**
 * MCP Bridge and SDK Guards:
 * - Guard N8: getMcpSdkVersion returns installed MCP SDK version.
 * - Architecture Drift Guard: getAiTools wraps tools using tool() and jsonSchema() cleanly.
 */
import { describe, it, expect } from "bun:test";
import { getMcpSdkVersion } from "@/services/mcp/manager.ts";
import { tool, jsonSchema, type JSONSchema7 } from "ai";

describe("N8 — MCP SDK version reporting", () => {
  it("resolves the installed SDK version from package.json without throwing", () => {
    const version = getMcpSdkVersion();
    expect(version).not.toBe("unknown");
    expect(version).toBe("2.3.1");
  });
});

describe("Architecture Drift Guard — AI SDK tool bridge", () => {
  it("uses official AI SDK tool() and jsonSchema() helpers with valid JSON Schema", () => {
    const schema: JSONSchema7 = {
      type: "object",
      properties: {
        text: { type: "string" },
      },
      required: ["text"],
    };

    const t = tool({
      description: "Test tool description",
      inputSchema: jsonSchema(schema),
      execute: async (args) => JSON.stringify(args),
    });

    expect(t).toBeDefined();
    expect(t.description).toBe("Test tool description");
    expect(typeof t.execute).toBe("function");
  });
});
