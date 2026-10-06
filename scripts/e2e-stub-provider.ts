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
  /**
   * Split the reply into deltas of roughly this many characters.
   *
   * Why this exists: the default is 0, meaning ONE delta, which is what every
   * existing spec assumes. It is also useless for profiling, because a single
   * delta delivers a finished message in one shot - the browser never renders
   * a partially-arrived reply, so the per-token re-render cost that streaming
   * actually imposes is invisible. Profiling the streaming path requires
   * deltas that arrive one at a time.
   */
  chunkChars: number;
  /** Pause between deltas, in ms. 0 emits back-to-back. */
  chunkDelayMs: number;
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

/**
 * Split reply text into the deltas the stub will stream.
 *
 * With `size <= 0` this returns the whole text as ONE piece, which is the
 * historical behaviour every other spec depends on: a single delta means the
 * client receives a complete message at once and never renders a partial
 * reply. Changing that default would silently alter what unrelated specs
 * exercise, so the chunked path is strictly opt-in.
 *
 * With a positive `size` the text is cut into pieces of about that many
 * characters. Boundaries snap to whitespace so each delta looks like a
 * plausible token rather than a mid-word slice - a mid-word cut would make the
 * markdown parser see different intermediate states than a real provider
 * produces, and this harness is meant to model a real stream.
 */
export function splitIntoDeltas(text: string, size: number): string[] {
  if (size <= 0) return [text];
  if (text.length <= size) return [text];

  const pieces: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    let end = Math.min(cursor + size, text.length);
    if (end < text.length) {
      // Snap forward to the next space so no delta ends mid-word, but never
      // past the end and never so far that this piece is the whole tail.
      const space = text.indexOf(" ", end);
      if (space !== -1 && space - cursor < size * 2) end = space + 1;
    }
    pieces.push(text.slice(cursor, end));
    cursor = end;
  }
  return pieces;
}

export function startStubProvider(port: number): StubProvider {
  let requests = 0;
  let text = "ok";
  let hold = false;
  let chunkChars = 0;
  let chunkDelayMs = 0;
  const held = new Set<HeldResponse>();
  const encoder = new TextEncoder();

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  const finish = (entry: HeldResponse): void => {
    entry.done = true;
    held.delete(entry);
    for (const piece of splitIntoDeltas(text, chunkChars)) {
      entry.res.write(encoder.encode(chunk({ content: piece })));
    }
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
        return Response.json({
          requests,
          hold,
          text,
          held: held.size,
          chunkChars,
          chunkDelayMs,
        });
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
      // Streaming shape, for specs that must observe a reply ARRIVING rather
      // than a reply that is already complete when the response opens.
      if (url.pathname === "/__e2e/stream" && req.method === "POST") {
        try {
          const body = (await req.json()) as {
            text?: string;
            chunkChars?: number;
            chunkDelayMs?: number;
          };
          if (typeof body.text === "string") text = body.text;
          if (typeof body.chunkChars === "number") chunkChars = body.chunkChars;
          if (typeof body.chunkDelayMs === "number") chunkDelayMs = body.chunkDelayMs;
        } catch {
          /* keep the previous settings on a malformed request */
        }
        return Response.json({ ok: true, chunkChars, chunkDelayMs });
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

      // Captured per request for the same reason: a spec that reconfigures the
      // stub must not mutate the shape of a stream that is already in flight.
      const thisChunkChars = chunkChars;
      const thisChunkDelayMs = chunkDelayMs;

      // Any straggler from an abandoned hold is released rather than left hanging.
      release();

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          if (holdThisRequest) {
            const writer: HeldWriter = {
              write: (bytes: Uint8Array) => controller.enqueue(bytes),
              close: () => controller.close(),
            };
            held.add({ done: false, res: writer });
            return;
          }

          const pieces = splitIntoDeltas(text, thisChunkChars);
          try {
            // The role marker stays on the first piece, matching the OpenAI
            // chat-completions shape the real provider sends, so the client's
            // stream parser sees the same sequence of chunks it sees in
            // production rather than a shape only the stub produces.
            controller.enqueue(
              encoder.encode(
                chunk({
                  role: "assistant",
                  content: thisChunkChars > 0 ? pieces[0] : text,
                }),
              ),
            );
            for (let i = thisChunkChars > 0 ? 1 : 0; i < pieces.length; i++) {
              if (thisChunkDelayMs > 0) await sleep(thisChunkDelayMs);
              controller.enqueue(encoder.encode(chunk({ content: pieces[i] })));
            }
            controller.enqueue(encoder.encode(chunk({}, "stop")));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          } catch {
            // A client that navigates away mid-stream aborts the connection.
            // Closing is the correct terminal state and must not surface as an
            // unhandled rejection that takes down the shared stub.
            try {
              controller.close();
            } catch {
              /* already closed or errored */
            }
          }
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
    get chunkChars() {
      return chunkChars;
    },
    set chunkChars(next: number) {
      chunkChars = next;
    },
    get chunkDelayMs() {
      return chunkDelayMs;
    },
    set chunkDelayMs(next: number) {
      chunkDelayMs = next;
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
