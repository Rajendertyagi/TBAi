import { useEffect, useState } from "react";
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
import { ArrowDown, Check, Copy, RefreshCw, Loader2 } from "lucide-react";
import { MarkdownText } from "./assistant-ui/elements/markdown-text";
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
import { DiffViewer } from "../components/diff-viewer";
import { prettyToolName } from "./assistant-ui/rendering-glue";
import { TooltipIconButton } from "./assistant-ui/elements/tooltip-icon-button";
import { Composer } from "./Composer";
import { WelcomeScreen } from "../features/chat/components/WelcomeScreen";
import { WelcomeScopePicker } from "../features/chat/components/WelcomeScopePicker";
import { historyConfig } from "../config/history";
import { useSettingsStore } from "../stores";
import { useMessageError } from "@assistant-ui/core/react";
import { chatErrorCopy, classifyChatError } from "../lib/transport-errors";

/**
 * Lightweight boot skeleton for a persisted thread whose history has not
 * resolved yet. Rendered inside the messages viewport (never Welcome);
 * unmounts the moment history settles. Copy comes from `historyConfig`.
 */
function ThreadBootSkeleton() {
  return (
    <div
      data-testid="thread-boot"
      role="status"
      aria-label={historyConfig.copy.loadingConversation}
      className="space-y-4"
    >
      <div className="ml-auto h-10 w-2/5 animate-pulse rounded-xl bg-muted" />
      <div className="h-24 w-4/5 animate-pulse rounded-xl bg-muted" />
      <div className="ml-auto h-10 w-1/3 animate-pulse rounded-xl bg-muted" />
      <div className="h-16 w-3/5 animate-pulse rounded-xl bg-muted" />
      <span className="sr-only">{historyConfig.copy.loadingConversation}</span>
    </div>
  );
}

export function ChatWindow({ isDraft }: { isDraft: boolean }) {
  // Single composer instance for the whole app: one tag, one live mount,
  // identical size/features everywhere. Identity is structural, never
  // message-derived: welcome shows iff this is a draft thread AND it is
  // empty. A bound thread never mounts welcome — while its history loads
  // (`thread.isLoading`, assistant-ui's canonical history-loading signal)
  // it renders the boot skeleton instead. The folder scope chip renders as
  // a separate row below the composer box (editable on drafts, static on
  // bound threads) so the box itself never changes.
  const isEmpty = useAuiState((s) => s.thread.isEmpty);
  // Canonical history-loading signal: true from per-thread runtime mount
  // until ThreadHistoryAdapter.load() settles (success or failure).
  const isHistoryLoading = useAuiState((s) => s.thread.isLoading);
  const showWelcome = isDraft && isEmpty;
  const showBoot = !isDraft && isHistoryLoading;
  const composer = <Composer />;

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
                message.role === "user" ? <UserMessage /> : <AssistantMessage />
              }
            </ThreadPrimitive.Messages>
          </ThreadPrimitive.Viewport>

          <ThreadPrimitive.ScrollToBottom asChild>
            <TooltipIconButton
              tooltip="Scroll to bottom"
              side="top"
              className="absolute bottom-24 right-6 rounded-full border border-border bg-background shadow-md"
            >
              <ArrowDown />
            </TooltipIconButton>
          </ThreadPrimitive.ScrollToBottom>

          <div className="mx-auto w-full max-w-3xl px-4 pb-4">
            {composer}
            <div className="px-1 pt-1">
              <WelcomeScopePicker editable={false} />
            </div>
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

const groupedBy = groupPartByType({
  reasoning: ["group-chainOfThought", "group-reasoning"],
  "tool-call": ["group-chainOfThought", "group-tool"],
  "standalone-tool-call": [],
});

function AssistantMessage() {
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
      <div className="max-w-[85%] space-y-2 rounded-xl bg-muted px-3.5 py-2.5 text-sm text-foreground">
        <MessagePrimitive.GroupedParts groupBy={groupedBy}>
          {({ part, children }) => {
            switch (part.type) {
              case "group-chainOfThought":
                return <div className="my-2">{children}</div>;
              case "group-reasoning": {
                const running = part.status.type === "running";
                return (
                  <ReasoningRoot streaming={running}>
                    <ReasoningTrigger active={running} />
                    <ReasoningContent aria-busy={running}>
                      <ReasoningText>{children}</ReasoningText>
                    </ReasoningContent>
                  </ReasoningRoot>
                );
              }
              case "group-tool": {
                const running = part.status.type === "running";
                return (
                  <AutoOpenToolGroup active={running} count={part.indices.length}>
                    {children}
                  </AutoOpenToolGroup>
                );
              }
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

function AutoOpenToolGroup({
  active,
  count,
  children,
}: {
  active: boolean;
  count: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(active);
  useEffect(() => {
    if (active) setOpen(true);
  }, [active]);
  return (
    <ToolGroupRoot open={open} onOpenChange={setOpen}>
      <ToolGroupTrigger count={count} active={active} />
      <ToolGroupContent>{children}</ToolGroupContent>
    </ToolGroupRoot>
  );
}

function HighlightingSyntax(props: {
  code: string;
  language: string;
  node?: unknown;
  components?: unknown;
}) {
  if (props.language === "diff") {
    return <DiffViewer patch={props.code} showLineNumbers={false} className="w-full" />;
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
  const error = useMessageError();
  const copy = error === undefined ? null : chatErrorCopy(classifyChatError(error));
  return <>{copy ?? <ErrorPrimitive.Message />}</>;
}
