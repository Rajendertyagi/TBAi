import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { SQLQueryBindings } from "bun:sqlite";
import fs from "fs";
import path from "path";
import os from "os";

// Test isolation: tests/setup.ts (bunfig preload) already redirects DATA_DIR to
// a per-run tmp dir. Only fall back to a private tmp dir when running this file
// outside the suite. Never close the shared db singleton — other test files in
// the same process use it.
if (!process.env.DATA_DIR) {
  const fallback = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-cred-"));
  process.env.DATA_DIR = fallback;
}
const tmp = process.env.DATA_DIR;

const { credentialStore, CredentialStore, CredentialError } = await import(
  "../services/credentials"
);
const { db } = await import("../db");

const TOOL_APPROVAL_SECRET_SETTING_KEY = "security.tool_approval_secret";
const CORRUPTED_TOOL_APPROVAL_SECRET = "not-an-encrypted-envelope";

function seedProvider(id: string, type = "openai") {
  // INSERT OR REPLACE: the suite shares one DB per process with other suites
  // (see header comment), and sibling suites seed the same fixed ids (e.g.
  // scheduler-ai-tools seeds "p1"). A bare INSERT would UNIQUE-violation
  // depending on file order — replace keeps this file order-independent
  // without changing what it asserts (set() overwrites the key anyway).
  db.run(
    `INSERT OR REPLACE INTO provider_configs (id, name, type, endpoint, model, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, id, type, null, "gpt-4o", 0, Date.now(), Date.now()],
  );
}

function readToolApprovalSecretSetting():
  | { value: string; updated_at: number }
  | undefined {
  return db
    .query<{ value: string; updated_at: number }, SQLQueryBindings[]>(
      "SELECT value, updated_at FROM app_settings WHERE key = ?",
    )
    .get(TOOL_APPROVAL_SECRET_SETTING_KEY);
}

function restoreToolApprovalSecretSetting(
  original: { value: string; updated_at: number } | undefined,
): void {
  if (!original) {
    db.run("DELETE FROM app_settings WHERE key = ?", [
      TOOL_APPROVAL_SECRET_SETTING_KEY,
    ]);
    return;
  }
  db.run("UPDATE app_settings SET value = ?, updated_at = ? WHERE key = ?", [
    original.value,
    original.updated_at,
    TOOL_APPROVAL_SECRET_SETTING_KEY,
  ]);
}

beforeAll(() => {
  credentialStore.initialize();
});

afterAll(() => {
  // Leave the shared db connection open for other test files in this process.
  // Best-effort cleanup of the fallback dir only (ignore locked files).
  if (tmp.includes("tbai-cred-")) {
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* ignore */
    }
  }
});

describe("CredentialStore (local DEK encryption)", () => {
  it("generates and persists a local data-encryption key on first init", () => {
    const row = db
      .query<{ key_hex: string }, SQLQueryBindings[]>("SELECT key_hex FROM credential_key WHERE id = 1")
      .get();
    expect(row).toBeDefined();
    expect(row!.key_hex.length).toBe(64); // 32 bytes hex
  });

  it("sets and gets a secret round-trip", () => {
    seedProvider("p1");
    credentialStore.set("p1", "sk-secret-abc123");
    expect(credentialStore.has("p1")).toBe(true);
    expect(credentialStore.get("p1")).toBe("sk-secret-abc123");
  });

  it("keeps the secret available across a simulated restart", () => {
    // Re-initialize: the DEK is loaded from the DB (not regenerated).
    credentialStore.initialize();
    expect(credentialStore.has("p1")).toBe(true);
    expect(credentialStore.get("p1")).toBe("sk-secret-abc123");
  });

  it("replaces an existing credential", () => {
    credentialStore.set("p1", "sk-replaced-xyz");
    expect(credentialStore.get("p1")).toBe("sk-replaced-xyz");
  });

  it("deletes a credential", () => {
    credentialStore.delete("p1");
    expect(credentialStore.has("p1")).toBe(false);
    expect(() => credentialStore.get("p1")).toThrow(CredentialError);
  });

  it("fails safely on corrupted ciphertext", () => {
    seedProvider("p2");
    db.run(
      `UPDATE provider_configs SET encrypted_api_key = ? WHERE id = 'p2'`,
      [JSON.stringify({ v: 1, nonce: "00".repeat(12), ct: "00".repeat(32) })],
    );
    expect(() => credentialStore.get("p2")).toThrow(/Failed to decrypt/);
  });

  it("logs credential.error on decrypt failure (funnel proof)", async () => {
    const { logger } = await import("../lib/logger");
    logger.configure({ level: "debug", targets: [], file: null });
    try {
      const since = logger.lastSeq;
      expect(() => credentialStore.get("p2")).toThrow(/Failed to decrypt/);
      const entry = logger
        .getRecentEntries(since)
        .find((e) => e.event === "credential.error");
      expect(entry).toBeTruthy();
      expect(entry?.level).toBe("error");
      expect((entry as { providerId?: string }).providerId).toBe("p2");
    } finally {
      logger.configure({ level: "error", targets: [], file: null });
    }
  });

  it("never persists the plaintext secret", () => {
    seedProvider("p3");
    credentialStore.set("p3", "sk-plaintext-must-not-appear");
    const row = db
      .query<{ encrypted_api_key: string | null }, SQLQueryBindings[]>(
        "SELECT encrypted_api_key FROM provider_configs WHERE id = 'p3'",
      )
      .get();
    expect(row!.encrypted_api_key ?? "").not.toContain("sk-plaintext-must-not-appear");
    // The stored envelope must not be valid plaintext JSON containing the secret.
    expect(row!.encrypted_api_key ?? "").not.toContain("must-not-appear");
  });

  it("returns a stable non-empty Direct approval secret across calls and store reinitialization", () => {
    const firstStore = new CredentialStore();
    const firstSecret = firstStore.getToolApprovalSecret();

    expect(firstSecret.length).toBeGreaterThan(0);
    expect(firstStore.getToolApprovalSecret()).toBe(firstSecret);

    const reinitializedStore = new CredentialStore();
    expect(reinitializedStore.getToolApprovalSecret()).toBe(firstSecret);
    reinitializedStore.initialize();
    expect(reinitializedStore.getToolApprovalSecret()).toBe(firstSecret);
  });

  it("persists the Direct approval secret without plaintext in app_settings", () => {
    const secret = new CredentialStore().getToolApprovalSecret();
    const row = readToolApprovalSecretSetting();

    expect(row).toBeDefined();
    expect(row!.value).not.toBe(secret);
    expect(row!.value).not.toContain(secret);
  });

  it("fails closed without replacing a corrupted Direct approval secret setting", () => {
    const originalRow = readToolApprovalSecretSetting();
    if (!originalRow) throw new Error("Tool approval secret setting was not initialized");
    const originalSecret = new CredentialStore().getToolApprovalSecret();

    try {
      db.run("UPDATE app_settings SET value = ? WHERE key = ?", [
        CORRUPTED_TOOL_APPROVAL_SECRET,
        TOOL_APPROVAL_SECRET_SETTING_KEY,
      ]);

      const restartedStore = new CredentialStore();
      expect(() => restartedStore.getToolApprovalSecret()).toThrow(CredentialError);
      expect(() => restartedStore.getToolApprovalSecret()).toThrow(
        /data may be corrupted/i,
      );
      expect(readToolApprovalSecretSetting()?.value).toBe(
        CORRUPTED_TOOL_APPROVAL_SECRET,
      );
    } finally {
      restoreToolApprovalSecretSetting(originalRow);
    }

    expect(new CredentialStore().getToolApprovalSecret()).toBe(originalSecret);
  });
});
