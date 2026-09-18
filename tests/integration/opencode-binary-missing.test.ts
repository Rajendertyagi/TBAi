/**
 * OpenCode missing-binary surface:
 *   - findOpenCodeBinary: a path when the CLI is on PATH, null when not
 *     (hermetic: Bun.which is patched per-case, never read for real)
 *   - OpenCodeBinaryMissingError: stable name + config-owned message
 *   - /api/opencode/session + /api/opencode/capabilities map that error to
 *     an actionable 503 (never a generic 500, never a hang)
 *
 * Environment rule: the 503 mapping tests SKIP when an `opencode` binary IS
 * present on this machine — verified live via Bun.which at runtime, never
 * assumed. The hermetic unit tests above cover both resolution branches
 * regardless, so skipping loses no coverage of the pure functions.
 */
import { describe, it, expect } from "bun:test";
import {
  findOpenCodeBinary,
  OpenCodeBinaryMissingError,
  openCodeServerManager,
} from "../../src/services/opencode/serverManager";
import { OPENCODE_CONFIG } from "../../src/config/opencode";
import { conversationService } from "../../src/services/storage";

// Patch the server manager's ensureBaseUrl to throw the binary-missing error,
// so every OpenCode surface takes its 503 branch without spawning a process
// or doing network I/O (hermetic).
(
  openCodeServerManager as unknown as {
    ensureBaseUrl: () => Promise<string>;
  }
).ensureBaseUrl = () => Promise.reject(new OpenCodeBinaryMissingError());

describe("findOpenCodeBinary — resolves the CLI via PATH (hermetic)", () => {
  it("returns the resolved path when the binary is on PATH", () => {
    expect(findOpenCodeBinary(() => "/fake/bin/opencode")).toBe(
      "/fake/bin/opencode",
    );
  });

  it("returns null when the binary is not installed (edge: absent PATH entry)", () => {
    expect(findOpenCodeBinary(() => null)).toBeNull();
  });

  it("queries PATH for the config-owned binary name", () => {
    // The function must look up exactly OPENCODE_CONFIG.binaryName — a
    // hardcoded name would break when the config changes.
    let queried = "";
    findOpenCodeBinary((name) => {
      queried = name;
      return "/wherever";
    });
    expect(queried).toBe(OPENCODE_CONFIG.binaryName);
  });
});

describe("OpenCodeBinaryMissingError — stable identity + config-owned message", () => {
  it("carries the config's actionable message", () => {
    const err = new OpenCodeBinaryMissingError();
    expect(err.name).toBe("OpenCodeBinaryMissingError");
    expect(err.message).toBe(OPENCODE_CONFIG.binaryMissingError);
    // The message names the CLI so the user knows what to install.
    expect(err.message).toMatch(/opencode/i);
  });

  it("is an instanceof Error so route classification can narrow on it", () => {
    const err = new OpenCodeBinaryMissingError();
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(OpenCodeBinaryMissingError);
  });
});

/** Drive the real Hono route in-process (no server, no network). */
async function requestRoute(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const { default: app } = await import("../../src/routes/opencode");
  return app.request(`http://localhost${path}`, init);
}

// Real binary present on THIS machine? The live-mapping tests skip when it
// is (plain read — never patched).
const realBinaryPath = Bun.which(OPENCODE_CONFIG.binaryName);

// The 503 mapping is environment-dependent: it only fires when the binary is
// actually absent. When installed, these tests would spawn a real server and
// return 200 — wrong outcome to assert here — so they skip.
describe("/api/opencode/* 503 mapping (skipped when the binary is installed)", () => {
  it("GET /api/opencode/capabilities → 503 with the actionable message", async () => {
    if (realBinaryPath) {
      console.log(
        `[skip] opencode binary present at ${realBinaryPath}; 503 mapping not exercisable`,
      );
      return;
    }
    const res = await requestRoute("/api/opencode/capabilities");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe(OPENCODE_CONFIG.binaryMissingError);
  });

  it("POST /api/opencode/session → 503 with the actionable message", async () => {
    if (realBinaryPath) {
      console.log(
        `[skip] opencode binary present at ${realBinaryPath}; 503 mapping not exercisable`,
      );
      return;
    }
    // A real conversation is needed so the service passes its not-found
    // guard and reaches the binary-missing branch.
    const created = await conversationService.create({
      title: "oc-503-probe",
      providerId: "p",
      modelId: null,
      reasoningLevel: null,
      systemPrompt: null,
      workspaceMode: "simple",
    });
    try {
      const res = await requestRoute("/api/opencode/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: created.id }),
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe(OPENCODE_CONFIG.binaryMissingError);
    } finally {
      await conversationService.delete(created.id);
    }
  });

  it("a bad conversationId still 400s before the 503 branch", async () => {
    if (realBinaryPath) {
      console.log(
        `[skip] opencode binary present at ${realBinaryPath}; 503 mapping not exercisable`,
      );
      return;
    }
    const res = await requestRoute("/api/opencode/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
