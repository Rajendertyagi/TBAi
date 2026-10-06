import { describe, it, expect, beforeAll } from "bun:test";

/**
 * Source-level guards for the three OpenCode composer chips and the
 * per-conversation config override map.
 *
 * Not behavioural — `web/` has no DOM/component-test runner (same precedent
 * as `ChatWindow.blocks.test.ts` and `StatusBar.guard.test.ts`). Behaviour is
 * confirmed in the browser; these guards pin the specific code paths so a
 * regression that removes the fix fails here rather than silently.
 *
 * Files guarded:
 *  - useOpenCodeConversationConfig.ts — override-map merge + notification
 *  - OpenCodeChipShared.tsx — `persist` publishes only on res.ok
 *  - OpenCodeChipShared.tsx — `OpenCodeChipMenu` outside-pointerdown/Escape/cleanup
 *  - OpenCodeModelChip.tsx — providerID grouping + search filter + empty state
 */

let configSource = "";
let chipSharedSource = "";
let modelChipSource = "";

beforeAll(async () => {
  configSource = await Bun.file(
    new URL("./useOpenCodeConversationConfig.ts", import.meta.url),
  ).text();
  chipSharedSource = await Bun.file(
    new URL("./OpenCodeChipShared.tsx", import.meta.url),
  ).text();
  modelChipSource = await Bun.file(
    new URL("./OpenCodeModelChip.tsx", import.meta.url),
  ).text();
});

// ── useOpenCodeConversationConfig: override merge + notification ───────────

describe("useOpenCodeConversationConfig — override merge", () => {
  it("merges the conversation's override over the fetched config", () => {
    // The return value must spread the override on top of the base config so
    // every mounted reader re-reads last-confirmed server writes.
    expect(configSource).toMatch(
      /return\s*\{\s*\.\.\.config,\s*\.\.\.override\s*\}/,
    );
  });

  it("publishes the override version to all subscribers on update", () => {
    // `updateConversationConfig` must bump the version and walk the listener
    // set so `useSyncExternalStore` re-renders every mounted instance.
    expect(configSource).toContain("overrideVersion++");
    expect(configSource).toContain("overrideListeners.forEach");
  });

  it("keys overrides by conversationId (no cross-chat leakage)", () => {
    // The merge must look up by `conversationId`, never a global flag.
    expect(configSource).toContain("configOverrides.get(conversationId)");
  });

  it("only runs the fetch when a conversationId is present", () => {
    // The draft (no bound conversation) path must short-circuit.
    expect(configSource).toMatch(/if \(!conversationId\) \{[\s\S]*?return;[\s\S]*?\}/);
  });
});

// ── OpenCodeChipShared: the chip's display source is the native session ─────

describe("OpenCodeChipShared — model chip display source", () => {
  it("reads the model through resolveChipModelSource, not the stored column alone", () => {
    // THE REGRESSION. The chip previously read `config?.opencodeModel ?? ""`,
    // so a session bound through the server-default path (which never writes
    // that column) rendered "Select a model" while running a real model.
    const currentModel = chipSharedSource.match(/const currentModel = [^;]+;/)?.[0] ?? "";
    expect(currentModel, "currentModel must be computed by the resolver").toContain(
      "resolveChipModelSource",
    );
    expect(currentModel, "must not read the stored column directly").not.toContain(
      "config?.opencodeModel ??",
    );
  });

  it("feeds the native session's model into the resolver", () => {
    // `nativeExtras.model` is the server-reported bound model. Without this the
    // resolver has no Case-B input and the fix silently does nothing.
    const call = chipSharedSource.match(/resolveChipModelSource\(\{[\s\S]*?\}\)/)?.[0] ?? "";
    expect(call, "resolver call must exist").toContain("nativeModel:");
    expect(call, "native model must come from the runtime extras").toContain(
      "nativeExtras?.model",
    );
    expect(call, "stored column must still be an input, as the authority").toContain(
      "storedModel:",
    );
  });

  it("resolves the displayed label through the shared catalogue lookup", () => {
    // The chip's own `models.find(...)` was moved into `findChipModelInfo` so
    // the resolution is testable and the hook cannot drift from the tests.
    const info = chipSharedSource.match(/const currentModelInfo = [^;]+;/)?.[0] ?? "";
    expect(info, "currentModelInfo must use the shared lookup").toContain(
      "findChipModelInfo",
    );
    expect(chipSharedSource).toContain('from "./chipModelSource"');
  });

  it("still reads the runtime extras for the model-switch path", () => {
    // Manual selection must keep reaching setDesiredSelection: the display fix
    // must not disturb how a pick is applied to the live session.
    expect(chipSharedSource).toContain("nativeExtras.setDesiredSelection");
  });
});

// ── OpenCodeChipShared: persist publishes only on res.ok ──────────────────

describe("OpenCodeChipShared.persist — publish-on-success only", () => {
  it("publishes to the override map only after a successful PATCH", () => {
    // The bound-thread path (non-draft) must call `updateConversationConfig`
    // with the confirmed (server-echoed) values.
    expect(chipSharedSource).toContain("updateConversationConfig(conversationId");
    // It must be preceded by the res.ok guard and the echo-match loop.
    const okIdx = chipSharedSource.indexOf("if (!res.ok)");
    const echoIdx = chipSharedSource.indexOf("echoed !== sent");
    const pubIdx = chipSharedSource.indexOf("updateConversationConfig(conversationId");
    expect(okIdx, "res.ok guard must exist").toBeGreaterThan(-1);
    expect(echoIdx, "echo-match check must exist").toBeGreaterThan(-1);
    expect(pubIdx, "updateConversationConfig call must exist").toBeGreaterThan(-1);
    // Ordering: ok guard → echo check → publish.
    expect(okIdx).toBeLessThan(echoIdx);
    expect(echoIdx).toBeLessThan(pubIdx);
    // The draft branch (no conversationId) must NOT call updateConversationConfig.
    const draftBranch = chipSharedSource.match(
      /if \(draft\) \{[\s\S]*?return;[\s\S]*?\}/,
    );
    expect(draftBranch, "draft branch must exist").not.toBeNull();
    expect(draftBranch![0], "draft branch must not publish to override map").not.toContain(
      "updateConversationConfig",
    );
  });

  it("fails closed on a non-ok response (no state change)", () => {
    // A non-ok response must `return` before any publish.
    const resOkGuard = chipSharedSource.match(
      /if \(!res\.ok\) \{[\s\S]*?return;[\s\S]*?\}/,
    );
    expect(resOkGuard, "res.ok guard must exist").not.toBeNull();
  });

  it("compares server-echoed values to the sent patch before publishing", () => {
    // Mismatch between request and response must be dropped, not published.
    expect(chipSharedSource).toMatch(/echoed !== sent/);
  });
});

// ── OpenCodeChipMenu: outside-pointerdown + Escape + cleanup ──────────────

describe("OpenCodeChipMenu — outside-click and Escape close", () => {
  it("registers a document pointerdown listener when open", () => {
    expect(chipSharedSource).toMatch(
      /document\.addEventListener\("pointerdown",\s*onPointerDown\)/,
    );
  });

  it("closes on a pointerdown outside the menu root", () => {
    // The handler must check containment against rootRef and call onClose.
    expect(chipSharedSource).toMatch(
      /rootRef\.current\s*&&\s*!rootRef\.current\.contains\(e\.target as Node\)[\s\S]*?onCloseRef\.current\(\)/,
    );
  });

  it("closes on the Escape key", () => {
    // Accepts either spelling. What matters is that Escape reaches `onClose`,
    // not which expression gets it there. This assertion used to pin the exact
    // text `e.key === "Escape"`, so adding the IME guard broke it — a false
    // alarm, because the behaviour did not regress, only the string did.
    // `isPlainEscape` is the guarded form and is required: this listener is on
    // `document`, so it also sees Escape pressed in the composer, where a
    // composition may be open.
    expect(chipSharedSource).toMatch(
      /(e\.key === "Escape"|isPlainEscape\([^)]*\))[\s\S]*?onCloseRef\.current\(\)/,
    );
  });

  it("cleans up both listeners on close/unmount", () => {
    expect(chipSharedSource).toMatch(
      /document\.removeEventListener\("pointerdown",\s*onPointerDown\)/,
    );
    expect(chipSharedSource).toMatch(
      /document\.removeEventListener\("keydown",\s*onKeyDown\)/,
    );
  });

  it("gates the effect on the `open` flag (no listeners when closed)", () => {
    // The effect must early-return when the menu is not open.
    expect(chipSharedSource).toMatch(
      /if \(!open\) return;[\s\S]*?document\.addEventListener\("pointerdown"/,
    );
  });
});

// ── OpenCodeModelChip: providerID groups + search filter + empty state ────

describe("OpenCodeModelChip — provider groups, search, empty state", () => {
  it("groups models by providerID, preserving first-seen order", () => {
    // The `ordered` array must record first-seen providers as they appear.
    expect(modelChipSource).toMatch(
      /ordered\.push\(\{\s*provider: key,\s*options: list\s*\}\)/,
    );
  });

  it("filters models by name or id (case-insensitive)", () => {
    // The search must check both `m.name` and `m.id`.
    expect(modelChipSource).toMatch(
      /m\.name\.toLowerCase\(\)\.includes\(q\)[\s\S]*?m\.id\.toLowerCase\(\)\.includes\(q\)/,
    );
  });

  it("renders an empty-state message when no models match", () => {
    // `matchCount === 0` must branch to `noModelsMatch` / `selectModel` copy.
    expect(modelChipSource).toMatch(
      /matchCount === 0 \?[\s\S]*?copy\.noModelsMatch[\s\S]*?copy\.selectModel/,
    );
  });

  it("computes matchCount across all groups", () => {
    expect(modelChipSource).toMatch(
      /matchCount\s*=\s*groups\.reduce\(\(n,\s*g\) => n \+ g\.options\.length,\s*0\)/,
    );
  });

  it("sorts options within each group by name", () => {
    expect(modelChipSource).toMatch(
      /g\.options\.sort\(\(a,\s*b\) => a\.name\.localeCompare\(b\.name\)\)/,
    );
  });
});
