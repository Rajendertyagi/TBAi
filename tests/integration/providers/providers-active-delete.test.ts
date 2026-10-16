import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { registry } from "@/config/providers";
import providersApp from "@/routes/providers.ts";
import { resolveChatModel } from "@/routes/chat/model.ts";

/**
 * The stale-active-provider defect, exercised through the REAL
 * `DELETE /api/providers/:id` route rather than the registry in isolation.
 *
 * The route deletes the row and then calls `registry.loadFromDb(db)`. Before
 * the fix that reload kept the deleted provider's id, so `getActive()`
 * returned `undefined` and `resolveChatModel` reported no provider at all,
 * even though a second provider was still configured.
 *
 * DB isolation: tests/setup.ts (bunfig preload) redirects DATA_DIR per file.
 */

const app = new Hono();
app.route("/", providersApp);

function createProvider(body: Record<string, unknown>) {
  return app.request("/api/providers", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("provider deletion does not strand the registry's active provider", () => {
  it("leaves an existing provider selected after the active one is deleted", async () => {
    // The first provider created becomes the active one.
    const firstRes = await createProvider({ name: "primary", type: "openai", model: "gpt-x" });
    expect(firstRes.status).toBe(200);
    const primary = (await firstRes.json()) as { id: string; isActive: boolean };
    expect(primary.isActive).toBe(true);
    expect(registry.getActive()?.id).toBe(primary.id);

    // A second provider stays inactive.
    const secondRes = await createProvider({ name: "secondary", type: "openai", model: "gpt-y" });
    expect(secondRes.status).toBe(200);
    const secondary = (await secondRes.json()) as { id: string; isActive: boolean };
    expect(secondary.isActive).toBe(false);

    // Delete the ACTIVE provider through the real route.
    const delRes = await app.request(`/api/providers/${primary.id}`, { method: "DELETE" });
    expect(delRes.status).toBe(200);

    // The deleted provider must not still be the selected one...
    expect(registry.getActive()?.id).not.toBe(primary.id);
    // ...and a provider that still exists must be selected instead of none.
    expect(registry.getActive()).toBeDefined();
    expect(registry.list().map((p) => p.id)).toContain(registry.getActive()!.id);
    expect(registry.getActive()?.id).toBe(secondary.id);
  });

  it("still resolves a chat model after the active provider is deleted", async () => {
    // Guard: this suite must start from a state where a provider is selected,
    // otherwise the assertion below would pass for the wrong reason.
    expect(registry.getActive()).toBeDefined();

    // No providerId, no threadId => the global-fallback branch of resolution,
    // which is the branch that reported "No provider configured" before the fix.
    const resolved = await resolveChatModel({});

    expect(resolved).not.toBeNull();
    expect(resolved?.provider.id).toBe(registry.getActive()?.id);
  });
});
