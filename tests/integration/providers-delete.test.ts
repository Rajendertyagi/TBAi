/**
 * Provider delete guard: refuse while conversations reference the provider.
 *
 * DB isolation: tests/setup.ts (bunfig preload) redirects DATA_DIR to tmp.
 */
import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { db } from "../../src/db";
import { conversationService } from "../../src/services/storage";
import providersApp from "../../src/routes/providers";

const app = new Hono();
app.route("/", providersApp);

function seedProvider(id: string): void {
  db.run(
    `INSERT OR REPLACE INTO provider_configs
       (id, name, type, encrypted_api_key, credential_version, endpoint, model, models, thinking, is_active, created_at, updated_at)
     VALUES (?, ?, 'openai', NULL, NULL, NULL, 'm', '[]', 'off', 0, ?, ?)`,
    [id, `prov-${id}`, Date.now(), Date.now()],
  );
}

describe("provider delete guard", () => {
  it("refuses deletion while conversations reference the provider", async () => {
    seedProvider("guard-p1");
    const conv = await conversationService.create({
      title: "guarded chat",
      providerId: "guard-p1",
      modelId: null,
      reasoningLevel: null,
      systemPrompt: null,
      workspaceMode: "simple",
      workspaceFolderId: null,
    });
    const res = await app.request(`/api/providers/guard-p1`, {
      method: "DELETE",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error ?? "").toMatch(/in use/i);
    await conversationService.delete(conv.id);
  });

  it("deletes an unused provider", async () => {
    seedProvider("guard-p2");
    const res = await app.request(`/api/providers/guard-p2`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
  });
});
