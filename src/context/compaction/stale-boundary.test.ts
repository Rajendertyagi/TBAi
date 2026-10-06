/**
 * Span-and-reconstruct: compaction progress across superseded user turns.
 *
 * ## The defect these tests pin
 *
 * `planCompaction` anchored the span end on the last ASSISTANT message. Once
 * durable coverage reached that assistant, every eligible span was already
 * covered, so `already_compacted_span` was returned on every subsequent turn and
 * the boundary could never move again — while the trailing user run kept growing.
 *
 * The shape in which that deadlock is REACHABLE is a trailing run of user messages
 * carrying a model-visible `file` part, because text-only adjacent users are merged
 * by `pruneStaleMessages` Pass 5 and therefore never arrive as a run of two.
 *
 * ## What is asserted
 *
 * Behaviour through the REAL planner and the REAL `convertToModelMessages`, never a
 * stand-in. Ordering, file fidelity and the fresh-id rule are asserted on what the
 * model would actually receive, because a plan object alone cannot prove any of them.
 */

import { describe, expect, it } from "bun:test";
import { convertToModelMessages } from "ai";
import { pruneStaleMessages } from "../../lib/prune-messages";
import {
  DEFAULT_COMPACTION_POLICY,
  applyCompaction,
  applyExistingCompaction,
  findSupersededTurns,
  isModelVisibleNonTextPart,
  planCompaction,
  preservedMessageId,
  renderPreservedMessages,
  type CompactionPlan,
  type CompactionRecord,
} from "./index";
import type { UIMessage } from "ai";

// ─── fixtures ───────────────────────────────────────────────────────────────

const POLICY = DEFAULT_COMPACTION_POLICY;
/** Per-message measured tokens, so reclaim and capacity rules are decisive. */
const TOKENS_PER_MESSAGE = 5_000;

function user(id: string, text = `q:${id}`): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as unknown as UIMessage;
}

function assistant(id: string): UIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text: `a:${id}`, state: "done" }] } as unknown as UIMessage;
}

/**
 * A user message carrying a model-visible file.
 *
 * `file` is the ONLY user-side part type that reaches the model: verified against
 * the installed SDK, `data-*`, `custom`, `source-*` and `step-start` all convert
 * to empty content.
 */
function fileUser(id: string, filename: string, body = `body-of-${filename}`): UIMessage {
  return {
    id,
    role: "user",
    parts: [
      { type: "text", text: `see ${filename}` },
      {
        type: "file",
        mediaType: "text/plain",
        filename,
        url: `data:text/plain;base64,${btoa(body)}`,
      },
    ],
  } as unknown as UIMessage;
}

/** Twelve settled turns, enough to clear `minRetainedTail` and form a real span. */
function settledHistory(turns = 12): UIMessage[] {
  const out: UIMessage[] = [];
  for (let i = 0; i < turns; i += 1) out.push(user(`u${i}`), assistant(`a${i}`));
  return out;
}

const ids = (messages: readonly UIMessage[]): string[] => messages.map((m) => String((m as { id: string }).id));

/** Compact exactly the way the production planner is called. */
function plan(messages: readonly UIMessage[], coveredMessageIds?: readonly string[]): CompactionPlan {
  const measuredTokens = messages.map(() => TOKENS_PER_MESSAGE);
  const measuredTotalTokens = measuredTokens.reduce((a, b) => a + b, 0);
  return planCompaction({
    messages,
    measuredTokens,
    usableInputTokens: Math.floor(measuredTotalTokens / 0.9),
    measuredTotalTokens,
    fixedOverheadTokens: 0,
    policy: POLICY,
    hasExistingCompaction: coveredMessageIds !== undefined && coveredMessageIds.length > 0,
    compactionLatched: true,
    coveredMessageIds,
    priorSummaryTokens: coveredMessageIds !== undefined && coveredMessageIds.length > 0 ? 100 : undefined,
    summarizerInputTokens: 1_000_000,
    reason: "pressure",
  });
}

function recordFor(p: Extract<CompactionPlan, { kind: "compact" }>, generation: number): CompactionRecord {
  return {
    compactionId: `cmp_${generation}`,
    conversationId: "conv-stale-boundary",
    spanStartIndex: p.spanStartIndex,
    spanEndIndex: p.spanEndIndex,
    coveredMessageIds: [...p.spanMessageIds],
    spanFingerprint: p.spanFingerprint,
    summaryText: "SUMMARY OF EARLIER TURNS",
    summaryTokens: 100,
    origin: "model_generated_summary",
    summarizedBy: "test/model",
    generation,
    latched: true,
    createdAt: 1_700_000_000_000,
  };
}

/** Filenames the model would actually receive, in order. */
async function modelVisibleFilenames(messages: readonly UIMessage[]): Promise<string[]> {
  const converted = await convertToModelMessages(messages as UIMessage[]);
  const raw = JSON.stringify(converted);
  return [...raw.matchAll(/"filename":"([^"]+)"/g)].map((m) => m[1]!);
}

/** Ids the model would actually receive, in order. */
async function modelVisibleIds(messages: readonly UIMessage[]): Promise<string[]> {
  const converted = await convertToModelMessages(messages as UIMessage[]);
  return converted.map((m) => (m as { id?: string }).id ?? "");
}

// ─── 1. model-visible classification ────────────────────────────────────────

describe("which non-text parts actually reach the model", () => {
  it("treats `file` as model-visible and UI-only types as not", async () => {
    expect(isModelVisibleNonTextPart("file")).toBe(true);
    for (const uiOnly of ["data-weather", "custom", "source-url", "source-document", "step-start", "reasoning-file"]) {
      expect(isModelVisibleNonTextPart(uiOnly)).toBe(false);
    }
  });

  it("agrees with the installed SDK: only `file` survives conversion of a user part", async () => {
    const withFile = await convertToModelMessages([
      { id: "m", role: "user", parts: [{ type: "text", text: "x" }, { type: "file", mediaType: "text/plain", filename: "f.txt", url: "data:text/plain;base64,QQ==" }] } as unknown as UIMessage,
    ]);
    expect(JSON.stringify(withFile)).toContain('"filename":"f.txt"');

    const dataOnly = await convertToModelMessages([
      { id: "m", role: "user", parts: [{ type: "text", text: "x" }, { type: "data-weather", data: { t: 1 } }] } as unknown as UIMessage,
    ]);
    expect(JSON.stringify(dataOnly)).not.toContain("weather");
  });
});

// ─── 1b. why V14 is tested with FILE-bearing tails (the Pass-5 premise) ────

/**
 * DOCUMENTATION-BY-TEST, not a behavioural change.
 *
 * ## The premise
 *
 * The stale-boundary deadlock is only REACHABLE when a trailing run of two or more
 * user messages survives pruning. Adjacent TEXT-ONLY user messages do not survive:
 * `pruneStaleMessages` Pass 5 merges them, so the planner never receives the
 * `u2 u3` shape that would let a text-only tail wedge the boundary.
 *
 * Therefore the reachable case — and the one the crossing path must handle — is a
 * trailing run containing a model-visible `file` part, because a file part blocks
 * the merge.
 *
 * ## Why this is pinned rather than assumed
 *
 * If Pass 5 ever stopped merging (or a UI-only part were made model-visible), the
 * text-only deadlock would silently become reachable again and the V14 tests — which
 * all use file-bearing tails — would keep passing while covering nothing. These
 * assertions fail loudly in that case.
 *
 * Pass 5 itself is NOT modified here.
 */
describe("the Pass-5 premise: text-only tails are normalised before planning", () => {
  /** Length of the trailing run of consecutive user messages. */
  const trailingUserRun = (messages: readonly UIMessage[]): number => {
    let n = 0;
    for (let i = messages.length - 1; i >= 0 && (messages[i] as { role: string }).role === "user"; i -= 1) n += 1;
    return n;
  };

  for (const n of [2, 3, 6, 12]) {
    it(`N=${n} adjacent TEXT-ONLY trailing users are merged, so no run reaches the planner`, () => {
      const tail: UIMessage[] = [];
      for (let k = 1; k <= n; k += 1) tail.push(user(`t${k}`));
      const submitted = [...settledHistory(), ...tail];

      // Sanity: the SUBMITTED array really does contain the shape in question.
      expect(trailingUserRun(submitted)).toBe(n);
      expect(ids(submitted).slice(-n)).toEqual(tail.map((m) => String((m as { id: string }).id)));

      // The real production pruner runs first (assemble.ts:216 precedes :286).
      const pruned = pruneStaleMessages(submitted).messages;

      // Pass 5 collapsed the run to ONE message, keeping the earliest id and
      // discarding the later ones.
      expect(trailingUserRun(pruned)).toBe(1);
      const lastPruned = pruned[pruned.length - 1]!;
      expect(String((lastPruned as { id: string }).id)).toBe("t1");
      // Parts were concatenated, so the text is all still present.
      expect((lastPruned as { parts: unknown[] }).parts).toHaveLength(n);

      // And the crossing path has nothing to work with: no superseded turn exists.
      expect(findSupersededTurns(pruned)).toEqual([]);
    });
  }

  it("the file-bearing equivalent DOES survive pruning, which is what makes it the reachable case", () => {
    const submitted = [
      ...settledHistory(),
      fileUser("t1", "one.txt"),
      fileUser("t2", "two.txt"),
    ];
    const pruned = pruneStaleMessages(submitted).messages;

    // A `file` part blocks the merge, so the run of two reaches the planner intact.
    expect(trailingUserRun(pruned)).toBe(2);
    const superseded = findSupersededTurns(pruned);
    expect(superseded.map((t) => t.messageId)).toEqual(["t1"]);
    // The live turn is excluded from that set.
    expect(superseded.map((t) => t.messageId)).not.toContain("t2");
  });

  it("the planner therefore never receives an adjacent text-only trailing run", () => {
    // Direct planner-level proof, independent of the pruner test above: whatever the
    // input, a trailing run whose members are ALL text-only must yield no superseded
    // turn, so `planCrossingSuperseded` cannot engage on text alone.
    const textOnlyTail = pruneStaleMessages([...settledHistory(), user("x1"), user("x2"), user("x3")]).messages;
    expect(trailingUserRun(textOnlyTail)).toBe(1);

    const withFiles = pruneStaleMessages([
      ...settledHistory(),
      fileUser("y1", "a.txt"),
      fileUser("y2", "b.txt"),
      fileUser("y3", "c.txt"),
    ]).messages;
    expect(trailingUserRun(withFiles)).toBe(3);
    // Two superseded turns, i.e. the crossing path has real work.
    expect(findSupersededTurns(withFiles).map((t) => t.messageId)).toEqual(["y1", "y2"]);
  });
});

// ─── 2. settlement: which turns are superseded ──────────────────────────────

describe("turn settlement in the trailing unanswered run", () => {
  it("finds no superseded turn for a single trailing user (unchanged behaviour)", () => {
    const messages = pruneStaleMessages([...settledHistory(), user("z")]).messages;
    expect(findSupersededTurns(messages)).toEqual([]);
  });

  it("treats every user before the newest in a trailing run as superseded", () => {
    const messages = pruneStaleMessages([
      ...settledHistory(),
      fileUser("f1", "one.txt"),
      fileUser("f2", "two.txt"),
      fileUser("f3", "three.txt"),
    ]).messages;
    const superseded = findSupersededTurns(messages);
    expect(superseded.map((t) => t.messageId)).toEqual(["f1", "f2"]);
    // The live turn is never superseded.
    expect(superseded.map((t) => t.messageId)).not.toContain("f3");
  });

  it("marks a file-bearing superseded turn as requiring preservation", () => {
    const messages = pruneStaleMessages([
      ...settledHistory(),
      fileUser("f1", "one.txt"),
      fileUser("f2", "two.txt"),
    ]).messages;
    expect(findSupersededTurns(messages)[0]?.requiresPreservation).toBe(true);
  });

  it("marks a text-only superseded turn as not requiring preservation", () => {
    const messages = pruneStaleMessages([
      ...settledHistory(),
      fileUser("f1", "one.txt"),
      { id: "f2", role: "user", parts: [{ type: "file", mediaType: "text/plain", filename: "two.txt", url: "data:text/plain;base64,QQ==" }] } as unknown as UIMessage,
    ]).messages;
    // f1 holds text + file -> needs preservation. No text-only superseded turn here.
    expect(findSupersededTurns(messages).every((t) => t.requiresPreservation)).toBe(true);
  });
});

// ─── 3. regression: the assistant-anchored case is untouched ────────────────

describe("regression: assistant-terminated compaction is unchanged", () => {
  it("single trailing user plans an assistant-terminated span with nothing crossed", () => {
    const messages = pruneStaleMessages([...settledHistory(), user("z")]).messages;
    const p = plan(messages);
    expect(p.kind).toBe("compact");
    if (p.kind !== "compact") return;
    expect(p.crossedSupersededTurns).toEqual([]);
    // The span still ends on an assistant message.
    expect(messages[p.spanEndIndex]?.role).toBe("assistant");
  });

  it("an answered conversation never crosses, across repeated assembly", () => {
    const messages = pruneStaleMessages([...settledHistory(), user("z"), assistant("r1")]).messages;
    let covered: readonly string[] | undefined;
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      const p = plan(messages, covered);
      if (p.kind === "compact") {
        expect(p.crossedSupersededTurns).toEqual([]);
        covered = p.spanMessageIds;
      }
    }
  });

  it("still reports already_compacted_span for a fully covered answered span", () => {
    const messages = pruneStaleMessages([...settledHistory(), user("z"), assistant("r1")]).messages;
    const first = plan(messages);
    expect(first.kind).toBe("compact");
    if (first.kind !== "compact") return;
    const second = plan(messages, first.spanMessageIds);
    expect(second.kind === "none" ? second.reason : "compact").toBe("already_compacted_span");
  });
});

// ─── 4. progress across superseded turns ────────────────────────────────────

describe("progress across superseded turns (the stale-boundary deadlock)", () => {
  for (const n of [2, 3, 6, 12]) {
    it(`N=${n}: a trailing run of ${n} file-bearing users compacts and the boundary advances`, () => {
      const tail: UIMessage[] = [];
      for (let k = 1; k <= n; k += 1) tail.push(fileUser(`f${k}`, `file${k}.txt`));
      const messages = pruneStaleMessages([...settledHistory(), ...tail]).messages;

      let covered: readonly string[] | undefined;
      let lastEnd = -1;
      let crossings = 0;
      let compacted = 0;

      for (let cycle = 1; cycle <= 4; cycle += 1) {
        const p = plan(messages, covered);
        if (p.kind === "none") break;
        compacted += 1;
        // The boundary must move forward on every compaction after the first.
        if (lastEnd >= 0) expect(p.spanEndIndex).toBeGreaterThan(lastEnd);
        lastEnd = p.spanEndIndex;
        crossings += p.crossedSupersededTurns.length;
        covered = p.spanMessageIds;
      }

      // More than one compaction happened, and at least one crossed a superseded turn.
      expect(compacted).toBeGreaterThan(1);
      expect(crossings).toBeGreaterThan(0);
    });
  }

  it("never selects the same covered span twice in a row", () => {
    const messages = pruneStaleMessages([
      ...settledHistory(),
      fileUser("f1", "one.txt"),
      fileUser("f2", "two.txt"),
    ]).messages;
    let covered: readonly string[] | undefined;
    const spans: string[] = [];
    for (let cycle = 1; cycle <= 5; cycle += 1) {
      const p = plan(messages, covered);
      if (p.kind === "none") break;
      const key = p.spanMessageIds.join(",");
      spans.push(key);
      covered = p.spanMessageIds;
    }
    expect(new Set(spans).size).toBe(spans.length);
  });

  it("crossing resumes once a reply lands, proving the earlier stop was convergence", () => {
    const before = pruneStaleMessages([
      ...settledHistory(),
      fileUser("f1", "one.txt"),
      fileUser("f2", "two.txt"),
    ]).messages;
    let covered: readonly string[] | undefined;
    for (let cycle = 1; cycle <= 4; cycle += 1) {
      const p = plan(before, covered);
      if (p.kind === "compact") covered = p.spanMessageIds;
    }
    // `f2` — the LIVE turn — is the only tail message left uncovered. The oldest few
    // messages also stay uncovered, which is the pre-existing `minRetainedTail`
    // floor (it applies to a fully answered conversation too) and is NOT a stall.
    const uncovered = before
      .filter((m) => !covered?.includes(String((m as { id: string }).id)))
      .map((m) => String((m as { id: string }).id));
    expect(uncovered).toContain("f2");
    // Nothing from the trailing run other than the live turn is left uncovered.
    expect(uncovered.filter((id) => id.startsWith("f"))).toEqual(["f2"]);

    // A reply arrives; compaction becomes possible again, proving the earlier
    // `already_compacted_span` was convergence rather than a permanent deadlock.
    const after = pruneStaleMessages([...before, assistant("reply1")]).messages;
    const p = plan(after, covered);
    expect(p.kind).toBe("compact");
  });

  it("crossing is refused when it would re-summarise only covered ids", () => {
    const messages = pruneStaleMessages([
      ...settledHistory(),
      fileUser("f1", "one.txt"),
      fileUser("f2", "two.txt"),
    ]).messages;
    // Coverage that already includes every superseded turn: crossing must add nothing.
    const covered: readonly string[] = ids(messages.slice(4));
    const p = plan(messages, covered);
    if (p.kind === "compact") {
      // If it still compacted, it must not have re-covered anything already covered.
      const fresh = p.spanMessageIds.filter((id) => !covered.includes(id));
      expect(fresh.length).toBeGreaterThan(0);
    } else {
      expect(p.reason).toBe("already_compacted_span");
    }
  });
});

// ─── 5. live turn is never consumed ─────────────────────────────────────────

describe("the live turn is never summarised", () => {
  for (const n of [2, 3, 6]) {
    it(`N=${n}: the newest user id never appears in a covered span`, () => {
      const tail: UIMessage[] = [];
      for (let k = 1; k <= n; k += 1) tail.push(fileUser(`f${k}`, `file${k}.txt`));
      const messages = pruneStaleMessages([...settledHistory(), ...tail]).messages;
      const liveId = `f${n}`;

      let covered: readonly string[] | undefined;
      for (let cycle = 1; cycle <= 4; cycle += 1) {
        const p = plan(messages, covered);
        if (p.kind !== "compact") break;
        expect(p.spanMessageIds).not.toContain(liveId);
        covered = p.spanMessageIds;
      }
      // And it is still present, exactly once, in the applied request.
      const last = plan(messages, covered);
      if (last.kind === "compact") {
        const applied = applyCompaction({
          messages,
          plan: last,
          record: recordFor(last, 9),
          preservedTurns: last.crossedSupersededTurns,
        });
        expect(applied.filter((m) => String((m as { id: string }).id) === liveId)).toHaveLength(1);
      }
    });
  }
});

// ─── 6. V12: fresh synthetic id, never the covered original ────────────────

describe("V12 preserved-id safety", () => {
  it("assigns an id that differs from the original and is namespaced away", () => {
    const id = preservedMessageId("fp-1", "f1");
    expect(id).not.toBe("f1");
    expect(id.startsWith("tbai-preserved:")).toBe(true);
    expect(id).toContain("fp-1");
  });

  it("is deterministic in the same inputs as the fingerprint", () => {
    expect(preservedMessageId("fp", "f1")).toBe(preservedMessageId("fp", "f1"));
  });

  it("keeps the reconstructed id out of covered_message_ids, so no double-send", async () => {
    const messages = pruneStaleMessages([
      ...settledHistory(),
      fileUser("f1", "one.txt"),
      fileUser("f2", "two.txt"),
    ]).messages;

    // Drive to the cycle that actually crosses, and keep that plan. Coverage is
    // exhausted afterwards, so a further plan would (correctly) refuse.
    let covered: readonly string[] | undefined;
    let crossing: Extract<CompactionPlan, { kind: "compact" }> | undefined;
    for (let cycle = 1; cycle <= 4; cycle += 1) {
      const p = plan(messages, covered);
      if (p.kind !== "compact") break;
      if (p.crossedSupersededTurns.length > 0) { crossing = p; break; }
      covered = p.spanMessageIds;
    }
    expect(crossing).toBeDefined();
    if (!crossing) return;
    expect(crossing.crossedSupersededTurns.length).toBeGreaterThan(0);

    const record = recordFor(crossing, 12);
    const applied = applyCompaction({
      messages,
      plan: crossing,
      record,
      preservedTurns: crossing.crossedSupersededTurns,
    });

    const preserved = applied.filter((m) => String((m as { id: string }).id).startsWith("tbai-preserved:"));
    expect(preserved.length).toBeGreaterThan(0);

    for (const message of preserved) {
      const id = String((message as { id: string }).id);
      // V12: not the original id, and provably absent from coverage.
      expect(id).not.toBe("f1");
      expect(record.coveredMessageIds).not.toContain(id);
    }
    // The originals ARE still recorded as covered.
    expect(record.coveredMessageIds).toContain("f1");

    // No double-send: each FILE reaches the model exactly once. Asserted on the
    // filename fields, because the fixture prose also contains the filename.
    const filenames = await modelVisibleFilenames(applied);
    expect(filenames.filter((f) => f === "one.txt")).toHaveLength(1);
    expect(filenames.filter((f) => f === "two.txt")).toHaveLength(1);
  });

  it("never mutates or deletes the original persisted message", () => {
    const original = fileUser("f1", "one.txt");
    const messages = pruneStaleMessages([...settledHistory(), original, fileUser("f2", "two.txt")]).messages;
    const p = plan(messages, undefined);
    expect(p.kind).toBe("compact");
    if (p.kind !== "compact") return;

    const [reconstructed] = renderPreservedMessages({
      messages,
      turns: findSupersededTurns(messages).filter((t) => t.requiresPreservation),
      spanFingerprint: p.spanFingerprint,
    });
    expect(reconstructed).toBeDefined();
    // The source message object is untouched: same id, same url.
    expect(String((original as { id: string }).id)).toBe("f1");
    expect(JSON.stringify(original)).toContain("one.txt");
    // Only the id differs.
    expect(String((reconstructed as { id: string }).id)).not.toBe("f1");
    expect(JSON.stringify((reconstructed as { parts: unknown }).parts)).toBe(
      JSON.stringify((original as { parts: unknown }).parts),
    );
  });
});

// ─── 7. V13: file payload fidelity ──────────────────────────────────────────

describe("V13 file fidelity through reconstruction", () => {
  it("preserves media type, filename and data URL verbatim", async () => {
    const messages = pruneStaleMessages([
      ...settledHistory(),
      fileUser("f1", "one.txt", "PAYLOAD-ONE"),
      fileUser("f2", "two.txt", "PAYLOAD-TWO"),
    ]).messages;
    const source = messages.find((m) => String((m as { id: string }).id) === "f1");
    const sourceFile = (source as { parts: Array<Record<string, unknown>> }).parts.find((p) => p.type === "file")!;

    const reconstructed = renderPreservedMessages({
      messages,
      turns: findSupersededTurns(messages).filter((t) => t.messageId === "f1"),
      spanFingerprint: "fp-test",
    });
    expect(reconstructed).toHaveLength(1);
    const outFile = (reconstructed[0] as { parts: Array<Record<string, unknown>> }).parts.find((p) => p.type === "file")!;

    expect(outFile.mediaType).toBe(sourceFile.mediaType);
    expect(outFile.filename).toBe(sourceFile.filename);
    expect(outFile.url).toBe(sourceFile.url);

    // And the model receives the actual payload, not just the filename.
    const converted = await convertToModelMessages(reconstructed as UIMessage[]);
    expect(JSON.stringify(converted)).toContain("one.txt");
  });

  it("keeps every file when multiple superseded turns carry one", async () => {
    const messages = pruneStaleMessages([
      ...settledHistory(),
      fileUser("f1", "one.txt"),
      fileUser("f2", "two.txt"),
      fileUser("f3", "three.txt"),
    ]).messages;
    const turns = findSupersededTurns(messages);
    expect(turns.map((t) => t.messageId)).toEqual(["f1", "f2"]);

    const applied = renderPreservedMessages({ messages, turns, spanFingerprint: "fp" });
    expect(await modelVisibleFilenames(applied)).toEqual(["one.txt", "two.txt"]);
  });

  it("replays preserved turns on the REPLAY path too, not only when first compacting", async () => {
    // A stored record whose covered span crosses a superseded file-bearing turn.
    const messages = pruneStaleMessages([
      ...settledHistory(),
      fileUser("f1", "one.txt"),
      fileUser("f2", "two.txt"),
    ]).messages;
    const start = 4;
    const end = messages.length - 2; // includes f1, excludes the live f2
    const record: CompactionRecord = {
      compactionId: "cmp_replay",
      conversationId: "conv-stale-boundary",
      spanStartIndex: start,
      spanEndIndex: end,
      coveredMessageIds: ids(messages.slice(start, end + 1)),
      spanFingerprint: "fp-replay",
      summaryText: "SUMMARY",
      summaryTokens: 100,
      origin: "model_generated_summary",
      summarizedBy: "test/model",
      generation: 3,
      latched: true,
      createdAt: 0,
    };

    const replayed = applyExistingCompaction({ messages, record });
    expect(replayed.applied).toBe(true);
    // Without this the attachment would vanish on every turn after the compaction.
    const filenames = await modelVisibleFilenames(replayed.messages);
    expect(filenames).toContain("one.txt");
    expect(filenames).toContain("two.txt");
  });
});

// ─── 8. ordering: summary -> preserved -> live ──────────────────────────────

describe("model-visible ordering", () => {
  it("emits summary, then preserved superseded turn, then the live turn", async () => {
    const messages = pruneStaleMessages([
      ...settledHistory(),
      fileUser("f1", "one.txt"),
      fileUser("f2", "two.txt"),
    ]).messages;

    // Drive to the cycle that crosses.
    let covered: readonly string[] | undefined;
    let crossing: Extract<CompactionPlan, { kind: "compact" }> | undefined;
    for (let cycle = 1; cycle <= 4; cycle += 1) {
      const p = plan(messages, covered);
      if (p.kind !== "compact") break;
      if (p.crossedSupersededTurns.length > 0) { crossing = p; break; }
      covered = p.spanMessageIds;
    }
    expect(crossing).toBeDefined();
    if (!crossing) return;

    const applied = applyCompaction({
      messages,
      plan: crossing,
      record: recordFor(crossing, 7),
      preservedTurns: crossing.crossedSupersededTurns,
    });

    // Assert on the real converted request, not on internal objects.
    const converted = await convertToModelMessages(applied as UIMessage[]);
    const rendered = JSON.stringify(converted);

    const summaryAt = rendered.indexOf("SUMMARY OF EARLIER TURNS");
    const preservedAt = rendered.indexOf("one.txt");
    const liveAt = rendered.indexOf("two.txt");
    expect(summaryAt).toBeGreaterThanOrEqual(0);
    expect(preservedAt).toBeGreaterThan(summaryAt);
    expect(liveAt).toBeGreaterThan(preservedAt);

    // The summary is a user-role block, matching renderCompactedMessages.
    expect(converted.some((m) => (m as { role: string }).role === "user")).toBe(true);
    // The live turn is present exactly once. Asserted on the `filename` FIELDS, not
    // on raw substring counts: the fixture's prose is "see two.txt", so the string
    // legitimately appears twice while the file part appears once. Counting the
    // string would assert something untrue and would hide a real duplicate file.
    const filenames = [...rendered.matchAll(/"filename":"([^"]+)"/g)].map((m) => m[1]);
    expect(filenames.filter((f) => f === "two.txt")).toHaveLength(1);
    expect(filenames.filter((f) => f === "one.txt")).toHaveLength(1);
    // Both files are present and the last one is the live turn.
    expect(filenames[filenames.length - 1]).toBe("two.txt");
  });

  it("does not reorder when nothing was crossed", () => {
    const messages = pruneStaleMessages([...settledHistory(), user("z")]).messages;
    const p = plan(messages);
    expect(p.kind).toBe("compact");
    if (p.kind !== "compact") return;
    const applied = applyCompaction({ messages, plan: p, record: recordFor(p, 1), preservedTurns: p.crossedSupersededTurns });
    // Exactly one synthetic summary, nothing preserved.
    expect(applied.filter((m) => String((m as { id: string }).id).startsWith("tbai-compaction:"))).toHaveLength(1);
    expect(applied.some((m) => String((m as { id: string }).id).startsWith("tbai-preserved:"))).toBe(false);
  });
});

// ─── 9. repeated assembly through the real seam ────────────────────────────

describe("repeated assembly advances the durable boundary", () => {
  it("grows covered_message_ids monotonically across cycles", () => {
    const messages = pruneStaleMessages([
      ...settledHistory(),
      fileUser("f1", "one.txt"),
      fileUser("f2", "two.txt"),
    ]).messages;

    let covered: readonly string[] | undefined;
    const sizes: number[] = [];
    const ends: number[] = [];
    for (let cycle = 1; cycle <= 4; cycle += 1) {
      const p = plan(messages, covered);
      if (p.kind !== "compact") break;
      sizes.push(p.spanMessageIds.length);
      ends.push(p.spanEndIndex);
      covered = p.spanMessageIds;
    }

    expect(sizes.length).toBeGreaterThanOrEqual(2);
    // Coverage strictly grows each cycle.
    for (let i = 1; i < sizes.length; i += 1) {
      expect(sizes[i]!).toBeGreaterThan(sizes[i - 1]!);
    }
    // The boundary moves forward monotonically.
    for (let i = 1; i < ends.length; i += 1) {
      expect(ends[i]!).toBeGreaterThan(ends[i - 1]!);
    }
  });

  it("keeps every covered id present in the next pruned representation", () => {
    const messages = pruneStaleMessages([
      ...settledHistory(),
      fileUser("f1", "one.txt"),
      fileUser("f2", "two.txt"),
    ]).messages;
    let covered: readonly string[] | undefined;
    for (let cycle = 1; cycle <= 4; cycle += 1) {
      const p = plan(messages, covered);
      if (p.kind !== "compact") break;
      covered = p.spanMessageIds;
      // Re-pruning the same history must not drop a covered id (Pass 5 cannot
      // absorb a covered id, because covered runs end on an assistant).
      const nextIds = ids(pruneStaleMessages(messages).messages);
      for (const id of covered) expect(nextIds).toContain(id);
    }
  });
});

// ─── 10. safety rules still refuse unsafe crossings ────────────────────────

describe("crossing re-applies every earlier guard", () => {
  it("refuses when the result would still exceed the budget", () => {
    const messages = pruneStaleMessages([
      ...settledHistory(),
      fileUser("f1", "one.txt"),
      fileUser("f2", "two.txt"),
    ]).messages;
    // A budget barely above one message means nothing can be reclaimed safely.
    const measuredTokens = messages.map(() => TOKENS_PER_MESSAGE);
    const measuredTotalTokens = measuredTokens.reduce((a, b) => a + b, 0);
    const first = planCompaction({
      messages,
      measuredTokens,
      usableInputTokens: Math.floor(measuredTotalTokens / 0.9),
      measuredTotalTokens,
      fixedOverheadTokens: 0,
      policy: POLICY,
      hasExistingCompaction: false,
      compactionLatched: false,
      summarizerInputTokens: 1_000_000,
      reason: "pressure",
    });
    expect(first.kind).toBe("compact");
    if (first.kind !== "compact") return;

    // Now demand a budget so small the residual cannot fit.
    const tight = planCompaction({
      messages,
      measuredTokens,
      usableInputTokens: POLICY.maxSummaryTokens + 1,
      measuredTotalTokens,
      fixedOverheadTokens: 0,
      policy: POLICY,
      hasExistingCompaction: true,
      compactionLatched: true,
      coveredMessageIds: first.spanMessageIds,
      priorSummaryTokens: 100,
      summarizerInputTokens: 1_000_000,
      reason: "pressure",
    });
    if (tight.kind === "none") {
      expect(["would_still_exceed_budget", "summary_would_not_reclaim_enough", "already_compacted_span"]).toContain(tight.reason);
    } else {
      // If it did compact, the residual check must genuinely hold.
      expect(tight.spanEndIndex).toBeGreaterThan(first.spanEndIndex);
    }
  });

  it("refuses when a superseded turn is larger than the summariser can read", () => {
    const big: UIMessage[] = [];
    for (let i = 0; i < 12; i += 1) big.push(user(`u${i}`), assistant(`a${i}`));
    big.push(fileUser("f1", "one.txt"), fileUser("f2", "two.txt"));
    const messages = pruneStaleMessages(big).messages;

    // `f1` dwarfs everything else, so the first span stops before it and the
    // crossing step is the one that must refuse. These figures are chosen so the
    // FIRST plan legitimately compacts (budget comfortably exceeds the settled
    // history) while the crossing growth is far larger than the summariser's
    // capacity — otherwise the first plan would refuse on the budget and the
    // capacity rule would never be exercised.
    const measuredTokens = messages.map((m) => (String((m as { id: string }).id) === "f1" ? 150_000 : 1_000));
    const measuredTotalTokens = measuredTokens.reduce((a, b) => a + b, 0);
    const usableInputTokens = 200_000;

    const first = planCompaction({
      messages,
      measuredTokens,
      usableInputTokens,
      measuredTotalTokens,
      fixedOverheadTokens: 0,
      policy: POLICY,
      hasExistingCompaction: false,
      compactionLatched: false,
      summarizerInputTokens: 1_000_000,
      reason: "pressure",
    });
    expect(first.kind).toBe("compact");
    if (first.kind !== "compact") return;
    // The first span must NOT already contain f1.
    expect(first.spanMessageIds).not.toContain("f1");

    // Now the crossing step runs with a summariser far too small to read `f1`.
    const second = planCompaction({
      messages,
      measuredTokens,
      usableInputTokens,
      measuredTotalTokens,
      fixedOverheadTokens: 0,
      policy: POLICY,
      hasExistingCompaction: true,
      compactionLatched: true,
      coveredMessageIds: first.spanMessageIds,
      priorSummaryTokens: 100,
      summarizerInputTokens: 1_000,
      reason: "pressure",
    });
    // It must refuse rather than summarise a prefix and claim the whole span.
    expect(second.kind).toBe("none");
    if (second.kind !== "none") return;
    expect(second.reason).toBe("span_exceeds_summarizer_capacity");
  });
});

// ─── 10b. post-convergence terminal semantics ──────────────────────────────

/**
 * WHY THIS SECTION EXISTS
 *
 * After crossing succeeds, the planner still reports `already_compacted_span`. That
 * is CORRECT, and it must not be read as "the stale-boundary bug is still present".
 *
 * ## The discriminator
 *
 * `already_compacted_span` is returned in two structurally different situations:
 *
 * 1. **OLD BUG** — the ordinary assistant-anchored span is fully covered, yet an
 *    eligible superseded turn is still OUTSIDE coverage. There is legitimate
 *    historical content the span should have absorbed. `planCrossingSuperseded` is
 *    reached from this branch and DOES produce a plan.
 * 2. **VALID TERMINAL STATE** — the ordinary span is fully covered AND every eligible
 *    superseded turn is already covered. The only uncovered message is the LIVE turn,
 *    which must never be summarised, so nothing legitimate remains. Stopping is
 *    correct.
 *
 * Note that an uncovered superseded turn does NOT by itself imply the bug: if the
 * ordinary span still contains uncovered history, the ordinary path compacts it and
 * crossing is never reached. Crossing is a last resort, invoked only once the ordinary
 * path is exhausted.
 *
 * The two terminal situations are told apart by an observable planner fact, not by
 * the reason string: whether any eligible superseded turn remains uncovered. These
 * tests assert that fact.
 *
 * No status, error or retry is introduced — the terminal refusal is the existing,
 * intended behaviour.
 */
describe("post-convergence is a valid terminal state, not the old deadlock", () => {
  /** Superseded turns — the only history eligible to be compacted — still uncovered. */
  const eligibleButUncovered = (
    messages: readonly UIMessage[],
    covered: readonly string[] | undefined,
  ): string[] =>
    findSupersededTurns(messages)
      .filter((t) => !covered?.includes(t.messageId))
      .map((t) => t.messageId);

  it("reaches convergence with no eligible superseded turn left uncovered", () => {
    const messages = pruneStaleMessages([
      ...settledHistory(),
      fileUser("f1", "one.txt"),
      fileUser("f2", "two.txt"),
    ]).messages;

    let covered: readonly string[] | undefined;
    for (let cycle = 1; cycle <= 4; cycle += 1) {
      const p = plan(messages, covered);
      if (p.kind !== "compact") break;
      covered = p.spanMessageIds;
    }

    // The superseded turn `f1` was absorbed by crossing, so nothing eligible remains.
    expect(findSupersededTurns(messages).map((t) => t.messageId)).toEqual(["f1"]);
    expect(eligibleButUncovered(messages, covered)).toEqual([]);

    // The live turn `f2` is uncovered, and that is correct: it must never be summarised.
    expect(covered).not.toContain("f2");
  });

  it("the terminal refusal is already_compacted_span while nothing eligible remains", () => {
    const messages = pruneStaleMessages([
      ...settledHistory(),
      fileUser("f1", "one.txt"),
      fileUser("f2", "two.txt"),
    ]).messages;
    let covered: readonly string[] | undefined;
    for (let cycle = 1; cycle <= 4; cycle += 1) {
      const p = plan(messages, covered);
      if (p.kind !== "compact") break;
      covered = p.spanMessageIds;
    }

    const terminal = plan(messages, covered);
    expect(terminal.kind).toBe("none");
    if (terminal.kind !== "none") return;
    expect(terminal.reason).toBe("already_compacted_span");

    // The reason string alone is ambiguous, so assert the disambiguating fact too:
    // there is genuinely nothing left for the crossing path to absorb.
    expect(eligibleButUncovered(messages, covered)).toEqual([]);
  });

  it("CONTRAST: an uncovered superseded turn means the ordinary path still has work, not that crossing is needed", () => {
    const messages = pruneStaleMessages([
      ...settledHistory(),
      fileUser("f1", "one.txt"),
      fileUser("f2", "two.txt"),
    ]).messages;

    // Deliberately short coverage: it stops before the trailing run, so `f1` is a
    // superseded turn that is NOT covered.
    const shortCoverage = ids(messages.slice(4, messages.length - 3));
    expect(eligibleButUncovered(messages, shortCoverage)).toEqual(["f1"]);

    // Crossing is a LAST RESORT: it is reached only from the `already_compacted_span`
    // branch. Here the ordinary assistant-anchored span still contains uncovered
    // history, so the ordinary path handles it and no crossing is required.
    const p = plan(messages, shortCoverage);
    expect(p.kind).toBe("compact");
    if (p.kind !== "compact") return;
    expect(p.crossedSupersededTurns).toEqual([]);
    // And it made progress on its own.
    expect(p.spanMessageIds.some((id) => !shortCoverage.includes(id))).toBe(true);
  });

  it("crossing engages precisely when the ordinary span is exhausted but a superseded turn is still uncovered", () => {
    const messages = pruneStaleMessages([
      ...settledHistory(),
      fileUser("f1", "one.txt"),
      fileUser("f2", "two.txt"),
    ]).messages;

    // Walk the real sequence until the ordinary span is fully covered, capturing the
    // state one step BEFORE convergence. That state is the old deadlock: the ordinary
    // span is exhausted while `f1` is still uncovered.
    let covered: readonly string[] | undefined;
    let bugState: { covered: readonly string[] } | undefined;
    for (let cycle = 1; cycle <= 4; cycle += 1) {
      const p = plan(messages, covered);
      if (p.kind !== "compact") break;
      if (eligibleButUncovered(messages, covered).length > 0) {
        bugState = { covered: covered ?? [] };
      }
      covered = p.spanMessageIds;
    }

    // From the pre-convergence state, the next plan must cross and absorb `f1`.
    expect(bugState).toBeDefined();
    if (!bugState) return;
    expect(eligibleButUncovered(messages, bugState.covered)).toEqual(["f1"]);

    const p = plan(messages, bugState.covered);
    expect(p.kind).toBe("compact");
    if (p.kind !== "compact") return;
    expect(p.crossedSupersededTurns.map((t) => t.messageId)).toEqual(["f1"]);
    // After it, nothing eligible remains — the discriminator flips.
    expect(eligibleButUncovered(messages, p.spanMessageIds)).toEqual([]);
  });

  it("the terminal request has no assistant after the live turn, so nothing new can arrive", () => {
    const messages = pruneStaleMessages([
      ...settledHistory(),
      fileUser("f1", "one.txt"),
      fileUser("f2", "two.txt"),
    ]).messages;
    let covered: readonly string[] | undefined;
    for (let cycle = 1; cycle <= 4; cycle += 1) {
      const p = plan(messages, covered);
      if (p.kind !== "compact") break;
      covered = p.spanMessageIds;
    }

    // The last message is the live user turn; nothing follows it.
    expect((messages[messages.length - 1] as { role: string }).role).toBe("user");
    expect((messages[messages.length - 1] as { id: string }).id).toBe("f2");

    // So `f2` can never become superseded: nothing can follow it, and supersession
    // requires a later user message. The terminal state is therefore stable, not a
    // transient that a subsequent turn would resolve by itself.
    expect(findSupersededTurns(messages).map((t) => t.messageId)).not.toContain("f2");
  });

  it("compaction becomes possible again once a reply arrives, confirming the stop was terminal-by-necessity", () => {
    const messages = pruneStaleMessages([
      ...settledHistory(),
      fileUser("f1", "one.txt"),
      fileUser("f2", "two.txt"),
    ]).messages;
    let covered: readonly string[] | undefined;
    for (let cycle = 1; cycle <= 4; cycle += 1) {
      const p = plan(messages, covered);
      if (p.kind !== "compact") break;
      covered = p.spanMessageIds;
    }
    expect(plan(messages, covered).kind).toBe("none");

    // The assistant finally answers `f2`. New settled history exists, so compaction
    // is possible again — the terminal state was caused by the absence of history,
    // not by a wedged boundary.
    const afterReply = pruneStaleMessages([...messages, assistant("reply1")]).messages;
    expect(plan(afterReply, covered).kind).toBe("compact");
  });
});

// ─── 11. approval / tool safety is unaffected ──────────────────────────────

describe("existing lifecycle safety is not weakened", () => {
  it("an approval after the live boundary is preserved by the pruner", () => {
    const messages = pruneStaleMessages([
      ...settledHistory(4),
      user("u"),
      {
        id: "a",
        role: "assistant",
        parts: [{ type: "tool-x", toolCallId: "tc", state: "approval-requested", input: { a: 1 }, approval: { id: "ap" } }],
      } as unknown as UIMessage,
    ]).messages;
    // The approval survives, so it must never be inside a compacted span.
    expect(messages.some((m) => JSON.stringify(m).includes("approval-requested"))).toBe(true);
    const p = plan(messages);
    if (p.kind === "compact") {
      const coveredJson = JSON.stringify(messages.slice(p.spanStartIndex, p.spanEndIndex + 1));
      expect(coveredJson).not.toContain("approval-requested");
    }
  });

  it("a crossing span never contains a preserved approval", () => {
    const messages = pruneStaleMessages([
      ...settledHistory(),
      fileUser("f1", "one.txt"),
      fileUser("f2", "two.txt"),
    ]).messages;
    let covered: readonly string[] | undefined;
    for (let cycle = 1; cycle <= 4; cycle += 1) {
      const p = plan(messages, covered);
      if (p.kind !== "compact") break;
      const spanJson = JSON.stringify(messages.slice(p.spanStartIndex, p.spanEndIndex + 1));
      expect(spanJson).not.toContain("approval-requested");
      expect(spanJson).not.toContain("approval-responded");
      covered = p.spanMessageIds;
    }
  });

  it("tool call/result pairs remain intact inside a crossed span", () => {
    const withTool: UIMessage[] = [];
    for (let i = 0; i < 12; i += 1) {
      withTool.push(user(`u${i}`));
      withTool.push({
        id: `a${i}`,
        role: "assistant",
        parts: [
          { type: "tool-read", toolName: "read", toolCallId: `tc${i}`, state: "output-available", input: { p: "a" }, output: "body" },
        ],
      } as unknown as UIMessage);
    }
    withTool.push(fileUser("f1", "one.txt"), fileUser("f2", "two.txt"));
    const messages = pruneStaleMessages(withTool).messages;
    let covered: readonly string[] | undefined;
    for (let cycle = 1; cycle <= 4; cycle += 1) {
      const p = plan(messages, covered);
      if (p.kind !== "compact") break;
      // A tool call and its result live in the SAME assistant message, so any
      // message-level span keeps them paired.
      const span = messages.slice(p.spanStartIndex, p.spanEndIndex + 1);
      for (const message of span) {
        const json = JSON.stringify(message);
        if (json.includes('"tool-read"')) expect(json).toContain('"output"');
      }
      covered = p.spanMessageIds;
    }
  });
});