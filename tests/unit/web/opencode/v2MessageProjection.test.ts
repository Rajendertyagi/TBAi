import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionMessageInfo } from "@opencode/client";
import { createInitialV2ThreadState } from "@web/features/opencode/v2Events.ts";
import type { V2MessageState } from "@web/features/opencode/v2Types.ts";
import { projectV2History } from "@web/features/opencode/v2History.ts";
import { deriveV2ToolCallId } from "@web/features/opencode/v2Permissions.ts";
import { projectV2RepositoryItems } from "@web/features/opencode/v2MessageProjection.ts";
import { openCodePatchFromParts } from "@web/tools/opencode/adapt";
import { OpenCodeEditView, openCodePendingPatchFor } from "@web/tools/opencode/ui";

const SESSION_ID = "ses_live_projection_test";
const MESSAGE_ID = "msg_live_projection_test";
const TOOL_ID = "call_live_projection_test";
const PERMISSION_ID = "permission_live_projection_test";

describe("native V2 live tool projection", () => {
  it("matches a live tool event to its permission without history source metadata", () => {
    const initial = createInitialV2ThreadState(SESSION_ID);
    const state = {
      ...initial,
      messages: {
        [MESSAGE_ID]: {
          id: MESSAGE_ID,
          parentId: null,
          role: "assistant" as const,
          createdAt: 1,
          parts: [
            {
              kind: "tool" as const,
              id: `tool:${MESSAGE_ID}:${TOOL_ID}`,
              order: 0,
              name: "shell",
              input: { command: "bun --version" },
              output: null,
              status: "running" as const,
            },
          ],
          source: null,
        },
      },
      messageOrder: [MESSAGE_ID],
      permissions: [
        {
          id: PERMISSION_ID,
          sessionID: SESSION_ID,
          action: "shell",
          resources: ["bun --version"],
          save: [],
          source: { type: "tool" as const, messageID: MESSAGE_ID, id: TOOL_ID },
        },
      ],
    };

    const [item] = projectV2RepositoryItems(state);
    const part = item?.message.content[0];
    expect(part).toMatchObject({
      type: "tool-call",
      approval: { id: PERMISSION_ID },
    });
  });

  it("preserves assistant tool metadata for the V2 edit diff renderer", () => {
    const source: SessionMessageInfo = {
      id: MESSAGE_ID,
      type: "assistant",
      agent: "build",
      model: { id: "test-model", providerID: "test-provider" },
      time: { created: 1 },
      content: [
        {
          type: "tool",
          id: TOOL_ID,
          name: "edit",
          time: { created: 1, ran: 1 },
          state: {
            status: "completed",
            input: { filePath: "a.ts" },
            content: [{ type: "text", text: "done" }],
            metadata: { files: [{ file: "a.ts", patch: "PATCH" }] },
          },
        },
      ],
    };
    const initial = createInitialV2ThreadState(SESSION_ID);
    const state = {
      ...initial,
      messages: {
        [MESSAGE_ID]: {
          id: MESSAGE_ID,
          parentId: null,
          role: "assistant" as const,
          createdAt: 1,
          parts: [
            {
              kind: "tool" as const,
              id: `tool:${MESSAGE_ID}:${TOOL_ID}`,
              order: 0,
              name: "edit",
              input: { filePath: "a.ts" },
              output: [{ type: "text", text: "done" }],
              status: "complete" as const,
            },
          ],
          source,
        },
      },
      messageOrder: [MESSAGE_ID],
    };

    const [item] = projectV2RepositoryItems(state);
    expect(item?.message.metadata?.custom).toEqual({
      turnStartedAt: 1,
      agent: "build",
      providerId: "test-provider",
      modelId: "test-model",
      opencode: { parts: source.content },
    });
  });

  it("projects the turn record the footer renders from the assistant record", () => {
    const source: SessionMessageInfo = {
      id: MESSAGE_ID,
      type: "assistant",
      agent: "build",
      model: { id: "test-model", providerID: "test-provider" },
      time: { created: 1_000, completed: 91_000 },
      tokens: { input: 3000, output: 660, reasoning: 0, cache: { read: 0, write: 0 } },
      content: [{ type: "text", text: "done" }],
    };
    const initial = createInitialV2ThreadState(SESSION_ID);
    const state = {
      ...initial,
      messages: {
        [MESSAGE_ID]: {
          id: MESSAGE_ID,
          parentId: null,
          role: "assistant" as const,
          createdAt: 1_000,
          parts: [
            {
              kind: "text" as const,
              id: `text:${MESSAGE_ID}:0`,
              order: 0,
              value: "done",
              status: "complete" as const,
            },
          ],
          source,
        },
      },
      messageOrder: [MESSAGE_ID],
    };

    const [item] = projectV2RepositoryItems(state);
    // Reloading re-runs this projection over the same record, so the duration
    // and the token count are reproduced rather than inferred from a clock.
    expect(item?.message.metadata?.custom).toMatchObject({
      turnStartedAt: 1_000,
      turnTiming: { startedAt: 1_000, endedAt: 91_000, durationMs: 90_000 },
      usage: { inputTokens: 3000, outputTokens: 660, totalTokens: 3660 },
      agent: "build",
      providerId: "test-provider",
      modelId: "test-model",
    });
  });

  it("preserves live tool metadata for the edit diff renderer", () => {
    const initial = createInitialV2ThreadState(SESSION_ID);
    const state = {
      ...initial,
      messages: {
        [MESSAGE_ID]: {
          id: MESSAGE_ID,
          parentId: null,
          role: "assistant" as const,
          createdAt: 1,
          parts: [
            {
              kind: "tool" as const,
              id: `tool:${MESSAGE_ID}:${TOOL_ID}`,
              order: 0,
              name: "edit",
              input: { filePath: "a.ts" },
              output: [{ type: "text", text: "done" }],
              metadata: { files: [{ file: "a.ts", patch: "PATCH" }] },
              status: "complete" as const,
            },
          ],
          source: null,
        },
      },
      messageOrder: [MESSAGE_ID],
    };

    const [item] = projectV2RepositoryItems(state);
    expect(item?.message.metadata?.custom).toEqual({
      opencode: {
        parts: [
          {
            type: "tool",
            id: TOOL_ID,
            name: "edit",
            state: {
              status: "completed",
              input: { filePath: "a.ts" },
              content: [{ type: "text", text: "done" }],
              metadata: { files: [{ file: "a.ts", patch: "PATCH" }] },
            },
          },
        ],
      },
    });
  });

  it("keeps a running V2 tool pending instead of projecting a defined null result", () => {
    const initial = createInitialV2ThreadState(SESSION_ID);
    const state = {
      ...initial,
      messages: {
        [MESSAGE_ID]: {
          id: MESSAGE_ID,
          parentId: null,
          role: "assistant" as const,
          createdAt: 1,
          parts: [
            {
              kind: "tool" as const,
              id: `tool:${MESSAGE_ID}:${TOOL_ID}`,
              order: 0,
              name: "shell",
              input: { command: "bun --version" },
              output: null,
              status: "running" as const,
            },
          ],
          source: null,
        },
      },
      messageOrder: [MESSAGE_ID],
    };

    const [item] = projectV2RepositoryItems(state);
    expect(item?.message.content[0]).toMatchObject({
      type: "tool-call",
      result: undefined,
    });
  });
});

/**
 * The reload path for `edit`, composed end to end.
 *
 * A reload does not replay `session.tool.*` events — it re-reads history and
 * rebuilds state from the snapshot. That makes it the ONLY path that carries an
 * edit's diff, because the patch lives in `state.metadata.files[].patch` and
 * never in the result, and the normalized tool part is rebuilt from scratch.
 *
 * Each link below is already proven alone:
 *   - `v2History.test.ts`     history keeps `state.metadata` on the tool part
 *   - `v2MessageProjection.test.ts` above  the raw parts reach the message
 *   - `ui.test.ts`            a given patch renders as a diff
 *
 * What no test covered is the seam BETWEEN them: the reload-built repository
 * item must hand the renderer a `toolCallId` that `openCodePatchFromParts` can
 * resolve back to its own part. The two sides derive that id independently
 * (`deriveV2ToolCallId` here, suffix-decoding there), so a change to either
 * would silently drop every diff back to the raw completion text — with all
 * three unit tests still green. This test is the seam.
 */
const RELOAD_PATCH =
  "Index: src/a.ts\n" +
  "===================================================================\n" +
  "--- src/a.ts\n" +
  "+++ src/a.ts\n" +
  "@@ -1,2 +1,3 @@\n" +
  ' - "old"\n' +
  '+- "ADDED_BY_RELOAD"\n';

describe("native V2 edit metadata through a reload", () => {
  it("carries a reloaded edit's patch from history to the rendered diff", () => {
    // What the server sends back on reload: a completed `edit` whose patch is
    // only in `state.metadata`.
    const reloaded: SessionMessageInfo = {
      id: MESSAGE_ID,
      type: "assistant",
      agent: "build",
      model: { id: "test-model", providerID: "test-provider" },
      time: { created: 1 },
      content: [
        {
          type: "tool",
          id: TOOL_ID,
          name: "edit",
          time: { created: 1, ran: 1 },
          state: {
            status: "completed",
            input: { filePath: "src/a.ts" },
            content: [{ type: "text", text: "Edit applied successfully." }],
            metadata: { files: [{ file: "src/a.ts", patch: RELOAD_PATCH }] },
          },
        },
      ],
    };

    // Reload: snapshot -> normalized state -> assistant-ui repository item.
    const history = projectV2History({ messages: [reloaded], pages: 1 });
    const state = {
      ...createInitialV2ThreadState(SESSION_ID),
      messages: Object.fromEntries(history.messages.map((message) => [message.id, message])),
      messageOrder: history.messageOrder,
    };
    const [item] = projectV2RepositoryItems(state);

    // The renderer reads the untouched parts off message metadata, exactly as
    // `useOpenCodeEditPatch` does.
    const custom = item?.message.metadata?.custom as { opencode?: { parts?: unknown } } | undefined;
    const rawParts = custom?.opencode?.parts;

    const toolCall = item?.message.content[0];
    expect(toolCall).toMatchObject({ type: "tool-call", toolName: "edit" });
    const toolCallId = (toolCall as { toolCallId: string }).toolCallId;

    // The seam: the id this projection invented must resolve to the patch.
    const patch = openCodePatchFromParts(rawParts, toolCallId);
    expect(patch).toBe(RELOAD_PATCH);

    // And the recovered patch must be what the user actually sees.
    const html = renderToStaticMarkup(
      createElement(OpenCodeEditView, {
        type: "tool-call",
        toolCallId,
        toolName: "edit",
        args: { filePath: "src/a.ts" },
        argsText: JSON.stringify({ filePath: "src/a.ts" }),
        result: { content: [{ type: "text", text: "Edit applied successfully." }] },
        status: { type: "complete" },
        diffPatch: patch,
        // Required by the assistant-ui tool-part contract. The completed+diff
        // branch is hook-free and calls none of them.
        addResult: () => {},
        resume: () => {},
        respondToApproval: async () => {},
      }),
    );
    expect(html).toContain("ADDED_BY_RELOAD");
    expect(html).not.toContain("Edit applied successfully.");
  });
});

/**
 * The last link in the chain: the projected `timing` must actually reach the
 * assistant-ui tool-call part, because that is the object
 * `useToolCallElapsed` reads. A timing that stopped at `V2MessagePartState`
 * would look correct in every projection test and render nothing in the app.
 */
describe("tool timing reaches the assistant-ui part", () => {
  function projected(timing: { startedAt: number; completedAt?: number } | undefined) {
    const initial = createInitialV2ThreadState(SESSION_ID);
    const withMessage = {
      ...initial,
      messages: {
        [MESSAGE_ID]: {
          id: MESSAGE_ID,
          parentId: null,
          role: "assistant" as const,
          createdAt: 1,
          parts: [
            {
              kind: "tool" as const,
              id: `tool:${MESSAGE_ID}:${TOOL_ID}`,
              order: 0,
              name: "shell",
              input: { command: "bun --version" },
              output: "ok",
              status: "complete" as const,
              ...(timing === undefined ? {} : { timing }),
            },
          ],
          source: null,
        },
      },
      messageOrder: [MESSAGE_ID],
      permissions: [],
    };
    return projectV2RepositoryItems(withMessage)[0]?.message.content[0];
  }

  it("forwards a completed call's timing onto the tool-call part", () => {
    expect(projected({ startedAt: 1000, completedAt: 2600 })).toMatchObject({
      type: "tool-call",
      timing: { startedAt: 1000, completedAt: 2600 },
    });
  });

  it("forwards an in-flight call with no completion, which is what makes it tick", () => {
    const part = projected({ startedAt: 1000 }) as { timing?: { completedAt?: number } };
    expect(part.timing?.completedAt).toBeUndefined();
  });

  it("omits the key entirely when there is no timing, rather than sending undefined", () => {
    // An explicit `timing: undefined` is not the same as an absent key to a
    // consumer that checks `'timing' in part`.
    const part = projected(undefined);
    expect(part).toBeTypeOf("object");
    expect(Object.hasOwn(part as object, "timing")).toBe(false);
  });
});

/**
 * The pending-change preview reaches the message metadata the renderer reads.
 *
 * The renderer has no access to the runtime's permission state - it reads
 * `metadata.custom.opencode`, the same place the completed-patch renderer reads
 * `parts` from. So this is the seam: if the patch is dropped here, the gate
 * silently falls back to the find/replace pair and every test on the view still
 * passes.
 */
describe("pending-change preview in the projected message metadata", () => {
  const PATCH = "--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n-old\n+new\n";

  const stateWith = (permissions: unknown[]) => ({
    ...createInitialV2ThreadState(SESSION_ID),
    messages: {
      [MESSAGE_ID]: {
        id: MESSAGE_ID,
        parentId: null,
        role: "assistant" as const,
        createdAt: 1,
        parts: [
          {
            kind: "tool" as const,
            id: `tool:${MESSAGE_ID}:${TOOL_ID}`,
            order: 0,
            name: "edit",
            input: { filePath: "a.ts" },
            output: undefined,
            status: "running" as const,
          },
        ],
        source: null,
      },
    },
    messageOrder: [MESSAGE_ID],
    permissions,
  });

  const editPermission = (metadata: Record<string, unknown>) => ({
    id: PERMISSION_ID,
    sessionID: SESSION_ID,
    action: "edit",
    resources: ["a.ts"],
    save: [],
    source: { type: "tool" as const, messageID: MESSAGE_ID, id: TOOL_ID },
    metadata,
  });

  const pendingPatchesOf = (state: ReturnType<typeof stateWith>) => {
    const [item] = projectV2RepositoryItems(state as never);
    return (
      item?.message.metadata?.custom as
        | {
            opencode?: { pendingPatches?: Record<string, string> };
          }
        | undefined
    )?.opencode?.pendingPatches;
  };

  it("keys the patch by the tool call the permission belongs to", () => {
    const patches = pendingPatchesOf(
      stateWith([editPermission({ files: [{ file: "a.ts", patch: PATCH }] })]),
    );
    expect(patches).toEqual({ [deriveV2ToolCallId(MESSAGE_ID, TOOL_ID)]: PATCH });
  });

  it("omits the key entirely when no permission carries a patch", () => {
    const [item] = projectV2RepositoryItems(
      stateWith([
        {
          id: PERMISSION_ID,
          sessionID: SESSION_ID,
          action: "bash",
          resources: ["x"],
          save: [],
          source: { type: "tool" as const, messageID: MESSAGE_ID, id: TOOL_ID },
        },
      ]) as never,
    );
    expect(item?.message.metadata?.custom).toEqual({ opencode: { parts: expect.anything() } });
    expect(
      (item?.message.metadata?.custom as { opencode?: { pendingPatches?: unknown } } | undefined)
        ?.opencode?.pendingPatches,
    ).toBeUndefined();
  });

  it("skips a permission whose patch cannot be tied to a tool call", () => {
    // `toolCallId` is null when the request is not bound to a tool, so there is
    // nothing to key the preview on and nothing should be written.
    const patches = pendingPatchesOf(
      stateWith([
        { ...editPermission({ files: [{ file: "a.ts", patch: PATCH }] }), source: undefined },
      ]),
    );
    expect(patches).toBeUndefined();
  });

  it("skips a multi-file request rather than previewing only some of it", () => {
    // Showing one file of a two-file change would read as "this is all that will
    // change", which is the one thing a gate must never imply.
    const patches = pendingPatchesOf(
      stateWith([
        editPermission({
          files: [
            { file: "a.ts", patch: PATCH },
            { file: "b.ts", patch: PATCH },
          ],
        }),
      ]),
    );
    expect(patches).toBeUndefined();
  });
});
/**
 * The projected metadata and the gate's reader agree on the key.
 *
 * This is the one test that closes the whole seam: it runs the real projection,
 * takes the metadata it actually produced, and hands it to the reader the gate
 * actually calls. A test that hand-wrote the metadata key would agree with the
 * reader whatever key the projection chose, so the failure it is here to catch -
 * two files disagreeing, with every other test green - would slip through.
 *
 * That is the same shape as the code-fence bug, where the budget was wired to a
 * slot nobody read and nothing failed until a browser looked at it.
 */
describe("the gate reads what the projection wrote", () => {
  const PATCH = "--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n-old\n+new\n";

  const stateWith = (permissions: unknown[]) => ({
    ...createInitialV2ThreadState(SESSION_ID),
    messages: {
      [MESSAGE_ID]: {
        id: MESSAGE_ID,
        parentId: null,
        role: "assistant" as const,
        createdAt: 1,
        parts: [
          {
            kind: "tool" as const,
            id: `tool:${MESSAGE_ID}:${TOOL_ID}`,
            order: 0,
            name: "edit",
            input: { filePath: "a.ts" },
            output: undefined,
            status: "running" as const,
          },
        ],
        source: null,
      },
    },
    messageOrder: [MESSAGE_ID],
    permissions,
  });

  const editPermission = (metadata: Record<string, unknown>) => ({
    id: PERMISSION_ID,
    sessionID: SESSION_ID,
    action: "edit",
    resources: ["a.ts"],
    save: [],
    source: { type: "tool" as const, messageID: MESSAGE_ID, id: TOOL_ID },
    metadata,
  });

  const readBack = (permissions: unknown[]) => {
    const [item] = projectV2RepositoryItems(stateWith(permissions) as never);
    return openCodePendingPatchFor(
      item?.message.metadata?.custom,
      deriveV2ToolCallId(MESSAGE_ID, TOOL_ID),
    );
  };

  it("hands the gate the patch, end to end", () => {
    expect(readBack([editPermission({ files: [{ file: "a.ts", patch: PATCH }] })])).toBe(PATCH);
  });

  it("hands the gate nothing when the permission carries no patch", () => {
    expect(readBack([{ ...editPermission({}), metadata: undefined }])).toBeNull();
  });
});

/**
 * The execution error's detail stays on the MESSAGE.
 *
 * S3 removes turn status from the connection heart. The detail it used to show
 * in a popover must not be removed with it: `projectV2RepositoryItems` already
 * attaches the failure to the assistant message's `status`, and that message is
 * what the transcript renders. This case pins the DATA half of that contract.
 *
 * The PRESENTATION half is currently blocked and tracked separately: the row
 * selector (`createThreadRowsSelector`, core 0.3.30) emits only part rows for
 * assistant messages, so `ChatWindow`'s `AssistantMessage` - which owns the
 * `AssistantError` bubble - is never mounted for them. See the S3 report.
 */
describe("an execution error is carried on the assistant message", () => {
  const USER_ID = "msg_exec_error_user";
  const ASSISTANT_ID = "msg_exec_error_assistant";
  const DETAIL = "Free usage limit reached. Please connect a provider.";

  function errorState() {
    const initial = createInitialV2ThreadState(SESSION_ID);
    return {
      ...initial,
      messages: {
        [USER_ID]: {
          id: USER_ID,
          parentId: null,
          role: "user" as const,
          createdAt: 1,
          parts: [
            {
              kind: "text" as const,
              id: `text:${USER_ID}:0`,
              order: 0,
              value: "hi",
              status: "complete" as const,
            },
          ],
          source: null,
        },
        [ASSISTANT_ID]: {
          id: ASSISTANT_ID,
          parentId: USER_ID,
          role: "assistant" as const,
          createdAt: 2,
          parts: [
            {
              kind: "text" as const,
              id: `text:${ASSISTANT_ID}:0`,
              order: 0,
              value: "I could not complete the request.",
              status: "complete" as const,
            },
          ],
          source: null,
        },
      },
      messageOrder: [USER_ID, ASSISTANT_ID],
      execution: {
        type: "error" as const,
        userMessageId: USER_ID,
        assistantMessageId: ASSISTANT_ID,
        error: { kind: "server" as const, message: DETAIL },
      },
    };
  }

  it("attaches the formatted failure to the named assistant message", () => {
    const items = projectV2RepositoryItems(errorState());
    const assistant = items.find((item) => item.message.id === ASSISTANT_ID);
    const status = assistant?.message.status;

    expect(status).toMatchObject({
      type: "incomplete",
      reason: "error",
    });
    // The reader's detail survives the formatting rather than being replaced by
    // a generic "an error occurred".
    const detail = status && "error" in status ? String(status.error) : "";
    expect(detail).toContain(DETAIL);
  });
});

describe("retry and step parts never become visible content", () => {
  const USER_ID = "msg_internal_user";
  const ASSISTANT_ID = "msg_internal_assistant";
  const DETAIL = "Free usage limit reached. Please connect a provider.";

  /**
   * A user prompt plus one assistant message carrying exactly these parts.
   *
   * The parts are contextually typed by the state's own union, so a fixture
   * cannot drift into a shape the reducer could never produce.
   */
  function stateWith(parts: V2MessageState["parts"]) {
    const initial = createInitialV2ThreadState(SESSION_ID);
    return {
      ...initial,
      messages: {
        [USER_ID]: {
          id: USER_ID,
          parentId: null,
          role: "user" as const,
          createdAt: 1,
          parts: [
            {
              kind: "text" as const,
              id: `text:${USER_ID}:0`,
              order: 0,
              value: "fix the build",
              status: "complete" as const,
            },
          ],
          source: null,
        },
        [ASSISTANT_ID]: {
          id: ASSISTANT_ID,
          parentId: USER_ID,
          role: "assistant" as const,
          createdAt: 2,
          parts,
          source: null,
        },
      },
      messageOrder: [USER_ID, ASSISTANT_ID],
    };
  }

  function assistantContent(state: ReturnType<typeof stateWith>) {
    const items = projectV2RepositoryItems(state);
    const assistant = items.find((item) => item.message.id === ASSISTANT_ID);
    expect(assistant).toBeDefined();
    // `ThreadMessageLike.content` also admits a plain string for simple text
    // messages; a projected assistant turn is always a part array, so state and
    // check that rather than casting the union away.
    const content = assistant!.message.content;
    if (!Array.isArray(content)) {
      throw new Error("projected assistant content must be an array of parts");
    }
    return content;
  }

  it("[text, retry] projects the text without an empty retry part", () => {
    const content = assistantContent(
      stateWith([
        {
          kind: "text",
          id: `text:${ASSISTANT_ID}:0`,
          order: 0,
          value: "Here is the fix.",
          status: "complete",
        },
        { kind: "retry", id: `retry:${ASSISTANT_ID}`, order: 1, value: "retry 3" },
      ]),
    );

    expect(content).toEqual([
      { type: "text", text: "Here is the fix.", status: { type: "complete" } },
    ]);
    // The internal attempt wording never reaches a renderer.
    expect(JSON.stringify(content)).not.toContain("retry 3");
    expect(content.some((part) => part.type === "text" && part.text === "")).toBe(false);
  });

  it("[retry, step] projects to empty content rather than a bubble", () => {
    const state = stateWith([
      { kind: "retry", id: `retry:${ASSISTANT_ID}`, order: 0, value: "retry 2" },
      { kind: "step", id: `step:${ASSISTANT_ID}:1`, order: 1, status: "started" },
    ]);

    expect(assistantContent(state)).toEqual([]);
    // The message itself still exists, in order: dropping the parts is not
    // dropping the turn (its status and its errors ride on the message).
    expect(projectV2RepositoryItems(state).map((item) => item.message.id)).toEqual([
      USER_ID,
      ASSISTANT_ID,
    ]);
  });

  it("keeps a typed execution error on a step-only assistant message", () => {
    const state = stateWith([
      { kind: "step", id: `step:${ASSISTANT_ID}:1`, order: 0, status: "error" },
    ]);
    const items = projectV2RepositoryItems({
      ...state,
      execution: {
        type: "error",
        userMessageId: USER_ID,
        assistantMessageId: ASSISTANT_ID,
        error: { kind: "server", message: DETAIL },
      },
    });
    const assistant = items.find((item) => item.message.id === ASSISTANT_ID);
    const status = assistant?.message.status;

    expect(assistant?.message.content).toEqual([]);
    expect(status).toMatchObject({ type: "incomplete", reason: "error" });
    const detail = status && "error" in status ? String(status.error) : "";
    expect(detail).toContain(DETAIL);
  });

  it("leaves ordinary text and reasoning parts unchanged", () => {
    const content = assistantContent(
      stateWith([
        {
          kind: "reasoning",
          id: `reasoning:${ASSISTANT_ID}:0`,
          order: 0,
          value: "planning",
          status: "complete",
        },
        {
          kind: "text",
          id: `text:${ASSISTANT_ID}:1`,
          order: 1,
          value: "Done.",
          status: "complete",
        },
      ]),
    );

    expect(content).toEqual([
      { type: "reasoning", text: "planning", status: { type: "complete" } },
      { type: "text", text: "Done.", status: { type: "complete" } },
    ]);
  });
});
