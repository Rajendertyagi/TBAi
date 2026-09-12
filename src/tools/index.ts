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
  type BashOutputEvent,
} from "../services/tools";
import { runScheduler } from "../services/scheduler/schedulerTools";
import { runTodo } from "../services/todos";
import { runBrowserRead, runBrowserAction } from "../services/browser";

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
    execute: (a) => runRead(a),
  },
  write_file: {
    type: "backend",
    description:
      "Write or create a text file in the workspace. Requires user approval before executing.",
    parameters: js(toolSchemas.write_file),
    execute: (a) => runWrite(a),
  },
  edit_file: {
    type: "backend",
    description:
      "Replace text in a workspace file. Requires user approval before executing.",
    parameters: js(toolSchemas.edit_file),
    execute: (a) => runEdit(a),
  },
  run_command: {
    type: "backend",
    description:
      "Run a shell command inside the workspace. Requires user approval before executing.",
    parameters: js(toolSchemas.run_command),
    execute: (a) => runBash(a),
  },
  list_dir: {
    type: "backend",
    description:
      "List files and folders inside the workspace. Runs without approval.",
    parameters: js(toolSchemas.list_dir),
    execute: (a) => runList(a),
  },
  search_files: {
    type: "backend",
    description:
      "Search file contents inside the workspace (case-insensitive). Runs without approval.",
    parameters: js(toolSchemas.search_files),
    execute: (a) => runSearch(a),
  },
  file_info: {
    type: "backend",
    description:
      "Show size, type and timestamps for a workspace path. Runs without approval.",
    parameters: js(toolSchemas.file_info),
    execute: (a) => runStat(a),
  },
  delete_file: {
    type: "backend",
    description:
      "Delete a file or folder inside the workspace. Requires user approval before executing.",
    parameters: js(toolSchemas.delete_file),
    execute: (a) => runDelete(a),
  },
  // ---- Computer ----
  process_list: {
    type: "backend",
    description:
      "List running processes on this computer (pid, name, CPU, memory). Runs without approval.",
    parameters: js(toolSchemas.process_list),
    execute: () => runProcesses(),
  },
  process_kill: {
    type: "backend",
    description:
      "Stop a running process by pid. Requires user approval before executing. Cannot kill the app itself or system processes.",
    parameters: js(toolSchemas.process_kill),
    execute: (a) => runKill(a),
  },
  system_info: {
    type: "backend",
    description:
      "Show computer info: OS, CPU, memory and uptime. Runs without approval.",
    parameters: js(toolSchemas.system_info),
    execute: () => runSysinfo(),
  },
  // ---- Scheduler (AI-controlled, single action-dispatched tool) ----
  scheduler: {
    type: "backend",
    description:
      "Manage scheduled AI jobs via an `action` selector (create | list | get | update | delete | run_now). " +
      "create requires: name, scheduleType ('once'|'cron'), timezone (IANA), providerId, modelId, workspacePath, prompt; " +
      "for 'once' also execAt (epoch ms), for 'cron' also cronExpression (5-field). " +
      "get / update / delete / run_now require jobId. list accepts an optional status filter (active|paused|failed|all).",
    parameters: js(toolSchemas.scheduler),
    execute: (a) => runScheduler(a),
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
    execute: (a) => runTodo(a as any),
  },
  // ---- Browser: read/navigation (agent-browser CLI, no MCP) ----
  browser: {
    type: "backend",
    description:
      "Browser read/navigation via the agent-browser CLI (external persistent daemon). Actions: open a URL, snapshot the DOM, get page text, screenshot, or extract structured data with a prompt. Runs without approval.",
    parameters: js(toolSchemas.browser),
    execute: (a) => runBrowserRead(a as any),
  },
  // ---- Browser: interactive actions (agent-browser CLI, approval-gated) ----
  browser_action: {
    type: "backend",
    description:
      "Interactive browser actions via the agent-browser CLI requiring approval. Actions: click an element by ref, fill a field, press a key, or perform an AI-driven act. Requires user approval before executing.",
    parameters: js(toolSchemas.browser_action),
    execute: (a) => runBrowserAction(a as any),
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
): any {
  if (threadId && tools.todo) {
    tools.todo = {
      ...tools.todo,
      execute: (args: unknown) => runTodo(args as any, { threadId }),
    };
  }
  if (onTerminalOutput && tools.run_command) {
    tools.run_command = {
      ...tools.run_command,
      execute: (args: unknown, opts?: { toolCallId?: string }) =>
        runBash({
          ...(args as { command: string; cwd?: string }),
          onOutput: (event) => {
            const id = opts?.toolCallId;
            if (id) onTerminalOutput(id, event);
          },
        }),
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
