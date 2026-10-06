/**
 * Phase 2 - the Direct assembly seam, end to end.
 *
 * These assert the properties that make guarantee 1 ("one Direct assembly path")
 * a property of the code rather than a claim, plus the two guarantees that
 * Phase 2 could most easily have broken: tool pairing and the approval
 * lifecycle.
 */

import { describe, expect, it, beforeEach } from "bun:test";
import { assembleContext, buildToolLayer, classifyDivergence } from "./index";
import type { UIMessage } from "ai";
import type { ProviderConfig } from "../types";

const provider: ProviderConfig = {
  id: "p1",
  name: "Test",
  type: "anthropic",
  model: "claude-test",
} as unknown as ProviderConfig;

const controller = new AbortController();

function user(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as unknown as UIMessage;
}

function assistant(id: string, text: string): UIMessage {
  return { id, role: "assistant", parts: [{ type: "text", state: "done", text }] } as unknown as UIMessage;
}

function approvalPaused(id: string, toolCallId: string, approvalId: string): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [
      {
        type: "tool-delete_file",
        toolCallId,
        state: "approval-requested",
        input: { path: "a.txt" },
        approval: { id: approvalId },
      } as unknown as Record<string, unknown>,
    ],
  } as unknown as UIMessage;
}

async function assemble(messages: UIMessage[], overrides: Partial<Parameters<typeof assembleContext>[0]> = {}) {
  return assembleContext({
    // No conversationId by default: reconciliation is exercised separately, and
    // omitting it keeps these tests free of a database.
    conversationId: undefined,
    submittedMessages: messages,
    runId: "run_test",
    provider,
    modelId: "claude-test",
    systemPrompt: undefined,
    toolSignal: controller.signal,
    ...overrides,
  });
}

describe("the seam produces three distinct layers", () => {
  it("keeps Layer A as its own field, separate from messages", async () => {
    const result = await assemble([user("u1", "hi")], { systemPrompt: "SYSTEM RULES" });
    expect(result.context.layerA.text).toBe("SYSTEM RULES");
    // A is NOT a message in C.
    const serializedC = JSON.stringify(result.context.layerC.messages);
    expect(serializedC).not.toContain("SYSTEM RULES");
  });

  it("reports Layer A as absent rather than inventing an empty instruction", async () => {
    // Phase 1: systemPrompt was NULL for every conversation in the audit install.
    const result = await assemble([user("u1", "hi")]);
    expect(result.context.layerA.source).toBe("absent");
    expect(result.context.layerA.text).toBeUndefined();
  });

  it("keeps Layer B out of the message array", async () => {
    const result = await assemble([user("u1", "hi")]);
    const serializedC = JSON.stringify(result.context.layerC.messages);
    for (const name of result.context.layerB.nativeToolNames) {
      expect(serializedC).not.toContain(`"${name}"`);
    }
  });

  it("carries every layer on the result", async () => {
    const result = await assemble([user("u1", "hi")]);
    expect(result.context.layerA).toBeDefined();
    expect(result.context.layerB).toBeDefined();
    expect(result.context.layerC).toBeDefined();
    expect(result.context.modelMessages.length).toBeGreaterThan(0);
    expect(result.context.provenance.engine).toBe("direct");
  });
});

describe("Layer B ordering is deterministic (guarantee G7, second half)", () => {
  it("sorts native tool names", () => {
    const layer = buildToolLayer({ toolSignal: controller.signal });
    const sorted = [...layer.nativeToolNames].sort();
    expect([...layer.nativeToolNames]).toEqual(sorted);
  });

  it("sorts MCP tool names and derives sorted, de-duplicated server ids", () => {
    const layer = buildToolLayer({ toolSignal: controller.signal });
    expect([...layer.mcpToolNames].sort()).toEqual([...layer.mcpToolNames]);
    expect([...layer.mcpServerIds].sort()).toEqual([...layer.mcpServerIds]);
    expect(new Set(layer.mcpServerIds).size).toBe(layer.mcpServerIds.length);
  });

  it("produces byte-identical tool key order across repeated builds", () => {
    // The provider's cacheable prefix is A -> B -> C, so a Layer B that varies
    // between identical builds silently destroys Layer C's cacheability.
    const a = buildToolLayer({ toolSignal: controller.signal });
    const b = buildToolLayer({ toolSignal: controller.signal });
    expect(Object.keys(a.tools)).toEqual(Object.keys(b.tools));
  });
});

describe("lifecycle repair stays separate from size management (G17)", () => {
  it("records lifecycle repair as its own provenance field", async () => {
    const result = await assemble([user("u1", "hi")]);
    expect(result.context.provenance.lifecycleRepair).toBeDefined();
    expect(result.context.provenance.reduction).toBeNull();
  });

  it("does not let size pressure remove an unexpired approval decision", async () => {
    // The one thing a budget must never do. A paused approval is carried whole
    // through assembly: pruning keeps it (it is the CURRENT turn), and the
    // budget reduces tool RESULTS, never the call or its gate.
    const result = await assemble([user("u1", "delete it"), approvalPaused("a1", "call_1", "appr_1")]);
    const serialized = JSON.stringify(result.context.layerC.messages);
    expect(serialized).toContain("appr_1");
    expect(serialized).toContain("call_1");
  });

  it("drops a dead incomplete tool call without losing its message", async () => {
    const dead = {
      id: "a1",
      role: "assistant",
      parts: [{ type: "tool-read", toolCallId: "call_dead", state: "input-available", input: {} }],
    } as unknown as UIMessage;
    const result = await assemble([user("u1", "go"), dead, user("u2", "again")]);
    expect(JSON.stringify(result.context.layerC.messages)).not.toContain("call_dead");
  });
});

describe("tool-call/result pairing survives assembly (guarantee 5)", () => {
  it("keeps a call and its reduced result together", async () => {
    const big = "Q".repeat(70_000);
    const turn = {
      id: "a1",
      role: "assistant",
      parts: [
        { type: "text", state: "done", text: "reading" },
        { type: "tool-read", toolCallId: "call_x", state: "output-available", input: { path: "p" }, output: big },
      ],
    } as unknown as UIMessage;
    const result = await assemble([user("u1", "read p"), turn]);
    expect(result.context.provenance.reduction?.reducedParts).toBe(1);
    const serialized = JSON.stringify(result.context.layerC.messages);
    // The call survives, so the pairing invariant holds for the reduced result.
    expect(serialized).toContain("call_x");
    expect(serialized).toContain("truncated");
  });
});

describe("the current user turn is identifiable (G11)", () => {
  it("names the trailing user turn by id", async () => {
    const result = await assemble([user("u1", "first"), assistant("a1", "r"), user("u2", "second")]);
    expect(result.context.layerC.currentTurnIds).toEqual(["u2"]);
    expect(result.context.layerC.retainedIds).toContain("u1");
  });
});

describe("overflow is a decision, not an accident", () => {
  it("rejects a request that cannot fit a KNOWN limit, rather than sending it", async () => {
    // The property under test: a budget rejection is terminal and pays nothing.
    //
    // This previously used the default fixture, which carries no `models` array and
    // therefore resolves to `conservative_default`. Under P-1 a stand-in is advisory,
    // so it no longer rejects — correctly, because a number TBAi invented must not
    // stop a request the provider would have served. The terminal case is now pinned
    // against a REAL ceiling, which is where the property actually has to hold.
    const known = {
      ...provider,
      models: [
        { id: "claude-test", provider: "anthropic", contextWindow: 128_000, contextWindowSource: "provider_reported" },
      ],
    } as unknown as typeof provider;

    const huge = [user("u1", "x".repeat(3_000_000))];
    const result = await assemble(huge, { provider: known });
    expect(result.context.provenance.limit.source).toBe("provider_reported");
    expect(result.decision.action).toBe("reject");
    if (result.decision.action === "reject") {
      expect(result.decision.reason).toBe("over_limit");
      // A rejection must not pay for a conversion it will discard.
      expect(result.context.modelMessages).toHaveLength(0);
    }
  });

  it("sends an over-stand-in request for an UNKNOWN model, bounded by Tier 2 instead", async () => {
    // P-1. The stand-in no longer rejects, and the request is converted for
    // transport so the provider can decide and `observed` can learn. Tier 2 is the
    // bound that remains.
    const huge = [user("u1", "x".repeat(3_000_000))];
    const result = await assemble(huge);
    expect(result.context.provenance.limit.source).toBe("conservative_default");
    expect(result.decision.action).toBe("advisory");
    // ~1M tokens is under the 4,194,304 assembly ceiling, so it proceeds.
    expect(result.tier2.outcome).toBe("within_assembly_limit");
    expect(result.context.modelMessages.length).toBeGreaterThan(0);
  });

  it("still sends an ordinary small request for an UNKNOWN model", async () => {
    // Tier 2 is a ceiling, not a gate: a request far below it must be unaffected by
    // the model's limit being unknown. This asserts the PASSING case only.
    //
    // It does NOT cover the breach case. Reaching 4,194,304 estimated tokens needs
    // more text than is practical in this fixture, and doing it artificially would
    // assert the guard rather than the seam. The breach is proven properly in
    // `tier2-seam.test.ts`, where a configured 8M window cannot lift the ceiling and
    // an over-ceiling request yields no model messages at all.
    const result = await assemble([user("u1", "hi")]);
    expect(result.tier2.outcome).toBe("within_assembly_limit");
    expect(result.context.modelMessages.length).toBeGreaterThan(0);
  });

  it("reports a default limit as a default, never as a known figure", async () => {
    // The fixture provider carries NO `models` array, so the unknown path stays
    // the path under test (R1 did not weaken this fixture to make wiring pass).
    const result = await assemble([user("u1", "hi")]);
    expect(result.context.provenance.limit.source).toBe("conservative_default");
    expect(result.diagnostics.limitSource).toContain("conservative_default");
  });

  it("labels the measurement as an estimate, never as usage", async () => {
    // Nothing downstream may read a pre-request number as provider usage.
    const result = await assemble([user("u1", "hi")]);
    expect(result.diagnostics.measurementKind).toBe("estimate_pre_request");
  });
});

describe("diagnostics are counts and categories only", () => {
  it("never includes prompt text", async () => {
    const secret = "SECRET_PROBE_STRING_NOT_FOR_LOGS";
    const result = await assemble([user("u1", secret)]);
    expect(JSON.stringify(result.diagnostics)).not.toContain(secret);
  });

  it("includes the fields needed to explain a decision", async () => {
    const result = await assemble([user("u1", "hi")], { systemPrompt: "rules" });
    const d = result.diagnostics;
    for (const key of [
      "estimatedSize",
      "unit",
      "windowLimit",
      "limitSource",
      "outputReserve",
      "safetyMargin",
      "usableInput",
      "decision",
      "messageCount",
      "categories",
      "nativeToolCount",
      "historySource",
    ]) {
      expect(d).toHaveProperty(key);
    }
  });

  it("uses log keys the logger will not redact", async () => {
    // `src/lib/logger.ts` SENSITIVE_KEY_RE matches `.*token.*` because keys like
    // `authToken` really are secrets. A count of tokens therefore cannot be
    // logged under a key containing that substring, or the budget becomes
    // unexplainable in production ("[REDACTED]" everywhere).
    //
    // The security pattern is NOT relaxed; the log keys avoid the collision and
    // carry `unit: "tokens"` to stay unambiguous. This test fails if someone
    // "fixes" the key names back to the obvious spelling and silently loses
    // observability.
    const result = await assemble([user("u1", "hello there")]);
    const offending = Object.keys(result.diagnostics).filter((key) => /token/i.test(key));
    expect(offending).toEqual([]);
    expect(result.diagnostics.unit).toBe("tokens");
    // The values are genuinely present, not redacted away.
    expect(typeof result.diagnostics.estimatedSize).toBe("number");
    expect(typeof result.diagnostics.usableInput).toBe("number");
    expect(typeof result.diagnostics.outputReserve).toBe("number");
  });
});

describe("divergence classification", () => {
  it("treats a superset submission as normal in-flight state", () => {
    // The auto-continue case: the client holds turns the server has not
    // persisted. Rejecting this would break a working path.
    const report = classifyDivergence(new Set(["a", "b", "c"]), new Set(["a", "b"]));
    expect(report.outcome).toBe("in_flight_extension");
  });

  it("flags stored turns the submission omits", () => {
    // The case that motivated the seam: a detached run's reply was finalized
    // server-side and the client, being gone, can never re-send it.
    const report = classifyDivergence(new Set(["a"]), new Set(["a", "b"]));
    expect(report.outcome).toBe("missing_from_submission");
    expect(report.onlyInStored).toBe(1);
  });

  it("reports alignment exactly", () => {
    expect(classifyDivergence(new Set(["a"]), new Set(["a"])).outcome).toBe("aligned");
  });

  it("reports disjoint sets as unrelated", () => {
    expect(classifyDivergence(new Set(["x"]), new Set(["y"])).outcome).toBe("unrelated");
  });

  it("carries counts only, never ids", () => {
    const report = classifyDivergence(new Set(["secret-id-1"]), new Set(["secret-id-2"]));
    expect(JSON.stringify(report)).not.toContain("secret-id-1");
  });
});
