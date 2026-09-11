/**
 * TBAi Agent Progress — structured progress model.
 *
 * Stages are high-level work categories derived server-side from actual tool
 * execution. They are NOT per-tool-call; related tools aggregate into one
 * semantic stage (e.g. list_dir + search_files + file_info → "Inspecting
 * workspace").
 */

export type ProgressStatus = "pending" | "active" | "completed" | "failed";

export interface ProgressStage {
  id: string;
  label: string;
  status: ProgressStatus;
}

export interface ProgressData {
  kind: "tbai-progress";
  version: 1;
  stages: ProgressStage[];
}

/**
 * Map every known native tool and any MCP tools we want specific labels for
 * to a high-level stage. Unknown tools fall through to the generic fallback.
 */
export const TOOL_STAGE_MAP: Readonly<Record<string, { id: string; label: string }>> = {
  // Workspace inspection
  list_dir:    { id: "inspect",   label: "Inspecting workspace" },
  search_files:{ id: "search",    label: "Finding relevant files" },
  file_info:   { id: "inspect",   label: "Inspecting workspace" },

  // Reading
  read_file:   { id: "read",      label: "Reading files" },

  // Modifying
  write_file:  { id: "modify",    label: "Modifying files" },
  edit_file:   { id: "modify",    label: "Modifying files" },
  delete_file: { id: "modify",    label: "Modifying files" },

  // Execution / verification
  run_command: { id: "run",       label: "Running commands" },

  // System
  process_list:     { id: "system", label: "Inspecting system" },
  process_kill:     { id: "system", label: "Managing processes" },
  system_info:      { id: "system", label: "Inspecting system" },
};

const DEFAULT_STAGE = { id: "execute", label: "Executing tools" };

/**
 * Resolve the canonical stage definition for a tool name.
 * MCP / unknown tools get the generic fallback.
 */
export function resolveStage(toolName: string): { id: string; label: string } {
  return TOOL_STAGE_MAP[toolName] ?? DEFAULT_STAGE;
}
