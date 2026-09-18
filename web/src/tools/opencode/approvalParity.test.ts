import { describe, it, expect, beforeAll } from "bun:test";
import { stripComments } from "@/testing/source-scope";
import * as ui from "./ui";

/**
 * Phase 3C's hard requirement: the permission-gated OpenCode tools must keep
 * the SAME protected approval lifecycle, and no second approval path may be
 * introduced.
 *
 * The chain that makes that true:
 *
 *   OpenCode renderer  ->  BackendToolView  ->  ApprovalGate  ->  useStaleApprovalGuard
 *   (tools/opencode/ui.tsx) (filesystem/ui)   (filesystem/ui)    (stalePermissionsStore)
 *
 * The last two links are guarded in `stores/stalePermissionsStore.test.ts`
 * (parity + no local re-implementation) and in `tool-fallback.test.ts`
 * (ordering). This file guards the first link: that the OpenCode renderers add
 * no gate of their own and always hand approval state to the shared dispatcher.
 *
 * A renderer that rendered its own buttons would answer a permission the server
 * may have forgotten, which is the wedge — on the very tools that hit it.
 */
let source = "";
let code = "";

beforeAll(async () => {
  source = await Bun.file(new URL("./ui.tsx", import.meta.url)).text();
  code = stripComments(source);
});

describe("OpenCode renderers — one approval path, not two", () => {
  it("delegates to the shared dispatcher", () => {
    expect(code).toContain("BackendToolView");
  });

  it("does not reach the gate directly", () => {
    // Importing ApprovalGate here would be the second path: it is reached only
    // through BackendToolView, which owns the state routing.
    expect(code).not.toContain("ApprovalGate");
  });

  it("does not re-implement the stale-permission rule", () => {
    // The rule lives in one place. A copy here would drift from the guarded one.
    expect(code).not.toContain("useStaleApprovalGuard");
    expect(code).not.toContain("isPermissionGone");
    expect(code).not.toContain("markStale");
    expect(code).not.toMatch(/permission request not found/i);
  });

  it("does not answer a gate itself", () => {
    // It may PASS the responder down, but must never call it: answering is the
    // gate's job, and doing it here would bypass the guard.
    expect(code).toContain("respondToApproval={p.respondToApproval}");
    expect(code).not.toMatch(/respondToApproval\s*\(/);
  });

  it("does not build its own approval card chrome", () => {
    // These belong to the shared surface; using them here would fork the gate.
    expect(code).not.toContain("useApprovalExit");
    expect(code).not.toContain("ApprovalActions");
    expect(code).not.toContain("ApprovalCard");
  });

  it("exports a renderer for every gated tool it claims to map", () => {
    // A mapping without a registered renderer would silently fall back to the
    // generic card, losing both the rich UI and the standalone gate.
    //
    // Asserted against the module's actual exports, not its source spelling:
    // `edit`/`write` are built by the shared factory while `bash` is written
    // by hand (it needs its own terminal branch), so the two legitimately
    // register differently. What must hold is that each one exists as a
    // renderer, and that each is wired to its own tool name — a copy-pasted
    // renderer still passing the *other* tool's name would normalize the wrong
    // field set and is exactly the kind of slip this guards.
    for (const [tool, exported] of [
      ["bash", "OpenCodeBashToolUI"],
      ["edit", "OpenCodeEditToolUI"],
      ["write", "OpenCodeWriteToolUI"],
    ] as const) {
      expect(typeof (ui as Record<string, unknown>)[exported], exported).toBe(
        "function",
      );
      expect(code, tool).toContain(`"${tool}"`);
    }
  });
});
