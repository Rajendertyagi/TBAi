/**
 * Phase 5 — the local application-memory provider.
 *
 * Reads the authoritative TBAi SQLite `memories` table directly, rather than going
 * through `memoryService`. Two reasons, both deliberate:
 *
 * 1. **It is the retrieval side, not the CRUD side.** Phase 5 locked
 *    application-memory CRUD as separate from the candidate contract, and this is
 *    a different access pattern: a bounded, deterministically ordered read rather
 *    than an unbounded full listing.
 * 2. **It fixes a real determinism gap.** `memoryService.list()` orders by
 *    `updated_at DESC` with **no tiebreaker**, so equal timestamps fall back to
 *    SQLite's plan — row order, which is not a contract. The query below orders by
 *    `created_at DESC, id ASC`, which is total, and therefore reproducible.
 *
 * The table is the same one CRUD writes. There is no second store.
 */

import type { Database, SQLQueryBindings } from "bun:sqlite";
import { db } from "../../db";
import { MEMORY_MAX_CANDIDATES } from "./contract";
import type { MemoryCandidate, MemoryCandidateProvider } from "./contract";

/** Id recorded in provenance. Not a provider name, which could be renamed freely. */
export const LOCAL_MEMORY_PROVIDER_ID = "application-local";

interface MemoryCandidateRow {
  id: string;
  content: string;
  created_at: number;
  updated_at: number;
}

/**
 * The provider contract's ceiling is applied by the caller as well as here, so a
 * provider cannot widen the work TBAi asked for by returning more than it should.
 */
function toCandidate(row: MemoryCandidateRow): MemoryCandidate {
  return {
    id: row.id,
    content: row.content,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    providerId: LOCAL_MEMORY_PROVIDER_ID,
  };
}

/**
 * Create the local provider.
 *
 * Takes the query function rather than importing `db` at call time so a test can
 * drive it without a database, matching how `CompactionSeam` is exercised.
 */
export function createLocalMemoryProvider(
  runQuery: (limit: number) => MemoryCandidateRow[] = defaultQuery,
): MemoryCandidateProvider {
  return {
    providerId: LOCAL_MEMORY_PROVIDER_ID,
    async listCandidates(query): Promise<readonly MemoryCandidate[]> {
      const limit = Math.max(0, Math.min(query.limit, MEMORY_MAX_CANDIDATES));
      if (limit === 0) return [];
      return runQuery(limit).map(toCandidate);
    },
  };
}

/** The retrieval statement. One definition, so the test exercises what ships. */
const CANDIDATE_QUERY =
  "SELECT id, content, created_at, updated_at FROM memories ORDER BY created_at DESC, id ASC LIMIT ?";

/**
 * Build a candidate query runner bound to a specific database.
 *
 * Exists so the SHIPPED statement can be exercised against a scratch database.
 * Part 5 makes this the live retrieval path, and a query whose ordering carries
 * the determinism guarantee cannot be verified by re-typing it in a test.
 *
 * @param database Connection to read. Defaults to TBAi's own, which is the
 * production behaviour; a test passes its own scratch handle.
 * @returns A runner suitable for {@link createLocalMemoryProvider}.
 */
export function createMemoryQueryRunner(
  database: Pick<Database, "query"> = db,
): (limit: number) => MemoryCandidateRow[] {
  return (limit) =>
    database.query<MemoryCandidateRow, SQLQueryBindings[]>(CANDIDATE_QUERY).all(limit);
}

function defaultQuery(limit: number): MemoryCandidateRow[] {
  // `created_at DESC, id ASC` is a total order: no two rows can tie, so the result
  // is byte-identical for identical table state on every call and every process.
  return createMemoryQueryRunner()(limit);
}

/** The provider Phase 5 uses. Bounded, ordered, and the same table CRUD owns. */
export const localMemoryProvider: MemoryCandidateProvider = createLocalMemoryProvider();