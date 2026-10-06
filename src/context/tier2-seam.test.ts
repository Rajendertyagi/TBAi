/**
 * Tier 2 at the assembly seam — position and reachability.
 *
 * `tier2.test.ts` proves the guard's arithmetic and `tier2-p1.test.ts` proves the
 * P-1 advisory behaviour. This file proves the two properties that only the seam
 * can establish:
 *
 * 1. **Position.** The guard evaluates the FINAL assembled request — after
 *    reduction, compaction and measurement — not an earlier or cached reading. A
 *    guard placed before compaction would judge a request that is no longer the one
 *    being sent.
 * 2. **Reachability.** Every Direct provider path goes through `assembleContext`,
 *    so the guard cannot be skipped by choosing a different provider. And a breach
 *    produces NO model messages, which is what makes "before provider transport"
 *    true rather than aspirational.
 */

import { describe, expect, it } from "bun:test";
import { assembleContext } from "./index";
import { TIER_2_MAX_TOKENS } from "./tier2";
import type { UIMessage } from "ai";
import type { ProviderConfig } from "../types";

const controller = new AbortController();

function unknownProvider(): ProviderConfig {
  return {
    id: "agnes-cfg",
    name: "Agnes",
    type: "custom",
    model: "agnes-2.5-flash",
    endpoint: "https://apihub.agnes-ai.com/v1",
    apiProtocol: "chat-completions",
    // No `models` entry carrying a contextWindow: the real Agnes case, where the
    // listing exposes only id/object/created/owned_by.
    models: [],
  } as unknown as ProviderConfig;
}

function user(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as unknown as UIMessage;
}

/** `chars` characters of user text — the cheapest way to grow an assembled request. */
function history(chars: number): UIMessage[] {
  const body = "x".repeat(chars);
  return [user("u1", body)];
}

describe("the guard runs at the assembly seam for an unknown model", () => {
  it("reports a within-limit verdict for a small request and converts it", async () => {
    const result = await assembleContext({
      conversationId: undefined,
      submittedMessages: [user("u1", "hello")],
      runId: "r1",
      provider: unknownProvider(),
      modelId: "agnes-2.5-flash",
      systemPrompt: undefined,
      toolSignal: controller.signal,
    });

    expect(result.tier2.outcome).toBe("within_assembly_limit");
    // Passing the guard is what makes conversion happen; a breach would leave this
    // empty and never reach `streamText`.
    expect(result.context.modelMessages.length).toBeGreaterThan(0);
  });

  it("exposes the verdict on provenance so the route can distinguish the failure", async () => {
    const result = await assembleContext({
      conversationId: undefined,
      submittedMessages: [user("u1", "hello")],
      runId: "r2",
      provider: unknownProvider(),
      modelId: "agnes-2.5-flash",
      systemPrompt: undefined,
      toolSignal: controller.signal,
    });

    expect(result.context.provenance.tier2.outcome).toBe("within_assembly_limit");
    expect(result.context.provenance.tier2).toEqual(result.tier2);
  });

  it("always emits the guard's outcome and ceiling in diagnostics", async () => {
    // Observability on EVERY request, not only breaches: otherwise a guard that
    // silently stopped running would look identical to one that always passes.
    const result = await assembleContext({
      conversationId: undefined,
      submittedMessages: [user("u1", "hello")],
      runId: "r3",
      provider: unknownProvider(),
      modelId: "agnes-2.5-flash",
      systemPrompt: undefined,
      toolSignal: controller.signal,
    });

    expect(result.diagnostics.assemblyLimitOutcome).toBe("within_assembly_limit");
    expect(result.diagnostics.assemblyLimitCeiling).toBe(TIER_2_MAX_TOKENS);
  });
});

describe("the Agnes regression at the seam", () => {
  it("an over-stand-in request is ADVISORY and still converts for transport", async () => {
    // ~101K tokens of text. Over the 92,928 usable planning budget derived from the
    // 128K stand-in, far under Tier 2.
    const result = await assembleContext({
      conversationId: undefined,
      submittedMessages: history(101_000 * 3),
      runId: "r-agnes",
      provider: unknownProvider(),
      modelId: "agnes-2.5-flash",
      systemPrompt: undefined,
      toolSignal: controller.signal,
    });

    expect(result.context.provenance.limit.source).toBe("conservative_default");
    // Was `reject` before this change; the whole fix is that it is not terminal.
    expect(result.decision.action).toBe("advisory");
    expect(result.tier2.outcome).toBe("within_assembly_limit");
    // Non-empty modelMessages is the observable proof that provider transport is
    // reachable — a terminal rejection returned [] here.
    expect(result.context.modelMessages.length).toBeGreaterThan(0);
  });

  it("records the advisory condition in diagnostics rather than hiding it", async () => {
    const result = await assembleContext({
      conversationId: undefined,
      submittedMessages: history(101_000 * 3),
      runId: "r-agnes-2",
      provider: unknownProvider(),
      modelId: "agnes-2.5-flash",
      systemPrompt: undefined,
      toolSignal: controller.signal,
    });

    expect(result.diagnostics.advisoryReason).toBe("limit_not_authoritative");
    expect(result.diagnostics.decision).toBe("advisory");
    // The stand-in is reported as a planning ceiling, never as a provider figure.
    expect(result.diagnostics.planningCeiling).toBe(92_928);
    expect(result.diagnostics.limitSource).toBe("conservative_default(128000)");
  });
});

describe("every Direct provider path reaches the guard", () => {
  // `assemble.ts` documents itself as the single Direct assembly boundary. This
  // asserts that property for the provider TYPES most likely to diverge, rather
  // than trusting the comment.
  const TYPES = ["custom", "anthropic", "openai", "google", "ollama"] as const;

  for (const type of TYPES) {
    it(`evaluates Tier 2 for a ${type} provider`, async () => {
      const provider = {
        id: `p-${type}`,
        name: type,
        type,
        model: "m",
        models: [],
      } as unknown as ProviderConfig;

      const result = await assembleContext({
        conversationId: `c-${type}`,
        submittedMessages: [user("u1", "hi")],
        runId: `r-${type}`,
        provider,
        modelId: "m",
        systemPrompt: undefined,
        toolSignal: controller.signal,
      });

      expect(result.tier2.outcome).toBe("within_assembly_limit");
      expect(result.diagnostics.assemblyLimitCeiling).toBe(TIER_2_MAX_TOKENS);
    });
  }
});

describe("the guard cannot be raised by model metadata", () => {
  it("a configured 8M window does not lift the ceiling", async () => {
    const provider = {
      id: "p-huge",
      name: "Huge",
      type: "custom",
      model: "huge-model",
      models: [
        {
          id: "huge-model",
          provider: "custom",
          contextWindow: 8_000_000,
          contextWindowSource: "configured",
        },
      ],
    } as unknown as ProviderConfig;

    const result = await assembleContext({
      conversationId: undefined,
      // ~5M tokens: under the operator's 8M, over Tier 2.
      submittedMessages: history(5_000_000 * 3),
      runId: "r-huge",
      provider,
      modelId: "huge-model",
      systemPrompt: undefined,
      toolSignal: controller.signal,
    });

    // The budget accepts it — Tier 1 permits it.
    expect(result.decision.action).not.toBe("reject");
    // Tier 2 does not. This is the invariant that no configuration can cross.
    expect(result.tier2.outcome).toBe("assembly_limit_exceeded");
    // And a breach leaves nothing to send.
    expect(result.context.modelMessages).toHaveLength(0);
  });
});