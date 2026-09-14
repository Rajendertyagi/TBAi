/**
 * Server-side native toolkit (assistant-ui `AISDKToolkit`).
 *
 * This is the single server assembly of every native tool. `AISDKToolkit`
 * converts it into an AI SDK `ToolSet` for `streamText`, with each tool's
 * `execute` running server-side and its `parameters` exposed to the model as a
 * JSON Schema (derived from the shared Zod schemas in `./schemas`).
 *
 * The schemas and `execute` functions live in shared modules
 * (`lib/validation.ts`, `services/tools.ts`, `services/scheduler/schedulerTools.ts`)
 * so the client `defineToolkit` (web/src/tools/toolkit.ts) renders the same
 * tools without duplicating logic. `AISDKToolkit` is the current, non-deprecated
 * official server API; it also merges frontend-uploaded and MCP tools when used.
 */
import { AISDKToolkit } from "@assistant-ui/ai-sdk";
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
  WORKSPACE_DIR,
  type BashOutputEvent,
} from "../services/tools";
import { runScheduler } from "../services/scheduler/schedulerTools";
import { runTodo } from "../services/todos";
import { runBrowserRead, runBrowserAction } from "../services/browser";
import { instrumentedExecute } from "../lib/tool-funnel";

type ServerToolEntry = {
  type: "backend";
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: any) => unknown | Promise<unknown>;
};

/** Convert a Zod schema to the JSON Schema shape `AISDKToolkit` expects. */
const js = (schema: z.ZodTypeAny): Record<string, unknown> =>
  z.toJSONSchema(schema) as Record<string, unknown>;

const entries: Record<string, ServerToolEntry> = {
  // ---- Filesystem (sandboxed to the workspace) ----
  read_file: {
    type: "backend",
    description:
      "Read a text file from the workspace. Returns the file content. Runs without approval.",
    parameters: js(toolSchemas.read_file),
    execute: instrumentedExecute("read_file", (a) => runRead(a, WORKSPACE_DIR)),
  },
  write_file: {
    type: "backend",
    description:
      "Write or create a text file in the workspace. Requires user approval before executing.",
    parameters: js(toolSchemas.write_file),
    execute: instrumentedExecute("write_file", (a) => runWrite(a, WORKSPACE_DIR)),
  },
  edit_file: {
    type: "backend",
    description:
      "Replace text in a workspace file. Requires user approval before executing.",
    parameters: js(toolSchemas.edit_file),
    execute: instrumentedExecute("edit_file", (a) => runEdit(a, WORKSPACE_DIR)),
  },
  run_command: {
    type: "backend",
    description:
      "Run a PowerShell command starting in the workspace directory. The command body itself is NOT sandboxed — only the starting directory is confined, and the command runs with the server's own privileges (absolute paths, directory changes, redirection, and network access are all possible). Requires user approval before executing.",
    parameters: js(toolSchemas.run_command),
    execute: instrumentedExecute("run_command", (a) => runBash(a, WORKSPACE_DIR)),
  },
  list_dir: {
    type: "backend",
    description:
      "List files and folders inside the workspace. Runs without approval.",
    parameters: js(toolSchemas.list_dir),
    execute: instrumentedExecute("list_dir", (a) => runList(a, WORKSPACE_DIR)),
  },
  search_files: {
    type: "backend",
    description:
      "Search file contents inside the workspace (case-insensitive). Runs without approval.",
    parameters: js(toolSchemas.search_files),
    execute: instrumentedExecute("search_files", (a) => runSearch(a, WORKSPACE_DIR)),
  },
  file_info: {
    type: "backend",
    description:
      "Show size, type and timestamps for a workspace path. Runs without approval.",
    parameters: js(toolSchemas.file_info),
    execute: instrumentedExecute("file_info", (a) => runStat(a, WORKSPACE_DIR)),
  },
  delete_file: {
    type: "backend",
    description:
      "Delete a file or folder inside the workspace. Requires user approval before executing.",
    parameters: js(toolSchemas.delete_file),
    execute: instrumentedExecute("delete_file", (a) => runDelete(a, WORKSPACE_DIR)),
  },
  // ---- Computer ----
  process_list: {
    type: "backend",
    description:
      "List running processes on this computer (pid, name, CPU, memory). Runs without approval.",
    parameters: js(toolSchemas.process_list),
    execute: instrumentedExecute("process_list", () => runProcesses()),
  },
  process_kill: {
    type: "backend",
    description:
      "Stop a running process by pid. Requires user approval before executing. Cannot kill the app itself or system processes.",
    parameters: js(toolSchemas.process_kill),
    execute: instrumentedExecute("process_kill", (a) => runKill(a)),
  },
  system_info: {
    type: "backend",
    description:
      "Show computer info: OS, CPU, memory and uptime. Runs without approval.",
    parameters: js(toolSchemas.system_info),
    execute: instrumentedExecute("system_info", () => runSysinfo()),
  },
  // ---- Scheduler (AI-controlled, single action-dispatched tool) ----
  scheduler: {
    type: "backend",
    description:
      "Manage scheduled AI jobs via an `action` selector (create | list | get | update | delete | run_now). " +
      "create requires: name, scheduleType ('once'|'cron'), timezone (IANA), prompt; " +
      "for 'once' also execAt (epoch ms), for 'cron' also cronExpression (5-field). " +
      "providerId, modelId, and workspacePath are optional — when omitted they default to this conversation's provider, model, and workspace. " +
      "get / update / delete / run_now require jobId. list accepts an optional status filter (active|paused|failed|all).",
    parameters: js(toolSchemas.scheduler),
    execute: instrumentedExecute("scheduler", (a) => runScheduler(a)),
  },
  // ---- Todo (per-conversation durable notepad) ----
  todo: {
    type: "backend",
    description:
      "Manage a durable per-conversation to-do list. Actions: add, list, update, toggle, remove, clear. " +
      "Every successful action returns the current list. Runs without approval.",
    parameters: js(toolSchemas.todo),
    // threadId is injected per request in `withThreadContext` (chat route); the
    // static entry rejects when no thread context is available.
    execute: instrumentedExecute("todo", (a) => runTodo(a as any)),
  },
  // ---- Browser: read/navigation (agent-browser CLI, no MCP) ----
  browser: {
    type: "backend",
    description:
      "Browser read/navigation via the agent-browser CLI (external persistent daemon). Actions: open a URL, snapshot the DOM, get page text, screenshot, or extract structured data with a prompt. Runs without approval.",
    parameters: js(toolSchemas.browser),
    execute: instrumentedExecute("browser", (a) => runBrowserRead(a as any)),
  },
  // ---- Browser: interactive actions (agent-browser CLI, approval-gated) ----
  browser_action: {
    type: "backend",
    description:
      "Interactive browser actions via the agent-browser CLI requiring approval. Actions: click an element by ref, fill a field, press a key, or perform an AI-driven act. Requires user approval before executing.",
    parameters: js(toolSchemas.browser_action),
    execute: instrumentedExecute("browser_action", (a) => runBrowserAction(a as any)),
  },
};

/**
 * Bind request-scoped context into the native toolkit. `AISDKToolkit` strips
 * AI SDK `runtimeContext` from the `execute` second argument, so thread
 * identity is supplied here via a per-request closure over the freshly-built
 * `ToolSet`. Only `todo` needs thread context today.
 *
 * `onTerminalOutput`, when provided, wires `run_command` incremental output
 * into the caller (the chat route forwards it as `data-tbai-terminal` parts).
 * The toolCallId comes from the standard AI SDK execute options — documented
 * there as the hook for "sending tool-call related information with stream
 * data" — so nearby command calls stay isolated without any extra plumbing.
 */
export function withThreadContext(
  tools: any,
  threadId: string | undefined,
  onTerminalOutput?: (toolCallId: string, event: BashOutputEvent) => void,
  workspaceDir?: string,
  chatDefaults?: { providerId?: string; modelId?: string },
): any {
  // Conversation-bound binding: the workspace root is REQUIRED. A missing
  // root fails closed here rather than silently falling back to the global
  // process workspace. (The static `entries` defaults below still target
  // WORKSPACE_DIR explicitly — they are the pre-bind shape, always replaced
  // by this function on the chat path.)
  if (!workspaceDir) {
    throw new ToolError("No workspace root for this conversation");
  }
  // All filesystem / terminal tools resolve against the conversation's resolved
  // workspace directory (simple = disposable, project = registered folder). The
  // model can never supply a different root — `resolveSafe` confines every path.
  // One-shot outside-workspace grants (if the user approved one) ride along as
  // the grant scope; without a thread there is no scope and outside stays hard.
  const ws = workspaceDir;
  const scopeFor = (tool: string) =>
    threadId ? { conversationId: threadId, tool } : undefined;
  const wrap = (name: string, fn: (args: any) => unknown) => {
    if (tools[name]) {
      tools[name] = { ...tools[name], execute: instrumentedExecute(name, fn) };
    }
  };
  wrap("read_file", (a) => runRead(a, ws, scopeFor("read_file")));
  wrap("write_file", (a) => runWrite(a, ws, scopeFor("write_file")));
  wrap("edit_file", (a) => runEdit(a, ws, scopeFor("edit_file")));
  wrap("list_dir", (a) => runList(a, ws, scopeFor("list_dir")));
  wrap("search_files", (a) => runSearch(a, ws, scopeFor("search_files")));
  wrap("file_info", (a) => runStat(a, ws, scopeFor("file_info")));
  wrap("delete_file", (a) => runDelete(a, ws, scopeFor("delete_file")));

  if (onTerminalOutput && tools.run_command) {
    tools.run_command = {
      ...tools.run_command,
      execute: instrumentedExecute("run_command", (args: unknown, opts?: { toolCallId?: string }) =>
        runBash(
          {
            ...(args as { command: string; cwd?: string }),
            onOutput: (event) => {
              const id = opts?.toolCallId;
              if (id) onTerminalOutput(id, event);
            },
          },
          ws,
          scopeFor("run_command"),
        ),
      ),
    };
  }
  if (threadId && tools.todo) {
    tools.todo = {
      ...tools.todo,
      execute: instrumentedExecute("todo", (args: unknown) => runTodo(args as any, { threadId })),
    };
  }
  if (tools.scheduler) {
    // Default the current conversation's provider/model/workspace into
    // scheduler creates — the model cannot guess provider cuid values, so
    // explicit IDs stay optional overrides. The inner execute is already
    // instrumented once; this wrapper only fills omissions (no double log).
    // It MUST forward the second (options) argument untouched: the incoming
    // execute is the framework's (args, callOptions) wrapper and drops it at
    // the cost of a callOptions.toolCallId TypeError on every scheduler call.
    const inner = tools.scheduler.execute;
    tools.scheduler = {
      ...tools.scheduler,
      execute: (args: unknown, opts?: unknown) => {
        const a = (args ?? {}) as Record<string, unknown>;
        if (a.action === "create") {
          return (inner as (filled: unknown, o?: unknown) => unknown)(
            {
              ...a,
              providerId: a.providerId ?? chatDefaults?.providerId,
              modelId: a.modelId ?? chatDefaults?.modelId,
              workspacePath: a.workspacePath ?? ws,
            },
            opts,
          );
        }
        return (inner as (filled: unknown, o?: unknown) => unknown)(a, opts);
      },
    };
  }
  return tools;
}

/**
 * The canonical server toolkit. Instantiated once at module scope so any MCP
 * connections it opens would pool across requests. Consumed by the chat route
 * via `aiToolkit.tools()`.
 */
export const aiToolkit = new AISDKToolkit({ toolkit: entries as any });
