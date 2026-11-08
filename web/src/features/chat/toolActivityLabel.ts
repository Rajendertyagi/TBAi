import { toolsConfig } from "@/config/tools";

/**
 * The running label for a Direct tool call.
 *
 * Direct's own tool names are the only ones mapped here (`read_file`,
 * `write_file`, `edit_file`, `run_command`, `search_files`, …). Code mode has
 * its own resolver in `features/opencode/toolActivityLabel.ts`, which owns the
 * OpenCode spellings — `shell`, `execute` and `patch` are not Direct tools and
 * deliberately fall through to the name fallback here.
 */
export function toolActivityLabel(toolName: string): string {
  const c = toolsConfig.copy.running;
  switch (toolName) {
    case "read":
    case "read_file":
      return c.reading;
    case "write":
    case "write_file":
      return c.writing;
    case "edit":
    case "edit_file":
      return c.editing;
    case "bash":
    case "run_command":
      return c.running;
    case "glob":
    case "find_files":
      return c.findingFiles;
    case "grep":
    case "search_files":
      return c.searching;
    case "websearch":
      return c.searchingWeb;
    case "webfetch":
      return c.fetching;
    case "question":
      return c.waitingForAnswer;
    case "skill":
      return c.loadingSkill;
    case "subagent":
      return c.runningSubagent;
    default:
      return `${toolName}…`;
  }
}
