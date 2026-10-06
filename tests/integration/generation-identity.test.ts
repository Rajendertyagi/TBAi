/**
 * Generation identity for the Direct runtime.
 *
 * A model invocation is the PAIR (callId, stepNumber). `callId` alone is NOT
 * sufficient: ai@7.0.93 mints `callId` once per `streamText()` and reuses it
 * across every step, so a twenty-step tool loop carries a single callId. These
 * tests pin that distinction so a future change cannot quietly collapse the two
 * levels into one.
 *
 * They run against the real `streamText` using the repo's existing
 * `MockLanguageModelV4` harness, so no provider is contacted.
 */
import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { stepCountIs, streamText, tool } from "ai";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";

/**
 * Provider-WIRE usage, as the mock's stream parts expect it. The SDK normalizes
 * this into the FLAT `LanguageModelUsage` that `StepResult.usage` carries, so a
 * flat literal here would silently normalize to `undefined` everywhere.
 */
const USAGE = { inputTokens: { total: 10, noCache: 10 }, outputTokens: { total: 5, text: 5 } };

/** The exact shape `chat.ts#onStepFinish` reads. Kept in sync with it on purpose. */
type GenerationStep = {
  readonly callId?: string;
  readonly stepNumber?: number;
  readonly usage?: unknown;
  readonly model?: { readonly provider?: string; readonly modelId?: string };
  readonly response?: { readonly id?: string };
  readonly content?: ReadonlyArray<{ readonly type?: string; readonly toolCallId?: string }>;
};

function collectSteps(model: unknown, stopAt = 20): Promise<GenerationStep[]> {
  const seen: GenerationStep[] = [];
  const probe = tool({
    description: "probe",
    inputSchema: z.object({}),
    execute: async () => ({ ok: true }),
  });
  const result = streamText({
    model: model as never,
    prompt: "hi",
    tools: { probe_tool: probe },
    stopWhen: stepCountIs(stopAt),
    onStepFinish: (step: GenerationStep) => seen.push(step),
  });
  return (async () => {
    for await (const _ of result.fullStream) { /* drain */ }
    return seen;
  })();
}

/** Step 0 calls a tool; every later step answers in text. */
function toolLoopStream() {
  let call = 0;
  return () => {
    call += 1;
    if (call === 1) {
      return {
        stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { type: "tool-call", toolCallId: "toolcall-xyz", toolName: "probe_tool", input: JSON.stringify({}) },
          { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: USAGE },
        ] as never),
      };
    }
    return {
      stream: convertArrayToReadableStream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "done" },
        { type: "text-end", id: "t1" },
        { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: USAGE },
      ] as never),
    };
  };
}

function textStream(text: string) {
  return {
    stream: convertArrayToReadableStream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: text },
      { type: "text-end", id: "t1" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: USAGE },
    ] as never),
  };
}

describe("generation identity is (callId, stepNumber)", () => {
  // I — same callId, different stepNumber must be distinguishable generations.
  it("distinguishes two generations that share a callId", async () => {
    const steps = await collectSteps(new MockLanguageModelV4({ doStream: toolLoopStream() } as never));

    expect(steps).toHaveLength(2);
    // The premise of the whole design: callId alone would collapse these.
    expect(new Set(steps.map((s) => s.callId)).size).toBe(1);
    expect(steps.map((s) => s.stepNumber)).toEqual([0, 1]);

    // The PAIR is what identifies a generation.
    const identities = steps.map((s) => `${String(s.callId)}#${String(s.stepNumber)}`);
    expect(new Set(identities).size).toBe(2);
  });

  // I (cont.) — different callId, same stepNumber is a different generation.
  it("distinguishes two generations that share a stepNumber across two calls", async () => {
    const first = await collectSteps(new MockLanguageModelV4({ doStream: textStream("one") } as never));
    const second = await collectSteps(new MockLanguageModelV4({ doStream: textStream("two") } as never));

    // Both are step 0 — the level that a stepNumber-only identity would merge.
    expect(first[0]?.stepNumber).toBe(0);
    expect(second[0]?.stepNumber).toBe(0);
    expect(first[0]?.callId).not.toBe(second[0]?.callId);
    expect(`${String(first[0]?.callId)}#0`).not.toBe(`${String(second[0]?.callId)}#0`);
  });

  // K — a retry (a second streamText) is a new callId under the same run.
  it("gives a retried attempt a new callId while the run identity is unchanged", async () => {
    const attemptOne = await collectSteps(new MockLanguageModelV4({ doStream: toolLoopStream() } as never));
    const attemptTwo = await collectSteps(new MockLanguageModelV4({ doStream: textStream("after recovery") } as never));

    expect(new Set([attemptOne[0]?.callId, attemptTwo[0]?.callId]).size).toBe(2);
    // `streamId` is owned by the route and identical across both attempts; it is
    // deliberately NOT derived from callId.
    expect(attemptOne[0]?.callId).not.toBe(attemptTwo[0]?.callId);
  });

  // J — provider response id is a different identity and must not be equated.
  it("keeps response.id distinct from the callId/stepNumber pair", async () => {
    const steps = await collectSteps(new MockLanguageModelV4({ doStream: toolLoopStream() } as never));

    // response.id varies per step; callId does not. Collapsing them would make
    // a per-step fact look like a per-run one.
    const responseIds = steps.map((s) => s.response?.id);
    expect(new Set(responseIds).size).toBe(2);
    expect(new Set(steps.map((s) => s.callId)).size).toBe(1);
    for (const responseId of responseIds) {
      expect(responseId).not.toBe(steps[0]?.callId);
    }
  });

  // J cont. — tool causality survives the join used by the funnel.
  it("exposes the requesting generation's tool call ids", async () => {
    const steps = await collectSteps(new MockLanguageModelV4({ doStream: toolLoopStream() } as never));

    const firstToolIds = (steps[0]?.content ?? [])
      .filter((part) => part.type === "tool-call")
      .map((part) => part.toolCallId);
    expect(firstToolIds).toEqual(["toolcall-xyz"]);
    // The answering step requested nothing.
    expect((steps[1]?.content ?? []).filter((part) => part.type === "tool-call")).toHaveLength(0);
  });

  // B/C cont. — a model invocation is bounded but callId is not re-minted.
  it("keeps one callId across many steps", async () => {
    let call = 0;
    const alwaysTool = () => {
      call += 1;
      return {
        stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { type: "tool-call", toolCallId: `toolcall-${call}`, toolName: "probe_tool", input: JSON.stringify({}) },
          { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage: USAGE },
        ] as never),
      };
    };

    const steps = await collectSteps(new MockLanguageModelV4({ doStream: alwaysTool } as never), 5);
    expect(steps.length).toBeGreaterThan(1);
    expect(new Set(steps.map((s) => s.callId)).size).toBe(1);
    expect(steps.map((s) => s.stepNumber)).toEqual(steps.map((_, index) => index));
  });

  it("carries model identity and provider usage on every generation", async () => {
    const steps = await collectSteps(new MockLanguageModelV4({ doStream: toolLoopStream() } as never));
    for (const step of steps) {
      expect(step.model?.provider).toBe("mock-provider");
      expect(step.model?.modelId).toBe("mock-model-id");
      // Normalized to the flat shape `chat.ts` reads.
      const usage = step.usage as
        | { inputTokens?: number; outputTokens?: number; totalTokens?: number }
        | undefined;
      expect(usage?.inputTokens).toBe(10);
      expect(usage?.outputTokens).toBe(5);
      expect(usage?.totalTokens).toBe(15);
    }
  });
});