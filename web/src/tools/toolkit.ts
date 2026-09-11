import { defineToolkit } from "@assistant-ui/react";
import {
  ReadFileToolUI,
  ListDirToolUI,
  SearchFilesToolUI,
  FileInfoToolUI,
  WriteFileToolUI,
  EditFileToolUI,
  DeleteFileToolUI,
} from "./filesystem/ui";
import {
  ProcessListToolUI,
  ProcessKillToolUI,
  SystemInfoToolUI,
  BashToolUI,
} from "./computer/ui";

/**
 * Canonical native toolkit (assistant-ui Toolkit architecture).
 *
 * All 11 native tools are `type: "backend"` render-only entries: the
 * model-facing contract AND execution live server-side
 * (src/routes/index.ts `nativeTools`, executed in streamText). Privileged
 * tools pause at the server `toolApproval` gate, which these renderers answer
 * via `respondToApproval()`. No client-side execution, no fetches, no
 * addResult, no human tools.
 *
 * Authored with explicit `type` fields (no "use generative" compiler — the
 * project has no @assistant-ui/vite plugin; defineToolkit passes entries
 * through unchanged). Never call the marker factories (humanTool(),
 * externalTool(), …) — they throw at runtime by design.
 *
 * MCP/dynamic tools are intentionally NOT registered here; they render via
 * ToolFallback in ChatWindow.
 */
export const nativeToolkit = defineToolkit({
  read_file: { type: "backend", render: ReadFileToolUI },
  list_dir: { type: "backend", render: ListDirToolUI },
  search_files: { type: "backend", render: SearchFilesToolUI },
  file_info: { type: "backend", render: FileInfoToolUI },
  // Approval-gated tools render standalone so their cards stay visible
  // outside collapsed tool groups (docs' display guidance).
  write_file: { type: "backend", display: "standalone", render: WriteFileToolUI },
  edit_file: { type: "backend", display: "standalone", render: EditFileToolUI },
  delete_file: { type: "backend", display: "standalone", render: DeleteFileToolUI },
  run_command: { type: "backend", display: "standalone", render: BashToolUI },
  process_list: { type: "backend", render: ProcessListToolUI },
  process_kill: { type: "backend", display: "standalone", render: ProcessKillToolUI },
  system_info: { type: "backend", render: SystemInfoToolUI },
});

export const NATIVE_TOOL_NAMES = Object.keys(nativeToolkit);
