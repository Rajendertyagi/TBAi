import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { generateText, streamText } from "ai";
import { getModel } from "./ai";
import type { ApiProtocol } from "../types";

// --- Mock fetch that records the request URL and returns a minimal OpenAI-
// shaped body. The AI SDK strictly validates response schemas, so generateText
// may throw on our fake body — but the request URL (which protocol was chosen)
// is captured BEFORE parsing, which is exactly what these tests assert. ---
let lastUrl: string | null = null;
let callCount = 0;

function chatCompletionBody(text: string): string {
  return JSON.stringify({
    id: "cmpl-1",
    object: "chat.completion",
    created: 0,
    model: "m",
    choices: [
      { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

function responsesBody(text: string): string {
  return JSON.stringify({
    id: "resp-1",
    object: "response",
    created_at: 0,
    model: "m",
    output: [
      {
        id: "msg-1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text }],
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  });
}

function sseStream(text: string): string {
  const chunks = text
    .split("")
    .map((ch) =>
      JSON.stringify({
        id: "c",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: ch }, finish_reason: null }],
      }),
    );
  return chunks.map((c) => `data: ${c}\n`).join("") + "data: [DONE]\n\n";
}

function installFetch() {
  lastUrl = null;
  callCount = 0;
  const orig = globalThis.fetch;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    lastUrl = url;
    callCount++;
    const body = init?.body ? JSON.parse(init.body as string) : {};
    const isResponses = url.includes("/responses");
    if (body.stream) {
      const payload = isResponses ? responsesBody("hi") : sseStream("hi");
      return new Response(payload, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response(isResponses ? responsesBody("hi") : chatCompletionBody("hi"), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return () => {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = orig;
  };
}

/** Run a model call; tolerate SDK schema errors on the fake body, return captured URL. */
async function capture(fn: () => Promise<unknown>): Promise<{ url: string | null; calls: number }> {
  try {
    await fn();
  } catch {
    /* expected: fake response bodies need not satisfy the SDK schema */
  }
  return { url: lastUrl, calls: callCount };
}

const openaiModel = (proto?: ApiProtocol) =>
  getModel({ type: "openai", model: "gpt-x", apiKey: "k", ...(proto ? { apiProtocol: proto } : {}) });

const customModel = (proto?: ApiProtocol) =>
  getModel({
    type: "custom",
    model: "agnes-2.5-flash",
    endpoint: "https://apihub.agnes-ai.com/v1",
    apiKey: "k",
    ...(proto ? { apiProtocol: proto } : {}),
  });

describe("ai model factory — apiProtocol resolution", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = installFetch();
  });
  afterEach(() => restore());

  it("native OpenAI explicit 'responses' → /responses", async () => {
    const { url } = await capture(() => generateText({ model: openaiModel("responses"), messages: [{ role: "user", content: "hi" }] }));
    expect(url).toContain("/responses");
    expect(url).not.toContain("/chat/completions");
  });

  it("native OpenAI defaults to 'responses'", async () => {
    const { url } = await capture(() => generateText({ model: openaiModel(), messages: [{ role: "user", content: "hi" }] }));
    expect(url).toContain("/responses");
  });

  it("custom explicit 'chat-completions' → /chat/completions", async () => {
    const { url } = await capture(() => generateText({ model: customModel("chat-completions"), messages: [{ role: "user", content: "hi" }] }));
    expect(url).toContain("/chat/completions");
    expect(url).not.toContain("/responses");
  });

  it("custom (Agnes) defaults to 'chat-completions'", async () => {
    const { url } = await capture(() => generateText({ model: customModel(), messages: [{ role: "user", content: "hi" }] }));
    expect(url).toContain("/chat/completions");
  });

  it("ollama defaults to 'chat-completions'", async () => {
    const { url } = await capture(() =>
      generateText({ model: getModel({ type: "ollama", model: "llama3", endpoint: "http://localhost:11434/v1" }), messages: [{ role: "user", content: "hi" }] }),
    );
    expect(url).toContain("/chat/completions");
  });

  it("custom provider is configurable to 'responses'", async () => {
    const { url } = await capture(() => generateText({ model: customModel("responses"), messages: [{ role: "user", content: "hi" }] }));
    expect(url).toContain("/responses");
  });

  it("chat-completions streaming issues a /chat/completions stream request", async () => {
    const model = getModel({
      type: "custom",
      model: "agnes-2.5-flash",
      endpoint: "https://apihub.agnes-ai.com/v1",
      apiProtocol: "chat-completions" as ApiProtocol,
      apiKey: "k",
    });
    const result = streamText({ model, messages: [{ role: "user", content: "hi" }] });
    try {
      for await (const _ of result.textStream) {
        /* drain */
      }
    } catch {
      /* tolerate fake SSE schema */
    }
    expect(lastUrl).toContain("/chat/completions");
    expect(callCount).toBe(1);
  });
});
