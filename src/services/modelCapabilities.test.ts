import { describe, it, expect, afterEach } from "bun:test";
import { discoverModels } from "./modelDiscovery";
import {
  modelCapabilitiesSchema,
  modelOptionSchema,
  providerCreateSchema,
  reasoningCapabilitySchema,
} from "../lib/validation";

// --- Deterministic fetch mock (no live network). Routes by URL suffix. ---
type ShowBehavior =
  | { kind: "json"; body: unknown; status?: number }
  | { kind: "throw"; error?: Error };

const origFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Ollama-scoped mock: per-model /api/show behavior keyed by model id. */
function installOllamaMock(tags: string[], shows: Record<string, ShowBehavior | unknown>): void {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string" ? input : String(input);
    if (url.endsWith("/api/tags")) {
      return jsonResponse({ models: tags.map((name) => ({ name })) });
    }
    if (url.endsWith("/api/show")) {
      let model = "";
      try {
        model = (JSON.parse(String(init?.body ?? "{}")) as { model?: unknown }).model as string;
      } catch {
        model = "";
      }
      const behavior = shows[model] as ShowBehavior | unknown;
      if (
        behavior !== null &&
        typeof behavior === "object" &&
        "kind" in (behavior as Record<string, unknown>)
      ) {
        const b = behavior as ShowBehavior;
        if (b.kind === "throw") throw b.error ?? new Error("network down");
        return jsonResponse(b.body, b.status ?? 200);
      }
      // Plain value = the raw /api/show JSON body.
      return jsonResponse(behavior);
    }
    throw new Error(`unexpected fetch in ollama mock: ${url}`);
  }) as typeof fetch;
}

/** Cloud-listing mock: serves one listing payload for models endpoints. */
function installCloudMock(payload: unknown): void {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
    input: RequestInfo | URL,
  ) => {
    const url = typeof input === "string" ? input : String(input);
    if (url.includes("/models")) return jsonResponse(payload);
    throw new Error(`unexpected fetch in cloud mock: ${url}`);
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("Phase 1 model capabilities — truthful foundation", () => {
  it("1. explicit thinking capability marks the model supported", async () => {
    installOllamaMock(["qwen-think"], {
      "qwen-think": { capabilities: ["thinking"] },
    });
    const models = await discoverModels({ type: "ollama", endpoint: "http://mock:11434" });
    expect(models).toHaveLength(1);
    expect(models[0]?.capabilities?.reasoning.support).toBe("supported");
  });

  it("2. source-provided level ids are preserved exactly (opaque, any count)", () => {
    const levels = ["t1", "deep-think", "x", "mode-4", "fifth-mode", "extra-opaque-id"];
    const parsed = modelCapabilitiesSchema.parse({
      reasoning: { support: "supported", levels },
    });
    expect(parsed.reasoning.levels).toEqual(levels);
    expect(parsed.reasoning.levels).toHaveLength(6);
    // No mapping to off/low/medium/high — opaque strings survive verbatim.
    expect(parsed.reasoning.levels).not.toContain("medium");
  });

  it("3. supported with no levels stays valid with levels absent (nothing invented)", () => {
    const parsed = modelCapabilitiesSchema.parse({ reasoning: { support: "supported" } });
    expect(parsed.reasoning.support).toBe("supported");
    expect("levels" in parsed.reasoning).toBe(false);
    expect(parsed.reasoning.levels).toBeUndefined();
  });

  it("4. cloud normalizers (openai/anthropic/google/custom) yield unknown", async () => {
    installCloudMock({ data: [{ id: "gpt-4o-mini" }] });
    const openai = await discoverModels({ type: "openai", endpoint: "http://mock-openai/v1" });
    expect(openai[0]?.capabilities?.reasoning.support).toBe("unknown");

    installCloudMock({ data: [{ id: "claude-3-haiku", display_name: "Haiku" }] });
    const anthropic = await discoverModels({
      type: "anthropic",
      endpoint: "http://mock-anthropic",
      apiKey: "k",
    });
    expect(anthropic[0]?.capabilities?.reasoning.support).toBe("unknown");

    installCloudMock({ models: [{ name: "models/gemini-flash" }] });
    const google = await discoverModels({
      type: "google",
      endpoint: "http://mock-google",
      apiKey: "k",
    });
    expect(google[0]?.capabilities?.reasoning.support).toBe("unknown");

    installCloudMock({ data: [{ id: "llama-custom" }] });
    const custom = await discoverModels({ type: "custom", endpoint: "http://mock-custom/v1" });
    expect(custom[0]?.capabilities?.reasoning.support).toBe("unknown");
  });

  it("5. ollama /api/show containing thinking among other tokens yields supported", async () => {
    installOllamaMock(["mixed-model"], {
      "mixed-model": { capabilities: ["completion", "thinking", "vision"] },
    });
    const models = await discoverModels({ type: "ollama", endpoint: "http://mock:11434" });
    expect(models[0]?.capabilities?.reasoning.support).toBe("supported");
  });

  it("6. /api/show without thinking yields unknown (NOT unsupported)", async () => {
    installOllamaMock(["plain-model"], {
      "plain-model": { capabilities: ["completion"] },
    });
    const models = await discoverModels({ type: "ollama", endpoint: "http://mock:11434" });
    expect(models[0]?.capabilities?.reasoning.support).toBe("unknown");
    expect(models[0]?.capabilities?.reasoning.support).not.toBe("unsupported");
  });

  it("7. /api/show failure/unreachable/malformed degrades to unknown", async () => {
    // Failure (network throw).
    installOllamaMock(["down-model"], {
      "down-model": { kind: "throw", error: new Error("connection refused") },
    });
    const failed = await discoverModels({ type: "ollama", endpoint: "http://mock:11434" });
    expect(failed[0]?.capabilities?.reasoning.support).toBe("unknown");

    // Malformed: capabilities missing entirely.
    installOllamaMock(["odd-model"], { "odd-model": { tools: true } });
    const missing = await discoverModels({ type: "ollama", endpoint: "http://mock:11434" });
    expect(missing[0]?.capabilities?.reasoning.support).toBe("unknown");

    // Malformed: capabilities present but not an array.
    installOllamaMock(["shaped-wrong"], { "shaped-wrong": { capabilities: "thinking" } });
    const shaped = await discoverModels({ type: "ollama", endpoint: "http://mock:11434" });
    expect(shaped[0]?.capabilities?.reasoning.support).toBe("unknown");

    // Unreachable: HTTP 500 from the daemon.
    installOllamaMock(["sick-model"], {
      "sick-model": { kind: "json", body: { error: "boom" }, status: 500 },
    });
    const http500 = await discoverModels({ type: "ollama", endpoint: "http://mock:11434" });
    expect(http500[0]?.capabilities?.reasoning.support).toBe("unknown");
  });

  it("8. capabilities survive save-to-GET serialization round-trip", async () => {
    installOllamaMock(["qwen-think", "plain"], {
      "qwen-think": { capabilities: ["thinking"] },
      plain: { capabilities: ["completion"] },
    });
    const discovered = await discoverModels({ type: "ollama", endpoint: "http://mock:11434" });
    // Simulate provider save (JSON into models column) then GET /api/providers
    // echo (JSON out, validated on read) — the verbatim-echo projection path.
    const saved = JSON.stringify(discovered);
    const restored = modelOptionSchema.array().parse(JSON.parse(saved) as unknown);
    expect(restored).toEqual(discovered);
    expect(restored.find((m) => m.id === "qwen-think")?.capabilities?.reasoning.support).toBe(
      "supported",
    );
    expect(restored.find((m) => m.id === "plain")?.capabilities?.reasoning.support).toBe(
      "unknown",
    );
    // Same round-trip through the provider create shape carrying models.
    const provider = providerCreateSchema.parse({
      name: "o",
      type: "ollama",
      model: "qwen-think",
      models: JSON.parse(saved) as unknown,
    });
    expect(provider.models?.[0]?.capabilities?.reasoning.support).toBe("supported");
  });

  it("9. same model id under two providers keeps separate capability objects", async () => {
    installCloudMock({ data: [{ id: "llama3-shared" }] });
    const cloud = await discoverModels({ type: "openai", endpoint: "http://mock-openai/v1" });
    installOllamaMock(["llama3-shared"], {
      "llama3-shared": { capabilities: ["thinking"] },
    });
    const ollama = await discoverModels({ type: "ollama", endpoint: "http://mock:11434" });
    expect(cloud[0]?.id).toBe("llama3-shared");
    expect(ollama[0]?.id).toBe("llama3-shared");
    expect(cloud[0]?.provider).toBe("openai");
    expect(ollama[0]?.provider).toBe("ollama");
    expect(cloud[0]?.capabilities?.reasoning.support).toBe("unknown");
    expect(ollama[0]?.capabilities?.reasoning.support).toBe("supported");
    // Distinct objects — mutating one cannot leak into the other.
    expect(cloud[0]?.capabilities).not.toBe(ollama[0]?.capabilities);
  });

  it("10. one model's /api/show failure does not break the rest of discovery", async () => {
    installOllamaMock(["good-thinker", "bad-actor", "plain-jane"], {
      "good-thinker": { capabilities: ["thinking"] },
      "bad-actor": { kind: "throw", error: new Error("reset by peer") },
      "plain-jane": { capabilities: [] },
    });
    const models = await discoverModels({ type: "ollama", endpoint: "http://mock:11434" });
    expect(models).toHaveLength(3);
    const byId = Object.fromEntries(models.map((m) => [m.id, m]));
    expect(byId["good-thinker"]?.capabilities?.reasoning.support).toBe("supported");
    expect(byId["bad-actor"]?.capabilities?.reasoning.support).toBe("unknown");
    expect(byId["plain-jane"]?.capabilities?.reasoning.support).toBe("unknown");
  });

  it("11. strict schema preserves the capability field and rejects invalid support values", () => {
    const valid = modelOptionSchema.parse({
      id: "m",
      provider: "openai",
      capabilities: { reasoning: { support: "unknown" } },
    });
    expect(valid.capabilities?.reasoning.support).toBe("unknown");

    for (const bad of ["maybe", "", "SUPPORTED", true, 42, null]) {
      expect(() =>
        reasoningCapabilitySchema.parse({ support: bad }),
      ).toThrow();
    }
    // Missing required reasoning stance is rejected — a capabilities object
    // must take an explicit stance.
    expect(() => modelCapabilitiesSchema.parse({})).toThrow();
  });

  it("12. unknown is never converted to unsupported anywhere in the pipeline", async () => {
    const supports: string[] = [];
    // Cloud normalizers.
    installCloudMock({ data: [{ id: "gpt-4o-mini" }] });
    for (const m of await discoverModels({ type: "openai", endpoint: "http://mock-openai/v1" })) {
      if (m.capabilities) supports.push(m.capabilities.reasoning.support);
    }
    installCloudMock({ data: [{ id: "claude-3-haiku" }] });
    for (const m of await discoverModels({
      type: "anthropic",
      endpoint: "http://mock-anthropic",
      apiKey: "k",
    })) {
      if (m.capabilities) supports.push(m.capabilities.reasoning.support);
    }
    installCloudMock({ models: [{ name: "models/gemini-flash" }] });
    for (const m of await discoverModels({
      type: "google",
      endpoint: "http://mock-google",
      apiKey: "k",
    })) {
      if (m.capabilities) supports.push(m.capabilities.reasoning.support);
    }
    installCloudMock({ data: [{ id: "llama-custom" }] });
    for (const m of await discoverModels({ type: "custom", endpoint: "http://mock-custom/v1" })) {
      if (m.capabilities) supports.push(m.capabilities.reasoning.support);
    }
    // Ollama degraded paths: no-thinking, empty, missing, malformed, failure.
    installOllamaMock(["a", "b", "c", "d", "e"], {
      a: { capabilities: ["completion"] },
      b: { capabilities: [] },
      c: {},
      d: { capabilities: "thinking" },
      e: { kind: "throw" as const },
    });
    for (const m of await discoverModels({ type: "ollama", endpoint: "http://mock:11434" })) {
      if (m.capabilities) supports.push(m.capabilities.reasoning.support);
    }
    expect(supports.length).toBeGreaterThan(0);
    expect(supports.every((s) => s === "unknown")).toBe(true);
    expect(supports).not.toContain("unsupported");
  });
});
