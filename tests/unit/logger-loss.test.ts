/**
 * Logging-loss visibility.
 *
 * Every path that can discard an entry must be COUNTED, so "nothing happened"
 * is distinguishable from "evidence was dropped". These tests drive each path
 * directly and assert the counter — a loss path that cannot be observed is the
 * thing this suite exists to prevent.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import path from "path";
import os from "os";
import { logger } from "../../src/lib/logger";
import { logLossMetricsText } from "../../src/services/http-metrics";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-loss-"));
  logger.resetLossCounters();
  logger.resetThrottleStates();
  logger.configure({
    level: "debug",
    targets: [],
    file: null,
    fileEnabled: false,
    bufferSize: 5000,
    fileQueueLimit: 5000,
  });
});

afterEach(() => {
  logger.flushFileLines();
  // The logger is a process-wide singleton, so every knob this file touched
  // must be restored or the caps would leak into other test files.
  logger.configure({
    level: "error",
    targets: [],
    file: null,
    fileEnabled: false,
    bufferSize: 5000,
    fileQueueLimit: 5000,
  });
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("loss counters", () => {
  it("counts entries discarded by the level filter", () => {
    logger.configure({ level: "error" });
    logger.debug("test.loss", "a");
    logger.info("test.loss", "b");
    logger.warn("test.loss", "c");
    logger.error("test.loss", "kept");
    expect(logger.getWriteStats().loss.levelFiltered).toBe(3);
  });

  it("counts ring entries spliced past the live-tail cap", () => {
    logger.configure({ bufferSize: 3 });
    // The ring is a process-wide singleton, so the expected splice is computed
    // from whatever it already holds rather than assumed empty.
    const before = logger.getRecentEntries(0).length;
    const emitted = 10;
    for (let i = 0; i < emitted; i++) logger.debug("test.loss", `ring-${i}`);
    const stats = logger.getWriteStats();
    expect(stats.loss.ringSpliced).toBe(Math.max(0, before + emitted - 3));
    // Bounded storage is preserved: the ring holds exactly the cap.
    expect(logger.getRecentEntries(0).length).toBe(3);
  });

  it("counts file-queue overflow instead of blocking", () => {
    const file = path.join(tmpRoot, "queue", "tbai.log");
    logger.configure({ file, fileEnabled: true, fileQueueLimit: 2 });
    for (let i = 0; i < 5; i++) logger.debug("test.loss", `q-${i}`);
    const stats = logger.getWriteStats();
    expect(stats.loss.fileQueueDropped).toBe(3);
    expect(stats.queued).toBe(2);
  });

  it("counts file I/O failures instead of throwing", () => {
    // The parent "directory" is a regular file, so mkdir/append must fail.
    const blocker = path.join(tmpRoot, "blocker");
    fs.writeFileSync(blocker, "x");
    logger.configure({ file: path.join(blocker, "tbai.log"), fileEnabled: true });
    logger.debug("test.loss", "will-fail");
    expect(() => logger.flushFileLines()).not.toThrow();
    expect(logger.getWriteStats().loss.ioFailures).toBeGreaterThanOrEqual(1);
  });

  it("resets counters on demand (per-process accounting)", () => {
    logger.configure({ level: "error" });
    logger.info("test.loss", "filtered");
    expect(logger.getWriteStats().loss.levelFiltered).toBe(1);
    logger.resetLossCounters();
    expect(logger.getWriteStats().loss).toEqual({
      levelFiltered: 0,
      ringSpliced: 0,
      fileQueueDropped: 0,
      ioFailures: 0,
    });
  });
});

describe("loss exposition", () => {
  it("exposes every counter through the Prometheus text", () => {
    logger.configure({ level: "error" });
    logger.info("test.loss", "filtered");
    const text = logLossMetricsText();
    expect(text).toContain("# TYPE tbai_log_entries_level_filtered counter");
    expect(text).toContain("tbai_log_entries_level_filtered 1");
    expect(text).toContain("tbai_log_entries_ring_spliced");
    expect(text).toContain("tbai_log_entries_file_queue_dropped");
    expect(text).toContain("tbai_log_file_io_failures");
  });
});

/**
 * Ring-buffer behaviour for the live log tail.
 *
 * The ring is a fixed-slot circular buffer, so the failure modes are ordering and
 * survival, not just counts: a walk from the wrong slot returns the right NUMBER
 * of entries in the wrong order, or keeps the wrong survivors after a wrap. These
 * cases therefore assert exact SEQUENCE numbers.
 *
 * `seq` is process-global because the logger is a singleton, so every expectation
 * is relative to `lastSeq` captured before the emits rather than an absolute
 * number. Each case first collapses the ring to one known entry
 * (`bufferSize: 1`) and then grows it, which makes the starting state exact no
 * matter what earlier cases left behind.
 */
describe("live log ring", () => {
  it("retains entries in emit order while filling, without evicting", () => {
    logger.configure({ bufferSize: 1 });
    const base = logger.lastSeq;
    logger.configure({ bufferSize: 4 }); // grows; retains the single entry
    for (let i = 0; i < 3; i += 1) logger.debug("test.ring.fill", `fill-${i}`);
    // 1 retained + 3 emitted fills the cap exactly, so nothing may be dropped:
    // the ring holds base..base+3 and the counter stays at 0.
    expect(logger.getRecentEntries(0).map((e) => e.seq)).toEqual([
      base,
      base + 1,
      base + 2,
      base + 3,
    ]);
    expect(logger.getWriteStats().loss.ringSpliced).toBe(0);
  });

  it("returns the newest entries in oldest-first order after wrapping", () => {
    logger.configure({ bufferSize: 1 });
    const base = logger.lastSeq;
    logger.configure({ bufferSize: 4 });
    for (let i = 0; i < 10; i += 1) logger.debug("test.ring.wrap", `w-${i}`);
    // The documented wrap contract: capacity 4 after 10 writes holds 7..10, in
    // that order. An array-front walk would yield the wrong four entries here.
    expect(logger.getRecentEntries(0).map((e) => e.seq)).toEqual([
      base + 7,
      base + 8,
      base + 9,
      base + 10,
    ]);
  });

  it("counts exactly one eviction per write once the ring is full", () => {
    logger.configure({ bufferSize: 1 });
    const base = logger.lastSeq;
    logger.configure({ bufferSize: 4 });
    logger.resetLossCounters();
    // Ring starts with 1 entry, absorbs 3 to reach the cap, then evicts 7 times.
    for (let i = 0; i < 10; i += 1) logger.debug("test.ring.evict", `e-${i}`);
    expect(logger.getWriteStats().loss.ringSpliced).toBe(7);
    expect(logger.getRecentEntries(0).length).toBe(4);
    expect(logger.lastSeq).toBe(base + 10);
  });

  it("filters by sinceSeq across the wrap boundary", () => {
    logger.configure({ bufferSize: 1 });
    const base = logger.lastSeq;
    logger.configure({ bufferSize: 4 });
    for (let i = 0; i < 10; i += 1) logger.debug("test.ring.since", `s-${i}`);
    // Retained entries are base+7..base+10. A filter past the retention window
    // must not resurrect evicted entries, and one inside it must still drop the
    // oldest survivors — both exercise the walk, not a front-anchored slice.
    expect(logger.getRecentEntries(base + 6).map((e) => e.seq)).toEqual([
      base + 7,
      base + 8,
      base + 9,
      base + 10,
    ]);
    expect(logger.getRecentEntries(base + 8).map((e) => e.seq)).toEqual([
      base + 9,
      base + 10,
    ]);
  });

  it("reports lastSeq correctly before full, after wrap, and after overwrite", () => {
    logger.configure({ bufferSize: 1 });
    const base = logger.lastSeq;
    logger.configure({ bufferSize: 4 });
    // Not yet full: the newest entry is not the last array slot.
    logger.debug("test.ring.lastseq", "one");
    expect(logger.lastSeq).toBe(base + 1);
    // Full and wrapping: the newest entry sits behind the head, not at the end.
    for (let i = 0; i < 9; i += 1) logger.debug("test.ring.lastseq", `l-${i}`);
    expect(logger.lastSeq).toBe(base + 10);
  });

  it("keeps only the newest entries when bufferSize shrinks", () => {
    logger.configure({ bufferSize: 1 });
    const base = logger.lastSeq;
    logger.configure({ bufferSize: 6 });
    for (let i = 0; i < 5; i += 1) logger.debug("test.ring.shrink", `p-${i}`);
    // 1 retained + 5 emitted fills the cap of 6 exactly.
    expect(logger.getRecentEntries(0).map((e) => e.seq)).toEqual([
      base,
      base + 1,
      base + 2,
      base + 3,
      base + 4,
      base + 5,
    ]);
    logger.configure({ bufferSize: 2 });
    // Shrinking retains the newest survivors, oldest-first — matching what the
    // previous front-splice left alive.
    expect(logger.getRecentEntries(0).map((e) => e.seq)).toEqual([
      base + 4,
      base + 5,
    ]);
  });

  it("keeps writing and ordering correctly immediately after a shrink", () => {
    logger.configure({ bufferSize: 1 });
    const base = logger.lastSeq;
    logger.configure({ bufferSize: 6 });
    for (let i = 0; i < 5; i += 1) logger.debug("test.ring.reshrink", `g-${i}`);
    logger.configure({ bufferSize: 2 });
    logger.resetLossCounters();
    logger.debug("test.ring.reshrink", "after-1");
    // Capacity is 2, so the write overwrites the oldest survivor instead of
    // growing the ring, and the advanced head is still read correctly.
    expect(logger.getRecentEntries(0).map((e) => e.seq)).toEqual([
      base + 5,
      base + 6,
    ]);
    expect(logger.getWriteStats().loss.ringSpliced).toBe(1);
    expect(logger.lastSeq).toBe(base + 6);
  });

  it("keeps ordering across a further wrap after a shrink", () => {
    logger.configure({ bufferSize: 1 });
    const base = logger.lastSeq;
    logger.configure({ bufferSize: 6 });
    for (let i = 0; i < 5; i += 1) logger.debug("test.ring.reshrink2", `g-${i}`);
    logger.configure({ bufferSize: 3 });
    expect(logger.getRecentEntries(0).map((e) => e.seq)).toEqual([
      base + 3,
      base + 4,
      base + 5,
    ]);
    logger.resetLossCounters();
    for (let i = 0; i < 4; i += 1) logger.debug("test.ring.reshrink2", `h-${i}`);
    // Four writes past a full post-shrink ring: each evicts exactly one, and the
    // survivors must still read oldest-first rather than in raw slot order.
    expect(logger.getRecentEntries(0).map((e) => e.seq)).toEqual([
      base + 7,
      base + 8,
      base + 9,
    ]);
    expect(logger.getWriteStats().loss.ringSpliced).toBe(4);
    expect(logger.lastSeq).toBe(base + 9);
  });
});
