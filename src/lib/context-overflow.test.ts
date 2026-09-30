/**
 * Context-overflow classification.
 *
 * Phase 1 finding F7: an oversized request was classified into the generic
 * `config` bucket and the user was told "Generation failed. Retry or pick another
 * provider/model." That message is both wrong and unactionable - retrying an
 * oversized request reproduces it exactly - and with `DIRECT_MAX_RETRIES = 0`
 * (`chat.ts:54-55`) nothing retried it either.
 *
 * These tests pin the new classification AND the regressions that must not
 * happen: an auth failure, a quota failure, a cancelled run, and a genuine
 * configuration error must all still classify as they did.
 */

import { describe, expect, it } from "bun:test";
import { classifyError } from "./errors";
import { sanitizeStreamError } from "./redact";

function provider400(message: string): Error {
  const err = new Error(message) as Error & { statusCode?: number };
  err.statusCode = 400;
  return err;
}

describe("context overflow is its own category", () => {
  it("classifies Anthropic's wording", () => {
    expect(classifyError(provider400("prompt is too long: 250000 tokens > 200000 maximum")).category).toBe(
      "context_overflow",
    );
  });

  it("classifies OpenAI's wording", () => {
    expect(classifyError(provider400("This model's maximum context length is 8192 tokens")).category).toBe(
      "context_overflow",
    );
  });

  it("classifies the reduce-the-length advice", () => {
    expect(
      classifyError(provider400("Please reduce the length of the messages to fit the context window")).category,
    ).toBe("context_overflow");
  });

  it("classifies Google's wording", () => {
    expect(classifyError(provider400("input length exceeds the maximum number of input tokens")).category).toBe(
      "context_overflow",
    );
  });

  it("classifies even when the message carries no status", () => {
    expect(classifyError(new Error("context window exceeded")).category).toBe("context_overflow");
  });

  it("is NOT retryable - resending an oversized request reproduces it", () => {
    const classified = classifyError(provider400("prompt is too long"));
    expect(classified.retryable).toBe(false);
  });
});

describe("overflow does not swallow neighbouring conditions", () => {
  it("still classifies an auth failure as auth", () => {
    const err = new Error("401 invalid api key") as Error & { statusCode?: number };
    err.statusCode = 401;
    expect(classifyError(err).category).toBe("auth");
  });

  it("still classifies a bare 401 as auth, even if the text mentions tokens", () => {
    // The 401 status is the authority; an overflow pattern must not win over it.
    const err = new Error("Unauthorized: token count exceeds allowance") as Error & { statusCode?: number };
    err.statusCode = 401;
    expect(classifyError(err).category).toBe("auth");
  });

  it("still classifies a rate limit as a rate limit", () => {
    const err = new Error("429 rate limit reached") as Error & { statusCode?: number };
    err.statusCode = 429;
    expect(classifyError(err).category).toBe("rate_limit");
  });

  it("still classifies a quota error as a rate limit, not a size problem", () => {
    // "exceeded your current quota" and a token-limit message can co-occur.
    const err = new Error("429 You exceeded your current quota, please check your plan and token usage") as Error & {
      statusCode?: number;
    };
    err.statusCode = 429;
    expect(classifyError(err).category).toBe("rate_limit");
  });

  it("still classifies a cancellation as cancelled", () => {
    expect(classifyError(new Error("the operation was aborted")).category).toBe("cancelled");
  });

  it("still classifies a genuine configuration error as config", () => {
    const err = new Error("invalid model: gpt-nope") as Error & { statusCode?: number };
    err.statusCode = 400;
    expect(classifyError(err).category).toBe("config");
  });

  it("still classifies a validation rejection as validation", () => {
    const err = new Error("invalid request body") as Error & { statusCode?: number };
    err.statusCode = 400;
    expect(classifyError(err).category).toBe("validation");
  });
});

describe("the user-facing message is actionable", () => {
  it("names the actual cause instead of blaming the provider", () => {
    const message = sanitizeStreamError(provider400("prompt is too long"));
    expect(message.toLowerCase()).toContain("too long");
    expect(message).not.toBe("Generation failed. Retry or pick another provider/model.");
  });

  it("offers both real remedies", () => {
    const message = sanitizeStreamError(provider400("prompt is too long"));
    expect(message).toMatch(/new chat/i);
    expect(message).toMatch(/larger context/i);
  });

  it("does not advise a retry, which would reproduce the failure", () => {
    expect(sanitizeStreamError(provider400("prompt is too long"))).not.toMatch(/\bretry\b/i);
  });
});
