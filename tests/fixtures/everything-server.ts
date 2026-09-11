#!/usr/bin/env bun
/**
 * Fixture MCP server (TEST ONLY — never shipped).
 *
 * Generic capability server used by integration tests (adapted from the AIPM
 * reference everything-server, trimmed to what canonical TBAi exercises):
 * - tools: echo, fail (isError result), ask_user (elicitation form flow)
 * - resources: fixture://config static text
 * - prompts: greeting with one argument
 *
 * Usage:
 *   bun run tests/fixtures/everything-server.ts stdio
 *   bun run tests/fixtures/everything-server.ts http <port>
 */
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import {
  InMemoryTransport,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ServerContext } from "@modelcontextprotocol/server";

export function createFixtureServer(): McpServer {
  const server = new McpServer({ name: "fixture-everything", version: "1.0.0" });

  server.registerTool(
    "echo",
    {
      title: "Echo",
      description: "Echoes the input text back.",
      inputSchema: z.object({ text: z.string() }),
      outputSchema: z.object({ echoed: z.string() }),
    },
    async ({ text }) => ({
      content: [{ type: "text" as const, text }],
      structuredContent: { echoed: text },
    })
  );

  server.registerTool(
    "fail",
    { description: "Always returns a tool-level error." },
    async () => ({
      content: [{ type: "text" as const, text: "intentional failure" }],
      isError: true,
    })
  );

  // NOTE (v2 API): a tool WITHOUT inputSchema receives only (ctx) — the handler
  // would get the context as its first arg. All tools declare a schema so the
  // handler signature stays (args, ctx).
  server.registerTool(
    "ask_user",
    {
      description: "Asks the user a question via elicitation.",
      inputSchema: z.object({}),
    },
    async (_args: Record<string, unknown>, ctx: ServerContext) => {
      const result = await ctx.mcpReq.elicitInput({
        mode: "form",
        message: "What is your project name?",
        requestedSchema: {
          type: "object",
          properties: {
            projectName: { type: "string", description: "Project name" },
          },
          required: ["projectName"],
        },
      });
      const name =
        result.action === "accept" && result.content
          ? String((result.content as Record<string, unknown>).projectName ?? "")
          : "(declined)";
      return { content: [{ type: "text" as const, text: `User answered: ${name}` }] };
    }
  );

  server.registerResource(
    "config",
    "fixture://config",
    { title: "App Config", mimeType: "text/plain" },
    async (uri) => ({ contents: [{ uri: uri.href, text: "v1" }] })
  );

  server.registerPrompt(
    "greeting",
    {
      title: "Greeting",
      description: "Greets a person by name.",
      argsSchema: { name: z.string().describe("Who to greet") },
    },
    ({ name }) => ({
      messages: [
        { role: "user" as const, content: { type: "text" as const, text: `Please greet ${name}.` } },
      ],
    })
  );

  return server;
}

if (import.meta.main) {
  const mode = process.argv[2] ?? "stdio";
  if (mode === "stdio") {
    await createFixtureServer().connect(new StdioServerTransport());
    console.error("EVERYTHING SERVER UP (stdio)");
  } else if (mode === "http") {
    const port = Number(process.argv[3] ?? 3211);
    const server = createFixtureServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });
    await server.connect(transport);
    Bun.serve({
      port,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/mcp") {
          try {
            return await transport.handleRequest(req);
          } catch (error) {
            return new Response(String(error), { status: 500 });
          }
        }
        return new Response("not found", { status: 404 });
      },
    });
    console.log(`fixture http server on http://localhost:${port}/mcp`);
  } else {
    console.error("Unknown mode. Use: stdio | http <port>");
    process.exit(1);
  }
}

export { InMemoryTransport };
