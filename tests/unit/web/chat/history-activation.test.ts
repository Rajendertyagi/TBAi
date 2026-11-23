/**
 * Activation-generation signal for Direct history recovery (K-I5 root-cause fix).
 *
 * A new user visit is an ACTIVATION of a conversation, not a React mount:
 * Dockview keeps a conversation's host mounted while hidden. These tests pin the
 * per-conversation generation store that the recovery bridge consumes.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  activateHistoryConversation,
  beginHistoryActivation,
  getHistoryActivationGeneration,
  isHistoryConversationActive,
} from "@web/features/chat/history/useDirectHistoryWindow";

describe("history activation generation", () => {
  beforeEach(() => {
    // Reset module state via the coordinated reset used by the existing suite.
    // (clearAllWindowControllers bumps the visit generation; activation state is
    // keyed by conversation and tested with unique ids per case below.)
  });

  it("a genuine activation creates exactly one new visit", () => {
    const id = `act-1-${Date.now()}`;
    activateHistoryConversation(id);
    expect(getHistoryActivationGeneration(id)).toBe(1);
    expect(beginHistoryActivation(id)).toBe(true);
    expect(beginHistoryActivation(id)).toBe(false); // consumed once
  });

  it("repeated activation of the active conversation does not manufacture visits", () => {
    const id = `act-2-${Date.now()}`;
    activateHistoryConversation(id);
    beginHistoryActivation(id); // consume initial
    activateHistoryConversation(id); // same id -> no-op
    activateHistoryConversation(id);
    expect(getHistoryActivationGeneration(id)).toBe(1);
    expect(beginHistoryActivation(id)).toBe(false);
  });

  it("per-conversation generations are independent", () => {
    const a = `act-3a-${Date.now()}`;
    const b = `act-3b-${Date.now()}`;
    activateHistoryConversation(a);
    activateHistoryConversation(b);
    expect(getHistoryActivationGeneration(a)).toBe(1);
    expect(getHistoryActivationGeneration(b)).toBe(1);
    // Re-activating A must not reset B's budget/generation.
    activateHistoryConversation(a);
    expect(getHistoryActivationGeneration(a)).toBe(2);
    expect(getHistoryActivationGeneration(b)).toBe(1);
  });

  it("activation is not visibility: only the activated conversation is active", () => {
    const a = `act-4a-${Date.now()}`;
    const b = `act-4b-${Date.now()}`;
    activateHistoryConversation(a);
    expect(isHistoryConversationActive(a)).toBe(true);
    expect(isHistoryConversationActive(b)).toBe(false); // visible split panel, not active
    activateHistoryConversation(b);
    expect(isHistoryConversationActive(a)).toBe(false);
    expect(isHistoryConversationActive(b)).toBe(true);
  });

  it("returning to a conversation creates a fresh recovery opportunity", () => {
    const id = `act-5-${Date.now()}`;
    activateHistoryConversation(id);
    expect(beginHistoryActivation(id)).toBe(true); // first visit
    activateHistoryConversation(`other-${Date.now()}`); // switch away
    activateHistoryConversation(id); // return
    expect(getHistoryActivationGeneration(id)).toBe(2);
    expect(beginHistoryActivation(id)).toBe(true); // fresh opportunity
  });
});
