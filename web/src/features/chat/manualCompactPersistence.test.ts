/**
 * The manual `/compact` persistence invariant.
 *
 * ## What is being protected
 *
 * A manual compaction produces EXACTLY ONE durable divider row, and the server's
 * `persistCompactionDivider` is the only thing that writes it. The Composer ALSO
 * appends a divider to the live thread, and that append is deliberately
 * non-persisting: `adapters.history` is not configured on this runtime, so the
 * assistant-ui library only writes messages the transport streams. The append exists
 * so the divider is on screen immediately; the row is what a reload replays.
 *
 * That is a real architectural invariant resting on a library/configuration
 * behaviour, and it was measured but unguarded. If `adapters.history` were ever
 * configured, every manual `/compact` would write a SECOND row for the same
 * compaction and the transcript would show a duplicate divider after a refresh.
 *
 * ## What each half of this file can and cannot prove
 *
 * `web/` has no DOM runner, so the CLIENT half is pinned against the source — the
 * same convention as `recoveryGuards.test.ts` and `OpenCodeView.test.tsx`. That
 * proves TBAi performs no message persistence of its own for the command; it cannot
 * prove what the library does with an appended message.
 *
 * The SERVER half is a real route-level integration test in
 * `tests/integration/direct-manual-compact.test.ts` ("a second `/compact` adds
 * exactly one more row"), which is the half that actually decides the count.
 *
 * A runtime proof that `thread().append()` does not persist — rendering a real
 * assistant-ui runtime with a history-adapter spy — is UNVERIFIED: there is no DOM
 * runner in this package to build one with.
 */

import { describe, expect, it, beforeAll } from "bun:test";
import {
  buildDividerPart,
  type DirectCompactStatus,
} from "./compactCommand";
import { composerConfig } from "../../config/composer";

const sources: Record<string, string> = {};

beforeAll(async () => {
  const base = import.meta.url;
  const files: Record<string, string> = {
    composer: "../../components/Composer.tsx",
    adapter: "../../adapters/threadHistoryAdapter.ts",
  };
  await Promise.all(
    Object.entries(files).map(async ([key, rel]) => {
      sources[key] = await Bun.file(new URL(rel, base)).text();
    }),
  );
});

const status: DirectCompactStatus = {
  outcome: "compacted",
  reason: "compacted",
  generation: 1,
  spanLength: 12,
  summaryTokens: 40,
  reclaimedTokens: 900,
  requestFits: true,
  operationId: "op-1",
  anchorMessageId: "data-tbai-compact-op-1",
  origin: "manual",
};

/** The composer's Direct compaction command, as source. */
function composerCompactCommand(): string {
  const start = sources.composer.indexOf("const runDirectCompactCommand");
  expect(start).toBeGreaterThan(-1);
  const end = sources.composer.indexOf("\n  };", start);
  return sources.composer.slice(start, end);
}

describe("the client's role in manual compaction persistence", () => {  it("appends the divider in memory and starts no run", () => {
    const body = composerCompactCommand();
    // `startRun: false` is what keeps a compaction from becoming a chat run: no
    // provider call, no assistant reply, no conversational artefact.
    expect(body).toContain("startRun: false");
    expect(body).toContain("aui.thread().append(");
    expect(body).toContain("buildDividerPart(status)");
  });

  it("performs NO message persistence of its own", () => {
    const body = composerCompactCommand();
    // The durable write is the server's. If any of these appear here, the client has
    // started writing a second divider and the "exactly one row" property is at risk.
    expect(body).not.toContain("appendStored");
    expect(body).not.toContain("/messages");
    expect(body).not.toContain("upsertStored");
    expect(body).not.toContain("fetch(");
  });

  it("clears the composer only after the status arrives", () => {
    const body = composerCompactCommand();
    const append = body.indexOf("aui.thread().append(");
    const clear = body.indexOf("setText(\"\")");
    // Ordering is the invariant: nothing is consumed, and nothing is shown, until the
    // server has actually said what it did. A transport failure must leave the text
    // in the box so a retry is possible.
    expect(append).toBeGreaterThan(-1);
    expect(clear).toBeGreaterThan(append);
  });

  it("keys the divider payload on the server's operation identity", () => {
    // Two compactions must be two entries, and one compaction must be one: the row
    // the server stores is keyed by `operationId`, so this is the client half of that
    // identity agreeing with it.
    const a = buildDividerPart(status);
    const b = buildDividerPart({ ...status, operationId: "op-2", generation: 2 });
    expect(a.data.operationId).toBe("op-1");
    expect(b.data.operationId).toBe("op-2");
    expect(a.data.operationId).not.toBe(b.data.operationId);
    expect(a.type).toBe(b.type);
    expect(a.name).toBe(b.name);
  });

  it("carries the server's anchor so the row and the screen agree", () => {
    expect(buildDividerPart(status).data.anchorMessageId).toBe("data-tbai-compact-op-1");
    // A row the server could not write is `null`, not an empty id, so "on screen only"
    // is distinguishable from "durable".
    expect(buildDividerPart({ ...status, anchorMessageId: null }).data.anchorMessageId).toBeNull();
  });
});

describe("the runtime's persistence configuration", () => {
  it("the history adapter still only persists what the adapter is asked to persist", () => {
    // Documents WHY the invariant holds, and would catch a change that made the
    // adapter write on its own initiative.
    const adapter = sources.adapter;
    expect(adapter).toContain("async append(item: ExportedMessageRepositoryItem)");
    expect(adapter).toContain("async update(item: ExportedMessageRepositoryItem)");
    // The guard that keeps the write server-confirmed rather than silently divergent.
    expect(adapter).toContain("Failed to persist message");
  });
});

/**
 * The in-flight indicator for a Direct `/compact`.
 *
 * The gap it closes: the summariser call can take up to `COMPACTION_SUMMARY_TIMEOUT_MS`
 * (30 s) and until Change 2 the composer showed nothing at all for that whole window,
 * so a working app was indistinguishable from a hung one.
 *
 * What it is NOT: an outcome. The verdict belongs to the transcript divider. An
 * earlier design put the outcome in the composer and it was removed as a toast — the
 * assertions below exist so it cannot quietly come back.
 */
describe("the in-flight indicator for a Direct compaction", () => {
  it("sets the flag BEFORE awaiting, so the wait is covered at all", () => {
    const body = composerCompactCommand();
    const set = body.indexOf("setDirectCompacting(true)");
    const call = body.indexOf("await runDirectCompact(");
    // Setting it after the await would leave the exact silence this exists to remove.
    expect(set).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(-1);
    expect(set).toBeLessThan(call);
  });

  it("clears the flag in `finally`, so a transport failure cannot strand it", () => {
    const body = composerCompactCommand();
    // Not the success path: a thrown transport would otherwise leave the indicator
    // on forever with no second submit available to clear it.
    expect(body).toContain("} finally {");
    const finallyAt = body.indexOf("} finally {");
    const clear = body.indexOf("setDirectCompacting(false)");
    expect(clear).toBeGreaterThan(finallyAt);
  });

  it("does NOT drive the Code surface's own compact state", () => {
    const body = composerCompactCommand();
    // `compacting` / `compactError` belong to the Code path (Composer.tsx:506). Driving
    // them from Direct is precisely what produced the composer toast this replaced.
    expect(body).not.toContain("setCompacting(");
    expect(body).not.toContain("setCompactError(");
    expect(body).toContain("setDirectCompacting(");
  });

  it("renders its own line, gated on the flag, announced as a status", () => {
    const composer = sources.composer;
    expect(composer).toContain("directCompacting ? (");
    expect(composer).toContain('role="status"');
    // A line of its own: the button row is a `justify-between` slot of fixed chips,
    // so text placed inside it would shift every chip on appearance.
    expect(composer).toContain("composerConfig.copy.compactingContext");
  });

  it("shows NO outcome — the verdict belongs to the transcript divider", () => {
    const composer = sources.composer;
    // Any of these in the composer re-creates the retired outcome strip.
    for (const verdict of ["skipped", "failed", "compacted"]) {
      const indicator = composer.slice(
        composer.indexOf("directCompacting ? ("),
        composer.indexOf("Button row: attach on left"),
      );
      expect(indicator).not.toContain(verdict);
    }
  });

  it("keeps the copy in composerConfig, not inline in the component", () => {
    // The same rule every other composer string follows.
    expect(composerConfig.copy.compactingContext.length).toBeGreaterThan(0);
    expect(sources.composer).not.toContain("Compacting context");
  });

  it("is transient — nothing persists it and it becomes no message", () => {
    const body = composerCompactCommand();
    // No store write, no message, no run. It is a local flag and a conditional node.
    expect(body).not.toContain("localStorage");
    expect(body).not.toContain("createJSONStorage");
    expect(body).not.toContain("startRun: true");
  });
});