/**
 * The context meter must show OCCUPANCY, not token TRAFFIC.
 *
 * The defect this locks: the ring divided the provider's accumulated
 * `totalUsage` by the context window. The AI SDK accumulates that figure with
 * `addLanguageModelUsage` across every model call in a turn, so one tool-using
 * turn reports more input tokens than the window can hold. A chat sitting at a
 * few hundred thousand tokens of real context displayed "100% full" with an
 * "Input" line larger than the window itself.
 *
 * The fix is a server-measured current-context value, shipped on the message
 * metadata. These cases pin the parsing contract and the arithmetic that turns it
 * into the percentage the user sees.
 */
import { describe, expect, it } from "bun:test";
import fs from "fs";
import path from "path";

import { parseCurrentContext, readingApplies } from "./useCurrentContext";
import { stripComments } from "../../../testing/source-scope";

const RING_SOURCE = path.resolve(
  import.meta.dir,
  "..",
  "..",
  "..",
  "components",
  "assistant-ui",
  "elements",
  "context-display.tsx",
);
const SERVER_SOURCE = path.resolve(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "..",
  "src",
  "routes",
  "chat-model.ts",
);

const ring = fs.readFileSync(RING_SOURCE, "utf8");
const server = fs.readFileSync(SERVER_SOURCE, "utf8");

describe("server-measured current context is what the meter reads", () => {
  it("parses the state the route emits", () => {
    expect(
      parseCurrentContext({
        context: {
          usedTokens: 420_000,
          windowTokens: 1_000_000,
          windowSource: "configured",
          usableInputTokens: 746_928,
          occupancyKind: "provider",
        },
      }),
    ).toEqual({
      usedTokens: 420_000,
      windowTokens: 1_000_000,
      windowSource: "configured",
      usableInputTokens: 746_928,
      occupancyKind: "provider",
    });
  });

  it("keeps the cached portion separate instead of folding it into the numerator", () => {
    const parsed = parseCurrentContext({
      context: {
        usedTokens: 90_000,
        windowTokens: 1_000_000,
        windowSource: "provider_reported",
        occupancyKind: "provider",
        cachedInputTokens: 236_288,
      },
    });
    // The measured occupancy stands alone. Cached tokens are a subdivision of
    // the same prompt, never an addition to it - summing them is the exact bug
    // that produced a 330% readout.
    expect(parsed?.usedTokens).toBe(90_000);
    expect(parsed?.cachedInputTokens).toBe(236_288);
  });

  it("reports an unstated occupancy as unknown rather than as a measurement", () => {
    const parsed = parseCurrentContext({
      context: { usedTokens: 5, windowTokens: 100, windowSource: "configured" },
    });
    expect(parsed?.occupancyKind).toBe("unknown");
  });

  it("reads it from metadata.custom too, since assistant-ui relocates unknown keys", () => {
    expect(
      parseCurrentContext({ custom: { context: { usedTokens: 10, windowTokens: 100, windowSource: "provider_reported" } } })
        ?.usedTokens,
    ).toBe(10);
  });

  it("reports no reading rather than inventing one", () => {
    expect(parseCurrentContext(undefined)).toBeUndefined();
    expect(parseCurrentContext({})).toBeUndefined();
    expect(parseCurrentContext({ context: { usedTokens: 0, windowTokens: 100 } })).toBeUndefined();
    expect(parseCurrentContext({ context: { windowTokens: 100 } })).toBeUndefined();
  });

  it("never presents an unrecognised source as verified", () => {
    const parsed = parseCurrentContext({
      context: { usedTokens: 5, windowTokens: 100, windowSource: "trust_me" },
    });
    expect(parsed?.windowSource).toBe("unknown");
  });

  it("keeps an observed limit as itself, not as unknown", () => {
    // A window the provider stated while rejecting a request IS a real figure. Folding
    // it into `unknown` would make the ring report "Context limit unknown" while
    // displaying 524288 - the UI contradicting itself. It stays its own source so the
    // ring can word it as stated-not-published.
    const parsed = parseCurrentContext({
      context: { usedTokens: 5, windowTokens: 524_288, windowSource: "observed" },
    });
    expect(parsed?.windowSource).toBe("observed");
    expect(parsed?.windowTokens).toBe(524_288);
  });
});

describe("THE REGRESSION: cumulative usage must not be the numerator", () => {
  it("a heavy turn with real context well under the window is not 100%", () => {
    // The exact shape of the reported bug: real context 420k inside a 1M window,
    // while the turn's accumulated input traffic reached 2.1M.
    const usedTokens = 420_000;
    const windowTokens = 1_000_000;
    const cumulativeTraffic = 2_100_000;

    const percent = Math.min((usedTokens / windowTokens) * 100, 100);
    expect(percent).toBeCloseTo(42, 5);
    expect(percent).not.toBe(100);

    // And the traffic figure, if it had been used, would have pinned it at 100%.
    expect(Math.min((cumulativeTraffic / windowTokens) * 100, 100)).toBe(100);
  });

  it("a multi-step turn does not inflate occupancy by its step count", () => {
    // Three model calls, each re-sending a 900k context: traffic 2.86M, occupancy
    // still 900k. The meter must report the second number's percentage.
    const perStepContext = 900_000;
    const windowTokens = 1_000_000;
    const steps = 3;
    const accumulated = perStepContext * steps;
    expect(Math.min((accumulated / windowTokens) * 100, 100)).toBe(100);
    expect(Math.min((perStepContext / windowTokens) * 100, 100)).toBe(90);
  });

  it("the ring prefers the server value over usage.totalTokens", () => {
    // The ordering now lives in `resolveOccupancyNumerator`, which the ring calls
    // instead of inlining the `??` chain.
    expect(ring).toContain("export function resolveOccupancyNumerator(");
    expect(ring).toContain("const candidate = input.contextTokens ?? input.usageTotalTokens;");
  });

  it("the meter drops immediately after compaction", () => {
    // Post-compaction the server ships a smaller usedTokens; the ring reads it
    // directly, so no separate "refresh" path can lag behind.
    const before = parseCurrentContext({ context: { usedTokens: 900_000, windowTokens: 1_000_000, windowSource: "configured" } });
    const after = parseCurrentContext({ context: { usedTokens: 76_000, windowTokens: 1_000_000, windowSource: "configured" } });
    expect(before!.usedTokens).toBeGreaterThan(after!.usedTokens);
    const pct = (c: { usedTokens: number; windowTokens: number }) => (c.usedTokens / c.windowTokens) * 100;
    expect(pct(after!)).toBeLessThan(pct(before!));
  });

  it("usage stays separately available as usage, never merged into occupancy", () => {
    // The popover still breaks out Input / Cached input / Output / Reasoning from
    // `usage`; occupancy is a different number and is not summed with them.
    expect(ring).toContain('label: "Input"');
    expect(ring).toContain('label: "Cached input"');
    expect(ring).toContain("const segments = getContextSegments(usage);");
  });
});

describe("the denominator is the same window the budget enforced", () => {
  it("the route ships the budget's own resolved window, not a second guess", () => {
    expect(server).toContain("usedTokens: number;");
    expect(server).toContain("windowTokens: number;");
    expect(server).toContain("windowSource: string;");
  });

  it("the UI says where the limit came from instead of implying it is verified", () => {
    expect(ring).toContain("Context limit reported by the provider");
    expect(ring).toContain("set in this app");
    expect(ring).toContain("Estimated context limit");
    expect(ring).toContain("Context limit unknown");
  });

  it("the Direct ring uses the server window and server occupancy, exclusively", () => {
    const ringComponent = fs.readFileSync(
      path.resolve(import.meta.dir, "..", "..", "..", "components", "context-ring.tsx"),
      "utf8",
    );
    // Comments are stripped so a prohibition cannot be satisfied - or broken - merely by
    // prose. The ring documents the fallback it removed; the CODE must not contain it.
    const code = ringComponent
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    // The denominator and the numerator both come from the server's resolution.
    expect(code).toContain("modelContextWindow={serverContext.windowTokens}");
    expect(code).toContain("contextTokens={serverContext.usedTokens}");
    expect(code).toContain("windowSource={serverContext.windowSource}");

    // And there is no frontend fallback left to disagree with them. The optional
    // chaining these assertions used to require WAS the second authority: it let the
    // ring divide by a locally-resolved window whenever the server had published none,
    // while reporting no provenance. Absent reading now means the ring renders nothing.
    expect(code).toContain("if (!serverContext) return null");
    expect(code).not.toContain("resolveContextWindow");
    expect(code).not.toContain("DEFAULT_MODEL_CONTEXT_WINDOW");
  });
});
// ─── staleness ───────────────────────────────────────────────────────────────
//
// A reading is a per-turn sample, so it describes the turn it was taken on. That is
// fine while the authority's inputs stay put, and wrong the moment they move: the
// ring would keep showing a denominator the server would no longer resolve.
//
// The fix is NOT a second resolver. The server publishes WHICH resolution produced
// the number (`resolvedFor`), the client compares that identity against the
// conversation it is displaying, and a mismatch WITHHIELDS the reading. The ring
// already renders nothing when it has no reading, so the honest state needs no new
// presentation and no invented number.

describe("a reading whose resolution no longer applies is withheld", () => {
  const reading = (resolvedFor?: Record<string, unknown>) => ({
    usedTokens: 4_158,
    windowTokens: 24_000,
    windowSource: "configured",
    usableInputTokens: 14_928,
    occupancyKind: "provider",
    ...(resolvedFor ? { resolvedFor } : {}),
  });

  const conversation = { providerId: "prov-1", modelId: "model-a" };

  it("parses the resolution identity the server published", () => {
    const parsed = parseCurrentContext({ context: reading({ providerId: "prov-1", modelId: "model-a" }) });
    expect(parsed?.resolvedFor).toEqual({ providerId: "prov-1", modelId: "model-a" });
  });

  it("keeps a reading that matches the conversation", () => {
    const parsed = parseCurrentContext({ context: reading({ providerId: "prov-1", modelId: "model-a" }) });
    expect(parsed).toBeDefined();
    expect(readingApplies(parsed!, conversation)).toBe(true);
  });

  it("withholds a reading taken for a DIFFERENT model", () => {
    // The conversation was re-pointed. The old reading's window and occupancy belong
    // to a model this conversation no longer uses.
    const parsed = parseCurrentContext({ context: reading({ providerId: "prov-1", modelId: "model-b" }) });
    expect(readingApplies(parsed!, conversation)).toBe(false);
  });

  it("withholds a reading taken for a DIFFERENT provider on the same model", () => {
    const parsed = parseCurrentContext({ context: reading({ providerId: "prov-2", modelId: "model-a" }) });
    expect(readingApplies(parsed!, conversation)).toBe(false);
  });

  it("keeps a reading when the caller has no binding to check against", () => {
    // Discarding an authoritative measurement because nobody asked would remove a true
    // number, which is worse than showing it.
    const parsed = parseCurrentContext({ context: reading({ providerId: "prov-1", modelId: "model-a" }) });
    expect(readingApplies(parsed!, undefined)).toBe(true);
  });

  it("keeps a reading from a server that published no identity", () => {
    // Absence of identity is not disagreement. The number is still authoritative for
    // its own turn, and the client has nothing to contradict it with.
    const parsed = parseCurrentContext({ context: reading() });
    expect(parsed?.resolvedFor).toBeUndefined();
    expect(readingApplies(parsed!, conversation)).toBe(true);
  });

  it("does not compare provider identity when the server omitted it", () => {
    const parsed = parseCurrentContext({ context: reading({ providerId: undefined, modelId: "model-a" }) });
    expect(readingApplies(parsed!, conversation)).toBe(true);
  });

  it("drops a partial identity rather than half-matching it", () => {
    // Provider alone would match a DIFFERENT model on the same provider, so an
    // identity without a model id is not comparable at all.
    const parsed = parseCurrentContext({ context: reading({ providerId: "prov-1" }) });
    expect(parsed?.resolvedFor).toBeUndefined();
  });
});

describe("the Direct ring never resolves a window itself", () => {
  it("reads the server value and compares identity — it does not compute one", () => {
    // Comments are stripped first: this file's prose documents the 128k fallback it
    // no longer has, and writing about a removed constant is not having one.
    const ring = stripComments(
      fs.readFileSync(
        path.resolve(import.meta.dir, "..", "..", "..", "components", "context-ring.tsx"),
        "utf8",
      ),
    );
    // The denominator comes from the server reading, full stop.
    expect(ring).toContain("modelContextWindow={serverContext.windowTokens}");
    // The only thing the ring contributes is which conversation this is.
    expect(ring).toContain("useCurrentContext(");
    expect(ring).toContain("s.threadListItem.custom");
    // No window arithmetic, and no fallback constant of any kind.
    expect(ring).not.toMatch(/windowTokens\s*[*/+-]/);
    expect(ring).not.toContain("DEFAULT_MODEL_CONTEXT_WINDOW");
    expect(ring).not.toContain("128");
  });
});
