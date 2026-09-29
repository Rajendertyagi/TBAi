/**
 * TBAi-owned copy and metadata for the OpenCode Configuration settings page.
 *
 * ## Why this is separate from the OpenCode boundary
 *
 * `features/opencode/openCodeConfig.ts` owns the wire shape and the read/write
 * calls. This owns everything the page needs to SAY. Keeping them apart means a
 * wording change is a one-file edit here, and the boundary module stays free of
 * presentation concerns.
 *
 * ## Effect descriptions come from OpenCode, not from us
 *
 * Each description states what OpenCode DOES with the rule, taken from its
 * published permission semantics. An unrecognised action gets a generic
 * description rather than a guess — the page must not assert meaning for a tool
 * it does not know.
 */
import type { OpenCodePermissionEffect } from "@/features/opencode/openCodeConfig";

/** The three effects, in the order a selector should offer them. */
export const openCodeConfigEffects: readonly OpenCodePermissionEffect[] = [
  "allow",
  "ask",
  "deny",
] as const;

/** Human label for an effect. */
export const effectLabel: Record<OpenCodePermissionEffect, string> = {
  allow: "Allow",
  ask: "Ask",
  deny: "Deny",
};

/**
 * What each effect means, in OpenCode's own terms.
 *
 * `deny` is a block, not a warning: OpenCode refuses the call outright, and the
 * agent loop does not continue past it. `ask` is a prompt the user answers with
 * once / always / reject.
 */
export const effectDescription: Record<OpenCodePermissionEffect, string> = {
  allow: "Run without asking.",
  ask: "Ask before running.",
  deny: "Block. The agent cannot run this.",
};

/**
 * One-line description of a permission action, keyed by OpenCode's action name.
 *
 * Only actions the published OpenCode docs describe appear here. A missing key
 * is not a bug: `actionDescription` falls back to a neutral line, because
 * asserting a meaning for an action we have not verified would be worse than
 * saying nothing.
 */
const actionDescriptions: Record<string, string> = {
  question: "Ask the user a question during execution.",
  todowrite: "Write the agent's task list.",
  read: "Read a file.",
  edit: "Modify a file — covers edit, write and patch.",
  write: "Modify a file — covered by the edit action.",
  patch: "Apply a patch — covered by the edit action.",
  glob: "Find files by pattern.",
  grep: "Search file contents.",
  list: "List directory contents.",
  ls: "List directory contents.",
  webfetch: "Fetch a URL.",
  websearch: "Search the web.",
  shell: "Run a shell command.",
  bash: "Run a shell command — the shell action.",
  task: "Launch a subagent.",
  subagent: "Launch a subagent — the task action.",
  lsp: "Run a language-server query.",
  skill: "Load a skill.",
  external_directory: "Touch a path outside the working directory.",
  doom_loop: "The same tool call repeating with identical input.",
  "provider.use": "Use a provider.",
  permission: "Override a permission check outright.",
};

/**
 * The description for an action, or a neutral line for one we do not know.
 *
 * @param action - OpenCode's action name.
 * @returns A sentence describing what the action covers.
 */
export function actionDescription(action: string): string {
  return (
    actionDescriptions[action] ??
    "An action this app does not have a description for."
  );
}

/** UI copy for the page. */
export const openCodeConfigCopy = {
  page: {
    title: "OpenCode Configuration",
    description:
      "The real OpenCode configuration the managed Code server reads. Editing here changes that file — OpenCode stays the source of truth.",
  },
  sections: {
    source: "Configuration source",
    permissions: "Permissions",
    json: "Native OpenCode JSON",
  },
  source: {
    active: "Editing this file",
    description:
      "OpenCode reports several configuration sources. The one carrying your permission rules is the effective policy; the others are merged underneath it.",
    discovered: "All sources OpenCode reported, in precedence order",
  },
  permissions: {
    description:
      "OpenCode evaluates these rules in order and the last matching rule wins, so position is part of each rule's meaning.",
    effect: "Effect",
    empty: "This configuration has no permission rules, so OpenCode uses its own defaults.",
    noKey:
      "This configuration has no permissions key. OpenCode is using its built-in defaults.",
    skipped: (count: number) =>
      `${count} rule${count === 1 ? "" : "s"} could not be read and ${count === 1 ? "is" : "are"} not shown. Nothing was changed.`,
    notConfigurable: (action: string) =>
      `No rule matches "${action}", so OpenCode is using its default for it. Add a rule to the configuration to control it.`,
  },
  json: {
    description:
      "The configuration file exactly as it is on disk, including any field this page does not model.",
    empty: "The file is empty or does not exist yet.",
  },
  save: {
    idle: "Save",
    saving: "Saving…",
    saved: "Saved to the OpenCode configuration.",
    unchanged: "Already set to this effect. Nothing was written.",
    dirty: "Unsaved change",
  },
  states: {
    loading: "Reading the OpenCode configuration…",
    error: "Could not read the OpenCode configuration.",
    malformed:
      "This configuration file is not valid JSON, so it is shown read-only. Fix the file by hand to make it editable again.",
  },
  labels: {
    action: "Action",
    resource: "Resource",
    order: "Order",
    path: "Path",
  },
} as const;
