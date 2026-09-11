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
} from "../services/tools";
import { schedulerToolHandlers } from "../services/scheduler/schedulerTools";

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
  // ---- Scheduler (AI-controlled) ----
  create_scheduled_job: {
    type: "backend",
    description:
      "Create a scheduled AI job that runs automatically (once at a timestamp or on a cron schedule). Required: name, scheduleType ('once'|'cron'), timezone (IANA), providerId, modelId, workspacePath, prompt. For 'once' also execAt (epoch ms); for 'cron' also cronExpression (5-field). Returns the created job summary.",
    parameters: js(toolSchemas.create_scheduled_job),
    execute: (a) => schedulerToolHandlers.create(a),
  },
  list_scheduled_jobs: {
    type: "backend",
    description:
      "List all scheduler jobs with their status and next run time. Returns a summary array (no full prompts).",
    parameters: js(toolSchemas.list_scheduled_jobs),
    execute: () => schedulerToolHandlers.list(),
  },
  get_scheduled_job: {
    type: "backend",
    description:
      "Get full details of one scheduler job by id, including its prompt.",
    parameters: js(toolSchemas.get_scheduled_job),
    execute: (a) => schedulerToolHandlers.get(a),
  },
  update_scheduled_job: {
    type: "backend",
    description:
      "Update an existing scheduler job by id. Any subset of fields may be provided. Re-validates schedule and reschedules the timer. Returns the updated summary.",
    parameters: js(toolSchemas.update_scheduled_job),
    execute: (a) => schedulerToolHandlers.update(a),
  },
  delete_scheduled_job: {
    type: "backend",
    description:
      "Soft-delete a scheduler job by id: stops scheduling and hides it, retaining run history.",
    parameters: js(toolSchemas.delete_scheduled_job),
    execute: (a) => schedulerToolHandlers.delete(a),
  },
  run_scheduled_job_now: {
    type: "backend",
    description:
      "Trigger an immediate manual run of a scheduler job by id (a fresh occurrence, independent of its schedule). Returns the run id.",
    parameters: js(toolSchemas.run_scheduled_job_now),
    execute: (a) => schedulerToolHandlers.runNow(a),
  },
};

/**
 * The canonical server toolkit. Instantiated once at module scope so any MCP
 * connections it opens would pool across requests. Consumed by the chat route
 * via `aiToolkit.tools()`.
 */
export const aiToolkit = new AISDKToolkit({ toolkit: entries as any });
