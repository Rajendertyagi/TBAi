/**
 * The Direct error-publication OWNERSHIP contract.
 *
 * ## Why this test exists
 *
 * Provider-overflow recovery requires that a DISCARDED attempt publish nothing. Two
 * handlers in the Direct route can publish terminal state:
 *
 *   1. `streamText({ onError })`            — per attempt
 *   2. `createUIMessageStream({ onError })` — the composed logical stream
 *
 * Measured against the real route with an ordinary provider rejection (this file's
 * fixture), rather than assumed:
 *
 *   - (1) FIRES.
 *   - (2) DOES NOT FIRE.
 *
 * A provider `error` part is converted by `toUIMessageStream` into an `error` CHUNK and
 * the composed stream then ends normally — it never throws, so the composed `onError` is
 * never invoked. Ordinary provider errors therefore depend ENTIRELY on (1).
 *
 * ## The trap this guards
 *
 * The obvious redesign — make attempt `onError` capture-only and let the composed path
 * publish — would silently break EVERY ordinary provider error: no `ai.error`, no
 * `settleRun("failed")`, and a run left non-terminal. Nothing would throw; the failure
 * would be invisible.
 *
 * The correct model, established by the measurement above, is the reverse: attempt
 * `onError` captures only, and the RECOVERY GATE becomes the publisher for the
 * surviving attempt. Until that gate exists, (1) must keep publishing.
 *
 * If a future AI SDK change makes (2) fire for a forwarded provider error, this
 * contract changes and the recovery design gets simpler. That must be a deliberate
 * decision, so the structural assertion below is the thing that fails first.
 */

import { afterAll, afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Hono } from "hono";
import { db } from "../../src/db";
import { registry } from "../../src/config/providers";
import { conversationService } from "../../src/services/storage";
import chatApp from "../../src/routes/chat";

const app = new Hono();
app.route("/", chatApp);

const JSON_HEADERS = { "Content-Type": "application/json" };
const PROVIDER_ID = "prov-error-ownership";
const MODEL_ID = "ownership-model";

let upstreamCalls = 0;
let controlled: ReturnType<typeof Bun.serve> | null = null;

/**
 * An ORDINARY provider failure: HTTP 500 with no size wording.
 *
 * Deliberately NOT a context overflow, so it exercises the untouched error path — the
 * one recovery must not regress.
 */
function providerFailure(): Response {
  return new Response(
    JSON.stringify({ error: { message: "upstream backend unavailable", type: "server_error" } }),
    { status: 500, headers: { "Content-Type": "application/json" } },
  );
}

async function seed(): Promise<void> {
  upstreamCalls = 0;
  controlled = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      await req.json().catch(() => ({}));
      upstreamCalls += 1;
      return providerFailure();
    },
  });
  controlled.unref();
  db.run(
    `INSERT OR REPLACE INTO provider_configs
       (id, name, type, encrypted_api_key, credential_version, endpoint, model, models, thinking, api_protocol, is_active, created_at, updated_at)
     VALUES (?, 'error-ownership', 'ollama', NULL, NULL, ?, ?, '[]', 'off', 'chat-completions', 1, ?, ?)`,
    [PROVIDER_ID, `http://127.0.0.1:${controlled.port}/v1`, MODEL_ID, Date.now(), Date.now()],
  );
  await registry.loadFromDb(db);
}

/** Count SSE chunks of a given type. */
function countChunks(sseText: string, type: string): number {
  let n = 0;
  for (const line of sseText.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (payload === "[DONE]") continue;
    try {
      if (((JSON.parse(payload) as { type?: unknown }).type as string) === type) n += 1;
    } catch {
      /* keepalive */
    }
  }
  return n;
}

afterEach(() => {
  try {
    controlled?.stop(true);
  } catch {
    /* closed */
  }
  controlled = null;
});
afterAll(async () => {
  db.run("DELETE FROM provider_configs WHERE id = ?", [PROVIDER_ID]);
  await registry.loadFromDb(db);
});

describe("OWNERSHIP: an ordinary provider error is published exactly once", () => {
  it("surfaces exactly one error chunk, from one provider call, with no retry", async () => {
    await seed();
    const conv = await conversationService.create({
      title: "error-ownership",
      providerId: PROVIDER_ID,
      modelId: MODEL_ID,
      reasoningLevel: null,
      systemPrompt: null,
      engine: "direct",
    });

    try {
      const res = await app.request("/api/chat", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          providerId: PROVIDER_ID,
          model: MODEL_ID,
          id: conv.id,
          messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] }],
        }),
      });
      const body = await res.text();

      // Exactly one provider call: a non-overflow error must not trigger recovery.
      expect(upstreamCalls).toBe(1);
      // EXACTLY ONE error chunk. This is the load-bearing assertion: terminal
      // publication happens once, so the user sees one failure for one turn. A second
      // chunk would mean two publishers, which is the failure mode recovery must avoid.
      expect(countChunks(body, "error")).toBe(1);
      // The stream still terminates properly rather than hanging or truncating.
      expect(body).toContain("[DONE]");
    } finally {
      await conversationService.delete(conv.id);
    }
  }, 60000);
});

describe("OWNERSHIP: the structural precondition the redesign depends on", () => {
  const routeSource = (): string =>
    fs.readFileSync(path.resolve(import.meta.dir, "..", "..", "src", "routes", "chat.ts"), "utf8");

  it("the attempt-level onError currently publishes, and must keep doing so until the gate can", () => {
    // The attempt-level handler is the ONLY measured publisher. Recovery's redesign
    // makes it capture-only and moves publication into the gate. Until the gate is
    // wired, deleting `logAiError` from here would silently kill terminal logging for
    // every ordinary provider error — so its presence is asserted deliberately.
    const src = routeSource();
    const handler = src.slice(src.indexOf("onError: ({ error }) => {"));
    const body = handler.slice(0, handler.indexOf("},"));
    expect(body).toContain("logAiError(error)");
  });

  it("the composed onError still settles the run — the path recovery must not rely on", () => {
    // Present in source but NOT reached by a forwarded provider error (measured above).
    // If the SDK ever starts invoking it, this contract changes deliberately rather than
    // by accident, and the recovery design can be simplified.
    const src = routeSource();
    const composed = src.slice(src.indexOf("The composed stream reports error chunks"));
    expect(composed).toContain("settleRun(\"failed\")");
    expect(composed).toContain("logAiError(");
  });

  it("the recovery gate is present but NOT yet wired into the route", () => {
    // Guards against a half-wired lifecycle landing unnoticed: the gate must not be
    // referenced by the route until the capture/publish ownership model is in place.
    const src = routeSource();
    expect(src).not.toContain("withOverflowRecovery");
  });
});
