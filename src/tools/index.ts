/**
 * Server-side native tools: AI SDK v7 `tool()` definitions (direct chat).
 *
 * This is the single server assembly of every native tool. Each entry is a
 * native AI SDK v7 `tool()` with its Zod `inputSchema` passed directly — no
 * JSON-Schema conversion layer, no `AISDKToolkit`, no per-request execute
 * rewrapping. Where a tool needs request-scoped data it declares a
 * `contextSchema`; the chat route supplies one `toolsContext` map (keyed by
 * tool name) per request, AI SDK validates each entry against its tool's
 * `contextSchema` before `execute` runs, and the validated value arrives as
 * `options.context`.
 *
 * Context carries DATA only (workspaceDir, threadId, provider/model ids). A
 * function can never ride validated Zod context, so `run_command`'s
 * per-request terminal callback stays a thin closure (`withTerminalOutput`).
 * MCP tools keep their own `tool()` wrappers in `services/mcp/manager.ts`,
 * OpenCode tools stay behind their feature boundary, and the scheduler's
 * unattended set stays in `services/scheduler/schedulerExecution.ts`.
 *
 * Client renderers (`web/src/tools/toolkit.ts`, `defineToolkit`) are
 * render-only and name-keyed — the contract is the tool NAME, so they are
 * untouched by this assembly.
 */
import { tool } from "ai";
import { z } from "zod";
import { toolSchemas } from "./schemas";
import {
  runRead,
  runWrite,
  runEdit,
  runBash,
  runList,
  runSearch,
  runStat,
  runDelete,
  runProcesses,
  runKill,
  runSysinfo,
  ToolError,
  type BashOutputEvent,
} from "../services/tools";
import { runScheduler } from "../services/scheduler/schedulerTools";
import { runTodo } from "../services/todos";
import { runBrowserRead, runBrowserAction } from "../services/browser";
import { instrumentedExecute } from "../lib/tool-funnel";

/**
 * Request-scoped data for every workspace-bound tool (8 fs tools +
 * `run_command`). `workspaceDir` is required — a missing root fails closed
 * in `execute`, and the chat route refuses to build `toolsContext` without
 * one. `threadId` is optional: without a thread there are no one-shot
 * outside-workspace grants and no funnel conversationId, and outside paths
 * stay hard-rejected.
 */
const workspaceContext = z.object({
  workspaceDir: z.string().min(1),
  threadId: z.string().min(1).optional(),
});
export type WorkspaceToolContext = z.infer<typeof workspaceContext>;

/**
 * Todo needs only thread identity. The service rejects a missing thread
 * (`runTodo` throws `ToolError`), which preserves the old static-entry
 * behavior of refusing without thread context.
 */
const todoContext = z.object({
  threadId: z.string().min(1).optional(),
});
export type TodoToolContext = z.infer<typeof todoContext>;

/**
 * Scheduler creates inherit the current conversation's provider, model, and
 * workspace — the model cannot guess provider cuid values, so explicit IDs
 * stay optional overrides. Defaults apply on `create` only; every other
 * action passes its args through untouched.
 */
const schedulerContext = z.object({
  workspaceDir: z.string().min(1),
  providerId: z.string().optional(),
  modelId: z.string().optional(),
});
export type SchedulerToolContext = z.infer<typeof schedulerContext>;

/** The full per-request context map, keyed by tool name (AI SDK shape). */
export interface NativeToolsContext {
  read_file: WorkspaceToolContext;
  write_file: WorkspaceToolContext;
  edit_file: WorkspaceToolContext;
  run_command: WorkspaceToolContext;
  list_dir: WorkspaceToolContext;
  search_files: WorkspaceToolContext;
  file_info: WorkspaceToolContext;
  delete_file: WorkspaceToolContext;
  todo: TodoToolContext;
  scheduler: SchedulerToolContext;
}

/** One-shot outside-workspace grant scope for one tool execution. */
function grantScopeFor(threadId: string | undefined, tool: string) {
  return threadId ? { conversationId: threadId, tool } : undefined;
}

/** Fail closed: no workspace root, no execution (never a global fallback). */
function requireWorkspace(context: WorkspaceToolContext | undefined): string {
  // AI SDK validates `toolsContext` against `contextSchema` before `execute`,
  // so a missing root normally fails there with a TypeValidationError. This
  // guard covers direct `execute` invocations (tests, manual surfaces) with
  // the domain error instead.
  if (!context?.workspaceDir) {
    throw new ToolError("No workspace root for this conversation");
  }
  return context.workspaceDir;
}

const runCommandDescription =
  "Run a PowerShell command starting in the workspace directory. The command body itself is NOT sandboxed — only the starting directory is confined, and the command runs with the server's own privileges (absolute paths, directory changes, redirection, and network access are all possible). Requires user approval before executing.";

/** Shared `run_command` definition parts (description + schemas, no execute). */
const runCommandDef = {
  description: runCommandDescription,
  inputSchema: toolSchemas.run_command,
  contextSchema: workspaceContext,
};

/**
 * `run_command` execute with an optional terminal-output tap. The tap is a
 * plain closure because a function cannot ride validated Zod context — the
 * only per-request closure in this module. Without a tap the tool behaves
 * exactly as before (same return shape, same limits).
 */
function runCommandExecute(
  onTerminalOutput?: (toolCallId: string, event: BashOutputEvent) => void,
) {
  return instrumentedExecute(
    "run_command",
    (
      args: z.infer<typeof toolSchemas.run_command>,
      opts?: { context?: WorkspaceToolContext; toolCallId?: string },
    ) =>
      runBash(
        {
          ...args,
          ...(onTerminalOutput
            ? {
                onOutput: (event: BashOutputEvent) => {
                  const id = opts?.toolCallId;
                  if (id) onTerminalOutput(id, event);
                },
              }
            : {}),
        },
        requireWorkspace(opts?.context),
        grantScopeFor(opts?.context?.threadId, "run_command"),
      ),
  );
}

/**
 * The canonical server toolkit: one native AI SDK `tool()` per native tool,
 * instantiated once at module scope. The chat route merges these with the
 * MCP `tool()` set and supplies `toolsContext` per request (see
 * `buildToolsContext`). `run_command` here carries no terminal tap — the
 * route swaps in `withTerminalOutput(...)` for the live-output chain.
 */
export const nativeTools = {
  // ---- Filesystem (sandboxed to the workspace) ----
  read_file: tool({
    description:
      "Read a text file from the workspace. Returns the file content. Runs without approval.",
    inputSchema: toolSchemas.read_file,
    contextSchema: workspaceContext,
    execute: instrumentedExecute(
      "read_file",
      (
        a: z.infer<typeof toolSchemas.read_file>,
        opts?: { context?: WorkspaceToolContext },
      ) =>
        runRead(
          a,
          requireWorkspace(opts?.context),
          grantScopeFor(opts?.context?.threadId, "read_file"),
        ),
    ),
  }),
  write_file: tool({
    description:
      "Write or create a text file in the workspace. Requires user approval before executing.",
    inputSchema: toolSchemas.write_file,
    contextSchema: workspaceContext,
    execute: instrumentedExecute(
      "write_file",
      (
        a: z.infer<typeof toolSchemas.write_file>,
        opts?: { context?: WorkspaceToolContext },
      ) =>
        runWrite(
          a,
          requireWorkspace(opts?.context),
          grantScopeFor(opts?.context?.threadId, "write_file"),
        ),
    ),
  }),
  edit_file: tool({
    description:
      "Replace text in a workspace file. Requires user approval before executing.",
    inputSchema: toolSchemas.edit_file,
    contextSchema: workspaceContext,
    execute: instrumentedExecute(
      "edit_file",
      (
        a: z.infer<typeof toolSchemas.edit_file>,
        opts?: { context?: WorkspaceToolContext },
      ) =>
        runEdit(
          a,
          requireWorkspace(opts?.context),
          grantScopeFor(opts?.context?.threadId, "edit_file"),
        ),
    ),
  }),
  run_command: tool({
    ...runCommandDef,
    execute: runCommandExecute(),
  }),
  list_dir: tool({
    description:
      "List files and folders inside the workspace. Runs without approval.",
    inputSchema: toolSchemas.list_dir,
    contextSchema: workspaceContext,
    execute: instrumentedExecute(
      "list_dir",
      (
        a: z.infer<typeof toolSchemas.list_dir>,
        opts?: { context?: WorkspaceToolContext },
      ) =>
        runList(
          a,
          requireWorkspace(opts?.context),
          grantScopeFor(opts?.context?.threadId, "list_dir"),
        ),
    ),
  }),
  search_files: tool({
    description:
      "Search file contents inside the workspace (case-insensitive). Runs without approval.",
    inputSchema: toolSchemas.search_files,
    contextSchema: workspaceContext,
    execute: instrumentedExecute(
      "search_files",
      (
        a: z.infer<typeof toolSchemas.search_files>,
        opts?: { context?: WorkspaceToolContext },
      ) =>
        runSearch(
          a,
          requireWorkspace(opts?.context),
          grantScopeFor(opts?.context?.threadId, "search_files"),
        ),
    ),
  }),
  file_info: tool({
    description:
      "Show size, type and timestamps for a workspace path. Runs without approval.",
    inputSchema: toolSchemas.file_info,
    contextSchema: workspaceContext,
    execute: instrumentedExecute(
      "file_info",
      (
        a: z.infer<typeof toolSchemas.file_info>,
        opts?: { context?: WorkspaceToolContext },
      ) =>
        runStat(
          a,
          requireWorkspace(opts?.context),
          grantScopeFor(opts?.context?.threadId, "file_info"),
        ),
    ),
  }),
  delete_file: tool({
    description:
      "Delete a file or folder inside the workspace. Requires user approval before executing.",
    inputSchema: toolSchemas.delete_file,
    contextSchema: workspaceContext,
    execute: instrumentedExecute(
      "delete_file",
      (
        a: z.infer<typeof toolSchemas.delete_file>,
        opts?: { context?: WorkspaceToolContext },
      ) =>
        runDelete(
          a,
          requireWorkspace(opts?.context),
          grantScopeFor(opts?.context?.threadId, "delete_file"),
        ),
    ),
  }),
  // ---- Computer ----
  process_list: tool({
    description:
      "List running processes on this computer (pid, name, CPU, memory). Runs without approval.",
    inputSchema: toolSchemas.process_list,
    execute: instrumentedExecute("process_list", () => runProcesses()),
  }),
  process_kill: tool({
    description:
      "Stop a running process by pid. Requires user approval before executing. Cannot kill the app itself or system processes.",
    inputSchema: toolSchemas.process_kill,
    execute: instrumentedExecute(
      "process_kill",
      (a: z.infer<typeof toolSchemas.process_kill>) => runKill(a),
    ),
  }),
  system_info: tool({
    description:
      "Show computer info: OS, CPU, memory and uptime. Runs without approval.",
    inputSchema: toolSchemas.system_info,
    execute: instrumentedExecute("system_info", () => runSysinfo()),
  }),
  // ---- Scheduler (AI-controlled, single action-dispatched tool) ----
  scheduler: tool({
    description:
      "Manage scheduled AI jobs via an `action` selector (create | list | get | update | delete | run_now). " +
      "create requires: name, scheduleType ('once'|'cron'), timezone (IANA), prompt; " +
      "for 'once' also execAt (epoch ms), for 'cron' also cronExpression (5-field). " +
      "providerId, modelId, and workspacePath are optional — when omitted they default to this conversation's provider, model, and workspace. " +
      "get / update / delete / run_now require jobId. list accepts an optional status filter (active|paused|failed|all).",
    inputSchema: toolSchemas.scheduler,
    contextSchema: schedulerContext,
    execute: instrumentedExecute(
      "scheduler",
      (
        a: z.infer<typeof toolSchemas.scheduler>,
        opts?: { context?: SchedulerToolContext },
      ) => {
        const context = opts?.context;
        // The schema is a discriminated union on `action`: narrowing here
        // keeps the create-only defaults injection type-safe, with explicit
        // IDs always winning over the conversation's.
        if (a.action === "create") {
          return runScheduler({
            ...a,
            providerId: a.providerId ?? context?.providerId,
            modelId: a.modelId ?? context?.modelId,
            workspacePath: a.workspacePath ?? context?.workspaceDir,
          });
        }
        return runScheduler(a);
      },
    ),
  }),
  // ---- Todo (per-conversation durable notepad) ----
  todo: tool({
    description:
      "Manage a durable per-conversation to-do list. Actions: add, list, update, toggle, remove, clear. " +
      "Every successful action returns the current list. Runs without approval.",
    inputSchema: toolSchemas.todo,
    contextSchema: todoContext,
    execute: instrumentedExecute(
      "todo",
      (
        a: z.infer<typeof toolSchemas.todo>,
        opts?: { context?: TodoToolContext },
      ) =>
        runTodo(
          a,
          opts?.context?.threadId
            ? { threadId: opts.context.threadId }
            : undefined,
        ),
    ),
  }),
  // ---- Browser: read/navigation (agent-browser CLI, no MCP) ----
  browser: tool({
    description:
      "Browser read/navigation via the agent-browser CLI (external persistent daemon). Actions: open a URL, snapshot the DOM, get page text, screenshot, or extract structured data with a prompt. Runs without approval.",
    inputSchema: toolSchemas.browser,
    execute: instrumentedExecute(
      "browser",
      (
        a: z.infer<typeof toolSchemas.browser>,
        opts?: { abortSignal?: AbortSignal },
      ) => runBrowserRead(a, { abortSignal: opts?.abortSignal }),
    ),
  }),
  // ---- Browser: interactive actions (agent-browser CLI, approval-gated) ----
  browser_action: tool({
    description:
      "Interactive browser actions via the agent-browser CLI requiring approval. Actions: click an element by ref, fill a field, press a key, or perform an AI-driven act. Requires user approval before executing.",
    inputSchema: toolSchemas.browser_action,
    execute: instrumentedExecute(
      "browser_action",
      (
        a: z.infer<typeof toolSchemas.browser_action>,
        opts?: { abortSignal?: AbortSignal },
      ) => runBrowserAction(a, { abortSignal: opts?.abortSignal }),
    ),
  }),
};

/** The precise native tool set type (the `streamText` generic binds to this). */
export type NativeToolSet = typeof nativeTools;

/**
 * `run_command` with live terminal output wired in. Replaces the static
 * entry's execute wholesale (single funnel instrumentation, not stacked):
 * the `toolCallId` comes from the standard AI SDK execute options — the
 * hook for "sending tool-call related information with stream data" — so
 * nearby command calls stay isolated without any extra plumbing.
 */
export function withTerminalOutput(
  onTerminalOutput: (toolCallId: string, event: BashOutputEvent) => void,
): NativeToolSet["run_command"] {
  return tool({
    ...runCommandDef,
    execute: runCommandExecute(onTerminalOutput),
  });
}

/**
 * Build the per-request `toolsContext` map for `streamText`.
 *
 * Fails closed when the conversation has no workspace root (mirrors the old
 * `withThreadContext` guard): a missing root throws `ToolError` here, during
 * tools assembly, rather than silently falling back to the global process
 * workspace. One-shot outside-workspace grants ride the grant scope inside
 * each execute (derived from `threadId`); without a thread there is no scope
 * and outside stays hard-rejected.
 */
export function buildToolsContext(input: {
  workspaceDir: string | undefined;
  threadId?: string;
  providerId?: string;
  modelId?: string;
}): NativeToolsContext {
  const { workspaceDir, threadId, providerId, modelId } = input;
  if (!workspaceDir) {
    throw new ToolError("No workspace root for this conversation");
  }
  const workspace: WorkspaceToolContext = threadId
    ? { workspaceDir, threadId }
    : { workspaceDir };
  return {
    read_file: workspace,
    write_file: workspace,
    edit_file: workspace,
    run_command: workspace,
    list_dir: workspace,
    search_files: workspace,
    file_info: workspace,
    delete_file: workspace,
    todo: threadId ? { threadId } : {},
    scheduler: {
      workspaceDir,
      ...(providerId ? { providerId } : {}),
      ...(modelId ? { modelId } : {}),
    },
  };
}
