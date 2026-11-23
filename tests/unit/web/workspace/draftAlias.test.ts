/**
 * Draft-materialization alias state machine (audit M1/M4).
 *
 * The `chat:new` Dockview panel id is immutable, but first send changes the
 * canonical key to `chat:<id>`. These tests pin the alias that keeps the live
 * runtime mounted and, critically, that close/focus events are canonicalized
 * to the materialized conversation (not draft-local state).
 */
import { describe, it, expect } from "bun:test";
import { createDraftAlias, DRAFT_PANEL_ID } from "@web/features/workspace/draftAlias";

describe("draft alias — materialization", () => {
  it("maps the materialized key back to the stable chat:new panel id", () => {
    const alias = createDraftAlias();
    alias.observeActiveKey(DRAFT_PANEL_ID);
    alias.observeActiveKey("chat:mat-1");

    expect(alias.materializedKey).toBe("chat:mat-1");
    expect(alias.panelIdFor("chat:mat-1")).toBe(DRAFT_PANEL_ID);
    expect(alias.panelIdFor("chat:other")).toBe("chat:other");
    expect(alias.canonicalKeyFor(DRAFT_PANEL_ID)).toBe("chat:mat-1");
    expect(alias.canonicalKeyFor("chat:other")).toBe("chat:other");
  });

  it("is idempotent under StrictMode double-render", () => {
    const alias = createDraftAlias();
    alias.observeActiveKey(DRAFT_PANEL_ID);
    alias.observeActiveKey("chat:mat-1");
    alias.observeActiveKey("chat:mat-1"); // duplicate render with same key
    expect(alias.materializedKey).toBe("chat:mat-1");
  });

  it("does not alias a non-chat materialization (agent keys)", () => {
    const alias = createDraftAlias();
    alias.observeActiveKey(DRAFT_PANEL_ID);
    alias.observeActiveKey("agent:mat-1");
    expect(alias.materializedKey).toBeUndefined();
    expect(alias.canonicalKeyFor(DRAFT_PANEL_ID)).toBe(DRAFT_PANEL_ID);
  });
});

describe("draft alias — close canonicalization (audit M1)", () => {
  it("canonicalizes a close of the aliased panel to chat:<id>", () => {
    const alias = createDraftAlias();
    alias.observeActiveKey(DRAFT_PANEL_ID);
    alias.observeActiveKey("chat:mat-1");

    // The panel id is chat:new, but the close must target the conversation.
    expect(alias.canonicalKeyFor(DRAFT_PANEL_ID)).toBe("chat:mat-1");
  });

  it("clears the alias on genuine close so no stale key survives", () => {
    const alias = createDraftAlias();
    alias.observeActiveKey(DRAFT_PANEL_ID);
    alias.observeActiveKey("chat:mat-1");
    alias.clear();

    expect(alias.materializedKey).toBeUndefined();
    // A later close of chat:new is now draft-local, not the old conversation.
    expect(alias.canonicalKeyFor(DRAFT_PANEL_ID)).toBe(DRAFT_PANEL_ID);
  });

  it("supports a fresh draft after materialization (replacement)", () => {
    const alias = createDraftAlias();
    alias.observeActiveKey(DRAFT_PANEL_ID);
    alias.observeActiveKey("chat:mat-1");
    alias.clear(); // fresh draft replaces the materialized host
    alias.observeActiveKey(DRAFT_PANEL_ID);
    alias.observeActiveKey("chat:mat-2");

    expect(alias.materializedKey).toBe("chat:mat-2");
    expect(alias.canonicalKeyFor(DRAFT_PANEL_ID)).toBe("chat:mat-2");
  });
});
