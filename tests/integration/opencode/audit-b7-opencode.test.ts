import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import { OPENCODE_CONFIG } from "@/config/opencode.ts";
import {
  createRuntimeIsolation,
  runtimeTestsRequested,
  runtimeUnavailableReason,
  startRuntimeOpenCodeServer,
  type RuntimeOpenCodeServer,
} from "../../harness/opencodeRuntimeHarness.ts";

const reason = runtimeUnavailableReason();
const describeRuntime = runtimeTestsRequested() ? describe : describe.skip;

if (runtimeTestsRequested() && reason) {
  console.warn(`[opencode audit-b7] enabled but unavailable: ${reason}`);
}

describeRuntime("B7 Audit — Live OpenCode API Behavior & Replay Semantics", () => {
  let server: RuntimeOpenCodeServer;
  const isolation = createRuntimeIsolation("audit-b7-live");

  beforeAll(async () => {
    server = await startRuntimeOpenCodeServer(OPENCODE_CONFIG, {}, { isolation });
  }, 120_000);

  afterAll(async () => {
    await server?.stop();
  });

  it("inspects /api/event headers and Last-Event-ID behavior", async () => {
    const controller = new AbortController();
    const res1 = await fetch(`${server.baseUrl}/api/event`, {
      headers: server.headers,
      signal: controller.signal,
    });
    expect(res1.status).toBe(200);
    expect(res1.headers.get("content-type")).toContain("text/event-stream");

    const reader1 = res1.body!.getReader();
    const decoder = new TextDecoder();
    const { value } = await reader1.read();
    const text1 = decoder.decode(value);

    await reader1.cancel();
    controller.abort();

    // 2. Connect with Last-Event-ID header
    const controller2 = new AbortController();
    const res2 = await fetch(`${server.baseUrl}/api/event`, {
      headers: {
        ...server.headers,
        "Last-Event-ID": "test-id-123",
      },
      signal: controller2.signal,
    });
    expect(res2.status).toBe(200);

    const reader2 = res2.body!.getReader();
    const { value: val2 } = await reader2.read();
    const text2 = decoder.decode(val2);

    await reader2.cancel();
    controller2.abort();

    fs.writeFileSync(
      "audit-event-log.json",
      JSON.stringify({ text1, text2 }, null, 2),
      "utf8",
    );
  });

  it("inspects empty session list response shape", async () => {
    const res = await fetch(`${server.baseUrl}/api/session`, {
      headers: server.headers,
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    fs.writeFileSync("audit-session-list.json", JSON.stringify(json, null, 2), "utf8");
  });

  it("inspects message list response shape for a fresh session", async () => {
    const createRes = await fetch(`${server.baseUrl}/api/session`, {
      method: "POST",
      headers: { ...server.headers, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const sessionData = (await createRes.json()) as { data?: { id?: string }; id?: string };
    const sessionId = sessionData.data?.id ?? sessionData.id;
    expect(sessionId).toBeDefined();

    const msgRes = await fetch(`${server.baseUrl}/api/session/${sessionId}/message`, {
      headers: server.headers,
    });
    expect(msgRes.status).toBe(200);
    const msgJson = await msgRes.json();
    fs.writeFileSync("audit-message-list.json", JSON.stringify(msgJson, null, 2), "utf8");

    // Cleanup session
    await fetch(`${server.baseUrl}/api/session/${sessionId}`, {
      method: "DELETE",
      headers: server.headers,
    });
  });
});
