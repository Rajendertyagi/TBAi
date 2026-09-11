import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const server = new McpServer({ name: "rich-e2e-echo", version: "1.0.0" });
server.registerTool("echo", { inputSchema: z.object({ text: z.string() }) }, async ({ text }) => ({
      content: [{ type: "text", text }],
    }));
await server.connect(new StdioServerTransport());
console.error("ECHO SERVER UP");
