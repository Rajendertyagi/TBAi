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
} from "./computer/ui";
import { RunCommandTerminalUI } from "./computer/terminal-ui";
import { SchedulerToolUI } from "./scheduler/ui";
import { TodoToolUI } from "./todo/ui";
import { BrowserToolUI, BrowserActionToolUI } from "./browser/ui";
import {
  OpenCodeReadToolUI,
  OpenCodeGlobToolUI,
  OpenCodeGrepToolUI,
  OpenCodeBashToolUI,
  OpenCodeEditToolUI,
  OpenCodeWriteToolUI,
  OpenCodeTaskToolUI,
  OpenCodeTodoWriteToolUI,
  OpenCodeWebFetchToolUI,
  OpenCodeWebSearchToolUI,
  OpenCodeSkillToolUI,
  OpenCodeQuestionToolUI,
} from "./opencode/ui";

/**
 * Canonical native toolkit (assistant-ui Toolkit architecture).
 *
 * All native tools are `type: "backend"` render-only entries: the
 * model-facing contract AND execution live server-side (src/tools/index.ts,
 * assembled into the assistant-ui AISDKToolkit and executed in streamText).
 * Privileged tools pause at the server `toolApproval` gate, which these
 * renderers answer via `respondToApproval()`. No client-side execution, no
 * fetches, no addResult, no human tools.
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
  run_command: { type: "backend", display: "standalone", render: RunCommandTerminalUI },
  process_list: { type: "backend", render: ProcessListToolUI },
  process_kill: { type: "backend", display: "standalone", render: ProcessKillToolUI },
  system_info: { type: "backend", render: SystemInfoToolUI },
  // Scheduler (AI-controlled): one backend tool, action-dispatched.
  scheduler: { type: "backend", display: "standalone", render: SchedulerToolUI },
  // Todo (per-conversation notepad)
  todo: { type: "backend", display: "standalone", render: TodoToolUI },
  // Browser (native agent-browser CLI, no MCP)
  browser: { type: "backend", display: "standalone", render: BrowserToolUI },
  browser_action: { type: "backend", display: "standalone", render: BrowserActionToolUI },
});

export const NATIVE_TOOL_NAMES = Object.keys(nativeToolkit);

/**
 * Renderers for OpenCode's OWN tool names (Code mode).
 *
 * These are NOT native TBAi tools and deliberately live in a separate registry
 * so `nativeToolkit` keeps meaning "the native tools": the server
 * (`src/tools/index.ts`) is the single authority for what the model may call,
 * and this registry only answers "which component draws this part". Code mode
 * sends `read`/`glob`/`grep`/`bash`/… — names that match none of our native
 * tools — so without these entries every Code tool call fell through to the
 * generic `ToolFallback`.
 *
 * Only tools that are NOT permission-gated are mapped here; the gated ones
 * (`bash`, `edit`, `write`) follow once their approval parity is verified, so
 * no tool can reach a rich UI that lacks the stale-permission guard.
 *
 * Their arguments are OpenCode's, not ours, and are normalized per tool in
 * `tools/opencode/adapt.ts` — see that file for where each field name was
 * verified.
 */
export const openCodeToolkit = defineToolkit({
  read: { type: "backend", render: OpenCodeReadToolUI },
  glob: { type: "backend", render: OpenCodeGlobToolUI },
  grep: { type: "backend", render: OpenCodeGrepToolUI },
  // Permission-gated, so `standalone` — the same rule the native entries above
  // follow, keeping their approval cards out of a collapsed tool group. They
  // are only mapped now that `ApprovalGate` carries the stale-permission guard
  // (Phase 3A); before that, a rich UI here would have re-created the wedge on
  // the very tools that hit it.
  bash: { type: "backend", display: "standalone", render: OpenCodeBashToolUI },
  edit: { type: "backend", display: "standalone", render: OpenCodeEditToolUI },
  write: { type: "backend", display: "standalone", render: OpenCodeWriteToolUI },
  // Not permission-gated, so they render inline like read/glob/grep.
  // `GET /experimental/tool?provider=<p>&model=<m>` supplied every argument
  // name these read — see `tools/opencode/ui.tsx`.
  task: { type: "backend", render: OpenCodeTaskToolUI },
  todowrite: { type: "backend", display: "standalone", render: OpenCodeTodoWriteToolUI },
  webfetch: { type: "backend", render: OpenCodeWebFetchToolUI },
  websearch: { type: "backend", render: OpenCodeWebSearchToolUI },
  skill: { type: "backend", render: OpenCodeSkillToolUI },
  // Standalone because it is an interactive prompt the reader must see, not
  // because it is gated. Registering it is also the fix for the
  // "Runtime does not support tool results" crash: an unregistered `question`
  // part fell through to `ToolFallback`, whose approval card answers through
  // `addResult`, which this runtime does not implement.
  question: { type: "backend", display: "standalone", render: OpenCodeQuestionToolUI },
});

export const OPENCODE_TOOL_NAMES = Object.keys(openCodeToolkit);

/**
 * What actually gets registered. A single object because `Tools({ toolkit })`
 * takes one registry; the two sources stay separate above so each can be
 * asserted on its own terms.
 */
export const appToolkit = defineToolkit({
  ...nativeToolkit,
  ...openCodeToolkit,
});
