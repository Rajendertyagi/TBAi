import { describe, it, expect, beforeAll } from "bun:test";
import { composerConfig } from "../../config/composer";
import { shouldReconnectForEpoch } from "../opencode/recoveryEpoch";

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
    runtime: "../../runtime.ts",
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

describe("composer primitive alignment", () => {
  it("touch-primary Enter inserts a newline instead of sending", () => {
    // `submitMode="enter"` stays (desktop behaviour), and the touch flag only
    // downgrades that default — an on-screen Return key must not submit a
    // half-typed message. Matches ChatGPT / Slack / WhatsApp.
    expect(sources.composer).toContain("unstable_insertNewlineOnTouchEnter");
    expect(sources.composer).toContain('submitMode="enter"');
  });

  it("the headless composer hook is documented as send-interception, not a DOM takeover", () => {
    // The docs present `unstable_useComposerInput` as an ALTERNATIVE to
    // `ComposerPrimitive.Input`. TBAi uses both on purpose (intercepting the
    // OpenCode draft first send), so the reason must stay written down.
    expect(sources.composer).toContain("unstable_useComposerInput()");
    expect(sources.composer).toContain("only for that interception");
  });
});

describe("slash-command palette wiring", () => {
  it("uses the library's trigger-popover primitives, not a hand-rolled popover", () => {
    expect(sources.composer).toContain("ComposerPrimitive.Unstable_TriggerPopoverRoot");
    expect(sources.composer).toContain('char="/"');
    expect(sources.composer).toContain("unstable_useSlashCommandAdapter");
    // Exactly one trigger declaration, and exactly one behaviour sub-primitive:
    // the library allows only one of Directive/Action per popover. Counting the
    // trigger CHARACTER (not the tag text) keeps this independent of formatting.
    expect(count(sources.composer, 'char="/"')).toBe(1);
    expect(count(sources.composer, "Unstable_TriggerPopover.Action")).toBe(1);
    expect(sources.composer).not.toContain("Unstable_TriggerPopover.Directive");
  });

  it("leaves plain text, never a directive chip (OpenCode wants `/name args`)", () => {
    expect(sources.composer).toContain("removeOnExecute");
    expect(sources.composer).toContain("applyCommandSelection(");
  });

  it("is feed-driven — the command list is never hardcoded in the composer", () => {
    expect(sources.composer).toContain("useCommandsStore");
    expect(sources.composer).toContain("toSlashCommands(");
  });

  it("is scoped to the OpenCode surface (the Direct runtime cannot run these)", () => {
    expect(sources.composer).toContain(
      "const slashCommandsEnabled = isCodeSurface || showOpenCodeDraft;",
    );
    expect(sources.composer).toContain("{slashCommandsEnabled && (");
  });

  it("hides the box when nothing matches (the library stays open on trigger)", () => {    // The library keeps the popover open whenever `/` is detected, even with
    // zero matches — without this the user gets a small empty bordered box.
    // The `:has` rule hides the container exactly when the item group is
    // empty, so Enter submits the text normally.
    expect(sources.composer).toContain("has-[.slash-command-items:empty]:hidden");
    expect(sources.composer).toContain('className="slash-command-items"');
    expect(sources.composer).toContain("items.length === 0");
  });

  it("keys row highlight on data-highlighted (the library's real attribute)", () => {
    // The item primitive sets `data-highlighted` on keyboard navigation —
    // `data-selected` is never set, so styling that leaves arrow-key movement
    // invisible and the palette looks unselectable.
    expect(sources.composer).toContain("data-[highlighted]");
    expect(sources.composer).not.toContain("data-[selected=true]");
  });

  it("renders single-line rows (label + inline truncated description)", () => {
    expect(sources.composer).toContain("truncate text-xs text-muted-foreground");
    expect(sources.composer).not.toContain("line-clamp-2 text-xs text-muted-foreground");
  });
});

describe("offline send gate (Phase 3.7)", () => {
  it("[P3-14a] only offline (not degraded) gates sending", () => {
    expect(sources.composer).toContain(
      'useAvailabilityStore((s) => s.status === "offline")',
    );
    expect(sources.composer).toContain("{isOffline ? (");
    expect(sources.runtime).toContain(
      'useAvailabilityStore((s) => s.status === "offline")',
    );
  });

  it("[P3-14b] the runtime holds the gate shut, not just the button", () => {
    // The offline button is inert, but a disabled button only stops CLICKS:
    // `ComposerPrimitive.Input` submits the form on Enter (`requestSubmit()`)
    // and `aui.composer.send()` can be called programmatically. The composer
    // runtime gates `send()` on `canSend = !isEmpty && !isSendDisabled && …`,
    // so the flag must be set on the runtime for the gate to hold on every
    // path. Without this the button is decorative.
    expect(sources.runtime).toContain("isSendDisabled: isOffline");
  });

  it("[P3-14c] the offline affordance keeps its copy and a single Send primitive", () => {
    expect(sources.composer).toContain(
      "aria-label={composerConfig.copy.sendOffline}",
    );
    expect(sources.composer).toContain("disabled");
    // A single Send primitive (the online path): the offline button submits
    // nothing and triggers no prompt/send call of its own.
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
  it("[P3-18a] bound session + epoch change calls the EXISTING reconnect once (never on stale mount)", () => {
    const src = sources.openCodeView;
    // Previous-epoch ref + pure gate: only an epoch CHANGE while mounted
    // reconnects. A mount with an already-non-zero epoch must not rebuild
    // the client (that would swap the frozen thread-list adapter while the
    // first thread switch/append is still pending).
    expect(src).toContain("seenRecoveryEpochRef");
    expect(src).toContain("shouldReconnectForEpoch({");
    expect(src).toContain("reconnect();");
    expect(src).toContain("}, [recoveryEpoch, sessionId, reconnect]);");
    expect(src).not.toContain("if (recoveryEpoch === 0 || !sessionId) return;");
  });

  it("[P3-18b] epoch changes map to exactly one reconnect each (declared-deps simulation)", () => {
    let calls = 0;
    // Models the declared effect deps: React re-runs the effect only when
    // [recoveryEpoch, sessionId, reconnect] change; the decision matches the
    // production gate (`shouldReconnectForEpoch`) with a mount-seen epoch.
    let seen = 0;
    let sessionId: string | undefined;
    const fireEpoch = (epoch: number) => {
      const d = shouldReconnectForEpoch({
        sessionId,
        recoveryEpoch: epoch,
        seenRecoveryEpoch: seen,
      });
      seen = d.seenRecoveryEpoch;
      if (d.reconnect) calls += 1; // reconnect();
    };

    fireEpoch(1);
    fireEpoch(2);
    expect(calls).toBe(0); // no bound session: never reconnects

    sessionId = "sess-1";
    // Mount lands on a stale non-zero epoch: the ref records it, no reconnect.
    seen = 2;
    fireEpoch(2);
    expect(calls).toBe(0);
    fireEpoch(2);
    expect(calls).toBe(0); // no duplicate per epoch
    fireEpoch(3);
    expect(calls).toBe(1); // genuine transition → exactly one more
    fireEpoch(3);
    expect(calls).toBe(1);
    fireEpoch(0);
    expect(calls).toBe(1); // epoch 0 never fires
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
