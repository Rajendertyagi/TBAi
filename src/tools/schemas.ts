/**
 * Single source of truth for every native tool's Zod input schema.
 *
 * The server toolkit (`src/tools/index.ts`, consumed by `AISDKToolkit`) and the
 * client `defineToolkit` both derive from these. Schemas are pure (no server
 * imports) so they are safe to share across the Bun backend and the Vite
 * frontend. The 11 filesystem/computer schemas are re-exported from
 * `lib/validation.ts` (the API boundary); the 6 scheduler schemas mirror the
 * REST job schemas so a model-driven job and a UI-created job validate alike.
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
  schedulerJobCreateSchema,
  schedulerJobUpdateSchema,
  schedulerToolIdSchema,
  schedulerToolRunSchema,
  schedulerToolListSchema,
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
  // Scheduler (AI-controlled)
  create_scheduled_job: schedulerJobCreateSchema,
  list_scheduled_jobs: schedulerToolListSchema,
  get_scheduled_job: schedulerToolIdSchema,
  update_scheduled_job: schedulerJobUpdateSchema,
  delete_scheduled_job: schedulerToolIdSchema,
  run_scheduled_job_now: schedulerToolRunSchema,
} as const;

export type ToolName = keyof typeof toolSchemas;
