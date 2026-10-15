/**
 * F2 — Stdio environment isolation and stderr secret redaction regression tests.
 *
 * Verifies that:
 * 1. Parent-only secret variables are NOT inherited by a real spawned child process.
 * 2. Explicitly configured MCP server env vars ARE passed through to the child.
 * 3. Default environment variables (PATH, etc.) required to run commands exist.
 * 4. Secrets printed to stderr are redacted before being logged as diagnostics.
 */
import { describe, it, expect } from "bun:test";
import { buildTransport, redactStderr } from "@/services/mcp/transport.ts";
import { Client } from "@modelcontextprotocol/client";
import type { McpServerConfig } from "@/services/mcp/types.ts";
import { logger } from "@/lib/logger";

function config(partial: Partial<McpServerConfig>): McpServerConfig {
  return {
    id: "test-env-1",
    name: "test-env",
    transport: "stdio",
    command: "bun",
    args: [],
    authType: "none",
    enabled: true,
    autoConnect: false,
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}

describe("F2 — Stdio environment isolation (real child process)", () => {
  it("proves parent secrets are absent while configured variables reach the child process", async () => {
    const PARENT_SECRET_KEY = "TBAI_PARENT_SECRET_VAR_XYZ";
    const PARENT_SECRET_VAL = "super-secret-parent-token-12345";
    const CHILD_CONFIGURED_KEY = "TBAI_CHILD_EXPLICIT_VAR_ABC";
    const CHILD_CONFIGURED_VAL = "configured-explicit-child-val";

    // 1. Set parent-only secret in process.env
    process.env[PARENT_SECRET_KEY] = PARENT_SECRET_VAL;

    // We run an inline script that checks process.env and exits with code 0 if conditions are met
    // Condition:
    // - parent secret is ABSENT (undefined)
    // - child explicit config is PRESENT and equals CHILD_CONFIGURED_VAL
    // - PATH or Path exists (from getDefaultEnvironment())
    const checkScript = `
      import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
      import { McpServer } from "@modelcontextprotocol/server";
      import { z } from "zod";

      const server = new McpServer({ name: "env-check-server", version: "1.0.0" });
      server.registerTool("check_env", { description: "Returns inspected env" }, async () => {
        const hasParent = Boolean(process.env["${PARENT_SECRET_KEY}"]);
        const childVal = process.env["${CHILD_CONFIGURED_KEY}"] ?? null;
        const hasPath = Boolean(process.env.PATH || process.env.Path);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ hasParent, childVal, hasPath })
          }]
        };
      });

      await server.connect(new StdioServerTransport());
    `;

    try {
      const transport = buildTransport(
        config({
          command: "bun",
          args: ["-e", checkScript],
          env: {
            [CHILD_CONFIGURED_KEY]: CHILD_CONFIGURED_VAL,
          },
        }),
      );

      const client = new Client({ name: "test-env-client", version: "1.0.0" });
      await client.connect(transport);

      try {
        const res = await client.callTool({ name: "check_env", arguments: {} });
        const textBlock = (res.content as any[])[0]?.text;
        expect(textBlock).toBeDefined();
        const data = JSON.parse(textBlock);

        // Parent-only variable MUST be absent
        expect(data.hasParent).toBe(false);
        // Explicitly configured variable MUST be present
        expect(data.childVal).toBe(CHILD_CONFIGURED_VAL);
        // Default environment (PATH) MUST be preserved
        expect(data.hasPath).toBe(true);
      } finally {
        await client.close();
      }
    } finally {
      delete process.env[PARENT_SECRET_KEY];
    }
  }, 30000);

  it("redacts configured secrets and credential patterns (Bearer, Basic, assignments) from stderr before logging", async () => {
    const RAW_SECRET_1 = "very-confidential-api-token-98765";
    const RAW_SECRET_2 = "sk-ant-live01-1234567890abcdef1234567890abcdef";
    const BEARER_PADDED = "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdef==";
    const BASIC_AUTH = "Basic dXNlcm5hbWU6cGFzc3dvcmQ=";
    const ASSIGN_TOKEN = "token=sensitive_token_value_abc==";
    const ASSIGN_CLIENT_SECRET = "client_secret=my_client_secret_xyz123";
    const ASSIGN_SECRET_KEY = "secret_key: my_top_secret_key_456";
    const ASSIGN_AUTH = "authorization=Bearer eyJhbGciOiJIUzI1NiJ9.tokenpart==";

    // Unit check of redactStderr helper
    const textWithSecrets = `
      Error connecting to service:
      token: ${RAW_SECRET_1}
      key: ${RAW_SECRET_2}
      auth_bearer: ${BEARER_PADDED}
      auth_basic: ${BASIC_AUTH}
      assignment_1: ${ASSIGN_TOKEN}
      assignment_2: ${ASSIGN_CLIENT_SECRET}
      assignment_3: ${ASSIGN_SECRET_KEY}
      assignment_4: ${ASSIGN_AUTH}
      normal diagnostic output: connection refused at 127.0.0.1:8080
    `;

    const redacted = redactStderr(textWithSecrets, [RAW_SECRET_1]);

    // Complete credentials and token values must never appear
    expect(redacted).not.toContain(RAW_SECRET_1);
    expect(redacted).not.toContain(RAW_SECRET_2);
    expect(redacted).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(redacted).not.toContain("abcdef==");
    expect(redacted).not.toContain("dXNlcm5hbWU6cGFzc3dvcmQ=");
    expect(redacted).not.toContain("sensitive_token_value_abc==");
    expect(redacted).not.toContain("my_client_secret_xyz123");
    expect(redacted).not.toContain("my_top_secret_key_456");
    expect(redacted).not.toContain("tokenpart==");

    // Standard expected redaction replacements
    expect(redacted).toContain("Bearer [REDACTED]");
    expect(redacted).toContain("Basic [REDACTED]");
    expect(redacted).toContain("token=[REDACTED]");
    expect(redacted).toContain("client_secret=[REDACTED]");
    expect(redacted).toContain("secret_key:[REDACTED]");
    expect(redacted).toContain("authorization=[REDACTED]");
    expect(redacted).toContain("connection refused at 127.0.0.1:8080");

    // Real child process stderr regression test:
    const cutoff = logger.lastSeq;
    const serverName = "test-stderr-leak-prevention";
    const script = `
      console.error("FATAL: secret_key = ${RAW_SECRET_1}");
      console.error("Authorization: ${BEARER_PADDED}");
      console.error("Authorization: ${BASIC_AUTH}");
      console.error("token=${ASSIGN_TOKEN}");
      console.error("Server initialization failed normally");
      process.exit(1);
    `;

    const transport = buildTransport(
      config({
        name: serverName,
        command: "bun",
        args: ["-e", script],
        env: { MY_SECRET: RAW_SECRET_1 },
      }),
      "my-auth-token-4321",
    );

    const client = new Client({ name: "test-stderr-client", version: "1.0.0" });
    try {
      await client.connect(transport);
    } catch {
      // Expected to fail since child exits with 1
    }

    await new Promise((r) => setTimeout(r, 500));

    const stderrLogs = logger
      .getRecentEntries(cutoff)
      .filter((e) => e.event === "mcp.stdio_stderr" && e.mcpServer === serverName);

    expect(stderrLogs.length).toBeGreaterThanOrEqual(1);
    for (const log of stderrLogs) {
      const loggedOutput = log.output as string;
      expect(loggedOutput).not.toContain(RAW_SECRET_1);
      expect(loggedOutput).not.toContain("eyJhbGciOiJIUzI1NiJ9");
      expect(loggedOutput).not.toContain("abcdef==");
      expect(loggedOutput).not.toContain("dXNlcm5hbWU6cGFzc3dvcmQ=");
    }
  }, 30000);

  it("logs diagnostics incrementally while child is running and enforces discard-until-newline state machine", async () => {
    const cutoff = logger.lastSeq;
    const serverName = "test-incremental-diagnostics";

    // Script that:
    // 1. Emits a normal startup diagnostic line
    // 2. Emits an oversized line (> 4096 bytes) containing sensitive tokens
    // 3. Emits a subsequent safe line after the newline
    // 4. Sleeps to stay alive so we prove incremental logging occurs before process exit
    const oversizedChunk = `${"X".repeat(5000)}Bearer secret-overflow-token==\n`;
    const script = `
      console.error("INITIAL_STARTUP_LINE_OK");
      // Send oversized line with no intermediate newline
      process.stderr.write(${JSON.stringify(oversizedChunk)});
      console.error("SUBSEQUENT_HEALTHY_LOG_LINE");
      await new Promise((r) => setTimeout(r, 2000));
      process.exit(0);
    `;

    const transport = buildTransport(
      config({
        name: serverName,
        command: "bun",
        args: ["-e", script],
      }),
    );

    const client = new Client({ name: "test-inc-client", version: "1.0.0" });
    const connectPromise = client.connect(transport).catch(() => {});

    // Check after 600ms — process is still alive (it sleeps for 2000ms)
    await new Promise((r) => setTimeout(r, 800));

    const earlyLogs = logger
      .getRecentEntries(cutoff)
      .filter((e) => e.event === "mcp.stdio_stderr" && e.mcpServer === serverName);

    // Proves lines were emitted INCREMENTALLY while process was still sleeping
    const initialLog = earlyLogs.find((l) =>
      (l.output as string).includes("INITIAL_STARTUP_LINE_OK"),
    );
    expect(initialLog).toBeDefined();

    // Proves oversized line was discarded safely
    const discardNotice = earlyLogs.find((l) =>
      (l.output as string).includes("[discarded oversized stderr line]"),
    );
    expect(discardNotice).toBeDefined();

    // Proves sensitive overflow text in discarded line never leaked
    for (const log of earlyLogs) {
      expect((log.output as string).includes("secret-overflow-token")).toBe(false);
    }

    // Proves subsequent safe line AFTER the newline was captured cleanly
    const subsequentLog = earlyLogs.find((l) =>
      (l.output as string).includes("SUBSEQUENT_HEALTHY_LOG_LINE"),
    );
    expect(subsequentLog).toBeDefined();

    await connectPromise;
    try {
      await client.close();
    } catch {
      /* ignore */
    }
  }, 30000);
});
