/**
 * Detection tests for the manual `/compact` command.
 *
 * Scope is deliberately the PURE detection seam: `detectCompactCommand` and
 * `isCompactCommandText`. Compaction execution, the checkpoint and the assembly
 * seam are covered by the engine's own suites; re-testing them here would assert
 * against mocks and prove nothing.
 *
 * The property under test is that a command is recognised EXACTLY. Anything the
 * matcher is too eager to accept becomes a destructive silent interception — the
 * user's real request never reaches the model — so the negative cases carry more
 * weight than the positive ones.
 */

import { describe, expect, it } from "bun:test";
import type { UIMessage } from "ai";
import {
  COMPACT_COMMAND,
  COMPACT_COMMAND_ALIASES,
  COMPACT_COMMANDS,
  COMPACT_DIVIDER_PART_TYPE,
  buildDividerStoredContent,
  detectCompactCommand,
  isCompactCommandText,
  parseCompactCommand,
  type ManualCompactData,
} from "./direct-compact-command";

/** A user message with one text part, which is the only shape detection reads. */
function user(text: string): UIMessage {
  return { id: `u-${text}`, role: "user", parts: [{ type: "text", text }] };
}

/** A transcript whose LAST user message carries `text`. */
function conversationWith(text: string): UIMessage[] {
  return [
    user("first question"),
    { id: "a-1", role: "assistant", parts: [{ type: "text", text: "an answer" }] },
    user(text),
  ];
}

describe("COMPACT_COMMANDS", () => {
  it("lists the canonical spelling first", () => {
    // The canonical string is what the client sends and what logs record, so it
    // must remain element 0 no matter how many aliases are added.
    expect(COMPACT_COMMANDS[0]).toBe(COMPACT_COMMAND);
  });

  it("contains every alias exactly once", () => {
    for (const alias of COMPACT_COMMAND_ALIASES) {
      expect(COMPACT_COMMANDS.filter((command) => command === alias)).toHaveLength(1);
    }
  });

  it("declares no empty or duplicated entries", () => {
    // An empty entry would make `isCompactCommandText("")` true, which would
    // turn an empty submit into a compaction.
    for (const command of COMPACT_COMMANDS) {
      expect(command.length).toBeGreaterThan(0);
      expect(command.startsWith("/")).toBe(true);
    }
    expect(new Set(COMPACT_COMMANDS).size).toBe(COMPACT_COMMANDS.length);
  });
});

describe("isCompactCommandText", () => {
  it("accepts the canonical command and every alias", () => {
    for (const command of COMPACT_COMMANDS) {
      expect(isCompactCommandText(command)).toBe(true);
    }
  });

  it("rejects a longer slash-word sharing the prefix", () => {
    // Whole-token match, not prefix: `/compactx` must not be a command, or a typo
    // would silently destroy the conversation.
    expect(isCompactCommandText("/compactx")).toBe(false);
    expect(isCompactCommandText("/compressed")).toBe(false);
    expect(isCompactCommandText("/compressx")).toBe(false);
  });

  it("rejects the empty string", () => {
    expect(isCompactCommandText("")).toBe(false);
  });
});

describe("parseCompactCommand", () => {
  it("reads the bare command as no instructions at all", () => {
    expect(parseCompactCommand(COMPACT_COMMAND)).toEqual({
      command: COMPACT_COMMAND,
      instructions: undefined,
    });
  });

  it("reads trailing words as the user's instructions", () => {
    expect(parseCompactCommand(`${COMPACT_COMMAND} keep the API decisions`)).toEqual({
      command: COMPACT_COMMAND,
      instructions: "keep the API decisions",
    });
  });

  it("collapses inner whitespace, so a newline cannot smuggle a second line", () => {
    expect(parseCompactCommand(`${COMPACT_COMMAND}\n  focus   on  auth `)).toEqual({
      command: COMPACT_COMMAND,
      instructions: "focus on auth",
    });
  });

  it("treats an alias with instructions the same as the canonical one", () => {
    expect(parseCompactCommand("/compress keep the tests")).toEqual({
      command: "/compress",
      instructions: "keep the tests",
    });
  });

  it("reports the spelling the user typed, not the canonical one", () => {
    // Provenance: an alias-typed compaction is not silently recorded as `/compact`.
    expect(parseCompactCommand("/compress x")?.command).toBe("/compress");
  });

  it("returns undefined for ordinary text", () => {
    expect(parseCompactCommand("please run /compact")).toBeUndefined();
    expect(parseCompactCommand("")).toBeUndefined();
  });
});

describe("detectCompactCommand", () => {
  it("detects the canonical command in the last user message", () => {
    expect(detectCompactCommand(conversationWith(COMPACT_COMMAND))?.command).toBe(COMPACT_COMMAND);
  });

  it("detects an alias in the last user message", () => {
    for (const alias of COMPACT_COMMAND_ALIASES) {
      expect(detectCompactCommand(conversationWith(alias))?.command).toBe(alias);
    }
  });

  it("tolerates surrounding whitespace and carries trailing words through", () => {
    expect(detectCompactCommand(conversationWith(`  ${COMPACT_COMMAND}\n`))?.command).toBe(
      COMPACT_COMMAND,
    );
    expect(detectCompactCommand(conversationWith(`${COMPACT_COMMAND} now`))?.instructions).toBe(
      "now",
    );
  });

  it("ignores a command quoted inside the transcript, only the last user message counts", () => {
    const quoted: UIMessage[] = [
      user(COMPACT_COMMAND),
      { id: "a-1", role: "assistant", parts: [{ type: "text", text: "not a command" }] },
      user("carry on"),
    ];
    expect(detectCompactCommand(quoted)).toBeUndefined();
  });

  it("ignores a command carried by a non-user role", () => {
    // An assistant or system message never triggers the command, so a transcript
    // cannot smuggle one in.
    const assistant: UIMessage[] = [
      user("hello"),
      { id: "a-1", role: "assistant", parts: [{ type: "text", text: COMPACT_COMMAND }] },
    ];
    expect(detectCompactCommand(assistant)).toBeUndefined();
  });

  it("returns undefined when there is no user message at all", () => {
    expect(detectCompactCommand([])).toBeUndefined();
    expect(
      detectCompactCommand([
        { id: "a-1", role: "assistant", parts: [{ type: "text", text: "hi" }] },
      ]),
    ).toBeUndefined();
  });

  it("reads the last user message even when assistant turns follow it", () => {
    const messages: UIMessage[] = [
      user("a question"),
      user(COMPACT_COMMAND),
      { id: "a-1", role: "assistant", parts: [{ type: "text", text: "unfinished" }] },
    ];
    expect(detectCompactCommand(messages)?.command).toBe(COMPACT_COMMAND);
  });

  it("matches multi-part user messages by their joined text", () => {
    const split: UIMessage = {
      id: "u-split",
      role: "user",
      parts: [
        { type: "text", text: "/comp" },
        { type: "text", text: "act" },
      ],
    };
    expect(detectCompactCommand([split])?.command).toBe(COMPACT_COMMAND);
  });

  it("ignores non-text parts on the deciding message", () => {
    // A file attachment alongside the command text does not change the decision.
    const withAttachment: UIMessage = {
      id: "u-file",
      role: "user",
      parts: [
        { type: "text", text: COMPACT_COMMAND },
        { type: "file", mediaType: "text/plain", filename: "notes.txt", url: "blob:n" },
      ],
    };
    expect(detectCompactCommand([withAttachment])?.command).toBe(COMPACT_COMMAND);
  });
});
describe("the durable divider row", () => {
  const compacted: ManualCompactData = {
    kind: "tbai-compact",
    version: 1,
    outcome: "compacted",
    reason: "compacted",
    generation: 2,
    spanLength: 14,
    summaryTokens: 180,
    summary: "The user compared three storage engines and we settled on WAL plus a buffer pool.",
    reclaimedTokens: 4200,
    requestFits: true,
    operationId: "op-1",
    anchorMessageId: null,
    origin: "manual",
  };
  const rowId = "data-tbai-compact-op-1";

  function stored(data: ManualCompactData = compacted): {
    role: unknown;
    parts: Array<Record<string, unknown>>;
    metadata: unknown;
  } {
    return buildDividerStoredContent(rowId, data) as never;
  }

  it("uses the same envelope the runtime's own transport writes", () => {
    // `{ role, parts, metadata }`, NOT assistant-ui's internal `{ role, content }`.
    // Stored rows in this database use `parts`; the thread loader replays that
    // shape. Verified against real rows and a hard reload in the browser.
    const content = stored();
    expect(Object.keys(content).sort()).toEqual(["metadata", "parts", "role"]);
    expect(content.role).toBe("assistant");
    expect(content.metadata).toEqual({ custom: {} });
  });

  it("stores exactly one data part, in the wire part type", () => {
    const content = stored();
    expect(content.parts).toHaveLength(1);
    expect(content.parts[0]?.type).toBe(COMPACT_DIVIDER_PART_TYPE);
    // The wire type is `data-*`; `name` is assistant-ui's internal field and has no
    // place in a stored row.
    expect(content.parts[0]).not.toHaveProperty("name");
  });

  it("carries the outcome so a reload shows the same verdict", () => {
    const data = (stored().parts[0]?.data ?? {}) as Record<string, unknown>;
    expect(data.kind).toBe("tbai-compact");
    expect(data.outcome).toBe("compacted");
    expect(data.generation).toBe(2);
    expect(data.spanLength).toBe(14);
    expect(data.operationId).toBe("op-1");
  });

  it("stores a failure as a failure, with no generation claimed", () => {
    const content = stored({ ...compacted, outcome: "failed", generation: 0 });
    const data = (content.parts[0]?.data ?? {}) as Record<string, unknown>;
    expect(data.outcome).toBe("failed");
    expect(data.generation).toBe(0);
  });

  it("stores a skip as a skip, because 'already compact' is a real answer", () => {
    const content = stored({ ...compacted, outcome: "skipped", generation: 0, spanLength: 0 });
    const data = (content.parts[0]?.data ?? {}) as Record<string, unknown>;
    expect(data.outcome).toBe("skipped");
  });

  it("stores the summary WITH the divider, not looked up on click", () => {
    // The whole point of the feature: a compaction that removes history must be
    // readable. Embedding it at write time is what makes that durable.
    //
    // It cannot be fetched on click instead, because `conversation_compactions` is a
    // single rolling row keyed by `conversation_id` and holds only the LATEST
    // summary — an older divider would then display the newest summary against older
    // history. One row, one summary, no second read path.
    const data = (stored().parts[0]?.data ?? {}) as Record<string, unknown>;
    expect(data.summary).toBe(compacted.summary);
  });

  it("omits the summary entirely when there is none, keeping old rows byte-identical", () => {
    // OMITTED, not `null`: a payload with no summary must be byte-for-byte what the
    // pre-summary build wrote, so every row already in SQLite stays readable and no
    // migration is implied by this change.
    for (const outcome of ["skipped", "failed"] as const) {
      const data = (stored({ ...compacted, outcome, summary: null }).parts[0]?.data ??
        {}) as Record<string, unknown>;
      expect(data).not.toHaveProperty("summary");
    }
  });

  it("stores a summary for an automatic compaction too, not only a manual one", () => {
    // The engine removes history the user did not ask it to remove. If the user
    // cannot read that, they cannot consent to it.
    const data = (stored({ ...compacted, origin: "automatic" }).parts[0]?.data ??
      {}) as Record<string, unknown>;
    expect(data.origin).toBe("automatic");
    expect(data.summary).toBe(compacted.summary);
  });

  it("keeps the row id equal to the part id, so the two name one entry", () => {
    // The envelope id and the part id are the same string on purpose: the row id
    // is what a reload anchors on, and a second, different part id inside the same
    // row would be a second thing to reconcile.
    expect(stored().parts[0]?.id).toBe(rowId);
  });
});