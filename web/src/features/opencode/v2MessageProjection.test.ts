import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionMessageInfo } from "@opencode/client";
import { createInitialV2ThreadState } from "./v2Events";
import { projectV2History } from "./v2History";
import { deriveV2ToolCallId } from "./v2Permissions";
import { projectV2RepositoryItems } from "./v2MessageProjection";
import { openCodePatchFromParts } from "@/tools/opencode/adapt";
import { OpenCodeEditView, openCodePendingPatchFor } from "@/tools/opencode/ui";

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
          parts: [{
            kind: "tool" as const,
            id: `tool:${MESSAGE_ID}:${TOOL_ID}`,
            order: 0,
            name: "shell",
            input: { command: "bun --version" },
            output: null,
            status: "running" as const,
            permissionId: null,
          }],
          source: null,
        },
      },
      messageOrder: [MESSAGE_ID],
      permissions: [{
        id: PERMISSION_ID,
        sessionID: SESSION_ID,
        action: "shell",
        resources: ["bun --version"],
        save: [],
        source: { type: "tool" as const, messageID: MESSAGE_ID, id: TOOL_ID },
      }],
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
      content: [{
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
      }],
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
          parts: [{
            kind: "tool" as const,
            id: `tool:${MESSAGE_ID}:${TOOL_ID}`,
            order: 0,
            name: "edit",
            input: { filePath: "a.ts" },
            output: [{ type: "text", text: "done" }],
            status: "complete" as const,
            permissionId: null,
          }],
          source,
        },
      },
      messageOrder: [MESSAGE_ID],
    };

    const [item] = projectV2RepositoryItems(state);
    expect(item?.message.metadata?.custom).toEqual({
      opencode: { parts: source.content },
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
          parts: [{
            kind: "tool" as const,
            id: `tool:${MESSAGE_ID}:${TOOL_ID}`,
            order: 0,
            name: "edit",
            input: { filePath: "a.ts" },
            output: [{ type: "text", text: "done" }],
            metadata: { files: [{ file: "a.ts", patch: "PATCH" }] },
            status: "complete" as const,
            permissionId: null,
          }],
          source: null,
        },
      },
      messageOrder: [MESSAGE_ID],
    };

    const [item] = projectV2RepositoryItems(state);
    expect(item?.message.metadata?.custom).toEqual({
      opencode: {
        parts: [{
          type: "tool",
          id: TOOL_ID,
          name: "edit",
          state: {
            status: "completed",
            input: { filePath: "a.ts" },
            content: [{ type: "text", text: "done" }],
            metadata: { files: [{ file: "a.ts", patch: "PATCH" }] },
          },
        }],
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
          parts: [{
            kind: "tool" as const,
            id: `tool:${MESSAGE_ID}:${TOOL_ID}`,
            order: 0,
            name: "shell",
            input: { command: "bun --version" },
            output: null,
            status: "running" as const,
            permissionId: null,
          }],
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
      content: [{
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
      }],
    };

    // Reload: snapshot -> normalized state -> assistant-ui repository item.
    const history = projectV2History({ messages: [reloaded], pages: 1 }, []);
    const state = {
      ...createInitialV2ThreadState(SESSION_ID),
      messages: Object.fromEntries(history.messages.map((message) => [message.id, message])),
      messageOrder: history.messageOrder,
    };
    const [item] = projectV2RepositoryItems(state);

    // The renderer reads the untouched parts off message metadata, exactly as
    // `useOpenCodeEditPatch` does.
    const custom = item?.message.metadata?.custom as
      | { opencode?: { parts?: unknown } }
      | undefined;
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
              permissionId: null,
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
        parts: [{
          kind: "tool" as const,
          id: `tool:${MESSAGE_ID}:${TOOL_ID}`,
          order: 0,
          name: "edit",
          input: { filePath: "a.ts" },
          output: undefined,
          status: "running" as const,
          permissionId: null,
        }],
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
    return (item?.message.metadata?.custom as {
      opencode?: { pendingPatches?: Record<string, string> };
    } | undefined)?.opencode?.pendingPatches;
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
        { id: PERMISSION_ID, sessionID: SESSION_ID, action: "bash", resources: ["x"], save: [], source: { type: "tool" as const, messageID: MESSAGE_ID, id: TOOL_ID } },
      ]) as never,
    );
    expect(item?.message.metadata?.custom).toEqual({ opencode: { parts: expect.anything() } });
    expect(
      (item?.message.metadata?.custom as { opencode?: { pendingPatches?: unknown } }).opencode?.pendingPatches,
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
        parts: [{
          kind: "tool" as const,
          id: `tool:${MESSAGE_ID}:${TOOL_ID}`,
          order: 0,
          name: "edit",
          input: { filePath: "a.ts" },
          output: undefined,
          status: "running" as const,
          permissionId: null,
        }],
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