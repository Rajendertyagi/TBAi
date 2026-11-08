/**
 * The live OpenCode retry and the process-local activity it is reconciled with.
 *
 * ## Why this file exists
 *
 * Retry is the one piece of runtime state that a reader will believe even when
 * it is wrong: "Retrying in 5s" is a promise about a scheduled wait. Three
 * separate mistakes all render as a plausible countdown:
 *
 * - clearing the wait on an ordinary history refresh (which is not evidence
 *   that the wait ended),
 * - rebuilding a countdown from a durable record (which proves an attempt
 *   happened, not that a process is still waiting),
 * - letting a late activity response overwrite newer event evidence.
 *
 * The lifecycle table in `docs`/the plan is what these cases pin, row by row.
 * `activityRevision` is the ordering marker that makes the third mistake
 * impossible inside the existing reducer, so the stale-response cases assert
 * the revision as well as the value.
 */

import { describe, expect, it } from "bun:test";
import type { V2Event } from "@opencode/client";
import {
  createInitialV2ThreadState,
  reduceV2Event,
  reduceV2ThreadState,
} from "@web/features/opencode/v2Events.ts";
import type {
  V2ActivityState,
  V2ThreadAction,
  V2ThreadState,
} from "@web/features/opencode/v2Types.ts";

const SESSION_ID = "ses_retry_activity_test";
const ASSISTANT_MESSAGE_ID = "msg_retry_activity_test";
const DEADLINE = 1_700_000_000_000;

/** Builds one public V2 event with a unique id. */
function event(id: string, type: V2Event["type"], data: unknown): V2Event {
  return { id, created: 1, type, data } as V2Event;
}

function statusEvent(
  id: string,
  status:
    | { readonly type: "idle" }
    | { readonly type: "busy" }
    | {
        readonly type: "retry";
        readonly attempt: number;
        readonly message: string;
        readonly next: number;
      },
): V2Event {
  return event(id, "session.status", { sessionID: SESSION_ID, status });
}

function retryScheduled(id: string, attempt: number, at: number): V2Event {
  return event(id, "session.retry.scheduled", {
    sessionID: SESSION_ID,
    assistantMessageID: ASSISTANT_MESSAGE_ID,
    attempt,
    at,
    error: { type: "provider", message: "provider overloaded", status: 503 },
  });
}

function apply(state: V2ThreadState, next: V2Event, replayed = false): V2ThreadState {
  return reduceV2Event(state, next, "observe-and-apply", replayed);
}

function initial(): V2ThreadState {
  return createInitialV2ThreadState(SESSION_ID);
}

/** A state holding a live retry at attempt 2, deadline `DEADLINE`. */
function retrying(): V2ThreadState {
  return apply(initial(), retryScheduled("evt_retry_seed", 2, DEADLINE));
}

const ACTIVITY_EVENTS: ReadonlyArray<{
  readonly label: string;
  readonly event: () => V2Event;
  readonly activity: V2ActivityState;
}> = [
  {
    label: "session.status busy",
    event: () => statusEvent("evt_busy", { type: "busy" }),
    activity: "running",
  },
  {
    label: "session.status idle",
    event: () => statusEvent("evt_idle", { type: "idle" }),
    activity: "not-running",
  },
  {
    label: "session.execution.started",
    event: () => event("evt_exec_started", "session.execution.started", { sessionID: SESSION_ID }),
    activity: "running",
  },
  {
    label: "session.execution.succeeded",
    event: () =>
      event("evt_exec_succeeded", "session.execution.succeeded", { sessionID: SESSION_ID }),
    activity: "not-running",
  },
  {
    label: "session.execution.failed",
    event: () =>
      event("evt_exec_failed", "session.execution.failed", {
        sessionID: SESSION_ID,
        error: { type: "provider", message: "provider failed" },
      }),
    activity: "not-running",
  },
  {
    label: "session.idle",
    event: () => event("evt_session_idle", "session.idle", { sessionID: SESSION_ID }),
    activity: "not-running",
  },
  {
    label: "session.text.started",
    event: () =>
      event("evt_text_started", "session.text.started", {
        sessionID: SESSION_ID,
        assistantMessageID: ASSISTANT_MESSAGE_ID,
        ordinal: 0,
      }),
    activity: "running",
  },
  {
    label: "session.step.started",
    event: () =>
      event("evt_step_started", "session.step.started", {
        sessionID: SESSION_ID,
        assistantMessageID: ASSISTANT_MESSAGE_ID,
        agent: "build",
        model: { id: "m", providerID: "p" },
        started: 1,
      }),
    activity: "running",
  },
];

describe("a live retry is established only from live evidence", () => {
  it("session.retry.scheduled stores the attempt, deadline, and mapped error", () => {
    const state = apply(initial(), retryScheduled("evt_retry_live", 2, DEADLINE));

    expect(state.retry).toEqual({
      attempt: 2,
      next: DEADLINE,
      error: { kind: "server", message: "provider overloaded", status: 503 },
    });
    // The attempt alone does not prove whether the session is running.
    expect(state.activity).toBe("unknown");
    expect(state.activityRevision).toBe(1);
  });

  it("keeps the historical retry part in the transcript", () => {
    const state = apply(initial(), retryScheduled("evt_retry_part", 2, DEADLINE));
    const parts = state.messages[ASSISTANT_MESSAGE_ID]?.parts ?? [];

    expect(parts.some((part) => part.kind === "retry")).toBe(true);
  });

  it("accepts the real wire literal session.status and no longer diagnoses it", () => {
    const state = apply(initial(), statusEvent("evt_status_busy", { type: "busy" }));

    expect(state.diagnosticCount).toBe(0);
    expect(state.activity).toBe("running");
  });

  it("no longer accepts the dead session.status.updated literal", () => {
    const dead = event("evt_dead_status", "session.status.updated" as never, {
      sessionID: SESSION_ID,
      status: { type: "busy" },
    });
    const state = apply(retrying(), dead);

    // Ignored as an unknown type: a diagnostic, no retry/activity evidence.
    expect(state.diagnosticCount).toBe(1);
    expect(state.retry).toEqual(retrying().retry);
    expect(state.activityRevision).toBe(retrying().activityRevision);
  });

  it("does not turn a replayed durable record into a live countdown", () => {
    const replay = retryScheduled("evt_retry_replay", 3, DEADLINE);
    const state = apply(initial(), replay, true);

    // The transcript part is content, so it is still written…
    expect(
      state.messages[ASSISTANT_MESSAGE_ID]?.parts.some((part) => part.kind === "retry") ?? false,
    ).toBe(true);
    // …but no wait, activity, or ordering evidence is invented from history.
    expect(state.retry).toBeNull();
    expect(state.activity).toBe("unknown");
    expect(state.activityRevision).toBe(0);
  });

  it("session.status retry stores the deadline and proves no activity", () => {
    const state = apply(
      initial(),
      statusEvent("evt_status_retry", {
        type: "retry",
        attempt: 4,
        message: "rate limited",
        next: DEADLINE,
      }),
    );

    expect(state.retry).toEqual({
      attempt: 4,
      next: DEADLINE,
      error: { kind: "unknown", message: "rate limited", status: undefined },
    });
    expect(state.activity).toBe("unknown");
  });

  it("rejects an untrustworthy deadline instead of fabricating a countdown", () => {
    for (const [index, next] of [0, -1, Number.NaN, Number.POSITIVE_INFINITY].entries()) {
      const state = apply(
        initial(),
        statusEvent(`evt_status_bad_deadline_${index}`, {
          type: "retry",
          attempt: 1,
          message: "rate limited",
          next,
        }),
      );
      expect(state.retry?.next).toBeNull();
    }
  });
});

describe("the attempt guard orders retry evidence", () => {
  it("ignores a lower attempt entirely: retry, activity, and revision unchanged", () => {
    const base = retrying();
    const lower = apply(base, retryScheduled("evt_retry_lower", 1, DEADLINE + 1));

    expect(lower.retry).toEqual(base.retry);
    expect(lower.activity).toBe(base.activity);
    expect(lower.activityRevision).toBe(base.activityRevision);
  });

  it("updates the deadline for an equal attempt", () => {
    const base = retrying();
    const equal = apply(base, retryScheduled("evt_retry_equal", 2, DEADLINE + 5_000));

    expect(equal.retry?.attempt).toBe(2);
    expect(equal.retry?.next).toBe(DEADLINE + 5_000);
  });

  it("replaces the wait for a higher attempt", () => {
    const higher = apply(retrying(), retryScheduled("evt_retry_higher", 3, DEADLINE + 9_000));

    expect(higher.retry?.attempt).toBe(3);
    expect(higher.retry?.next).toBe(DEADLINE + 9_000);
  });
});

describe("proven work or a proven end clears the wait", () => {
  for (const row of ACTIVITY_EVENTS) {
    it(`${row.label} clears retry and establishes ${row.activity}`, () => {
      const state = apply(retrying(), row.event());

      expect(state.retry).toBeNull();
      expect(state.activity).toBe(row.activity);
    });
  }

  it("execution.interrupted clears the wait for EVERY reason and never claims a live run", () => {
    for (const [index, reason] of (
      ["user", "shutdown", "superseded", "inactivity"] as const
    ).entries()) {
      const state = apply(
        retrying(),
        event(`evt_interrupted_${index}`, "session.execution.interrupted", {
          sessionID: SESSION_ID,
          reason,
        }),
      );

      expect(state.retry).toBeNull();
      // Not `not-running`: an interruption proves neither an idle session nor a
      // surviving one. A shutdown reason is not a promise that a retry lives.
      expect(state.activity).toBe("unknown");
    }
  });

  it("lets later evidence settle activity after an interruption", () => {
    const interrupted = apply(
      retrying(),
      event("evt_interrupted_then_started", "session.execution.interrupted", {
        sessionID: SESSION_ID,
        reason: "shutdown",
      }),
    );

    const resumed = apply(
      interrupted,
      event("evt_started_after_interrupt", "session.execution.started", {
        sessionID: SESSION_ID,
      }),
    );
    expect(resumed.activity).toBe("running");

    const ended = apply(interrupted, statusEvent("evt_idle_after_interrupt", { type: "idle" }));
    expect(ended.activity).toBe("not-running");
  });
});

describe("only a connection attempt invalidates the wait", () => {
  it("an ordinary refresh preserves the retry, activity, and revision", () => {
    const beforeRead = retrying();
    const base = reduceV2ThreadState(beforeRead, {
      type: "activity_resolved",
      activity: "not-running",
      revision: beforeRead.activityRevision,
    });
    const refreshed = reduceV2ThreadState(base, { type: "load_started", reason: "refresh" });

    expect(refreshed.retry).toEqual(base.retry);
    expect(refreshed.activity).toBe(base.activity);
    expect(refreshed.activityRevision).toBe(base.activityRevision);
  });

  it("a connection attempt clears the retry and makes activity unknown", () => {
    const base = retrying();
    const connection = reduceV2ThreadState(base, { type: "load_started", reason: "connection" });

    expect(connection.retry).toBeNull();
    expect(connection.activity).toBe("unknown");
    expect(connection.activityRevision).toBe(base.activityRevision + 1);
  });

  it("leaving connected clears the retry; becoming connected alone does not", () => {
    const base = retrying();

    const nonConnected = [
      { type: "waiting-for-server" },
      { type: "reconnecting", attempt: 1 },
      { type: "failed", attempt: 3 },
      { type: "closed" },
    ] as const;

    for (const connection of nonConnected) {
      const left = reduceV2ThreadState(base, {
        type: "connection_changed",
        connection,
      });
      expect(left.retry).toBeNull();
      expect(left.activity).toBe("unknown");
      expect(left.activityRevision).toBe(base.activityRevision + 1);
    }

    const connected = reduceV2ThreadState(base, {
      type: "connection_changed",
      connection: { type: "connected", serverVersion: "2.1.2" },
    });
    expect(connected.retry).toEqual(base.retry);
    expect(connected.activityRevision).toBe(base.activityRevision);
  });

  it("load failure, load completion, hydration, and unrelated events preserve the wait", () => {
    const base = retrying();
    const actions: readonly V2ThreadAction[] = [
      { type: "load_failed", error: { kind: "network", message: "refresh failed" } },
      { type: "load_completed" },
      {
        type: "session_hydrated",
        session: {
          id: SESSION_ID,
          projectID: "project",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: 2 },
          location: { directory: "D:\\workspace" },
        },
      },
      { type: "execution_settled" },
    ];

    for (const action of actions) {
      const next = reduceV2ThreadState(base, action);
      expect(next.retry).toEqual(base.retry);
      expect(next.activityRevision).toBe(base.activityRevision);
    }

    const unrelated = apply(
      base,
      event("evt_unrelated", "session.permissions", { sessionID: SESSION_ID, permissions: [] }),
    );
    expect(unrelated.retry).toEqual(base.retry);
    expect(unrelated.activityRevision).toBe(base.activityRevision);
  });
});

describe("the activity snapshot is ordered by its revision", () => {
  it("accepts a snapshot taken at the current revision", () => {
    const base = retrying();
    const resolved = reduceV2ThreadState(base, {
      type: "activity_resolved",
      activity: "running",
      revision: base.activityRevision,
    });

    expect(resolved.activity).toBe("running");
    // An accepted read is not itself new ordering evidence.
    expect(resolved.activityRevision).toBe(base.activityRevision);
  });

  it("discards a snapshot after a newer authoritative event", () => {
    const captured = retrying();
    const revision = captured.activityRevision;
    // A live status arrives while the read is in flight.
    const newer = apply(captured, statusEvent("evt_busy_in_flight", { type: "busy" }));
    const late = reduceV2ThreadState(newer, {
      type: "activity_resolved",
      activity: "not-running",
      revision,
    });

    expect(late).toBe(newer);
    expect(late.activity).toBe("running");
  });

  it("a failed lookup still has to win the revision guard", () => {
    const captured = retrying();
    const newer = reduceV2ThreadState(captured, { type: "load_started", reason: "connection" });
    const late = reduceV2ThreadState(newer, {
      type: "activity_resolved",
      activity: "unknown",
      revision: captured.activityRevision,
    });

    expect(late).toBe(newer);
    expect(late.activity).toBe("unknown");
  });
});
