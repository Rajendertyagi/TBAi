import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../../../helpers/repo-root";

function read(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

describe("preferencesStore corrective invariants", () => {
  it("mutations wait for authoritative hydration (no default local snapshot, no false success)", () => {
    const src = read("web/src/features/preferences/state/preferencesStore.ts");
    expect(src).toContain("waitForHydratedSnapshot");
    expect(src).toContain("await get().waitForHydratedSnapshot()");
    expect(src).toContain("Preferences hydration failed");
    expect(src).toContain("authoritativeReapplySeq");
    expect(src).not.toContain("if (!base) return null");
  });

  it("close/batch-close return unambiguous results and never auto-retry stale 409", () => {
    const src = read("web/src/features/preferences/state/preferencesStore.ts");
    expect(src).toContain("PreferencesCloseResult");
    expect(src).toContain('reason: "conflict"');
    expect(src).toContain('reason: "error"');
    expect(src).toContain("return { ok: true, snapshot }");
    expect(src).toContain("get().applySnapshot(err.snapshot);");
  });

  it("SSE reconnect refreshes, self-origin skipped only when local >= event revision, visibility listener cleaned up", () => {
    const src = read("web/src/features/preferences/state/preferencesStore.ts");
    expect(src).toContain("hasConnectedSseOnce");
    expect(src).toContain("scheduleRefresh()");
    expect(src).toContain("known >= data.revision");
    expect(src).toContain("onVisibilityChange");
    expect(src).toContain('removeEventListener("visibilitychange", onVisibilityChange)');
    expect(src).toContain('removeEventListener("focus", scheduleRefresh)');
  });
});

describe("chatTabs corrective close/navigation invariants", () => {
  it("navigates only on confirmed success with conversation absent from resulting snapshot", () => {
    const src = read("web/src/features/chat/state/chatTabs.ts");
    expect(src).toContain("if (result.ok === false)");
    expect(src).toContain("result.snapshot.sharedTabs.some((t) => t.ref === conversationId)");
    expect(src).toContain("if (stillMember) return");
    expect(src).toContain("Conflict/error: preserve current local route/active conversation");
  });
});

describe("preferences service corrective invariants", () => {
  it("emits only after successful commit (no emit on conflict/no-op path)", () => {
    const src = read("src/services/preferences/service.ts");
    expect(src).toContain("emitAfterCommit");
    expect(src).toContain("if (!result.conflict && result.snapshot.revision > previousRevision)");
    expect(src).toContain("return emitAfterCommit(result");
    expect(src).not.toContain("emitPreferencesChange({ revision: next.revision");
  });
});

describe("failed optimistic patch rollback (behavioral + invariants)", () => {
  it("BEHAVIORAL: non-conflict PATCH failure + authoritative refresh with same revision increments authoritativeReapplySeq (store signal for UI reapply)", async () => {
    // Exercises the actual store path: optimistic patch -> PATCH 500 -> refresh returns same revision -> reapply signal.
    // This verifies store behavior/signal; usePreferencesSync consumes the signal (covered by invariant below).
    const { usePreferencesStore } = await import("@web/features/preferences/state/preferencesStore");
    const realFetch = globalThis.fetch;
    const snap = (revision = 5) => ({
      revision,
      sharedTabs: [],
      preferences: {
        appearance: { themeMode: "system", lightTheme: "default", darkTheme: "default", typography: "default" },
        desktop: {
          sidebarVisible: true,
          statusBarVisible: true,
          chatWidth: "comfortable",
          sidebarSort: "updated",
          sectionOrder: [],
          sectionCollapsed: {},
          showCompleted: false,
          spellCheck: true,
        },
        welcome: { engine: "direct", quickActionTab: "coding", scopeMode: "simple", folderId: null },
        navigation: { selectedFolderId: null, folderExpanded: {} },
      },
    });

    usePreferencesStore.getState().stop();
    usePreferencesStore.setState({
      snapshot: snap(5),
      hydration: "ready",
      hydrationError: null,
      refreshSeq: 0,
      authoritativeReapplySeq: 0,
      mutationQueue: Promise.resolve(),
    } as any);

    try {
      globalThis.fetch = (async (input: any, init?: any) => {
        const url = typeof input === "string" ? input : String(input?.url ?? input);
        const method = init?.method || (input?.method ?? "GET");
        if (url.includes("/api/preferences") && method === "PATCH") {
          return new Response(JSON.stringify({ error: "server error" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        }
        // Authoritative refresh returns same revision (unchanged).
        return new Response(JSON.stringify(snap(5)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;

      await expect(
        usePreferencesStore.getState().patchPreferences({ appearance: { themeMode: "dark" } }),
      ).rejects.toBeDefined();

      // 4. Reapply signal changes despite unchanged revision.
      expect(usePreferencesStore.getState().authoritativeReapplySeq).toBe(1);
      // 5. Authoritative snapshot remains the server's values (same revision).
      expect(usePreferencesStore.getState().snapshot?.revision).toBe(5);
      expect((usePreferencesStore.getState().snapshot?.preferences as any)?.appearance?.themeMode).toBe("system");
    } finally {
      globalThis.fetch = realFetch;
      usePreferencesStore.getState().stop();
      usePreferencesStore.setState({
        snapshot: null,
        hydration: "idle",
        hydrationError: null,
        refreshSeq: 0,
        authoritativeReapplySeq: 0,
        mutationQueue: Promise.resolve(),
      } as any);
    }
  });

  it("INVARIANT (source-level): patchPreferences increments authoritativeReapplySeq on non-conflict failure after refresh", () => {
    const src = read("web/src/features/preferences/state/preferencesStore.ts");
    expect(src).toContain("authoritativeReapplySeq: s.authoritativeReapplySeq + 1");
    expect(src).toContain("Failed optimistic patch: restore authoritative UI even if revision unchanged");
  });

  it("INVARIANT (source-level): usePreferencesSync force-reapplies on authoritativeReapplySeq change", () => {
    const src = read("web/src/features/preferences/state/usePreferencesSync.ts");
    expect(src).toContain("authoritativeReapplySeq");
    expect(src).toContain("forceReapply");
    expect(src).toContain("lastReapplySeq");
  });
});
