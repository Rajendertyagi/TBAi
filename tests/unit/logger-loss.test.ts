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
