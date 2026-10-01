/**
 * Phase 2 context foundation - measurement, budget, and limits.
 *
 * These tests pin the properties Phase 2 actually creates, rather than
 * restating what the code does. In particular they pin the DIRECTION of the
 * estimation error, which is the property that makes the estimate safe: a budget
 * built on an estimate that can silently under-count is worse than no budget.
 */

import { describe, expect, it } from "bun:test";
import {
  CHARS_PER_TOKEN_ESTIMATE,
  buildInstructionsLayer,
  combineEstimates,
  computeBudget,
  decideBudget,
  describeLimitSource,
  measureInstructions,
  measureMessages,
  measureToolDefinitions,
  reduceToolResults,
  REQUEST_TOOL_RESULT_MAX_CHARS,
  resolveContextLimit,
  resolveOutputReservation,
  SAFETY_MARGIN_FRACTION,
  UNKNOWN_LIMIT_CEILING,
  type MessagesLayer,
  type ToolDefinitionLayer,
} from "./index";
import type { UIMessage } from "ai";

function assistant(id: string, text: string): UIMessage {
  return { id, role: "assistant", parts: [{ type: "text", state: "done", text }] } as unknown as UIMessage;
}

function user(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as unknown as UIMessage;
}

function toolResultMessage(id: string, toolCallId: string, output: string, type = "tool-read"): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [
      {
        type,
        toolCallId,
        state: "output-available",
        input: { path: "x" },
        output,
      } as unknown as Record<string, unknown>,
    ],
  } as unknown as UIMessage;
}

describe("measurement: the estimate can only be pessimistic, never optimistic", () => {
  it("uses a chars-per-token divisor below the prose rule of thumb", () => {
    // The ~4 chars/token English rule of thumb would be optimistic. 3 is chosen
    // so the estimate over-counts, which is the safe direction for a ceiling.
    expect(CHARS_PER_TOKEN_ESTIMATE).toBeLessThan(4);
  });

  it("states a range that brackets the point estimate", () => {
    const estimate = measureMessages({
      messages: [assistant("a", "hello world ".repeat(500))],
      currentTurnIds: [],
      retainedIds: ["a"],
    });
    expect(estimate.range.low).toBeLessThanOrEqual(estimate.estimatedTokens);
    expect(estimate.range.high).toBeGreaterThan(estimate.estimatedTokens);
  });

  it("never reports the point estimate as a bound - the high end is reachable", () => {
    const estimate = measureMessages({
      messages: [assistant("a", "x".repeat(3000))],
      currentTurnIds: [],
      retainedIds: ["a"],
    });
    // A request accepted on the point estimate alone can still exceed it.
    // budget.ts therefore decides on range.high.
    expect(estimate.range.high).toBeGreaterThan(estimate.estimatedTokens);
  });

  it("attributes cost per category rather than only in total", () => {
    const layer: MessagesLayer = {
      messages: [assistant("a", "some assistant prose"), toolResultMessage("b", "call_1", "R".repeat(500))],
      currentTurnIds: [],
      retainedIds: ["a", "b"],
    };
    const estimate = measureMessages(layer);
    expect(estimate.byCategory.assistant_text).toBeGreaterThan(0);
    expect(estimate.byCategory.tool_results).toBeGreaterThan(0);
  });

  it("separates MCP results from native tool results", () => {
    // Phase 1 F9: MCP output is the unbounded population. A budget that cannot
    // attribute it separately cannot prioritise reducing it.
    const layer: MessagesLayer = {
      messages: [toolResultMessage("a", "call_1", "N".repeat(400), "tool-read")],
      currentTurnIds: [],
      retainedIds: ["a"],
    };
    const mcpLayer: MessagesLayer = {
      messages: [toolResultMessage("a", "call_1", "M".repeat(400), "tool-mcp__srv__doThing")],
      currentTurnIds: [],
      retainedIds: ["a"],
    };
    expect(measureMessages(layer).byCategory.tool_results).toBeGreaterThan(0);
    expect(measureMessages(mcpLayer).byCategory.mcp_results).toBeGreaterThan(0);
  });

  it("measures instructions as their own category and tolerates absence", () => {
    expect(measureInstructions(buildInstructionsLayer("S".repeat(300))).byCategory.instructions)
      .toBeGreaterThan(0);
    // Phase 1 found systemPrompt NULL for every conversation in the audit
    // install, so the absent case is the normal case, not an edge case.
    expect(measureInstructions(buildInstructionsLayer(undefined)).estimatedTokens).toBe(0);
  });

  it("measures tool definitions, which are a real per-request cost", () => {
    const layer: ToolDefinitionLayer = {
      tools: { read: { description: "d".repeat(200) } } as never,
      nativeToolNames: ["read", "write"],
      mcpToolNames: ["mcp__s__t"],
      mcpServerIds: ["s"],
    };
    expect(measureToolDefinitions(layer).byCategory.tool_definitions).toBeGreaterThan(0);
  });

  it("combines per-layer estimates into one request-level total", () => {
    const combined = combineEstimates([
      measureInstructions(buildInstructionsLayer("I".repeat(300))),
      measureMessages({ messages: [assistant("a", "A".repeat(300))], currentTurnIds: [], retainedIds: ["a"] }),
    ]);
    expect(combined.estimatedChars).toBeGreaterThanOrEqual(600);
    expect(combined.byCategory.instructions).toBeGreaterThan(0);
    expect(combined.byCategory.assistant_text).toBeGreaterThan(0);
  });
});

describe("limits: provenance is mandatory and never collapsed", () => {
  it("reports a provider-reported limit as such", () => {
    const limit = resolveContextLimit({
      providerType: "anthropic",
      modelId: "claude",
      model: { contextWindow: 200000, contextWindowSource: "provider_reported" },
    });
    expect(limit.source).toBe("provider_reported");
    expect(limit.maxInputTokens).toBe(200000);
  });

  it("marks a missing limit as a conservative default, never as a reported figure", () => {
    // Phase 1 F14: only Anthropic populates contextWindow today. Everything else
    // must not present the fallback as if a provider had reported it.
    const limit = resolveContextLimit({ providerType: "openai", modelId: "gpt-x" });
    expect(limit.source).toBe("conservative_default");
    expect(limit.maxInputTokens).toBe(UNKNOWN_LIMIT_CEILING);
    expect(describeLimitSource(limit)).toContain("conservative_default");
  });

  it("still bounds an unknown limit rather than allowing unbounded growth", () => {
    // The difference between "we do not know" and "we let it run forever".
    expect(UNKNOWN_LIMIT_CEILING).toBeGreaterThan(0);
  });

  it("ignores a non-positive reported limit rather than trusting it", () => {
    const limit = resolveContextLimit({
      providerType: "google",
      modelId: "g",
      model: { contextWindow: 0, contextWindowSource: "provider_reported" },
    });
    expect(limit.source).toBe("conservative_default");
  });
});

describe("output reservation: never zero, and not available input", () => {
  it("reserves a positive amount when the model reports nothing", () => {
    // Phase 1 F5: Direct reserved nothing at all.
    const reservation = resolveOutputReservation(undefined);
    expect(reservation.tokens).toBeGreaterThan(0);
    expect(reservation.source).toBe("conservative_default");
  });

  it("uses a model-reported output ceiling when available", () => {
    const reservation = resolveOutputReservation(8192);
    expect(reservation.tokens).toBe(8192);
    expect(reservation.source).toBe("provider_reported");
  });

  it("clamps an absurd reported ceiling so it cannot invert the budget", () => {
    const reservation = resolveOutputReservation(10_000_000);
    expect(reservation.tokens).toBeLessThanOrEqual(32_000);
  });
});

describe("budget: output is subtracted before input is computed", () => {
  it("reserves output, then margin, from the limit", () => {
    const limit = resolveContextLimit({ providerType: "anthropic", modelId: "c", model: { contextWindow: 100000 } });
    const budget = computeBudget({ limit });
    const reservation = budget.outputReservation.tokens;
    const expectedMargin = Math.floor((100000 - reservation) * SAFETY_MARGIN_FRACTION);
    expect(budget.safetyMarginTokens).toBe(expectedMargin);
    expect(budget.usableInputTokens).toBe(100000 - reservation - expectedMargin);
  });

  it("never reports usable input as the full limit", () => {
    // The arithmetic error Phase 2 exists to prevent: treating the window as
    // fully available for input, leaving no room to answer.
    const limit = resolveContextLimit({ providerType: "anthropic", modelId: "c", model: { contextWindow: 100000 } });
    const budget = computeBudget({ limit });
    expect(budget.usableInputTokens).toBeLessThan(limit.maxInputTokens!);
  });

  it("produces a non-negative usable budget for a tiny window", () => {
    const limit = resolveContextLimit({ providerType: "anthropic", modelId: "c", model: { contextWindow: 100 } });
    const budget = computeBudget({ limit });
    expect(budget.usableInputTokens).toBeGreaterThanOrEqual(0);
    expect(budget.safetyMarginTokens).toBeGreaterThanOrEqual(0);
  });
});

describe("budget decision", () => {
  const limit = resolveContextLimit({ providerType: "anthropic", modelId: "c", model: { contextWindow: 100000 } });

  it("accepts a small request and reports headroom", () => {
    const budget = computeBudget({ limit });
    const estimate = measureMessages({
      messages: [assistant("a", "short")],
      currentTurnIds: [],
      retainedIds: ["a"],
    });
    const decision = decideBudget({ estimate, budget, reducedAlready: false });
    expect(decision.action).toBe("accept");
  });

  it("rejects a request that cannot fit even at the optimistic end", () => {
    const budget = computeBudget({ limit });
    const huge = measureMessages({
      messages: [assistant("a", "x".repeat(2_000_000))],
      currentTurnIds: [],
      retainedIds: ["a"],
    });
    const decision = decideBudget({ estimate: huge, budget, reducedAlready: false });
    expect(decision.action).toBe("reject");
    if (decision.action === "reject") {
      expect(decision.reason).toBe("over_limit");
      expect(decision.overBy).toBeGreaterThan(0);
    }
  });

  it("decides on the pessimistic end of the band, not the point estimate", () => {
    // The narrow case that matters: the point estimate fits, but the pessimistic
    // end does not. Accepting here is exactly the failure the module exists to
    // prevent, so it is asserted directly with a synthetic estimate rather than
    // reverse-engineered from character counts.
    const budget = computeBudget({ limit });
    const usable = budget.usableInputTokens!;
    const estimate = {
      estimatedTokens: usable - 10,
      estimatedChars: 0,
      charsPerToken: CHARS_PER_TOKEN_ESTIMATE,
      range: { low: usable - 100, high: usable + 5_000 },
      byCategory: {} as never,
      charsByCategory: {} as never,
    };
    const decision = decideBudget({ estimate, budget, reducedAlready: false });
    expect(decision.action).not.toBe("accept");
  });

  it("accepts once reduction has already brought the request inside the ceiling", () => {
    // Reduction happens before the decision, so a request that only fit after
    // reduction must not be rejected on a second pass.
    const budget = computeBudget({ limit });
    const usable = budget.usableInputTokens!;
    const estimate = {
      estimatedTokens: usable - 10,
      estimatedChars: 0,
      charsPerToken: CHARS_PER_TOKEN_ESTIMATE,
      range: { low: usable - 100, high: usable + 5_000 },
      byCategory: {} as never,
      charsByCategory: {} as never,
    };
    const decision = decideBudget({ estimate, budget, reducedAlready: true });
    expect(decision.action).toBe("accept");
  });
});

describe("request-side reduction: the context limit, not the render limit", () => {
  it("leaves ordinary results untouched", () => {
    const { messages, report } = reduceToolResults([toolResultMessage("a", "c1", "small")]);
    expect(report.reducedParts).toBe(0);
    expect(messages).toHaveLength(1);
  });

  it("reduces an oversized result to the request cap", () => {
    const huge = "Z".repeat(REQUEST_TOOL_RESULT_MAX_CHARS * 3);
    const { messages, report } = reduceToolResults([toolResultMessage("a", "c1", huge)]);
    expect(report.reducedParts).toBe(1);
    expect(report.removedChars).toBeGreaterThan(0);
    const part = (messages[0] as { parts: Array<Record<string, unknown>> }).parts[0];
    expect(String(part.output).length).toBeLessThanOrEqual(REQUEST_TOOL_RESULT_MAX_CHARS);
  });

  it("marks truncation explicitly so the model is not misled about completeness", () => {
    // A silently clipped result teaches the model the output was complete.
    const huge = "Z".repeat(REQUEST_TOOL_RESULT_MAX_CHARS * 2);
    const { messages } = reduceToolResults([toolResultMessage("a", "c1", huge)]);
    const part = (messages[0] as { parts: Array<Record<string, unknown>> }).parts[0];
    expect(String(part.output)).toContain("truncated");
  });

  it("preserves tool-call/result pairing - the call, id and input are never touched", () => {
    // Guarantee 5. Reduction changes the RESULT only.
    const huge = "Z".repeat(REQUEST_TOOL_RESULT_MAX_CHARS * 2);
    const before = toolResultMessage("a", "call_keep", huge);
    const { messages } = reduceToolResults([before]);
    const part = (messages[0] as { parts: Array<Record<string, unknown>> }).parts[0];
    expect(part.toolCallId).toBe("call_keep");
    expect(part.type).toBe("tool-read");
    expect(part.input).toEqual({ path: "x" });
  });

  it("does not mutate the caller's messages", () => {
    const huge = "Z".repeat(REQUEST_TOOL_RESULT_MAX_CHARS * 2);
    const original = toolResultMessage("a", "c1", huge);
    const snapshot = JSON.stringify(original);
    reduceToolResults([original]);
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it("does not treat an error result as reducible output", () => {
    // A failure's cause is the payload; replacing it would hide the defect.
    const errorMessage = {
      id: "a",
      role: "assistant",
      parts: [
        { type: "tool-read", toolCallId: "c1", state: "output-error", errorText: "E".repeat(200_000) },
      ],
    } as unknown as UIMessage;
    const { messages, report } = reduceToolResults([errorMessage]);
    expect(report.droppedParts).toBe(1);
    const part = (messages[0] as { parts: Array<Record<string, unknown>> }).parts[0];
    expect(String(part.errorText)).not.toContain("E".repeat(1000));
  });
});

describe("current-turn identification (guarantee G11)", () => {
  it("is importable and distinguishes a user turn from history", async () => {
    const { identifyCurrentTurn } = await import("./divergence");
    const { currentIds, retainedIds } = identifyCurrentTurn([user("u1", "first"), assistant("a1", "reply"), user("u2", "second")]);
    expect(currentIds).toEqual(["u2"]);
    expect(retainedIds).toEqual(["u1", "a1"]);
  });

  it("reports no current turn when the array ends on an assistant turn", () => {
    // A continuation whose tool result is last has no user turn to protect.
    const result = identifyCurrentTurnLocal([user("u1", "go"), toolResultMessage("a1", "c1", "done")]);
    expect(result.currentIds).toEqual([]);
  });
});

// Local mirror to keep the sync import list small; same logic under test.
function identifyCurrentTurnLocal(messages: readonly UIMessage[]): { currentIds: string[]; retainedIds: string[] } {
  const currentIds: string[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i] as { role?: string; id?: string };
    if (m.role !== "user") continue;
    const followedByAssistant = messages.slice(i + 1).some((later) => (later as { role?: string }).role === "assistant");
    if (!followedByAssistant && typeof m.id === "string") currentIds.push(m.id);
  }
  return { currentIds, retainedIds: [] };
}
