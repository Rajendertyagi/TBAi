import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import {
  ActionBarPrimitive,
  ErrorPrimitive,
  groupPartByType,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  useMessageTiming,
} from "@assistant-ui/react";
import { cn } from "@/lib/utils";
import { AlertCircle, Check, Copy, RefreshCw, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MarkdownText } from "./assistant-ui/elements/markdown-text";
import { SessionTimeline } from "./assistant-ui/elements/session-timeline";
import {
  Reasoning,
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from "./assistant-ui/elements/reasoning.aui";
import { ToolFallback } from "./assistant-ui/elements/tool-fallback";
import {
  ToolGroupContent,
  ToolGroupRoot,
  ToolGroupTrigger,
} from "./assistant-ui/elements/tool-group";
import { BoundedSyntaxHighlighter } from "./assistant-ui/elements/code-budget";
import { CodeDiff } from "./assistant-ui/elements/code-diff";
import { patchToCodeDiffs } from "../lib/patch-to-diffs";
import { toolsConfig } from "../config/tools";
import { prettyToolName } from "./assistant-ui/rendering-glue";
import { TooltipIconButton } from "./assistant-ui/elements/tooltip-icon-button";
import { ScrollPill } from "./ScrollPill";
import { VirtualizedTranscript } from "./VirtualizedTranscript";
import { DirectViewportBridge } from "../features/chat/history/DirectViewportBridge";
import { ThreadBootSkeleton } from "./assistant-ui/elements/thread-boot-skeleton";
import { CompactionDivider } from "./assistant-ui/elements/compaction-divider";
import { DIRECT_COMPACT_DATA_NAME } from "../features/chat/compactCommand";
import { Composer } from "./Composer";
import { WelcomeScreen } from "../features/chat/components/WelcomeScreen";
import { WelcomeScopePicker } from "../features/chat/components/WelcomeScopePicker";
import { useSettingsStore } from "@/features/providers/state/providersStore";
import { chatErrorCopy, classifyChatError } from "../lib/transport-errors";

import { formatDuration } from "@/tools/elapsed";
import { AgentStatus } from "./assistant-ui/elements/agent-status";
import { useAssistantActivity } from "../features/chat/hooks/useAssistantActivity";
/**
 * Whether the thread boot skeleton renders. Pure (no hooks) so the
 * draft/loading/mode matrix is unit-testable without a DOM runner.
 *
 * - Drafts never show it (chat drafts mount Welcome; agent surfaces have no
 *   draft state, and a hypothetical agent draft must not either).
 * - Chat shows it for a bound thread while history loads.
 * - Agent shows it while history loads, so an existing OpenCode conversation
 *   is never a visually empty viewport during reconnect.
 */
export function shouldShowThreadBoot({
  mode,
  isDraft,
  isHistoryLoading,
}: {
  /** chat = TBAi chat; agent = OpenCode Code mode (separate runtime). */
  mode: "chat" | "agent";
  isDraft: boolean;
  isHistoryLoading: boolean;
}): boolean {
  if (isDraft) return false;
  if (mode === "agent") return isHistoryLoading;
  return mode === "chat" && isHistoryLoading;
}

/**
 * Whether the per-message tool timeline renders. Pure (no hooks) so the
 * engine gate is unit-testable without a DOM runner.
 *
 * The timeline speaks the OpenCode vocabulary — "N steps", "M files changed" —
 * because a coding session is a sequence of steps that change files. The Direct
 * engine has neither concept: a Direct message is one model turn whose tool
 * calls are the model's own decisions, and its `edit_file` / `write_file`
 * results carry `{ path, occurrences, diff }` / `{ path, bytes, created }`,
 * which carry no line counts. So the summary could only ever print
 * "0 files changed" there, and the defect it reports ("the tool summary in the
 * Direct transcript is meaningless") is exactly what a reader sees.
 *
 * The gate is the OWNING ENGINE, not a tool-name test: the same renderer serves
 * both surfaces, and which engine a message belongs to is already the `mode`
 * prop the rest of this component branches on. Gating on names would have to
 * re-derive the engine from data the runtime already states.
 */
export function shouldShowSessionTimeline({
  mode,
}: {
  /** chat = TBAi chat; agent = OpenCode Code mode (separate runtime). */
  mode: "chat" | "agent";
}): boolean {
  return mode === "agent";
}

function AssistantStatusPill() {
  const activity = useAssistantActivity();
  if (!activity) return null;

  return (
    <div className="flex items-center justify-start pb-2 animate-in fade-in-0 slide-in-from-bottom-0.5 duration-200 motion-reduce:animate-none">
      <AgentStatus {...activity} />
    </div>
  );
}

export function ChatWindow({
  isDraft = false,
  mode = "chat",
  aboveComposerExtra,
  belowComposerExtra,
}: {
  /** chat = TBAi chat; agent = OpenCode Code mode (separate runtime). */
  mode?: "chat" | "agent";
  isDraft?: boolean;
  /**
   * Opaque node rendered in the composer folder, directly ABOVE the composer
   * box. Same contract and the same reason as {@link belowComposerExtra}: kept
   * opaque so this file stays free of engine-specific imports, with the owner
   * (e.g. OpenCodeView) supplying whatever belongs there.
   *
   * Above rather than below because the surfaces that belong here are things
   * the reader must act on before composing — the Code-mode question dock is
   * the current owner. The transcript viewport is `flex-1` and the folder is
   * auto-height, so a node placed here shrinks the transcript rather than
   * covering it, and no measured height or floating panel is needed.
   */
  aboveComposerExtra?: ReactNode;
  /**
   * Opaque node rendered in the composer folder row (agent mode only).
   * Kept opaque so this file stays free of engine-specific imports —
   * the owner (e.g. OpenCodeView) supplies whatever belongs there.
   */
  belowComposerExtra?: ReactNode;
}) {
  // Single composer instance for the whole app: one tag, one live mount,
  // identical size/features everywhere. Identity is structural, never
  // message-derived: welcome shows iff this is a draft thread AND it is
  // empty. A bound thread never mounts welcome — while its history loads
  // (`thread.isLoading`, assistant-ui's canonical history-loading signal)
  // it renders the boot skeleton instead. The folder scope chip renders as
  // a separate row below the composer box (editable on drafts, static on
  // bound threads) so the box itself never changes.
  // In agent (Code) mode the OpenCode runtime owns the thread and directory,
  // so welcome/scope-chip are suppressed — only the message surface and
  // composer remain, reused verbatim. The boot skeleton is NOT suppressed:
  // an existing OpenCode conversation shows it while history loads.
  const isEmpty = useAuiState((s) => s.thread.isEmpty);
  // Canonical history-loading signal: true from per-thread runtime mount
  // until ThreadHistoryAdapter.load() settles (success or failure).
  const isHistoryLoading = useAuiState((s) => s.thread.isLoading);
  const showWelcome = mode === "chat" && isDraft && isEmpty;
  const showBoot = shouldShowThreadBoot({ mode, isDraft, isHistoryLoading });
  const showScopePicker = mode === "chat";
  // Code mode shows OpenCode's three independent chips instead of the Direct
  // provider chips; the two engines' model worlds never mix.
  const isCodeSurface = mode === "agent";
  // In agent mode the OpenCode session owns the working directory (resolved
  // server-side at session create). The workspace chip is display-only here —
  // it reads the bound conversation's workspaceMode/folder via the thread's
  // `custom` bag and never allows re-rooting mid-session.
  const showAgentScopeChip = mode === "agent";
  const composer = <Composer isWelcomeDraft={showWelcome} isCodeSurface={isCodeSurface} />;

  // The row renderer for the virtualized timeline. It switches on assistant-ui's
  // own row type, so the timeline decides only WHICH rows are mounted, never
  // what a row looks like — every case reuses an existing component, and the
  // part case shares `AssistantPart` with the ordinary message renderer.
  //
  // Its identity is stable (memoized on `mode`): the timeline invokes it for
  // every mounted row, so a fresh function per render re-renders the list.
  const renderRow = useCallback<
    NonNullable<React.ComponentProps<typeof ThreadPrimitive.Row>["children"]>
  >(
    (info) => {
      switch (info.type) {
        case "message":
          return info.message.role === "user" ? <UserMessage /> : <AssistantMessage mode={mode} />;
        case "part":
          return <AssistantPart part={info.part}>{info.children}</AssistantPart>;
        case "turn-end":
          // TBAi renders no turn footer; the action bar already lives on the
          // message. Returning null keeps the row from adding an empty cell.
          return null;
        default:
          return null;
      }
    },
    [mode],
  );

  return (
    <ThreadPrimitive.Root className="relative flex h-full min-h-0 flex-col">
      {showWelcome ? (
        <ThreadPrimitive.Viewport className="flex-1 overflow-y-auto px-4 py-6 pb-4">
          <WelcomeScreen composer={composer} />
        </ThreadPrimitive.Viewport>
      ) : (
        <>
          {/* P2 rebased architecture: one virtualized timeline for history AND
              the live streaming tail, so there is a single scroll position.
              `ThreadPrimitive.Viewport` is deliberately NOT used — its auto-scroll
              assumes every message is mounted, which is exactly what
              virtualization removes. The bridge supplies measurements and the
              paging control; it holds no window policy. */}
          <VirtualizedTranscript
            // The vertical spacing is MARGIN, not padding, and that is load-bearing.
            //
            // Padding on a scroll container is part of its scrollable overflow, so
            // `py-6 pb-4` added 40px to `scrollHeight` that the virtualizer's
            // `getTotalSize()` cannot see. That made the scrollport's end-distance
            // disagree with virtual-core's by exactly 40px, which is why
            // `resizeItem`'s `wasAtEnd` reported "at end" while the viewport was
            // not. Margin is outside the border box and contributes nothing to the
            // scrollable region, so the spacing is identical and the geometry is
            // exact: `scrollHeight === getTotalSize()`.
            //
            // Horizontal padding is untouched - it affects scrollWidth, not the
            // vertical geometry this corrects.
            className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 mt-6 mb-4"
            renderRow={renderRow}
            // The scroll-to-latest control lives INSIDE the transcript, next to
            // the paging control: it reads the virtualizer through context, and
            // that context only exists below the transcript that owns it. It is
            // passed as `overlay`, not `header`, because it is a fixed chip that
            // floats over the transcript - the header slot is the paging bar.
            header={
              <>
                {showBoot ? <ThreadBootSkeleton /> : null}
                <DirectViewportBridge />
              </>
            }
            overlay={<ScrollPill />}
          />

          <div className="relative z-10 mx-auto w-full max-w-3xl px-4 pb-4 bg-background">
            <AssistantStatusPill />
            {/* In flow, between the transcript and the composer, so the
                viewport's `flex-1` absorbs the height and the last rows stay
                reachable. No absolute positioning, no measurement. */}
            {aboveComposerExtra ? <div className="pt-2">{aboveComposerExtra}</div> : null}
            {composer}
            {showScopePicker && (
              <div className="px-1 pt-1">
                <WelcomeScopePicker editable={false} />
              </div>
            )}
            {/* Agent (Code) mode: display-only workspace chip — the OpenCode
                session's working directory is set at session-create time and
                cannot be re-rooted mid-session. Reuses the same static chip
                as bound Direct threads. An optional owner-supplied node
                (e.g. the Code-mode status heart) shares the row. */}
            {showAgentScopeChip && (
              <div className="flex items-center gap-1 px-1 pt-1">
                <div className="min-w-0 flex-1">
                  <WelcomeScopePicker editable={false} />
                </div>
                {belowComposerExtra}
              </div>
            )}
          </div>
        </>
      )}
    </ThreadPrimitive.Root>
  );
}

function TurnCopyButton() {
  const isCopied = useAuiState((s) => s.message.isCopied);
  return (
    <ActionBarPrimitive.Copy asChild>
      <TooltipIconButton tooltip={isCopied ? "Copied!" : "Copy message"} side="bottom">
        {isCopied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </TooltipIconButton>
    </ActionBarPrimitive.Copy>
  );
}

function UserMessage() {
  const createdAt = useAuiState((s) => s.message.createdAt);
  const timeStr =
    createdAt instanceof Date
      ? createdAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : undefined;

  return (
    <MessagePrimitive.Root className="flex animate-in flex-col items-end fade-in-0 slide-in-from-bottom-1 duration-200">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-xl border-t border-r border-border/40 bg-foreground px-3.5 py-2.5 text-sm text-background">
        <MessagePrimitive.Parts />
      </div>
      <div className="mt-1.5 flex items-center gap-1.5 opacity-0 transition-opacity hover:opacity-100 group/message">
        {timeStr && <span className="text-[11px] tabular-nums text-background/50">{timeStr}</span>}
        <TurnCopyButton />
      </div>
    </MessagePrimitive.Root>
  );
}

// Flattened on purpose: a tool group is a SIBLING of a reasoning block, never
// its child. `groupPartByType` nests by shared path prefix, so the previous
// `group-chainOfThought` prefix on `tool-call` rendered every tool group inside
// the thinking block — the "tools in a nested block" defect. Adjacent tool calls
// still coalesce into a single `group-tool` (the helper merges runs sharing a
// path), so the "N tool calls" collapsible survives.
//
// `"standalone-tool-call": []` is an EMPTY path, i.e. ungrouped: the part renders
// as a leaf, outside the grouping. That is how a registry tool opting into
// `display: "standalone"` keeps its approval card out of a collapsed group, and
// it is why the `tool-call` case below is reachable at all — every other tool
// call arrives as a `group-tool` node.
//
// `TKey` is stated explicitly because it cannot be inferred from this literal.
// `groupPartByType<TKey>` takes every array as `readonly TKey[]`, and inference
// fixes `TKey` from the FIRST property before the later ones are checked, so
// `reasoning: ["group-reasoning"]` alone narrowed it and `"tool-call"` then
// failed as not assignable. Naming the union states the intent the map already
// had and matches the upstream `groupPartByType` example, which lists several
// distinct group keys.
type TChatGroupKey = "group-reasoning" | "group-tool";

const groupedBy = groupPartByType<TChatGroupKey>({
  reasoning: ["group-reasoning"],
  "tool-call": ["group-tool"],
  "standalone-tool-call": [],
});

function AssistantMessage({ mode }: { mode: "chat" | "agent" }) {
  const timing = useMessageTiming();
  const createdAt = useAuiState((s) => s.message.createdAt);
  // Live-stream detection must ALSO require a running thread: restored
  // messages carry no timing data (it is never persisted), so timing-only
  // detection sticks every reloaded message in "streaming" forever (ticking
  // timer, hidden provenance footer). Gating on thread.isRunning keeps live
  // streams live while letting settled history settle.
  const threadIsRunning = useAuiState((s) => s.thread.isRunning);
  const custom = useAuiState(
    (s) =>
      (s.message.role === "assistant"
        ? (s.message.metadata?.custom as
            | {
                usage?: { totalTokens?: number };
                modelId?: string;
                providerId?: string;
                reasoningLevel?: string;
              }
            | undefined)
        : undefined) ?? undefined,
  );
  // Provider display names for the provenance chips (server stores ids).
  const providers = useSettingsStore((s) => s.providers);

  const total = custom?.usage?.totalTokens;
  const modelId = custom?.modelId;
  const providerName = custom?.providerId
    ? (providers.find((p) => p.id === custom.providerId)?.name ?? custom.providerId)
    : undefined;
  const thinking =
    custom?.reasoningLevel && custom.reasoningLevel !== "off" ? custom.reasoningLevel : undefined;
  const isStreaming = timing?.totalStreamTime == null && threadIsRunning;
  // Routed through `formatDuration`, the one owner of how a span is written.
  //
  // These two used to format inline with `(ms / 1000).toFixed(1)`, which is the
  // exact defect `formatDuration` was written to remove: a real 299-second turn
  // rendered `299.0s` in this footer while the tool badge on the same card read
  // `4m 59s`. Two spellings of the same fact on one screen, one of them
  // unreadable. Caught by looking at a live subagent capture, not by a test.
  const durationSec =
    !isStreaming && timing?.totalStreamTime != null
      ? formatDuration(timing.totalStreamTime)
      : undefined;
  const timeStr =
    createdAt instanceof Date
      ? createdAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : undefined;

  const [liveMs, setLiveMs] = useState(0);
  useEffect(() => {
    if (!isStreaming) {
      setLiveMs(0);
      return;
    }
    const interval = setInterval(() => setLiveMs((m) => m + 1000), 1000);
    return () => clearInterval(interval);
  }, [isStreaming]);
  const liveDuration = isStreaming && liveMs > 0 ? formatDuration(liveMs) : undefined;

  const [hovered, setHovered] = useState(false);
  const showTimestamp = hovered && !!timeStr;

  const handleMouseEnter = () => setHovered(true);
  const handleMouseLeave = () => setHovered(false);

  const primaryLabel = liveDuration || durationSec || timeStr;
  const displayLabel = showTimestamp && timeStr ? timeStr : (primaryLabel ?? "");

  const hasMetadata = total != null || modelId != null || providerName != null;
  const metadataChips = [];
  if (total != null) metadataChips.push(`${total}t`);
  if (providerName) metadataChips.push(providerName);
  if (modelId) metadataChips.push(modelId);
  if (thinking) metadataChips.push(`thinking:${thinking}`);

  return (
    <MessagePrimitive.Root className="flex animate-in flex-col items-start fade-in-0 slide-in-from-bottom-1 duration-200">
      {/* No single assistant bubble. Each node below owns its own surface, so a
          reasoning panel, a tool group and a paragraph read as separate blocks
          instead of one nested stack. `max-w-[85%]` is carried over from the old
          bubble so the column width is unchanged — only the shared background
          and padding are gone. */}
      <div className="flex w-full max-w-[85%] min-w-0 flex-col gap-2 text-sm text-foreground">
        {/* One-line summary of the turn's tool work, above the parts.
            Upstream's guidance is to silence the per-part tool renderers so the
            steps are not shown twice. This app deliberately does NOT: it has
            real per-tool UIs (`part.toolUI`, `AutoOpenToolGroup`, a terminal
            block for shell calls) that carry output a verb/chip row cannot, and
            dropping them would delete working capability to avoid a cosmetic
            overlap. So the timeline is a COLLAPSED summary and the detailed
            cards stay below it — summary on top, detail underneath, which is the
            same shape as any log viewer. It renders nothing for a message with no
            tool calls, so ordinary replies are untouched.

            AGENT MODE ONLY. "N steps · M files changed" is the OpenCode
            session's vocabulary, and only that runtime produces the data it
            counts: OpenCode's `edit` / `write` results carry per-file line counts
            in `state.metadata.files[]`, while the Direct engine's
            `write_file` / `edit_file` results carry none (`{ path, bytes,
            created }`, `{ path, occurrences, diff }`) — so on the Direct surface
            the count is structurally always 0 and the line reads as a bug. See
            {@link shouldShowSessionTimeline}. */}
        {shouldShowSessionTimeline({ mode }) ? <SessionTimeline /> : null}
        {/* `GroupedParts` takes a render FUNCTION, so the shared part renderer is
            passed as a reference — the same one the virtualized row renderer
            uses, so an assistant part is rendered by one implementation. */}
        <MessagePrimitive.GroupedParts groupBy={groupedBy}>
          {AssistantPartSlot}
        </MessagePrimitive.GroupedParts>
        <AssistantError />
      </div>

      <div
        className={cn(
          "mt-1.5 flex items-center gap-1.5 min-h-6",
          isStreaming ? "opacity-100" : "opacity-80 hover:opacity-100",
        )}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <div className="flex items-center gap-0.5">
          <TurnCopyButton />
          <ActionBarPrimitive.Reload asChild>
            <TooltipIconButton tooltip="Regenerate response" side="bottom">
              <RefreshCw className="size-3.5" />
            </TooltipIconButton>
          </ActionBarPrimitive.Reload>
        </div>

        {isStreaming && (
          <div className="flex items-center gap-1.5 ml-1">
            <Loader2 className="size-3 animate-spin text-muted-foreground" />
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {liveDuration || "0.0s"}
            </span>
          </div>
        )}

        {!isStreaming && hasMetadata && (
          <div className="ml-auto flex items-center gap-1">
            <span
              className={cn(
                "text-[11px] tabular-nums text-muted-foreground transition-opacity hover:text-foreground",
                showTimestamp && "text-foreground",
              )}
              title={displayLabel}
            >
              {displayLabel}
            </span>
            {metadataChips.map((chip, i) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: the chips are a fixed set of slots (total, provider, model, thinking) pushed in a constant order and never reordered or removed, so position IS the identity. A content key would collide whenever two slots hold the same string.
                key={i}
                className="text-[10px] tabular-nums text-muted-foreground/70"
                title={chip}
              >
                {chip}
              </span>
            ))}
          </div>
        )}
      </div>
    </MessagePrimitive.Root>
  );
}

/**
 * Tool group that opens itself while there is something to watch: a running
 * call, or one waiting on approval. `pending` is deliberately separate from
 * `active` — a `requires-action` group is not running, but leaving it collapsed
 * hides the approval card inside it, which is how a permission ended up
 * invisible inside a nested block.
 */
/**
 * Renders ONE assistant part (or part group).
 *
 * Shared by the ordinary message renderer (`MessagePrimitive.GroupedParts`) and
 * the virtualized timeline's `ThreadPrimitive.Row`, so there is exactly ONE
 * implementation of how an assistant part looks. The two renderers differ only
 * in what wraps them, never in the part itself.
 *
 * `part`/`children` are `MessagePrimitive.GroupedParts`' own props, which is
 * also what a row's `part` case carries, so this fits both without adaptation.
 */
function AssistantPart({
  part,
  children,
}: {
  part: Parameters<
    NonNullable<React.ComponentProps<typeof MessagePrimitive.GroupedParts>["children"]>
  >[0]["part"];
  children?: ReactNode;
}) {
  // Thread-level, so it is read here rather than threaded down from the message:
  // the streaming affordance below is about the THREAD still working, and the
  // library's per-message condition would keep it lit forever after an errored
  // turn that produced no text.
  const threadIsRunning = useAuiState((s) => s.thread.isRunning);

  switch (part.type) {
    case "group-reasoning": {
      // `counts` rather than one part's status: a run of reasoning stays marked
      // as streaming while ANY part is still arriving.
      const running = part.counts.running > 0;
      // `defaultOpen`: the thinking block is expanded and STAYS expanded once the
      // stream ends. Without it the disclosure falls back to collapsed the moment
      // `streaming` goes false, so the reasoning a reader just watched stream in
      // vanished behind a one-line trigger. A manual toggle still wins — see
      // `ReasoningRoot`'s `userOpen ?? (streaming || initialOpen)`.
      return (
        <ReasoningRoot streaming={running} defaultOpen>
          <ReasoningTrigger active={running} />
          <ReasoningContent aria-busy={running}>
            <ReasoningText>{children}</ReasoningText>
          </ReasoningContent>
        </ReasoningRoot>
      );
    }
    case "group-tool":
      return (
        <AutoOpenToolGroup
          active={part.counts.running > 0}
          // A group holding a tool that needs approval is not settled, even
          // though it is not running. Opening it is what makes a permission card
          // visible rather than hiding it inside a collapsed block.
          pending={part.counts.requiresAction > 0}
          count={part.indices.length}
        >
          {children}
        </AutoOpenToolGroup>
      );
    case "text":
      return (
        <MarkdownText
          components={{
            SyntaxHighlighter: HighlightingSyntax,
            a: ({ className, ...props }) => (
              <a {...props} className={className} target="_blank" rel="noreferrer" />
            ),
          }}
        />
      );
    case "reasoning":
      return <Reasoning {...part} />;
    case "tool-call":
      return part.toolUI ?? <ToolFallback {...part} toolName={prettyToolName(part.toolName)} />;
    // Data parts are LEAF parts: `children` is a sentinel that throws (see the
    // library's `GroupedParts` docs — `children` is only meaningful for
    // `group-…` cases), so the part must render itself. This is what makes the
    // Direct compaction divider appear at all. Keyed on the part name rather
    // than rendering every data part, so an unregistered name renders nothing.
    case "data":
      return part.name === DIRECT_COMPACT_DATA_NAME ? <CompactionDivider {...part} /> : null;
    // Trailing streaming affordance emitted by GroupedParts (default mode
    // "no-text"). Gated on the THREAD (see above) so it can only appear while
    // work is real.
    case "indicator":
      return threadIsRunning ? <ThinkingIndicator /> : null;
    default:
      return null;
  }
}

/** `GroupedParts` render-function form, for use as its child. */
function AssistantPartSlot(
  props: Parameters<
    NonNullable<React.ComponentProps<typeof MessagePrimitive.GroupedParts>["children"]>
  >[0],
) {
  return <AssistantPart part={props.part}>{props.children}</AssistantPart>;
}

function AutoOpenToolGroup({
  active,
  pending = false,
  count,
  children,
}: {
  active: boolean;
  pending?: boolean;
  count: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(active || pending);
  useEffect(() => {
    if (active || pending) setOpen(true);
  }, [active, pending]);
  return (
    <ToolGroupRoot open={open} onOpenChange={setOpen}>
      <ToolGroupTrigger count={count} active={active} />
      <ToolGroupContent>{children}</ToolGroupContent>
    </ToolGroupRoot>
  );
}

/**
 * Trailing streaming affordance for the synthetic `{ type: "indicator" }` part
 * that `MessagePrimitive.GroupedParts` emits (default mode "no-text", i.e. while
 * the message runs and the last part is not text/reasoning). Decorative only:
 * streaming state and the live timer are already announced by the action bar, so
 * it is hidden from assistive tech rather than double-announced.
 */
function ThinkingIndicator() {
  return (
    <div
      data-slot="assistant-indicator"
      aria-hidden="true"
      className="flex items-center gap-1 py-0.5 text-muted-foreground"
    >
      <span className="size-1.5 animate-pulse rounded-full bg-current" />
      <span className="size-1.5 animate-pulse rounded-full bg-current [animation-delay:150ms]" />
      <span className="size-1.5 animate-pulse rounded-full bg-current [animation-delay:300ms]" />
    </div>
  );
}

function HighlightingSyntax(props: {
  code: string;
  language: string;
  node?: unknown;
  components?: unknown;
}) {
  if (props.language === "diff") {
    const files = patchToCodeDiffs(props.code);
    // The legacy viewer's empty state, preserved verbatim: a fence that carries
    // no parseable diff still says so rather than rendering nothing at all.
    if (files.length === 0) {
      return (
        <pre
          data-slot="code-diff-empty"
          className="border-foreground/10 bg-foreground/[0.025] dark:bg-foreground/[0.04] text-muted-foreground border px-3.5 py-3 font-mono text-xs"
        >
          {toolsConfig.copy.status.noDiffContent}
        </pre>
      );
    }
    // One official `CodeDiff` per file — a multi-file patch renders as a stack,
    // matching how the legacy viewer rendered one block per file.
    return (
      <div data-slot="code-diff-list" className="w-full space-y-2">
        {files.map((file) => (
          <CodeDiff
            key={file.filename}
            filename={file.filename}
            additions={file.additions}
            deletions={file.deletions}
            lines={file.lines}
            cycle={0}
          />
        ))}
      </div>
    );
  }
  // Bounded before highlighting. This is the registration the Direct chat
  // surface actually uses, and it OVERRIDES the `SyntaxHighlighter` entry in
  // `markdown-text.tsx`'s `defaultComponents` - a caller's `components` prop is
  // spread last - so the budget has to be applied here as well, or this branch
  // would remain the one unbounded path in the app.
  //
  // The `diff` branch above deliberately does NOT go through the code-fence
  // budget: `patchToCodeDiffs` applies `diffPreviewMaxLines` /
  // `diffPreviewMaxChars` and renders its own `diffRowsOmitted` marker, so
  // bounding it twice would produce two markers and cut a payload that was
  // already cut.
  return <BoundedSyntaxHighlighter code={props.code} language={props.language} />;
}

function AssistantError() {
  const error = useAuiState((s) => {
    const status = s.message.status;
    if (status?.type !== "incomplete" || status.reason !== "error") return undefined;
    const err = status.error;
    if (typeof err === "string") return err;
    if (
      typeof err === "object" &&
      err !== null &&
      "message" in err &&
      typeof err.message === "string"
    ) {
      return err.message;
    }
    return err ? String(err) : "An error occurred";
  });

  if (!error) return null;

  const transportCopy = chatErrorCopy(classifyChatError(error));
  const displayText = transportCopy ?? error;
  const lower = displayText.toLowerCase();
  const isQuotaOrAuthError =
    lower.includes("usage limit") ||
    lower.includes("free usage") ||
    lower.includes("authentication failed") ||
    lower.includes("connect a provider") ||
    lower.includes("401");

  const hasRawDetails = displayText.length > 300;

  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root
        role="alert"
        className="mt-2 flex flex-col gap-2 rounded-xl border border-destructive/20 bg-destructive/10 p-3 text-xs text-destructive"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 font-medium">
            <AlertCircle className="size-4 shrink-0 text-destructive" />
            <span className="break-words">{displayText}</span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {isQuotaOrAuthError && (
              <Button size="xs" variant="outline" asChild className="h-6 text-[11px]">
                <Link to="/settings/providers">Open Provider Settings</Link>
              </Button>
            )}
            <ActionBarPrimitive.Reload asChild>
              <Button size="xs" variant="outline" className="h-6 text-[11px]">
                <RefreshCw className="mr-1 size-3" />
                Retry
              </Button>
            </ActionBarPrimitive.Reload>
          </div>
        </div>
        {hasRawDetails && (
          <details className="mt-1 text-[11px] text-muted-foreground/90">
            <summary className="cursor-pointer font-medium hover:text-foreground">
              Error Details
            </summary>
            <pre className="mt-1 max-h-40 overflow-auto rounded bg-background/50 p-2 font-mono text-[10px] text-foreground">
              {displayText}
            </pre>
          </details>
        )}
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
}
