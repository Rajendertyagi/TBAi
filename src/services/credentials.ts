import { gcm } from "@noble/ciphers/aes.js";
import type { SQLQueryBindings } from "bun:sqlite";
import { db } from "../db";
import { logger } from "../lib/logger";
import { classifyError } from "../lib/errors";

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

  /** Load the local DEK, generating and persisting it on first use. Call at startup. */
  initialize(): void {
    const row = db
      .query<{ key_hex: string }, SQLQueryBindings[]>("SELECT key_hex FROM credential_key WHERE id = 1")
      .get();
    if (row) {
      this.key = hexToBytes(row.key_hex);
      return;
    }
    const newKey = randomBytes(32);
    db.run(
      "INSERT INTO credential_key (id, key_hex, version, created_at) VALUES (1, ?, ?, ?)",
      [bytesToHex(newKey), KEY_VERSION, Date.now()],
    );
    this.key = newKey;
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
        ...classifyError(err),
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
      logger.error("credential", "credential.error", { ...classifyError(err) });
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
