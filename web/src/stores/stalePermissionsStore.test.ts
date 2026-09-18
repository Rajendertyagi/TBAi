import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { functionBody, stripComments } from "@/testing/source-scope";
import {
  isPermissionGone,
  isStaleApproval,
  reportPermissionGone,
  useStalePermissionsStore,
} from "./stalePermissionsStore";

describe("isPermissionGone", () => {
  it("recognises the OpenCode server's not-found reply", () => {
    expect(
      isPermissionGone(new Error("Permission request not found: per_0ab678")),
    ).toBe(true);
  });

  it("is case-insensitive and reads non-Error throwables", () => {
    expect(isPermissionGone("permission request NOT FOUND")).toBe(true);
    expect(isPermissionGone({ message: "Permission request not found" })).toBe(
      true,
    );
  });

  it("does not treat an unrelated failure as gone", () => {
    // A transient failure must stay retryable: the card keeps its controls.
    expect(isPermissionGone(new Error("Failed to fetch"))).toBe(false);
    expect(isPermissionGone(new Error("NetworkError when attempting"))).toBe(
      false,
    );
    expect(isPermissionGone(undefined)).toBe(false);
    expect(isPermissionGone(new Error("session not found"))).toBe(false);
  });
});

describe("stalePermissionsStore", () => {
  beforeEach(() => {
    useStalePermissionsStore.setState({ stale: new Set<string>() });
  });

  it("records ids as stale", () => {
    useStalePermissionsStore.getState().markStale(["per_a", "per_b"]);
    const { stale } = useStalePermissionsStore.getState();
    expect(stale.has("per_a")).toBe(true);
    expect(stale.has("per_b")).toBe(true);
    expect(stale.has("per_c")).toBe(false);
  });

  it("is idempotent and keeps set identity when nothing is new", () => {
    const { markStale } = useStalePermissionsStore.getState();
    markStale(["per_a"]);
    const first = useStalePermissionsStore.getState().stale;
    markStale(["per_a"]);
    // Same reference => subscribers do not re-render for a no-op mark.
    expect(useStalePermissionsStore.getState().stale).toBe(first);
  });

  it("publishes a new set when an id is added", () => {
    const { markStale } = useStalePermissionsStore.getState();
    markStale(["per_a"]);
    const first = useStalePermissionsStore.getState().stale;
    markStale(["per_b"]);
    const second = useStalePermissionsStore.getState().stale;
    expect(second).not.toBe(first);
    expect(second.size).toBe(2);
  });

  it("ignores an empty mark so an empty reconcile cannot churn state", () => {
    const { markStale } = useStalePermissionsStore.getState();
    const first = useStalePermissionsStore.getState().stale;
    markStale([]);
    expect(useStalePermissionsStore.getState().stale).toBe(first);
  });

  it("never un-marks an id already known to be gone", () => {
    const { markStale } = useStalePermissionsStore.getState();
    markStale(["per_a"]);
    // A later reconcile that happens to list per_a as live must not resurrect
    // the card: the reply path already proved the server had forgotten it.
    markStale([]);
    expect(useStalePermissionsStore.getState().stale.has("per_a")).toBe(true);
  });
});

/**
 * The write half, exercised through the same pure function the hook delegates
 * to — so this covers the real rule, not a copy of it.
 *
 * Deliberately not render-based. `renderToStaticMarkup` reads zustand's SERVER
 * snapshot, which is `api.getInitialState()` — the state captured when the
 * store was created — so a `markStale` performed by the test is invisible to
 * the render. And `bun test` has no DOM (no jsdom / happy-dom), so a live
 * client render is not available either. Production is unaffected: the browser
 * subscribes through `getSnapshot`, which is live.
 */
describe("reportPermissionGone — the write half", () => {
  beforeEach(() => {
    useStalePermissionsStore.setState({ stale: new Set<string>() });
  });

  it("records the id when the failure is the gone signal", () => {
    const { markStale } = useStalePermissionsStore.getState();
    expect(
      reportPermissionGone(
        "per_gone",
        new Error("Permission request not found: per_gone"),
        markStale,
      ),
    ).toBe(true);
    expect(useStalePermissionsStore.getState().stale.has("per_gone")).toBe(true);
  });

  it("retires the request so it can never be offered again", () => {
    // The point of the guard: once a reply has PROVED the request is gone, the
    // same id reads as stale from then on — which is what makes both approval
    // surfaces render nothing for it.
    const { markStale } = useStalePermissionsStore.getState();
    expect(
      isStaleApproval("per_gone", useStalePermissionsStore.getState().stale),
    ).toBe(false);

    reportPermissionGone(
      "per_gone",
      new Error("Permission request not found: per_gone"),
      markStale,
    );

    expect(
      isStaleApproval("per_gone", useStalePermissionsStore.getState().stale),
    ).toBe(true);
  });

  it("retires only the request that failed, never its neighbours", () => {
    const { markStale } = useStalePermissionsStore.getState();
    reportPermissionGone(
      "per_gone",
      new Error("Permission request not found: per_gone"),
      markStale,
    );
    const { stale } = useStalePermissionsStore.getState();
    expect(stale.has("per_gone")).toBe(true);
    expect(isStaleApproval("per_other", stale)).toBe(false);
  });

  it("leaves an ordinary transient failure retryable", () => {
    // Conflating "gone" with "failed" would hide a card a retry could answer.
    const { markStale } = useStalePermissionsStore.getState();
    expect(
      reportPermissionGone("per_transient", new Error("Failed to fetch"), markStale),
    ).toBe(false);
    expect(useStalePermissionsStore.getState().stale.size).toBe(0);
  });

  it("reports nothing when there is no approval id to retire", () => {
    const { markStale } = useStalePermissionsStore.getState();
    expect(
      reportPermissionGone(
        undefined,
        new Error("Permission request not found"),
        markStale,
      ),
    ).toBe(false);
    expect(useStalePermissionsStore.getState().stale.size).toBe(0);
  });
});

describe("isStaleApproval", () => {
  it("is a pure membership test", () => {
    const stale = new Set(["per_a"]);
    expect(isStaleApproval("per_a", stale)).toBe(true);
    expect(isStaleApproval("per_b", stale)).toBe(false);
    expect(isStaleApproval(undefined, stale)).toBe(false);
    expect(isStaleApproval("per_a", new Set())).toBe(false);
  });
});

/* -------------------------------------------------------------------------
 * Approval parity.
 *
 * Phase 3A exists because the rich tool UIs had their OWN approval card
 * (`ApprovalGate`) and it did not share the guard the generic tool block
 * already had — so the wedge Phase 1 fixed was still reproducible through
 * every file-reading / file-writing tool. These assertions pin that shut.
 *
 * They are scoped to each component's own body and comments are stripped
 * first, so an explanatory comment can never satisfy them.
 * ---------------------------------------------------------------------- */

/** Every surface that can offer a decision on a permission request. */
const SURFACES = [
  {
    name: "ToolFallbackApproval",
    file: "../components/assistant-ui/elements/tool-fallback.tsx",
  },
  { name: "ApprovalGate", file: "../tools/filesystem/ui.tsx" },
] as const;

describe("approval parity — every surface shares the ONE guard", () => {
  const bodies = new Map<string, string>();

  beforeAll(async () => {
    for (const surface of SURFACES) {
      const source = await Bun.file(new URL(surface.file, import.meta.url)).text();
      bodies.set(surface.name, functionBody(stripComments(source), surface.name));
    }
  });

  function bodyOf(name: string): string {
    const body = bodies.get(name);
    if (body == null) throw new Error(`${name}'s body was not loaded`);
    return body;
  }

  for (const surface of SURFACES) {
    describe(surface.name, () => {
      it("applies the shared guard to its own approval id", () => {
        expect(bodyOf(surface.name)).toContain("= useStaleApprovalGuard(");
      });

      it("renders no controls for a request the server has forgotten", () => {
        expect(bodyOf(surface.name)).toContain("if (stale) return null;");
      });

      it("retires the card on the gone signal rather than offering a retry", () => {
        expect(bodyOf(surface.name)).toContain("reportGone(");
      });

      it("does not re-implement the rule locally", () => {
        const body = bodyOf(surface.name);
        expect(body).not.toContain("permission request not found");
        expect(body).not.toContain("markStale");
        expect(body).not.toContain("isPermissionGone");
      });
    });
  }

  it("keeps the server's wording as code in exactly one place", async () => {
    // If a second copy of the wording appears, a surface has grown its own
    // rule again — which is the bug 3A closes.
    const store = await Bun.file(
      new URL("./stalePermissionsStore.ts", import.meta.url),
    ).text();
    const occurrences =
      stripComments(store).match(/permission request not found/gi) ?? [];
    expect(occurrences.length).toBe(1);
  });

  it("the standalone permission list uses the store, not a copy of the rule", async () => {
    const source = await Bun.file(
      new URL("../features/opencode/OpenCodePermissions.tsx", import.meta.url),
    ).text();
    const code = stripComments(source);
    expect(code).toContain("isPermissionGone");
    expect(code).toContain("useStalePermissionsStore");
    expect(code).not.toMatch(/\/permission request not found\/i/);
  });
});
