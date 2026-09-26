import { describe, it, expect } from "bun:test";
import {
  InvalidToolApprovalSignatureError,
  streamText,
  stepCountIs,
  tool,
  type UIMessage,
} from "ai";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { z } from "zod";
import { prepareModelMessages } from "../../src/lib/model-messages";

/**
 * Server approval-gate lifecycle (mock V4 model — no provider key, no network).
 *
 * Exercises the REAL production history path:
 *   incoming UIMessages → prepareModelMessages (pruneStaleMessages +
 *   convertToModelMessages) → streamText/toolApproval → execution → result
 *
 * Proves the exact lifecycle the toolkit UI depends on:
 *   1. gate pauses: approval-request chunk, zero executions
 *   2. approve → response survives pruning → executes EXACTLY once →
 *      tool-output chunk → model continues
 *   3. deny → response survives pruning → zero executions → denial →
 *      model continues
 *
 * (This test previously mirrored the route without pruneStaleMessages — which
 * is exactly how the approval-deletion regression slipped through. It now goes
 * through the same prepareModelMessages the chat route uses.)
 */

const APPROVAL_SECRET = "direct-approval-lifecycle-test-secret";
const usage = {
  inputTokens: { total: 1, noCache: 1 },
  outputTokens: { total: 1, text: 1 },
};

function toolCallStream() {
  return convertArrayToReadableStream([
    { type: "stream-start", warnings: [] },
    {
      type: "tool-call",
      toolCallId: "call-1",
      toolName: "delete_file",
      input: JSON.stringify({ path: "victim.txt" }),
    },
    {
      type: "finish",
      finishReason: { unified: "tool-calls", raw: "tool-calls" },
      usage,
    },
  ] as any);
}

function textStream(text: string) {
  return convertArrayToReadableStream([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
  ] as any);
}

function deleteTool(executions: { count: number }) {
  return tool({
    description: "Delete a file (test double).",
    inputSchema: z.object({ path: z.string() }),
    execute: async () => {
      executions.count += 1;
      return { deleted: true };
    },
  });
}

async function runChat(model: any, uiMessages: UIMessage[], toolDef: any) {
  const tools = { delete_file: toolDef };
  return streamText({
    model,
    // Production history path (prune + convert) — identical to the chat route.
    messages: await prepareModelMessages(uiMessages, tools),
    tools,
    experimental_toolApprovalSecret: APPROVAL_SECRET,
    toolApproval: { delete_file: "user-approval" },
    stopWhen: stepCountIs(3),
  });
}

async function collect(result: Awaited<ReturnType<typeof runChat>>) {
  const approvals: any[] = [];
  const outputs: any[] = [];
  const texts: string[] = [];
  const errors: unknown[] = [];
  const reader = result
    .toUIMessageStream({
      onError(error) {
        errors.push(error);
        return "An error occurred.";
      },
    })
    .getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const c = value as any;
    if (c.type === "tool-approval-request") approvals.push(c);
    if (c.type === "tool-output-available" || c.type === "tool-output-error") outputs.push(c);
    if (c.type === "tool-output-denied") outputs.push({ ...c, denied: true });
    if (c.type === "text-delta") texts.push(c.delta ?? "");
  }
  return { approvals, outputs, texts, errors };
}

const userMsg = (text: string): UIMessage => ({
  id: "u1",
  role: "user",
  parts: [{ type: "text", text }],
});

type ApprovalRequest = {
  approvalId: string;
  signature?: string;
};

function decidedFollowUp(
  approvalRequest: ApprovalRequest,
  approved: boolean,
): UIMessage[] {
  // Static tool UI parts carry the tool name in `type` (tool-<name>); the
  // runtime emits them this way and convertToModelMessages reads them back.
  return [
    userMsg("delete victim.txt"),
    {
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "tool-delete_file",
          toolCallId: "call-1",
          input: { path: "victim.txt" },
          state: "approval-responded",
          approval: approved
            ? {
                id: approvalRequest.approvalId,
                approved: true,
                signature: approvalRequest.signature,
              }
            : {
                id: approvalRequest.approvalId,
                approved: false,
                reason: "Denied by user",
                signature: approvalRequest.signature,
              },
        } as any,
      ],
    },
  ];
}

describe("server approval gate lifecycle", () => {
  it("pauses before approval and never executes", async () => {
    const executions = { count: 0 };
    const model = new MockLanguageModelV4({ doStream: { stream: toolCallStream() } as any });
    const result = await runChat(model, [userMsg("delete victim.txt")], deleteTool(executions));
    const { approvals } = await collect(result);
    expect(approvals.length).toBe(1);
    expect(approvals[0].toolCallId).toBe("call-1");
    expect(approvals[0].approvalId).toBeTruthy();
    expect(executions.count).toBe(0);
  });

  it("approve → executes exactly once → result → model continues", async () => {
    const executions = { count: 0 };
    const firstModel = new MockLanguageModelV4({ doStream: { stream: toolCallStream() } as any });
    const first = await runChat(firstModel, [userMsg("delete victim.txt")], deleteTool(executions));
    const { approvals } = await collect(first);
    const approvalRequest = approvals[0] as ApprovalRequest;
    expect(approvalRequest.approvalId).toBeTruthy();
    expect(approvalRequest.signature).toBeTruthy();

    const secondModel = new MockLanguageModelV4({ doStream: { stream: textStream("deleted") } as any });
    const second = await runChat(
      secondModel,
      decidedFollowUp(approvalRequest, true),
      deleteTool(executions),
    );
    const { outputs, texts } = await collect(second);
    expect(executions.count).toBe(1);
    expect(outputs.length).toBeGreaterThan(0);
    expect(texts.join("")).toContain("deleted");
  });

  it("unsigned approval response fails closed before tool execution", async () => {
    const executions = { count: 0 };
    const firstModel = new MockLanguageModelV4({ doStream: { stream: toolCallStream() } as any });
    const first = await runChat(firstModel, [userMsg("delete victim.txt")], deleteTool(executions));
    const { approvals } = await collect(first);
    const approvalRequest = approvals[0] as ApprovalRequest;

    const secondModel = new MockLanguageModelV4({ doStream: { stream: textStream("unsafe") } as any });
    const second = await runChat(
      secondModel,
      decidedFollowUp({ approvalId: approvalRequest.approvalId }, true),
      deleteTool(executions),
    );

    const { errors } = await collect(second);
    expect(
      errors.some((error) => error instanceof InvalidToolApprovalSignatureError),
    ).toBe(true);
    expect(executions.count).toBe(0);
  });

  it("invalid approval signature fails closed before tool execution", async () => {
    const executions = { count: 0 };
    const firstModel = new MockLanguageModelV4({ doStream: { stream: toolCallStream() } as any });
    const first = await runChat(firstModel, [userMsg("delete victim.txt")], deleteTool(executions));
    const { approvals } = await collect(first);
    const approvalRequest = approvals[0] as ApprovalRequest;
    expect(approvalRequest.signature).toBeTruthy();

    const secondModel = new MockLanguageModelV4({ doStream: { stream: textStream("unsafe") } as any });
    const second = await runChat(
      secondModel,
      decidedFollowUp(
        {
          approvalId: approvalRequest.approvalId,
          signature: `${approvalRequest.signature}x`,
        },
        true,
      ),
      deleteTool(executions),
    );

    const { errors } = await collect(second);
    expect(
      errors.some((error) => error instanceof InvalidToolApprovalSignatureError),
    ).toBe(true);
    expect(executions.count).toBe(0);
  });

  it("signed deny → never executes → denial reaches the model", async () => {
    const executions = { count: 0 };
    const firstModel = new MockLanguageModelV4({ doStream: { stream: toolCallStream() } as any });
    const first = await runChat(firstModel, [userMsg("delete victim.txt")], deleteTool(executions));
    const { approvals } = await collect(first);
    const approvalRequest = approvals[0] as ApprovalRequest;
    expect(approvalRequest.signature).toBeTruthy();

    const secondModel = new MockLanguageModelV4({ doStream: { stream: textStream("ok, skipped") } as any });
    const second = await runChat(
      secondModel,
      decidedFollowUp(approvalRequest, false),
      deleteTool(executions),
    );
    const { outputs, texts } = await collect(second);
    expect(executions.count).toBe(0);
    const denied = outputs.some((o) => (o as any).denied === true);
    expect(denied).toBe(true);
    expect(texts.join("")).toContain("skipped");
  });
});

describe("pruning × approval lifecycle (production path)", () => {
  it("an approved response followed by a later user turn EXPIRES: no execution, fresh gate", async () => {
    // Continuation was lost; the user typed a new message. The stale approved
    // call must NOT execute retroactively — it is pruned and the model simply
    // continues (and may raise a fresh gate).
    const executions = { count: 0 };
    // First stream: nothing but text (the stale call is gone from history).
    const model = new MockLanguageModelV4({ doStream: { stream: textStream("ok") } as any });
    const history: UIMessage[] = [
      userMsg("delete victim.txt"),
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-delete_file",
            toolCallId: "call-stale",
            input: { path: "victim.txt" },
            state: "approval-responded",
            approval: { id: "ap-stale", approved: true },
          } as any,
        ],
      },
      userMsg("actually never mind"),
    ];
    const result = await runChat(model, history, deleteTool(executions));
    const { texts } = await collect(result);
    expect(executions.count).toBe(0);
    expect(texts.join("")).toContain("ok");
  });

  it("a completed interaction is NOT re-executed on replay (dedupe keeps output)", async () => {
    const executions = { count: 0 };
    const model = new MockLanguageModelV4({ doStream: { stream: textStream("done") } as any });
    // Both the approval snapshot AND the completed result persisted — the
    // pruner must keep only the completed one, so the tool does not run again.
    const history: UIMessage[] = [
      userMsg("delete victim.txt"),
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-delete_file",
            toolCallId: "call-1",
            input: { path: "victim.txt" },
            state: "approval-responded",
            approval: { id: "ap-1", approved: true },
          } as any,
        ],
      },
      {
        id: "a2",
        role: "assistant",
        parts: [
          {
            type: "tool-delete_file",
            toolCallId: "call-1",
            input: { path: "victim.txt" },
            state: "output-available",
            output: { deleted: true },
          } as any,
        ],
      },
    ];
    const result = await runChat(model, history, deleteTool(executions));
    await collect(result);
    expect(executions.count).toBe(0);
  });

  it("thread isolation: another thread's approval parts never appear in history", async () => {
    // Approval state lives in per-thread message history only — there is no
    // cross-thread store. Assert the boundary explicitly: converting thread B
    // history (no approval parts) yields no approval responses.
    const executions = { count: 0 };
    const model = new MockLanguageModelV4({ doStream: { stream: textStream("hi") } as any });
    const threadB: UIMessage[] = [userMsg("hello from B")];
    const result = await runChat(model, threadB, deleteTool(executions));
    const { approvals } = await collect(result);
    expect(approvals.length).toBe(0);
    expect(executions.count).toBe(0);
  });
});
