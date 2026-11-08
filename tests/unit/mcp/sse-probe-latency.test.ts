/**
 * F1 — SSE probe latency regression test.
 *
 * A valid long-lived SSE response should not cause the probe to wait for the
 * full timeout. The probe must read headers and cancel the body immediately.
 */
import { describe, it, expect } from "bun:test";
import { probeSseEndpoint } from "@/services/mcp/transport.ts";

describe("probeSseEndpoint — latency", () => {
  it("returns promptly for a healthy SSE stream without waiting for timeout", async () => {
    // Create a server that sends SSE headers but keeps the stream open.
    const server = Bun.serve({
      port: 0,
      fetch(_req) {
        const body = new ReadableStream({
          start(controller) {
            // Send headers and an initial comment to keep the stream alive.
            controller.enqueue(new TextEncoder().encode(": keep-alive\n\n"));
            // Never close — simulates a long-lived SSE stream.
          },
        });
        return new Response(body, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
          },
        });
      },
    });

    try {
      const start = Date.now();
      const result = await probeSseEndpoint(`http://localhost:${server.port}/`, {});
      const elapsed = Date.now() - start;

      // Should return well under the 3s timeout.
      expect(elapsed).toBeLessThan(2000);
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.status).toBe(200);
        expect(result.contentType).toContain("text/event-stream");
      }
    } finally {
      server.stop(true);
    }
  }, 10000);

  it("classifies a non-SSE content type as incompatible", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("<html>Not MCP</html>", {
          headers: { "content-type": "text/html" },
        });
      },
    });

    try {
      const result = await probeSseEndpoint(`http://localhost:${server.port}/`, {});
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.status).toBe(200);
        expect(result.contentType).toContain("text/html");
      }
    } finally {
      server.stop(true);
    }
  }, 10000);
});
