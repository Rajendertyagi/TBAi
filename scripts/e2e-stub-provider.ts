/**
 * Baseline Direct provider for the hermetic E2E suite.
 *
 * Why this exists: the suite now runs against its own empty database, so nothing
 * has a model to talk to. Specs that only need a model to EXIST (the picker, the
 * composer mechanics, a send that is expected to fail) failed with "no providers",
 * which says nothing about the code under test. Previously they silently borrowed
 * the maintainer's real credentials, which is the coupling isolation removed.
 *
 * So the suite seeds its own: a provider pointing at a local stub that speaks the
 * OpenAI chat-completions stream. No credentials, no network, no quota, and a send
 * that completes deterministically.
 *
 * Specs that need a genuinely capable model are the `*-live` ones, which stay
 * opt-in and run against a real server.
 */
/**
 * The writer a held response exposes. Deliberately NOT a `Response`: holding a
 * stream means holding its `ReadableStreamDefaultController`, and casting a
 * controller to `Response` to borrow `write`/`close` is a lie the type checker
 * is right to reject.
 */
interface HeldWriter {
  write(bytes: Uint8Array): void;
  close(): void;
}

type HeldResponse = { res: HeldWriter; done: boolean };

export interface StubProvider {
  readonly endpoint: string;
  readonly providerId: string;
  readonly model: string;
  /** Canned assistant text, streamed as a single delta. */
  text: string;
  /** Hold the next response open until released, to simulate a slow model. */
  hold: boolean;
  release(): void;
  requestCount(): number;
  stop(): void;
}

/**
 * Named so the fixture cannot collide with a spec's own selectors: the provider
 * button's accessible name is "<provider> · <model>", and a spec querying
 * getByRole("button", { name: "Model" }) without `exact` matches any name
 * CONTAINING "model". A fixture called "e2e-stub-model" therefore made an
 * unrelated strict-mode assertion fail.
 */
const MODEL = "e2e-stub-1";
const PROVIDER_NAME = "e2e stub";

function chunk(delta: unknown, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-e2e-stub",
    object: "chat.completion.chunk",
    created: 0,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

export function startStubProvider(port: number): StubProvider {
  let requests = 0;
  let text = "ok";
  let hold = false;
  const held = new Set<HeldResponse>();
  const encoder = new TextEncoder();

  const finish = (entry: HeldResponse): void => {
    entry.done = true;
    held.delete(entry);
    entry.res.write(encoder.encode(chunk({ content: text })));
    entry.res.write(encoder.encode(chunk({}, "stop")));
    entry.res.write(encoder.encode("data: [DONE]\n\n"));
    entry.res.close();
  };

  const release = (): void => {
    for (const entry of [...held]) {
      if (!entry.done) finish(entry);
    }
  };

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);

      // Control plane for specs. The stub is shared by the whole suite, so
      // holding a stream open is a property of the stub rather than something
      // each spec re-creates with its own provider.
      if (url.pathname === "/__e2e/hold") {
        hold = true;
        return new Response("holding");
      }
      if (url.pathname === "/__e2e/release") {
        hold = false;
        release();
        return new Response("released");
      }
      if (url.pathname === "/__e2e/state") {
        return Response.json({ requests, hold, text, held: held.size });
      }
      if (url.pathname === "/__e2e/text" && req.method === "POST") {
        try {
          const body = (await req.json()) as { text?: string };
          if (typeof body.text === "string") text = body.text;
        } catch {
          /* keep the previous text on a malformed request */
        }
        return new Response("ok");
      }

      if (!url.pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }
      requests += 1;
      await req.text();

      // `hold` is CONSUMED by the request that observes it, so it can never leak
      // into a later spec. The stub is shared by the whole suite and outlives any
      // single spec; a sticky flag meant one spec that forgot to release would
      // hang every subsequent send, and the failures looked like product bugs in
      // unrelated specs. One request, one hold, by construction.
      const holdThisRequest = hold;
      hold = false;

      // Any straggler from an abandoned hold is released rather than left hanging.
      release();

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          if (holdThisRequest) {
            const writer: HeldWriter = {
              write: (bytes: Uint8Array) => controller.enqueue(bytes),
              close: () => controller.close(),
            };
            held.add({ done: false, res: writer });
            return;
          }
          controller.enqueue(encoder.encode(chunk({ role: "assistant", content: text })));
          controller.enqueue(encoder.encode(chunk({}, "stop")));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });

      return new Response(stream, {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });

  return {
    endpoint: `http://127.0.0.1:${port}/v1`,
    providerId: "",
    model: MODEL,
    get text() {
      return text;
    },
    set text(next: string) {
      text = next;
    },
    get hold() {
      return hold;
    },
    set hold(next: boolean) {
      hold = next;
    },
    release,
    requestCount: () => requests,
    stop: () => {
      for (const entry of [...held]) {
        entry.done = true;
        held.delete(entry);
      }
      server.stop(true);
    },
  };
}

/** Register the stub as a provider and make it the active one. */
export async function seedStubProvider(
  apiBaseUrl: string,
  stub: StubProvider,
): Promise<string> {
  const response = await fetch(`${apiBaseUrl}/api/providers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: PROVIDER_NAME,
      type: "custom",
      endpoint: stub.endpoint,
      apiKey: "e2e-stub-key",
      model: MODEL,
      apiProtocol: "chat-completions",
    }),
  });
  if (!response.ok) {
    throw new Error(`stub provider registration failed: ${response.status}`);
  }
  const body = (await response.json()) as { id: string };
  const activated = await fetch(`${apiBaseUrl}/api/providers/${body.id}/set-active`, {
    method: "POST",
  });
  if (!activated.ok) {
    throw new Error(`stub provider activation failed: ${activated.status}`);
  }
  return body.id;
}
