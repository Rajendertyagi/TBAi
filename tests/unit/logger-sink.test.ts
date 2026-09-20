import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import fs from "fs";
import path from "path";
import os from "os";
import {
  listLogFiles,
  logger,
  pruneLogFiles,
} from "../../src/lib/logger";

let tmpRoot: string;

function tmpDir(name: string): string {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function touch(dir: string, name: string, ageMs = 0, size = 10): void {
  const p = path.join(dir, name);
  fs.writeFileSync(p, "x".repeat(size));
  if (ageMs > 0) {
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(p, t, t);
  }
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tbai-logsink-"));
  logger.resetLossCounters();
  logger.configure({ level: "debug", targets: [], file: null, fileEnabled: false });
});

afterEach(() => {
  logger.flushFileLines();
  logger.configure({ level: "error", targets: [], file: null, fileEnabled: false });
  logger.resetLossCounters();
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("async batched file writer", () => {
  it("batches lines and preserves order", () => {
    const file = path.join(tmpDir("batch"), "tbai.log");
    logger.configure({ level: "debug", file, fileEnabled: true });
    logger.debug("test.sink", "first");
    logger.debug("test.sink", "second");
    logger.debug("test.sink", "third");
    // Nothing hits disk before the flush — proof of batching.
    expect(fs.existsSync(file)).toBe(false);
    expect(logger.getWriteStats().queued).toBe(3);
    logger.flushFileLines();
    const lines = fs.readFileSync(file, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => (JSON.parse(l) as { event: string }).event)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(logger.getWriteStats().queued).toBe(0);
  });

  it("counts queued lines dropped when the sink is off", () => {
    const file = path.join(tmpDir("drop"), "tbai.log");
    logger.configure({ level: "debug", file, fileEnabled: true });
    logger.debug("test.sink", "a");
    logger.debug("test.sink", "b");
    logger.configure({ fileEnabled: false, file: null });
    logger.flushFileLines();
    expect(logger.getWriteStats().dropped).toBe(2);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("rotates on size without per-entry stats", () => {
    const dir = tmpDir("rotate");
    const file = path.join(dir, "tbai.log");
    logger.configure({ level: "debug", file, fileEnabled: true, maxBytes: 200, keepFiles: 2 });
    // Rotation is checked pre-append: first flush creates the file, the
    // second observes it over budget and rotates.
    for (let i = 0; i < 8; i++) logger.debug("test.sink", `filler-event-number-${i}-padding`);
    logger.flushFileLines();
    for (let i = 0; i < 8; i++) logger.debug("test.sink", `filler-event-number-${i}-padding`);
    logger.flushFileLines();
    expect(fs.existsSync(`${file}.1`)).toBe(true);
  });
});

describe("retention pruning", () => {
  it("drops rotated generations older than retention, never the live base", () => {
    const dir = tmpDir("prune-age");
    touch(dir, "tbai.log", 0, 50);
    touch(dir, "tbai.log.1", 48 * 3600 * 1000, 50);
    touch(dir, "tbai.log.2", 60 * 1000, 50);
    const kept = pruneLogFiles(dir, { maxTotalBytes: 10 ** 9, retentionMs: 24 * 3600 * 1000 });
    expect(fs.existsSync(path.join(dir, "tbai.log.1"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "tbai.log"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "tbai.log.2"))).toBe(true);
    expect(kept.map((f) => f.name).sort()).toEqual(["tbai.log", "tbai.log.2"]);
  });

  it("caps total bytes oldest-first", () => {
    const dir = tmpDir("prune-cap");
    touch(dir, "tbai.log", 0, 50);
    touch(dir, "tbai.log.1", 60 * 1000, 400);
    touch(dir, "tbai.log.2", 2 * 60 * 1000, 400);
    const kept = pruneLogFiles(dir, { maxTotalBytes: 500, retentionMs: 24 * 3600 * 1000 });
    // Newest-first accounting: base(50) + .1(400) = 450 fits; .2 exceeds.
    expect(fs.existsSync(path.join(dir, "tbai.log.2"))).toBe(false);
    expect(kept.map((f) => f.name).sort()).toEqual(["tbai.log", "tbai.log.1"]);
  });

  it("lists generations base-first and ignores foreign files", () => {
    const dir = tmpDir("list");
    touch(dir, "tbai.log.2", 0, 5);
    touch(dir, "tbai.log", 0, 7);
    touch(dir, "other.txt", 0, 9);
    const listed = listLogFiles(dir);
    expect(listed.map((f) => f.name)).toEqual(["tbai.log", "tbai.log.2"]);
    expect(listed[0].size_bytes).toBe(7);
    expect(listLogFiles(path.join(dir, "missing"))).toEqual([]);
  });
});

describe("scope throttling", () => {
  beforeEach(() => {
    logger.resetThrottleStates();
  });

  it("sheds sustained info above budget with an engage marker", () => {
    const since = logger.lastSeq;
    for (let i = 0; i < 120; i++) logger.info("throttle.probe", `spam-${i}`);
    const fresh = logger.getRecentEntries(since);
    const infos = fresh.filter(
      (e) => e.scope === "throttle.probe" && e.level === "info" && e.event !== "scope.throttled",
    );
    // Bucket absorbs the burst; the sustained excess is shed, not stored.
    expect(infos.length).toBeLessThanOrEqual(101);
    expect(infos.length).toBeGreaterThanOrEqual(90);
    const markers = fresh.filter((e) => e.event === "scope.throttled");
    expect(markers.length).toBeGreaterThanOrEqual(1);
    expect((markers[0] as { engaged?: boolean }).engaged).toBe(true);
    const stats = logger.getWriteStats();
    expect(stats.throttled.find((t) => t.scope === "throttle.probe")?.dropped).toBeGreaterThan(10);
  });

  it("never throttles warn/error or the http audit scope", () => {
    const since = logger.lastSeq;
    for (let i = 0; i < 10; i++) logger.warn("throttle.probe2", `w-${i}`);
    for (let i = 0; i < 150; i++) logger.info("http", `h-${i}`);
    const fresh = logger.getRecentEntries(since);
    expect(fresh.filter((e) => e.scope === "throttle.probe2")).toHaveLength(10);
    expect(fresh.filter((e) => e.scope === "http")).toHaveLength(150);
  });
});
