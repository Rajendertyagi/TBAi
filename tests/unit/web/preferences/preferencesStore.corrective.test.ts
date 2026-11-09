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
    expect(src).not.toContain("if (!base) return null");
    expect(src).not.toContain("defaultSnapshot");
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
