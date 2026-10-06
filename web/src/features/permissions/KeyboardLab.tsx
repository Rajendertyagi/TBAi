"use client";

import { useState } from "react";
import { ApprovalActions, ApprovalCard } from "@/components/shared/approval-card";
import { useKeyboardClaimed } from "@/lib/focus";

/**
 * DEV-ONLY diagnostic page. Reachable at `#/keyboard-lab` in a dev build only.
 *
 * ## What this exists for
 *
 * The permission-card keyboard work has properties that no unit test can check:
 * does focus actually land, does it land on the TOPMOST card when several are
 * stacked, does the mark appear, and does approving hand the keyboard to the next
 * card? Focus, mount effects, event bubbling, native activation, `:has()` styling
 * and computed styles are all browser behaviour. When the wiring is wrong the
 * symptom is silence -- Enter reaches the composer and sends an empty message
 * instead of approving, which looks like a hung card rather than a bug.
 *
 * So this renders the REAL `ApprovalActions` inside the REAL `ApprovalCard`, in
 * the real DOM, with a stand-in composer carrying the exact attribute
 * `focusComposerInput()` looks for. Deciding a card REMOVES it, as answering a
 * real request does, so the drain can be watched rather than imagined.
 *
 * ## Why it renders a LIST
 *
 * The first version of this lab rendered one card, which is why a whole class of
 * bug got through: `OpenCodePermissions` deliberately renders every pending
 * request (`unlinked.map(...)`, and its own comment says "this surface is a
 * LIST"), so twenty stacked cards is an intended state. With one card, "focus on
 * mount" looks correct. With several, React's top-down effect order puts focus on
 * the bottom one.
 *
 * ## What it does NOT prove
 *
 * It is not a native IME test. The events are synthetic, so it says nothing about
 * real input methods on any engine -- that needs a human on a machine with an IME,
 * and Safari is the engine that matters most.
 *
 * Mirrors `ThemeLab`: top-level, no session, no `/api` traffic, excluded from
 * production builds by `import.meta.env.DEV` at the route.
 */

/**
 * Identifies a pending request. Order in the list is the order on screen.
 *
 * Starts at 2 because "r1" is the seeded card below. Starting at 1 handed out a
 * SECOND "r1", and duplicate keys broke React's reconciliation so the drain
 * behaved as if the same card were being approved over and over.
 */
let nextCardId = 2;

export function KeyboardLab() {
  // Ids, in DOM order. The FIRST is the topmost, which is the one that owns the
  // keyboard and the one Enter drains from.
  const [pending, setPending] = useState<string[]>(() => ["r1"]);
  const [log, setLog] = useState<string[]>([]);

  // Subscribes to the real focus registry the composer listens to, so a driver
  // can confirm the cards drive it. Nothing is exposed on `window`; this is the
  // same hook the composer uses.
  const keyboardClaimed = useKeyboardClaimed();

  const note = (entry: string) => setLog((prev) => [entry, ...prev]);

  const settle = (id: string, decision: string) => {
    note(`${decision} ${id}`);
    setPending((prev) => prev.filter((entry) => entry !== id));
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-8">
      <header>
        <h1 className="text-lg font-medium">Keyboard lab</h1>
        <p className="text-muted-foreground text-sm">
          Real ApprovalActions in the real ApprovalCard. Focus goes to the{" "}
          <b>topmost</b> pending request. Enter approves, Escape denies, Tab walks
          the buttons. Deciding a card removes it, so you can watch the keyboard
          hand on to the next one.
        </p>
      </header>

      {/* The stand-in composer. `name="input"` is exactly what
          `ComposerPrimitiveInput` sets on the textarea it renders, so
          `focusComposerInput()` finding this proves the selector matches the
          real composer -- see lib/focus.ts. */}
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">
          Stand-in composer (the element focus is restored to)
        </span>
        <textarea
          name="input"
          rows={2}
          className="w-full rounded-md border p-2"
          placeholder="Send a message…"
        />
      </label>

      <section>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="rounded-md border px-3 py-1.5 text-sm"
            onClick={() => setPending((prev) => [...prev, `r${nextCardId++}`])}
          >
            Add pending request
          </button>
          <button
            type="button"
            className="rounded-md border px-3 py-1.5 text-sm"
            onClick={() => setPending([])}
          >
            Clear all
          </button>
          <button
            type="button"
            className="rounded-md border px-3 py-1.5 text-sm"
            onClick={() => {
              setPending(["r1"]);
              setLog([]);
            }}
          >
            Reset to one
          </button>
          <span className="text-muted-foreground text-sm" data-lab="pending">
            {pending.length} pending
          </span>
        </div>
      </section>

      {pending.length === 0 ? (
        <p className="text-muted-foreground text-sm" data-lab="empty">
          Nothing pending.
        </p>
      ) : (
        <section className="flex flex-col gap-2">
          {pending.map((id) => (
            <div key={id} data-lab="card" data-lab-id={id}>
              <ApprovalCard
                title={`Permission required (${id})`}
                description={`edit · src/routes/${id}.ts`}
              >
                <ApprovalActions
                  approveLabel="Approve once"
                  denyLabel="Deny"
                  approveAria={`Approve once: ${id}`}
                  denyAria={`Deny: ${id}`}
                  onApprove={() => settle(id, "APPROVE")}
                  onDeny={() => settle(id, "DENY")}
                />
              </ApprovalCard>
            </div>
          ))}
        </section>
      )}

      <section>
        <h2 className="mb-2 font-medium">Callbacks</h2>
        <p data-lab="count">{log.length}</p>
        <ul className="font-mono text-sm">
          {log.map((entry, index) => (
            <li key={`${entry}-${index}`}>{entry}</li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="mb-2 font-medium">Keyboard claim</h2>
        {/* The composer disables its own focus-on-scroll and focus-on-run-start
            while this reads "yes". */}
        <p data-lab="claimed">{keyboardClaimed ? "yes" : "no"}</p>
      </section>
    </div>
  );
}
