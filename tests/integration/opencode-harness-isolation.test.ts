/**
 * Unit coverage for the pieces of the runtime harness that do not need a binary.
 *
 * The real-binary behaviour lives in `opencode-runtime-auth.test.ts` and
 * `opencode-stub-provider-spike.test.ts`. These cases pin the two things that
 * silently corrupted eight earlier attempts at this harness, and which no
 * assertion on a running server would have explained:
 *
 *  1. Isolating `XDG_CACHE_HOME` starves the models.dev catalogue, so a declared
 *     model never appears at all.
 *  2. OpenCode resolves its global config through `OPENCODE_CONFIG_DIR` ->
 *     `$XDG_CONFIG_HOME/opencode` -> `~/.config/opencode`, so pinning one of
 *     them is not enough to stay off the developer's real config.
 *
 * Plus the stub's own protocol: real SSE framing, and token counts that come
 * from a real encoder rather than a constant.
 */

import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encode } from "gpt-tokenizer";
import {
  createRuntimeIsolation,
  isolatedChildEnv,
  runtimeChildEnv,
} from "../harness/opencodeRuntimeHarness";
import {
  buildStubOpenCodeConfig,
  OPENCODE_V2_COMPATIBLE_PACKAGE,
  STUB_COMPACTION_BUFFER,
  STUB_COMPACTION_KEEP_TOKENS,
  STUB_CONTEXT_LIMIT,
  STUB_MODEL_ID,
  STUB_PROVIDER_ID,
} from "../harness/opencodeStubConfig";
import { startStubProvider, summariseStubRequest } from "../harness/opencodeStubProvider";

describe("runtime isolation: config is pinned, catalogue is not starved", () => {
  const isolation = createRuntimeIsolation("unit-isolation");

  it("creates the directories OpenCode's config resolution walks", () => {
    // $XDG_CONFIG_HOME/opencode is the middle term of OpenCode's precedence,
    // so both must exist for the isolated document to be discoverable.
    expect(isolation.configDir).toBe(path.join(isolation.xdgConfigHome, "opencode"));
    expect(fs.existsSync(isolation.configDir)).toBe(true);
    expect(fs.existsSync(isolation.homeDir)).toBe(true);
  });

  it("pins every name that can resolve a config document", () => {
    const env = isolatedChildEnv(isolation);
    expect(env.XDG_CONFIG_HOME).toBe(isolation.xdgConfigHome);
    expect(env.OPENCODE_CONFIG_DIR).toBe(isolation.configDir);
    expect(env.OPENCODE_CONFIG).toBe(isolation.configFile);
  });

  it("disables project config under both the v2 and legacy switches", () => {
    const env = isolatedChildEnv(isolation);
    expect(env.OPENCODE_CONFIG_PROJECT_DISABLE).toBe("1");
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1");
  });

  it("leaves the cache and data directories alone", () => {
    // The regression this guards: isolating XDG_CACHE_HOME empties the
    // models.dev catalogue, and OpenCode then lists zero models regardless of
    // what the config declares.
    const env = isolatedChildEnv(isolation);
    expect(env.XDG_CACHE_HOME).toBeUndefined();
    expect(env.XDG_DATA_HOME).toBeUndefined();
  });

  it("never mutates the parent environment", () => {
    const before = { ...process.env };
    isolatedChildEnv(isolation);
    expect(process.env).toEqual(before);
  });

  it("keeps the authentication credential intact", () => {
    const env = { ...isolatedChildEnv(isolation), ...runtimeChildEnv("pw") };
    expect(env.OPENCODE_PASSWORD).toBe("pw");
    expect(env.OPENCODE_SERVER_PASSWORD).toBe("pw");
  });

  it("gives each test its own tree, so nothing leaks between runs", () => {
    const other = createRuntimeIsolation("unit-isolation-other");
    expect(other.root).not.toBe(isolation.root);
    expect(other.configFile).not.toBe(isolation.configFile);
  });

  it("roots isolation in the OS temp dir, never in the working directory", () => {
    // The regression this guards: `createRuntimeIsolation` used to read
    // `process.env.TEMP` and fall back to `process.cwd()`, so on a runner with no
    // TEMP (Linux, or a Windows session that cleared it) every runtime test
    // would write its config and scratch state into the repository tree.
    const root = path.resolve(createRuntimeIsolation("unit-isolation-temp-safety").root);
    const tmp = path.resolve(os.tmpdir());
    const cwd = path.resolve(process.cwd());
    expect(root.startsWith(tmp + path.sep)).toBe(true);
    // Belt and braces: the tree must never be the working directory itself, even
    // in the pathological case where tmpdir sits inside it.
    expect(root === cwd).toBe(false);
  });
});

describe("stub config: v2 names, declared capabilities, sized compaction", () => {
  const config = buildStubOpenCodeConfig("http://127.0.0.1:1/v1") as {
    providers: Record<string, Record<string, unknown>>;
    compaction: Record<string, unknown>;
    model: string;
  };

  it("uses the v2 provider package, never the v1 aisdk: spelling", () => {
    // The v1 name is silently ignored by a v2 binary, which presents as "config
    // parsed but no models appeared" - the failure that cost eight attempts.
    expect(OPENCODE_V2_COMPATIBLE_PACKAGE).toBe("@opencode/ai/providers/openai-compatible");
    const provider = config.providers[STUB_PROVIDER_ID];
    expect(provider.package).toBe(OPENCODE_V2_COMPATIBLE_PACKAGE);
    expect(JSON.stringify(config)).not.toContain("aisdk:");
  });

  it("declares tool support instead of inheriting the fallback", () => {
    // A catalogue-absent model is ASSUMED tool-capable; asserting the
    // declaration keeps a silent fallback from becoming the proof.
    const model = config.providers[STUB_PROVIDER_ID].models as Record<
      string,
      { capabilities: { tools: boolean }; limit: { context: number } }
    >;
    expect(model[STUB_MODEL_ID].capabilities.tools).toBe(true);
    expect(model[STUB_MODEL_ID].limit.context).toBe(STUB_CONTEXT_LIMIT);
  });

  it("keeps the retained tail below the declared window", () => {
    // OpenCode keeps `keep.tokens` of recent conversation beside the summary.
    // At or above the whole window there is no room to compact into.
    const keep = (config.compaction.keep as { tokens: number }).tokens;
    expect(keep).toBe(STUB_COMPACTION_KEEP_TOKENS);
    expect(keep).toBeLessThan(STUB_CONTEXT_LIMIT);
    expect(config.compaction.auto).toBe(true);
    expect(config.compaction.buffer).toBe(STUB_COMPACTION_BUFFER);
  });

  it("selects the stub as the default so a bare session already uses it", () => {
    expect(config.model).toBe(`${STUB_PROVIDER_ID}/${STUB_MODEL_ID}`);
  });
});

describe("stub provider: real SSE, real token counts", () => {
  it("streams proper SSE framing terminated by [DONE]", async () => {
    const stub = await startStubProvider();
    try {
      const response = await fetch(`${stub.baseURL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
      });
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const body = await response.text();
      expect(body.startsWith("data: ")).toBe(true);
      expect(body).toContain('"object":"chat.completion.chunk"');
      expect(body.trimEnd().endsWith("data: [DONE]")).toBe(true);
    } finally {
      stub.stop();
    }
  });

  it("reports a token count derived from the prompt it received", async () => {
    const stub = await startStubProvider();
    try {
      await fetch(`${stub.baseURL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "m",
          messages: [{ role: "user", content: "a".repeat(400) }],
        }),
      });
      const request = stub.requests[0];
      // Measured with a real BPE encoder, so a longer prompt genuinely reports
      // more tokens. A constant here would make every occupancy proof vacuous.
      expect(request.promptTokens).toBe(encode(JSON.stringify(request.messages)).length);
      expect(request.promptTokens).toBeGreaterThan(encode("a".repeat(400)).length);
    } finally {
      stub.stop();
    }
  });

  it("records the tools it was offered, separately from the messages", async () => {
    const stub = await startStubProvider();
    try {
      await fetch(`${stub.baseURL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "m",
          messages: [{ role: "user", content: "hi" }],
          tools: [{ type: "function", function: { name: "bash" } }],
        }),
      });
      expect(stub.requests[0].offersTools).toBe(true);
      expect(stub.requests[0].tools[0]?.function?.name).toBe("bash");
    } finally {
      stub.stop();
    }
  });

  it("detects OpenCode's summarisation request from its actual wording", async () => {
    // Captured from a live request, because OpenCode rejects a compaction whose
    // reply lacks the template headings ("Compaction produced no summary").
    const stub = await startStubProvider();
    try {
      await fetch(`${stub.baseURL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "m",
          messages: [
            {
              role: "user",
              content:
                "You MUST summarize the conversation above into a structured summary that will be given to another agent to resume the work.",
            },
          ],
        }),
      });
      expect(summariseStubRequest(stub.requests[0])).toBe("summary");
      expect(summariseStubRequest({ messages: [{ role: "user", content: "hi" }] } as never)).toBe(
        "text",
      );
    } finally {
      stub.stop();
    }
  });

  it("answers a summarisation request with the required template headings", async () => {
    const stub = await startStubProvider();
    try {
      const response = await fetch(`${stub.baseURL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "m",
          messages: [
            {
              role: "user",
              content:
                "You MUST summarize the conversation above into a structured summary that will be given to another agent to resume the work.",
            },
          ],
        }),
      });
      const body = await response.text();
      for (const heading of [
        "## Objective",
        "## Requirements",
        "## Decisions",
        "## Work State",
        "## Next Move",
        "## Relevant Files",
        "## Important Context",
      ]) {
        expect(body).toContain(heading);
      }
    } finally {
      stub.stop();
    }
  });

  it("emits a tool call when asked, and recognises the tool-result turn", async () => {
    const stub = await startStubProvider({
      respond: (request) => (request.carriesToolResult ? "text" : "tool-call"),
    });
    try {
      const first = await fetch(`${stub.baseURL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "go" }] }),
      });
      const firstBody = await first.text();
      expect(firstBody).toContain('"tool_calls"');
      expect(firstBody).toContain('"finish_reason":"tool_calls"');

      await fetch(`${stub.baseURL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "m",
          messages: [
            { role: "user", content: "go" },
            { role: "tool", content: "file contents" },
          ],
        }),
      });
      expect(stub.toolResultRequests.length).toBe(1);
    } finally {
      stub.stop();
    }
  });

  it("serves the model-list probe the compatible runtime makes before use", async () => {
    const stub = await startStubProvider({ model: "listed-model" });
    try {
      const response = await fetch(`${stub.baseURL}/models`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { data: Array<{ id: string }> };
      expect(body.data[0]?.id).toBe("listed-model");
    } finally {
      stub.stop();
    }
  });
});
