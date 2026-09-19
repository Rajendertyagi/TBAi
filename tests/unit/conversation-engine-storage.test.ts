import { describe, it, expect, beforeEach } from "bun:test";
import { db } from "../../src/db";
import { conversationService } from "../../src/services/storage";

/**
 * Storage mapping for the dual-chat conversation columns: `engine`,
 * `opencode_agent`, `opencode_model`. The service is the single row→domain
 * mapper (mapConversation), so these tests exercise the public create/update/
 * get surface against the isolated test DB.
 *
 * DB isolation: tests/setup.ts (bunfig preload) redirects DATA_DIR to tmp.
 */

interface LegacyRow {
  id: string;
}

function legacyConversation(id: string): LegacyRow {
  const now = Date.now();
  // Insert only the pre-dual-chat columns: engine / opencode_agent /
  // opencode_model intentionally absent → they land as SQL NULL in the DB.
  db.run(
    `INSERT INTO conversations (id, title, provider_id, model_id, reasoning_level, system_prompt, status, created_at, updated_at)
     VALUES (?, 'legacy', 'p', NULL, NULL, NULL, 'regular', ?, ?)`,
    [id, now, now],
  );
  return { id };
}

async function cleaned(id: string) {
  await conversationService.delete(id);
}

describe("conversation storage — engine / opencodeAgent / opencodeModel mapping", () => {
  beforeEach(() => {
    // Defensive: no shared state between cases.
  });

  it("create persists explicit engine + opencodeAgent + opencodeModel (happy path)", async () => {
    const created = await conversationService.create({
      title: "engine-happy",
      providerId: "p",
      modelId: "openai/gpt-4o",
      reasoningLevel: "off",
      systemPrompt: null,
      workspaceMode: "simple",
      engine: "opencode",
      opencodeAgent: "coder",
      opencodeModel: "openai/gpt-4o",
    });
    expect(created.engine).toBe("opencode");
    expect(created.opencodeAgent).toBe("coder");
    expect(created.opencodeModel).toBe("openai/gpt-4o");

    // Round-trip through the real row mapper, not just the create response.
    const fetched = await conversationService.get(created.id);
    expect(fetched?.engine).toBe("opencode");
    expect(fetched?.opencodeAgent).toBe("coder");
    expect(fetched?.opencodeModel).toBe("openai/gpt-4o");
    await cleaned(created.id);
  });

  it("create without engine fields defaults engine to 'direct' with null agent/model (happy path)", async () => {
    const created = await conversationService.create({
      title: "engine-defaults",
      providerId: "p",
      modelId: null,
      reasoningLevel: null,
      systemPrompt: null,
    });
    expect(created.engine).toBe("direct");
    expect(created.opencodeAgent).toBeNull();
    expect(created.opencodeModel).toBeNull();
    await cleaned(created.id);
  });

  it("legacy row with NULL engine maps to 'direct', NULL agent/model map to null (edge case)", async () => {
    const legacy = legacyConversation("legacy-engine-" + Date.now());
    const mapped = await conversationService.get(legacy.id);
    expect(mapped).not.toBeNull();
    // The documented mapping: SQL NULL → "direct" default.
    expect(mapped?.engine).toBe("direct");
    expect(mapped?.opencodeAgent).toBeNull();
    expect(mapped?.opencodeModel).toBeNull();
    await cleaned(legacy.id);
  });

  it("update patches engine / opencodeAgent / opencodeModel and persists (happy path)", async () => {
    const created = await conversationService.create({
      title: "engine-update",
      providerId: "p",
      modelId: null,
      reasoningLevel: null,
      systemPrompt: null,
    });
    expect(created.engine).toBe("direct");

    const updated = await conversationService.update(created.id, {
      engine: "opencode",
      opencodeAgent: "coder",
      opencodeModel: "anthropic/claude-sonnet-4",
    });
    expect(updated.engine).toBe("opencode");
    expect(updated.opencodeAgent).toBe("coder");
    expect(updated.opencodeModel).toBe("anthropic/claude-sonnet-4");

    // Re-read from SQLite — proves persistence, not just the returned object.
    const reloaded = await conversationService.get(created.id);
    expect(reloaded?.engine).toBe("opencode");
    expect(reloaded?.opencodeAgent).toBe("coder");
    expect(reloaded?.opencodeModel).toBe("anthropic/claude-sonnet-4");
    await cleaned(created.id);
  });

  it("update clears opencode fields to null without touching engine (edge case: partial patch)", async () => {
    const created = await conversationService.create({
      title: "engine-clear",
      providerId: "p",
      modelId: null,
      reasoningLevel: null,
      systemPrompt: null,
      engine: "opencode",
      opencodeAgent: "coder",
      opencodeModel: "openai/gpt-4o",
    });

    const updated = await conversationService.update(created.id, {
      opencodeAgent: null,
      opencodeModel: null,
    });
    expect(updated.opencodeAgent).toBeNull();
    expect(updated.opencodeModel).toBeNull();
    // Engine was not part of the patch → preserved.
    expect(updated.engine).toBe("opencode");
    await cleaned(created.id);
  });

  it("create persists opencodeAutoApprove and round-trips it", async () => {
    const created = await conversationService.create({
      title: "auto-happy",
      providerId: "p",
      modelId: null,
      reasoningLevel: null,
      systemPrompt: null,
      opencodeAutoApprove: true,
    });
    expect(created.opencodeAutoApprove).toBe(true);

    const fetched = await conversationService.get(created.id);
    expect(fetched?.opencodeAutoApprove).toBe(true);
    await cleaned(created.id);
  });

  it("create without opencodeAutoApprove defaults to manual (false)", async () => {
    const created = await conversationService.create({
      title: "auto-default",
      providerId: "p",
      modelId: null,
      reasoningLevel: null,
      systemPrompt: null,
    });
    expect(created.opencodeAutoApprove).toBe(false);
    await cleaned(created.id);
  });

  it("update patches opencodeAutoApprove and persists it", async () => {
    const created = await conversationService.create({
      title: "auto-update",
      providerId: "p",
      modelId: null,
      reasoningLevel: null,
      systemPrompt: null,
    });
    expect(created.opencodeAutoApprove).toBe(false);

    const updated = await conversationService.update(created.id, {
      opencodeAutoApprove: true,
    });
    expect(updated.opencodeAutoApprove).toBe(true);

    const reloaded = await conversationService.get(created.id);
    expect(reloaded?.opencodeAutoApprove).toBe(true);
    await cleaned(created.id);
  });

  it("legacy row with NULL opencode_auto_approve maps to manual (false)", async () => {
    const legacy = legacyConversation("legacy-auto-" + Date.now());
    const mapped = await conversationService.get(legacy.id);
    expect(mapped).not.toBeNull();
    expect(mapped?.opencodeAutoApprove).toBe(false);
    await cleaned(legacy.id);
  });
});
