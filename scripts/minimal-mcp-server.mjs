import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { McpServer } from "@modelcontextprotocol/server";

// Minimal standards-compliant MCP server for testing the TBAi MCP client.
// Exposes a few tools, a resource, and a prompt over STDIO. Run with:
//   bun run scripts/minimal-mcp-server.mjs
import { z } from "zod";

const server = new McpServer({ name: "minimal-test", version: "1.0.0" });

server.registerTool("echo", { description: "Echo the provided text back to the caller", inputSchema: z.object({ text: z.string() }) }, async ({ text }) => ({
      content: [{ type: "text", text: `Echo: ${text}` }],
    }));

server.registerTool("add", { description: "Add two numbers and return the sum", inputSchema: z.object({ a: z.number(), b: z.number() }) }, async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }));

server.registerTool("fail_on_purpose", { description: "Always returns an error result (for testing error handling)", inputSchema: z.object({ msg: z.string() }) }, async ({ msg }) => ({ content: [{ type: "text", text: `boom: ${msg}` }], isError: true }));

server.registerResource("greeting", "file:///greeting.txt", {}, async (uri) => ({
      contents: [{ uri: uri.href, text: "Hello from the minimal MCP test server" }],
    }));

server.registerPrompt("summarize", { description: "Produce a summarize instruction for the given text", argsSchema: z.object({ text: z.string() }) }, ({ text }) => ({
      messages: [{ role: "user", content: { type: "text", text: `Please summarize the following:\n${text}` } }],
    }));

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[minimal-mcp-server] ready");
