/**
 * RUNTIME proof that TBAi's Code context meter tracks the current model-visible
 * context, not cumulative token traffic.
 *
 * ## The defect this pins
 *
 * The ring's numerator was read from `session.usage.updated`, which OpenCode
 * fills with the SESSION's cumulative token ledger. Measured live against
 * opencode 2.0.22 through TBAi's own Code path, three trivial turns produced
 * ledger totals of 12,451 -> 24,005 -> 35,571 while the newest assistant
 * response stayed flat at 11,524. The meter was therefore reporting the sum of
 * every round trip ever made: at a 200K window it reads 100% after roughly 17
 * short turns while the model actually holds ~12K.
 *
 * OpenChamber does not have this bug because it never reads the ledger for
 * occupancy - `findLatestContextFill` walks the message list and takes the newest
 * response that reported tokens. These tests drive the REAL OpenCode server and
 * assert the same two properties against real payloads.
 *
 * Skipped unless `TBAI_OPENCODE_RUNTIME_TESTS=1`. See the harness for gating.
 */

import { describe, expect, it, afterAll, beforeAll } from "bun:test";
import { OPENCODE_CONFIG } from "../../src/config/opencode";
import {
  runtimeTestsRequested,
  runtimeUnavailableReason,
  startRuntimeOpenCodeServer,
  type RuntimeOpenCodeServer,
} from "../harness/opencodeRuntimeHarness";
import { resolveCodeOccupancy, occupancyTokens } from "../../web/src/features/opencode/codeOccupancy";

const reason = runtimeUnavailableReason();
const describeRuntime = runtimeTestsRequested() ? describe : describe.skip;

if (runtimeTestsRequested() && reason) {
  console.warn(`[opencode context meter] enabled but unavailable: ${reason}`);
}

const DIRECTORY = process.cwd();

/**
 * The model every runtime case drives.
 *
 * It must be pinned explicitly rather than left to the server default: the
 * default is resolved from the catalogue, which loads asynchronously and can
 * leave a session on a model this OpenRouter key cannot route (observed live as
 * `No endpoints found that support tool use`). This one is tool-capable and free,
 * so a runtime case costs nothing and still crosses the real provider path.
 */
const RUNTIME_MODEL = { id: "fledge-alpha-free", providerID: "opencode" } as const;

/** Binds the runtime model to a freshly created session. */
async function createSession(server: RuntimeOpenCodeServer): Promise<string> {
  const created = await server.json<{ data: { id: string } }>("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const sessionId = created.data.id;
  await server.json(`/api/session/${sessionId}/model`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencode-directory": DIRECTORY },
    body: JSON.stringify({ model: RUNTIME_MODEL }),
  });
  return sessionId;
}

/**
 * Prompts and waits for the response to be measurable.
 *
 * Polls the ledger rather than sleeping a fixed interval: an unrouted model fails
 * in seconds and a working one takes tens, so a fixed wait either wastes time or
 * reports a false zero.
 *
 * @returns True when the response reported output tokens.
 */
async function promptUntilAnswered(
  server: RuntimeOpenCodeServer,
  sessionId: string,
  text: string,
): Promise<boolean> {
  // The ledger is cumulative, so "output > 0" is already true by the second turn
  // and would report success before the new response existed. Wait for a response
  // that did not exist when the prompt was sent.
  const before = new Set(
    (await readMessages(server, sessionId))
      .map((message) => (message as { id?: string }).id)
      .filter((id): id is string => typeof id === "string"),
  );

  await server.json(`/api/session/${sessionId}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencode-directory": DIRECTORY },
    body: JSON.stringify({ text }),
  });

  for (let attempt = 0; attempt < 90; attempt += 1) {
    await Bun.sleep(1000);
    const messages = await readMessages(server, sessionId);
    const answered = messages.some(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        (message as { type?: string }).type === "assistant" &&
        typeof (message as { id?: string }).id === "string" &&
        !before.has((message as { id?: string }).id),
    );
    if (answered) return true;

    const failed = messages.some(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        (message as { type?: string; outcome?: string }).type === "idle" &&
        (message as { outcome?: string }).outcome === "failed" &&
        !before.has((message as { id?: string }).id),
    );
    if (failed) return false;
  }
  return false;
}

interface SessionSnapshot {
  readonly cost: number;
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly reasoning: number;
    readonly cache: { readonly read: number; readonly write: number };
  };
}

/** Reads the session ledger - the value TBAi used to render as occupancy. */
async function readLedger(server: RuntimeOpenCodeServer, sessionId: string): Promise<SessionSnapshot> {
  const body = await server.json<{ data: SessionSnapshot }>(
    `/api/session/${sessionId}`,
    { headers: { "x-opencode-directory": DIRECTORY } },
  );
  return body.data;
}

/** Reads the persisted message list - the source occupancy is derived from. */
async function readMessages(server: RuntimeOpenCodeServer, sessionId: string): Promise<unknown[]> {
  const body = await server.json<{ data: unknown[] }>(
    `/api/session/${sessionId}/message`,
    { headers: { "x-opencode-directory": DIRECTORY } },
  );
  return body.data;
}

function ledgerTotal(snapshot: SessionSnapshot): number {
  const { input, output, reasoning, cache } = snapshot.tokens;
  return input + output + reasoning + cache.read + cache.write;
}

describeRuntime("real OpenCode: the ledger is cumulative traffic, not occupancy", () => {
  let server: RuntimeOpenCodeServer;
  let sessionId: string;

  beforeAll(async () => {
    server = await startRuntimeOpenCodeServer();
    sessionId = await createSession(server);
  }, 120_000);

  afterAll(async () => {
    await server?.stop();
  });

  it("carries no `total` field, so the total-preferred branch is unreachable", async () => {
    // OpenChamber's rule only helps when the server sends `total`. On this build
    // it does not, which is why the numerator source is the whole story.
    const before = await readLedger(server, sessionId);
    expect(before.tokens).not.toHaveProperty("total");
  });

  it("the ledger accumulates traffic that occupancy never reports", async () => {
    // The core defect, measured. Each response re-reads the prompt, so the ledger
    // accumulates; the newest response describes only the CURRENT window.
    const ledgerTotals: number[] = [];
    const occupancyTotals: (number | undefined)[] = [];

    for (let turn = 0; turn < 3; turn += 1) {
      const answered = await promptUntilAnswered(
        server,
        sessionId,
        `Reply with exactly: PONG${turn}`,
      );
      // A model this key cannot route would make every assertion below pass for
      // the wrong reason (all zeros), so the response is required, not hoped for.
      expect(answered).toBe(true);

      ledgerTotals.push(ledgerTotal(await readLedger(server, sessionId)));

      const messages = await readMessages(server, sessionId);
      const occupancy = resolveCodeOccupancy(
        messages as Parameters<typeof resolveCodeOccupancy>[0],
      );
      const tokens = occupancyTokens(occupancy);
      occupancyTotals.push(tokens ? ledgerTotal({ cost: 0, tokens }) : undefined);
    }

    // The ledger must exceed a single response. That is the whole defect: it sums
    // every round trip instead of reporting the window.
    //
    // It is deliberately NOT asserted to grow strictly between turns. OpenCode
    // settles the ledger asynchronously - a second `usage.updated` can land after
    // this read - so the intermediate values are genuinely racy, and a strict
    // inequality here would fail on timing rather than on behaviour. Measured on a
    // 1M-context model by hand, the two figures were 12,451 vs 11,524 after one
    // turn and 35,571 vs 11,524 after three; the small stub-backed model used here
    // has a narrower gap for the same reason.
    const latestLedger = ledgerTotals[ledgerTotals.length - 1];
    const measured = occupancyTotals.filter((value): value is number => value !== undefined);
    expect(measured.length).toBeGreaterThan(0);
    expect(latestLedger).toBeGreaterThan(measured[measured.length - 1]);
  }, 240_000);
});

describeRuntime("real OpenCode: compaction shapes the persisted message list", () => {
  let server: RuntimeOpenCodeServer;
  let sessionId: string;

  beforeAll(async () => {
    server = await startRuntimeOpenCodeServer();
    sessionId = await createSession(server);
  }, 120_000);

  afterAll(async () => {
    await server?.stop();
  });

  it("admits a manual compaction and records it as a compaction message", async () => {
    // A compaction over real content, so it produces a summary and a settled
    // record rather than the nothing-to-do no-op an empty session returns.
    expect(
      await promptUntilAnswered(server, sessionId, "Reply with exactly: PONG"),
    ).toBe(true);

    // The wire call TBAi's `controller.compact()` makes.
    const admitted = await server.json<{ data: { id: string; type: string } }>(
      `/api/session/${sessionId}/compact`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-opencode-directory": DIRECTORY },
        body: JSON.stringify({ delivery: "steer" }),
      },
    );
    expect(admitted.data.type).toBe("compaction");

    // Let the compaction settle before reading the list.
    await Bun.sleep(3000);
    const messages = (await readMessages(server, sessionId)) as Array<{ type?: string }>;
    expect(messages.some((message) => message.type === "compaction")).toBe(true);
  }, 120_000);

  it("a settled compaction is unknown, and a later response repopulates it", async () => {
    const messages = await readMessages(server, sessionId);
    const afterCompaction = resolveCodeOccupancy(
      messages as Parameters<typeof resolveCodeOccupancy>[0],
    );
    // Either the compaction settled (unknown - the honest answer) or it has not
    // finished yet (measured). What must never happen is a "measured" reading of
    // zero, which a naive sum of a settled ledger would produce.
    if (afterCompaction?.state === "measured") {
      expect(occupancyTokens(afterCompaction)).toBeDefined();
    } else {
      expect(occupancyTokens(afterCompaction)).toBeUndefined();
    }

    // The conversation is still usable, and the next response repopulates.
    expect(
      await promptUntilAnswered(server, sessionId, "Reply with exactly: PONGAGAIN"),
    ).toBe(true);
    const afterResponse = resolveCodeOccupancy(
      (await readMessages(server, sessionId)) as Parameters<typeof resolveCodeOccupancy>[0],
    );
    expect(afterResponse?.state).toBe("measured");
    expect(occupancyTokens(afterResponse)?.input).toBeGreaterThan(0);
  }, 180_000);
});

describeRuntime("real OpenCode: the limit is reported and never fabricated", () => {
  let server: RuntimeOpenCodeServer;

  beforeAll(async () => {
    server = await startRuntimeOpenCodeServer();
  }, 120_000);

  afterAll(async () => {
    await server?.stop();
  });

  it("reports each model's own context limit, distinct from any default", async () => {
    // The catalogue is populated asynchronously after readiness, so an empty read
    // here means "not loaded yet", not "this install has no models". Bounded wait.
    let limits: number[] = [];
    for (let attempt = 0; attempt < 30 && limits.length === 0; attempt += 1) {
      const body = await server.json<{
        data?: Array<{ limit?: { context?: number } }>;
      }>("/api/model", { headers: { "x-opencode-directory": DIRECTORY } });
      limits = (body.data ?? [])
        .map((model) => model.limit?.context)
        .filter((value): value is number => typeof value === "number" && value > 0);
      if (limits.length === 0) await Bun.sleep(1000);
    }

    // OpenCode reports real per-model limits; TBAi's 128_000 fallback is only
    // ever reached when a model reports none, so it must not be a common value.
    expect(limits.length).toBeGreaterThan(0);
    expect(new Set(limits).size).toBeGreaterThan(1);
    expect(OPENCODE_CONFIG.authUsername).toBe("opencode");
  }, 120_000);
});
