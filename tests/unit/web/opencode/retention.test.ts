/**
 * The retention policy for the runtime's long-lived collections.
 *
 * ## THE POLICY
 *
 * A **settled** entry is evictable: it records a decision that already
 * happened, and it is only ever consulted as "has this been answered?" - a
 * question the server can also answer.
 *
 * An **in-flight** entry is **protected**: it records an operation that is
 * still running, and evicting it would let a second operation start for the
 * same id. That is exactly the defect M6 was, and the protection is absolute.
 *
 * The TTL measures the last touch, not the creation. The cap is the reducer's
 * existing 256-item window, so the controller and the reducer share one policy.
 *
 * ## WHAT IS PINNED HERE
 *
 * - a settled entry is evicted once it is untouched for longer than the TTL;
 * - a protected entry survives the TTL, and survives the cap;
 * - when EVERY entry is protected and the cap is exceeded, the collection
 *   reports it rather than evicting a protected entry - a cap that cannot be
 *   honoured is not a cap, and the overflow must be visible;
 * - `protect`/`release` preserve the entry's place, and `add` refreshes it.
 */

import { describe, expect, it } from "bun:test";
import { RetentionSet } from "@web/features/opencode/sync/retention.ts";

const NOW = 1_000_000;
const TTL = 1000;

describe("the retention policy", () => {
  it("holds a settled entry until the TTL elapses, then evicts it", () => {
    const set = new RetentionSet<string>(10, TTL);
    set.add("a", NOW);

    expect(set.sweep(NOW + TTL - 1)).toBe("none");
    expect(set.has("a")).toBe(true);

    expect(set.sweep(NOW + TTL)).toBe("none");
    expect(set.has("a")).toBe(false);
  });

  it("measures from the LAST touch, not from creation", () => {
    const set = new RetentionSet<string>(10, TTL);
    set.add("a", NOW);
    // Touched at the very edge of its life: the TTL restarts from here.
    set.add("a", NOW + TTL - 1);

    expect(set.sweep(NOW + TTL)).toBe("none");
    expect(set.has("a")).toBe(true);
    expect(set.sweep(NOW + TTL - 1 + TTL)).toBe("none");
    expect(set.has("a")).toBe(false);
  });

  it("never evicts a protected entry, however old it is", () => {
    const set = new RetentionSet<string>(10, TTL);
    set.add("inflight", NOW);
    set.protect("inflight");

    expect(set.sweep(NOW + TTL * 100)).toBe("none");
    expect(set.has("inflight")).toBe(true);
    expect(set.protectedCount).toBe(1);
  });

  it("evicts the oldest unprotected entries when the cap is exceeded", () => {
    const set = new RetentionSet<string>(3, TTL);
    set.add("oldest", NOW);
    set.add("middle", NOW + 1);
    set.add("newest", NOW + 2);
    set.add("newest2", NOW + 3);

    expect(set.sweep(NOW + 3)).toBe("none");
    expect(set.size).toBe(3);
    // The oldest went; the rest stayed.
    expect(set.has("oldest")).toBe(false);
    expect(set.has("newest2")).toBe(true);
  });

  it("evicts AROUND a protected entry rather than evicting it", () => {
    const set = new RetentionSet<string>(2, TTL);
    set.add("protected", NOW);
    set.protect("protected");
    set.add("a", NOW + 1);
    set.add("b", NOW + 2);

    expect(set.sweep(NOW + 2)).toBe("none");
    expect(set.has("protected")).toBe(true);
    expect(set.size).toBe(2);
  });

  it("REPORTS the overflow when every entry is protected", () => {
    // The cap cannot be honoured, and the protection is absolute. The
    // collection says so instead of silently losing an entry.
    const set = new RetentionSet<string>(1, TTL);
    set.add("a", NOW);
    set.protect("a");
    set.add("b", NOW + 1);
    set.protect("b");

    expect(set.sweep(NOW + 1)).toBe("protected");
    expect(set.size).toBe(2);
    expect(set.has("a")).toBe(true);
    expect(set.has("b")).toBe(true);
  });

  it("releases an entry into the evictable population without losing it", () => {
    const set = new RetentionSet<string>(10, TTL);
    set.add("a", NOW);
    set.protect("a");
    expect(set.has("a")).toBe(true);

    set.release("a");
    expect(set.protectedCount).toBe(0);
    // Still held - the question "has this been answered?" still applies.
    expect(set.has("a")).toBe(true);
    // And now evictable.
    set.sweep(NOW + TTL);
    expect(set.has("a")).toBe(false);
  });

  it("delete removes an entry and its protection together", () => {
    const set = new RetentionSet<string>(10, TTL);
    set.add("a", NOW);
    set.protect("a");

    set.delete("a");
    expect(set.has("a")).toBe(false);
    expect(set.protectedCount).toBe(0);
  });

  it("reports the ids in least-recently-touched order", () => {
    const set = new RetentionSet<string>(10, TTL);
    set.add("a", NOW);
    set.add("b", NOW + 1);
    set.add("c", NOW + 2);

    expect(set.ids()).toEqual(["a", "b", "c"]);
    // Re-adding moves an entry to the back: it is the most recently touched.
    set.add("a", NOW + 3);
    expect(set.ids()).toEqual(["b", "c", "a"]);
  });
});
