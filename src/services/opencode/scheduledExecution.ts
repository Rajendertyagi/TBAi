/**
 * OpenCode Scheduled Execution Adapter.
 *
 * Implements executeOpenCodeScheduledTurn according to the V1 Unified Scheduler plan:
 * - 3 session strategies: fresh, persistent, existing_conversation
 * - Autonomous coding & read-only permission presets (no OS-level claims)
 * - Queue delivery via client.session.prompt with stable prompt ID (= inbox ID)
 * - Turn-bounding inspection (user prompt ID -> idle outcome)
 * - Cancellation isolation: no session.interrupt on shared Existing Conversations
 * - No inferred completion via session.active(); uncertain outcomes settle to 'outcome_unknown'
 * - Prohibits automatic retry on uncertain outcomes to prevent duplicate side effects
 */
import { createOpenCodeClient } from "./client";
import { resolveOpenCodeServiceAccess } from "./serviceAccess";
import {
  ensureOpenCodeSession,
  AUTONOMOUS_CODING_PERMISSIONS,
  READ_ONLY_PERMISSIONS,
} from "./sessions";
import { conversationService } from "../storage";
import { schedulerStore } from "../scheduler/schedulerStore";
import type {
  SchedulerJob,
  SchedulerRun,
} from "../scheduler/schedulerTypes";
import type { ExecutionResult } from "../scheduler/schedulerExecution";
import { logger, newRequestId, normalizeError } from "../../lib/logger";
import { generateId } from "../../lib/utils";

export interface ScheduledTurnParams {
  job: SchedulerJob;
  run: SchedulerRun;
  conversationId?: string | null;
  parentSignal?: AbortSignal;
}

/**
 * Cancels a queued scheduled prompt from the OpenCode session inbox.
 * Best-effort: safe if already delivered or if the session does not exist.
 */
export async function cancelOpenCodePrompt(input: {
  sessionId: string;
  promptId: string;
  conversationId: string;
}): Promise<boolean> {
  try {
    const conv = await conversationService.get(input.conversationId);
    if (!conv) return false;
    const access = await resolveOpenCodeServiceAccess(conv);
    const client = createOpenCodeClient(access.baseUrl, {
      directory: conv.opencodeDirectory ?? undefined,
      transport: access.transport,
    });
    await client.session.inbox.cancel({
      sessionID: input.sessionId,
      inboxID: input.promptId,
    });
    return true;
  } catch (err: any) {
    logger.debug("opencode", "opencode.inbox_cancel_skipped", {
      sessionId: input.sessionId,
      promptId: input.promptId,
      error: err?.message,
    });
    return false;
  }
}

/**
 * Resolves the target conversation and OpenCode session for a scheduled job.
 */
async function resolveSessionForJob(
  job: SchedulerJob,
  run: SchedulerRun,
): Promise<{
  conversationId: string;
  sessionId: string;
  isSharedExisting: boolean;
}> {
  const strategy = job.opencodeSessionStrategy ?? "fresh";

  if (strategy === "fresh") {
    // Fresh session: dedicated run-scoped conversation in SQLite
    const createdConv = await conversationService.create({
      title: `[Scheduled: Fresh] ${job.name}`,
      providerId: "opencode",
      modelId: job.opencodeModel ?? null,
      workspaceMode: "project",
      workspaceFolderId: job.workspaceFolderId,
      engine: "opencode",
      opencodeAgent: job.opencodeAgent ?? undefined,
      opencodeModel: job.opencodeModel ?? undefined,
      opencodeVariant: job.opencodeVariant ?? undefined,
    });

    const permissions =
      job.opencodePermissions === "read_only"
        ? READ_ONLY_PERMISSIONS
        : AUTONOMOUS_CODING_PERMISSIONS;

    const binding = await ensureOpenCodeSession(createdConv.id, { permissions });

    schedulerStore.updateRun(run.id, {
      conversationId: createdConv.id,
      opencodeSessionId: binding.sessionId,
    });

    return {
      conversationId: createdConv.id,
      sessionId: binding.sessionId,
      isSharedExisting: false,
    };
  }

  if (strategy === "persistent") {
    let targetConvId = job.conversationId;
    if (targetConvId) {
      const existing = await conversationService.get(targetConvId);
      if (!existing || existing.status === "archived") {
        targetConvId = null;
      }
    }

    if (!targetConvId) {
      const createdConv = await conversationService.create({
        title: `[Scheduled: Persistent] ${job.name}`,
        providerId: "opencode",
        modelId: job.opencodeModel ?? null,
        workspaceMode: "project",
        workspaceFolderId: job.workspaceFolderId,
        engine: "opencode",
        opencodeAgent: job.opencodeAgent ?? undefined,
        opencodeModel: job.opencodeModel ?? undefined,
        opencodeVariant: job.opencodeVariant ?? undefined,
      });
      targetConvId = createdConv.id;
      schedulerStore.update(job.id, { conversationId: createdConv.id });
    }

    const permissions =
      job.opencodePermissions === "read_only"
        ? READ_ONLY_PERMISSIONS
        : AUTONOMOUS_CODING_PERMISSIONS;

    const binding = await ensureOpenCodeSession(targetConvId, { permissions });

    schedulerStore.updateRun(run.id, {
      conversationId: targetConvId,
      opencodeSessionId: binding.sessionId,
    });

    return {
      conversationId: targetConvId,
      sessionId: binding.sessionId,
      isSharedExisting: false,
    };
  }

  // existing_conversation strategy
  if (!job.conversationId) {
    throw new Error(
      `Job "${job.name}" uses existing conversation strategy but has no conversation selected`,
    );
  }
  const existingConv = await conversationService.get(job.conversationId);
  if (!existingConv || existingConv.status === "archived") {
    throw new Error(
      `Conversation "${job.conversationId}" not found or archived. Please update the job.`,
    );
  }

  // Existing conversations retain active permissions - no permissions override
  const binding = await ensureOpenCodeSession(job.conversationId);

  schedulerStore.updateRun(run.id, {
    conversationId: job.conversationId,
    opencodeSessionId: binding.sessionId,
  });

  return {
    conversationId: job.conversationId,
    sessionId: binding.sessionId,
    isSharedExisting: true,
  };
}

/**
 * Executes a single scheduled turn against OpenCode 2.2.0.
 */
export async function executeOpenCodeScheduledTurn(
  params: ScheduledTurnParams,
): Promise<ExecutionResult> {
  const { job, run, parentSignal } = params;
  const requestId = run.requestId ?? newRequestId();
  const log = logger.child({
    requestId,
    jobId: job.id,
    occurrenceId: run.occurrenceId,
    runId: run.id,
  });
  const started = Date.now();

  log.info("opencode", "opencode.scheduled_run_started", {
    strategy: job.opencodeSessionStrategy ?? "fresh",
    model: job.opencodeModel ?? undefined,
    agent: job.opencodeAgent ?? undefined,
  });

  let conversationId: string | null = null;
  let sessionId: string | null = null;
  let isSharedExisting = false;

  try {
    const sessionRes = await resolveSessionForJob(job, run);
    conversationId = sessionRes.conversationId;
    sessionId = sessionRes.sessionId;
    isSharedExisting = sessionRes.isSharedExisting;
  } catch (resolveErr: any) {
    const durationMs = Date.now() - started;
    const errorMsg = normalizeError(resolveErr).message;
    schedulerStore.updateRun(run.id, {
      status: "failed",
      turnOutcome: "failed",
      error: errorMsg,
      completedAt: Date.now(),
      durationMs,
    });
    schedulerStore.update(job.id, { lastRunAt: Date.now() });
    return { ok: false, text: "", error: errorMsg, retryable: false };
  }

  const promptId = run.opencodePromptId ?? `msg_${generateId()}`;
  schedulerStore.updateRun(run.id, {
    opencodePromptId: promptId,
    opencodeSessionId: sessionId,
    status: "running",
  });

  const conv = await conversationService.get(conversationId);
  const access = await resolveOpenCodeServiceAccess(conv!);
  const client = createOpenCodeClient(access.baseUrl, {
    directory: conv?.opencodeDirectory ?? undefined,
    transport: access.transport,
  });

  // Check parent abortion before prompt dispatch
  if (parentSignal?.aborted) {
    const durationMs = Date.now() - started;
    schedulerStore.updateRun(run.id, {
      status: "cancelled",
      turnOutcome: "interrupted",
      error: "Cancelled by user before prompt submission",
      completedAt: Date.now(),
      durationMs,
    });
    schedulerStore.update(job.id, { lastRunAt: Date.now() });
    return { ok: false, text: "", error: "Cancelled by user", retryable: false };
  }

  // 1. Submit prompt to session queue
  try {
    await client.session.prompt({
      sessionID: sessionId,
      id: promptId,
      text: job.prompt,
      delivery: "queue",
    });
  } catch (promptErr: any) {
    const durationMs = Date.now() - started;
    const errorMsg = `Failed to queue prompt to OpenCode: ${normalizeError(promptErr).message}`;
    schedulerStore.updateRun(run.id, {
      status: "failed",
      turnOutcome: "failed",
      error: errorMsg,
      completedAt: Date.now(),
      durationMs,
    });
    schedulerStore.update(job.id, { lastRunAt: Date.now() });
    return { ok: false, text: "", error: errorMsg, retryable: false };
  }

  // 2. Await turn completion
  const timeoutMs = Math.max(5, job.timeoutSeconds) * 1000;
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);

  let cancelledByParent = false;
  const onParentAbort = (): void => {
    cancelledByParent = true;
    timeoutController.abort();
  };
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });

  try {
    await client.session.wait(
      { sessionID: sessionId },
      { signal: timeoutController.signal },
    );
  } catch {
    // Wait may reject if aborted or if unsupported on server
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }

  // Handle cancellation or timeout
  if (timeoutController.signal.aborted) {
    const durationMs = Date.now() - started;
    if (cancelledByParent) {
      if (isSharedExisting) {
        // Cancel queued prompt if still in inbox; DO NOT interrupt shared session
        await cancelOpenCodePrompt({ sessionId, promptId, conversationId });
        schedulerStore.updateRun(run.id, {
          status: "cancelled",
          turnOutcome: "outcome_unknown",
          error: "Cancelled by user. Shared conversation session was not interrupted.",
          completedAt: Date.now(),
          durationMs,
        });
        schedulerStore.update(job.id, { lastRunAt: Date.now() });
        return { ok: false, text: "", error: "Cancelled by user", retryable: false };
      } else {
        try {
          await client.session.interrupt({ sessionID: sessionId });
        } catch {}
        schedulerStore.updateRun(run.id, {
          status: "cancelled",
          turnOutcome: "interrupted",
          error: "Cancelled by user",
          completedAt: Date.now(),
          durationMs,
        });
        schedulerStore.update(job.id, { lastRunAt: Date.now() });
        return { ok: false, text: "", error: "Cancelled by user", retryable: false };
      }
    } else {
      // Timeout hit
      if (isSharedExisting) {
        // Shared conversation timeout: cancel if queued, do NOT interrupt shared session
        await cancelOpenCodePrompt({ sessionId, promptId, conversationId });
        const errorMsg =
          "Scheduled run timed out while executing in a shared conversation. Session was not interrupted to prevent aborting user interactive work.";
        schedulerStore.updateRun(run.id, {
          status: "failed",
          turnOutcome: "outcome_unknown",
          error: errorMsg,
          completedAt: Date.now(),
          durationMs,
        });
        schedulerStore.update(job.id, { lastRunAt: Date.now() });
        return { ok: false, text: "", error: errorMsg, retryable: false };
      } else {
        try {
          await client.session.interrupt({ sessionID: sessionId });
        } catch {}
        const errorMsg = `Run timed out after ${job.timeoutSeconds}s`;
        schedulerStore.updateRun(run.id, {
          status: "failed",
          turnOutcome: "interrupted",
          error: errorMsg,
          completedAt: Date.now(),
          durationMs,
        });
        schedulerStore.update(job.id, { lastRunAt: Date.now() });
        return { ok: false, text: "", error: errorMsg, retryable: false };
      }
    }
  }

  // 3. Inspect message history for prompt -> idle turn boundary
  try {
    const listResp = await client.message.list({
      sessionID: sessionId,
      order: "asc",
    });
    const messages = listResp.data ?? [];

    const promptIdx = messages.findIndex((m: any) => m.type === "user" && m.id === promptId);
    if (promptIdx === -1) {
      const durationMs = Date.now() - started;
      const errorMsg =
        "Submitted prompt message could not be located in session message history.";
      schedulerStore.updateRun(run.id, {
        status: "failed",
        turnOutcome: "outcome_unknown",
        error: errorMsg,
        completedAt: Date.now(),
        durationMs,
      });
      schedulerStore.update(job.id, { lastRunAt: Date.now() });
      return { ok: false, text: "", error: errorMsg, retryable: false };
    }

    let assistantText = "";
    let boundaryIdle: any = null;
    let interveningUserMessage = false;

    for (let i = promptIdx + 1; i < messages.length; i++) {
      const msg = messages[i] as any;
      if (msg.type === "user") {
        interveningUserMessage = true;
        break;
      }
      if (msg.type === "assistant") {
        if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part?.type === "text" && typeof part.text === "string") {
              assistantText += (assistantText ? "\n" : "") + part.text;
            }
          }
        }
      }
      if (msg.type === "idle") {
        boundaryIdle = msg;
        break;
      }
    }

    if (interveningUserMessage) {
      const durationMs = Date.now() - started;
      const errorMsg =
        "Interactive user message intervened before turn completion; assistant output cannot be unambiguously attributed.";
      schedulerStore.updateRun(run.id, {
        status: "failed",
        turnOutcome: "outcome_unknown",
        error: errorMsg,
        completedAt: Date.now(),
        durationMs,
      });
      schedulerStore.update(job.id, { lastRunAt: Date.now() });
      return { ok: false, text: "", error: errorMsg, retryable: false };
    }

    if (!boundaryIdle) {
      const durationMs = Date.now() - started;
      const errorMsg =
        "Session did not record a terminating idle state for the scheduled prompt.";
      schedulerStore.updateRun(run.id, {
        status: "failed",
        turnOutcome: "outcome_unknown",
        error: errorMsg,
        completedAt: Date.now(),
        durationMs,
      });
      schedulerStore.update(job.id, { lastRunAt: Date.now() });
      return { ok: false, text: "", error: errorMsg, retryable: false };
    }

    const durationMs = Date.now() - started;
    const excerpt = assistantText.slice(0, 2000);

    if (boundaryIdle.outcome === "succeeded") {
      schedulerStore.updateRun(run.id, {
        status: "completed",
        turnOutcome: "succeeded",
        outputExcerpt: excerpt,
        error: null,
        completedAt: Date.now(),
        durationMs,
      });
      schedulerStore.update(job.id, { lastRunAt: Date.now() });
      log.info("opencode", "opencode.scheduled_run_succeeded", {
        sessionId,
        promptId,
        durationMs,
      });
      return { ok: true, text: assistantText, error: null, retryable: false };
    }

    if (boundaryIdle.outcome === "failed") {
      const failError =
        boundaryIdle.error?.message ?? "OpenCode turn reported failure outcome.";
      schedulerStore.updateRun(run.id, {
        status: "failed",
        turnOutcome: "failed",
        outputExcerpt: excerpt,
        error: failError,
        completedAt: Date.now(),
        durationMs,
      });
      schedulerStore.update(job.id, { lastRunAt: Date.now() });
      log.warn("opencode", "opencode.scheduled_run_failed", {
        sessionId,
        promptId,
        error: failError,
      });
      return { ok: false, text: assistantText, error: failError, retryable: false };
    }

    if (boundaryIdle.outcome === "interrupted") {
      schedulerStore.updateRun(run.id, {
        status: "cancelled",
        turnOutcome: "interrupted",
        outputExcerpt: excerpt,
        error: "OpenCode turn was interrupted",
        completedAt: Date.now(),
        durationMs,
      });
      schedulerStore.update(job.id, { lastRunAt: Date.now() });
      return {
        ok: false,
        text: assistantText,
        error: "OpenCode turn was interrupted",
        retryable: false,
      };
    }

    // Any unknown outcome from idle
    const outcome = boundaryIdle.outcome ?? "unknown";
    const errorMsg = `OpenCode idle reported unrecognized outcome: ${outcome}`;
    schedulerStore.updateRun(run.id, {
      status: "failed",
      turnOutcome: "outcome_unknown",
      error: errorMsg,
      completedAt: Date.now(),
      durationMs,
    });
    schedulerStore.update(job.id, { lastRunAt: Date.now() });
    return { ok: false, text: assistantText, error: errorMsg, retryable: false };
  } catch (inspectErr: any) {
    const durationMs = Date.now() - started;
    const errorMsg = `Failed to inspect session messages: ${normalizeError(inspectErr).message}`;
    schedulerStore.updateRun(run.id, {
      status: "failed",
      turnOutcome: "outcome_unknown",
      error: errorMsg,
      completedAt: Date.now(),
      durationMs,
    });
    schedulerStore.update(job.id, { lastRunAt: Date.now() });
    return { ok: false, text: "", error: errorMsg, retryable: false };
  }
}
