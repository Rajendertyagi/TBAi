import { describe, it, expect } from "bun:test";
import { ensureOpenCodeSession } from "@/services/opencode/sessions.ts";

describe("ensureOpenCodeSession", () => {
  it("rejects a missing conversation without spawning OpenCode", async () => {
    // Error path: no OpenCode server is started for an unknown conversation, so
    // this validates the guard without requiring the binary.
    await expect(ensureOpenCodeSession("does-not-exist-000")).rejects.toThrow();
  });
});
