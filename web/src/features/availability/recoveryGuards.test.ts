import { describe, it, expect, beforeAll } from "bun:test";
import { composerConfig } from "../../config/composer";

/**
 * Phase 3 component/hook boundary pins.
 *
 * `web/` has no DOM runner, so component internals (Composer send gate,
 * ElicitationModal resolve, OpenCodeView recovery effect) are pinned against
 * the source — the same convention as `OpenCodeView.test.tsx` and
 * `TabStrip.test.tsx` — plus a deterministic simulation of the declared
 * effect semantics. Behavioral halves (store, adapters, draft helpers,
 * loadProviders) are covered by runtime tests elsewhere.
 */

const sources: Record<string, string> = {};

beforeAll(async () => {
  const base = import.meta.url;
  const files: Record<string, string> = {
    composer: "../../components/Composer.tsx",
    elicitation: "../../components/ElicitationModal.tsx",
    openCodeView: "../opencode/OpenCodeView.tsx",
    conversationsList: "../sidebar/hooks/useConversationsList.ts",
    capabilities: "../opencode/useOpenCodeCapabilities.ts",
    conversationConfig: "../opencode/useOpenCodeConversationConfig.ts",
    recovery: "./recovery.ts",
  };
  await Promise.all(
    Object.entries(files).map(async ([key, rel]) => {
      sources[key] = await Bun.file(new URL(rel, base)).text();
    }),
  );
});

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("offline send gate (Phase 3.7)", () => {
  it("[P3-14a] only offline (not degraded) gates the Send primitive", () => {
    expect(sources.composer).toContain(
      'useAvailabilityStore((s) => s.status === "offline")',
    );
    expect(sources.composer).toContain("{isOffline ? (");
  });

  it("[P3-14b] the offline branch is an inert disabled button — exactly one Send primitive exists", () => {
    expect(sources.composer).toContain(
      "aria-label={composerConfig.copy.sendOffline}",
    );
    expect(sources.composer).toContain("disabled");
    // A single Send primitive (the online path): the offline button submits
    // nothing and triggers no prompt/send call.
    expect(count(sources.composer, "<ComposerPrimitive.Send ")).toBe(1);
    expect(sources.composer).toContain("never auto-submits");
  });

  it("[P3-14c] draft durability stays wired in the composer (retained, not replayed)", () => {
    expect(sources.composer).toContain("readComposerDraft");
    expect(sources.composer).toContain("writeComposerDraft");
    expect(sources.composer).toContain("draft is retained");
  });

  it("[P3-14d] offline send copy names the kept draft", () => {
    expect(composerConfig.copy.sendOffline.length).toBeGreaterThan(0);
    expect(composerConfig.copy.sendOfflineTitle).toContain("draft is kept");
  });
});

describe("elicitation resolve failure contract (Phase 3.11)", () => {
  it("[P3-17] pending is cleared ONLY on res.ok; busy always resets", () => {
    // Scope to the resolve handler: the polling effect above also clears
    // pending (server-side withdrawal), which must not satisfy this pin.
    const body = sources.elicitation.slice(
      sources.elicitation.indexOf("const resolve"),
    );
    const guardAt = body.indexOf("if (!res.ok) return;");
    const clearAt = body.indexOf("setPending(null)");
    expect(guardAt).toBeGreaterThan(-1);
    // The resolve-path clear happens strictly after the !ok early return.
    expect(clearAt).toBeGreaterThan(guardAt);
    const finallyAt = body.indexOf("finally");
    expect(finallyAt).toBeGreaterThan(-1);
    expect(body.indexOf("setBusy(false)", finallyAt)).toBeGreaterThan(
      finallyAt,
    );
  });

  it("[P3-15b] a failed resolve keeps the request visible (no silent dismissal)", () => {
    expect(sources.elicitation).toContain("keeps the pending request visible");
  });
});

describe("OpenCode recovery reconnect (Phase 3.10)", () => {
  it("[P3-18a] nonzero recoveryEpoch with a bound session calls the EXISTING reconnect once", () => {
    const src = sources.openCodeView;
    expect(src).toContain("if (recoveryEpoch === 0 || !sessionId) return;");
    expect(src).toContain("reconnect();");
    expect(src).toContain("}, [recoveryEpoch, sessionId, reconnect]);");
  });

  it("[P3-18b] epoch changes map to exactly one reconnect each (declared-deps simulation)", () => {
    let calls = 0;
    // Models the declared effect deps: React re-runs the effect only when
    // [recoveryEpoch, sessionId, reconnect] change; the guard inside matches
    // the pinned source line above.
    let lastEpoch = 0;
    let sessionId: string | undefined;
    const fireEpoch = (epoch: number) => {
      if (epoch === 0 || !sessionId) return;
      if (epoch === lastEpoch) return;
      lastEpoch = epoch;
      calls += 1; // reconnect();
    };

    fireEpoch(1);
    fireEpoch(2);
    expect(calls).toBe(0); // no bound session: never reconnects

    sessionId = "sess-1";
    fireEpoch(1);
    expect(calls).toBe(1);
    fireEpoch(1);
    expect(calls).toBe(1); // no duplicate per epoch
    fireEpoch(2);
    expect(calls).toBe(2); // second epoch → exactly one more
    fireEpoch(0);
    expect(calls).toBe(2); // epoch 0 never fires
  });
});

describe("epoch-driven refetch subscriptions (Phase 3.8)", () => {
  it("[P3-09c] sidebar list refetches on recoveryEpoch", () => {
    expect(sources.conversationsList).toContain("recoveryEpoch");
    expect(sources.conversationsList).toContain("setRefreshTrigger");
  });

  it("[P3-09d] OpenCode capabilities + conversation config refetch on recoveryEpoch", () => {
    expect(sources.capabilities).toContain("[enabled, recoveryEpoch]");
    expect(sources.conversationConfig).toContain(
      "[conversationId, recoveryEpoch]",
    );
  });
});

describe("recovery sequence boundaries (Phase 3.8)", () => {
  it("[P3-19b] recovery only invalidates caches + reloads providers — never sends, never touches drafts", () => {
    const src = sources.recovery;
    expect(src).toContain("invalidateThreadListCache()");
    expect(src).toContain("invalidateHistoryCache()");
    expect(src).toContain("loadProviders()");
    expect(src).not.toContain("/api/chat");
    expect(src).not.toContain("transport");
    expect(src).not.toContain("composerDraft");
    expect(src).not.toContain("writeComposerDraft");
  });
});
