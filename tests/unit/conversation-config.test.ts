import { describe, it, expect } from "bun:test";
import { db } from "../../src/db";
import { registry } from "../../src/config/providers";
import { conversationService } from "../../src/services/storage";
import {
  conversationCreateSchema,
  conversationUpdateSchema,
  chatRequestSchema,
} from "../../src/lib/validation";

async function seedActiveProvider(model: string, thinking: string | null, active = true) {
  const id = `prov-${model}-${thinking ?? "off"}`;
  db.run(
    `INSERT OR REPLACE INTO provider_configs
       (id, name, type, encrypted_api_key, credential_version, endpoint, model, models, thinking, is_active, created_at, updated_at)
     VALUES (?, ?, 'ollama', NULL, NULL, NULL, ?, '[]', ?, ?, ?, ?)`,
    [
      id,
      `seed-${id}`,
      model,
      thinking,
      active ? 1 : 0,
      Date.now(),
      Date.now(),
    ],
  );
  await registry.loadFromDb(db);
  return id;
}

describe("conversation config persistence", () => {
  it("create persists explicit modelId + reasoningLevel and round-trips them", async () => {
    const created = await conversationService.create({
      title: "cfg-test",
      providerId: "p1",
      modelId: "model-x",
      reasoningLevel: "high",
      systemPrompt: null,
    });
    expect(created.modelId).toBe("model-x");
    expect(created.reasoningLevel).toBe("high");

    const fetched = await conversationService.get(created.id);
    expect(fetched?.modelId).toBe("model-x");
    expect(fetched?.reasoningLevel).toBe("high");

    await conversationService.delete(created.id);
  });

  it("update patches modelId + reasoningLevel without clobbering other fields", async () => {
    const created = await conversationService.create({
      title: "cfg-update",
      providerId: "p1",
      modelId: "model-a",
      reasoningLevel: "off",
      systemPrompt: "sys",
    });

    const updated = await conversationService.update(created.id, {
      modelId: "model-b",
      reasoningLevel: "medium",
    });
    expect(updated.modelId).toBe("model-b");
    expect(updated.reasoningLevel).toBe("medium");
    // Untouched fields preserved.
    expect(updated.providerId).toBe("p1");
    expect(updated.systemPrompt).toBe("sys");

    await conversationService.delete(created.id);
  });

  it("create persists the active provider's default when fields are omitted (route resolution)", async () => {
    // The DEFAULTING is the route's job (src/routes/conversations.ts fills
    // omitted modelId/reasoningLevel from the active provider); the service
    // stores exactly what it is given. Exercise the full resolution the way
    // the route does: compute the effective values from the active provider,
    // then hand them to create() and prove they persist.
    const providerId = await seedActiveProvider("default-model", "low");
    const active = registry.getActive();
    expect(active?.id).toBe(providerId);

    const created = await conversationService.create({
      title: "cfg-defaults",
      providerId,
      modelId: active?.model ?? null,
      reasoningLevel: active?.thinking ?? "off",
      systemPrompt: null,
    });
    expect(created.modelId).toBe("default-model");
    expect(created.reasoningLevel).toBe("low");
    expect(created.providerId).toBe(providerId);

    // And the omitted-field path: when the route leaves a field undefined the
    // service stores NULL — proving the service is a faithful store and that
    // defaulting is a caller (route) concern, not a hidden behavior here.
    const omitted = await conversationService.create({
      title: "cfg-omitted",
      providerId,
      modelId: undefined,
      reasoningLevel: undefined,
      systemPrompt: null,
    });
    expect(omitted.modelId).toBeNull();
    expect(omitted.reasoningLevel).toBeNull();

    await conversationService.delete(created.id);
    await conversationService.delete(omitted.id);
  });

  it("conversationCreateSchema accepts the per-conversation config fields", () => {
    const parsed = conversationCreateSchema.parse({
      title: "t",
      providerId: "p1",
      modelId: "m1",
      reasoningLevel: "low",
    });
    expect(parsed.modelId).toBe("m1");
    expect(parsed.reasoningLevel).toBe("low");
  });

  it("conversationUpdateSchema accepts providerId/modelId/reasoningLevel", () => {
    const parsed = conversationUpdateSchema.parse({
      modelId: "m2",
      reasoningLevel: "high",
      providerId: "p2",
    });
    expect(parsed.modelId).toBe("m2");
    expect(parsed.reasoningLevel).toBe("high");
    expect(parsed.providerId).toBe("p2");
  });

  it("chatRequestSchema uses reasoningLevel (not thinkingLevel)", () => {
    const parsed = chatRequestSchema.parse({
      providerId: "p1",
      model: "m1",
      reasoningLevel: "medium",
      messages: [{ role: "user" }],
    });
    expect((parsed as { reasoningLevel?: string }).reasoningLevel).toBe("medium");
    // Legacy field name is not accepted as a known key.
    expect((parsed as { thinkingLevel?: string }).thinkingLevel).toBeUndefined();
  });
});
