/**
 * Phase 5 Part 5 — memory enablement.
 *
 * ## What this decides
 *
 * Whether the Direct path is allowed to supply the memory seam at all. It is the
 * memory equivalent of {@link import("../compaction/contract").compactionEnabled},
 * and it exists for the same reason: an unwired seam must be impossible to activate
 * by accident.
 *
 * ## OFF BY DEFAULT
 *
 * Supplying this seam changes what leaves the machine. Stored application memory
 * becomes model-visible context, so enabling it is a deliberate act by the operator
 * — not something a new build should start doing silently. The same reasoning that
 * keeps compaction behind `TBAI_COMPACTION_ENABLED` applies here, and the same
 * env-flag precedent (`TBAI_CHAT_STREAM_TTL_MS`, `src/services/chat-streams/schema.ts`)
 * is the mechanism.
 *
 * Anything other than an explicit `"1"` or `"true"` is off. A missing value, `"0"`,
 * `"false"` and arbitrary text are all off, so a typo can never start sending
 * stored memory to a provider.
 *
 * ## Why this lives beside the boundary rather than in the route
 *
 * The route composes the seam; it does not decide whether the feature participates.
 * Keeping the decision here means the policy is one testable pure function rather
 * than a conditional buried in request handling, and it means the default is stated
 * in exactly one place.
 */

/** Environment variable that opts the Direct path into memory injection. */
export const MEMORY_ENV = "TBAI_MEMORY_ENABLED";

/**
 * Whether automatic memory retrieval may run.
 *
 * OFF BY DEFAULT — see the module note. An unset variable, or any value other than
 * `"1"` or `"true"`, leaves the seam unsupplied, which makes the whole phase inert:
 * no candidate is retrieved, no memory is selected, and no block is injected.
 *
 * @param env Environment to read. Injected so a test never mutates `process.env`.
 * @returns Whether the Direct path may supply the memory seam.
 */
export function memoryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[MEMORY_ENV];
  return value === "1" || value === "true";
}
