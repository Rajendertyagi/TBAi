import { createServer, type Server, type ServerResponse } from "node:http";
import type { APIRequestContext } from "@playwright/test";

/**
 * A real, controllable OpenAI-compatible provider for the E2E suite.
 *
 * Why this exists: specs that need a run to be genuinely IN FLIGHT used to fake
 * it by intercepting the /api/chat request in the browser and holding it. That
 * never worked, and the reason is instructive: with zero bytes delivered, the
 * assistant-ui thread-list item never enters its running state, so the sidebar's
 * live indicator has nothing to report. The test was asserting on a state its own
 * setup prevented — 6/6 deterministic failures that said nothing about the app.
 *
 * Holding the PROVIDER's stream instead is the honest simulation: the app makes a
 * real request over a real socket, receives real streaming frames, and is
 * genuinely mid-run. Nothing about the transport is faked, and no production code
 * changes to accommodate a test.
 *
 * The provider is registered through the app's own API, so it goes through the
 * same validation, credential handling and activation path a user's provider does.
 * The E2E database starts empty, so the first provider created is auto-activated.
 *
 * Built on Node's http module rather than a runtime-specific server: Playwright
 * executes specs in Node, so anything Bun-specific is simply undefined here.
 *
 * NOTE: no backticks in this comment. The Playwright/Bun transform used for spec
 * files mis-parses a backtick inside a block comment and reports the whole file as
 * unbuildable, with an error pointing at an unrelated line.
 */
export interface ControlledProvider {
  /** Registered provider id, for assertions. */
  readonly providerId: string;
  readonly model: string;
  /** How many completions requests have arrived. */
  readonly requestCount: number;
  /** Assistant text frames emitted, in order. */
  readonly frames: readonly string[];
  /** Let a held run finish normally (stop frame, then close). */
  complete(): void;
  /** Fail a held run with a provider error. */
  fail(detail: string): void;
  /** Tear the stub down. Safe to call more than once. */
  stop(): void;
}

const MODEL = "e2e-controlled-model";
const PROVIDER_NAME = "e2e-controlled-provider";

function chatChunk(delta: unknown, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-e2e-controlled",
    object: "chat.completion.chunk",
    created: 0,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

export async function startControlledProvider(
  request: APIRequestContext,
): Promise<ControlledProvider> {
  let requestCount = 0;
  const frames: string[] = [];
  /** Held responses, so complete()/fail() can release exactly one. */
  const held = new Set<{ res: ServerResponse; done: boolean }>();

  const server: Server = createServer((req, res) => {
    if (!req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end("not found");
      return;
    }
    requestCount += 1;
    req.resume();

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // First frame: the model has produced something. From here the client is
    // genuinely streaming, which is the state the sidebar indicator reports.
    res.write(chatChunk({ role: "assistant", content: "working" }));
    frames.push("working");

    const entry = { res, done: false };
    held.add(entry);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("controlled provider failed to bind a port");
  }
  const endpoint = `http://127.0.0.1:${address.port}/v1`;

  const created = await request.post("/api/providers", {
    data: {
      name: PROVIDER_NAME,
      type: "custom",
      endpoint,
      apiKey: "e2e-not-a-real-key",
      model: MODEL,
      apiProtocol: "chat-completions",
    },
  });
  if (!created.ok()) {
    server.close();
    throw new Error(`controlled provider registration failed: ${created.status()}`);
  }
  const body = (await created.json()) as { id: string };

  // Activate it explicitly. A provider created while others already exist is NOT
  // activated (only the first one is), so without this the composer would keep
  // using whatever provider was already active and this stub would never be
  // called — the test would then assert against a run it does not control.
  const activated = await request.post(`/api/providers/${body.id}/set-active`);
  if (!activated.ok()) {
    server.close();
    throw new Error(`controlled provider activation failed: ${activated.status()}`);
  }

  const finish = (mode: "complete" | "fail", detail?: string): void => {
    for (const entry of [...held]) {
      if (entry.done) continue;
      entry.done = true;
      held.delete(entry);
      if (mode === "fail") {
        entry.res.write(chatChunk({}, "stop"));
        entry.res.destroy(new Error(detail ?? "controlled provider failure"));
        continue;
      }
      entry.res.write(chatChunk({}, "stop"));
      entry.res.write("data: [DONE]\n\n");
      entry.res.end();
    }
  };

  return {
    providerId: body.id,
    model: MODEL,
    get requestCount() {
      return requestCount;
    },
    get frames() {
      return frames;
    },
    complete: () => finish("complete"),
    fail: (detail: string) => finish("fail", detail),
    stop: () => {
      finish("fail", "provider stopped");
      server.close();
    },
  };
}
