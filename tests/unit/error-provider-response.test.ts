/**
 * Provider-response conformance: `invalid_stream`.
 *
 * A provider that answers 200 with a body the SDK cannot use is a distinct
 * failure from a transport hiccup, and it needs its own category, its own user
 * copy, and its own retry advice. It is recognised by the AI SDK's error NAME.
 *
 * The two cases that shaped this design, both caught by an independent review of
 * the plan that first proposed it as a `refineCategory` refinement:
 *
 *  - `AI_TypeValidationError` ("Type validation failed…") is swallowed by
 *    `VALIDATION_RE`, whose first alternative is `/\bvalidation\b/`. As a
 *    refinement it would never have fired.
 *  - `AI_InvalidStreamPartError` on a tool-call delta matches `TOOL_SUBJECT_RE` ×
 *    `TOOL_OUTCOME_RE` and lands on `tool`. Tool-call deltas are the single most
 *    common malformed stream part, so that is the worst place to lose it.
 *
 * Both are pinned below as regressions, alongside the one intentional change to
 * retry policy.
 */
import { describe, it, expect } from "bun:test";
import { classifyError } from "../../src/lib/errors";
import { sanitizeStreamError } from "../../src/lib/redact";

/** An error carrying an SDK `name` and, optionally, a status — the real shape. */
const sdkError = (name: string, message: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), { name }, extra);

describe("invalid_stream — recognised from the SDK error name", () => {
  it("classifies every verified provider-response error name", () => {
    const names = [
      "AI_InvalidStreamPartError",
      "AI_StreamProviderError",
      "AI_InvalidResponseDataError",
      "AI_TypeValidationError",
      "AI_JSONParseError",
      "AI_EmptyResponseBodyError",
    ] as const;
    for (const name of names) {
      expect(classifyError(sdkError(name, "boom")).category).toBe("invalid_stream");
    }
  });

  it("REGRESSION: a schema-validation failure is not one of OUR validation errors", () => {
    // `VALIDATION_RE` matches "validation" in this message, so a refinement-based
    // implementation silently classified this as a rejected request.
    const classified = classifyError(
      sdkError("AI_TypeValidationError", "Type validation failed: expected string"),
    );
    expect(classified.category).toBe("invalid_stream");
  });

  it("REGRESSION: a malformed tool-call delta is not a tool failure", () => {
    const classified = classifyError(
      sdkError("AI_InvalidStreamPartError", "Invalid stream part: tool-call delta was truncated"),
    );
    expect(classified.category).toBe("invalid_stream");
  });

  it("outranks the transport prose that would otherwise claim a provider stream failure", () => {
    // `TRANSPORT_RE` matches "premature close"; `StreamProviderError` is more
    // specific and is the authoritative signal.
    expect(classifyError(sdkError("AI_StreamProviderError", "premature close of stream")).category).toBe(
      "invalid_stream",
    );
  });
});

describe("invalid_stream — the one intentional retry-policy change", () => {
  it("is NOT retryable: a response the SDK could not parse will not parse on a resend", () => {
    for (const name of ["AI_InvalidStreamPartError", "AI_JSONParseError"]) {
      expect(classifyError(sdkError(name, "boom")).retryable).toBe(false);
    }
  });

  it("CHANGED: a malformed stream part that mentions a fetch failure used to be retryable", () => {
    // Previously `network` / retryable:true, because `NETWORK_RE` matched
    // "fetch failed". Declared, not accidental — see the note in errors.ts.
    const classified = classifyError(
      sdkError("AI_InvalidStreamPartError", "fetch failed while streaming"),
    );
    expect(classified.category).toBe("invalid_stream");
    expect(classified.retryable).toBe(false);
  });

  it("leaves a genuine network error alone", () => {
    // No SDK name, so nothing changed for the case that genuinely is transient.
    const classified = classifyError(new Error("fetch failed: ENOTFOUND"));
    expect(classified.category).toBe("network");
    expect(classified.retryable).toBe(true);
  });
});

describe("invalid_stream — AI_APICallError must not swallow auth or rate limits", () => {
  it("keeps every failing status in its own category", () => {
    // Classifier fixtures, not modelled provider failures: the SDK builds
    // APICallError from handleErrorResponse for NON-2xx. The 2xx branch below is
    // defence; these three are the cases that would break if it were careless.
    expect(classifyError(sdkError("AI_APICallError", "nope", { statusCode: 401 })).category).toBe(
      "auth",
    );
    expect(classifyError(sdkError("AI_APICallError", "nope", { statusCode: 429 })).category).toBe(
      "rate_limit",
    );
    expect(
      classifyError(sdkError("AI_APICallError", "nope", { statusCode: 500 }), {
        provider: "openai",
      }).category,
    ).toBe("provider");
  });

  it("treats a 2xx call with an unusable body as a conformance fault", () => {
    expect(classifyError(sdkError("AI_APICallError", "bad body", { statusCode: 200 })).category).toBe(
      "invalid_stream",
    );
  });

  it("does NOT infer a conformance fault from a missing status", () => {
    // Absence of evidence is not evidence: no status, no claim.
    expect(classifyError(sdkError("AI_APICallError", "bad body")).category).not.toBe(
      "invalid_stream",
    );
  });
});

describe("invalid_stream — user copy", () => {
  it("does not tell the user to retry something that will fail identically", () => {
    const copy = sanitizeStreamError(sdkError("AI_InvalidStreamPartError", "bad part"));
    expect(copy).toContain("could not read");
    expect(copy).not.toMatch(/wait briefly/i);
    // The generic copy invites a pointless retry; this one must not.
    expect(copy).not.toBe("Generation failed. Retry or pick another provider/model.");
  });

  it("never leaks the raw provider message", () => {
    const raw = "PROVIDER_RAW_MARKER_a1b2c3";
    expect(sanitizeStreamError(sdkError("AI_JSONParseError", raw))).not.toContain(raw);
  });
});

describe("billing copy outranks rate-limit copy", () => {
  it("does not tell someone with no credit to wait and retry", () => {
    const copy = sanitizeStreamError(new Error("429 insufficient_quota: quota exceeded"));
    expect(copy).toMatch(/credit|billing/i);
    expect(copy).not.toMatch(/wait briefly/i);
  });

  it("still gives retry advice for a real rate limit", () => {
    expect(sanitizeStreamError(new Error("429 slow down"))).toMatch(/rate limit/i);
  });

  it("NEGATIVE: a rate-limit message that merely contains 402 is still a rate limit", () => {
    // `BILLING_RE` once matched a bare "402" with no boundary, so a request id or
    // byte count in the text would have produced "check your billing" and
    // suppressed the retry advice. Pinned in both directions.
    const copy = sanitizeStreamError(new Error("429 rate limited, retried 1402 times over 402ms"));
    expect(copy).toMatch(/rate limit/i);
    expect(copy).not.toMatch(/billing/i);
  });
});

describe("transport copy", () => {
  it("no longer falls through to the generic copy", () => {
    const copy = sanitizeStreamError(new Error("terminated: incomplete chunked encoding"));
    expect(copy).toContain("connection dropped");
    expect(copy).not.toBe("Generation failed. Retry or pick another provider/model.");
  });
});
