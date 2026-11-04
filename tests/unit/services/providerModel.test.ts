import { describe, it, expect, beforeEach } from "bun:test";
import type { LanguageModel } from "ai";
import { db } from "@/db";
import { credentialStore } from "@/services/credentials";
import { resolveProviderApiKey, buildProviderModel } from "@/services/providerModel";
import type { ProviderConfig } from "@/types";

credentialStore.initialize();

/** Narrow the LanguageModel union (it includes a bare string id) to its object form. */
function modelInfo(model: LanguageModel): { provider: string; modelId: string } {
  if (typeof model === "string") return { provider: model, modelId: model };
  return { provider: model.provider, modelId: model.modelId };
}

/**
 * Shared provider → model resolution.
 *
 * The chat route and MCP sampling both build their model through this module,
 * so the wire-protocol override and the keyless Ollama case behave the same
 * everywhere. These tests pin the credential resolution contract and the
 * apiProtocol pass-through (MCP sampling used to drop it, silently rebuilding
 * a Chat Completions provider with the Responses default).
 */

function seedProvider(
  id: string,
  type: ProviderConfig["type"],
  apiProtocol?: ProviderConfig["apiProtocol"],
): void {
  const now = Date.now();
  db.run(
    "INSERT INTO provider_configs (id, name, type, endpoint, model, models, thinking, api_protocol, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, id, type, "http://mock/v1", "test-model", "[]", "off", apiProtocol ?? null, 0, now, now],
  );
}

function providerConfig(
  id: string,
  type: ProviderConfig["type"],
  apiProtocol?: ProviderConfig["apiProtocol"],
): ProviderConfig {
  return {
    id,
    name: id,
    type,
    endpoint: "http://mock/v1",
    model: "test-model",
    models: [],
    thinking: "off",
    apiProtocol,
    isActive: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

beforeEach(() => {
  db.run("DELETE FROM provider_configs WHERE id LIKE 'resolver-test-%'");
});

describe("resolveProviderApiKey", () => {
  it("returns undefined for Ollama without touching the credential store", () => {
    seedProvider("resolver-test-ollama", "ollama");
    expect(resolveProviderApiKey(providerConfig("resolver-test-ollama", "ollama"))).toBeUndefined();
  });

  it("returns undefined when no key is stored", () => {
    seedProvider("resolver-test-nokey", "openai");
    expect(resolveProviderApiKey(providerConfig("resolver-test-nokey", "openai"))).toBeUndefined();
  });

  it("returns the stored key", () => {
    seedProvider("resolver-test-key", "openai");
    credentialStore.set("resolver-test-key", "sk-test-123");
    expect(resolveProviderApiKey(providerConfig("resolver-test-key", "openai"))).toBe(
      "sk-test-123",
    );
  });
});

describe("buildProviderModel", () => {
  it("passes apiProtocol through to the model factory (chat-completions)", () => {
    const model = buildProviderModel(
      providerConfig("resolver-test-cc", "openai", "chat-completions"),
      { apiKey: "k" },
    );
    expect(modelInfo(model).provider).toBe("openaiCompatible.chat");
  });

  it("passes apiProtocol through to the model factory (responses)", () => {
    const model = buildProviderModel(providerConfig("resolver-test-resp", "openai", "responses"), {
      apiKey: "k",
    });
    expect(modelInfo(model).provider).toBe("openai.responses");
  });

  it("defaults a custom provider to chat-completions", () => {
    const model = buildProviderModel(providerConfig("resolver-test-custom", "custom"), {
      apiKey: "k",
    });
    expect(modelInfo(model).provider).toBe("openaiCompatible.chat");
  });

  it("resolves the stored credential when no apiKey override is given", () => {
    seedProvider("resolver-test-stored", "openai", "chat-completions");
    credentialStore.set("resolver-test-stored", "sk-stored-456");
    const model = buildProviderModel(
      providerConfig("resolver-test-stored", "openai", "chat-completions"),
    );
    expect(modelInfo(model).provider).toBe("openaiCompatible.chat");
  });

  it("honours an explicit model override", () => {
    const model = buildProviderModel(providerConfig("resolver-test-override", "openai"), {
      apiKey: "k",
      model: "gpt-override",
    });
    expect(modelInfo(model).modelId).toBe("gpt-override");
  });
});
