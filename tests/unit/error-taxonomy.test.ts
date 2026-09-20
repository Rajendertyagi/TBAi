/**
 * Extended error taxonomy.
 *
 * The classifier gained categories, but its RETRY POLICY must not have moved:
 * `retryable` is computed from the coarse category, so refining the label can
 * never change what the scheduler or the UI does. Both halves are pinned here —
 * the new labels AND the frozen legacy outcomes.
 */
import { describe, it, expect } from "bun:test";
import { classifyError } from "../../src/lib/errors";
import { sanitizeStreamError } from "../../src/lib/redact";
import { isRetryableError } from "../../src/services/scheduler/schedulerExecution";

const errWith = (message: string, extra: Record<string, unknown> = {}) => {
  const e = new Error(message);
  return Object.assign(e, extra);
};

describe("refined categories", () => {
  it("splits explicit validation rejections out of config", () => {
    for (const msg of ["Invalid request", "invalid query", "Invalid body"]) {
      expect(classifyError(errWith(msg)).category).toBe("validation");
    }
    // ...while a bare 4xx with no validation signal stays `config`.
    expect(classifyError(errWith("bad", { status: 400 })).category).toBe("config");
    // ...and the existing config markers are NOT reclassified.
    for (const msg of [
      "invalid model foo",
      "Workspace outside the permitted root",
      "user approval required",
      "Conversation not found",
    ]) {
      expect(classifyError(errWith(msg)).category).toBe("config");
    }
  });

  it("recognises database faults", () => {
    expect(classifyError(errWith("SQLITE_BUSY: database is locked")).category).toBe("database");
    expect(classifyError(errWith("no such table: messages")).category).toBe("database");
  });

  it("recognises lifecycle faults", () => {
    expect(classifyError(errWith("startup_failed")).category).toBe("lifecycle");
    expect(classifyError(errWith("port_bind_failed: EADDRINUSE")).category).toBe("lifecycle");
  });

  it("recognises runtime faults", () => {
    expect(classifyError(errWith("TypeError: x is not a function")).category).toBe("runtime");
    expect(classifyError(errWith("Cannot read properties of undefined")).category).toBe("runtime");
  });

  it("recognises stream/transport faults", () => {
    expect(
      classifyError(errWith("ERR_INCOMPLETE_CHUNKED_ENCODING")).category,
    ).toBe("transport");
    expect(
      classifyError(errWith("Invalid state: Controller is already closed")).category,
    ).toBe("transport");
  });

  it("leaves genuinely unknown errors unknown", () => {
    for (const msg of ["something bizarre", "plain failure", "boom"]) {
      expect(classifyError(errWith(msg)).category).toBe("unknown");
    }
  });
});

describe("retry policy is unchanged", () => {
  it("keeps the legacy retryable outcomes exactly", () => {
    expect(classifyError(errWith("fetch failed")).retryable).toBe(true);
    expect(classifyError(errWith("429 Too Many Requests", { status: 429 })).retryable).toBe(true);
    expect(classifyError(errWith("quota exceeded")).retryable).toBe(true);
    expect(classifyError(errWith("timed out", { status: 408 })).retryable).toBe(true);
    expect(classifyError(errWith("overloaded", { status: 500 })).retryable).toBe(true);
    expect(classifyError(errWith("invalid api key")).retryable).toBe(false);
    expect(classifyError(errWith("workspace escape")).retryable).toBe(false);
    expect(classifyError(errWith("plain failure")).retryable).toBe(false);
    expect(classifyError(errWith("The operation was aborted")).retryable).toBe(false);
  });

  it("does not make a refined category retryable by accident", () => {
    for (const msg of [
      "Invalid request",
      "SQLITE_BUSY: database is locked",
      "startup_failed",
      "TypeError: nope",
      "ERR_INCOMPLETE_CHUNKED_ENCODING",
    ]) {
      expect(classifyError(errWith(msg)).retryable).toBe(false);
    }
  });

  it("keeps the scheduler's documented abort divergence", () => {
    expect(isRetryableError(errWith("connection aborted"))).toBe(true);
    expect(isRetryableError(errWith("plain failure"))).toBe(false);
  });

  it("keeps user-facing copy unchanged for the new categories", () => {
    // No new switch case was added, so a refined category still renders the
    // default copy rather than silently changing what the user sees.
    expect(sanitizeStreamError(errWith("TypeError: nope"))).toContain("Generation failed");
    expect(sanitizeStreamError(errWith("SQLITE_BUSY"))).toContain("Generation failed");
  });
});

describe("billing distinction", () => {
  it("flags a credit failure while leaving the category and policy alone", () => {
    const credit = classifyError(errWith("insufficient balance: balance=0"));
    expect(credit.billing).toBe(true);
    expect(credit.retryable).toBe(false);
  });

  it("flags a quota failure WITHOUT turning it into a non-retryable error", () => {
    const quota = classifyError(errWith("quota exceeded"));
    // Distinguishable from a generic throttle...
    expect(quota.billing).toBe(true);
    // ...but the pre-existing retry policy is untouched.
    expect(quota.category).toBe("rate_limit");
    expect(quota.retryable).toBe(true);
  });

  it("omits the flag for ordinary failures", () => {
    expect(classifyError(errWith("fetch failed")).billing).toBeUndefined();
    expect(classifyError(errWith("bad", { status: 400 })).billing).toBeUndefined();
  });
});
