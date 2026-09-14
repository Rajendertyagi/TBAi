import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import path from "path";
import os from "os";
import {
  redactFields,
  normalizeError,
  newRequestId,
  runWithRequestContext,
  getRequestContext,
  resolveLoggerConfig,
  logger,
} from "../../src/lib/logger";
import {
  sanitizeAiRequest,
  aiDebugRequestsEnabled,
} from "../../src/lib/ai-diagnostics";

// The global logger writes to console; silence it here so test output stays
// readable. Per-test behavior is verified through pure helpers + a scratch
// instance via configure().
beforeEach(() => {
  logger.configure({ level: "error", file: null });
});
afterEach(() => {
  logger.configure({ level: "error", file: null });
});

describe("levels + fields", () => {
  it("resolves dev/prod defaults and env overrides", () => {
    expect(resolveLoggerConfig({ NODE_ENV: "development" } as any).level).toBe("debug");
    expect(resolveLoggerConfig({ NODE_ENV: "production" } as any).level).toBe("info");
    expect(resolveLoggerConfig({ TBAI_LOG_LEVEL: "warn" } as any).level).toBe("warn");
    // Production must never default to debug (K).
    expect(resolveLoggerConfig({ NODE_ENV: "production" } as any).level).not.toBe("debug");
  });

  it("generates unique request ids", () => {
    const a = newRequestId();
    const b = newRequestId();
    expect(a.startsWith("req_")).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe("request correlation + isolation", () => {
  it("propagates context and isolates concurrent chains (C, D, E)", async () => {
    const seen: (string | undefined)[] = [];
    await Promise.all([
      (async () =>
        runWithRequestContext({ requestId: "req_A" }, async () => {
          await new Promise((r) => setTimeout(r, 20));
          seen.push(getRequestContext()?.requestId);
        }))(),
      (async () =>
        runWithRequestContext({ requestId: "req_B" }, async () => {
          await new Promise((r) => setTimeout(r, 5));
          seen.push(getRequestContext()?.requestId);
        }))(),
    ]);
    expect(seen.sort()).toEqual(["req_A", "req_B"]);
    expect(getRequestContext()).toBeUndefined();
  });
});

describe("error normalization (F)", () => {
  it("extracts type/message/status/code, dev-only stacks", () => {
    const err = new Error("boom") as Error & { statusCode?: number; code?: string };
    err.statusCode = 400;
    err.code = "INVALID_ARGUMENT";
    const norm = normalizeError(err, true);
    expect(norm.errorType).toBe("Error");
    expect(norm.message).toBe("boom");
    expect(norm.status).toBe(400);
    expect(norm.code).toBe("INVALID_ARGUMENT");
    expect(norm.stack).toBeTruthy();
    const prod = normalizeError(err, false);
    expect(prod.stack).toBeUndefined();
  });

  it("handles non-Error values without throwing", () => {
    expect(normalizeError("plain").message).toBe("plain");
    expect(normalizeError(42).errorType).toBe("number");
    expect(normalizeError(null).message).toBeTruthy();
  });
});

describe("redaction (G, H, I + negatives)", () => {
  it("redacts secret keys structurally", () => {
    const out = redactFields({
      event: "x",
      apiKey: "sk-abcdefgh12345678",
      nested: { password: "hunter2-hunter2", ok: "fine" },
    });
    expect(JSON.stringify(out)).not.toContain("sk-abcdefgh12345678");
    expect(JSON.stringify(out)).not.toContain("hunter2-hunter2");
    expect((out.nested as { ok: string }).ok).toBe("fine");
  });

  it("redacts Authorization headers and bearer tokens", () => {
    const out = redactFields({
      event: "x",
      headers: { authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig" },
    });
    expect(JSON.stringify(out)).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  it("never leaks the credential DEK material", () => {
    const dek = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
    const out = redactFields({ event: "x", key_hex: dek, apiKey: "AIzaSyD-1234567890abcdef1234" });
    const s = JSON.stringify(out);
    expect(s).not.toContain(dek);
    expect(s).not.toContain("AIzaSyD-1234567890abcdef1234");
  });

  it("redacts credential-shaped values inside free text", () => {
    const out = redactFields({ event: "x", message: "key=xoxb-1234567890-abcdefghij hi" });
    expect(JSON.stringify(out)).not.toContain("xoxb-1234567890");
  });
});

describe("sanitized AI diagnostics (J + negatives)", () => {
  const secretText = "my password is hunter2-hunter2 and card 4111";
  const messages = [
    { role: "user", content: [{ type: "text", text: secretText }] },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "write_file",
          input: { path: "a.txt", content: secretText },
          providerOptions: { google: { thoughtSignature: "sig-abc-123" } },
        },
      ],
    },
  ];
  const tools = {
    write_file: { parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } } } },
  };

  it("keeps structure, drops user text and secrets", () => {
    const rec = sanitizeAiRequest({ provider: "google", model: "m", messages, tools });
    const s = JSON.stringify(rec);
    expect(s).not.toContain("hunter2");
    expect(s).not.toContain("sig-abc-123");
    expect(s).not.toContain("4111");
    // Structure preserved for diagnosis:
    expect(rec.nMessages).toBe(2);
    expect(rec.nTools).toBe(1);
    expect(s).toContain("write_file");
    expect(s).toContain("tool-call");
    expect(s).toContain("required");
    expect(s).toContain("[text:");
  });

  it("marks thought-signature presence without the value", () => {
    const rec = sanitizeAiRequest({ messages, tools: {} });
    const s = JSON.stringify(rec);
    expect(s).toContain('"present":true');
    expect(s).not.toContain("sig-abc-123");
  });

  it("keeps approval ids/decisions for call matching", () => {
    const rec = sanitizeAiRequest({
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool-approval-response",
              approvalId: "ap-1",
              approved: false,
              reason: "no",
            },
          ],
        },
      ],
      tools: {},
    });
    const s = JSON.stringify(rec);
    expect(s).toContain("ap-1");
    expect(s).toContain("tool-approval-response");
  });

  it("debug diagnostics are off by default", () => {
    expect(aiDebugRequestsEnabled({} as any)).toBe(false);
    expect(aiDebugRequestsEnabled({ AI_DEBUG_REQUESTS: "true" } as any)).toBe(true);
    expect(aiDebugRequestsEnabled({ AI_DEBUG_REQUESTS: "1" } as any)).toBe(false);
  });
});

describe("file rotation (L)", () => {
  it("rotates bounded generations instead of growing forever", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-logtest-"));
    const file = path.join(dir, "tbai.log");
    const { logger: fresh } = await import("../../src/lib/logger");
    fresh.configure({ level: "debug", file, fileEnabled: true, maxBytes: 300, keepFiles: 2 });
    try {
      // Batched writer: rotation is checked pre-append per flush, so emit in
      // rounds. Two rounds rotate once without deleting anything (keepFiles 2),
      // which proves rotation happened, generations stay bounded, and no lines
      // are lost across the split.
      for (let round = 0; round < 2; round++) {
        for (let i = 0; i < 10; i++) {
          fresh.info("test", "rotation_probe", { message: `line-${i}-padding-xxxxxxxxxxxx` });
        }
        fresh.flushFileLines();
      }
      const names = fs.readdirSync(dir).sort();
      expect(names.length).toBeLessThanOrEqual(3);
      expect(names).toContain("tbai.log");
      expect(names).toContain("tbai.log.1");
      const lines = names.flatMap((f) =>
        fs.readFileSync(path.join(dir, f), "utf-8").trim().split("\n").filter(Boolean),
      );
      expect(lines).toHaveLength(20);
    } finally {
      fresh.configure({ level: "error", file: null });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
