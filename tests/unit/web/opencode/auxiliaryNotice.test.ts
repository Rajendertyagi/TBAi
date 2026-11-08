/**
 * M10 — the status popover must NAME the pending sets it could not read.
 *
 * The state already keeps the last known entries when a read fails (pinned by
 * `R-M10` in the controller suite). This is the other half: the surface has to
 * say so, because until it does, a set kept from before the failure looks
 * exactly like one the server just confirmed.
 *
 * The copy is asserted in pieces (the named kinds and the static sentence)
 * rather than as one exact string: wording may change, the set of named kinds
 * may not.
 */

import { describe, expect, it } from "bun:test";
import { pendingSetNotice } from "@web/features/opencode/auxiliaryNotice.ts";
import type { V2AuxiliaryState } from "@web/features/opencode/v2Types.ts";

const CURRENT: V2AuxiliaryState = {
  inbox: "current",
  permissions: "current",
  forms: "current",
};

describe("the pending-set stale notice", () => {
  it("says nothing while every pending set is current", () => {
    expect(pendingSetNotice(CURRENT)).toBeNull();
  });

  it("names the one set whose read failed", () => {
    const notice = pendingSetNotice({ ...CURRENT, permissions: "unavailable" });

    expect(notice).toContain("permissions");
    expect(notice).toContain("may be out of date");
    // The sets that DID read are not named, or the reader cannot tell which
    // list to distrust.
    expect(notice).not.toContain("queued prompts");
    expect(notice).not.toContain("questions");
  });

  it("names every failing set, in the order the state lists them", () => {
    const notice = pendingSetNotice({
      inbox: "unavailable",
      permissions: "unavailable",
      forms: "current",
    });

    expect(notice).toContain("queued prompts, permissions");
    expect(notice).not.toContain("questions");
  });

  it("names all three when nothing could be read", () => {
    const notice = pendingSetNotice({
      inbox: "unavailable",
      permissions: "unavailable",
      forms: "unavailable",
    });

    expect(notice).toContain("queued prompts, permissions, questions");
  });
});
