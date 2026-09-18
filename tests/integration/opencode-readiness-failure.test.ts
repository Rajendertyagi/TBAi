/**
 * OpenCode readiness-failure surface (hermetic):
 *   When `ensureBaseUrl()` rejects with a generic (non-binary-missing) Error,
 *   every OpenCode route must return a CLASSIFIED 500 with `{ error }` — never
 *   an unhandled TypeError leaking internals. This guards the regression where
 *   a readiness race defect surfaced as `TypeError: undefined is not an object
 *   (evaluating 'outcome.kind')` instead of a clean failure.
 *
 * Hermetic: `ensureBaseUrl` is patched to reject, so no process is spawned and
 * no network I/O occurs. Runs regardless of whether the opencode binary exists.
 */
import { describe, it, expect } from "bun:test";
import { openCodeServerManager } from "../../src/services/opencode/serverManager";
import { conversationService } from "../../src/services/storage";

// Force every OpenCode surface down the failure branch without spawning a
// process or doing network I/O.
(
  openCodeServerManager as unknown as {
    ensureBaseUrl: () => Promise<string>;
  }
).ensureBaseUrl = () => Promise.reject(new Error("readiness failed"));

/** Drive the real Hono route in-process (no server, no network). */
async function requestRoute(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const { default: app } = await import("../../src/routes/opencode");
  return app.request(`http://localhost${path}`, init);
}

describe("/api/opencode/* generic readiness failure → classified 500", () => {
  it("GET /api/opencode/capabilities → 500 with an error payload", async () => {
    const res = await requestRoute("/api/opencode/capabilities");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string };
    expect(typeof body.error).toBe("string");
    expect(body.error?.length).toBeGreaterThan(0);
  });

  it("POST /api/opencode/session → 500 with an error payload", async () => {
    const created = await conversationService.create({
      title: "oc-readiness-failure-probe",
      providerId: "p",
      modelId: null,
      reasoningLevel: null,
      systemPrompt: null,
      workspaceMode: "simple",
    });
    try {
      const res = await requestRoute("/api/opencode/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: created.id }),
      });
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error?: string };
      expect(typeof body.error).toBe("string");
      expect(body.error?.length).toBeGreaterThan(0);
    } finally {
      await conversationService.delete(created.id);
    }
  });
});
