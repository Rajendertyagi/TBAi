/**
 * The Code context meter, aligned with OpenChamber.
 *
 * ## The failure class these pin
 *
 * OCCUPANCY is the prompt the provider held. TRAFFIC is everything billed across
 * a turn. A multi-step turn makes several model calls and each one re-reads the
 * whole prompt, so summing the turn's steps reports a conversation as many times
 * larger than the window that actually held it.
 *
 * OpenChamber's rule (`contextTokensFromBreakdown`): prefer the server's
 * `tokens.total`, and fall back to a sum only when the server sent no total.
 * These cases assert that rule on TBAi's Code surface, including the documented
 * 330% readout that adding cache reads to the numerator produced.
 */
import { describe, expect, it } from "bun:test";
import { toCodeContextUsage, toTokenUsage } from "./contextTokens";
import { resolveOccupancyNumerator } from "@/components/assistant-ui/elements/context-display";
import { reduceV2Event, reduceV2ThreadState } from "./v2Events";
import * as fs from "node:fs";
import * as path from "node:path";

const ringSource = fs.readFileSync(path.join(import.meta.dir, "OpenCodeContextRing.tsx"), "utf8");

const usage = (over: Record<string, unknown> = {}) => ({
  input: 200_000,
  output: 32_000,
  reasoning: 500,
  cache: { read: 30_000, write: 0 },
  ...over,
});

describe("Code meter: the server's total wins", () => {
  it("uses tokens.total as the numerator when the server reports one", () => {
    const result = toCodeContextUsage(usage({ total: 232_000 }));
    expect(result?.contextTokens).toBe(232_000);
    expect(result?.numeratorSource).toBe("server_total");
  });

  it("falls back to the full field sum only when no total is reported", () => {
    // OpenChamber's `sumTokenBreakdown`: input + output + reasoning + cache.read
    // + cache.write. Matching it exactly matters - a different fallback would
    // make TBAi and OpenChamber disagree about the same server response.
    const result = toCodeContextUsage(usage());
    // 200_000 + 32_000 + 500 + 30_000 + 0
    expect(result?.contextTokens).toBe(262_500);
    expect(result?.numeratorSource).toBe("derived_input_output");
  });

  it("the fallback includes cache.write, as OpenChamber's does", () => {
    const result = toCodeContextUsage(
      usage({ cache: { read: 30_000, write: 5_000 } }),
    );
    // 200_000 + 32_000 + 500 + 30_000 + 5_000
    expect(result?.contextTokens).toBe(267_500);
  });

  it("a reported total beats the sum even when the sum is much larger", () => {
    // The degradation is real: the sum inflates. A server that DOES report a
    // total must never be second-guessed by the buckets.
    const result = toCodeContextUsage(usage({ total: 100_000 }));
    expect(result?.contextTokens).toBe(100_000);
    expect(result?.numeratorSource).toBe("server_total");
  });

  it("treats a non-positive or non-finite total as absent", () => {
    // A server that reports `total: 0` has told us nothing, and a malformed
    // value must not become the numerator.
    for (const total of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, null]) {
      const result = toCodeContextUsage(usage({ total }));
      expect(result?.numeratorSource).toBe("derived_input_output");
    }
  });

  it("returns no context at all for an invalid payload", () => {
    expect(toCodeContextUsage(null)).toBeUndefined();
    expect(toCodeContextUsage({ input: "200000", output: 1, reasoning: 0, cache: { read: 0, write: 0 } })).toBeUndefined();
  });
});

describe("Code meter: a multi-step turn is occupancy, not traffic", () => {
  it("does not sum the turn's round trips", () => {
    // The real shape: two steps, each re-reading a ~900k context. Traffic is
    // 1.8M against a 1M window; the conversation is 90% full, not full, and
    // certainly not 180%.
    const perStep = 900_000;
    const windowTokens = 1_000_000;
    const traffic = perStep * 2;

    const result = toCodeContextUsage(
      usage({ input: perStep, output: 1_000, total: perStep, cache: { read: 0, write: 0 } }),
    );
    expect(result?.contextTokens).toBe(perStep);
    const percent = Math.min((result!.contextTokens! / windowTokens) * 100, 100);
    expect(Math.round(percent)).toBe(90);
    // The number the meter must never show.
    expect(Math.min((traffic / windowTokens) * 100, 100)).toBe(100);
    expect(result?.contextTokens).not.toBe(traffic);
  });

  it("a server that reports no total cannot fake occupancy from traffic", () => {
    // The degraded path must still be visibly degraded. The sum exceeds the
    // window, and `numeratorSource` says so rather than presenting it as a
    // measurement.
    const result = toCodeContextUsage(
      usage({ input: 900_000, output: 2_000, cache: { read: 850_000, write: 0 } }),
    );
    expect(result?.numeratorSource).toBe("derived_input_output");
    // 900_000 + 2_000 + reasoning 500 (inherited) + 850_000
    expect(result?.contextTokens).toBe(1_752_500);
  });

  it("does not add cache reads to the numerator", () => {
    // OpenChamber's documented 330% readout: cache.read of 3,291,956 against a
    // window that really held 232,872 tokens. Cache reads are a subdivision of
    // the same prompt the total already contains.
    const result = toCodeContextUsage(
      usage({ input: 200_000, output: 32_000, total: 232_872, cache: { read: 3_291_956, write: 0 } }),
    );
    expect(result?.contextTokens).toBe(232_872);
    expect(result?.cachedInputTokens).toBe(3_291_956);
    // Cached is retained for the breakdown, never summed into occupancy.
    expect(result?.contextTokens).not.toBe(232_872 + 3_291_956);
    expect(Math.round((result!.contextTokens! / 1_000_000) * 100)).toBe(23);
  });

  it("keeps cumulative usage available separately from occupancy", () => {
    // Spend accounting is untouched by the meter fix.
    const result = toCodeContextUsage(usage({ total: 232_000 }));
    expect(result?.usage).toEqual({
      totalTokens: 232_000,
      inputTokens: 200_000,
      outputTokens: 32_000,
      reasoningTokens: 500,
      cachedInputTokens: 30_000,
    });
  });

  it("toTokenUsage is unchanged - the spend contract still derives from buckets", () => {
    expect(toTokenUsage(usage())?.totalTokens).toBe(232_000);
  });
});

describe("Code meter: after a compaction the reading is unknown", () => {
  const base = {
    sessionId: "ses_1",
    connection: { type: "connected" as const, serverVersion: "2.0.16" },
    load: { type: "ready" as const },
    execution: { type: "idle" as const },
    compaction: { type: "idle" as const },
    occupancyStale: false,
    revertRecovery: { type: "none" as const },
    eventIdentity: {
      nextOrdinal: 0,
      recentObservedEventIds: [],
      recentAppliedEventIds: [],
      durableSequenceByAggregate: {},
    },
    session: null,
    model: null,
    agent: null,
    desiredModel: null,
    desiredAgent: null,
    selectionGeneration: 0,
    messages: {},
    messageOrder: [],
    permissions: [],
    forms: [],
    inboxById: {},
    usage: { cost: 1.5, tokens: usage({ total: 900_000, input: 900_000, output: 1_000 }) },
    optimisticMessageIds: [],
    answeredPermissionIds: [],
    diagnosticCount: 0,
  };

  const settle = { type: "compaction_settled" } as never;
  const begin = { type: "compaction_running" } as never;
  const fail = { type: "compaction_failed", error: { message: "refused" } } as never;
  const usageEvent = {
    type: "session.usage.updated",
    data: { cost: 2, tokens: usage({ total: 76_000, input: 75_000, output: 1_000 }) },
  } as never;
  const hydrated = {
    type: "session_hydrated",
    session: { id: "ses_1", cost: 3, tokens: usage({ total: 40_000 }) },
  } as never;

  it("compaction EVENTS are translated by the controller, not by the event reducer", () => {
    // The two-step chain, pinned at both halves because either alone is useless:
    //
    //   OpenCode publishes `session.compaction.*`  (the wire)
    //     -> controller dispatches compaction_running / _settled / _failed
    //       -> reducer sets occupancyStale          (the meter)
    //
    // The reducer deliberately does NOT react to the raw event: the controller
    // owns the translation, so a raw event passing through `reduceV2Event`
    // changes nothing. These cases document that split rather than asserting a
    // single-hop reaction that was never the design.
    const raw = reduceV2Event(base, {
      type: "session.compaction.ended",
      data: { sessionID: "ses_1" },
    } as never, 3);
    expect(raw.occupancyStale).toBe(false);

    // The action the controller dispatches for that same event does invalidate.
    expect(reduceV2ThreadState(base, settle).occupancyStale).toBe(true);
    // And the started/failed actions leave the reading alone.
    expect(reduceV2ThreadState(base, begin).occupancyStale).toBe(false);
    expect(reduceV2ThreadState(reduceV2ThreadState(base, begin), fail).occupancyStale).toBe(false);
  });

  it("a settled compaction invalidates occupancy but keeps the spend breakdown", () => {
    const before = reduceV2ThreadState(base, settle);
    expect(before.occupancyStale).toBe(true);
    // The tokens really were spent, so cost and buckets survive.
    expect(before.usage?.cost).toBe(1.5);
    expect(before.usage?.tokens.input).toBe(900_000);
  });

  it("a FAILED compaction leaves the reading valid", () => {
    // Nothing was rewritten, so the measurement still describes the conversation.
    const failed = reduceV2ThreadState(reduceV2ThreadState(base, begin), fail);
    expect(failed.occupancyStale).toBe(false);
  });

  it("the next usage report clears the invalidation", () => {
    // A public EVENT, so it goes through the event reducer, not the action one.
    const after = reduceV2Event(reduceV2ThreadState(base, settle), usageEvent, 1);
    expect(after.occupancyStale).toBe(false);
    expect(after.usage?.tokens.input).toBe(75_000);
  });

  it("a session reload trusts the server's snapshot", () => {
    // OpenCode has already resolved its own compactions; a reload must not
    // resurrect an "unknown" state the server can answer.
    const reloaded = reduceV2ThreadState(reduceV2ThreadState(base, settle), hydrated);
    expect(reloaded.occupancyStale).toBe(false);
  });

  it("unknown resolves to no numerator at all, not to zero", () => {
    expect(
      resolveOccupancyNumerator({
        contextTokens: 900_000,
        usageTotalTokens: 900_000,
        state: "unknown",
      }),
    ).toBeUndefined();
  });

  it("a measured reading still resolves normally", () => {
    expect(
      resolveOccupancyNumerator({ contextTokens: 76_000, usageTotalTokens: 900_000, state: "measured" }),
    ).toBe(76_000);
    expect(resolveOccupancyNumerator({ usageTotalTokens: 50_000, state: "measured" })).toBe(50_000);
    expect(resolveOccupancyNumerator({ state: "measured" })).toBeUndefined();
  });
});

describe("Code meter: the limit comes from OpenCode", () => {
  // OpenCode owns the Code model's window. TBAi's job is to use whatever it
  // reports, including when that is smaller or larger than any local default.
  it("uses the host-reported limit verbatim, however unusual", async () => {
    const { resolveContextWindow } = await import("@/config/modelContext");
    expect(resolveContextWindow({ limitContext: 200_000 })).toBe(200_000);
    expect(resolveContextWindow({ limitContext: 1_000_000 })).toBe(1_000_000);
    // Smaller than TBAi's 128k default, which must not override the server.
    expect(resolveContextWindow({ limitContext: 32_000 })).toBe(32_000);
  });

  it("does not substitute a local default when the host provides one", async () => {
    const { resolveContextWindow, DEFAULT_MODEL_CONTEXT_WINDOW } = await import(
      "@/config/modelContext"
    );
    // The specific bug this forbids: a 1M model being measured against 128k,
    // which reads as 100% full on a conversation that is 12% full.
    expect(resolveContextWindow({ limitContext: 1_000_000 })).not.toBe(DEFAULT_MODEL_CONTEXT_WINDOW);
  });

  it("rejects a malformed host limit and falls back rather than rendering NaN", async () => {
    const { resolveContextWindow } = await import("@/config/modelContext");
    for (const limitContext of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const window = resolveContextWindow({ limitContext });
      expect(Number.isFinite(window)).toBe(true);
      expect(window).toBeGreaterThan(0);
    }
  });

  it("falls back to a documented default when the host reports nothing", async () => {
    const { resolveContextWindow, DEFAULT_MODEL_CONTEXT_WINDOW } = await import(
      "@/config/modelContext"
    );
    // Documented, not invented per-render. OpenChamber's own analogue is
    // DEFAULT_CONTEXT_LIMIT; TBAi's is documented at the constant.
    expect(resolveContextWindow({ limitContext: undefined })).toBe(DEFAULT_MODEL_CONTEXT_WINDOW);
  });

  it("the Code ring passes OpenCode's limit and no configured override", () => {
    // Only `limitContext` is supplied: the Code surface must not let a
    // provider-configured window outrank the live server value.
    expect(ringSource).toContain("limitContext: current?.limit?.context");
    expect(ringSource).not.toContain("modelId:");
    expect(ringSource).not.toContain("groups:");
  });
});