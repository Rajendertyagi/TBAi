import { describe, expect, it } from "bun:test";
import {
  ALWAYS_ELIGIBLE_PERMISSION_ACTIONS,
  AUTO,
  AUTO_RESPONSE,
  MANUAL,
  QUESTION_PERMISSION_ACTION,
  isAutoActive,
  restoreMode,
  shouldAutoApprove,
  toggleAuto,
} from "./permissionPolicy";
import { stripComments } from "@/testing/source-scope";

/**
 * The Manual/Auto shield, and the one action-aware eligibility rule on top of it.
 *
 * THE BUG THESE CASES PIN. A user's OpenCode config sets
 * `{ "action": "question", "resource": "*", "effect": "ask" }`, so raising the
 * `question` tool produced a permission. With the shield in Manual — the
 * default — the user had to click Approve on a card that protected nothing
 * before the actual question form existed. Two clicks to ask one question, and
 * the first one approved nothing: asking reads nothing, writes nothing and runs
 * nothing.
 *
 * THE GUARD THAT MATTERS MOST is the other half. `question` becoming automatic
 * must not become "everything became automatic": `shell`, `subagent` and
 * `external_directory` still ask in Manual, and an action nobody recognises
 * still asks. Those are the assertions that would fail if the rule were ever
 * written as "auto-approve unless…" or if the set were matched loosely.
 */
describe("permission policy — a question needs no approval", () => {
  it("accepts a question with the shield in Manual, the position that used to ask twice", () => {
    expect(shouldAutoApprove(MANUAL, QUESTION_PERMISSION_ACTION)).toBe(true);
  });

  it("accepts a question with the shield on, exactly as it always did", () => {
    expect(shouldAutoApprove(AUTO, QUESTION_PERMISSION_ACTION)).toBe(true);
  });

  it("does not move the shield itself: a question is not a trust grant", () => {
    // The eligibility rule sits ON TOP of the shield; it must not leak into the
    // shield's own state, or every later action would inherit the answer.
    expect(isAutoActive(MANUAL)).toBe(false);
    expect(isAutoActive(AUTO)).toBe(true);
  });
});

/**
 * The wire action names, spelled as OpenCode sends them.
 *
 * Deliberate literals, NOT the always-eligible constant: these are the negative
 * cases, and a negative case written against a constant can only ever prove the
 * constant agrees with itself. `shell` is the action from a real observed V2
 * permission (see `v2Permissions.test.ts`); `subagent` and
 * `external_directory` are the other `ask` actions on that default list.
 */
const ASKED_ACTIONS = ["shell", "subagent", "external_directory"] as const;

describe("permission policy — every other action still follows the shield", () => {
  it("asks for shell, subagent and external_directory in Manual", () => {
    for (const action of ASKED_ACTIONS) {
      expect(shouldAutoApprove(MANUAL, action)).toBe(false);
    }
  });

  it("accepts shell, subagent and external_directory in Auto, unchanged", () => {
    for (const action of ASKED_ACTIONS) {
      expect(shouldAutoApprove(AUTO, action)).toBe(true);
    }
  });

  it("asks for an action nobody recognises when the shield is off", () => {
    // Fail closed. A new OpenCode action must arrive as a question for the user,
    // never as a silent approval, and must not be rescued by the eligibility
    // rule — an unrecognised action is not treated as a question.
    expect(shouldAutoApprove(MANUAL, "some_action_added_next_year")).toBe(false);
  });

  it("leaves an unrecognised action to the shield when it is on", () => {
    // The unknown action is not DENIED by not being on the list; it is simply
    // not exempt from the shield, which is exactly how it behaved before.
    expect(shouldAutoApprove(AUTO, "some_action_added_next_year")).toBe(true);
  });

  it("asks when no action was supplied at all", () => {
    // The call shape every pre-existing caller uses: one argument, no action.
    // It must keep meaning "no action known", so it follows the shield — and a
    // caller that forgets the new argument can never start approving things.
    expect(shouldAutoApprove(MANUAL)).toBe(false);
    expect(shouldAutoApprove(AUTO)).toBe(true);
  });

  it("is not fooled by a near miss on the always-eligible action", () => {
    // Set membership is exact: casing, padding and a suffix are all different
    // actions and must all be asked.
    for (const action of ["Question", " question", "question ", "question.form"]) {
      expect(shouldAutoApprove(MANUAL, action)).toBe(false);
    }
  });
});

describe("permission policy — the always-eligible set", () => {
  it("holds exactly one action, the question", () => {
    // The load-bearing structural claim: this is a named list, not a growing
    // matrix. Anything else added here would silently change what the app
    // approves without the user asking for it.
    expect([...ALWAYS_ELIGIBLE_PERMISSION_ACTIONS]).toEqual([QUESTION_PERMISSION_ACTION]);
  });

  it("is the only place the action name is spelled", async () => {
    // The wire value is a constant, so a second literal elsewhere could drift
    // from it. The policy module is the single source of truth; everything that
    // needs the action imports it (the native controller included).
    const source = stripComments(
      await Bun.file(new URL("./permissionPolicy.ts", import.meta.url)).text(),
    );
    const occurrences = source.split(`"${QUESTION_PERMISSION_ACTION}"`).length - 1;
    // Exactly one: the constant's own value. (Comments are stripped above, so
    // the prose that mentions the action cannot be counted here.)
    expect(occurrences).toBe(1);
  });
});

describe("permission policy — the shield's invariants are unchanged", () => {
  it("has exactly one automatic response, and it is 'once'", () => {
    // Never `always`: an automatic acceptance must not leave a standing grant.
    expect(AUTO_RESPONSE).toBe("once");
  });

  it("fails closed to Manual for corrupt or absent persisted state", () => {
    for (const value of [undefined, null, "AUTO", "Auto", true, 1, 0, {}, [], ""]) {
      expect(restoreMode(value)).toBe(MANUAL);
    }
  });

  it("restores exactly the two positions it was given", () => {
    expect(restoreMode(AUTO)).toBe(AUTO);
    expect(restoreMode(MANUAL)).toBe(MANUAL);
  });

  it("still flips between the two positions and nothing else", () => {
    expect(toggleAuto(MANUAL)).toBe(AUTO);
    expect(toggleAuto(AUTO)).toBe(MANUAL);
    expect(toggleAuto(toggleAuto(MANUAL))).toBe(MANUAL);
  });
});

/**
 * The module is pure, and that is a structural property worth pinning.
 *
 * The policy is imported by a non-React event path (the native controller's
 * event loop), so a dependency on React, the host DOM, the network or the
 * OpenCode client would make an eligibility decision impossible to make there —
 * and would drag the permission wire format across a boundary the module's own
 * header reserves for `features/opencode`.
 */
describe("permission policy — the module stays pure", () => {
  it("imports nothing and touches no host API", async () => {
    const source = stripComments(
      await Bun.file(new URL("./permissionPolicy.ts", import.meta.url)).text(),
    );

    expect(source).not.toContain("import ");
    expect(source).not.toContain("require(");
    expect(source).not.toContain("@opencode/client");
    expect(source).not.toContain("react");
    expect(source).not.toContain("fetch(");
    expect(source).not.toContain("localStorage");
    expect(source).not.toContain("document.");
  });
});
