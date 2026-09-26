/**
 * Direct tool-approval secret integrity, on ONE long-lived CredentialStore.
 *
 * The Direct route calls `credentialStore.getToolApprovalSecret()` on every
 * request, and the approval secret is the HMAC key that makes a tool-approval
 * id unforgeable. So a cached secret must never outlive the row it came from:
 * if the encrypted setting is deleted or corrupted while the process is
 * running, the SAME instance must fail closed on its next read rather than keep
 * serving (or silently regenerate) a secret. A cache that hides deletion turns
 * a data-integrity fault into a security-relevant one.
 *
 * Each case restores the exact row it disturbed (value + updated_at) and
 * leaves the DB in the state it found it, because the suite shares one SQLite
 * file with every other credential/approval test in the process.
 *
 * DB isolation: tests/setup.ts (bunfig preload) redirects DATA_DIR to tmp.
 */
import { describe, it, expect, afterEach } from "bun:test";
import type { SQLQueryBindings } from "bun:sqlite";
import { db } from "../../src/db";
import { CredentialStore, CredentialError } from "../../src/services/credentials";

/**
 * Mirrors the production setting key. The store keeps it private, so the test
 * addresses the row exactly as the store does; a rename would surface here as a
 * failing case rather than as a silent "row not found" skip.
 */
const TOOL_APPROVAL_SECRET_SETTING_KEY = "security.tool_approval_secret";
/** Not a decryptable envelope: the store must refuse it, never replace it. */
const CORRUPTED_SETTING_VALUE = "not-an-encrypted-envelope";

interface SettingRow {
  value: string;
  updated_at: number;
}

function readSetting(): SettingRow | undefined {
  // bun:sqlite reports a missing row as `null`; normalize so "absent" is one
  // value everywhere in this file.
  return (
    db
      .query<SettingRow, SQLQueryBindings[]>(
        "SELECT value, updated_at FROM app_settings WHERE key = ?",
      )
      .get(TOOL_APPROVAL_SECRET_SETTING_KEY) ?? undefined
  );
}

function writeSetting(row: SettingRow): void {
  db.run(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [TOOL_APPROVAL_SECRET_SETTING_KEY, row.value, row.updated_at],
  );
}

function deleteSetting(): void {
  db.run("DELETE FROM app_settings WHERE key = ?", [TOOL_APPROVAL_SECRET_SETTING_KEY]);
}

/** Pre-test snapshot of the row, restored after every case. */
let snapshot: SettingRow | undefined;

function snapshotSetting(): void {
  snapshot = readSetting();
}

function restoreSetting(): void {
  if (snapshot) {
    writeSetting(snapshot);
  } else {
    deleteSetting();
  }
}

afterEach(() => {
  restoreSetting();
  snapshot = undefined;
});

describe("tool approval secret — the same store instance fails closed", () => {
  it("refuses to serve a secret after its setting row is deleted, and recovers when the row returns", () => {
    snapshotSetting();
    const store = new CredentialStore();
    store.initialize();
    const secret = store.getToolApprovalSecret();
    expect(secret.length).toBeGreaterThan(0);
    const persisted = readSetting();
    expect(persisted).toBeDefined();

    // The row disappears underneath a live process (restore, wipe, restore
    // from backup gone wrong, an editor, a migration).
    deleteSetting();

    // Fail closed — the very same instance, no restart in between.
    expect(() => store.getToolApprovalSecret()).toThrow(CredentialError);
    // ...and it stays closed: no re-read rehydrates a secret from memory.
    expect(() => store.getToolApprovalSecret()).toThrow(CredentialError);
    // Nothing was silently regenerated to paper over the missing row.
    expect(readSetting()).toBeUndefined();

    // The row comes back with its original value: the same instance serves the
    // same secret again, so a transient fault is not a permanent outage.
    writeSetting(persisted!);
    expect(store.getToolApprovalSecret()).toBe(secret);
  });

  it("refuses to serve a secret after its setting is corrupted, without overwriting the evidence", () => {
    snapshotSetting();
    const store = new CredentialStore();
    store.initialize();
    const secret = store.getToolApprovalSecret();
    expect(secret.length).toBeGreaterThan(0);

    // The row survives but can no longer be decrypted (bit rot, a truncated
    // write, a value written by another key).
    db.run("UPDATE app_settings SET value = ? WHERE key = ?", [
      CORRUPTED_SETTING_VALUE,
      TOOL_APPROVAL_SECRET_SETTING_KEY,
    ]);

    expect(() => store.getToolApprovalSecret()).toThrow(CredentialError);
    expect(() => store.getToolApprovalSecret()).toThrow(/data may be corrupted/i);
    expect(() => store.getToolApprovalSecret()).toThrow(CredentialError);
    // The corrupt value is left in place: replacing it here would destroy the
    // only evidence that something went wrong.
    expect(readSetting()?.value).toBe(CORRUPTED_SETTING_VALUE);
  });

  it("keeps a stable secret across the delete/corrupt/restore cycle on one instance", () => {
    snapshotSetting();
    const store = new CredentialStore();
    store.initialize();
    const first = store.getToolApprovalSecret();
    const persisted = readSetting();
    expect(persisted).toBeDefined();

    deleteSetting();
    expect(() => store.getToolApprovalSecret()).toThrow(CredentialError);
    writeSetting(persisted!);

    db.run("UPDATE app_settings SET value = ? WHERE key = ?", [
      CORRUPTED_SETTING_VALUE,
      TOOL_APPROVAL_SECRET_SETTING_KEY,
    ]);
    expect(() => store.getToolApprovalSecret()).toThrow(CredentialError);
    writeSetting(persisted!);

    // Identity, not just availability: the same instance returns the SAME
    // secret, so approval ids minted before the fault stay valid afterwards.
    expect(store.getToolApprovalSecret()).toBe(first);
    expect(store.getToolApprovalSecret()).toBe(first);
  });
});
