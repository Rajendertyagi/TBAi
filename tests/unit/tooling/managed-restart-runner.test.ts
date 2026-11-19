/**
 * B1 root-cause regression: the managed-restart E2E runner hosts the stub model
 * provider in its own process. Driving Playwright with a synchronous child
 * (`spawnSync`) blocks that process's event loop, so the stub can never answer
 * OpenCode's model request — the prompt is admitted and delivered, but the LLM
 * step never starts and no assistant response is persisted.
 *
 * This test exercises the actual failing boundary, not a mock: it starts a real
 * in-process stub, runs a real child that calls it through `runChildAsync`, and
 * asserts the stub answered while the child was running. If the runner ever
 * regresses to a blocking spawn, the event loop is frozen, the child's fetch
 * times out, and this test fails.
 */
import { describe, expect, it } from "bun:test";
import { startStubProvider } from "../../harness/opencodeStubProvider.ts";
import { STUB_MODEL_ID } from "../../harness/opencodeStubConfig.ts";
import { runChildAsync } from "../../../scripts/run-managed-restart-e2e.ts";

describe("managed-restart E2E runner (B1 root cause)", () => {
  it("keeps the in-process stub responsive while a child process runs", async () => {
    const stub = await startStubProvider({ model: STUB_MODEL_ID, text: "OK" });
    try {
      const url = `${stub.baseURL}/chat/completions`;
      const body = JSON.stringify({
        model: STUB_MODEL_ID,
        messages: [{ role: "user", content: "ping" }],
      });
      // The child fetches the stub that lives in THIS process. This only works
      // if runChildAsync leaves this process's event loop free (async spawn).
      const code = await runChildAsync(
        process.execPath,
        [
          "-e",
          `fetch(${JSON.stringify(url)}, {method:"POST",headers:{"content-type":"application/json"},body:${JSON.stringify(body)}})` +
            `.then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(2))`,
        ],
        { stdio: "ignore" },
      );
      expect(code).toBe(0);
      expect(stub.requests.length).toBe(1);
    } finally {
      stub.stop();
    }
  }, 30_000);
});
