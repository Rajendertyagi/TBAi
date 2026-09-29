import { describe, expect, it } from "bun:test";
import { openCodePendingPatchFor } from "./ui";

/**
 * The pending-change lookup the approval gate's hook delegates to.
 *
 * This is the seam a browser is the only other way to reach: the hook itself
 * needs an `AuiProvider`, so a unit test can never exercise it. Everything that
 * can actually be wrong lives in the reader - the key path, the shape checks,
 * the empty patch, a call id that is not in the map - so the reader is tested
 * against the exact metadata shape the projection writes.
 *
 * What is NOT tested here is whether the reader and the writer agree on the key:
 * that needs both, and the test for it projects a real message and reads the
 * result back. It lives with the projection rather than here, because a test that
 * hand-writes the metadata key - as the cases below do - would agree with a
 * reader no matter what key the writer chose, which is the failure it is meant
 * to catch.
 *
 * Getting the key path wrong is not hypothetical. The code-fence budget shipped
 * wired to a slot the library never read, and typecheck, build and every unit
 * test were green while the feature did nothing.
 */

const PATCH = "--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n-old\n+new\n";
const CALL = "tbai-v2-tool:msg%3Amsg_1:tool_1";

/** The metadata shape `messageToAssistant` writes. */
const metadataWith = (pendingPatches: unknown) => ({
  opencode: { parts: [], pendingPatches },
});

describe("pending-change lookup", () => {
  it("returns the patch for the tool call it was keyed to", () => {
    expect(openCodePendingPatchFor(metadataWith({ [CALL]: PATCH }), CALL)).toBe(PATCH);
  });

  it("is null for a call id the map does not carry", () => {
    // The normal case while another tool in the same message is pending.
    expect(openCodePendingPatchFor(metadataWith({ other: PATCH }), CALL)).toBeNull();
  });

  it("is null when the map is empty or absent", () => {
    expect(openCodePendingPatchFor(metadataWith({}), CALL)).toBeNull();
    expect(openCodePendingPatchFor({ opencode: { parts: [] } }, CALL)).toBeNull();
  });

  it("is null for an empty or blank patch", () => {
    // A blank patch would render an empty diff, which reads as "no change" -
    // the opposite of what a gate must convey.
    expect(openCodePendingPatchFor(metadataWith({ [CALL]: "" }), CALL)).toBeNull();
    expect(openCodePendingPatchFor(metadataWith({ [CALL]: "   " }), CALL)).toBeNull();
  });

  it("is null when the stored value is not a string", () => {
    expect(openCodePendingPatchFor(metadataWith({ [CALL]: 42 }), CALL)).toBeNull();
    expect(openCodePendingPatchFor(metadataWith({ [CALL]: null }), CALL)).toBeNull();
    expect(openCodePendingPatchFor(metadataWith({ [CALL]: { patch: PATCH } }), CALL)).toBeNull();
  });

  it("is null for absent, malformed, or empty metadata", () => {
    // No message metadata at all is the normal state for a Direct-chat part and
    // for any OpenCode part that never carried `parts`.
    expect(openCodePendingPatchFor(undefined, CALL)).toBeNull();
    expect(openCodePendingPatchFor(null, CALL)).toBeNull();
    expect(openCodePendingPatchFor("nonsense", CALL)).toBeNull();
    expect(openCodePendingPatchFor({}, CALL)).toBeNull();
    expect(openCodePendingPatchFor({ opencode: null }, CALL)).toBeNull();
    expect(openCodePendingPatchFor({ opencode: "x" }, CALL)).toBeNull();
    expect(openCodePendingPatchFor({ opencode: { pendingPatches: "x" } }, CALL)).toBeNull();
    expect(openCodePendingPatchFor({ opencode: { pendingPatches: 7 } }, CALL)).toBeNull();
  });

  it("is null without a call id", () => {
    expect(openCodePendingPatchFor(metadataWith({ [CALL]: PATCH }), undefined)).toBeNull();
  });
});
