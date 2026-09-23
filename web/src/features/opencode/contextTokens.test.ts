import { describe, it, expect } from "bun:test";
import {
  selectOpenCodeRawTokens,
  toTokenUsage,
  type TokenThreadState,
} from "./contextTokens";

describe("toTokenUsage (OpenCode message tokens)", () => {
  it("prefers the server-reported total over part sums", () => {
    expect(
      toTokenUsage({ total: 232_000, input: 200_000, output: 32_000 }),
    ).toEqual({
      totalTokens: 232_000,
      inputTokens: 200_000,
      outputTokens: 32_000,
      reasoningTokens: undefined,
      cachedInputTokens: undefined,
    });
  });

  it("maps reasoning and cache reads, drops the write channel", () => {
    expect(
      toTokenUsage({
        total: 10_000,
        reasoning: 500,
        cache: { read: 3_000, write: 100 },
      }),
    ).toMatchObject({
      reasoningTokens: 500,
      cachedInputTokens: 3_000,
    });
  });

  it("sums parts only when no total exists", () => {
    expect(toTokenUsage({ input: 1_000, output: 500 })).toMatchObject({
      totalTokens: 1_500,
    });
  });

  it("returns undefined for empty, garbage, or negative payloads", () => {
    for (const bad of [
      undefined,
      null,
      42,
      "tokens",
      {},
      { input: 0, output: 0 },
      { input: -5 },
      { cache: "nope" },
    ]) {
      expect(toTokenUsage(bad)).toBeUndefined();
    }
  });
});

function frozenThread(
  messages: TokenThreadState["thread"]["messages"],
): TokenThreadState {
  const state: TokenThreadState = { thread: { messages } };
  // The selector must never mutate: freeze deeply, then prove the snapshot
  // still deep-equals after selection.
  const deepFreeze = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Object.isFrozen(value)) return;
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  };
  deepFreeze(state);
  return state;
}

describe("selectOpenCodeRawTokens (external-store stability contract)", () => {
  it("returns the identical reference on repeated calls (React #185 guard)", () => {
    const tokens = { total: 1_000, input: 800, output: 200 };
    const state = frozenThread([
      { role: "user", metadata: {} },
      { role: "assistant", metadata: { custom: { tokens } } },
    ]);
    const first = selectOpenCodeRawTokens(state);
    const second = selectOpenCodeRawTokens(state);
    expect(first).toBe(tokens);
    expect(Object.is(first, second)).toBe(true);
  });

  it("newest token-bearing assistant message wins, skipping user messages", () => {
    const older = { total: 100 };
    const newer = { total: 200 };
    const state = frozenThread([
      { role: "assistant", metadata: { custom: { tokens: older } } },
      { role: "user", metadata: {} },
      { role: "assistant", metadata: { custom: { tokens: newer } } },
    ]);
    expect(selectOpenCodeRawTokens(state)).toBe(newer);
  });

  it("returns undefined when no token-bearing message exists", () => {
    for (const state of [
      frozenThread([]),
      frozenThread([{ role: "user", metadata: {} }]),
      frozenThread([{ role: "assistant" }]),
      frozenThread([{ role: "assistant", metadata: null }]),
      frozenThread([{ role: "assistant", metadata: { custom: {} } }]),
      frozenThread([
        { role: "assistant", metadata: { custom: { tokens: undefined } } },
      ]),
    ]) {
      expect(selectOpenCodeRawTokens(state)).toBeUndefined();
    }
  });

  it("unrelated message changes do not manufacture a token object", () => {
    const tokens = { total: 500 };
    const before = frozenThread([
      { role: "assistant", metadata: { custom: { tokens } } },
    ]);
    // A new state identity (e.g. an appended user message) must still yield
    // the SAME store-held reference — never a copy.
    const after: TokenThreadState = {
      thread: {
        messages: [
          ...before.thread.messages,
          { role: "user", metadata: { custom: { text: "hi" } } },
        ],
      },
    };
    expect(selectOpenCodeRawTokens(after)).toBe(tokens);
  });

  it("never mutates the state it reads", () => {
    const state = frozenThread([
      { role: "assistant", metadata: { custom: { tokens: { total: 7 } } } },
    ]);
    const snapshot = JSON.stringify(state);
    selectOpenCodeRawTokens(state);
    selectOpenCodeRawTokens(state);
    expect(JSON.stringify(state)).toBe(snapshot);
  });
});
