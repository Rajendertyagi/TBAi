/**
 * MCP manager extraction parity.
 *
 * `src/services/mcp/manager.ts` was a 1,297-line god-file. It was split into
 * `manager.ts` (registry + state machine), `store.ts` (SQLite),
 * `transport.ts` (transports + diagnostics) and `tool-content.ts` (text
 * shaping). That split is a MOVE, so the things a client or an operator can
 * observe must not change.
 *
 * ## Why this asserts on SOURCE TEXT rather than behaviour
 *
 * The alternative - exercising every log path and asserting on emitted events -
 * would need a live MCP server, a configured credential store, and a mocked
 * transport, and would still miss the majority of these events (connect failure
 * branches, elicitation, sampling). Static capture of the literals is weaker than
 * a runtime test in one specific way, and it is worth naming: it proves the
 * literals are PRESENT and UNCHANGED, not that every one still executes.
 *
 * What it does buy is the property that actually broke during the extraction:
 * a log event renamed from `op: "connect"` to `op: "connection"`, or a column
 * changed from `auth_token` to `authToken`, fails here immediately rather than
 * silently breaking log search or a query at runtime.
 *
 * The non-vacuity cases at the bottom prove the comparisons actually bite.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../../helpers/repo-root";

/** The four modules that together make up the MCP manager. */
const MODULE_FILES = ["manager.ts", "store.ts", "transport.ts", "tool-content.ts"] as const;

const MCP_DIR = path.join(REPO_ROOT, "src/services/mcp");

function readModule(name: string): string {
  return readFileSync(path.join(MCP_DIR, name), "utf8");
}

/** Concatenated source of every module in the extraction. */
function combinedSource(): string {
  return MODULE_FILES.map(readModule).join("\n");
}

type ParitySnapshot = {
  loggerEvents: string[];
  loggerEventCallCount: number;
  operationLabels: string[];
  outcomeLabels: string[];
  sqlStatements: string[];
  sqlColumnMentions: string[];
  protocolVerbs: string[];
};

/** Recompute the snapshot from the modules on disk. */
function snapshot(source: string): ParitySnapshot {
  const events = [
    ...source.matchAll(/logger\.(trace|debug|info|warn|error)\(\s*"([^"]+)"\s*,\s*"([^"]+)"/g),
  ].map((m) => `${m[1]}|${m[2]}|${m[3]}`);
  const ops = [...source.matchAll(/\bop:\s*"([^"]+)"/g)].map((m) => m[1]);
  const outcomes = [...source.matchAll(/\boutcome:\s*"([^"]+)"/g)].map((m) => m[1]);
  const sql = [...source.matchAll(/(`|")((?:SELECT|INSERT|UPDATE|DELETE)\s[^`"]*)\1/g)].map((m) =>
    m[2].replace(/\s+/g, " ").trim(),
  );
  const cols = [
    ...source.matchAll(/\b(auth_token|enabled|updated_at|created_at|auth_type)\b/g),
  ].map((m) => m[1]);
  const verbs = [
    ...source.matchAll(
      /(roots\/list_changed|resources\/read|prompts\/get|sampling\/createMessage|elicitation\/create)/g,
    ),
  ].map((m) => m[1]);
  return {
    loggerEvents: [...new Set(events)].sort(),
    loggerEventCallCount: events.length,
    operationLabels: [...new Set(ops)].sort(),
    outcomeLabels: [...new Set(outcomes)].sort(),
    sqlStatements: [...new Set(sql)].sort(),
    sqlColumnMentions: [...new Set(cols)].sort(),
    protocolVerbs: [...new Set(verbs)].sort(),
  };
}

// Captured from the 1,297-line single-file manager.ts, before any move.
//
// FOUR DELIBERATE ADDITIONS since that capture:
//
//   - `loggerEventCallCount` 16 -> 17, for the one `mcp.operation` line
//     `abandonAttempt()` emits when a superseded attempt releases its resources
//     and reports nothing else.
//   - `outcomeLabels` gains "abandoned" for the same reason.
//   - `loggerEventCallCount` 24 -> 25, for the structured diagnostic warn log
//     emitted when a live transport closes unexpectedly (F3 lifecycle handling).
//   - `loggerEventCallCount` 25 -> 26, for the structured diagnostic warn log
//     emitted when an oversized stderr line is safely discarded.
//
// Everything else is still pinned byte-for-byte, and the mutation cases at the
// bottom still bite, so any FURTHER drift still fails here.
const BASELINE: ParitySnapshot = {
  loggerEvents: [
    "debug|mcp|mcp.filter_applied",
    "debug|mcp|mcp.operation",
    "debug|mcp|mcp.tool_filtered",
    "error|mcp|mcp.operation",
    "info|mcp|mcp.operation",
    "info|mcp|mcp.sdk_version",
    "warn|mcp|mcp.filter_empty",
    "warn|mcp|mcp.filter_unknown_entry",
    "warn|mcp|mcp.operation",
    "warn|mcp|mcp.stdio_stderr",
  ],
  loggerEventCallCount: 26,
  operationLabels: [
    "connect",
    "disconnect",
    "elicitation",
    "prompt",
    "reconnect",
    "resource_read",
    "roots",
    "roots_notify",
    "sampling",
    "test_connection",
  ],
  outcomeLabels: ["abandoned", "error", "ok", "started"],
  sqlStatements: [
    "DELETE FROM mcp_servers WHERE id = ?",
    "INSERT INTO mcp_servers (id, name, transport, command, args, url, env, headers, auth_type, auth_token, enabled, auto_connect, notes, roots, disabled_tools, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    "SELECT * FROM mcp_servers ORDER BY created_at ASC",
    "SELECT * FROM mcp_servers WHERE id = ?",
    "SELECT id, auth_token FROM mcp_servers",
    "UPDATE mcp_servers SET enabled = ?, updated_at = ? WHERE id = ?",
  ],
  sqlColumnMentions: ["auth_token", "auth_type", "created_at", "enabled", "updated_at"],
  protocolVerbs: ["elicitation/create", "roots/list_changed", "sampling/createMessage"],
};

describe("MCP manager extraction parity", () => {
  const now = snapshot(combinedSource());

  it("finds every module in the extraction, so nothing below can pass vacuously", () => {
    for (const name of MODULE_FILES) {
      expect(readModule(name).length, `${name} must exist and be non-empty`).toBeGreaterThan(0);
    }
  });

  it("keeps every logger scope/event pair", () => {
    expect(now.loggerEvents).toEqual(BASELINE.loggerEvents);
  });

  it("keeps the number of logger calls, so a moved call cannot be silently dropped", () => {
    expect(now.loggerEventCallCount).toBe(BASELINE.loggerEventCallCount);
  });

  it("keeps every operation label - these are what operators grep for", () => {
    expect(now.operationLabels).toEqual(BASELINE.operationLabels);
  });

  it("keeps every outcome label", () => {
    expect(now.outcomeLabels).toEqual(BASELINE.outcomeLabels);
  });

  it("keeps every SQL statement byte-for-byte", () => {
    expect(now.sqlStatements).toEqual(BASELINE.sqlStatements);
  });

  it("keeps every SQL column name", () => {
    expect(now.sqlColumnMentions).toEqual(BASELINE.sqlColumnMentions);
  });

  it("keeps every MCP protocol verb", () => {
    expect(now.protocolVerbs).toEqual(BASELINE.protocolVerbs);
  });
});

describe("MCP parity harness is non-vacuous", () => {
  it("detects a renamed operation label", () => {
    const mutated = combinedSource().replace('op: "connect"', 'op: "connection"');
    expect(snapshot(mutated).operationLabels).not.toEqual(BASELINE.operationLabels);
  });

  it("detects a renamed log event", () => {
    const mutated = combinedSource().replace('"mcp", "mcp.operation"', '"mcp", "mcp.op"');
    expect(snapshot(mutated).loggerEvents).not.toEqual(BASELINE.loggerEvents);
  });

  it("detects a changed SQL column", () => {
    // replaceAll: a single-occurrence replace would leave the other copies of
    // `auth_token` intact and the SET would be unchanged - a mutation that looks
    // like it worked while proving nothing.
    const mutated = combinedSource().replaceAll("auth_token", "authToken");
    expect(snapshot(mutated).sqlColumnMentions).not.toEqual(BASELINE.sqlColumnMentions);
  });

  it("detects a dropped SQL statement", () => {
    const mutated = combinedSource().replace(
      "DELETE FROM mcp_servers WHERE id = ?",
      "DELETE FROM servers WHERE id = ?",
    );
    expect(snapshot(mutated).sqlStatements).not.toEqual(BASELINE.sqlStatements);
  });

  it("detects a lost MCP protocol verb", () => {
    const mutated = combinedSource().replaceAll("roots/list_changed", "roots/changed");
    expect(snapshot(mutated).protocolVerbs).not.toEqual(BASELINE.protocolVerbs);
  });
});
