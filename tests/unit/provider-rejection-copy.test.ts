/**
 * Provider-rejection error copy — the 4xx / model-identity split.
 *
 * Independent of the poisoned-history repair, and justified on its own: a
 * provider 4xx is non-retryable by policy (`config` is never retryable, and the
 * Direct route sets `DIRECT_MAX_RETRIES = 0`), yet the generic copy's first
 * clause is "Retry". It also conflated two causes that need OPPOSITE advice:
 * a rejected MODEL (switch model) versus a rejected REQUEST (retrying
 * re-sends the identical rejection).
 *
 * The cases below pin the split AND, just as importantly, that everything else
 * kept its existing copy — a copy change that quietly moved `validation`,
 * `database` or a workspace refusal would be a regression, not an improvement.
 */
import { describe, it, expect } from "bun:test";
import { classifyError } from "../../src/lib/errors";
import { sanitizeStreamError } from "../../src/lib/redact";

const errWith = (message: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), extra);

describe("model-identity rejection", () => {
  it.each([
    "model_not_found",
    "Invalid model: gpt-nope",
    "The model x does not exist",
    "unknown model",
    "unsupported model",
  ])("reports a rejected model for %j", (message) => {
    const copy = sanitizeStreamError(errWith(message, { status: 404 }));
    expect(copy).toBe(
      "The provider rejected this model. Pick another model or fix the provider's model id.",
    );
  });

  it("flags modelIdentity on the classification without changing the category", () => {
    const c = classifyError(errWith("model_not_found", { status: 404 }));
    expect(c.category).toBe("config");
    expect(c.modelIdentity).toBe(true);
    // Retry policy must be untouched by the flag: a bad model id is not a
    // transient fault, so a retry would fail identically.
    expect(c.retryable).toBe(false);
  });

  it("does not claim model identity for unrelated application 'not found' text", () => {
    // `config` also matches our own refusals. Misreporting one as a bad model id
    // would send the user to the wrong remedy.
    for (const message of ["Conversation not found", "Workspace outside the permitted root"]) {
      expect(classifyError(errWith(message)).modelIdentity).toBeUndefined();
    }
  });

  it("never sets modelIdentity when a refinement already claimed the category", () => {
    // `validation` and `config` share prose ("invalid …"), so the flag is checked
    // against the REFINED category; a claimed refinement must win outright.
    const c = classifyError(errWith("invalid request: invalid model payload rejected", { status: 400 }));
    expect(c.modelIdentity).toBeUndefined();
  });
});

describe("residual provider 4xx", () => {
  it.each([400, 404, 409, 422])("states that a %i will not be fixed by retrying", (status) => {
    const copy = sanitizeStreamError(errWith("Bad Request: messages[9].tool_calls[0] is invalid", { status }));
    expect(copy).toBe(
      "The provider rejected this request (HTTP 4xx) as invalid. Retrying the same message will not help — start a new chat or switch model.",
    );
  });

  it("does not offer a retry for a 5xx-classified provider failure either", () => {
    // Not the 4xx copy — a 5xx IS retryable — but it must not claim a retry is
    // the answer for a `config` bucket, which never is.
    const copy = sanitizeStreamError(errWith("bad configuration", { status: 400 }));
    expect(copy).toContain("Retrying the same message will not help");
  });
});

describe("unrelated copy is unchanged", () => {
  it.each([
    ["cancelled", "aborted", {}, "Generation stopped."],
    ["auth", "401 Unauthorized", {}, "API key"],
    ["rate limit", "429 slow down", {}, "rate limit"],
    ["network", "fetch failed", {}, "Network error"],
    ["timeout", "request timed out after 30s", { status: 408 }, "Network error"],
  ])("keeps the %s copy", (_label, message, extra, fragment) => {
    expect(sanitizeStreamError(errWith(message, extra))).toContain(fragment);
  });

  it("keeps the generic copy for a workspace refusal (our fault, not a provider 4xx)", () => {
    const copy = sanitizeStreamError(errWith("Workspace outside the permitted root"));
    expect(copy).toBe("Generation failed. Retry or pick another provider/model.");
  });

  it("keeps the generic copy for an unclassifiable failure", () => {
    expect(sanitizeStreamError(errWith("???"))).toBe(
      "Generation failed. Retry or pick another provider/model.",
    );
  });

  it("keeps the generic copy for a runtime fault", () => {
    expect(sanitizeStreamError(errWith("TypeError: x is not a function"))).toContain("Generation failed");
  });
});