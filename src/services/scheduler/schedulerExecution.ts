/**
 * Scheduler execution adapter.
 *
 * Reuses the canonical AI stack (`getModel` + AI SDK `streamText`) and the
 * sandboxed native tools (`services/tools.ts`). It does NOT duplicate the
 * chat route's streaming pipeline — scheduled runs are non-interactive.
 *
 * Unattended safety: destructive native tools (write/edit/delete/run/kill)
 * are offered with an execute function that always refuses with a clear
 * "user approval required" error — approval gates can never be silently
 * bypassed. MCP tools are excluded in V1 (documented limitation).
 */
import { streamText, stepCountIs, tool, type UIMessage } from "ai";
import { z } from "zod";
import fs from "fs";
import path from "path";
import { getModel } from "../ai";
import { registry } from "../../config/providers";
import { credentialStore } from "../credentials";
import {
  runRead,
  runList,
  runSearch,
  runStat,
  runProcesses,
  runSysinfo,
  getWorkspaceDir,
  ToolError,
} from "../tools";
import {
  toolReadSchema,
  toolListSchema,
  toolSearchSchema,
  toolStatSchema,
} from "../../lib/validation";
import { logger, normalizeError, newRequestId } from "../../lib/logger";
import { classifyError } from "../../lib/errors";
import { instrumentedExecute } from "../../lib/tool-funnel";
import { generateId } from "../../lib/utils";
import type { SchedulerJob, SchedulerRun } from "./schedulerTypes";
import { schedulerStore } from "./schedulerStore";
import { conversationService, messageService } from "../storage";

const APPROVAL_REFUSAL =
  "Refused: this tool requires interactive user approval, which is unavailable during unattended scheduled execution. The run continues without this action.";

function refusalTool(name: string, description: string) {
  return tool({
    description: `${description} UNAVAILABLE in scheduled runs — always refuses (user approval required).`,
    inputSchema: z.object({}).passthrough(),
    outputSchema: z.unknown(),
    execute: instrumentedExecute(name, async () => {
      throw new ToolError(APPROVAL_REFUSAL);
    }),
  });
}

/** Tool set for scheduled runs: read-only tools execute, destructive tools refuse. */
export function buildSchedulerTools() {
  return {
    read_file: tool({
      description:
        "Read a text file from the workspace. Returns the file content.",
      inputSchema: toolReadSchema,
      outputSchema: z.unknown(),
      execute: instrumentedExecute("read_file", async (args: any) => runRead(args)),
    }),
    list_dir: tool({
      description: "List files and folders inside the workspace.",
      inputSchema: toolListSchema,
      outputSchema: z.unknown(),
      execute: instrumentedExecute("list_dir", async (args) => runList(args)),
    }),
    search_files: tool({
      description:
        "Search file contents inside the workspace (case-insensitive).",
      inputSchema: toolSearchSchema,
      outputSchema: z.unknown(),
      execute: instrumentedExecute("search_files", async (args: any) => runSearch(args)),
    }),
    file_info: tool({
      description: "Show size, type and timestamps for a workspace path.",
      inputSchema: toolStatSchema,
      outputSchema: z.unknown(),
      execute: instrumentedExecute("file_info", async (args: any) => runStat(args)),
    }),
    process_list: tool({
      description:
        "List running processes on this computer (pid, name, CPU, memory).",
      inputSchema: z.object({}),
      outputSchema: z.unknown(),
      execute: instrumentedExecute("process_list", async () => runProcesses()),
    }),
    system_info: tool({
      description: "Show computer info: OS, CPU, memory and uptime.",
      inputSchema: z.object({}),
      outputSchema: z.unknown(),
      execute: instrumentedExecute("system_info", async () => runSysinfo()),
    }),
    write_file: refusalTool("write_file", "Write or create a text file in the workspace."),
    edit_file: refusalTool("edit_file", "Replace text in a workspace file."),
    delete_file: refusalTool("delete_file", "Delete a file or folder inside the workspace."),
    run_command: refusalTool("run_command", "Run a shell command inside the workspace."),
    process_kill: refusalTool("process_kill", "Stop a running process by pid."),
  };
}

export function isRetryableError(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  // Legacy transport policy preserved: raw aborts are retried (user
  // cancellation is forced by the caller's `aborted` flag instead).
  // classifyError conservatively marks these cancelled — the scheduler
  // deliberately diverges here; see docs/logging.md.
  if (/abort/i.test(text)) return true;
  return classifyError(err).retryable;
}

export interface ExecutionResult {
  ok: boolean;
  text: string;
  error: string | null;
  retryable: boolean;
}

/**
 * Verify the job's workspace: must exist and must resolve inside the
 * permitted workspace root (same sandbox policy as interactive tools).
 * Throws a non-retryable ToolError otherwise.
 */
export function verifyJobWorkspace(workspacePath: string): string {
  const root = getWorkspaceDir();
  const abs = path.resolve(workspacePath);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new ToolError(
      `Workspace "${workspacePath}" is outside the permitted workspace root`,
    );
  }
  let probe = abs;
  while (true) {
    if (fs.existsSync(probe)) {
      const real = fs.realpathSync(probe);
      if (real !== root && !real.startsWith(root + path.sep)) {
        throw new ToolError(
          `Workspace symlink target for "${workspacePath}" escapes the workspace root`,
        );
      }
      break;
    }
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  if (!fs.existsSync(abs)) {
    throw new ToolError(`Workspace not found: "${workspacePath}"`);
  }
  return abs;
}

/** Resolve provider + credential + model for a job. Throws non-retryable on misconfig. */
export function resolveJobModel(job: SchedulerJob): {
  providerType: string;
  model: ReturnType<typeof getModel>;
  // Mirrors the chat route: provider-specific thinking controls keyed by
  // provider id (Record<string, any> matches the AI SDK provider-options type).
  providerOptions: Record<string, any>;
} {
  const provider = registry.get(job.providerId);
  if (!provider) {
    throw new ToolError(
      `Provider "${job.providerId}" is missing or deleted; refusing to substitute another model`,
    );
  }
  const needsKey = provider.type !== "ollama";
  let apiKey: string | undefined;
  if (needsKey) {
    if (!credentialStore.has(provider.id)) {
      throw new ToolError(
        `No credential configured for provider "${provider.name}"; refusing to run`,
      );
    }
    apiKey = credentialStore.get(provider.id);
  }
  const model = getModel({
    id: provider.id,
    name: provider.name,
    type: provider.type,
    endpoint: provider.endpoint ?? undefined,
    model: job.modelId,
    apiKey,
  });
  const thinking = job.thinkingLevel ?? "off";
  const isLite = /lite|nano/i.test(job.modelId || "");
  const providerOptions: Record<string, any> = {};
  if (!isLite && thinking !== "off") {
    if (provider.type === "google") {
      const budget = { low: 1024, medium: 4096, high: 8192 }[thinking] ?? 4096;
      providerOptions.google = {
        thinkingConfig: { thinkingBudget: budget },
      };
    } else if (provider.type === "anthropic") {
      const budget = { low: 1024, medium: 4096, high: 8192 }[thinking] ?? 4096;
      providerOptions.anthropic = {
        thinking: { type: "enabled", budgetTokens: budget },
      };
    } else if (provider.type === "openai" || provider.type === "custom") {
      const effort = { low: "low", medium: "medium", high: "high" }[thinking] ?? "medium";
      providerOptions.openai = { reasoningEffort: effort };
    }
  }
  return { providerType: provider.type, model, providerOptions };
}

/** Resolve the conversation ID for a job, handling both conversation modes. */
export async function ensureJobConversation(
  job: SchedulerJob,
): Promise<{ conversationId: string; created: boolean; safeToDelete: boolean }> {
  if (job.conversationPolicy === "existing_thread") {
    if (!job.conversationId) {
      throw new ToolError(
        `Job "${job.name}" uses existing-thread mode but has no conversationId. ` +
        `Select a conversation when creating or editing the job.`,
      );
    }
    const conv = await conversationService.get(job.conversationId);
    if (!conv) {
      throw new ToolError(
        `Conversation "${job.conversationId}" not found (deleted or archived). ` +
        `Update the job to select a valid conversation.`,
      );
    }
    if (conv.status === "archived") {
      throw new ToolError(
        `Conversation "${job.conversationId}" is archived. Update the job to select a valid conversation.`,
      );
    }
    return { conversationId: conv.id, created: false, safeToDelete: false };
  }

  // dedicated_thread mode (default / backwards-compatible)
  if (job.conversationId) {
    const existing = await conversationService.get(job.conversationId);
    if (existing) return { conversationId: existing.id, created: false, safeToDelete: true };
    // ID stored but no longer exists — treat as fresh dedicated thread
  }
  const created = await conversationService.create({
    title: `[Scheduler] ${job.name}`,
    providerId: job.providerId,
    workspaceMode: "simple",
  });
  schedulerStore.update(job.id, { conversationId: created.id });
  return { conversationId: created.id, created: true, safeToDelete: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function executeJobRun(
  job: SchedulerJob,
  run: SchedulerRun,
  conversationId: string,
  parentSignal?: AbortSignal,
): Promise<ExecutionResult> {
  const requestId = run.requestId ?? newRequestId();
  const log = logger.child({
    requestId,
    jobId: job.id,
    occurrenceId: run.occurrenceId,
    runId: run.id,
  });
  const started = Date.now();
  log.info("scheduler", "scheduler.run", {
    outcome: "started",
    provider: job.providerId,
    model: job.modelId,
  });

  const maxAttempts = 1 + Math.max(0, job.maxRetries);
  let attempt = 0;
  let lastError: string | null = null;

  while (attempt < maxAttempts) {
    schedulerStore.updateRun(run.id, { attempt, status: "running" });
    const controller = new AbortController();
    // A parent abort means user cancellation (the timeout aborts below for
    // time limits). Tracked separately so the run records "cancelled".
    let cancelledByParent = parentSignal?.aborted ?? false;
    const onParentAbort = (): void => {
      cancelledByParent = true;
      controller.abort();
    };
    if (!cancelledByParent) parentSignal?.addEventListener("abort", onParentAbort);
    const timeoutMs = Math.max(5, job.timeoutSeconds) * 1000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const workspaceAbs = verifyJobWorkspace(job.workspacePath);
      const { model, providerOptions, providerType } = resolveJobModel(job);
      const rel = path.relative(getWorkspaceDir(), workspaceAbs) || ".";
      const workspaceLabel = rel === "." ? "workspace root" : rel;
      // Split sent-vs-shown (codeg prompt_blocks vs display_text): the model
      // needs the workspace/approval context, but the thread shows exactly
      // what the user wrote — no scaffolding, no header stamp. Run metadata
      // (job, time) lives in run history, not in chat.
      const displayPrompt = job.prompt;
      const fullPrompt =
        `[Scheduled run of job "${job.name}". Workspace: ${workspaceLabel} ` +
        `(all file paths are relative to the workspace root). ` +
        `Destructive tools are unavailable without interactive approval.]\n\n${job.prompt}`;
      // Persist the user prompt so the thread history shows what was asked.
      // Chained onto the thread tip: every scheduler message used parent_id
      // null, which built a forest of disconnected roots the thread view
      // could not render (prompts invisible despite being stored).
      let tip: string | null = null;
      try {
        tip = await messageService.getThreadTip(conversationId);
      } catch {
        /* tip is best-effort; a null parent still stores the message */
      }
      const userMsgId = generateId();
      await messageService.upsertStored(conversationId, {
        id: userMsgId,
        parent_id: tip,
        format: "ai-sdk/v6",
        content: { id: userMsgId, role: "user", parts: [{ type: "text", text: displayPrompt, state: "done" as const }] },
      });
      const result = streamText({
        model,
        messages: [{ role: "user", content: fullPrompt }],
        tools: buildSchedulerTools(),
        stopWhen: stepCountIs(10),
        abortSignal: controller.signal,
        ...(Object.keys(providerOptions).length ? { providerOptions } : {}),
      });
      const text = await result.text;
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
      // Persist the assistant response to the thread.
      const assistantMsgId = generateId();
      await messageService.upsertStored(conversationId, {
        id: assistantMsgId,
        parent_id: userMsgId,
        format: "ai-sdk/v6",
        content: { id: assistantMsgId, role: "assistant", parts: [{ type: "text", text, state: "done" as const }] },
      });
      const excerpt = text.slice(0, 2000);
      const durationMs = Date.now() - started;
      schedulerStore.updateRun(run.id, {
        status: "completed",
        error: null,
        outputExcerpt: excerpt,
        completedAt: Date.now(),
        durationMs,
      });
      schedulerStore.update(job.id, { lastRunAt: Date.now() });
      log.info("scheduler", "scheduler.run", {
        outcome: "finished",
        provider: providerType,
        model: job.modelId,
        durationMs,
      });
      return { ok: true, text, error: null, retryable: false };
    } catch (err) {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
      if (cancelledByParent) {
        const durationMs = Date.now() - started;
        schedulerStore.updateRun(run.id, {
          status: "cancelled",
          error: "Cancelled by user",
          completedAt: Date.now(),
          durationMs,
        });
        schedulerStore.update(job.id, { lastRunAt: Date.now() });
        log.info("scheduler", "scheduler.run", {
          outcome: "cancelled",
          provider: job.providerId,
          model: job.modelId,
          durationMs,
        });
        return { ok: false, text: "", error: "Cancelled by user", retryable: false };
      }
      const norm = normalizeError(err);
      const aborted =
        controller.signal.aborted ||
        /abort|aborted|timeout|timed out/i.test(norm.message);
      const message = aborted
        ? `Run timed out after ${job.timeoutSeconds}s`
        : norm.message.slice(0, 1000);
      lastError = message;
      // Best-effort: persist an error message so the thread shows why it failed.
      if (conversationId) {
        try {
          const errId = generateId();
          await messageService.upsertStored(conversationId, {
            id: errId,
            parent_id: null,
            format: "ai-sdk/v6",
            content: { id: errId, role: "assistant", parts: [{ type: "text", text: `Error: ${message}`, state: "done" as const }] },
          });
        } catch {
          /* persistence error must not mask the real error */
        }
      }
      const retryable = !aborted ? isRetryableError(err) : true;
      log.warn("scheduler", "scheduler.run", {
        outcome: "failed",
        ...classifyError(err),
        message,
        attempt,
        retryable,
      });
      attempt += 1;
      schedulerStore.updateRun(run.id, { attempt, error: message });
      if (attempt >= maxAttempts || !retryable) {
        const durationMs = Date.now() - started;
        schedulerStore.updateRun(run.id, {
          status: "failed",
          error: message,
          completedAt: Date.now(),
          durationMs,
        });
        schedulerStore.update(job.id, { lastRunAt: Date.now() });
        return { ok: false, text: "", error: message, retryable };
      }
      log.info("scheduler", "scheduler.run", {
        outcome: "retried",
        attempt,
        delaySeconds: job.retryDelaySeconds,
      });
      await sleep(Math.max(0, job.retryDelaySeconds) * 1000);
    }
  }
  const durationMs = Date.now() - started;
  schedulerStore.updateRun(run.id, {
    status: "failed",
    error: lastError,
    completedAt: Date.now(),
    durationMs,
  });
  return { ok: false, text: "", error: lastError, retryable: false };
}
