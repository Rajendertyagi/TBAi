/**
 * Bounded, TTL-swept collections for the runtime's long-lived per-controller
 * state.
 *
 * ## WHY THIS EXISTS
 *
 * The controller holds several sets that grow with use: the ids of answered
 * permissions, the ids the Auto shield has already tried, the ids of answered
 * forms, the ids of cancelled inbox entries, and the ids with an answer in
 * flight. None of them had a bound, so a long-lived session grew them without
 * limit.
 *
 * The reference implementation (OpenChamber's `sync/eviction.ts`) bounds its
 * equivalent with a **TTL plus a max size**, and it **tests the eviction policy
 * itself** rather than letting it be an accident. This module is that policy,
 * expressed against TBAi's collections.
 *
 * ## THE TWO CLASSES
 *
 * The policy is a **split**, and the split is the whole point:
 *
 * - a **settled** entry is evictable. It records a decision that has already
 *   happened, and the only thing it is consulted for is "has this already been
 *   answered?" - a question the server can also answer.
 * - an **in-flight** entry is **protected**. It records an operation that is
 *   still running, and evicting it would let a second operation start for the
 *   same id - which is exactly the defect M6 was.
 *
 * So the two classes get different treatment, and they are separate
 * collections rather than one collection with a flag: a protected entry must
 * never be swept, and a settled one must never block a sweep.
 *
 * ## THE CAP WHEN EVERYTHING IS PROTECTED
 *
 * A cap that cannot be honoured is not a cap. When every entry is protected and
 * the collection is over its limit, this module **refuses to evict** (the
 * protection is absolute) and **reports** it, so the caller can surface the
 * condition instead of silently losing the entries. The alternative - evicting
 * a protected entry to honour the number - would reintroduce M6.
 *
 * The reference makes the same trade in the other direction: it goes over the
 * limit rather than evicting a directory with a pending request, and says so
 * in its own comment ("going over the limit for a while is the cheaper
 * failure"). This module takes the same position, and makes the overflow
 * visible so it cannot be mistaken for a healthy state.
 *
 * ## LAST-TOUCH, NOT CREATION
 *
 * The TTL measures how long ago an entry was last *touched*, not how long ago
 * it was created. An entry that is still being consulted is alive; one that
 * has not been touched since it settled is stale. `touch()` is how a caller
 * says "this entry is still in use", and the caller decides when that is true
 * - the shared helper cannot know, because each collection has its own
 * lifecycle.
 */

import {
  OPENCODE_V2_RETENTION_CAP,
  OPENCODE_V2_RETENTION_TTL_MS,
} from "@/features/opencode/config";

/** What a protected collection does when it cannot honour its cap. */
export type RetentionOverflow = "none" | "protected";

/**
 * A bounded collection of ids with a TTL, where some entries are protected.
 *
 * @typeParam T - The id type.
 */
export class RetentionSet<T extends string> {
  /**
   * The id -> last-touch timestamp map, in insertion order.
   *
   * A `Map` preserves insertion order, so the oldest entry is the first key -
   * which is what the sweep needs, and what makes the sweep O(evicted).
   */
  private readonly entries = new Map<T, number>();

  /**
   * The entries an in-flight operation owns.
   *
   * These are never evicted while the operation is active, and they are not
   * part of `entries`' TTL accounting: a protected entry has no age.
   */
  private readonly protectedIds = new Set<T>();

  /**
   * @param cap - The most entries the collection may hold.
   * @param ttlMs - How long an untouched entry survives.
   */
  public constructor(
    private readonly cap: number = OPENCODE_V2_RETENTION_CAP,
    private readonly ttlMs: number = OPENCODE_V2_RETENTION_TTL_MS,
  ) {}

  /** The number of entries held, protected ones included. */
  public get size(): number {
    return this.entries.size;
  }

  /** The number of protected entries. */
  public get protectedCount(): number {
    return this.protectedIds.size;
  }

  /**
   * Whether the collection holds an id.
   *
   * @param id - The id.
   * @returns True when it is held.
   */
  public has(id: T): boolean {
    return this.entries.has(id);
  }

  /**
   * Records an id, and marks the moment it was last touched.
   *
   * @param id - The id.
   * @param now - The current time.
   */
  public add(id: T, now: number): void {
    // Re-adding an id REFRESHES its position: delete first so the map's
    // insertion order becomes "least recently touched first", which is what the
    // sweep relies on.
    this.entries.delete(id);
    this.entries.set(id, now);
  }

  /**
   * Marks an id as still in use, so the sweep leaves it alone.
   *
   * @param id - The id.
   */
  public protect(id: T): void {
    this.protectedIds.add(id);
  }

  /**
   * Releases an id's protection.
   *
   * The id stays in the collection - it is settled now, and the question the
   * collection answers ("has this been answered?") still applies to it.
   *
   * @param id - The id.
   */
  public release(id: T): void {
    this.protectedIds.delete(id);
  }

  /**
   * Removes an id entirely.
   *
   * @param id - The id.
   */
  public delete(id: T): void {
    this.entries.delete(id);
    this.protectedIds.delete(id);
  }

  /**
   * Evicts what the policy allows, and reports what it could not.
   *
   * Two things are evicted, in this order:
   *
   * 1. **Expired** entries - untouched for longer than the TTL. A protected
   *    entry is never expired, because "in flight" outranks "old".
   * 2. Then, if the collection is still over its cap, the **oldest
   *    unprotected** entries, until it fits or there is nothing left to evict.
   *
   * @param now - The current time.
   * @returns `protected` when entries remain over the cap and every one of
   * them is protected - the case the caller must surface.
   */
  public sweep(now: number): RetentionOverflow {
    for (const [id, touchedAt] of [...this.entries]) {
      if (this.protectedIds.has(id)) continue;
      if (now - touchedAt < this.ttlMs) continue;
      this.entries.delete(id);
    }
    while (this.entries.size > this.cap) {
      const oldest = this.firstUnprotected();
      if (oldest === null) return "protected";
      this.entries.delete(oldest);
    }
    return "none";
  }

  /**
   * Evicts only expired (TTL) entries, ignoring the cap.
   *
   * Used for collections where duplicate suppression must survive cap pressure
   * (e.g. auto-approve settled records): the cap is a memory bound for
   * long-lived collections, but suppression only needs to live for the TTL.
   */
  public sweepTtlOnly(now: number): void {
    for (const [id, touchedAt] of [...this.entries]) {
      if (this.protectedIds.has(id)) continue;
      if (now - touchedAt < this.ttlMs) continue;
      this.entries.delete(id);
    }
  }

  /**
   * The oldest entry that may be evicted.
   *
   * @returns The id, or `null` when every entry is protected.
   */
  private firstUnprotected(): T | null {
    for (const id of this.entries.keys()) {
      if (!this.protectedIds.has(id)) return id;
    }
    return null;
  }

  /** Every id held, in least-recently-touched order. */
  public ids(): readonly T[] {
    return [...this.entries.keys()];
  }

  /** Empties the collection. */
  public clear(): void {
    this.entries.clear();
    this.protectedIds.clear();
  }
}
