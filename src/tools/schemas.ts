/**
 * Single source of truth for every native tool's Zod input schema.
 *
 * The server toolkit (`src/tools/index.ts`, consumed by `AISDKToolkit`) and the
 * client `defineToolkit` both derive from these. Schemas are pure (no server
 * imports) so they are safe to share across the Bun backend and the Vite
 * frontend. The 11 filesystem/computer schemas are re-exported from
 * `lib/validation.ts` (the API boundary); the scheduler schemas mirror the
 * REST job schemas so a model-driven job and a UI-created job validate alike.
 * The todo and browser schemas are likewise re-exported here as the single
 * source of truth for both the server `AISDKToolkit` and the client
 * `defineToolkit`.
 */
import { z } from "zod";
import {
  toolReadSchema,
  toolWriteSchema,
  toolEditSchema,
  toolBashSchema,
  toolListSchema,
  toolSearchSchema,
  toolStatSchema,
  toolDeleteSchema,
  toolKillSchema,
  schedulerSchema,
  todoSchema,
  browserReadSchema,
  browserActionSchemaFull,
} from "../lib/validation";

export const toolSchemas = {
  // Filesystem
  read_file: toolReadSchema,
  write_file: toolWriteSchema,
  edit_file: toolEditSchema,
  run_command: toolBashSchema,
  list_dir: toolListSchema,
  search_files: toolSearchSchema,
  file_info: toolStatSchema,
  delete_file: toolDeleteSchema,
  // Computer
  process_list: z.object({}),
  process_kill: toolKillSchema,
  system_info: z.object({}),
  // Scheduler (AI-controlled, single action-dispatched tool)
  scheduler: schedulerSchema,
  // Todo (per-conversation notepad)
  todo: todoSchema,
  // Browser (native agent-browser CLI, no MCP)
  browser: browserReadSchema,
  browser_action: browserActionSchemaFull,
} as const;

export type ToolName = keyof typeof toolSchemas;
