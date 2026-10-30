import { Fragment, useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import {
  ActionBarPrimitive,
  ErrorPrimitive,
  groupPartByType,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { cn } from "@/lib/utils";
import { AlertCircle, RefreshCw, Loader2 } from "lucide-react";
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
import { MessageActions, MessageCopyAction } from "./assistant-ui/elements/message-actions";
import { messageActionsConfig } from "../config/messageActions";
import { ScrollPill } from "./ScrollPill";
import { VirtualizedTranscript } from "./VirtualizedTranscript";
import { DirectViewportBridge } from "../features/chat/history/DirectViewportBridge";
import { ThreadBootSkeleton } from "./assistant-ui/elements/thread-boot-skeleton";
import { CompactionDivider } from "./assistant-ui/elements/compaction-divider";
import { DIRECT_COMPACT_DATA_NAME } from "../features/chat/compactCommand";
import { Composer } from "./Composer";
import { WelcomeScreen } from "../features/chat/components/WelcomeScreen";
import { WelcomeScopePicker } from "../features/chat/components/WelcomeScopePicker";
import {
  ComposerDock,
  useComposerInset,
  useComposerReserve,
} from "../features/chat/components/ComposerDock";
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

/**
 * The composer's opaque extras.
 *
 * `ChatWindow` stays engine-neutral: it renders these nodes without knowing
 * which engine produced them, so nothing under `features/opencode/` or
 * `features/chat/` is imported here.
 */
export interface ComposerExtras {
  /**
   * Transient status presentations, rendered INSIDE the reserved status row
   * (which holds its height whether or not anything is showing). Direct: the
   * pill. Code: the primary status and the restoration notice.
   */
  status?: ReactNode;
  /**
   * Interactive content (questions / forms), rendered ABOVE the reserved row at
   * its natural height. Never constrained to the status row: a form is content,
   * not a label, and pinning it to a pill's height would clip it.
   */
  interactive?: ReactNode;
  /**
   * Below-composer row content (agent mode only): the connection heart and any
   * display-only chips. Its own constant-height row, outside the reserved row;
   * the heart's popover is an out-of-flow overlay.
   */
  below?: ReactNode;
}

/**
 * The Direct status pill.
 *
 * It renders into the reserved status row, so the marker rides on the pill
 * itself rather than on a wrapper that would add its own flow box.
 */
function AssistantStatusPill() {
  const activity = useAssistantActivity();
  if (!activity) return null;

  return (
    <AgentStatus
      data-primary-status
      {...activity}
      className="min-w-0 max-w-full shrink animate-in fade-in-0 slide-in-from-bottom-0.5 duration-200 motion-reduce:animate-none"
    />
  );
}

export function ChatWindow({
  isDraft = false,
  mode = "chat",
  composerExtras,
}: {
  /** chat = TBAi chat; agent = OpenCode Code mode (separate runtime). */
  mode?: "chat" | "agent";
  isDraft?: boolean;
  /**
   * Opaque content for the composer folder, split by concern:
   *
   * - `interactive` (questions, forms) keeps its natural height above the
   *   status row;
   * - `status` renders inside a CONSTANT-height reserved row between the
   *   interactive content and the composer, so a transient status appearing or
   *   disappearing cannot resize the folder and move the transcript/composer;
   * - `below` occupies the existing agent-mode chip row under the composer.
   *
   * The split is what makes layout stability structural rather than something
   * each caller has to remember.
   */
  composerExtras?: ComposerExtras;
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

  // The composer overlay's measured height, published by `ComposerDock` through
  // the thread viewport store. The pill sits on this number (the dock's top
  // edge); the transcript reserves this PLUS the tail gap, so the newest line
  // keeps clear air above the fade band instead of ending inside it.
  const composerInset = useComposerInset();
  const composerReserve = useComposerReserve();

  // The row renderer for the virtualized timeline. It switches on assistant-ui's
  // own row type, so the timeline decides only WHICH rows are mounted, never
  // what a row looks like — every case reuses an existing component, and the
  // part case shares `AssistantPart` with the ordinary message renderer.
  //
  // Its identity is stable (memoized on `mode`): the timeline invokes it for
  // every mounted row, so a fresh function per render re-renders the list.
  const renderRow = useCallback<
    NonNullable<React.ComponentProps<typeof ThreadPrimitive.Row>["children"]>
  >((info) => <ChatRow info={info} mode={mode} />, [mode]);

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
            //
            // No bottom margin: the composer is now an OVERLAY (`ComposerDock`)
            // positioned against the bottom of this column, and the scrollport
            // must reach that same bottom edge. A `mb-4` would leave a 16px band
            // the scrollport could not enter, and the transcript's live end would
            // sit that far above the dock. The bottom spacing the margin used to
            // provide now lives in the dock's own padding, inside the measured
            // reserve.
            className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 mt-6"
            // The overlay's measured height plus the tail gap.
            // `paddingEnd` is virtualizer-aware: it is part of
            // `getTotalSize()`, so the total-size container grows by exactly the
            // reserve and `scrollHeight === getTotalSize()` still holds. CSS
            // padding on the scrollport would break that invariant (see the
            // header note in `VirtualizedTranscript`).
            paddingEnd={composerReserve}
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
            overlay={<ScrollPill bottomOffset={composerInset} />}
          />

          <ComposerDock>
            {/* Interactive content sits ABOVE the reserved row and keeps its
                natural height: a question form is content, and clipping it to a
                status pill's height would make it unusable. Its own add/remove
                flow height is intentional, not a status jump. */}
            {composerExtras?.interactive ? (
              <div data-composer-interactive className="pt-2">
                {composerExtras.interactive}
              </div>
            ) : null}
            {/* The reserved status row. It is ALWAYS mounted and its one-line
                height is fixed by `--status-reserved-height`, so a status pill
                appearing, disappearing or changing label cannot resize the
                composer folder — which is what used to move the transcript and
                composer. `flex-wrap` lets the primary and the restoration
                notice coexist as sibling pills and wrap to a second line only
                when the row is too narrow to hold both; `gap-2` is also the
                wrapped line-gap. Every `AgentStatus` pill is 38px tall because
                its trailing wrapper is always a `size-6` box (6 + 24 + 6 + 2
                border), so one line is 38+8(pb)=46px and two lines are
                38+8(gap)+38+8(pb)=92px. Both numbers are asserted by the
                geometry spec.
                The Direct pill renders here only in chat mode: Code mode's
                primary is supplied by its own runtime owner through `status`,
                and composing both would report one turn twice. */}
            <div
              data-status-row
              className="flex flex-wrap items-center gap-2 min-w-0 overflow-x-clip pb-2 min-h-[var(--status-reserved-height)]"
            >
              {mode === "chat" ? <AssistantStatusPill /> : null}
              {composerExtras?.status ?? null}
            </div>
            {composer}
            {showScopePicker && (
              <div className="px-1 pt-1">
                <WelcomeScopePicker editable={false} />
              </div>
            )}
            {/* Agent (Code) mode: display-only workspace chip — the OpenCode
                session's working directory is set at session-create time and
                cannot be re-rooted mid-session. Reuses the same static chip
                as bound Direct threads. The connection heart shares this
                constant-height row; it is deliberately OUTSIDE the reserved
                status row, and its popover is an out-of-flow overlay. */}
            {showAgentScopeChip && (
              <div data-composer-below className="flex items-center gap-1 px-1 pt-1">
                <div className="min-w-0 flex-1">
                  <WelcomeScopePicker editable={false} />
                </div>
                {composerExtras?.below}
              </div>
            )}
          </ComposerDock>
        </>
      )}
    </ThreadPrimitive.Root>
  );
}

/** One row's render info, as `ThreadPrimitive.Row` passes it. */
type ThreadRowInfo = Parameters<
  NonNullable<React.ComponentProps<typeof ThreadPrimitive.Row>["children"]>
>[0];

/**
 * Renders one assistant-ui thread row using TBAi's own components.
 *
 * Exported so the DOM suite can mount the REAL row composition — this switch
 * together with `selectTranscriptRows` — under a real runtime. A virtualizer
 * needs measurable scroll geometry that a DOM test cannot provide; the rows it
 * feeds are the part whose behaviour is asserted.
 *
 * `mode` is the owning engine, never re-derived from tool names.
 *
 * ## Why the assistant cases do not render `AssistantMessage`
 *
 * Core 0.3.30 emits a `message` row only for a non-assistant message or an
 * assistant message the composer is editing; every other assistant message
 * becomes `part` rows (and a part-less one becomes no rows at all). So
 * `AssistantMessage`, which owns the error card, the action bar and the
 * timeline, never mounted for the messages a reader actually sees — a failed
 * turn carried `status: { type: "incomplete", reason: "error" }` and showed
 * nothing. The chrome is therefore rendered from the row that owns it: the
 * first part row (timeline), the last part row (error + footer), and the
 * `turn-end` row for a part-less message, whose scopes all resolve through the
 * library's own `MessageByIdProvider`.
 */
export function ChatRow({ info, mode }: { info: ThreadRowInfo; mode: "chat" | "agent" }) {
  switch (info.type) {
    case "message":
      return info.message.role === "user" ? <UserMessage /> : <AssistantMessage mode={mode} />;
    case "part":
      return (
        <AssistantPartRow part={info.part} indices={info.row.indices} mode={mode}>
          {info.children}
        </AssistantPartRow>
      );
    case "turn-end":
      return <PartlessAssistantTail />;
    default:
      return null;
  }
}

/**
 * One part row: the part itself plus the message-level chrome the row owns.
 *
 * The timeline goes on the FIRST row because it summarizes the whole turn and
 * has always sat above the parts; the error card and footer go on the LAST row
 * because they close the message. Exactly one row can satisfy each condition
 * (`indices` partition the message's parts), so neither duplicates across
 * rows, and a one-row message owns both.
 */
function AssistantPartRow({
  part,
  indices,
  mode,
  children,
}: {
  part: Parameters<typeof AssistantPart>[0]["part"];
  indices: readonly number[];
  mode: "chat" | "agent";
  children?: ReactNode;
}) {
  const partCount = useAuiState((s) => s.message.parts.length);
  const isFirstRow = Math.min(...indices) === 0;
  const isLastRow = Math.max(...indices) === partCount - 1;

  return (
    <>
      {isFirstRow && shouldShowSessionTimeline({ mode }) ? <SessionTimeline /> : null}
      <AssistantPart part={part}>{children}</AssistantPart>
      {isLastRow ? <AssistantMessageTail /> : null}
    </>
  );
}

/**
 * The turn-end row's chrome, for the one message shape that has no rows of its
 * own.
 *
 * Both engines can produce an assistant message with `content: []` and an error
 * status — the AI SDK converter appends one when the last message is not an
 * assistant, and the OpenCode projection does the same when no assistant
 * message can be named. Such a message yields no part rows, so its error would
 * otherwise have nowhere to render. Every other assistant message renders its
 * tail from its last part row (or, while editing, from its `message` row), so
 * this is deliberately narrow: it must not fire for those, or the card would
 * appear twice.
 */
function PartlessAssistantTail() {
  const ownedElsewhere = useAuiState(
    (s) =>
      s.message.role !== "assistant" || s.message.composer.isEditing || s.message.parts.length > 0,
  );
  return ownedElsewhere ? null : <AssistantMessageTail />;
}

/** The closing chrome of an assistant message: its error, then its footer. */
function AssistantMessageTail() {
  return (
    <>
      <AssistantError />
      <AssistantTurnFooter />
    </>
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
        <MessageCopyAction />
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

      <AssistantTurnFooter />
    </MessagePrimitive.Root>
  );
}

const SENT_AT_TIME = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});
const SENT_AT_DATE_AND_TIME = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** Today shows the clock alone; older turns also name the day. */
function formatSentAt(epochMs: number): string {
  const sentAt = new Date(epochMs);
  const isToday = sentAt.toDateString() === new Date().toDateString();
  return (isToday ? SENT_AT_TIME : SENT_AT_DATE_AND_TIME).format(sentAt);
}

const TOKEN_THOUSAND = 1_000;
const TOKEN_MILLION = 1_000_000;

/** `4660` -> `4.7k`, `1_240_000` -> `1.2M`. */
function compactTokenCount(total: number): string {
  if (total >= TOKEN_MILLION) return `${(total / TOKEN_MILLION).toFixed(1)}M`;
  if (total >= TOKEN_THOUSAND) return `${(total / TOKEN_THOUSAND).toFixed(1)}k`;
  return String(total);
}

/**
 * `google` -> `Google`. The first letter only, so a configured name that already
 * carries its own capitalisation — `OpenRouter`, `Ollama` — is left alone.
 */
function capitalizeFirst(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** `-`, `_` and whitespace all read as word breaks in a model id. */
const MODEL_NAME_BREAK = /[-_\s]+/;

/**
 * A model id written as a name: `gemini-3.5-flash-lite` -> `Gemini 3.5 Flash Lite`.
 *
 * Used only when the provider configuration carries no `label` for the model,
 * which is the normal case: Gemini's discovery endpoint reports no display name,
 * so every Gemini turn would otherwise read as a raw slug. The untouched id stays
 * in the segment's `title`, because the id is the fact and this is its reading
 * form.
 */
function formatModelName(id: string): string {
  return id
    .split(MODEL_NAME_BREAK)
    .filter((word) => word.length > 0)
    .map(capitalizeFirst)
    .join(" ");
}

/** Footer metadata as both engines write it. */
interface AssistantFooterCustom {
  usage?: { totalTokens?: number };
  modelId?: string;
  providerId?: string;
  reasoningLevel?: string;
  agent?: string;
  turnStartedAt?: number;
  turnTiming?: { startedAt: number; endedAt: number; durationMs: number };
}

/**
 * The message's closing footer.
 *
 * One line, in reading order: what answered (model details), how (agent, Code
 * only), how long it took, and when it was sent — then the token count and the
 * copy/regenerate actions. Everything flows in that order at one type size;
 * nothing is pushed to the trailing edge, so the end of the line is the end of
 * the reading, not a separate right-hand column.
 *
 * ## Both times, always
 *
 * The duration and the sent-at clock used to share one slot with a hover swap:
 * the duration while the vendor's in-memory timing survived, the stored clock
 * after a reload. The consumer sees one number that silently changes meaning.
 * Now both are rendered, always, and both come from the same place: the
 * server's turn record.
 *
 *  - `custom.turnStartedAt` is written on the stream's `start` event (Direct)
 *    or taken from the assistant record's `time.created` (Code). The live
 *    count is `now - turnStartedAt`, so it is anchored to the request, not to
 *    the moment the footer mounted — a new part remounting the last row cannot
 *    restart it.
 *  - `custom.turnTiming` is closed on `finish` (Direct) or from
 *    `time.completed` (Code), so the settled duration is the same number
 *    before and after a reload.
 *
 * An answer recorded before the turn clock existed has neither, and then this
 * footer shows no duration and no clock. That is deliberate: the only time the
 * runtime can supply for restored Direct history is `createdAt`, which it
 * assigns when the page loads, so a fallback to it would print the current time
 * as the send time — the exact confusion being fixed here.
 *
 * The vendor's `useMessageTiming` is deliberately not read: it is measured from
 * the first streamed chunk, lives in memory only, and its converter overwrites
 * stored metadata while a turn is live.
 */
function AssistantTurnFooter() {
  // Liveness is PER MESSAGE, not per thread.
  //
  // `message.status.type === "running"` is the runtime's own answer, and both
  // engines maintain it in the same place: the external-store core derives an
  // auto status as `isLast && isRunning` (core `runtime/utils/auto-status.ts`),
  // which is what backs Direct (`useChatRuntime`) and Code (the OpenCode
  // projection) alike. The previous predicate paired a per-message signal
  // (`timing`, never persisted) with `thread.isRunning`, so every restored or
  // completed message looked live for as long as any turn was streaming — a
  // spinner on all history, and the provenance row hidden behind it.
  const isRunningMessage = useAuiState((s) => s.message.status?.type === "running");
  const custom = useAuiState(
    (s) =>
      (s.message.role === "assistant"
        ? (s.message.metadata?.custom as AssistantFooterCustom | undefined)
        : undefined) ?? undefined,
  );
  // The footer is a reading surface and the server stores ids, so display names
  // come from the same provider configuration the composer reads.
  const providers = useSettingsStore((s) => s.providers);
  const provider = custom?.providerId
    ? providers.find((p) => p.id === custom.providerId)
    : undefined;

  const total = custom?.usage?.totalTokens;
  const modelId = custom?.modelId;
  const providerName = provider
    ? capitalizeFirst(provider.name)
    : custom?.providerId
      ? capitalizeFirst(custom.providerId)
      : undefined;
  // A configured label wins. Otherwise the id is written as a name, because a
  // slug is a storage key, not something a reader should be shown.
  const modelName = modelId
    ? (provider?.models?.find((m) => m.id === modelId)?.label ?? formatModelName(modelId))
    : undefined;
  const thinking =
    custom?.reasoningLevel && custom.reasoningLevel !== "off" ? custom.reasoningLevel : undefined;
  const agent = custom?.agent;

  // A running message whose turn record is already closed (the stream finished
  // while the thread settles) shows the settled duration, not a live count.
  const settledDurationMs = custom?.turnTiming?.durationMs;
  const liveAnchor =
    settledDurationMs === undefined && isRunningMessage ? custom?.turnStartedAt : undefined;

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (liveAnchor === undefined) return;
    // Seed immediately: the first interval tick is a full second away, and the
    // clock would otherwise stand still for that second.
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), messageActionsConfig.liveTickMs);
    return () => clearInterval(interval);
  }, [liveAnchor]);

  // Routed through `formatDuration`, the one owner of how a span is written.
  //
  // These two used to format inline with `(ms / 1000).toFixed(1)`, which is the
  // exact defect `formatDuration` was written to remove: a real 299-second turn
  // rendered `299.0s` in this footer while the tool badge on the same card read
  // `4m 59s`. Two spellings of the same fact on one screen, one of them
  // unreadable. Caught by looking at a live subagent capture, not by a test.
  const durationLabel =
    settledDurationMs === undefined
      ? liveAnchor === undefined
        ? undefined
        : formatDuration(Math.max(0, now - liveAnchor))
      : formatDuration(settledDurationMs);

  // When the turn was sent — from the persisted turn record, and nothing else.
  //
  // `message.createdAt` is deliberately NOT a fallback. On a restored Direct
  // history the runtime assigns it at import time, because the history window
  // carries `{ id, parent_id, format, content }` and no timestamp of its own;
  // printing it would put the moment the page loaded on every old answer as if
  // it were when the turn was sent. That is the "refresh shows the current time"
  // confusion this footer exists to remove, so an answer recorded before the
  // turn clock shows no clock rather than a fabricated one.
  const sentAt = custom?.turnTiming?.startedAt ?? custom?.turnStartedAt;

  const separators = messageActionsConfig.footer;
  const segments: { key: string; node: ReactNode }[] = [];
  if (providerName || modelName || thinking) {
    segments.push({
      key: "model",
      node: (
        <span
          data-slot="message-model"
          className="min-w-0 truncate text-muted-foreground"
          title={modelId}
        >
          {providerName ? <span className="text-muted-foreground/70">{providerName} </span> : null}
          {modelName}
          {thinking ? <span className="text-muted-foreground/70"> thinking:{thinking}</span> : null}
        </span>
      ),
    });
  }
  if (agent) {
    segments.push({
      key: "agent",
      node: (
        <span data-slot="message-agent" className="text-muted-foreground">
          {agent}
        </span>
      ),
    });
  }
  if (durationLabel !== undefined) {
    segments.push({
      key: "duration",
      node: (
        <span
          data-slot={liveAnchor === undefined ? "turn-duration" : "live-turn"}
          className="flex items-center gap-1 tabular-nums text-muted-foreground"
        >
          {liveAnchor === undefined ? null : <Loader2 className="size-3 animate-spin" />}
          {durationLabel}
        </span>
      ),
    });
  }
  if (sentAt !== undefined) {
    segments.push({
      key: "sent-at",
      node: (
        <span data-slot="message-sent-at" className="text-muted-foreground">
          {formatSentAt(sentAt)}
        </span>
      ),
    });
  }
  if (total != null) {
    segments.push({
      key: "tokens",
      node: (
        <span
          data-slot="message-tokens"
          className="tabular-nums text-muted-foreground/70"
          title={separators.tokensTitle(total)}
        >
          {compactTokenCount(total)} {separators.tokenSuffix}
        </span>
      ),
    });
  }

  return (
    <div
      data-slot="turn-footer"
      className={cn(
        "mt-1.5 flex min-h-6 flex-wrap items-center gap-x-1.5 gap-y-1 text-2xs",
        liveAnchor === undefined ? "opacity-80 hover:opacity-100" : "opacity-100",
      )}
    >
      {/* Every segment in reading order, separated uniformly, then the actions —
          nothing is pinned to the trailing edge, so the line reads left to right
          all the way through. */}
      {segments.map((segment, index) => (
        <Fragment key={segment.key}>
          {index > 0 ? (
            <span aria-hidden className="text-muted-foreground/70">
              {separators.separator}
            </span>
          ) : null}
          {segment.node}
        </Fragment>
      ))}
      <MessageActions />
    </div>
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
