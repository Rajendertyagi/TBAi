/**
 * POST /api/providers/test — success-path contract.
 *
 * The test endpoint runs a full model discovery server-side. It returns the
 * discovered models so the provider dialog can populate its picker without a
 * second discovery pass (which for Ollama means N extra /api/show requests).
 * This pins that contract: ok, modelCount, and the models array itself.
 */
import { describe, it, expect, afterEach } from "bun:test";

const app = (await import("@/routes/index.ts")).default;

const JSON_HEADERS = { "Content-Type": "application/json" };
const origFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("POST /api/providers/test — success path", () => {
  it("returns the discovered models alongside modelCount", async () => {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
      input: RequestInfo | URL,
    ) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("/models")) {
        return jsonResponse({
          data: [
            { id: "gpt-test-alpha" },
            { id: "gpt-test-beta" },
            { id: "text-embedding-3-large" },
          ],
        });
      }
      throw new Error(`unexpected fetch in test-endpoint mock: ${url}`);
    }) as typeof fetch;

    const res = await app.request("/api/providers/test", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        name: "test-endpoint-probe",
        type: "custom",
        endpoint: "http://mock-provider/v1",
        model: "gpt-test-alpha",
        apiKey: "probe-key",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      modelCount?: number;
      models?: Array<{ id: string }>;
    };
    expect(body.ok).toBe(true);
    // The embedding model is filtered out; the two chat models are returned.
    expect(body.modelCount).toBe(2);
    expect(body.models?.map((m) => m.id)).toEqual(["gpt-test-alpha", "gpt-test-beta"]);
  });
});
