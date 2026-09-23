/**
 * MCP connection hardening — focused deterministic tests (no sleeps, no live servers).
 *
 * Covers: SSE probe classification (unreachable / non-SSE / 401 without auth /
 * 401 with auth / timeout / successful probe), status transitions, reconnect
 * boundedness, auth preserve/replace/clear persistence, authConfigured masking,
 * failureReason UI truthfulness, log secret-freedom, and the SSEClientTransport
 * constructor shape against the installed client v2.0.0.
 *
 * Local Bun HTTP fixtures only. One test waits ~3s for the probe timeout and
 * one waits ~6s past a single reconnect delay; both are bounded and
 * deterministic. The full 5×5s reconnect cap is covered by
 * tests/unit/mcp-manager.test.ts (run alongside, unmodified).
 */
import { describe, it, expect, afterAll } from "bun:test";
import { SSEClientTransport } from "@modelcontextprotocol/client";
import { mcpManager } from "../../src/services/mcp/manager";
import { classifySseFailure, safeEndpointMeta } from "../../src/services/mcp/classify";
import { decryptSecret, credentialStore } from "../../src/services/credentials";
import { db } from "../../src/db";
import { logger } from "../../src/lib/logger";
import { failureCopy } from "../../web/src/lib/mcpCopy";

// The credential store is initialized by src/server.ts in production; tests
// must initialize it explicitly (same as src/services/credentials.test.ts).
// Isolated per run via the tmp DATA_DIR from tests/setup.ts.
credentialStore.initialize();

const createdIds: string[] = [];
const servers: { stop: (closeActive?: boolean) => void }[] = [];

function track(id: string): string {
  createdIds.push(id);
  return id;
}

afterAll(async () => {
  for (const id of createdIds) {
    try {
      await mcpManager.disconnect(id);
    } catch {
      /* ignore */
    }
    try {
      mcpManager.deleteConfig(id);
    } catch {
      /* row already gone */
    }
  }
  for (const s of servers) {
    try {
      s.stop(true);
    } catch {
      /* ignore */
    }
  }
});

/** Bounded status poll (existing repo pattern): resolves when met, throws on expiry. */
async function waitForStatus(id: string, want: string, maxMs = 8000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const st = mcpManager.getStatuses().find((s) => s.id === id);
    if (st?.status === want) return;
    if (Date.now() - start > maxMs) {
      throw new Error(`server ${id} did not reach status ${want} (still ${st?.status})`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Deterministic closed port: bind an ephemeral port, then release it. */
function closedPort(): number {
  const tmp = Bun.serve({ port: 0, fetch: () => new Response("x") });
  const port = tmp.port;
  tmp.stop(true);
  return port;
}

function statusOf(id: string) {
  return mcpManager.getStatuses().find((s) => s.id === id);
}

describe("classifySseFailure (pure, no I/O)", () => {
  it("maps unreachable probe to unreachable", () => {
    expect(classifySseFailure({ kind: "unreachable" })).toBe("unreachable");
  });
  it("maps non-SSE 200 response to incompatible_response", () => {
    expect(
      classifySseFailure({ kind: "ok", status: 200, contentType: "application/json" }),
    ).toBe("incompatible_response");
  });
  it("maps 401 without a stored credential to auth_required", () => {
    expect(
      classifySseFailure({ kind: "ok", status: 401, contentType: null }, undefined, false),
    ).toBe("auth_required");
  });
  it("maps 401 with a stored credential to auth_failed", () => {
    expect(
      classifySseFailure({ kind: "ok", status: 401, contentType: null }, undefined, true),
    ).toBe("auth_failed");
  });
  it("maps 403 with a stored credential to auth_failed", () => {
    expect(
      classifySseFailure({ kind: "ok", status: 403, contentType: null }, undefined, true),
    ).toBe("auth_failed");
  });
  it("maps probe timeout to timeout", () => {
    expect(classifySseFailure({ kind: "timeout" })).toBe("timeout");
  });
  it("maps auth-shaped SDK errors to auth_failed", () => {
    expect(classifySseFailure({ kind: "error" }, new Error("401 Unauthorized"), true)).toBe(
      "auth_failed",
    );
  });
  it("maps unknown SDK errors to protocol_error, and nothing to unknown", () => {
    expect(classifySseFailure({ kind: "error" }, new Error("weird boom"))).toBe("protocol_error");
    expect(classifySseFailure({ kind: "error" })).toBe("unknown");
  });
});

describe("safeEndpointMeta", () => {
  it("exposes host/port/path and drops query strings", () => {
    const meta = safeEndpointMeta("http://localhost:8080/mcp/sse?token=secret-abc");
    expect(meta).toEqual({ host: "localhost", port: "8080", path: "/mcp/sse" });
  });
});

describe("SSEClientTransport constructor (installed v2.0.0)", () => {
  it("constructs with the requestInit options shape the manager uses", () => {
    const t = new SSEClientTransport(new URL("http://127.0.0.1:9/x"), {
      requestInit: { headers: { Authorization: "Bearer probe" } },
    });
    expect(t).toBeDefined();
  });
});

describe("SSE probe integration (local fixtures)", () => {
  it("unreachable endpoint → error/unreachable, never connected", async () => {
    const port = closedPort();
    const id = track(
      mcpManager.createConfig({
        name: "t-unreachable",
        transport: "sse",
        url: `http://127.0.0.1:${port}/mcp/sse`,
        enabled: true,
        autoConnect: false,
      }).id,
    );
    await mcpManager.connect(id);
    await waitForStatus(id, "error");
    const st = statusOf(id)!;
    expect(st.status).toBe("error");
    expect(st.failureReason).toBe("unreachable");
    expect(st.error ?? "").toContain(`127.0.0.1:${port}`);
    expect(st.status).not.toBe("connected");
    await mcpManager.disconnect(id);
  });

  it("non-SSE 200 response → error/incompatible_response", async () => {
    const srv = Bun.serve({
      port: 0,
      fetch: () => new Response(JSON.stringify({ hello: 1 }), {
        headers: { "content-type": "application/json" },
      }),
    });
    servers.push(srv);
    const id = track(
      mcpManager.createConfig({
        name: "t-nonsse",
        transport: "sse",
        url: `http://127.0.0.1:${srv.port}/mcp/sse`,
        enabled: true,
        autoConnect: false,
      }).id,
    );
    await mcpManager.connect(id);
    await waitForStatus(id, "error");
    expect(statusOf(id)!.failureReason).toBe("incompatible_response");
    await mcpManager.disconnect(id);
  });

  it("401 without credential → auth_failed/auth_required", async () => {
    const srv = Bun.serve({
      port: 0,
      fetch: () =>
        new Response("auth", {
          status: 401,
          headers: { "www-authenticate": 'Bearer resource_metadata="x"' },
        }),
    });
    servers.push(srv);
    const id = track(
      mcpManager.createConfig({
        name: "t-401-naked",
        transport: "sse",
        url: `http://127.0.0.1:${srv.port}/mcp/sse`,
        authType: "bearer",
        enabled: true,
        autoConnect: false,
      }).id,
    );
    await mcpManager.connect(id);
    await waitForStatus(id, "auth_failed");
    const st = statusOf(id)!;
    expect(st.status).toBe("auth_failed");
    expect(st.failureReason).toBe("auth_required");
    await mcpManager.disconnect(id);
  });

  it("401 with credential → auth_failed/auth_failed", async () => {
    const srv = Bun.serve({
      port: 0,
      fetch: () =>
        new Response("denied", {
          status: 401,
          headers: { "www-authenticate": 'Bearer resource_metadata="x"' },
        }),
    });
    servers.push(srv);
    const id = track(
      mcpManager.createConfig({
        name: "t-401-token",
        transport: "sse",
        url: `http://127.0.0.1:${srv.port}/mcp/sse`,
        authType: "bearer",
        authToken: "sentinel-auth-401-token-xyz",
        enabled: true,
        autoConnect: false,
      }).id,
    );
    await mcpManager.connect(id);
    await waitForStatus(id, "auth_failed");
    const st = statusOf(id)!;
    expect(st.status).toBe("auth_failed");
    expect(st.failureReason).toBe("auth_failed");
    // Truthfulness: a failed connection is never presented as healthy.
    expect(
      mcpManager.getStatuses().find((s) => s.id === id)?.status,
    ).not.toBe("connected");
    await mcpManager.disconnect(id);
  });

  it("successful SSE probe falls through to the SDK path (not unreachable)", async () => {
    // Finite SSE-shaped body: the probe passes, the SDK then fails on the
    // protocol handshake → protocol_error, proving the probe did not
    // short-circuit a reachable endpoint.
    const srv = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(": ping\n\n", { headers: { "content-type": "text/event-stream" } }),
    });
    servers.push(srv);
    const id = track(
      mcpManager.createConfig({
        name: "t-sse-shape",
        transport: "sse",
        url: `http://127.0.0.1:${srv.port}/mcp/sse`,
        enabled: true,
        autoConnect: false,
      }).id,
    );
    await mcpManager.connect(id);
    await waitForStatus(id, "error");
    expect(statusOf(id)!.failureReason).not.toBe("unreachable");
    await mcpManager.disconnect(id);
  });

  it("probe timeout → error/timeout", async () => {
    // Black-hole server: accepts the socket, never responds. The 3s probe
    // budget fires deterministically.
    const srv = Bun.serve({
      port: 0,
      fetch: () => new Promise<Response>(() => {}),
    });
    servers.push(srv);
    const id = track(
      mcpManager.createConfig({
        name: "t-probe-timeout",
        transport: "sse",
        url: `http://127.0.0.1:${srv.port}/mcp/sse`,
        enabled: true,
        autoConnect: false,
      }).id,
    );
    await mcpManager.connect(id);
    await waitForStatus(id, "error", 15000);
    expect(statusOf(id)!.failureReason).toBe("timeout");
    await mcpManager.disconnect(id);
  }, 20000);
});

describe("connection state transitions (stdio fixture)", () => {
  it("disconnected → connecting → connected → disconnected", async () => {
    const id = track(
      mcpManager.createConfig({
        name: "t-lifecycle",
        transport: "stdio",
        command: "bun",
        args: ["run", "tests/fixtures/everything-server.ts", "stdio"],
        enabled: true,
        autoConnect: false,
      }).id,
    );
    expect(statusOf(id)!.status).toBe("disconnected");
    await mcpManager.connect(id);
    await waitForStatus(id, "connected");
    expect(statusOf(id)!.failureReason).toBeUndefined();
    await mcpManager.disconnect(id);
    expect(statusOf(id)!.status).toBe("disconnected");
  }, 20000);
});

describe("reconnect stays bounded (no loops)", () => {
  it("failed connect settles in error; disconnect clears the pending timer", async () => {
    const port = closedPort();
    const id = track(
      mcpManager.createConfig({
        name: "t-bounded",
        transport: "sse",
        url: `http://127.0.0.1:${port}/mcp/sse`,
        enabled: true,
        autoConnect: false,
      }).id,
    );
    const cutoff = logger.lastSeq;
    await mcpManager.connect(id);
    await waitForStatus(id, "error");
    await mcpManager.disconnect(id);
    expect(statusOf(id)!.status).toBe("disconnected");
    // Past one 5s reconnect delay: no resurrection attempt after disconnect.
    await new Promise((r) => setTimeout(r, 6000));
    expect(statusOf(id)!.status).toBe("disconnected");
    const reconnects = logger
      .getRecentEntries(cutoff)
      .filter((e) => e.event === "mcp.operation" && e.op === "reconnect" && e.mcpServer === "t-bounded");
    expect(reconnects.length).toBe(0);
  }, 20000);
});

describe("auth persistence (preserve / replace / clear)", () => {
  function rawToken(id: string): string | null {
    const row = db
      .query<{ auth_token: string | null }, [string]>(
        "SELECT auth_token FROM mcp_servers WHERE id = ?",
      )
      .get(id);
    return row?.auth_token ?? null;
  }

  it("creation encrypts the token (never plaintext at rest)", () => {
    const id = track(
      mcpManager.createConfig({
        name: "t-auth-enc",
        transport: "sse",
        url: "http://127.0.0.1:9/x",
        authType: "bearer",
        authToken: "sentinel-plaintext-check-123",
        enabled: false,
        autoConnect: false,
      }).id,
    );
    const raw = rawToken(id);
    expect(raw).not.toBeNull();
    expect(raw).not.toContain("sentinel-plaintext-check-123");
    expect(decryptSecret(raw!)).toBe("sentinel-plaintext-check-123");
  });

  it("non-empty authToken replaces the stored credential", () => {
    const id = track(
      mcpManager.createConfig({
        name: "t-auth-replace",
        transport: "sse",
        url: "http://127.0.0.1:9/x",
        authType: "bearer",
        authToken: "sentinel-first-token",
        enabled: false,
        autoConnect: false,
      }).id,
    );
    const before = rawToken(id);
    mcpManager.updateConfig(id, { authToken: "sentinel-second-token" });
    const after = rawToken(id);
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
    expect(decryptSecret(after!)).toBe("sentinel-second-token");
  });

  it('explicit "" clears the stored credential to NULL', () => {
    const id = track(
      mcpManager.createConfig({
        name: "t-auth-clear",
        transport: "sse",
        url: "http://127.0.0.1:9/x",
        authType: "bearer",
        authToken: "sentinel-to-clear",
        enabled: false,
        autoConnect: false,
      }).id,
    );
    expect(rawToken(id)).not.toBeNull();
    mcpManager.updateConfig(id, { authToken: "" });
    expect(rawToken(id)).toBeNull();
    expect(statusOf(id)!.authConfigured).toBe(false);
  });

  it("omitted authToken preserves the stored credential on unrelated edits", () => {
    const id = track(
      mcpManager.createConfig({
        name: "t-auth-keep",
        transport: "sse",
        url: "http://127.0.0.1:9/x",
        authType: "bearer",
        authToken: "sentinel-keep-me",
        enabled: false,
        autoConnect: false,
      }).id,
    );
    const before = rawToken(id);
    mcpManager.updateConfig(id, { notes: "unrelated edit", name: "t-auth-keep-renamed" });
    expect(rawToken(id)).toBe(before);
    expect(decryptSecret(rawToken(id)!)).toBe("sentinel-keep-me");
  });
});

describe("status auth surface (no secret exposure)", () => {
  it("exposes authConfigured + masked hint, never the plaintext token", () => {
    const sentinel = "sentinel-never-exposed-789";
    const id = track(
      mcpManager.createConfig({
        name: "t-auth-surface",
        transport: "sse",
        url: "http://127.0.0.1:9/x",
        authType: "bearer",
        authToken: sentinel,
        enabled: false,
        autoConnect: false,
      }).id,
    );
    const st = statusOf(id)!;
    expect(st.authConfigured).toBe(true);
    expect(st.authHint).toBe("Bearer ••••••");
    expect(st.authHint).not.toContain(sentinel);
    expect(JSON.stringify(st)).not.toContain(sentinel);
  });

  it("unconfigured auth reports authConfigured false and no hint", () => {
    const id = track(
      mcpManager.createConfig({
        name: "t-auth-bare",
        transport: "sse",
        url: "http://127.0.0.1:9/x",
        authType: "bearer",
        enabled: false,
        autoConnect: false,
      }).id,
    );
    const st = statusOf(id)!;
    expect(st.authConfigured).toBe(false);
    expect(st.authHint).toBeUndefined();
  });
});

describe("failureCopy truthfulness", () => {
  it("maps every reason to its sentence, unknown to undefined", () => {
    expect(failureCopy("unreachable")).toContain("Cannot reach");
    expect(failureCopy("auth_required")).toContain("Authentication required");
    expect(failureCopy("auth_failed")).toContain("Authentication failed");
    expect(failureCopy("incompatible_response")).toContain("did not return an SSE stream");
    expect(failureCopy("timeout")).toContain("timed out");
    expect(failureCopy("protocol_error")).toContain("Protocol");
    expect(failureCopy("unknown")).toBeUndefined();
    expect(failureCopy(undefined)).toBeUndefined();
  });
});

describe("connect failure logs: diagnostics without secrets", () => {
  it("mcp.operation error entries carry failureReason + endpoint meta, never the token", async () => {
    const sentinel = "sentinel-log-secrecy-456";
    const port = closedPort();
    const cutoff = logger.lastSeq;
    const id = track(
      mcpManager.createConfig({
        name: "t-log-secrecy",
        transport: "sse",
        url: `http://127.0.0.1:${port}/mcp/sse`,
        authType: "bearer",
        authToken: sentinel,
        enabled: true,
        autoConnect: false,
      }).id,
    );
    await mcpManager.connect(id);
    await waitForStatus(id, "error");
    const entries = logger
      .getRecentEntries(cutoff)
      .filter((e) => e.event === "mcp.operation" && e.op === "connect" && e.mcpServer === "t-log-secrecy");
    expect(entries.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain(sentinel);
    expect(serialized).toContain("unreachable");
    expect(serialized).toContain("127.0.0.1");
    const withMeta = entries.filter(
      (e) => e.host === "127.0.0.1" && e.transport === "sse" && e.failureReason === "unreachable",
    );
    expect(withMeta.length).toBeGreaterThan(0);
    await mcpManager.disconnect(id);
  });
});
