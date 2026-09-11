import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer } from "@modelcontextprotocol/server";

// Minimal MCP server over Streamable HTTP for testing the TBAi HTTP client
// transport. Run: bun run scripts/minimal-mcp-http.mjs  (listens on :8787)
import { z } from "zod";
import { createServer } from "http";

const PORT = Number(process.env.PORT || 8787);

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : undefined);
      } catch {
        resolve(undefined);
      }
    });
  });
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname !== "/mcp") {
    res.writeHead(404).end("not found");
    return;
  }
  const sessionId = req.headers["mcp-session-id"];
  let transport = sessionId ? globalThis.__t : undefined;
  if (!transport) {
    if (req.method !== "POST") {
      res.writeHead(405).end("Method Not Allowed");
      return;
    }
    transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: () => (globalThis.__sid = crypto.randomUUID()),
      onsessioninitialized: (sid) => {
        globalThis.__sid = sid;
        globalThis.__t = transport;
      },
    });
    globalThis.__t = transport;
    const server = new McpServer({ name: "minimal-http", version: "1.0.0" });
    server.registerTool("ping", { description: "Return pong", inputSchema: z.object({}) }, async () => ({
                content: [{ type: "text", text: "pong" }],
              }));
    server.registerTool("square", { description: "Square a number", inputSchema: z.object({ n: z.number() }) }, async ({ n }) => ({
                content: [{ type: "text", text: String(n * n) }],
              }));
    await server.connect(transport);
  }
  const body = req.method === "POST" ? await readBody(req) : undefined;
  await transport.handleRequest(req, res, body);
});

httpServer.listen(PORT, () => console.error(`[minimal-http] ready on ${PORT}`));
