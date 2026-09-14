/**
 * Log settings + files REST round-trip through the real Hono sub-app.
 *
 * DB isolation: tests/setup.ts (bunfig preload) redirects DATA_DIR to tmp.
 * The global logger is reconfigured per test and reset afterwards.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { logger } from "../../src/lib/logger";
import logsApp from "../../src/routes/logs";
import { persistLogSettings } from "../../src/services/log-settings";

const app = new Hono();
app.route("/api/logs", logsApp);

async function appFetch(path: string, init: RequestInit = {}) {
  const res = await app.request(path, init);
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* plain-text bodies (file download) */
  }
  return { status: res.status, json, text };
}

const json = { "Content-Type": "application/json" };

beforeEach(() => {
  logger.configure({ level: "debug", targets: [], file: null });
});

afterEach(() => {
  persistLogSettings({ level: "debug", targets: [] });
  logger.configure({ level: "error", targets: [], file: null });
});

describe("logs settings REST", () => {
  it("reports level, targets, and env lock", async () => {
    const res = await appFetch("/api/logs/settings");
    expect(res.status).toBe(200);
    expect(res.json.level).toBe("debug");
    expect(res.json.targets).toEqual([]);
    expect(res.json.env_locked).toBe(false);
  });

  it("persists valid settings and applies them live", async () => {
    const put = await appFetch("/api/logs/settings", {
      method: "PUT",
      headers: json,
      body: JSON.stringify({ level: "warn", targets: [{ scope: "mcp", level: "debug" }] }),
    });
    expect(put.status).toBe(200);
    expect(put.json.ok).toBe(true);
    expect(logger.level).toBe("warn");
    expect(logger.levelForScope("mcp")).toBe("debug");

    const got = await appFetch("/api/logs/settings");
    expect(got.json.level).toBe("warn");
    expect(got.json.targets).toEqual([{ scope: "mcp", level: "debug" }]);
  });

  it("rejects invalid settings", async () => {
    const badScope = await appFetch("/api/logs/settings", {
      method: "PUT",
      headers: json,
      body: JSON.stringify({ level: "info", targets: [{ scope: "no spaces", level: "debug" }] }),
    });
    expect(badScope.status).toBe(400);
    const badLevel = await appFetch("/api/logs/settings", {
      method: "PUT",
      headers: json,
      body: JSON.stringify({ level: "trace", targets: [] }),
    });
    expect(badLevel.status).toBe(400);
    // Failed writes change nothing.
    expect(logger.level).toBe("debug");
  });
});

describe("logs file settings", () => {
  it("round-trips file sink config and validates it", async () => {
    const put = await appFetch("/api/logs/settings", {
      method: "PUT",
      headers: json,
      body: JSON.stringify({
        level: "debug",
        targets: [],
        file: { enabled: false, maxMb: 5, keepFiles: 20, maxTotalMb: 100, retentionHours: 24 },
      }),
    });
    expect(put.status).toBe(200);
    const got = await appFetch("/api/logs/settings");
    expect(got.json.file.enabled).toBe(false);
    expect(got.json.file.maxTotalMb).toBe(100);
    expect(got.json.file_locked).toBe(false);

    const bad = await appFetch("/api/logs/settings", {
      method: "PUT",
      headers: json,
      body: JSON.stringify({
        level: "debug",
        targets: [],
        file: { enabled: true, maxMb: -5, keepFiles: 20, maxTotalMb: 100, retentionHours: 24 },
      }),
    });
    expect(bad.status).toBe(400);
  });

  it("reports retention metadata with the file list", async () => {
    await appFetch("/api/logs/settings", {
      method: "PUT",
      headers: json,
      body: JSON.stringify({
        level: "debug",
        targets: [],
        file: { enabled: false, maxMb: 5, keepFiles: 20, maxTotalMb: 100, retentionHours: 24 },
      }),
    });
    const listed = await appFetch("/api/logs/files");
    expect(listed.status).toBe(200);
    expect(Array.isArray(listed.json.files)).toBe(true);
    expect(typeof listed.json.writer.queued).toBe("number");
    expect(typeof listed.json.writer.dropped).toBe("number");
    expect(listed.json.retention.retentionHours).toBe(24);
    expect(listed.json.retention.maxTotalMb).toBe(100);
    expect(typeof listed.json.retention.totalBytes).toBe("number");
  });
});

describe("logs recent REST", () => {
  it("filters by level, search, and limit", async () => {
    logger.info("test.seed", "seed_info_event");
    logger.error("test.seed", "seed_error_event");

    const errors = await appFetch("/api/logs/recent?minLevel=error");
    expect(errors.status).toBe(200);
    const errorEvents = errors.json.entries.map((e: { event: string }) => e.event);
    expect(errorEvents).toContain("seed_error_event");
    expect(errorEvents).not.toContain("seed_info_event");

    const searched = await appFetch("/api/logs/recent?search=seed_error_event");
    expect(searched.json.entries.map((e: { event: string }) => e.event)).toEqual([
      "seed_error_event",
    ]);

    const limited = await appFetch("/api/logs/recent?limit=1");
    expect(limited.json.entries).toHaveLength(1);

    // Time range: a future window matches nothing; the past matches all.
    const future = await appFetch(`/api/logs/recent?since=0&from=${Date.now() + 3600_000}`);
    expect(future.json.entries).toEqual([]);
    const past = await appFetch(`/api/logs/recent?since=0&until=${Date.now() + 3600_000}`);
    expect(past.json.entries.length).toBeGreaterThan(0);
    const badRange = await appFetch("/api/logs/recent?from=not-a-number");
    expect(badRange.status).toBe(400);

    // Entries carry the server boot id so viewers can reset (not append)
    // when the server restarts and seqs start over.
    expect(typeof limited.json.bootId).toBe("string");
    expect(limited.json.bootId.length).toBeGreaterThan(0);
    const again = await appFetch("/api/logs/recent?limit=1");
    expect(again.json.bootId).toBe(limited.json.bootId);

    const bad = await appFetch("/api/logs/recent?limit=99999");
    expect(bad.status).toBe(400);
  });
});

describe("http edge coverage", () => {
  it("logs every failed response and successful requests centrally", async () => {
    // The full app (all routes + edge middleware). Failed responses must each
    // produce exactly one http.error entry — no route needs its own error line.
    const full = (await import("../../src/routes/index")).default;
    const since = logger.lastSeq;
    const nf = await full.request("/api/conversations/does-not-exist");
    expect(nf.status).toBe(404);
    const ok = await full.request("/api/health");
    expect(ok.status).toBe(200);
    const fresh = logger.getRecentEntries(since);
    const failed = fresh.find(
      (e) => e.event === "http.error" && String(e.message ?? "").includes("/api/conversations/does-not-exist"),
    );
    expect(failed).toBeTruthy();
    expect(failed?.level).toBe("warn");
    expect(failed?.statusCode).toBe(404);
    const completed = fresh.find(
      (e) => e.event === "http.request" && String(e.message ?? "").includes("/api/health"),
    );
    expect(completed).toBeTruthy();
  });

  it("demotes routine elicitation polls to debug (failures still warn)", async () => {
    const full = (await import("../../src/routes/index")).default;
    const since = logger.lastSeq;
    const res = await full.request("/api/mcp/elicit/pending");
    expect(res.status).toBe(200);
    const fresh = logger.getRecentEntries(since);
    const line = fresh.find(
      (e) => e.event === "http.request" && String(e.message ?? "").includes("/api/mcp/elicit/pending"),
    );
    expect(line).toBeTruthy();
    expect(line?.level).toBe("debug");
  });
});

describe("logs files REST", () => {
  it("lists no files when the sink is off and 404s unknowns", async () => {
    const listed = await appFetch("/api/logs/files");
    expect(listed.status).toBe(200);
    expect(listed.json.files).toEqual([]);

    const missing = await appFetch("/api/logs/files/tbai.log");
    expect(missing.status).toBe(404);

    const traversal = await appFetch("/api/logs/files/..%2Fchat.db");
    expect(traversal.status).toBe(404);
  });
});
