import { useEffect, useState, type ReactNode } from "react";
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
import { Check, Copy, RefreshCw, Loader2 } from "lucide-react";
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
import { SyntaxHighlighter } from "./assistant-ui/elements/shiki-highlighter.aui";
import { CodeDiff } from "./assistant-ui/elements/code-diff";
import { patchToCodeDiffs } from "../lib/patch-to-diffs";
import { toolsConfig } from "../config/tools";
import { prettyToolName } from "./assistant-ui/rendering-glue";
import { TooltipIconButton } from "./assistant-ui/elements/tooltip-icon-button";
import { ScrollPill } from "./ScrollPill";
import { ThreadBootSkeleton } from "./assistant-ui/elements/thread-boot-skeleton";
import { Composer } from "./Composer";
import { WelcomeScreen } from "../features/chat/components/WelcomeScreen";
import { WelcomeScopePicker } from "../features/chat/components/WelcomeScopePicker";
import { useSettingsStore } from "../stores";
import { chatErrorCopy, classifyChatError } from "../lib/transport-errors";

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

  return (
    <ThreadPrimitive.Root className="relative flex h-full min-h-0 flex-col">
      {showWelcome ? (
        <ThreadPrimitive.Viewport className="flex-1 overflow-y-auto px-4 py-6 pb-4">
          <WelcomeScreen composer={composer} />
        </ThreadPrimitive.Viewport>
      ) : (
        <>
          <ThreadPrimitive.Viewport className="flex-1 space-y-4 overflow-y-auto px-4 py-6 pb-4">
            {showBoot ? <ThreadBootSkeleton /> : null}
            <ThreadPrimitive.Messages>
              {({ message }) =>
                message.role === "user" ? <UserMessage /> : <AssistantMessage mode={mode} />
              }
            </ThreadPrimitive.Messages>
          </ThreadPrimitive.Viewport>

          <ScrollPill />

          <div className="mx-auto w-full max-w-3xl px-4 pb-4">
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
        {timeStr && (
          <span className="text-[11px] tabular-nums text-background/50">{timeStr}</span>
        )}
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
const groupedBy = groupPartByType({
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
    ? (providers.find((p) => p.id === custom.providerId)?.name ??
      custom.providerId)
    : undefined;
  const thinking =
    custom?.reasoningLevel && custom.reasoningLevel !== "off"
      ? custom.reasoningLevel
      : undefined;
  const isStreaming = timing?.totalStreamTime == null && threadIsRunning;
  const durationSec = !isStreaming && timing?.totalStreamTime != null
    ? (timing.totalStreamTime / 1000).toFixed(1)
    : undefined;
  const timeStr =
    createdAt instanceof Date
      ? createdAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : undefined;

  const [liveMs, setLiveMs] = useState(0);
  useEffect(() => {
    if (!isStreaming) { setLiveMs(0); return; }
    const interval = setInterval(() => setLiveMs((m) => m + 1000), 1000);
    return () => clearInterval(interval);
  }, [isStreaming]);
  const liveDuration = isStreaming && liveMs > 0 ? `${(liveMs / 1000).toFixed(1)}s` : undefined;

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
        <MessagePrimitive.GroupedParts groupBy={groupedBy}>
          {({ part, children }) => {
            switch (part.type) {
              case "group-reasoning": {
                // `counts` rather than one part's status: a run of reasoning
                // stays marked as streaming while ANY part is still arriving.
                const running = part.counts.running > 0;
                // `defaultOpen`: the thinking block is expanded and STAYS
                // expanded once the stream ends. Without it the disclosure
                // falls back to collapsed the moment `streaming` goes false,
                // so the reasoning a reader just watched stream in vanished
                // behind a one-line trigger. A manual toggle still wins — see
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
                    // A group holding a tool that needs approval is not settled,
                    // even though it is not running. Opening it is what makes a
                    // permission card visible rather than hiding it inside a
                    // collapsed block.
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
                return (
                  part.toolUI ?? (
                    <ToolFallback
                      {...part}
                      toolName={prettyToolName(part.toolName)}
                    />
                  )
                );
              // Trailing streaming affordance emitted by GroupedParts (default
              // mode "no-text"). Previously unhandled, so it rendered nothing.
              //
              // Gated on the THREAD, not just the message: the library's
              // condition is per-message, so a message left marked `running`
              // (an errored turn that never produced text) emits this forever
              // while the thread is idle — a permanent "still working" pulse
              // next to a live composer. `thread.isRunning` is the same
              // authoritative signal the composer uses to unmount its send
              // button, so the affordance can only appear while work is real.
              case "indicator":
                return threadIsRunning ? <ThinkingIndicator /> : null;
              default:
                return null;
            }
          }}
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
        {files.map((file, index) => (
          <CodeDiff
            key={`${index}-${file.filename}`}
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
  return <SyntaxHighlighter code={props.code} language={props.language} />;
}

function AssistantError() {
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="mt-1 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
        <AssistantErrorMessage />
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
}

/**
 * Transport-aware error copy. Reads the raw message error through the
 * library's own hook and substitutes the single specified copy for transport
 * kills; every other error renders exactly as before (same component, same
 * DOM). No state changes, no runtime interference, no recovery attempts.
 */
function AssistantErrorMessage() {
  // Message-error text read through `useAuiState` from `@assistant-ui/react`
  // (the provider's context). Selector mirrors the library's own
  // `messageErrorText` predicate line-for-line; only `incomplete`/`error`
  // message statuses carry a value and error-likes collapse to their message.
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
    return err ?? "An error occurred";
  });
  const copy = error === undefined ? null : chatErrorCopy(classifyChatError(error));
  return <>{copy ?? <ErrorPrimitive.Message />}</>;
}
