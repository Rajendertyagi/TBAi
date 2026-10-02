/**
 * Generation-400 regression — `MODEL_IDENTITY_RE` must not invent a cause.
 *
 * ## The defect this pins
 *
 * The 4xx copy split distinguishes a provider that rejected the MODEL ("switch
 * model") from one that rejected the REQUEST ("start a new chat"). The pattern
 * that separated them ended with a loose clause:
 *
 *   \bmodel\b[^.]{0,80}\b(?:not found|…)\b
 *
 * `[^.]{0,80}` happily bridges ordinary English, so real gateway prose that
 * merely mentions the model and later says "not found" about something else was
 * reported as a model-identity failure — telling the user to switch models when
 * switching model would change nothing:
 *
 *   "The model output did not contain the required tool; not found"
 *     → modelIdentity = true  → "The provider rejected this model."
 *
 * That is the outcome the pattern's own comment called the worse error, because
 * a false positive lies to the user about the remedy. Telling someone to start a
 * new chat when the model is fine merely wastes their history.
 *
 * ## The rule these cases assert
 *
 * A message is model-identity ONLY when the words name the MODEL as the thing
 * that is missing, unknown, unsupported or nonexistent. Prose that mentions the
 * model and separately reports something else as not found must fall through to
 * the accurate provider-4xx copy.
 */
import { describe, it, expect } from "bun:test";
import { classifyError } from "../../src/lib/errors";
import { sanitizeStreamError } from "../../src/lib/redact";

const errWith = (message: string, status: number) => Object.assign(new Error(message), { status });

const MODEL_COPY = "The provider rejected this model. Pick another model or fix the provider's model id.";
const REQUEST_COPY_FRAGMENT = "Retrying the same message will not help";

describe("Generation-400: MODEL_IDENTITY_RE false positives", () => {
  it("does not read a request rejection as a model-identity failure", () => {
    // The exact counterexample found by the Generation-400 audit.
    const message = "The model output did not contain the required tool; not found";
    expect(classifyError(errWith(message, 400)).modelIdentity).toBeUndefined();
    expect(sanitizeStreamError(errWith(message, 400))).toContain(REQUEST_COPY_FRAGMENT);
  });

  it.each([
    "The model output did not contain the required tool; not found",
    "tool 'write_file' not found in the model output",
    "The model's tool list is unavailable for this request",
    "Invalid request: expected a model tool call but received text",
    "the requested tool does not exist for this model",
    "the model produced no tool call and the parser gave up",
    "Model returned an empty completion",
    "conversation not found",
    "Workspace outside the permitted root",
  ])("does not claim model identity for %j", (message) => {
    expect(classifyError(errWith(message, 400)).modelIdentity).toBeUndefined();
  });

  it.each([
    ["model context length exceeded", 400],
    ["context_length_exceeded", 400],
    ["rate_limit_error", 429],
    ["invalid_request_error", 400],
  ])("leaves %j on its own truthful copy", (message, status) => {
    const classified = classifyError(errWith(message, status));
    expect(classified.modelIdentity).toBeUndefined();
    expect(sanitizeStreamError(errWith(message, status))).not.toContain(MODEL_COPY);
  });
});

describe("Generation-400: MODEL_IDENTITY_RE true positives are preserved", () => {
  it.each([
    "model_not_found",
    "model not found",
    "model-not-found",
    "no such model",
    "unknown model",
    "unknown_model",
    "unsupported model",
    "unsupported_model",
    "invalid model",
    "Invalid model: gpt-nope",
    "The model x does not exist",
    "The model `claude-9` does not exist",
    "model: claude-nope not found",
    "The model claude-nope was not found",
    "The model claude-nope is deprecated",
  ])("still reports a rejected model for %j", (message) => {
    expect(classifyError(errWith(message, 404)).modelIdentity).toBe(true);
    expect(sanitizeStreamError(errWith(message, 404))).toBe(MODEL_COPY);
  });

  it("never overrides a category a refinement already claimed", () => {
    // `validation` and `config` share "invalid …" prose; the refinement wins.
    const classified = classifyError(errWith("invalid request: invalid model payload rejected", 400));
    expect(classified.category).toBe("validation");
    expect(classified.modelIdentity).toBeUndefined();
  });

  it("a model-identity flag never makes the failure retryable", () => {
    expect(classifyError(errWith("model_not_found", 404)).retryable).toBe(false);
  });
});