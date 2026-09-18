import { describe, it, expect, beforeAll } from "bun:test";
import { commentedBodyOf } from "@/testing/source-scope";

/**
 * Source-level guard for the approval surface's dead-request contract.
 *
 * This is NOT a behavioural test, for the same reason as
 * `markdown-text.test.ts`: `web/` has no component-test runner, so the
 * component cannot be rendered here. The store's own logic is covered
 * behaviourally in `stores/stalePermissionsStore.test.ts`; this file guards
 * the *ordering* inside the surface, and the end-to-end behaviour is confirmed
 * in the browser.
 *
 * Division of labour, so the two guard files do not drift:
 * - `stores/stalePermissionsStore.test.ts` owns "is the shared guard applied
 *   at all, on every surface, and is the rule kept in one place".
 * - This file owns "is it applied in the right *place* inside the surface" —
 *   the guard has to precede the controls it suppresses and precede the
 *   retryable path, or the wedge returns even though the call is present.
 *
 * Why it matters: OpenCode keeps pending permissions in server memory only, so
 * a long-lived session can hold a request the server has forgotten. Both
 * Approve and Deny then answer "Permission request not found", and the card
 * stays on screen with no way to clear it.
 *
 * Assertions are scoped to the component's own body with comments stripped, so
 * a match has to be real code inside the surface — not an import line, and not
 * a comment that merely describes the rule.
 */
let body = "";

beforeAll(async () => {
  body = await commentedBodyOf(
    "ToolFallbackApproval",
    "./tool-fallback.tsx",
    import.meta.url,
  );
});

describe("approval surface — dead requests", () => {
  it("bails out before rendering any approval control", () => {
    const guard = body.indexOf("if (stale) return null;");
    const firstControl = body.indexOf('data-slot="tool-fallback-approval"');

    expect(guard).toBeGreaterThan(-1);
    expect(firstControl).toBeGreaterThan(-1);
    // Order is the contract: a bail-out after the controls would render them
    // and then suppress them, which is the wedge.
    expect(guard).toBeLessThan(firstControl);
  });

  it("retires a card whose reply proves the request is gone", () => {
    // Backstop for the case the reconcile probe could not run.
    const gone = body.indexOf("reportGone(sendError)");
    const retry = body.indexOf("cancelExit()");

    expect(gone).toBeGreaterThan(-1);
    expect(retry).toBeGreaterThan(-1);
    // The gone-signal must be checked BEFORE the retryable path: otherwise the
    // card re-renders its controls and can only ever fail again.
    expect(gone).toBeLessThan(retry);
  });

  it("keeps a transient failure retryable", () => {
    // An ordinary send failure must still cancel the exit and show the error,
    // so the guard above has to be conditional on the gone-signal only.
    expect(body).toContain("cancelExit();");
    expect(body).toContain("setSubmitted(false);");
  });
});
