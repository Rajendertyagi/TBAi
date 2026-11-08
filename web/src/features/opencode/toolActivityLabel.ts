import { toolsConfig } from "@/config/tools";

/**
 * The running label for an OpenCode tool call.
 *
 * This is the OpenCode owner of the tool vocabulary the engine-neutral
 * `activityFromParts` analyzer takes as `toolLabel`. Each label is the same
 * `toolsConfig.copy.running` verb the tool's own card already shows in
 * `tools/opencode/ui.tsx`, so the activity row and the card never describe one
 * call two ways. The names are the tools OpenCode v2 ships (`v2Tools.ts`); the
 * aliases are the v1 spellings v2 still accepts, kept so a build that emits one
 * gets the same verb instead of a raw fallback.
 *
 * The verbs live here, not in `config/tools.ts`: the shared config holds the
 * copy, this feature owns which OpenCode tool maps to which verb.
 */
export function opencodeToolActivityLabel(toolName: string): string {
  const c = toolsConfig.copy.running;
  switch (toolName) {
    case "read":
      return c.reading;
    case "write":
      return c.writing;
    case "edit":
      return c.editing;
    case "patch":
      return c.applyingPatch;
    case "shell":
    case "bash":
      return c.running;
    case "execute":
      return c.runningScript;
    case "glob":
      return c.findingFiles;
    case "grep":
      return c.searching;
    case "websearch":
      return c.searchingWeb;
    case "webfetch":
      return c.fetching;
    case "skill":
      return c.loadingSkill;
    case "subagent":
    case "task":
      return c.runningSubagent;
    case "question":
      return c.waitingForAnswer;
    default:
      return `${toolName}…`;
  }
}
