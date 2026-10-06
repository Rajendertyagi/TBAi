/**
 * `observedContextLength` — reading a window out of a provider's own overflow error.
 *
 * ## What is actually being protected
 *
 * Two failure modes, in opposite directions, and the second is far worse than the
 * first:
 *
 * 1. Returning nothing when a limit WAS stated. Costs one conversation's worth of
 *    the conservative stand-in. Recoverable, visible, honest.
 * 2. Returning the WRONG number. The verified error carries both the input size
 *    (950284) and the limit (524288). Learning the first would plan compaction
 *    against a window 80% larger than reality and report occupancy against a figure
 *    the provider never claimed — silently, with no error anywhere.
 *
 * So the negative cases below are the substance of this file, not the easy half.
 *
 * ## Two gates, both load-bearing
 *
 * The extractor refuses unless the error is ALREADY classified `context_overflow` by
 * the project's own `classifyError`, and unless a context-LABELLED figure is present.
 * The first gate reads the error `message` only — which is sufficient in practice,
 * because the SDK builds `message` from the provider body. A carrier whose overflow
 * wording exists ONLY in `responseBody` therefore contributes nothing, and that is
 * asserted below rather than assumed.
 */

import { describe, expect, it } from "bun:test";
import { classifyError } from "./errors";
import {
  MAX_OBSERVED_CONTEXT_TOKENS,
  MIN_OBSERVED_CONTEXT_TOKENS,
  observedContextLength,
} from "./context-window-observation";

/** The overflow wording the real gateway emits, reused to make a carrier eligible. */
const OVERFLOW_WORDING = "prompt is too long";

/** The verified real message, reproduced from the live gateway. */
const AGNES_MESSAGE = `***.ContextWindowExceededError: OpenAIException - {"object":"error","message":"The input (950284 tokens) is longer than the model's context length (524288 tokens).","type":"BadRequestError","code":400}\nmodel=agnes-2.5-flash`;

/** The verified real response body, which is JSON with the message embedded in it. */
const AGNES_BODY = `{"error":{"message":${JSON.stringify(AGNES_MESSAGE)},"type":"invalid_request_error","code":"400"}}`;

/** An `APICallError`-shaped carrier, which is what the transport actually hands over. */
function apiError(fields: Record<string, unknown>): Error {
  return Object.assign(new Error(String(fields.message ?? "provider error")), {
    name: "AI_APICallError",
    statusCode: 400,
    isRetryable: false,
    ...fields,
  });
}

describe("the verified provider error yields its stated limit", () => {
  it("reads the limit from the message carrier", () => {
    expect(observedContextLength(apiError({ message: AGNES_MESSAGE }))).toBe(524_288);
  });

  it("reads the limit when the body carries it too", () => {
    const error = apiError({ message: AGNES_MESSAGE, responseBody: AGNES_BODY });
    expect(observedContextLength(error)).toBe(524_288);
  });

  it("reads the limit when the parsed data carries it too", () => {
    const error = apiError({ message: AGNES_MESSAGE, data: JSON.parse(AGNES_BODY) });
    expect(observedContextLength(error)).toBe(524_288);
  });

  it("does NOT read the input size — the whole point of matching a label", () => {
    // Both numbers are present in the verified error. 950284 is the INPUT.
    const result = observedContextLength(apiError({ message: AGNES_MESSAGE }));
    expect(result).not.toBe(950_284);
    expect(result).toBe(524_288);
  });
});

describe("other providers' phrasings", () => {
  const cases: ReadonlyArray<readonly [string, number]> = [
    [`${OVERFLOW_WORDING}: this model's maximum context length is 200000 tokens`, 200_000],
    [`prompt is too long; context_length: 32768`, 32_768],
    [`${OVERFLOW_WORDING}. The context window is 1,000,000 tokens`, 1_000_000],
    [`input is too long; the context size is 8192 tokens`, 8_192],
    [`${OVERFLOW_WORDING}; maximum context length 262144`, 262_144],
    [`${OVERFLOW_WORDING}; context_length=131072`, 131_072],
  ];

  for (const [message, expected] of cases) {
    it(`reads ${expected} from: ${message.slice(0, 56)}…`, () => {
      expect(observedContextLength(apiError({ message }))).toBe(expected);
    });
  }
});

describe("never an arbitrary integer", () => {
  it("ignores a limit with no figure", () => {
    expect(observedContextLength(apiError({ message: `${OVERFLOW_WORDING}; maximum context length exceeded` }))).toBeUndefined();
  });

  it("ignores a model id that contains a large number", () => {
    const error = apiError({ message: "context-1048576-token-preview is overloaded", statusCode: 503 });
    expect(observedContextLength(error)).toBeUndefined();
  });

  it("ignores a byte count that merely sits near the keyword", () => {
    const error = apiError({ message: `${OVERFLOW_WORDING}; upstream returned 524288 bytes` });
    expect(observedContextLength(error)).toBeUndefined();
  });

  it("does not walk from the exception name across to an unrelated number", () => {
    // `ContextWindowExceededError` is a context keyword. An unbounded gap would let
    // the match run on to `950284` — the INPUT — and report it as the window.
    const error = apiError({ message: "ContextWindowExceededError: The input (950284 tokens) is too large" });
    expect(observedContextLength(error)).toBeUndefined();
  });

  it("ignores a timestamp that follows the keyword", () => {
    expect(observedContextLength(apiError({ message: `${OVERFLOW_WORDING}, built at 1773712345678` }))).toBeUndefined();
  });

  it("ignores a trace id that follows the keyword", () => {
    expect(observedContextLength(apiError({ message: `${OVERFLOW_WORDING}, trace id 9988776655443` }))).toBeUndefined();
  });

  it("ignores a figure that PRECEDES the keyword", () => {
    // "128000 maximum context length" states the input, then the phrase. Reading a
    // figure from before the label would be reading a different number entirely.
    const error = apiError({ message: "prompt is too long: 250000 tokens > 128000 maximum context length" });
    expect(observedContextLength(error)).toBeUndefined();
  });
});

describe("malformed and hostile input", () => {
  it("returns undefined for a truncated message", () => {
    expect(observedContextLength(apiError({ message: `${OVERFLOW_WORDING} (` }))).toBeUndefined();
  });

  it("returns undefined for an empty message", () => {
    expect(observedContextLength(apiError({ message: "" }))).toBeUndefined();
  });

  it("contributes nothing when the overflow wording exists only in the body", () => {
    // `classifyError` reads the message, and the SDK builds the message from the
    // provider body — so a body-only carrier is not provably an overflow.
    const error = apiError({ message: "request failed", responseBody: AGNES_BODY });
    expect(observedContextLength(error)).toBeUndefined();
  });

  it("contributes nothing when only the parsed data carries it", () => {
    const error = apiError({ message: "request failed", data: JSON.parse(AGNES_BODY) });
    expect(observedContextLength(error)).toBeUndefined();
  });

  it("returns undefined for a non-error value", () => {
    expect(observedContextLength(undefined)).toBeUndefined();
    expect(observedContextLength(null)).toBeUndefined();
    expect(observedContextLength(`${OVERFLOW_WORDING}; context length (524288 tokens)`)).toBeUndefined();
    expect(observedContextLength(42)).toBeUndefined();
  });

  it("rejects a figure below the plausible floor", () => {
    expect(observedContextLength(apiError({ message: `${OVERFLOW_WORDING}; context length is 512 tokens` }))).toBeUndefined();
    expect(observedContextLength(apiError({ message: `${OVERFLOW_WORDING}; context length is 0 tokens` }))).toBeUndefined();
  });

  it("rejects a figure above the plausible ceiling", () => {
    const huge = MAX_OBSERVED_CONTEXT_TOKENS + 1;
    expect(observedContextLength(apiError({ message: `${OVERFLOW_WORDING}; context length is ${huge} tokens` }))).toBeUndefined();
  });

  it("accepts the exact bounds, so the guard is a range and not an off-by-one", () => {
    const low = `${OVERFLOW_WORDING}; context length is ${MIN_OBSERVED_CONTEXT_TOKENS} tokens`;
    const high = `${OVERFLOW_WORDING}; context length is ${MAX_OBSERVED_CONTEXT_TOKENS} tokens`;
    expect(observedContextLength(apiError({ message: low }))).toBe(MIN_OBSERVED_CONTEXT_TOKENS);
    expect(observedContextLength(apiError({ message: high }))).toBe(MAX_OBSERVED_CONTEXT_TOKENS);
  });

  it("rejects a negative figure", () => {
    expect(observedContextLength(apiError({ message: `${OVERFLOW_WORDING}; context length is -524288` }))).toBeUndefined();
  });

  it("reads the integer part of a figure carrying a decimal tail", () => {
    expect(observedContextLength(apiError({ message: `${OVERFLOW_WORDING}; context length is 524288.5` }))).toBe(524_288);
  });
});
describe("only an overflow contributes a figure", () => {
  it("ignores an authentication failure", () => {
    expect(observedContextLength(apiError({ message: "invalid api key", statusCode: 401 }))).toBeUndefined();
  });

  it("ignores a rate limit that states no limit", () => {
    expect(observedContextLength(apiError({ message: "rate limit exceeded", statusCode: 429 }))).toBeUndefined();
  });

  it("ignores a server error that states no limit", () => {
    expect(observedContextLength(apiError({ message: "internal error", statusCode: 500 }))).toBeUndefined();
  });

  it("ignores an overflow-classified error that states no limit", () => {
    expect(observedContextLength(apiError({ message: "context window exceeded" }))).toBeUndefined();
  });

  it("inherits the project's text-based classification rather than judging status", () => {
    // `classifyError` classifies by MESSAGE TEXT and never reads the status code, so
    // any message mentioning a context window is an overflow whatever the HTTP status.
    // The extractor deliberately does not second-guess that: a second classifier here
    // would be a second authority, and disagreeing with it silently is the exact class
    // of bug this module exists to prevent. Asserted so the dependency is visible.
    const error = apiError({ message: "rate limit exceeded, context window is 524288 tokens", statusCode: 429 });
    expect(classifyError(error).category).toBe("context_overflow");
    expect(observedContextLength(error)).toBe(524_288);
  });
});