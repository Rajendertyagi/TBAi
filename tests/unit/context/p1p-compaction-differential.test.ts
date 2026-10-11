/**
 * P1′ Real Compaction Differential Verification
 *
 * ## What this file proves, and what it cannot
 *
 * Each scenario drives the REAL compaction seam — the real planner, the real
 * summariser call (via `MockLanguageModelV3`), the real record application — and
 * then compares the OLD client-authoritative path against the P1′
 * server-authoritative path on IDENTICAL inputs.
 *
 * The harness deliberately separates the two questions that were previously
 * conflated:
 *
 * 1. "Did compaction actually happen?" — asserted with the real
 *    `provenance.compaction` (`applied`, `reason`, `generation`, `spanLength`).
 *    A run that plans a span but fails to persist it reports `applied: false`
 *    with a failure reason, and its Layer C is the untouched input, so an
 *    OLD-vs-P1′ equality on such a run is vacuous. Every scenario here therefore
 *    asserts a genuinely applied compaction BEFORE comparing the two paths.
 * 2. "Do the two paths agree?" — asserted over the resulting Layer C and over the
 *    compaction provenance, with both paths seeded from the same real record.
 *
 * `persist` is an injected seam input ("Injected so storage stays out of the
 * decision path"), so a single-contended-writer in-memory sink is a faithful
 * stand-in for sequential use. The durable-store round trip is covered
 * separately by `src/services/compaction-d1.test.ts`.
 */

import { describe, expect, it, beforeEach } from "bun:test";
import type { UIMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { assembleContext } from "@/context/assemble.ts";
import { DEFAULT_COMPACTION_POLICY } from "@/context/compaction";
import type { CompactionRecord } from "@/context/compaction";
import type { CompactionSeam } from "@/context/types.ts";
import { messageService, conversationService } from "@/services/storage";
import { db } from "@/db";
import type { ProviderConfig } from "@/types";

const TEST_WINDOW = 32_000;
const FIXED_NOW = 1_700_000_000_000;
const SUMMARISED_BY = "anthropic/claude-test";
const SUMMARY_TIMEOUT_MS = 5_000;

/**
 * A summary large enough to clear the adequacy floor for the spans under test.
 *
 * `requiredSummaryTokens` is `max(8, min(spanTokens × 0.01, maxSummaryTokens / 2))`,
 * so for a crossing span of tens of thousands of tokens the floor is the cap — 750
 * here. A short mock summary is refused as `summary_inadequate`, the compaction is
 * discarded, and the run silently compares two uncompacted histories. This sits
 * above the cap and below `maxSummaryTokens`.
 */
const ADEQUATE_SUMMARY = Array.from(
  { length: 36 },
  (_, i) => `line ${i} detail about topic ${i} and task ${i} that the assistant left open for later.`,
).join(" ");

/** Context window for the crossing scenarios; see `crossingWindowIsUsable` below. */
const CROSSING_WINDOW = 84_000;

const provider: ProviderConfig = {
  id: "p1",
  name: "Test",
  type: "anthropic",
  models: [
    {
      id: "claude-test",
      name: "Claude Test",
      contextWindow: TEST_WINDOW,
      maxOutputTokens: 4096,
    },
  ],
} as unknown as ProviderConfig;

/**
 * A wider model for the scenarios that must reach the CROSSING branch.
 *
 * ## Why the crossing scenarios need their own window
 *
 * Crossing is reachable only when the ordinary assistant-anchored span is
 * ALREADY fully covered by a record, which happens on the pass after a
 * compaction that stopped at the last assistant reply. That pass must then still
 * be under real pressure, or the planner refuses with `below_trigger` before it
 * ever evaluates crossing. And `forceCompaction` is no substitute: `forced`
 * skips the hysteresis block that contains the crossing attempt outright.
 *
 * After the record is re-applied the covered prefix collapses into one summary,
 * so the pressure that survives is only the UNCOVERED tail. Writing `U` for
 * usable input and `C`/`T` for covered-raw and tail tokens, the two constraints
 * are `T > 0.8U` (pressure) and `C + T ≤ U - 2048` (one summariser call), leaving
 * a window of `0.2U - 2048 - C` tokens. At the small window that window is a few
 * hundred tokens wide — too narrow to tune honestly. A wider window makes the
 * scenario express the behaviour instead of the arithmetic.
 */
const crossingProvider: ProviderConfig = {
  id: "p1-crossing",
  name: "Test Crossing",
  type: "anthropic",
  models: [
    {
      id: "claude-test-crossing",
      name: "Claude Test Crossing",
      contextWindow: CROSSING_WINDOW,
      maxOutputTokens: 4096,
    },
  ],
} as unknown as ProviderConfig;

// ─── message fixtures ────────────────────────────────────────────────────────

function user(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as unknown as UIMessage;
}

function toolTurn(id: string, toolCallId: string): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [
      { type: "text", text: "running", state: "done" },
      {
        type: "tool-read_file",
        toolName: "read_file",
        toolCallId,
        state: "output-available",
        input: { path: "a.txt" },
        output: { path: "a.txt", totalLines: 1, truncated: false, content: "result" },
      },
    ],
  } as unknown as UIMessage;
}

function approvalPaused(id: string, toolCallId: string, approvalId: string): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [
      {
        type: "tool-delete_file",
        toolCallId,
        state: "approval-requested",
        input: { path: "a.txt" },
        approval: { id: approvalId },
      },
    ],
  } as unknown as UIMessage;
}

/** A user turn carrying a model-visible attachment, i.e. one that needs preserving. */
function fileUser(id: string, text: string, filename: string, dataUrl: string): UIMessage {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text }, { type: "file", mediaType: "text/plain", filename, url: dataUrl }],
  } as unknown as UIMessage;
}

function filler(repeat: number): string {
  return "context filler text that costs real tokens. ".repeat(repeat);
}

/** `turns` settled tool-using turns followed by the live request. */
function settledHistory(turns: number, repeat: number): UIMessage[] {
  const messages: UIMessage[] = [];
  for (let i = 0; i < turns; i += 1) {
    messages.push(user(`u${i}`, `question ${i} ${filler(repeat)}`));
    messages.push(toolTurn(`a${i}`, `tc${i}`));
  }
  return messages;
}

/** Settled history that ends on an unresolved approval rather than a live request. */
function approvalPausedHistory(turns: number, repeat: number): UIMessage[] {
  const messages = settledHistory(turns, repeat);
  messages.push(user("live", "THE LIVE REQUEST"));
  messages.push(approvalPaused("aLive", "tc-live", "ap-live"));
  return messages;
}

/**
 * The crossing fixture, sized for `crossingProvider`.
 *
 * The tail holds `CROSSING_SUPERSEDED` file-bearing turns plus the live request,
 * which is at least `minRetainedTail`, so the retained-tail floor lands at 0 and
 * the first pass covers the whole settled history. The tail is what must keep the
 * second pass under pressure once that prefix has collapsed into a summary.
 */
const CROSSING_SUPERSEDED = 5;
const CROSSING_SETTLED_REPEAT = 25;
const CROSSING_TAIL_REPEAT = 550;

function crossingFixture(): UIMessage[] {
  const messages = settledHistory(20, CROSSING_SETTLED_REPEAT);
  for (let i = 1; i <= CROSSING_SUPERSEDED; i += 1) {
    messages.push(
      fileUser(
        `f${i}`,
        `attachment ${i} ${filler(CROSSING_TAIL_REPEAT)}`,
        `file-${i}.txt`,
        `data:text/plain;base64,${Buffer.from(`contents of file ${i}`).toString("base64")}`,
      ),
    );
  }
  messages.push(user("live", "THE LIVE REQUEST"));
  return messages;
}

const CROSSING_MODEL = {
  provider: crossingProvider,
  modelId: "claude-test-crossing",
} as const;

/**
 * Growth large enough to re-clear the trigger on a repeated compaction.
 *
 * Below this the planner refuses with `below_trigger`; far above it the request
 * stops fitting and it refuses with `would_still_exceed_budget` instead.
 */
const CHAIN_GROWTH_REPEAT = 800;

// ─── seam harness ────────────────────────────────────────────────────────────

function summaryOnlyModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text" as const, text: ADEQUATE_SUMMARY }],
      finishReason: { unified: "stop" as const, raw: "end_turn" },
      usage: {
        inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 40, text: 40, reasoning: 0 },
      },
      warnings: [],
    }),
  });
}

/**
 * The real seam, with persistence injected.
 *
 * The sink records what a store would hold and returns it unchanged, which is
 * what a sequential conversation does. Returning `undefined` instead would model
 * a failed write, and `maybeCompact` discards the compaction with
 * `persist_failed` — so the run would silently compare two uncompacted histories.
 */
function seam(existingRecord: CompactionRecord | undefined, sink: CompactionStoreSink): CompactionSeam {
  return {
    policy: DEFAULT_COMPACTION_POLICY,
    existingRecord,
    persist: (record) => {
      sink.record = record;
      return record;
    },
    releaseLatch: () => {},
    summarizerModel: summaryOnlyModel() as never,
    summarizedBy: SUMMARISED_BY,
    nextCompactionId: (generation) => `cmp_${generation}`,
    now: () => FIXED_NOW,
    signal: new AbortController().signal,
    timeoutMs: SUMMARY_TIMEOUT_MS,
  };
}

interface CompactionStoreSink {
  record: CompactionRecord | undefined;
}

interface RunResult {
  readonly layerC: readonly UIMessage[];
  readonly report: NonNullable<
    Awaited<ReturnType<typeof assembleContext>>["context"]["provenance"]["compaction"]
  >;
  readonly persisted: CompactionRecord | undefined;
  readonly decision: Awaited<ReturnType<typeof assembleContext>>["decision"];
}

async function runOnce(args: {
  conversationId: string;
  messages: UIMessage[];
  existingRecord?: CompactionRecord | undefined;
  disableP1p?: boolean;
  forceCompaction?: boolean;
  model?: { readonly provider: ProviderConfig; readonly modelId: string };
}): Promise<RunResult> {
  const sink: CompactionStoreSink = { record: undefined };
  const result = await assembleContext({
    conversationId: args.conversationId,
    submittedMessages: args.messages,
    runId: "test",
    provider: args.model?.provider ?? provider,
    modelId: args.model?.modelId ?? "claude-test",
    systemPrompt: "SYSTEM RULES",
    toolSignal: new AbortController().signal,
    disableP1p: args.disableP1p,
    forceCompaction: args.forceCompaction,
    compaction: seam(args.existingRecord, sink),
  });
  const report = result.context.provenance.compaction;
  if (!report) throw new Error("expected a compaction report: the seam was wired");
  return { layerC: result.context.layerC.messages, report, persisted: sink.record, decision: result.decision };
}

/** A record handed to two runs must not be shared by reference. */
function seed(record: CompactionRecord | undefined): CompactionRecord | undefined {
  return record === undefined ? undefined : (structuredClone(record) as CompactionRecord);
}

async function createTestConversation(messages: UIMessage[]) {
  const conv = await conversationService.create({ title: "test", providerId: "test", workspaceMode: "simple" });
  let prevId: string | null = null;
  for (const msg of messages) {
    await messageService.upsertStored(conv.id, {
      id: msg.id,
      parent_id: prevId,
      format: "ai-sdk/v6",
      content: msg,
    });
    prevId = msg.id;
  }
  return conv;
}

/** Extend a conversation's stored chain, as a conversation that keeps growing does. */
async function appendToConversation(
  conversationId: string,
  messages: readonly UIMessage[],
  fromIndex: number,
): Promise<void> {
  let prevId: string | null = fromIndex === 0 ? null : ((messages[fromIndex - 1] as { id?: string }).id ?? null);
  for (let i = fromIndex; i < messages.length; i += 1) {
    const msg = messages[i] as { id?: string };
    await messageService.upsertStored(conversationId, {
      id: msg.id ?? "",
      parent_id: prevId,
      format: "ai-sdk/v6",
      content: messages[i],
    });
    prevId = msg.id ?? null;
  }
}

/** Key-order-independent comparison, since reconstruction rebuilds objects. */
function canonicalize(messages: readonly UIMessage[]): string {
  return JSON.stringify(messages, (_key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.keys(value)
        .sort()
        .reduce<Record<string, unknown>>((sorted, k) => {
          sorted[k] = value[k];
          return sorted;
        }, {});
    }
    return value;
  });
}

function idsOf(messages: readonly UIMessage[]): string[] {
  return messages.map((m) => (m as { id?: string }).id ?? "");
}

function preservedOf(messages: readonly UIMessage[]): UIMessage[] {
  return messages.filter((m) => (m as { id?: string }).id?.startsWith("tbai-preserved:") === true);
}

/**
 * The span identity encoded in the synthetic replay ids, e.g. `span:abc123:45`.
 *
 * `preservedMessageId` is `tbai-preserved:<spanFingerprint>:<originalId>` and the
 * fingerprint is `span:<hash>:<spanLength>`, so this recovers the identity of the
 * span each path actually cut.
 */
function spanOfPreserved(messages: readonly UIMessage[]): string | undefined {
  const first = preservedOf(messages)[0] as { id?: string } | undefined;
  const parts = first?.id?.split(":") ?? [];
  return parts.length >= 4 ? `${parts[1]}:${parts[2]}:${parts[3]}` : undefined;
}

/**
 * Canonical form with ONLY span-derived identity normalised away.
 *
 * Two things in Layer C encode the span rather than the conversation:
 *
 *  - the synthetic replay id, `tbai-preserved:<spanFingerprint>:<originalId>`
 *  - the divider's own description, which counts what was summarised
 *    ("N earlier message(s) summarized")
 *
 * Both are factored out so two paths that cut different spans can be compared on
 * everything that IS conversation content — message identity, role, ordering, text,
 * tool parts, `data-tbai-compact` parts, attachment media type/filename/data URL.
 * The span values themselves are pinned exactly by separate assertions, so nothing
 * is lost by normalising them here.
 */
function canonicalizeModuloSpan(messages: readonly UIMessage[]): string {
  return JSON.stringify(messages, (key, value) => {
    if (key === "id" && typeof value === "string" && value.startsWith("tbai-preserved:")) {
      return value.replace(/^tbai-preserved:span:[^:]+:\d+:/, "tbai-preserved:");
    }
    if (typeof value === "string") {
      return value.replace(/\d+ earlier message\(s\) summarized/g, "<span> earlier message(s) summarized");
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.keys(value)
        .sort()
        .reduce<Record<string, unknown>>((sorted, k) => {
          sorted[k] = value[k];
          return sorted;
        }, {});
    }
    return value;
  });
}

interface DifferentialOutcome {
  readonly old: RunResult;
  readonly current: RunResult;
}

/**
 * Run OLD and P1′ over the identical persisted state and compare.
 *
 * Both paths must have genuinely compacted, otherwise the comparison is between
 * two untouched histories and proves nothing. The compaction provenance is
 * compared alongside Layer C so a divergence in what was replaced is caught even
 * when the resulting transcript happens to match.
 */
function expectEquivalent(outcome: DifferentialOutcome): void {
  expect(outcome.old.report.applied).toBe(true);
  expect(outcome.current.report.applied).toBe(true);
  expect(outcome.old.report.reason).toBe(outcome.current.report.reason);
  expect(outcome.old.report.generation).toBe(outcome.current.report.generation);
  expect(outcome.old.report.spanLength).toBe(outcome.current.report.spanLength);
  expect(outcome.old.report.spanFingerprint).toBe(outcome.current.report.spanFingerprint);
  expect(outcome.old.report.summaryTokens).toBe(outcome.current.report.summaryTokens);
  expect(canonicalize(outcome.current.layerC)).toBe(canonicalize(outcome.old.layerC));
}

/** OLD and P1′ seeded from the same real record, in the same order. */
async function differential(args: {
  conversationId: string;
  messages: UIMessage[];
  existingRecord?: CompactionRecord | undefined;
  forceCompaction?: boolean;
  model?: { readonly provider: ProviderConfig; readonly modelId: string };
}): Promise<DifferentialOutcome> {
  const old = await runOnce({
    conversationId: args.conversationId,
    messages: args.messages,
    existingRecord: seed(args.existingRecord),
    disableP1p: true,
    forceCompaction: args.forceCompaction,
    model: args.model,
  });
  const current = await runOnce({
    conversationId: args.conversationId,
    messages: args.messages,
    existingRecord: seed(args.existingRecord),
    forceCompaction: args.forceCompaction,
    model: args.model,
  });
  return { old, current };
}

describe("P1′ real compaction differential", () => {
  beforeEach(() => {
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
    db.run("DELETE FROM conversation_compactions");
  });

  it("manual compaction (forced): OLD == P1′", async () => {
    const messages = approvalPausedHistory(20, 45);
    const conv = await createTestConversation(messages);

    const outcome = await differential({
      conversationId: conv.id,
      messages,
      forceCompaction: true,
    });

    // A first compaction is never a crossing, so no synthetic replay is expected.
    expect(preservedOf(outcome.current.layerC)).toHaveLength(0);
    expect(outcome.current.persisted?.generation).toBe(1);
    expectEquivalent(outcome);
  });

  it("automatic compaction under pressure: OLD == P1′", async () => {
    const messages = approvalPausedHistory(20, 45);
    const conv = await createTestConversation(messages);

    const outcome = await differential({ conversationId: conv.id, messages });

    expect(outcome.current.persisted?.generation).toBe(1);
    expectEquivalent(outcome);
  });

  it("oversized recovery compacts a safe prefix of the span: OLD == P1′", async () => {
    // Heavy enough that the span cannot reach the summariser in one call, so the
    // planner's walk-back has to shrink the END onto an earlier safe cut.
    const messages = approvalPausedHistory(20, 45);
    const conv = await createTestConversation(messages);

    const outcome = await differential({ conversationId: conv.id, messages });

    // A shrunk span covers fewer messages than the settled history holds.
    expect(outcome.current.report.spanLength).toBeLessThan(messages.length);
    expect(outcome.current.report.applied).toBe(true);
    expectEquivalent(outcome);
  });

  it("chained generations stay equivalent across repeats: OLD == P1′", async () => {
    // A repeated compaction needs fresh growth AND enough of it to clear the trigger
    // again: after the first record is re-applied the covered prefix collapses into
    // one summary, so the surviving pressure is only the growth. Each phase therefore
    // appends a heavy turn and extends the stored chain to match, as a real
    // conversation does.
    const base = settledHistory(20, 45);
    const phase1 = [...base, user("live", "THE LIVE REQUEST")];
    const phase2 = [...phase1, user("g1", `follow up one ${filler(CHAIN_GROWTH_REPEAT)}`), toolTurn("ag1", "tcg1")];
    const phase3 = [...phase2, user("g2", `follow up two ${filler(CHAIN_GROWTH_REPEAT)}`), toolTurn("ag2", "tcg2")];

    const conv = await createTestConversation(phase1);

    const first = await runOnce({ conversationId: conv.id, messages: phase1 });
    expect(first.report.applied).toBe(true);
    expect(first.report.generation).toBe(1);

    await appendToConversation(conv.id, phase2, phase1.length);
    const second = await differential({
      conversationId: conv.id,
      messages: phase2,
      existingRecord: first.persisted,
    });
    expect(second.current.report.applied).toBe(true);
    expect(second.current.report.generation).toBe(2);

    await appendToConversation(conv.id, phase3, phase2.length);
    const third = await differential({
      conversationId: conv.id,
      messages: phase3,
      existingRecord: second.current.persisted,
    });
    expect(third.current.report.generation).toBe(3);
    expect(third.current.report.applied).toBe(true);
    expectEquivalent(third);
  });

  it("stale-boundary repair crosses superseded turns: OLD == P1′", async () => {
    // The first pass compacts the settled span and leaves the trailing file-bearing
    // users behind. On the next pass that span is already covered, which is the
    // ONE state the planner crosses into (an ordinary first compaction never does).
    const messages = crossingFixture();
    const conv = await createTestConversation(messages);

    const first = await runOnce({ conversationId: conv.id, messages, model: CROSSING_MODEL });
    expect(first.report.applied).toBe(true);
    expect(preservedOf(first.layerC)).toHaveLength(0);

    const outcome = await differential({
      conversationId: conv.id,
      messages,
      existingRecord: first.persisted,
      model: CROSSING_MODEL,
    });

    // Every superseded file-bearing turn is replayed under a fresh synthetic id.
    const preserved = preservedOf(outcome.current.layerC);
    expect(preserved).toHaveLength(CROSSING_SUPERSEDED);
    for (const message of preserved) {
      expect((message as { id?: string }).id).toMatch(/^tbai-preserved:.+:f\d$/);
    }
    expect(outcome.current.report.spanLength).toBeGreaterThan(first.report.spanLength);
    expectEquivalent(outcome);
  });

  it("preserved synthetic messages replay the original file payload: OLD == P1′", async () => {
    const messages = crossingFixture();
    const conv = await createTestConversation(messages);

    const first = await runOnce({ conversationId: conv.id, messages, model: CROSSING_MODEL });
    expect(first.report.applied).toBe(true);

    const outcome = await differential({
      conversationId: conv.id,
      messages,
      existingRecord: first.persisted,
      model: CROSSING_MODEL,
    });

    const preserved = preservedOf(outcome.current.layerC);
    expect(preserved).toHaveLength(CROSSING_SUPERSEDED);

    // The replayed message must carry the ORIGINAL payload byte-for-byte, under a
    // fresh id that cannot collide with the persisted original.
    for (const message of preserved) {
      const parts = (message as { parts?: Array<{ type?: string; filename?: string; url?: string }> }).parts ?? [];
      const file = parts.find((part) => part.type === "file");
      expect(file).toBeDefined();
      expect(file?.filename).toMatch(/^file-\d\.txt$/);
      expect(file?.url?.startsWith("data:text/plain;base64,")).toBe(true);
    }

    // The originals are inside the covered span, so they are represented only by
    // their replays and must not also appear verbatim.
    const currentIds = idsOf(outcome.current.layerC);
    for (let i = 1; i <= CROSSING_SUPERSEDED; i += 1) {
      expect(currentIds).not.toContain(`f${i}`);
    }

    expectEquivalent(outcome);
  });

  it("divergent store: real compaction over a client window that omits server history", async () => {
    // ── The gap this closes ────────────────────────────────────────────────
    // Every other scenario here keeps the stored chain and the submitted list in
    // sync, so P1′'s reconstruction is close to an identity and "OLD == P1′"
    // would hold even if reconstruction silently did nothing. This scenario is the
    // one place the persisted history is genuinely LARGER than what the client
    // submitted, so P1′ has real server state to restore.
    //
    // ## What equivalence can and cannot mean here
    //
    // Strict byte equality of Layer C is impossible whenever the client omits a
    // non-empty prefix, and asserting it would be asserting something false. The
    // synthetic ids are `tbai-preserved:<spanFingerprint>:<originalId>`, and the
    // fingerprint is derived from the span the planner actually cut. OLD can only
    // cut a span inside its 30-message window; P1′ reconstructs the full 46-message
    // chain and cuts a wider one. Different span, different fingerprint, different
    // id — that difference IS the semantic gap P1′ exists to close.
    //
    // So equivalence is asserted in the two layers it is actually meaningful in:
    //
    //   1. MODULO span identity — full canonical equality of every message,
    //      part, payload, divider and the ordering, with only the
    //      span-derived fingerprint normalised away. If P1′ lost, dropped or
    //      reordered anything, or replayed an attachment differently, this fails.
    //   2. NOT modulo span identity — the raw canonical forms must DIFFER, and
    //      each path's fingerprint must match its OWN span. If P1′ silently fell
    //      back to the submitted window it would compute OLD's span, produce
    //      OLD's ids, and this test fails.
    const messages = crossingFixture();
    const conv = await createTestConversation(messages);

    // ── 1. A genuine durable compaction record, produced by the real seam ────
    const first = await runOnce({ conversationId: conv.id, messages, model: CROSSING_MODEL });
    expect(first.report.applied).toBe(true);
    expect(first.report.reason).toBe("compacted");
    expect(first.report.generation).toBe(1);
    expect(first.persisted?.generation).toBe(1);

    // Its coverage reaches into the prefix the client will NOT send, which is what
    // makes the record unlocatable for OLD and locatable for P1′.
    const coveredIds = first.persisted?.coveredMessageIds ?? [];
    expect(coveredIds.length).toBe(first.report.spanLength);
    expect(coveredIds).toContain(messages[0]!.id);

    // ── 2. Persisted history strictly larger than the submitted window ──────
    const WINDOW_DROP = 16;
    const window = messages.slice(WINDOW_DROP);
    expect(messages.length).toBe(46);
    expect(window.length).toBe(messages.length - WINDOW_DROP);
    expect(window.length).toBeLessThan(messages.length);

    // The window is a strict suffix of the head chain: same tail, missing prefix.
    expect(window[window.length - 1]!.id).toBe(messages[messages.length - 1]!.id);
    expect(window[0]!.id).toBe(messages[WINDOW_DROP]!.id);
    for (const message of messages.slice(0, WINDOW_DROP)) {
      expect(window.map((m) => (m as { id?: string }).id)).not.toContain((message as { id?: string }).id);
    }

    // ── 3. OLD and P1′ over the same persisted state and the same record ───
    const oldRun = await runOnce({
      conversationId: conv.id,
      messages: window,
      existingRecord: seed(first.persisted),
      disableP1p: true,
      model: CROSSING_MODEL,
    });
    const newRun = await runOnce({
      conversationId: conv.id,
      messages: window,
      existingRecord: seed(first.persisted),
      model: CROSSING_MODEL,
    });

    // ── 4. Compaction was REAL and applied on BOTH paths ────────────────────
    expect(oldRun.report.applied).toBe(true);
    expect(newRun.report.applied).toBe(true);
    expect(oldRun.report.reason).toBe("compacted");
    expect(newRun.report.reason).toBe("compacted");
    expect(oldRun.report.generation).toBe(2);
    expect(newRun.report.generation).toBe(2);

    // The spans genuinely differ, and each path cut the span its own input allowed.
    expect(oldRun.report.spanLength).toBe(window.length - 1);
    expect(newRun.report.spanLength).toBe(messages.length - 1);

    // ── 5. Equivalence modulo span identity ─────────────────────────────────
    const oldShape = canonicalizeModuloSpan(oldRun.layerC);
    const newShape = canonicalizeModuloSpan(newRun.layerC);
    expect(newShape).toBe(oldShape);

    // Structure: one compaction divider, every superseded attachment replayed, the
    // live request last.
    for (const layerC of [oldRun.layerC, newRun.layerC]) {
      const ids = idsOf(layerC);
      expect(ids[0]).toBe("tbai-compaction:cmp_2");
      expect(preservedOf(layerC)).toHaveLength(CROSSING_SUPERSEDED);
      expect(ids[ids.length - 1]).toBe("live");
      // The covered originals are gone from the request, represented only by replays.
      for (let i = 1; i <= CROSSING_SUPERSEDED; i += 1) {
        expect(ids).not.toContain(`f${i}`);
      }
      // The divider is a single user-role text block carrying the header and the
      // model summary. (`data-tbai-compact` is the browser-side representation the
      // adapter strips on persist; it is deliberately absent from Layer C.)
      const divider = layerC[0] as { role?: string; parts?: Array<{ type?: string; text?: string }> };
      expect(divider.role).toBe("user");
      expect(divider.parts).toHaveLength(1);
      expect(divider.parts?.[0]?.type).toBe("text");
      expect(divider.parts?.[0]?.text).toContain("[TBAi compacted history — model_generated_summary");
      expect(divider.parts?.[0]?.text).toContain(ADEQUATE_SUMMARY);
      // Every replayed attachment restores its ORIGINAL payload, byte for byte.
      for (const message of preservedOf(layerC)) {
        const parts = (message as { parts?: Array<{ type?: string; filename?: string; url?: string; mediaType?: string }> }).parts ?? [];
        const file = parts.find((part) => part.type === "file");
        expect(file?.filename).toMatch(/^file-\d\.txt$/);
        expect(file?.mediaType).toBe("text/plain");
        expect(file?.url).toBe(
          `data:text/plain;base64,${Buffer.from(`contents of file ${file.filename!.slice(5, -4)}`).toString("base64")}`,
        );
      }
    }

    // ── 6. The control: P1′ did NOT fall back to the submitted window ───────
    // Were reconstruction to fail closed, P1′ would plan over the same 30
    // messages as OLD and produce byte-identical Layer C. It must not.
    expect(canonicalize(newRun.layerC)).not.toBe(canonicalize(oldRun.layerC));
    expect(spanOfPreserved(newRun.layerC)).not.toBe(spanOfPreserved(oldRun.layerC));
    expect(spanOfPreserved(newRun.layerC)).toBe(newRun.persisted?.spanFingerprint);
    expect(spanOfPreserved(oldRun.layerC)).toBe(oldRun.persisted?.spanFingerprint);
    // Each replayed id encodes the span its own path cut.
    expect(newRun.persisted?.spanFingerprint.endsWith(`:${newRun.report.spanLength}`)).toBe(true);
    expect(oldRun.persisted?.spanFingerprint.endsWith(`:${oldRun.report.spanLength}`)).toBe(true);

    // ── 7. Assembly decision agrees ─────────────────────────────────────────
    expect(newRun.decision.action).toBe(oldRun.decision.action);
  });
});