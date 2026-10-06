/**
 * The Phase 1 spike gate, against the real `opencode serve`.
 *
 * ## What this proves
 *
 * That an isolated OpenCode environment can host a model TBAi controls, and that
 * a real conversation - including a real tool call and the tool-result turn that
 * follows - crosses the whole chain:
 *
 *   TBAi's session seam -> real opencode serve -> stub provider
 *
 * Everything except the upstream model is the real thing: a real child process,
 * real HTTP Basic auth, a real session, a real event stream.
 *
 * ## Why the model must be declared
 *
 * OpenCode v2 assumes tools-on and a 200,000-token window for any model absent
 * from the models.dev catalogue. Both fallbacks are asserted against here, so a
 * regression to the fallback is a failure rather than a silent 25x change in
 * when compaction would trigger.
 *
 * ## Gating
 *
 * Skipped unless `TBAI_OPENCODE_RUNTIME_TESTS=1` and a supported binary exists.
 * The default suite stays hermetic.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import {
  createRuntimeIsolation,
  runtimeTestsRequested,
  runtimeUnavailableReason,
  startRuntimeOpenCodeServer,
  type RuntimeIsolation,
  type RuntimeOpenCodeServer,
} from "../harness/opencodeRuntimeHarness";
import {
  buildStubOpenCodeConfig,
  STUB_CONTEXT_LIMIT,
  STUB_MODEL_ID,
  STUB_OUTPUT_LIMIT,
  STUB_PROVIDER_ID,
} from "../harness/opencodeStubConfig";
import {
  startStubProvider,
  summariseStubRequest,
  type StubProvider,
} from "../harness/opencodeStubProvider";

const reason = runtimeUnavailableReason();
const describeRuntime = runtimeTestsRequested() ? describe : describe.skip;

if (runtimeTestsRequested() && reason) {
  console.warn(`[opencode stub spike] enabled but unavailable: ${reason}`);
}

interface CatalogEntry {
  readonly id?: string;
  readonly providerID?: string;
  readonly limit?: { readonly context?: number; readonly output?: number };
}

describeRuntime("real OpenCode: an isolated stub provider serves a real turn", () => {
  let isolation: RuntimeIsolation;
  let stub: StubProvider;
  let server: RuntimeOpenCodeServer;
  let directory: string;

  beforeAll(async () => {
    stub = await startStubProvider({ model: STUB_MODEL_ID });
    isolation = createRuntimeIsolation("stub-spike");
    fs.writeFileSync(
      isolation.configFile,
      JSON.stringify(buildStubOpenCodeConfig(stub.baseURL), null, 2),
      "utf8",
    );
    server = await startRuntimeOpenCodeServer(undefined, {}, { isolation });
    directory = isolation.homeDir;
  }, 180_000);

  afterAll(async () => {
    await server?.stop();
    stub?.stop();
    fs.rmSync(isolation?.root ?? "", { recursive: true, force: true });
  });

  const api = <T,>(pathname: string): Promise<T> =>
    server.json<T>(pathname, { headers: { "x-opencode-directory": directory } });

  /**
   * Reads the model catalogue, waiting for the DECLARED model to appear.
   *
   * Waiting for a merely non-empty list is not enough: the models.dev catalogue
   * populates first, so an early read returns a full-looking list that does not
   * yet include a config-declared model. Polling for the specific id
   * distinguishes "still loading" from "this install has no models" without
   * inventing a fixed sleep.
   */
  const readCatalog = async (modelId = STUB_MODEL_ID): Promise<CatalogEntry[]> => {
    for (let attempt = 0; attempt < 90; attempt += 1) {
      const models = await api<{ data?: CatalogEntry[] }>("/api/model");
      const entries = models.data ?? [];
      if (entries.some((model) => model.id === modelId)) return entries;
      await Bun.sleep(500);
    }
    return (await api<{ data?: CatalogEntry[] }>("/api/model")).data ?? [];
  };

  /** The session under test, created once the server is up. */
  let sessionId: string | null = null;

  it("gate 1+9: starts on the isolated config, with no ambient project config", async () => {
    // The document list proves two things at once: our file is loaded, and the
    // developer's real global config is not. An `opencode.json` in the repository
    // root would also show up here, which is what makes this the contamination
    // check rather than just a presence check.
    const config = await api<Array<{ type: string; path: string }>>("/api/config");
    const documents = config.filter((entry) => entry.type === "document").map((e) => e.path);
    expect(documents).toContain(isolation.configFile);
    expect(documents.every((path) => path.startsWith(isolation.root))).toBe(true);
  });

  it("gate 2+10: the model is listed, and the models.dev catalogue still resolves", async () => {
    // The catalogue is why XDG_CACHE_HOME must NOT be isolated: an empty cache
    // means zero models are ever listed, whatever the config declares.
    const entries = await readCatalog();
    expect(entries.map((model) => model.id)).toContain(STUB_MODEL_ID);
  }, 120_000);

  it("gate 3+11: the declared limits are the ones OpenCode reports, not fallbacks", async () => {
    const stubModel = (await readCatalog()).find((model) => model.id === STUB_MODEL_ID);
    // Guards against silently inheriting the 200,000 fallback: automatic
    // compaction would then be ~150,000 tokens out of reach.
    expect(stubModel?.limit?.context).toBe(STUB_CONTEXT_LIMIT);
    expect(stubModel?.providerID).toBe(STUB_PROVIDER_ID);
    // The output ceiling is asserted from OpenCode's own runtime model, not from
    // the config file that declared it. That is the whole point of this gate: the
    // value has to survive the round trip through the binary, or the tiny output
    // window these tests rely on is not actually in force.
    expect(stubModel?.limit?.output).toBe(STUB_OUTPUT_LIMIT);
  }, 120_000);

  it("gate 4+5: the model is selectable and a real request reaches the stub", async () => {
    // POST /api/session returns the session INSIDE the response envelope; the
    // bare top-level `id` does not exist, so this must read `data.id`.
    const created = await server.json<{ data: { id: string } }>("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json", "x-opencode-directory": isolation.homeDir },
      body: JSON.stringify({}),
    });
    sessionId = created?.data?.id;
    expect(typeof sessionId).toBe("string");

    const headers = { "content-type": "application/json", "x-opencode-directory": isolation.homeDir };
    await server.json<unknown>(
      `/api/session/${sessionId}/model`,
      { method: "POST", headers, body: JSON.stringify({ model: { id: STUB_MODEL_ID, providerID: STUB_PROVIDER_ID } }) },
    );
    // Selection is proven by the session reporting the model back, not by the
    // 204: a switch that silently did nothing would look identical otherwise.
    const bound = await api<{ data: { model?: { id?: string; providerID?: string } } }>(
      `/api/session/${sessionId}`,
    );
    expect(bound.data.model?.providerID).toBe(STUB_PROVIDER_ID);
    expect(bound.data.model?.id).toBe(STUB_MODEL_ID);

    await server.json(`/api/session/${sessionId}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "hello" }),
    });

    // The stub is the proof that the request crossed OpenCode's provider
    // boundary; polling its recorded requests avoids a fixed sleep.
    for (let attempt = 0; attempt < 90 && stub.requests.length === 0; attempt += 1) {
      await Bun.sleep(500);
    }
    expect(stub.requests.length).toBeGreaterThan(0);
  }, 120_000);

  it("gate 8: the stub receives a real prompt, counted with a real tokenizer", async () => {
    const request = stub.requests[0];
    expect(request).toBeDefined();
    expect(request.messages.length).toBeGreaterThan(0);
    // Measured, not invented - this is what makes the occupancy proofs mean
    // anything later.
    expect(request.promptTokens).toBeGreaterThan(0);
    // A system role proves OpenCode sent its real prompt preamble rather than
    // the bare user text, so the count reflects an actual conversation.
    expect(request.messages.some((message) => message.role === "system")).toBe(true);
  });

  it("gate 12: OpenCode offered the provider a real, non-empty tools array", async () => {
    // Evidence is the recorded HTTP request, not the declared
    // `capabilities.tools: true`. Read off the wire, and WAIT for the right
    // request rather than the first one: OpenCode's initial upstream call is a
    // title generator that legitimately carries no `tools` array, so a gate that
    // simply inspected `requests[0]` would pass for the wrong reason. Only the
    // agent turns carry schemas, and they arrive after the title call.
    for (let attempt = 0; attempt < 120 && stub.requestsOfferingTools.length === 0; attempt += 1) {
      await Bun.sleep(500);
    }
    const offering = stub.requestsOfferingTools;
    expect(offering.length).toBeGreaterThan(0);
    const names = offering[0].tools.map((tool) => tool.function?.name);
    // `read` is the tool the tool-call gate drives, so its presence is what ties
    // "tools were offered" to "a tool could actually be invoked".
    expect(names).toContain("read");
    // And the offering must sit on a request carrying the agent preamble, which
    // is what distinguishes an agent turn from the title call.
    expect(offering.some((request) => request.messages.some((m) => m.role === "system"))).toBe(true);
  }, 120_000);

  it("gate 6+7: a tool call round trip completes, including the tool-result turn", async () => {
    // A second stub answers with a tool call so the round trip is driven by the
    // test, not by whatever the default reply happened to be.
    const toolStub = await startStubProvider({
      model: STUB_MODEL_ID,
      // Defer for compaction requests: OpenCode summarises with the session's
      // own model, and answering that with a tool call makes compaction fail
      // with "Compaction produced no summary".
      respond: (request) =>
        summariseStubRequest(request) === "summary"
          ? "summary"
          : request.carriesToolResult
            ? "text"
            : "tool-call",
    });
    const toolIsolation = createRuntimeIsolation("stub-toolcall");
    fs.writeFileSync(
      toolIsolation.configFile,
      JSON.stringify(buildStubOpenCodeConfig(toolStub.baseURL), null, 2),
      "utf8",
    );
    const toolServer = await startRuntimeOpenCodeServer(undefined, {}, { isolation: toolIsolation });
    const headers = {
      "content-type": "application/json",
      "x-opencode-directory": toolIsolation.homeDir,
    };
    try {
      for (let attempt = 0; attempt < 90; attempt += 1) {
        const models = await toolServer.json<{ data?: Array<{ id?: string }> }>("/api/model", {
          headers,
        });
        if ((models.data ?? []).some((model) => model.id === STUB_MODEL_ID)) break;
        await Bun.sleep(500);
      }
      const created = await toolServer.json<{ data: { id: string } }>("/api/session", {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });
      const toolSession = created.data.id;
      await toolServer.json(`/api/session/${toolSession}/model`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: { id: STUB_MODEL_ID, providerID: STUB_PROVIDER_ID } }),
      });
      await toolServer.json(`/api/session/${toolSession}/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({ text: "use a tool" }),
      });

      // Two requests are the round trip: the tool call, then the turn carrying
      // its result. Polling for the second avoids a fixed sleep.
      for (let attempt = 0; attempt < 120 && toolStub.toolResultRequests.length === 0; attempt += 1) {
        await Bun.sleep(500);
      }
      expect(toolStub.requests.length).toBeGreaterThanOrEqual(2);
      // The tool-result turn is real: OpenCode fed the tool's output back.
      expect(toolStub.toolResultRequests.length).toBeGreaterThan(0);
      const withResult = toolStub.toolResultRequests[0];
      expect(withResult.promptTokens).toBeGreaterThan(toolStub.requests[0].promptTokens);

      // And OpenCode drove the tool itself, recording a completed tool call.
      const messages = await toolServer.json<{ data: Array<Record<string, unknown>> }>(
        `/api/session/${toolSession}/message`,
        { headers },
      );
      const serialised = JSON.stringify(messages.data);
      expect(serialised).toContain("read");
      const idle = messages.data.filter((message) => message.type === "idle");
      expect(idle.some((message) => message.outcome === "succeeded")).toBe(true);
    } finally {
      await toolServer.stop();
      toolStub.stop();
      fs.rmSync(toolIsolation.root, { recursive: true, force: true });
    }
  }, 240_000);

  it("gate 6: a real request reached the stub and OpenCode accepted the reply", async () => {
    // Measured, not asserted from config: the stub received the prompt and
    // OpenCode recorded a SUCCEEDED assistant turn carrying its reported usage.
    // Tool availability is NOT re-asserted here: `stub.requests[0]` is OpenCode's
    // title-generator call, which legitimately carries no `tools` array. Gate 12
    // asserts the offering on the agent turns instead, which is where schemas
    // actually appear.
    expect(stub.requests.length).toBeGreaterThan(0);
    const messages = await server.json<{ data: Array<Record<string, unknown>> }>(
      `/api/session/${sessionId}/message`,
      { headers: { "x-opencode-directory": isolation.homeDir } },
    );
    const types = messages.data.map((message) => message.type);
    expect(types).toContain("assistant");
    const idle = messages.data.filter((message) => message.type === "idle");
    expect(idle.some((message) => message.outcome === "succeeded")).toBe(true);
  });
});
