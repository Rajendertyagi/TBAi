import type { Database } from "bun:sqlite";
import { canonicalizeServiceOwner } from "../../services/opencode/historyBoundary";
import { logger } from "../../lib/logger";

/**
 * Idempotent, forward-only migration for OpenCode conversation ownership.
 *
 * Normalizes legacy ownership values:
 * - NULL, empty, "managed", "default", "profile:default" -> "local"
 * - Loopback legacy "adopted:..." (e.g. 127.0.0.1, localhost, [::1]) -> "local"
 * - Non-loopback "adopted:..." -> "remote:<canonical-origin>"
 * - Explicit / remote values -> preserved as canonical "remote:<origin>"
 * - Non-default "profile:..." -> preserved as-is
 *
 * Scoped strictly to OpenCode-backed conversations (engine = 'opencode' AND opencode_session_id IS NOT NULL).
 * Ordinary TBAi conversations (engine = 'direct') are never modified.
 * Safe to run multiple times. Preserves conversation IDs and native session IDs.
 */
export function applyOpenCodeServiceOwnerSimplificationMigration(database: Database): void {
  database.transaction(() => {
    const columns = database.query("PRAGMA table_info(conversations)").all() as Array<{
      name: string;
    }>;
    const hasEngine = columns.some((c) => c.name === "engine");

    const sql = hasEngine
      ? `SELECT id, opencode_session_id, opencode_service_owner
         FROM conversations
         WHERE engine = 'opencode' AND opencode_session_id IS NOT NULL`
      : `SELECT id, opencode_session_id, opencode_service_owner
         FROM conversations
         WHERE opencode_session_id IS NOT NULL`;

    const rows = database
      .query<
        { id: string; opencode_session_id: string; opencode_service_owner: string | null },
        []
      >(sql)
      .all();

    if (rows.length === 0) return;

    let updatedCount = 0;
    const updateStmt = database.prepare(
      `UPDATE conversations
       SET opencode_service_owner = ?
       WHERE id = ?`,
    );

    for (const row of rows) {
      const canonical = canonicalizeServiceOwner(row.opencode_service_owner);
      if (row.opencode_service_owner !== canonical) {
        updateStmt.run(canonical, row.id);
        updatedCount++;
      }
    }

    if (updatedCount > 0) {
      logger.info("db", "opencode_service_owner_migration_completed", {
        migratedCount: updatedCount,
      });
    }
  })();
}
