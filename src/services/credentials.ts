import { gcm } from "@noble/ciphers/aes.js";
import type { SQLQueryBindings } from "bun:sqlite";
import { db } from "../db";
import { logger } from "../lib/logger";
import { errorLogFields } from "../lib/errors";

// Local, portable credential encryption for a personal-use app.
//
// Each provider API key is encrypted with AES-256-GCM under a per-install
// Data Encryption Key (DEK). The DEK is a random 32-byte value generated once and
// stored locally in the `credential_key` table (same SQLite file as the rest of the
// app), so it travels with the portable app folder. No master password, no OS
// keychain, no hardcoded key.
//
// Trade-off (documented in docs/security.md): anyone with full read access to the
// app's data file can recover the DEK and decrypt the keys. This is accepted for a
// personal, portable, single-user tool where convenience and portability matter more
// than protection against an attacker who already owns the machine/files.

const CREDENTIAL_VERSION = 1;
const KEY_VERSION = 1;
const NONCE_BYTES = 12;
const TOOL_APPROVAL_SECRET_SETTING_KEY = "security.tool_approval_secret";
const TOOL_APPROVAL_SECRET_BYTES = 32;
const TOOL_APPROVAL_SECRET_HEX_RE = /^[0-9a-f]{64}$/;

export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialError";
  }
}

interface EncryptedEnvelope {
  v: number;
  nonce: string; // hex
  ct: string; // hex (ciphertext + GCM tag)
}

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, "hex"));
}

function utf8Encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/**
 * Isolated credential store. All encryption/decryption lives here; providers,
 * routes, and the UI never touch key material.
 */
export class CredentialStore {
  private key: Uint8Array | null = null;
  private toolApprovalSecretReady = false;

  /** Load the local DEK, generating and persisting it on first use. Call at startup. */
  initialize(): void {
    if (!this.key) {
      const row = db
        .query<{ key_hex: string }, SQLQueryBindings[]>("SELECT key_hex FROM credential_key WHERE id = 1")
        .get();
      if (row) {
        this.key = hexToBytes(row.key_hex);
      } else {
        const newKey = randomBytes(32);
        db.run(
          "INSERT INTO credential_key (id, key_hex, version, created_at) VALUES (1, ?, ?, ?)",
          [bytesToHex(newKey), KEY_VERSION, Date.now()],
        );
        this.key = newKey;
      }
    }

    if (!this.toolApprovalSecretReady) {
      this.loadOrCreateToolApprovalSecret();
      this.toolApprovalSecretReady = true;
    }
  }

  /** Return the stable per-install HMAC secret used for Direct tool approvals. */
  getToolApprovalSecret(): string {
    // Route-level tests and embedded callers may reach the boundary before the
    // server startup task. Initialization is idempotent; after bootstrap we
    // re-read the encrypted setting on every request so deletion/corruption
    // cannot be hidden by an in-memory cache.
    if (!this.key) this.initialize();
    const row = db
      .query<{ value: string }, SQLQueryBindings[]>(
        "SELECT value FROM app_settings WHERE key = ?",
      )
      .get(TOOL_APPROVAL_SECRET_SETTING_KEY);
    if (!row) {
      this.toolApprovalSecretReady = false;
      throw new CredentialError("Tool approval secret is unavailable");
    }
    try {
      const secret = this.decryptToolApprovalSecret(row.value);
      this.toolApprovalSecretReady = true;
      return secret;
    } catch (error) {
      this.toolApprovalSecretReady = false;
      throw error;
    }
  }

  private loadOrCreateToolApprovalSecret(): string {
    const row = db
      .query<{ value: string }, SQLQueryBindings[]>(
        "SELECT value FROM app_settings WHERE key = ?",
      )
      .get(TOOL_APPROVAL_SECRET_SETTING_KEY);

    if (row) {
      return this.decryptToolApprovalSecret(row.value);
    }

    const secret = bytesToHex(randomBytes(TOOL_APPROVAL_SECRET_BYTES));
    const encrypted = this.encryptValue(secret);
    db.run(
      `INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)`,
      [TOOL_APPROVAL_SECRET_SETTING_KEY, encrypted, Date.now()],
    );

    // INSERT OR IGNORE makes startup safe if another local initialization wins
    // the race. Always read back the persisted value rather than trusting the
    // candidate in memory.
    const persisted = db
      .query<{ value: string }, SQLQueryBindings[]>(
        "SELECT value FROM app_settings WHERE key = ?",
      )
      .get(TOOL_APPROVAL_SECRET_SETTING_KEY);
    if (!persisted) {
      throw new CredentialError("Failed to persist tool approval secret");
    }
    return this.decryptToolApprovalSecret(persisted.value);
  }

  private decryptToolApprovalSecret(envelopeJson: string): string {
    let secret: string;
    try {
      secret = this.decryptValue(envelopeJson);
    } catch {
      // decryptValue already emits the credential funnel line with safe fields.
      throw new CredentialError(
        "Failed to load tool approval secret (data may be corrupted)",
      );
    }
    if (!TOOL_APPROVAL_SECRET_HEX_RE.test(secret)) {
      logger.error("credential", "credential.error", {
        category: "config",
        retryable: false,
        errorType: "CredentialError",
      });
      throw new CredentialError(
        "Failed to load tool approval secret (data may be corrupted)",
      );
    }
    return secret;
  }

  private requireKey(): Uint8Array {
    if (!this.key) {
      throw new CredentialError("Credential store is not initialized");
    }
    return this.key;
  }

  set(providerId: string, secret: string): void {
    const key = this.requireKey();
    const nonce = randomBytes(NONCE_BYTES);
    const ct = gcm(key, nonce).encrypt(utf8Encode(secret));
    const envelope: EncryptedEnvelope = {
      v: CREDENTIAL_VERSION,
      nonce: bytesToHex(nonce),
      ct: bytesToHex(ct),
    };
    db.run(
      `UPDATE provider_configs SET encrypted_api_key = ?, credential_version = ? WHERE id = ?`,
      [JSON.stringify(envelope), CREDENTIAL_VERSION, providerId],
    );
  }

  get(providerId: string): string {
    const key = this.requireKey();
    const row = db
      .query<{ encrypted_api_key: string | null }, SQLQueryBindings[]>(
        "SELECT encrypted_api_key FROM provider_configs WHERE id = ?",
      )
      .get(providerId);
    if (!row || !row.encrypted_api_key) {
      throw new CredentialError("No API key configured for this provider");
    }
    const envelope = JSON.parse(row.encrypted_api_key) as EncryptedEnvelope;
    try {
      return utf8Decode(gcm(key, hexToBytes(envelope.nonce)).decrypt(hexToBytes(envelope.ct)));
    } catch (err) {
      // Security-relevant: a decrypt failure means corruption or tampering.
      // Logged here (not just at the HTTP edge) with the provider identity.
      logger.error("credential", "credential.error", {
        providerId,
        ...errorLogFields(err),
      });
      throw new CredentialError(
        "Failed to decrypt credential (data may be corrupted)",
      );
    }
  }

  /** Works without touching the secret — used to report "Configured" status to the UI. */
  has(providerId: string): boolean {
    const row = db
      .query<{ encrypted_api_key: string | null }, SQLQueryBindings[]>(
        "SELECT encrypted_api_key FROM provider_configs WHERE id = ?",
      )
      .get(providerId);
    return !!row && !!row.encrypted_api_key;
  }

  delete(providerId: string): void {
    db.run(
      `UPDATE provider_configs SET encrypted_api_key = NULL, credential_version = NULL WHERE id = ?`,
      [providerId],
    );
  }

  /** Encrypt an arbitrary secret (e.g. an MCP server auth token) under the same local DEK. */
  encryptValue(plain: string): string {
    const key = this.requireKey();
    const nonce = randomBytes(NONCE_BYTES);
    const ct = gcm(key, nonce).encrypt(utf8Encode(plain));
    const envelope: EncryptedEnvelope = {
      v: CREDENTIAL_VERSION,
      nonce: bytesToHex(nonce),
      ct: bytesToHex(ct),
    };
    return JSON.stringify(envelope);
  }

  /** Decrypt a value produced by {@link encryptValue}. */
  decryptValue(envelopeJson: string): string {
    const key = this.requireKey();
    try {
      const envelope = JSON.parse(envelopeJson) as EncryptedEnvelope;
      return utf8Decode(gcm(key, hexToBytes(envelope.nonce)).decrypt(hexToBytes(envelope.ct)));
    } catch (err) {
      logger.error("credential", "credential.error", {
        ...errorLogFields(err),
      });
      throw err instanceof Error ? err : new CredentialError("Failed to decrypt value");
    }
  }
}

export const credentialStore = new CredentialStore();

/** Encrypt an arbitrary secret under the app's local DEK (e.g. an MCP auth token). */
export function encryptSecret(plain: string): string {
  return credentialStore.encryptValue(plain);
}

/** Decrypt a secret previously encrypted with {@link encryptSecret}. */
export function decryptSecret(envelopeJson: string): string {
  return credentialStore.decryptValue(envelopeJson);
}
