import { describe, expect, test } from "bun:test";
import { redact, sanitizeStreamError } from "../../src/lib/redact";

// P1/P2 regression: error sanitization never leaks secrets and maps to stable copy.
// NOTE (for test agent): abort/resumable/metadata/search/load-more/roots cases
// need a running server + provider key; see the reconciliation report §11 test briefs.
describe("reconciliation: stream error sanitization", () => {
  test("auth failures map to credentials copy", () => {
    expect(sanitizeStreamError(new Error("401 Unauthorized"))).toMatch(/credentials/i);
    expect(sanitizeStreamError(new Error("invalid_api_key"))).toMatch(/credentials/i);
  });

  test("rate-limit maps to rate-limit copy", () => {
    expect(sanitizeStreamError(new Error("429 rate limit exceeded"))).toMatch(/rate limit/i);
  });

  test("abort maps to stopped copy", () => {
    expect(sanitizeStreamError(new Error("The operation was aborted"))).toMatch(/stopped/i);
  });

  test("network failure maps to network copy", () => {
    expect(sanitizeStreamError(new Error("fetch failed: ENOTFOUND"))).toMatch(/network/i);
  });

  test("generic failure maps to retry copy", () => {
    expect(sanitizeStreamError(new Error("something odd"))).toMatch(/retry/i);
  });

  test("sanitized copy contains no secret material", () => {
    const out = sanitizeStreamError(new Error("401 bad key sk-abcdefgh12345678"));
    expect(out).not.toContain("sk-abcdefgh12345678");
    expect(redact("api_key=supersecretvalue123")).not.toContain("supersecretvalue123");
  });
});
