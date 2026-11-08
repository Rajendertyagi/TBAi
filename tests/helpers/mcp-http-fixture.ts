/**
 * Stateless Streamable HTTP serving for MCP test fixtures.
 *
 * SDK 2.3.1 made `WebStandardStreamableHTTPServerTransport` reject reuse: a
 * transport built with `sessionIdGenerator: undefined` may handle exactly ONE
 * request, and a second call throws
 * "Stateless transport cannot be reused across requests."
 *
 * The obvious repair — build a fresh server + transport per request — is only
 * half of it. `handleRequest` returns a `Response` whose body is an SSE
 * `ReadableStream` the server writes to ASYNCHRONOUSLY, so closing the server
 * or transport right after `handleRequest` resolves truncates the response
 * before the JSON-RPC reply is enqueued. The client then sees an empty stream
 * and the handshake never completes.
 *
 * The SDK's own stateless fallback (`createLegacyStatelessFallback`) shows the
 * correct shape, reproduced here: tear the per-request server and transport
 * down only once the response body has fully drained (or been cancelled), and
 * tear down immediately for non-streaming responses (JSON errors, 202 acks).
 *
 * Two callers share this: `tests/fixtures/gated-discovery-server.ts` and the
 * inline HTTP server in `tests/integration/mcp/mcp-v2.test.ts`.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";

/**
 * Serve one stateless Streamable HTTP request with a fresh server + transport.
 *
 * `createServer` is called once per request so each exchange gets its own
 * `McpServer` instance. The returned `Response` streams the server's reply and
 * releases both the server and the transport when the body completes.
 */
export async function serveStatelessMcpRequest(
  createServer: () => McpServer,
  request: Request,
): Promise<Response> {
  const server = createServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  await server.connect(transport);

  const teardown = () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  };
  request.signal?.addEventListener("abort", teardown, { once: true });

  const response = await transport.handleRequest(request);

  // Non-streaming replies (JSON-RPC errors, 202 acknowledgements) carry no
  // pending work, so the exchange is already over.
  const contentType = response.headers.get("content-type") ?? "";
  if (response.body === null || !contentType.includes("text/event-stream")) {
    teardown();
    return response;
  }

  const reader = response.body.getReader();
  let tornDown = false;
  const completeExchange = () => {
    if (!tornDown) {
      tornDown = true;
      teardown();
    }
  };

  const monitoredBody = new ReadableStream({
    pull: async (controller) => {
      try {
        const { done, value } = await reader.read();
        if (done) {
          completeExchange();
          controller.close();
          return;
        }
        if (value !== undefined) controller.enqueue(value);
      } catch (error) {
        completeExchange();
        controller.error(error);
      }
    },
    cancel: (reason) => {
      completeExchange();
      return reader.cancel(reason).catch(() => {});
    },
  });

  return new Response(monitoredBody, {
    status: response.status,
    headers: response.headers,
  });
}
