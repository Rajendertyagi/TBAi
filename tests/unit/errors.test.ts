import { describe, it, expect } from "bun:test";
import { classifyError } from "../../src/lib/errors";
import { sanitizeStreamError } from "../../src/lib/redact";
import { isRetryableError } from "../../src/services/scheduler/schedulerExecution";

const errWith = (message: string, extra: Record<string, unknown> = {}) => {
  const e = new Error(message);
  return Object.assign(e, extra);
};

describe("classifyError", () => {
  it("maps auth failures (non-retryable)", () => {
    for (const e of [
      errWith("Unauthorized", { status: 401 }),
      errWith("invalid_api_key", { statusCode: 403 }),
      errWith("No API key provided"),
    ]) {
      const c = classifyError(e);
      expect(c.category).toBe("auth");
      expect(c.retryable).toBe(false);
    }
    expect(classifyError(errWith("x", { status: 401 })).statusCode).toBe(401);
  });

  it("maps rate limits (retryable)", () => {
    const c = classifyError(errWith("429 Too Many Requests", { status: 429 }));
    expect(c.category).toBe("rate_limit");
    expect(c.retryable).toBe(true);
    expect(classifyError(errWith("quota exceeded")).retryable).toBe(true);
  });

  it("maps network and timeout (retryable)", () => {
    expect(classifyError(errWith("fetch failed")).category).toBe("network");
    expect(classifyError(errWith("fetch failed")).retryable).toBe(true);
    expect(classifyError(errWith("timed out", { status: 408 })).category).toBe("timeout");
  });

  it("marks aborts cancelled (conservative) while the scheduler still retries them", () => {
    const c = classifyError(errWith("The operation was aborted"));
    expect(c.category).toBe("cancelled");
    expect(c.retryable).toBe(false);
    // Legacy transport policy preserved at the scheduler boundary.
    expect(isRetryableError(errWith("connection aborted"))).toBe(true);
  });

  it("maps config failures (non-retryable)", () => {
    for (const msg of [
      "invalid model foo",
      "Workspace outside the permitted root",
      "user approval required",
      "Conversation not found",
    ]) {
      expect(classifyError(errWith(msg)).category).toBe("config");
      expect(classifyError(errWith(msg)).retryable).toBe(false);
    }
    expect(classifyError(errWith("bad", { status: 400 })).category).toBe("config");
  });

  it("maps tool failures and 5xx", () => {
    expect(classifyError(errWith("MCP tool returned an error")).category).toBe("tool");
    const p = classifyError(errWith("overloaded", { status: 500 }), { provider: "anthropic" });
    expect(p.category).toBe("provider");
    expect(p.retryable).toBe(true);
    expect(p.provider).toBe("anthropic");
    const u = classifyError(errWith("boom", { status: 500 }));
    expect(u.category).toBe("unknown");
    expect(u.retryable).toBe(true);
  });

  it("defaults unknown errors to non-retryable with the message preserved", () => {
    const c = classifyError(errWith("something bizarre"));
    expect(c.category).toBe("unknown");
    expect(c.retryable).toBe(false);
    expect(c.message).toBe("something bizarre");
    expect(c.errorType).toBe("Error");
  });
});

describe("sanitizeStreamError consumes classification", () => {
  it("renders stable copy per category", () => {
    expect(sanitizeStreamError(errWith("aborted"))).toBe("Generation stopped.");
    expect(sanitizeStreamError(errWith("401 Unauthorized"))).toContain("API key");
    expect(sanitizeStreamError(errWith("429 slow down"))).toContain("rate limit");
    expect(sanitizeStreamError(errWith("fetch failed"))).toContain("Network error");
    expect(sanitizeStreamError(errWith("tool call failed badly"))).toContain("tool call failed");
    expect(sanitizeStreamError(errWith("???"))).toContain("Generation failed");
  });
});

describe("isRetryableError delegates to classification", () => {
  it("matches legacy outcomes", () => {
    expect(isRetryableError(errWith("fetch failed"))).toBe(true);
    expect(isRetryableError(errWith("429"))).toBe(true);
    expect(isRetryableError(errWith("overloaded", { status: 503 }))).toBe(true);
    expect(isRetryableError(errWith("invalid api key"))).toBe(false);
    expect(isRetryableError(errWith("workspace escape"))).toBe(false);
    expect(isRetryableError(errWith("plain failure"))).toBe(false);
  });
});
