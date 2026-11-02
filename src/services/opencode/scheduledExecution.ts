/**
 * OpenCode Scheduled Execution Adapter.
 *
 * Implements executeOpenCodeScheduledTurn according to the V1 Unified Scheduler plan:
 * - 3 session strategies: fresh, persistent, existing_conversation
 * - Autonomous coding & read-only permission presets (no OS-level claims)
 * - Single authoritative conversation resolution (no duplicate conversation creation)
 * - Queue delivery via client.session.prompt with stable prompt ID (= inbox ID)
 * - Durable prompt submission reconciliation: verifies inbox/messages on transport error
 * - Post-wait queue check: confirms prompt is not still queued in inbox
 * - Turn-bounding inspection (user prompt ID -> idle outcome)
 * - Cancellation isolation: no session.interrupt on shared Existing Conversations
 * - No inferred completion via session.active(); uncertain outcomes settle to 'outcome_unknown'
 * - Prohibits automatic retry on uncertain outcomes to prevent duplicate side effects
 */
import { createOpenCodeClient, type OpenCodeClient } from "./client";
import { toOpenCodeError } from "./errors";
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
 * Reconciles prompt submission when client.session.prompt throws an error (e.g. transport drop).
 * Verifies whether the prompt was received by inspecting session inbox and message history.
 */
export async function reconcilePromptSubmission(
  client: OpenCodeClient,
  sessionId: string,
  promptId: string,
): Promise<{ found: boolean; location: "inbox" | "messages" | "none"; error?: string }> {
  try {
    const inboxResp = await client.session.inbox.list({ sessionID: sessionId });
    const inboxItems = Array.isArray(inboxResp) ? inboxResp : (inboxResp as any)?.data ?? [];
    if (inboxItems.some((item: any) => item.id === promptId)) {
      return { found: true, location: "inbox" };
    }

    const msgResp = await client.message.list({ sessionID: sessionId, order: "asc" });
    const messages = msgResp?.data ?? [];
    if (messages.some((msg: any) => msg.id === promptId)) {
      return { found: true, location: "messages" };
    }

    return { found: false, location: "none" };
  } catch (reconcileErr: any) {
    return {
      found: false,
      location: "none",
      error: normalizeError(reconcileErr).message,
    };
  }
}

/**
 * Resolves the target OpenCode session for a scheduled job.
 * Note: The conversation itself is authoritatively managed by ensureJobConversation in schedulerExecution.ts.
 * This function NEVER creates duplicate conversations; it binds/ensures the OpenCode session on the target conversation.
 */
export async function resolveSessionForJob(
  job: SchedulerJob,
  run: SchedulerRun,
  conversationId?: string | null,
): Promise<{
  conversationId: string;
  sessionId: string;
  isSharedExisting: boolean;
}> {
  let targetConvId = conversationId ?? run.conversationId ?? job.conversationId;
  if (!targetConvId) {
    const { ensureJobConversation } = await import("../scheduler/schedulerExecution");
    const resolved = await ensureJobConversation(job);
    targetConvId = resolved.conversationId;
  }

  const conv = await conversationService.get(targetConvId);
  if (!conv || conv.status === "archived") {
    throw new Error(
      `Conversation "${targetConvId}" not found or archived. Please update the job.`,
    );
  }

  const isSharedExisting = job.opencodeSessionStrategy === "existing_conversation";
  const permissions = isSharedExisting
    ? undefined
    : (job.opencodePermissions === "read_only"
        ? READ_ONLY_PERMISSIONS
        : AUTONOMOUS_CODING_PERMISSIONS);

  const binding = await ensureOpenCodeSession(
    targetConvId,
    permissions ? { permissions } : undefined,
  );

  schedulerStore.updateRun(run.id, {
    conversationId: targetConvId,
    opencodeSessionId: binding.sessionId,
  });

  return {
    conversationId: targetConvId,
    sessionId: binding.sessionId,
    isSharedExisting,
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
    const sessionRes = await resolveSessionForJob(job, run, params.conversationId);
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

  // 1. Submit prompt to session queue with durable submission reconciliation
  try {
    await client.session.prompt({
      sessionID: sessionId,
      id: promptId,
      text: job.prompt,
      delivery: "queue",
    });
  } catch (promptErr: any) {
    const normalizedPromptErr = normalizeError(promptErr).message;
    log.warn("opencode", "opencode.prompt_dispatch_error_reconciling", {
      sessionId,
      promptId,
      error: normalizedPromptErr,
    });

    const reconciliation = await reconcilePromptSubmission(client, sessionId, promptId);
    if (reconciliation.found) {
      log.info("opencode", "opencode.prompt_reconciled_after_dispatch_error", {
        sessionId,
        promptId,
        location: reconciliation.location,
      });
      // Prompt was received by OpenCode, continue to wait and turn-bounding
    } else {
      const durationMs = Date.now() - started;
      // Classify the dispatch error using the OpenCode error classifier rather
      // than fragile message matching. Only a positively identified definitive
      // server rejection (4xx) is treated as a hard failure. Transport faults,
      // 5xx, timeouts, malformed/lost responses and uncertain client errors are
      // ambiguous: acceptance cannot be established, so settle as outcome_unknown.
      // Reconciliation failure also makes acceptance unestablishable.
      const classified = toOpenCodeError(promptErr);
      const isDefinitiveRejection =
        classified.kind === "auth" ||
        classified.kind === "session_not_found" ||
        (classified.kind === "http" &&
          typeof classified.statusCode === "number" &&
          classified.statusCode >= 400 &&
          classified.statusCode < 500);
      const reconciliationFailed = Boolean(reconciliation.error);
      const isAmbiguous = reconciliationFailed || !isDefinitiveRejection;
      const turnOutcome = isAmbiguous ? "outcome_unknown" : "failed";
      const errorMsg = isAmbiguous
        ? `Ambiguous prompt submission: dispatch threw (${normalizedPromptErr}) and prompt existence could not be confirmed: ${reconciliation.error ?? "not found in inbox or messages"}`
        : `Failed to queue prompt to OpenCode: ${normalizedPromptErr}`;

      schedulerStore.updateRun(run.id, {
        status: "failed",
        turnOutcome,
        error: errorMsg,
        completedAt: Date.now(),
        durationMs,
      });
      schedulerStore.update(job.id, { lastRunAt: Date.now() });
      return { ok: false, text: "", error: errorMsg, retryable: false };
    }
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
        // Cancel queued prompt if still in inbox; DO NOT interrupt shared session.
        // Determine whether the prompt was still queued (cancellable) vs already
        // delivered (underlying work continues) so we report honestly.
        let stillQueued = false;
        try {
          const inboxResp = await client.session.inbox.list({ sessionID: sessionId });
          const inboxItems = Array.isArray(inboxResp) ? inboxResp : (inboxResp as any)?.data ?? [];
          stillQueued = inboxItems.some((item: any) => item.id === promptId);
        } catch {
          stillQueued = false;
        }
        await cancelOpenCodePrompt({ sessionId, promptId, conversationId });
        if (stillQueued) {
          schedulerStore.updateRun(run.id, {
            status: "cancelled",
            turnOutcome: "interrupted",
            error: "Cancelled by user. Queued prompt was removed; shared session was not interrupted.",
            completedAt: Date.now(),
            durationMs,
          });
        } else {
          // Prompt already delivered (or delivery unknown): cannot cancel the
          // underlying work in a shared conversation. Report as outcome_unknown,
          // not successful cancellation.
          schedulerStore.updateRun(run.id, {
            status: "failed",
            turnOutcome: "outcome_unknown",
            error: "Cancelled by user, but the prompt had already been delivered to the shared conversation; underlying work was not interrupted.",
            completedAt: Date.now(),
            durationMs,
          });
        }
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

  // 3. Post-wait inbox check: verify prompt was actually consumed from inbox
  try {
    const inboxResp = await client.session.inbox.list({ sessionID: sessionId });
    const inboxItems = Array.isArray(inboxResp) ? inboxResp : (inboxResp as any)?.data ?? [];
    if (inboxItems.some((item: any) => item.id === promptId)) {
      const durationMs = Date.now() - started;
      const errorMsg =
        "Scheduled prompt remained queued in session inbox after wait completed.";
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
  } catch (inboxErr: any) {
    // Non-fatal; continue to message list inspection
  }

  // 4. Inspect message history for prompt -> idle turn boundary
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
