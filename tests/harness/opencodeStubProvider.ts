/**
 * A real OpenAI-compatible streaming endpoint, for OpenCode runtime tests.
 *
 * ## Why this exists
 *
 * Proving anything about OpenCode's context handling needs a model that will
 * actually answer. Every real provider is a poor substitute: it costs money,
 * needs a key, has its own quota and routing rules, and - the real problem -
 * cannot be told to hold a small context window. OpenCode decides when to
 * compact against the model's declared limit, so without a model that reports a
 * small one, automatic compaction is unreachable in a test.
 *
 * ## What this is NOT
 *
 * It is not a fake TBAi. Nothing here reimplements TBAi's production path: a
 * test still spawns the real `opencode serve`, still authenticates to it, still
 * creates a session through it, and still consumes its event stream. Only the
 * upstream model is replaced, which is the one substitution that cannot
 * invalidate a conclusion about OpenCode's behaviour.
 *
 * ## Token counts are measured, never invented
 *
 * `usage` is computed by running a real BPE encoder (`gpt-tokenizer`) over the
 * prompt this server actually received. That matters more than it looks: the
 * context-occupancy proofs compare a numerator derived from provider-reported
 * tokens against the conversation that produced them. A hardcoded or estimated
 * number would let those proofs pass no matter what OpenCode did. Because the
 * count comes from the real request, a longer conversation genuinely reports a
 * larger prompt, so OpenCode's own accumulation - and its decision to compact -
 * is exercised rather than bypassed.
 *
 * This module stays model-agnostic on purpose: it knows how to stream a reply,
 * emit a tool call, and summarise. It contains no compaction policy.
 */

import { encode } from "gpt-tokenizer";

/** One tool call OpenCode asked for, as it arrived. */
export interface StubToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

/** One tool the caller offered, as it arrived. */
export interface StubTool {
  readonly type?: string;
  readonly function?: { readonly name?: string };
}

/** One recorded `/v1/chat/completions` request. */
export interface StubRequest {
  /** Monotonic per-stub counter, so ordering is assertable. */
  readonly sequence: number;
  readonly model: string;
  readonly messages: ReadonlyArray<Record<string, unknown>>;
  /** Tools offered with this request; empty when the caller offered none. */
  readonly tools: readonly StubTool[];
  /** True when the request carried at least one tool result. */
  readonly carriesToolResult: boolean;
  /** True when OpenCode offered at least one tool schema. */
  readonly offersTools: boolean;
  /** BPE token count of the whole serialised message list. */
  readonly promptTokens: number;
}

/** What the stub should do with a request. */
export type StubBehaviour = "text" | "tool-call" | "summary";

export interface StubProviderOptions {
  /** Model id the stub answers as. Must match the config's `modelID`. */
  readonly model?: string;
  /**
   * Chooses the reply. The default streams plain text and answers OpenCode's
   * summarisation request with a template-compliant summary; a test passes its
   * own to drive a tool call.
   *
   * A custom `respond` OWNS every request, including the summarisation one. When
   * overriding it, return {@link summariseStubRequest}'s verdict for compaction
   * requests or compaction will fail with `Compaction produced no summary` -
   * which is OpenCode correctly rejecting a reply that carried no summary.
   */
  readonly respond?: (request: StubRequest) => StubBehaviour | Promise<StubBehaviour>;
  /** Text used for the first plain-text reply. */
  readonly text?: string;
}

/**
 * How the stub would classify a request on its own.
 *
 * Exported so a test overriding `respond` can defer for compaction requests
 * instead of accidentally answering them as ordinary turns.
 */
export function summariseStubRequest(request: StubRequest): StubBehaviour {
  return looksLikeSummaryRequest(request.messages) ? "summary" : "text";
}

export interface StubProvider {
  /** Base URL to put in `providers.<id>.settings.baseURL`. */
  readonly baseURL: string;
  /** The model id the stub answers as. */
  readonly model: string;
  /** Every request received, in order. */
  readonly requests: readonly StubRequest[];
  /**
   * Requests that carried a non-empty `tools` array.
   *
   * Named for what it filters, which the previous name did not: it was
   * `toolCallRequests` documented as "requests whose reply was a tool call"
   * while actually filtering on whether the CALLER offered tools. Nothing
   * consumed it, so the mismatch was invisible, and it was exactly the filter a
   * test needs to prove OpenCode offered tool schemas to the provider.
   */
  readonly requestsOfferingTools: readonly StubRequest[];
  /** Requests that carried at least one tool result. */
  readonly toolResultRequests: readonly StubRequest[];
  /** Stop the server. Safe to call more than once. */
  stop(): void;
}

const DEFAULT_MODEL = "tbai-stub-model";
const DEFAULT_TEXT = "OK";

/**
 * The section headings OpenCode's summarisation prompt requires.
 *
 * Captured from a live request: OpenCode asks for "the exact section headings
 * from the template" and, when the reply does not carry them, rejects the
 * compaction with `Compaction produced no summary`. A stub that paraphrases the
 * headings therefore makes compaction fail for a reason that has nothing to do
 * with what is being tested. Read off the wire rather than guessed.
 */
const SUMMARY_SECTIONS = [
  "## Objective",
  "## Requirements",
  "## Decisions",
  "## Work State",
  "## Next Move",
  "## Relevant Files",
  "## Important Context",
] as const;

/** A summary that satisfies OpenCode's template, whatever the conversation was. */
function buildSummaryReply(): string {
  return SUMMARY_SECTIONS.map((heading, index) => {
    if (index === 0) return `${heading}\nStub conversation.`;
    if (heading === "## Work State") return `${heading}\n### Completed\n- Stub turn.\n\n### Active\n- (none)\n\n### Blocked\n- (none)`;
    if (heading === "## Next Move") return `${heading}\n1. Continue the stub run.`;
    return `${heading}\n- (none)`;
  }).join("\n\n");
}

/**
 * Recognises OpenCode's compaction summary request.
 *
 * Compaction uses the session's own model and asks for a structured summary, so
 * the stub must answer it or compaction cannot settle. Detected from the request
 * rather than from a flag, because the request is the only honest signal.
 */
function looksLikeSummaryRequest(messages: ReadonlyArray<Record<string, unknown>>): boolean {
  return messages.some((message) => {
    const content = typeof message.content === "string" ? message.content : "";
    return /summarize the conversation above into a structured summary/i.test(content);
  });
}

/** BPE count of the prompt as sent. Never estimated. */
function countPromptTokens(messages: ReadonlyArray<Record<string, unknown>>): number {
  // Serialising the real request body is what makes the count a property of the
  // prompt OpenCode actually sent, including tool schemas and role framing.
  return encode(JSON.stringify(messages)).length;
}

function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

const DONE_FRAME = "data: [DONE]\n\n";

/** One streamed assistant chunk. */
function textChunk(model: string, content: string): string {
  return sseFrame({
    id: "chatcmpl-tbai-stub",
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  });
}

/** One streamed tool-call delta, in the shape OpenAI's API uses. */
function toolCallChunk(
  model: string,
  id: string,
  name: string,
  args: string,
): string {
  return sseFrame({
    id: "chatcmpl-tbai-stub",
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id,
              type: "function",
              function: { name, arguments: args },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  });
}

function finishChunk(model: string, finishReason: string): string {
  return sseFrame({
    id: "chatcmpl-tbai-stub",
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  });
}

/** The `usage` block, carrying the measured prompt count and this reply's output. */
function usageBlock(promptTokens: number, completionTokens: number): Record<string, number> {
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

/**
 * Starts the stub on an ephemeral loopback port.
 *
 * @param options Model id and reply strategy; see {@link StubProviderOptions}.
 * @returns A handle exposing the base URL and every recorded request.
 * @throws Error when the server cannot bind.
 */
export async function startStubProvider(
  options: StubProviderOptions = {},
): Promise<StubProvider> {
  const model = options.model ?? DEFAULT_MODEL;
  const requests: StubRequest[] = [];
  let sequence = 0;

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      // OpenCode's compatible runtime also probes the model list before use.
      if (url.pathname === "/v1/models") {
        return Response.json({ object: "list", data: [{ id: model, object: "model" }] });
      }
      if (!url.pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }

      const body = (await request.json().catch(() => ({}))) as {
        model?: string;
        messages?: Array<Record<string, unknown>>;
        tools?: unknown[];
      };
      const messages = body.messages ?? [];
      const tools = Array.isArray(body.tools) ? (body.tools as StubTool[]) : [];
      const promptTokens = countPromptTokens(messages);
      const carriesToolResult = messages.some((message) => message.role === "tool");
      const record: StubRequest = {
        sequence: (sequence += 1),
        model: body.model ?? model,
        messages,
        tools,
        carriesToolResult,
        offersTools: tools.length > 0,
        promptTokens,
      };
      requests.push(record);

      const behaviour =
        (await options.respond?.(record)) ??
        (looksLikeSummaryRequest(messages) ? "summary" : "text");

      const reply =
        behaviour === "summary"
          ? buildSummaryReply()
          : (options.text ?? DEFAULT_TEXT);
      const completionTokens = encode(reply).length;

      const frames: string[] = [];
      if (behaviour === "tool-call") {
        const call: StubToolCall = {
          id: `call_${record.sequence}`,
          name: "read",
          arguments: { filePath: "README.md" },
        };
        frames.push(toolCallChunk(model, call.id, call.name, JSON.stringify(call.arguments)));
        frames.push(finishChunk(model, "tool_calls"));
      } else {
        frames.push(textChunk(model, reply));
        frames.push(finishChunk(model, "stop"));
      }
      frames.push(
        sseFrame({
          id: "chatcmpl-tbai-stub",
          object: "chat.completion.chunk",
          created: 0,
          model,
          choices: [],
          usage: usageBlock(promptTokens, completionTokens),
        }),
      );
      frames.push(DONE_FRAME);

      return new Response(frames.join(""), {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    },
  });

  let stopped = false;
  return {
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    model,
    requests,
    get requestsOfferingTools() {
      return requests.filter((request) => request.offersTools);
    },
    get toolResultRequests() {
      return requests.filter((request) => request.carriesToolResult);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      server.stop(true);
    },
  };
}
