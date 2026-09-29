import { describe, expect, it } from "bun:test";
import { schedulerActionNeedsApproval } from "./index";

/**
 * Which scheduler actions ask a person before running.
 *
 * `scheduler` is ONE tool with six actions, so the choice is between gating the
 * whole tool — which would prompt the reader to approve `list`, the call a model
 * makes to answer "what jobs are there?" — and gating per call. The schema is a
 * discriminated union on `action`, so the decision is made per call.
 *
 * The dangerous direction is ungating. A job that fires unattended with the
 * conversation's provider credentials is a real privilege, so anything not
 * positively known to be a read is gated.
 */
describe("schedulerActionNeedsApproval", () => {
  it("does not ask for the two read-only actions", () => {
    expect(schedulerActionNeedsApproval({ action: "list" })).toBe(false);
    expect(schedulerActionNeedsApproval({ action: "get", jobId: "j1" })).toBe(false);
  });

  it("asks for every action that creates, changes, removes or fires a job", () => {
    expect(schedulerActionNeedsApproval({ action: "create", name: "n" })).toBe(true);
    expect(schedulerActionNeedsApproval({ action: "update", jobId: "j1" })).toBe(true);
    expect(schedulerActionNeedsApproval({ action: "delete", jobId: "j1" })).toBe(true);
    // Fires a stored prompt right now, on this machine, with the conversation's
    // credentials. Nothing persistent changes, but everything consequential does.
    expect(schedulerActionNeedsApproval({ action: "run_now", jobId: "j1" })).toBe(true);
  });

  it("asks for an action it has never heard of", () => {
    // The safe default that matters: a new action added to the schema without a
    // decision here must stop and ask, not inherit the read-only trust.
    expect(schedulerActionNeedsApproval({ action: "pause" })).toBe(true);
    expect(schedulerActionNeedsApproval({ action: "" })).toBe(true);
    expect(schedulerActionNeedsApproval({ action: "LIST" })).toBe(true);
  });

  it("asks when the action cannot be read at all", () => {
    // A call whose arguments cannot be shown to the reader cannot be approved
    // by them either. Validation rejects it immediately afterwards, so gating
    // here costs nothing.
    for (const input of [null, undefined, "create", 42, {}, { action: 7 }]) {
      expect(schedulerActionNeedsApproval(input), String(input)).toBe(true);
    }
  });

  it("reads the action, not the rest of the arguments", () => {
    // A create with every field populated is still a create.
    expect(
      schedulerActionNeedsApproval({
        action: "create",
        name: "nightly",
        scheduleType: "cron",
        timezone: "UTC",
        prompt: "do a thing",
        cronExpression: "0 3 * * *",
      }),
    ).toBe(true);
    // And a get with no jobId is still a read, and still ungated — validation
    // is what rejects the missing id, not the approval policy.
    expect(schedulerActionNeedsApproval({ action: "get" })).toBe(false);
  });
});
