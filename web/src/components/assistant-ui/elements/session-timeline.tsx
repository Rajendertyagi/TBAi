"use client";

/**
 * Local adapter for the assistant-ui `tool-timeline` element: the mapping from
 * a message's tool parts to the timeline's steps and file-change stats.
 *
 * This mapping is deliberately app-owned. The upstream element is presentation
 * only — its docs state there is no runtime primitive for the step list — and
 * the verb/chip/icon for a step is only knowable from TBAi's own tool names,
 * which are registered once in `src/tools/index.ts` (server) and
 * `web/src/tools/toolkit.ts` (renderers). A tool with no entry here still gets a
 * truthful row; it simply shows its raw name.
 *
 * Installed via `npx assistant-ui@latest add elements-tool-timeline`, so
 * `tool-timeline.tsx` beside this file is upstream's, unmodified.
 */
import { useMemo, useState } from "react";
import { useAuiState, type ToolCallMessagePart } from "@assistant-ui/react";
import {
  FilePlusIcon,
  FileSearchIcon,
  FolderSearchIcon,
  GlobeIcon,
  ListChecksIcon,
  PencilIcon,
  SearchIcon,
  TerminalIcon,
  Trash2Icon,
  type LucideIcon,
} from "lucide-react";
import { ToolTimeline, type TimelineStat, type TimelineStep } from "./tool-timeline";

/** Verb + icon per tool. Keys are the real tool names from `web/src/tools/toolkit.ts`. */
const TOOL_META: Record<string, { verb: string; icon: LucideIcon }> = {
  // Direct chat
  read_file: { verb: "Read", icon: FileSearchIcon },
  list_dir: { verb: "Listed", icon: FolderSearchIcon },
  search_files: { verb: "Searched", icon: SearchIcon },
  file_info: { verb: "Inspected", icon: FileSearchIcon },
  write_file: { verb: "Wrote", icon: FilePlusIcon },
  edit_file: { verb: "Edited", icon: PencilIcon },
  delete_file: { verb: "Deleted", icon: Trash2Icon },
  run_command: { verb: "Ran", icon: TerminalIcon },
  process_list: { verb: "Listed processes", icon: TerminalIcon },
  process_kill: { verb: "Killed", icon: TerminalIcon },
  system_info: { verb: "Read system", icon: TerminalIcon },
  scheduler: { verb: "Scheduled", icon: ListChecksIcon },
  todo: { verb: "Tracked todo", icon: ListChecksIcon },
  browser: { verb: "Browsed", icon: GlobeIcon },
  browser_action: { verb: "Acted in browser", icon: GlobeIcon },
  // OpenCode
  read: { verb: "Read", icon: FileSearchIcon },
  glob: { verb: "Globbed", icon: FolderSearchIcon },
  grep: { verb: "Grepped", icon: SearchIcon },
  bash: { verb: "Ran", icon: TerminalIcon },
  shell: { verb: "Ran", icon: TerminalIcon },
  edit: { verb: "Edited", icon: PencilIcon },
  write: { verb: "Wrote", icon: FilePlusIcon },
  task: { verb: "Delegated", icon: ListChecksIcon },
  todowrite: { verb: "Tracked todo", icon: ListChecksIcon },
  webfetch: { verb: "Fetched", icon: GlobeIcon },
  websearch: { verb: "Searched web", icon: SearchIcon },
  skill: { verb: "Used skill", icon: ListChecksIcon },
  question: { verb: "Asked", icon: ListChecksIcon },
};

/** How many steps to reveal at once on a long run. */
const MAX_STEPS = 8;

/** One tool part -> one timeline row. Exported for direct testing. */
export function toStep(part: ToolCallMessagePart): TimelineStep {
  const meta = TOOL_META[part.toolName];
  const args = (part.args ?? {}) as Record<string, unknown>;
  const chip =
    firstString(args.filePath) ??
    firstString(args.path) ??
    firstString(args.file) ??
    firstString(args.pattern) ??
    firstString(args.command) ??
    firstString(args.url) ??
    part.toolName;
  return {
    verb: meta?.verb ?? part.toolName,
    chip,
    // Upstream's `TimelineStep.icon` is a `LucideIcon` COMPONENT, not a
    // rendered node — the element instantiates it so it can size and colour it.
    // Passing an already-created element here would be the wrong shape.
    icon: meta?.icon ?? TerminalIcon,
  };
}

function firstString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** File-change counts, from the edit/write tools that report them. Exported for testing. */
export function toStats(parts: readonly ToolCallMessagePart[]): TimelineStat[] {
  const stats: TimelineStat[] = [];
  for (const part of parts) {
    if (part.toolName !== "edit_file" && part.toolName !== "edit" && part.toolName !== "write_file" && part.toolName !== "write") {
      continue;
    }
    const result = part.result as
      | { file?: unknown; filePath?: unknown; path?: unknown; added?: unknown; removed?: unknown; linesAdded?: unknown; linesRemoved?: unknown }
      | undefined;
    if (!result || typeof result !== "object") continue;
    const file = firstString(result.file) ?? firstString(result.filePath) ?? firstString(result.path);
    if (!file) continue;
    const added = numberOrUndefined(result.added ?? result.linesAdded);
    const removed = numberOrUndefined(result.removed ?? result.linesRemoved);
    // A stat with neither side would render an empty chip; skip it.
    if (added === undefined && removed === undefined) continue;
    stats.push({ file, added, removed });
  }
  return stats;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Narrow the message's part union to the tool calls, using the library's own
 *  discriminant. Typed against the element type so TS can narrow both ways. */
function isToolPart<T extends { type: string }>(part: T): part is T & ToolCallMessagePart {
  return part.type === "tool-call";
}

/**
 * The timeline for the current message.
 *
 * Reads the message's own parts, as the upstream docs prescribe. Renders nothing
 * when the message has no tool calls, so an ordinary text reply is unchanged.
 */
export function SessionTimeline() {
  const [open, setOpen] = useState(false);
  // Select the parts array WHOLE, then derive. `useAuiState` compares the
  // selector result BY REFERENCE, so filtering inside the selector allocates a
  // fresh array on every call, the reference always differs, and the component
  // re-renders forever (React "Maximum update depth exceeded"). The array the
  // store holds is stable, and the derived list is memoized off it.
  const parts = useAuiState((s) => s.message.parts);
  const toolCalls = useMemo(() => parts.filter(isToolPart), [parts]);
  // A boolean primitive, which is safe to select directly.
  const streaming = useAuiState((s) => s.message.status?.type === "running");

  if (toolCalls.length === 0) return null;

  // Cap the ARRAY, not just visibleSteps: the panel reveals from the start, so a
  // long run would otherwise push everything interesting off the top.
  const steps = toolCalls.slice(-MAX_STEPS).map(toStep);
  const stats = toStats(toolCalls);
  const hidden = toolCalls.length - steps.length;

  return (
    <ToolTimeline
      steps={steps}
      visibleSteps={steps.length}
      streaming={streaming}
      open={open}
      onOpenChange={setOpen}
      restingLabel={restingLabel(toolCalls.length, stats.length, hidden)}
      activeLabel="Working"
      stats={stats}
    />
  );
}

function restingLabel(total: number, filesChanged: number, hidden: number): string {
  return buildRestingLabel(total, filesChanged, hidden);
}

/** Exported for direct testing; `restingLabel` is the component's own name for it. */
export function buildRestingLabel(total: number, filesChanged: number, hidden: number): string {
  const steps = `${total} step${total === 1 ? "" : "s"}`;
  const files = `${filesChanged} file${filesChanged === 1 ? "" : "s"} changed`;
  const more = hidden > 0 ? ` · last ${MAX_STEPS} shown` : "";
  return `${steps} · ${files}${more}`;
}
