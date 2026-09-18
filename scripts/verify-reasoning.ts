/**
 * Reasoning verification harness — one command answers "is thinking working?"
 * for every configured provider.
 *
 * WHY THIS EXISTS
 * Every defect on the reasoning path fails SILENTLY: the request succeeds, the
 * model thinks, and the UI simply renders nothing. There is no error to read,
 * so a wrong provider option looks identical to a model that cannot reason. We
 * found four such defects one provider at a time, each with a throwaway script.
 * This replaces that loop.
 *
 * TWO MODES
 *   (default)  OFFLINE — exercises the real production path
 *              (`getModel` + `buildReasoningProviderOptions`), intercepts the
 *              outgoing request to show exactly what would be sent, and spends
 *              no API quota. Deterministic; safe to run any time.
 *   --live     Also makes one real call per provider and reports whether a
 *              reasoning part actually came back. Costs quota.
 *
 * USAGE
 *   bun run scripts/verify-reasoning.ts                  # all providers, offline
 *   bun run scripts/verify-reasoning.ts --live           # + real calls
 *   bun run scripts/verify-reasoning.ts --provider=<id>  # narrow to one
 *
 * Never prints keys or model output — option shapes and part types only.
 */
import { streamText } from "ai";
import { db } from "../src/db/index";
import { registry } from "../src/config/providers";
import { credentialStore } from "../src/services/credentials";
import { getModel } from "../src/services/ai";
import { buildReasoningProviderOptions } from "../src/routes/chat-provider-options";
import type { ProviderConfig } from "../src/types";

const argv = process.argv.slice(2);
const live = argv.includes("--live");
const only = argv.find((a) => a.startsWith("--provider="))?.split("=")[1];

/** A provider row plus the key, in the shape `getModel` consumes. */
type ProviderUnderTest = {
  config: ProviderConfig & { endpoint?: string; apiKey?: string };
  label: string;
};

/** Load every configured provider, or just the one named on the command line. */
function providersUnderTest(): ProviderUnderTest[] {
  registry.loadFromDb(db as never);
  credentialStore.initialize();
  return registry
    .list()
    .filter((p) => (only ? p.id === only || p.name === only : true))
    .map((p) => ({
      label: p.name,
      config: {
        ...p,
        endpoint: p.endpoint ?? undefined,
        apiKey: credentialStore.has(p.id) ? credentialStore.get(p.id) : undefined,
      },
    }));
}

/**
 * Intercept `globalThis.fetch` for the duration of `run`, capturing the JSON
 * body the provider sends. The AI SDK providers default to the global fetch, so
 * this observes the REAL request without changing production code. The canned
 * response is an empty event stream — parsing may fail, which is fine: the body
 * is captured before anything is parsed.
 */
async function captureRequestBody(run: () => PromiseLike<unknown>): Promise<unknown> {
  const original = globalThis.fetch;
  let captured: unknown = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (init?.body) {
      try {
        captured = JSON.parse(String(init.body));
      } catch {
        captured = String(init.body).slice(0, 200);
      }
    } else if (input instanceof Request) {
      try {
        captured = JSON.parse(await input.clone().text());
      } catch {
        /* non-JSON body: not a chat request we care about */
      }
    }
    // A WELL-FORMED terminating stream, so the SDK finishes cleanly instead of
    // throwing "ended without a finish reason" over the report we came for.
    const sse = url.includes("generativelanguage")
      ? `data: ${JSON.stringify({
          candidates: [{ content: { parts: [] }, finishReason: "STOP" }],
        })}\n\n`
      : `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: "stop" }],
        })}\n\ndata: [DONE]\n\n`;
    return new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  try {
    await run();
  } catch {
    /* capture already happened; a stream-level complaint is not our concern */
  } finally {
    globalThis.fetch = original;
  }
  return captured;
}

/** Where the reasoning control lands in each provider's request body. */
function findReasoningInBody(body: unknown): string {
  if (!body || typeof body !== "object") return "—";
  const b = body as Record<string, unknown>;
  const generationConfig = b.generationConfig as Record<string, unknown> | undefined;
  if (generationConfig?.thinkingConfig) {
    return `generationConfig.thinkingConfig=${JSON.stringify(generationConfig.thinkingConfig)}`;
  }
  const thinking = b.thinking as Record<string, unknown> | undefined;
  if (thinking) return `thinking=${JSON.stringify(thinking)}`;
  if (b.reasoning_effort) return `reasoning_effort=${String(b.reasoning_effort)}`;
  if (b.reasoning) return `reasoning=${JSON.stringify(b.reasoning)}`;
  return "none";
}

/**
 * The live probe prompt.
 *
 * Deliberately NOT a trivial question. Reasoning models skip thinking on easy
 * prompts, so "what is 17 * 23?" reports "no reasoning" even when the whole
 * chain works — a false negative that cost real time. This prompt needs
 * planning and comparison, which reliably elicits thinking.
 */
const PROBE_PROMPT =
  "Plan a two-day itinerary for a first-time visitor to Kyoto on a 20,000 yen " +
  "budget, then say which day costs more and why.";

/** One live call; returns the reasoning-delta count, or the failure reason. */
async function probeLive(model: ProviderConfig, providerOptions: unknown): Promise<string> {
  try {
    const result = streamText({
      model: getModel(model as never),
      messages: [{ role: "user", content: PROBE_PROMPT }],
      providerOptions: providerOptions as never,
    });
    const counts = new Map<string, number>();
    for await (const part of result.fullStream) {
      counts.set(part.type, (counts.get(part.type) ?? 0) + 1);
    }
    const deltas = counts.get("reasoning-delta") ?? 0;
    if (deltas > 0) return `REASONING (${deltas} deltas)`;
    return "no reasoning part";
  } catch (err) {
    return `FAILED: ${err instanceof Error ? err.message.slice(0, 90) : String(err)}`;
  }
}

/**
 * The option shape for every provider type × model generation, with no provider
 * configured and no API call.
 *
 * This is the part that covers providers we cannot call — Anthropic and native
 * OpenAI have no key here — so a regression in their option shape is caught by
 * running the harness, not by waiting until someone configures a key.
 */
function printOptionMatrix(): void {
  const cases: Array<{
    type: ProviderConfig["type"];
    apiProtocol?: ProviderConfig["apiProtocol"];
    model: string;
    level: string;
    why: string;
  }> = [
    { type: "google", model: "gemini-3.1-flash-lite", level: "low", why: "Gemini 3 → thinkingLevel" },
    { type: "google", model: "gemini-2.5-flash", level: "low", why: "Gemini 2.5 → thinkingBudget" },
    { type: "google", model: "gemini-2.5-flash-lite", level: "low", why: "2.5 lite rejects a budget" },
    { type: "google", model: "gemini-3.1-flash-lite", level: "off", why: "off → no options at all" },
    { type: "anthropic", model: "claude-sonnet-4-5", level: "low", why: "extended thinking" },
    { type: "openai", model: "gpt-5", level: "low", why: "Responses API namespace" },
    { type: "custom", apiProtocol: "chat-completions", model: "agnes-2.0-flash", level: "low", why: "gateway namespace" },
    { type: "ollama", apiProtocol: "chat-completions", model: "llama3", level: "low", why: "effort not applicable" },
  ];
  console.log("\n=== option matrix (offline, no provider or key needed) ===");
  for (const c of cases) {
    const options = buildReasoningProviderOptions(
      { type: c.type, apiProtocol: c.apiProtocol },
      c.model,
      c.level,
    );
    const built = JSON.stringify(options);
    console.log(
      `  ${c.type.padEnd(9)} ${c.model.padEnd(22)} ${c.level.padEnd(4)} -> ${built === "{}" ? "(none)" : built}  [${c.why}]`,
    );
  }
}

async function main(): Promise<void> {
  printOptionMatrix();

  const providers = providersUnderTest();
  if (providers.length === 0) {
    console.log("No providers configured.");
    return;
  }

  console.log(
    live
      ? "=== reasoning harness (offline shapes + LIVE calls) ==="
      : "=== reasoning harness (offline: shapes + outgoing request only) ===",
  );

  for (const { config, label } of providers) {
    const level = config.thinking ?? "off";
    const providerOptions = buildReasoningProviderOptions(
      { type: config.type, apiProtocol: config.apiProtocol },
      config.model,
      level,
    );

    const body = await captureRequestBody(() =>
      streamText({
        model: getModel(config as never),
        messages: [{ role: "user", content: "hi" }],
        providerOptions: providerOptions as never,
      }).consumeStream(),
    );

    console.log(`\n${label} (${config.type}) — model ${config.model}`);
    console.log(`  level            : ${level}`);
    console.log(`  options built    : ${JSON.stringify(providerOptions)}`);
    console.log(`  request carries  : ${findReasoningInBody(body)}`);
    if (level === "off") {
      console.log(`  NOTE             : level is "off" — no reasoning will ever appear`);
    }
    if (live) {
      console.log(`  live             : ${await probeLive(config, providerOptions)}`);
    }
  }

  if (!live) {
    console.log("\n(run with --live to make real calls and confirm reasoning parts arrive)");
  }
}

await main();
