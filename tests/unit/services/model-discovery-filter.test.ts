import { describe, it, expect, afterEach } from "bun:test";
import { discoverModels } from "@/services/modelDiscovery.ts";

/**
 * Discovery filtering: provider model-list APIs are the authority on what
 * exists. TBAi accepts what they return unless the id identifies a non-chat
 * modality (embedding, image generation, audio/transcription, reranking,
 * moderation, legacy completion). Unfamiliar-but-valid chat families must
 * pass through — a family allowlist used to reject o1/o3, gemma, mixtral,
 * qwq, glm and kimi.
 */

const origFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Serves one listing payload for any /models-style endpoint. */
function installListingMock(payload: unknown): void {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : String(input);
    if (url.includes("/models") || url.includes("/api/tags")) return jsonResponse(payload);
    throw new Error(`unexpected fetch in listing mock: ${url}`);
  }) as typeof fetch;
}

/** Ollama mock: /api/tags lists the ids, /api/show answers per model. */
function installOllamaMock(tags: string[]): void {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : String(input);
    if (url.endsWith("/api/tags")) {
      return jsonResponse({ models: tags.map((name) => ({ name })) });
    }
    if (url.endsWith("/api/show")) {
      return jsonResponse({ capabilities: ["completion"] });
    }
    throw new Error(`unexpected fetch in ollama mock: ${url}`);
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = origFetch;
});

const openaiListing = (ids: string[]) => ({ data: ids.map((id) => ({ id })) });
const anthropicListing = (ids: string[]) => ({
  data: ids.map((id) => ({ id, display_name: id })),
});
const googleListing = (ids: string[]) => ({
  models: ids.map((id) => ({ name: `models/${id}` })),
});

async function openaiIds(ids: string[]): Promise<string[]> {
  installListingMock(openaiListing(ids));
  const models = await discoverModels({ type: "openai", endpoint: "http://mock/v1" });
  return models.map((m) => m.id);
}

describe("discovery filtering — unfamiliar valid chat models are accepted", () => {
  it("accepts OpenAI reasoning and unfamiliar families", async () => {
    const ids = await openaiIds([
      "o1",
      "o1-preview",
      "o3-mini",
      "o4-mini",
      "gpt-4o",
      "chatgpt-4o-latest",
    ]);
    expect(ids).toEqual(["o1", "o1-preview", "o3-mini", "o4-mini", "gpt-4o", "chatgpt-4o-latest"]);
  });

  it("accepts unfamiliar open-weight and regional families via a custom endpoint", async () => {
    installListingMock(
      openaiListing([
        "gemma-2-27b-it",
        "mixtral-8x7b-instruct",
        "qwq-32b",
        "glm-4-plus",
        "kimi-k2-0711-preview",
        "nova-pro",
        "command-a-03-2025",
      ]),
    );
    const models = await discoverModels({ type: "custom", endpoint: "http://mock/v1" });
    expect(models.map((m) => m.id)).toEqual([
      "gemma-2-27b-it",
      "mixtral-8x7b-instruct",
      "qwq-32b",
      "glm-4-plus",
      "kimi-k2-0711-preview",
      "nova-pro",
      "command-a-03-2025",
    ]);
  });

  it("accepts unfamiliar Anthropic and Google ids", async () => {
    installListingMock(anthropicListing(["claude-future-9", "claude-3-5-sonnet-20241022"]));
    const anthropic = await discoverModels({
      type: "anthropic",
      endpoint: "http://mock-anthropic",
      apiKey: "k",
    });
    expect(anthropic.map((m) => m.id)).toEqual(["claude-future-9", "claude-3-5-sonnet-20241022"]);

    installListingMock(
      googleListing(["gemini-2.5-pro", "gemma-2-27b-it", "learnlm-1.5-pro-experimental"]),
    );
    const google = await discoverModels({
      type: "google",
      endpoint: "http://mock-google",
      apiKey: "k",
    });
    expect(google.map((m) => m.id)).toEqual([
      "gemini-2.5-pro",
      "gemma-2-27b-it",
      "learnlm-1.5-pro-experimental",
    ]);
  });
});

describe("discovery filtering — known non-chat models are excluded", () => {
  it("excludes embedding, image, audio, transcription, reranking, moderation and legacy completion models", async () => {
    const ids = await openaiIds([
      "gpt-4o",
      "text-embedding-3-large",
      "text-embedding-ada-002",
      "dall-e-3",
      "whisper-1",
      "tts-1",
      "gpt-4o-transcribe",
      "gpt-4o-mini-transcribe",
      "omni-moderation-latest",
      "text-moderation-stable",
      "babbage-002",
      "davinci-002",
      "text-davinci-003",
      "gpt-4o-realtime-preview",
      "rerank-english-v3.0",
    ]);
    expect(ids).toEqual(["gpt-4o"]);
  });

  it("excludes Google non-chat models", async () => {
    installListingMock(
      googleListing([
        "gemini-2.5-pro",
        "embedding-001",
        "text-embedding-004",
        "gemini-embedding-exp-03-07",
        "imagen-3.0-generate-002",
        "veo-2.0-generate-001",
      ]),
    );
    const google = await discoverModels({
      type: "google",
      endpoint: "http://mock-google",
      apiKey: "k",
    });
    expect(google.map((m) => m.id)).toEqual(["gemini-2.5-pro"]);
  });

  it("excludes Ollama embedding models but keeps chat models", async () => {
    installOllamaMock(["llama3.2", "qwen2.5-coder", "nomic-embed-text", "mxbai-embed-large"]);
    const models = await discoverModels({ type: "ollama", endpoint: "http://mock:11434" });
    expect(models.map((m) => m.id)).toEqual(["llama3.2", "qwen2.5-coder"]);
  });
});
