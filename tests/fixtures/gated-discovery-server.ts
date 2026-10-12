#!/usr/bin/env bun
/**
 * Fixture MCP server (TEST ONLY — never shipped) that stalls capability
 * discovery on demand.
 *
 * ## Why this exists
 *
 * `McpManager.discoverCapabilities()` runs AFTER `client.connect()` has already
 * reported success, and it awaits `listTools` / `listResources` / `listPrompts`.
 * Those three awaits are a lifecycle window of their own: a disconnect or a
 * replacement `connect()` can land inside one, and the discovery that resumes
 * afterwards used to write through `pushEvent(id, ...)` — which resolves the
 * CURRENT connection, so a superseded discovery could append its error to a
 * replacement's event history.
 *
 * To test that deterministically the stall has to be placed by the TEST, not
 * waited for. Everything else in the fixture is an ordinary working MCP server:
 * the handshake completes normally, so the connection genuinely reaches
 * `"connected"` and discovery genuinely begins. Only `tools/list` is held.
 *
 * ## The gate
 *
 * The gate lives in this fixture's HTTP layer, not in an SDK request handler, so
 * it needs no SDK internals and holds the exact response the client is waiting
 * for:
 *
 *   - `entered` is written the moment a `tools/list` request arrives, so the
 *     test knows discovery is parked rather than guessing with a sleep;
 *   - the response is withheld until the `release` file exists, so the test
 *     chooses when discovery resumes.
 *
 * Both paths are handed in per-process, so parallel cases cannot wait on each
 * other's gate.
 *
 * Usage:
 *   bun run tests/fixtures/gated-discovery-server.ts <port> <releasePath> <enteredPath>
 */
import { existsSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { z } from "zod";

/** The one capability this server advertises, so only `tools/list` is called. */
function buildServer(): McpServer {
  const server = new McpServer({ name: "fixture-gated-discovery", version: "1.0.0" });
  server.registerTool(
    "gated_tool",
    {
      description: "Tool whose discovery response is held by the fixture's gate.",
      inputSchema: z.object({}),
    },
    async () => ({ content: [{ type: "text" as const, text: "gated" }] }),
  );
  return server;
}

/**
 * Start the gated server on `port`.
 *
 * Returns the Bun server so the caller can stop it. `releasePath` may be absent,
 * in which case discovery is never stalled and the server behaves normally.
 */
export async function startGatedDiscoveryServer(
  port: number,
  releasePath: string | undefined,
  enteredPath: string,
  options: { failOnRelease?: boolean } = {},
): Promise<{ stop: () => void }> {
  const server = buildServer();
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);

  const http = Bun.serve({
    port,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname !== "/mcp") return new Response("not found", { status: 404 });

      const body = await req.text();
      let toolListId: number | string | null = null;
      try {
        // Streamable HTTP batches requests, so every entry is inspected rather
        // than assuming the body is a single JSON-RPC message.
        const parsed: unknown = JSON.parse(body);
        for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
          if (
            typeof entry === "object" &&
            entry !== null &&
            (entry as { method?: unknown }).method === "tools/list"
          ) {
            toolListId = ((entry as { id?: unknown }).id ?? null) as number | string | null;
          }
        }
      } catch {
        /* not JSON-RPC: pass through to the transport unchanged */
      }

      if (toolListId !== null) {
        await Bun.write(enteredPath, "entered");
        while (releasePath && !existsSync(releasePath)) await Bun.sleep(20);
        // Answering with a JSON-RPC error is what puts the CALLER into the catch
        // block this fixture exists to exercise. A dropped connection would not:
        // the SDK leaves such a request pending rather than rejecting it, so the
        // failure path would never run and the test would prove nothing.
        if (options.failOnRelease) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: toolListId,
              error: { code: -32603, message: "gated discovery failure" },
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
      }

      return transport.handleRequest(
        new Request(req.url, { method: req.method, headers: req.headers, body }),
      );
    },
  });

  return { stop: () => http.stop(true) };
}

if (import.meta.main) {
  const [portArg, releaseArg, enteredArg] = process.argv.slice(2);
  if (!portArg || !enteredArg) {
    console.error("usage: gated-discovery-server.ts <port> [releasePath] <enteredPath>");
    process.exit(1);
  }
  await startGatedDiscoveryServer(Number(portArg), releaseArg, enteredArg);
  console.error(`GATED DISCOVERY SERVER UP (port ${portArg})`);
  // Serve until killed; the transport keeps the loop alive on its own.
  await new Promise(() => {});
}
