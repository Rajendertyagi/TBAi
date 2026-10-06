"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AuiIf,
  ComposerPrimitive,
  unstable_useComposerInput,
  unstable_useSlashCommandAdapter,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import { cn } from "@/lib/utils";
import {
  ArrowUp,
  Bot,
  Brain,
  Check,
  ChevronDown,
  File,
  Image,
  Mic,
  Paperclip,
  Square,
} from "lucide-react";
import { composerConfig, streamRecoveryCopy } from "../config/composer";
import { logger } from "../lib/logger";
import { useSettingsStore } from "../stores";
import type { ReasoningLevel } from "../types";
import { useWelcomeEngineStore } from "../features/chat/state/welcomeEngine";
import { useChatTabsStore } from "../features/chat/state/chatTabs";
import {
  captureDraftSnapshot,
  materializeDraft,
} from "../features/chat/state/materializeDraft";
import { setPendingFirstMessage } from "../features/chat/state/pendingFirstMessage";
import { useStreamRecoveryStore } from "../features/chat/state/streamRecovery";
import { useAvailabilityStore } from "../features/availability/availabilityStore";
import {
  clearComposerDraft,
  readComposerDraft,
  writeComposerDraft,
} from "../features/chat/state/composerDraft";
import { useMcpStore } from "../stores/mcpStore";
import { TooltipIconButton } from "./assistant-ui/elements/tooltip-icon-button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip";
import { ComposerContextMenu } from "./chat/ComposerContextMenu";
import { cancelActiveRun } from "../features/chat/state/deleteConversation";
import {
  buildDividerPart,
  DIRECT_COMPACT_COMMAND,
  parseDirectCompactCommand,
  runDirectCompact,
  type DirectCompactCommandMatch,
} from "../features/chat/compactCommand";
import { buildDirectCompactEntries } from "../features/chat/directCompactEntries";
import { useKeyboardClaimed } from "../lib/focus";
import { ModelOptionList } from "./chat/ModelOptionList";
import { buildModelGroups, resolveModelOwner } from "../lib/model-groups";
import { OpenCodeAgentChip } from "../features/opencode/OpenCodeAgentChip";
import { OpenCodeModelChip } from "../features/opencode/OpenCodeModelChip";
import { OpenCodeThinkingChip } from "../features/opencode/OpenCodeThinkingChip";
import { OpenCodeShieldChip } from "../features/opencode/OpenCodeShieldChip";
import { useCommandsStore } from "../features/opencode/commandsStore";
import {
  applyCommandSelection,
  toSlashCommands,
} from "../features/opencode/slashCommands";
import {
  buildCompactEntry,
  isCompactCommandText,
  runCompactSession,
  shouldOfferCompact,
} from "../features/opencode/compactSession";
import { useOpenCodeRuntimeContext } from "../features/opencode/opencodeRuntimeContext";
import { useDesktopLayout } from "../features/desktop/state/desktopLayout";
import { OpenCodeContextRing } from "../features/opencode/OpenCodeContextRing";
import { DirectContextRing } from "./context-ring";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "./ui/dropdown-menu";

/**
 * The four levels, `Off` included.
 *
 * `Off` is a level, not a "default" placeholder: with it selected the provider
 * receives no thinking option and no reasoning part can come back. Naming the
 * off state honestly is what lets a reader tell thinking is disabled.
 */
const THINKING_OPTIONS: ReadonlyArray<{ id: ReasoningLevel; label: string }> = [
  { id: "off", label: composerConfig.copy.thinkingOff },
  { id: "low", label: composerConfig.copy.thinkingLow },
  { id: "medium", label: composerConfig.copy.thinkingMedium },
  { id: "high", label: composerConfig.copy.thinkingHigh },
];

type ConversationCustom = {
  providerId?: string | null;
  modelId?: string | null;
  reasoningLevel?: ReasoningLevel | null;
  engine?: "direct" | "opencode";
};

function ModelChip() {
  const {
    providers,
    activeProviderId,
    selectedProviderId,
    selectedModelId,
    selectChatTarget,
  } = useSettingsStore();
  const aui = useAui();
  const custom = useAuiState((s) => s.threadListItem.custom) as
    | ConversationCustom
    | undefined;
  const [open, setOpen] = useState(false);

  // Every provider's models, grouped under its name (single source in
  // lib/model-groups — the picker list consumes the same groups).
  const groups = buildModelGroups(providers, activeProviderId);

  // Effective selection: one-shot picker override wins, else the conversation
  // default (custom), else the global active provider's model.
  let currentProviderId =
    selectedProviderId ?? custom?.providerId ?? activeProviderId;
  let currentModelId: string | undefined;
  if (selectedModelId) {
    const owner = resolveModelOwner(groups, selectedModelId);
    if (owner) {
      currentProviderId = owner.providerId;
      currentModelId = owner.modelId;
    }
  }
  currentModelId ??= custom?.modelId ?? undefined;
  const currentProvider = providers.find((p) => p.id === currentProviderId);
  currentModelId ??= currentProvider?.model ?? "";
  const currentModel =
    groups
      .flatMap((g) => g.models)
      .find((m) => m.id === currentModelId) ?? undefined;
  const label = currentModel?.label ?? currentModelId ?? composerConfig.copy.selectModel;

  const handleSelect = (providerId: string, modelId: string) => {
    // Set the one-shot override for the NEXT message, AND persist it as this
    // conversation's default (SQLite source of truth) so it survives reloads
    // and is the baseline for subsequent messages. On a draft there is no
    // server row yet: the one-shot plus the initialize() carry own the pick,
    // so skip the PATCH (the SDK throws updateCustom on unbound threads).
    selectChatTarget(providerId, modelId);
    let remoteId: string | null = null;
    try {
      remoteId = (aui.threadListItem.getState() as { remoteId?: string | null }).remoteId ?? null;
    } catch {
      remoteId = null;
    }
    if (!remoteId) {
      setOpen(false);
      return;
    }
    const base = (aui.threadListItem.getState().custom ?? {}) as ConversationCustom;
    aui.threadListItem.updateCustom({
      ...base,
      providerId,
      modelId,
    });
    setOpen(false);
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-1.5 h-7 rounded-full",
            "px-2.5 text-xs text-muted-foreground hover:text-foreground",
            "hover:bg-accent/50 transition-colors cursor-pointer",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          )}
        >
          <Bot className="size-3.5 shrink-0" />
          <span className="max-w-30 truncate">{label}</span>
          <ChevronDown className="size-3 shrink-0 opacity-50" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="min-w-55 p-0">
        {groups.length === 0 ||
        groups.every((g) => g.models.length === 0) ? (
          <div className="px-3 py-6 text-center text-sm text-muted-foreground">
            {composerConfig.copy.noModels}
          </div>
        ) : (
          <ModelOptionList
            groups={groups}
            currentProviderId={currentProviderId ?? undefined}
            currentModelId={currentModelId}
            onSelect={(providerId, modelId) => handleSelect(providerId, modelId)}
            searchPlaceholder={composerConfig.copy.modelSearchPlaceholder}
            searchAriaLabel={composerConfig.copy.modelSearchAria}
            listAriaLabel={composerConfig.copy.modelListAria}
            emptyLabel={composerConfig.copy.modelEmpty}
          />
        )}
        {currentProvider && (
          <>
            <DropdownMenuSeparator />
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              {composerConfig.copy.nextMessage(
                currentProvider.name,
                currentModelId || composerConfig.copy.defaultSuffix,
              )}
            </div>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ThinkingChip() {
  const [open, setOpen] = useState(false);
  const aui = useAui();
  const custom = useAuiState((s) => s.threadListItem.custom) as
    | ConversationCustom
    | undefined;
  // Display follows: one-shot override > conversation default > provider default.
  const stored = useSettingsStore((s) => s.selectedReasoningLevel);
  const providerDefault = useSettingsStore((s) => {
    const pid = s.selectedProviderId ?? custom?.providerId ?? s.activeProviderId;
    return s.providers.find((p) => p.id === pid)?.thinking ?? "off";
  });
  // Show the level that will actually be used. The old code mapped "off" onto a
  // "Default" label, so a conversation with thinking disabled still read as if
  // something would happen.
  const selected: ReasoningLevel =
    stored ?? custom?.reasoningLevel ?? providerDefault;

  const handleSelect = (level: ReasoningLevel) => {
    setOpen(false);
    // Persist the chosen level as the conversation default AND as the one-shot
    // pick, so the very next message uses exactly what was chosen. Drafts have
    // no server row yet (one-shot + initialize() carry own the pick), so skip
    // the PATCH there — the SDK throws updateCustom on unbound threads.
    useSettingsStore.getState().setSelectedReasoningLevel(level);
    let remoteId: string | null = null;
    try {
      remoteId = (aui.threadListItem.getState() as { remoteId?: string | null }).remoteId ?? null;
    } catch {
      remoteId = null;
    }
    if (!remoteId) return;
    const base = (aui.threadListItem.getState().custom ?? {}) as ConversationCustom;
    aui.threadListItem.updateCustom({ ...base, reasoningLevel: level });
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-1.5 h-7 rounded-full",
            "px-2.5 text-xs text-muted-foreground hover:text-foreground",
            "hover:bg-accent/50 transition-colors cursor-pointer",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          )}
        >
          <Brain className="size-3.5 shrink-0" />
          <span className="max-w-20 truncate">
            {THINKING_OPTIONS.find((o) => o.id === selected)?.label ?? composerConfig.copy.thinking}
          </span>
          <ChevronDown className="size-3 shrink-0 opacity-50" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="min-w-30">
        {THINKING_OPTIONS.map((opt) => (
          <DropdownMenuItem
            key={opt.id}
            className={cn(
              "justify-between",
              opt.id === selected && "bg-accent text-accent-foreground",
            )}
            onSelect={() => handleSelect(opt.id)}
          >
            {opt.label}
            {opt.id === selected && (
              <Check aria-hidden="true" className="ml-auto size-3.5 shrink-0" />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AttachDropdown() {
  const handlePickImage = async () => {
    logger.debug("composer", "attach_not_wired", { message: "pick image" });
  };
  const handlePickFile = async () => {
    logger.debug("composer", "attach_not_wired", { message: "pick file" });
  };
  const handlePickGithub = async () => {
    logger.debug("composer", "attach_not_wired", { message: "pick github" });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <TooltipIconButton tooltip={composerConfig.copy.attach} side="top">
          <Paperclip className="size-3.5" />
        </TooltipIconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start">
        <DropdownMenuItem onSelect={handlePickImage}>
          <Image className="size-3.5" />
          <span>{composerConfig.copy.addImage}</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={handlePickFile}>
          <File className="size-3.5" />
          <span>{composerConfig.copy.addFile}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={handlePickGithub}>
          <span>{composerConfig.copy.addGithub}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The app's single composer instance (one definition, one live mount —
 * ChatWindow owns the tag and injects it into the welcome/docked placement).
 * The box is textarea + button row only, unconditionally identical
 * everywhere; the folder scope chip renders as a separate row below it
 * (deliberate divergence from Codeg's inside-the-box row — see decisions).
 */
function Composer({
  isWelcomeDraft = false,
  isCodeSurface = false,
}: {
  /** True only on the welcome draft (drives the draft-only OpenCode chips). */
  isWelcomeDraft?: boolean;
  /** True on the Code surface (bound OpenCode conversation). */
  isCodeSurface?: boolean;
}) {
  // Why BOTH the headless hook and `ComposerPrimitive.Input` (below): the
  // primitive owns the textarea (auto-resize, submit keys, focus), while this
  // hook exposes the same composer state as VALUES so the custom send path can
  // intercept a send before the library performs it — the OpenCode draft first
  // send must be materialized and handed off, never sent to Direct /api/chat.
  // The docs present the hook as an alternative to the primitive for owning the
  // DOM outright; using both is deliberate here, and only for that interception.
  const { value: composerText, setText, send: sendViaRuntime } = unstable_useComposerInput();
  const aui = useAui();
  // True while a decision card (a permission request, or an agent question) owns
  // the keyboard. See `lib/focus.ts` for why the composer has to yield.
  const keyboardClaimed = useKeyboardClaimed();
  // Thread identity for draft persistence. Guarded: the composer also mounts
  // under runtimes where the thread item may be momentarily unavailable —
  // without an identity we skip persistence rather than cross-contaminate.
  const threadKey = (() => {
    try {
      const item = aui.threadListItem.getState() as {
        remoteId?: string | null;
        id?: string | null;
      };
      return item.remoteId ?? item.id ?? null;
    } catch {
      return null;
    }
  })();
  const isOffline = useAvailabilityStore((s) => s.status === "offline");

  // ── Dead-run recovery (Phase 3) ────────────────────────────────────────────
  // The third inline strip, sibling to `codeSendError` and `compactError`.
  //
  // Retry is offered ONLY when the server confirmed the run is `interrupted` AND
  // the prompt survived (`canRetry`). Those two conditions are the whole safety
  // story: a run that completed can never satisfy the first, and a run whose
  // prompt is unknown can never satisfy the second — so Retry can neither
  // duplicate a finished reply nor send an empty message. Everything else shows
  // the sentence and no button, which is the honest direction to fail.
  const recovery = useStreamRecoveryStore((s) => (threadKey ? s.byThread[threadKey] : undefined));
  const [retrying, setRetrying] = useState(false);
  const retryInterruptedRun = () => {
    if (retrying || !recovery?.canRetry || !recovery.prompt.trim()) return;
    setRetrying(true);
    try {
      // A NEW run, never a resume: appending a user turn with `startRun` starts a
      // fresh run with a new stream id and a new assistant message id. `startRun`
      // is set explicitly rather than relying on the `role === "user"` default,
      // because the runtime can be sitting in an error state after the dead
      // resume and the intent should not be inferred. The interrupted row is left
      // untouched for its retention window and is never re-driven.
      aui.thread().append({
        role: "user",
        content: [{ type: "text", text: recovery.prompt }],
        runConfig: aui.composer.getState().runConfig,
        startRun: true,
      });
      clearComposerDraft(threadKey);
      setText("");
      if (threadKey) useStreamRecoveryStore.getState().clear(threadKey);
    } finally {
      setRetrying(false);
    }
  };

  // Draft durability (Phase 3.7): restore once on mount when the box is empty
  // and a saved draft exists; persist every non-empty change; drop the key
  // when the box empties (send or manual clear). Recovery never auto-submits.
  const draftRestored = useRef(false);
  useEffect(() => {
    if (draftRestored.current || !threadKey) return;
    draftRestored.current = true;
    if (composerText) return;
    const saved = readComposerDraft(threadKey);
    if (saved) setText(saved.text);
  }, [threadKey, composerText, setText]);
  useEffect(() => {
    if (!threadKey || !draftRestored.current) return;
    writeComposerDraft(threadKey, composerText);
  }, [threadKey, composerText]);
  // Draft engine for the welcome surface. Bound threads never set
  // isWelcomeDraft, so showOpenCodeDraft is true only on the new-chat draft
  // with the OpenCode engine — never inferred, always explicit.
  const draftEngine = useWelcomeEngineStore((s) => s.engine);
  const showOpenCodeDraft = isWelcomeDraft && draftEngine === "opencode";

  // ── Slash commands (OpenCode surface only) ───────────────────────────────
  // The commands are OpenCode's own; the Direct runtime cannot execute them, so
  // the palette is mounted only where an OpenCode session is behind the send —
  // the bound Code surface or the OpenCode new-chat draft. Showing them on
  // Direct would offer a command that could never run.
  const slashCommandsEnabled = isCodeSurface || showOpenCodeDraft;
  const openCodeCommands = useCommandsStore((s) => s.commands);
  const loadOpenCodeCommands = useCommandsStore((s) => s.load);
  useEffect(() => {
    if (!slashCommandsEnabled) return;
    void loadOpenCodeCommands();
  }, [slashCommandsEnabled, loadOpenCodeCommands]);

  // ── Built-in /compact (bound OpenCode session only) ─────────────────────
  // `/compact` is NOT in the OpenCode `/command` feed, so it is a TBAi-side
  // built-in appended after the feed entries — never a fake feed entry. The
  // ambient runtime context is non-null only inside a session-bound Code
  // surface (null on Direct and on the session-less welcome draft), so gating
  // on it keeps `/compact` off every surface that has no session to compact.
  const openCodeRuntimeContext = useOpenCodeRuntimeContext();
  const canCompact = shouldOfferCompact(isCodeSurface, openCodeRuntimeContext);

  // The library hook owns trigger detection, filtering and keyboard routing;
  // only the item list and the execute action are ours. Called unconditionally
  // (hooks may not be conditional) — an empty list simply never opens.
  //
  // Direct contributes its OWN commands here. It previously contributed none, because
  // the palette was gated on `slashCommandsEnabled` — an OpenCode-only condition —
  // which left `/compact` reachable only by typing all seven characters. The gate was
  // right for the OpenCode feed and wrong for the built-in: the feed's commands cannot
  // run on Direct, but `/compact` is Direct's own and always could.
  //
  // The rows are built by a pure function rather than inline here, so the token→name
  // conversion the palette depends on is executable by a test. It was previously a
  // source-string assertion, which passed while the entry still inserted `//compact `.
  const directSlashEntries = useMemo(
    () =>
      buildDirectCompactEntries(
        composerConfig.copy.compactCommandDescription,
        (name) => setText(applyCommandSelection(composerText, name)),
      ),
    [composerConfig.copy.compactCommandDescription, composerText, setText],
  );

  const slashEntries = useMemo(
    () => [
      ...(slashCommandsEnabled
        ? toSlashCommands(openCodeCommands, (command) => {
          // Selection inserts `/name ` and leaves the composer to the user:
          // the command runs when they send, so arguments stay editable.
          setText(applyCommandSelection(composerText, command.name));
          logger.info("opencode", "command.selected", {
            name: command.name,
            source: command.source,
          });
        })
        : []),
      // Built-in compact: selection also only inserts the text — the submit
      // interception below performs the summarize, so palette and typed input
      // share one execution path and selection alone never sends anything.
      ...(canCompact
        ? [buildCompactEntry((name) => {
          setText(applyCommandSelection(composerText, name));
          logger.info("opencode", "command.selected", {
            name,
            source: "builtin",
          });
        })]
        : []),
      ...(slashCommandsEnabled ? [] : directSlashEntries),
    ],
    [
      slashCommandsEnabled,
      openCodeCommands,
      canCompact,
      composerText,
      setText,
      directSlashEntries,
    ],
  );
  const slash = unstable_useSlashCommandAdapter({
    commands: slashEntries,
    // No directive chip: OpenCode wants the literal `/name args` text, so the
    // library's trigger text is removed and `onExecute` writes plain text.
    removeOnExecute: true,
  });

  // Built-in /compact execution (Code surface only). The submit interception
  // below (`onSubmit` on the Root form) diverts a `/compact` box here BEFORE
  // the library's own submit handler runs — `preventDefault` in our handler
  // skips theirs via the library's composed `onSubmit`, so one guard covers
  // Enter, the Send button, and touch submit together. The literal text is
  // never sent as a prompt; completion arrives through the normal
  // session/message sync (the adapter already projects `compaction` parts).
  // Failure keeps a truthful error and never claims success.
  const [compacting, setCompacting] = useState(false);
  const [compactError, setCompactError] = useState<string | null>(null);
  const runCompact = async () => {
    const context = openCodeRuntimeContext;
    if (!context?.compact || compacting) return;
    // Narrowed to a plain function: the controller builds `compact` as a
    // closure over its own state, so it never reads `this` and is safe to
    // hand to the feature module as a value.
    const compact: () => Promise<void> = context.compact;
    setCompacting(true);
    setCompactError(null);
    try {
      // The lifecycle events live with the feature, not here: the Composer owns
      // the buttons, `compactSession` owns what a compact run means.
      await runCompactSession(() => compact(), {
        sessionId: context.sessionId,
      });
      setText("");
      clearComposerDraft(threadKey);
    } catch (err) {
      setCompactError(err instanceof Error ? err.message : String(err));
    } finally {
      setCompacting(false);
    }
  };
  // ── Direct `/compact` execution ─────────────────────────────────────────
  // The conversation as the thread currently holds it. Read during render
  // because `useAuiState` is a subscription, not an imperative getter — the value
  // is always the latest one a render has seen, and every send re-renders before
  // the next submit can happen.
  const directThreadMessages = useAuiState(
    (s) =>
      (s.thread.messages as ReadonlyArray<{
        id?: unknown;
        role?: unknown;
        parts?: unknown;
        metadata?: unknown;
      }> | undefined) ?? [],
  );
  // The command leaves its result IN THE TRANSCRIPT, not in composer state. That is
  // the whole point: a compaction is an event in the conversation, so it is a
  // message part the history adapter persists and the codec reloads — not React
  // state that vanishes on refresh.
  //
  // `compacting` / `compactError` are deliberately NOT touched here. They are shared
  // with the Code surface's own compact (declared at Composer.tsx:505), and driving
  // them from Direct is exactly what produced the composer toast this replaces.
  //
  // `directCompacting` is therefore a SEPARATE flag for a separate reason: it is not
  // an outcome, it is only "the summariser is running". The outcome belongs to the
  // divider in the transcript, and putting it back in the composer is the regression
  // this boundary exists to prevent.
  const [directCompacting, setDirectCompacting] = useState(false);
  const runDirectCompactCommand = async (command: DirectCompactCommandMatch) => {
    // Set BEFORE the await, not after: the whole gap this closes is the silence
    // between submit and the summariser finishing.
    setDirectCompacting(true);
    try {
      const status = await runDirectCompact({
        conversationId: threadKey,
        messages: directThreadMessages,
        command,
      });
      // `startRun: false`: the divider records what just happened, it is not a
      // prompt. No chat run, no provider call, no assistant reply.
      //
      // This is the OPTIMISTIC half only. The server already wrote the durable row
      // (`anchorMessageId`) — `thread().append()` is not a persistence path in this
      // runtime, because `adapters.history` is unset and only transported messages
      // are written. The append exists so the divider is on screen immediately; the
      // row the server wrote is what a reload replays, so exactly one divider
      // exists after a refresh.
      aui.thread().append({
        role: "assistant",
        content: [buildDividerPart(status)],
        startRun: false,
      });
      // Consumed either way: nothing to retry, and leaving the text in the box
      // would invite a second identical compaction.
      setText("");
      clearComposerDraft(threadKey);
    } catch {
      // Transport failure only — the request never produced a status, so there is
      // no outcome to represent. The text is KEPT so a retry is possible.
      logger.warn("direct", "compact.command_failed", { threadId: threadKey ?? undefined });
    } finally {
      // `finally`, not the success path: a thrown transport must not leave the
      // indicator stuck on with no way to clear it.
      setDirectCompacting(false);
    }
  };

  // The context panel's "Compress now" — routed through the SAME command handler the
  // typed `/compact` uses, not a second transport and not a direct call into
  // `runDirectCompact`.
  //
  // That routing is the whole guarantee: one path means one in-flight flag, one
  // optimistic append, one durable divider row, and the same text-retained-on-failure
  // behaviour. A shortcut straight to the transport would skip the append and leave
  // the user with no divider until a reload.
  //
  // Offered only on the Direct surface, where the command exists at all.
  const compactFromPanel = useMemo(() => {
    if (isCodeSurface) return undefined;
    return () => {
      const command = parseDirectCompactCommand(DIRECT_COMPACT_COMMAND);
      if (command) void runDirectCompactCommand(command);
    };
  }, [isCodeSurface, directThreadMessages, threadKey]);

  const pendingInsert = useMcpStore((s) => s.pendingInsert);
  const clearPendingInsert = useMcpStore((s) => s.clearPendingInsert);
  // Browser-native spell check, toggled in Settings > Appearance.
  const spellCheckEnabled = useDesktopLayout((s) => s.spellCheck);
  useEffect(() => {
    if (pendingInsert) {
      setText(pendingInsert);
      clearPendingInsert();
    }
  }, [pendingInsert, setText, clearPendingInsert]);

  // OpenCode draft first send (Phase 4): the Direct runtime must NEVER see
  // this send (it would mint an opencode row then fail the prompt with
  // ENGINE_MISMATCH 422). Instead: snapshot once → materialize via the
  // single owner → stash the text as the conversation's pending first prompt
  // → bind the agent tab (TabUrlSync navigates to /code/:id). The Code
  // surface consumes the stash into its session-bound runtime exactly once.
  // Failure keeps the text in the box (never cleared here) with a truthful
  // error; offline is already gated by the inert button below.
  const [codeSending, setCodeSending] = useState(false);
  const [codeSendError, setCodeSendError] = useState<string | null>(null);
  const sendOpenCodeDraft = async () => {
    if (codeSending || !composerText.trim()) return;
    const snapshot = captureDraftSnapshot();
    if (snapshot.engine !== "opencode") {
      // Engine flipped between render and click: fall back to the library
      // Direct send rather than dropping the user's click.
      sendViaRuntime();
      return;
    }
    setCodeSending(true);
    setCodeSendError(null);
    try {
      const created = await materializeDraft(snapshot);
      setPendingFirstMessage(created.id, composerText);
      // The one-shot pick was consumed by this handoff (carried into the row
      // by materialize): revert so it cannot leak into a later Direct draft.
      useSettingsStore.getState().revertChatTarget();
      clearComposerDraft(threadKey);
      useChatTabsStore.getState().resolveDraftId(created.id, snapshot.engine);
    } catch (err) {
      setCodeSendError(err instanceof Error ? err.message : String(err));
    } finally {
      setCodeSending(false);
    }
  };

  // ── The single send funnel ─────────────────────────────────────────────
  // EVERY submit — Enter, the Send button, touch, programmatic — arrives here,
  // and this is the only place that decides what submitting means.
  //
  // It has to be the only place, because the library cannot be asked to defer.
  // `ComposerPrimitive.Send` performs the send from its own click handler, which
  // runs BEFORE the form's submit event; and by the time either reaches the
  // transport, assistant-ui has already created the user message AND the history
  // adapter has already persisted it. Guarding only `onSubmit` therefore guarded
  // too late: measured in the browser, `/compact` still produced a persisted user
  // row and an empty assistant row. Nothing a response says can remove those, so
  // the decision has to move in front of the library, and the library's send is
  // then invoked explicitly below.
  const handleComposerSubmit = (e: { preventDefault(): void }) => {
    // Unconditional: the Composer owns sending, so the library's own submit
    // handler never also fires.
    e.preventDefault();
    // Code/OpenCode has a session-bound compact; its `/compact` must never be
    // re-routed to Direct.
    if (canCompact && isCompactCommandText(composerText)) {
      void runCompact();
      return;
    }
    const directCommand = isCodeSurface ? undefined : parseDirectCompactCommand(composerText);
    if (directCommand) {
      void runDirectCompactCommand(directCommand);
      return;
    }
    if (showOpenCodeDraft) {
      void sendOpenCodeDraft();
      return;
    }
    void sendViaRuntime();
  };

  return (
    <ComposerContextMenu>
      {/* The trigger-popover root groups the `/` declaration below and owns the
          shared input plugin registry. It renders nothing itself. */}
      <ComposerPrimitive.Unstable_TriggerPopoverRoot>
      <ComposerPrimitive.Root
        // No onContextMenu guard here on purpose. The composer's own right-click
        // menu is triggered by `ComposerContextMenu`, which wraps this form -
        // so a stopPropagation() on this inner element ran FIRST and killed the
        // event before it could ever reach that trigger. The page-menu guard
        // lives on the trigger instead (see ComposerContextMenu), where it still
        // suppresses the app-shell menu without eating the composer's own.
        // Non-mouse presses keep bubbling so panel selection bookkeeping is
        // untouched.
        onPointerDown={(event) => {
          if (event.pointerType !== "mouse") event.stopPropagation();
        }}
        // The SINGLE send funnel, and the reason the Send button is a plain submit:
        // the library's own send cannot be intercepted from here, so the Composer
        // owns sending outright and invokes the library's send itself. See
        // `handleComposerSubmit` for the measured reason.
        onSubmit={handleComposerSubmit}
        className={cn(
          "relative flex flex-col",
          "rounded-xl border-none glass-surface shadow-floating",
          "transition-shadow duration-200 ease-in-out",
          "focus-within:ring-1 focus-within:ring-ring",
        )}
      >
        {/* Textarea: the primitive owns auto-resize (controlled by the
            runtime, including programmatic clears on send) — no hand-rolled
            height hook, so paste-then-send always shrinks back. */}
        <div className="px-3 pb-1 pt-3">
          <ComposerPrimitive.Input
            autoFocus
            submitMode="enter"
            // Yield the keyboard while a decision card holds it. Both of these
            // default to TRUE in the library and TBAi never overrode them, so
            // scrolling to the bottom or starting a run would pull focus off
            // the card -- and Enter would then send an empty message instead of
            // approving. Restored as soon as the last card goes, so the
            // convenience is unchanged whenever nothing is being decided.
            unstable_focusOnScrollToBottom={!keyboardClaimed}
            unstable_focusOnRunStart={!keyboardClaimed}
            // Touch-primary devices get Return = newline instead of send, so a
            // half-typed message can't be submitted by the on-screen key
            // (matches ChatGPT / Slack / WhatsApp). Desktop is unchanged: the
            // flag only downgrades the default "enter" mode.
            unstable_insertNewlineOnTouchEnter
            // The platform's own spell checker — no bundled dictionary, no
            // library. User-controlled from Settings > Appearance, and on by
            // default (which is also the bare-textarea default, so omitting
            // the attribute would behave identically).
            spellCheck={spellCheckEnabled}
            placeholder="Send a message…  (Enter to send)"
            rows={1}
            className={cn(
              "w-full resize-none bg-transparent text-sm text-foreground",
              "placeholder:text-muted-foreground",
              "min-h-[2.5rem] max-h-40",
              "outline-none",
            )}
          />
        </div>

        {/* Slash-command palette. The library owns trigger detection, filtering
            and keyboard routing (plugins get first refusal on keydown, so
            Enter picks an item instead of submitting while the popover is
            open); this only supplies the items and the execute action. Mounted
            on the OpenCode surface only — see `slashCommandsEnabled`.
            The library keeps the popover open whenever the `/` trigger is
            detected, even when NOTHING matches the query — so an empty result
            would render as a small empty bordered box. The `:has` rule below
            hides the box when the item group is empty (Enter then submits the
            text normally); it depends only on the group being empty, never on
            library internals beyond the wrapper it renders. */}
        {slashEntries.length > 0 && (
          <ComposerPrimitive.Unstable_TriggerPopover
            char="/"
            adapter={slash.adapter}
            className={cn(
              "absolute bottom-full left-0 z-50 mb-1 max-h-72 w-full overflow-y-auto",
              "rounded-xl border-none p-1 glass-surface shadow-floating",
              "has-[.slash-command-items:empty]:hidden",
            )}
          >
            <ComposerPrimitive.Unstable_TriggerPopover.Action
              {...slash.action}
              removeOnExecute
            />
            <ComposerPrimitive.Unstable_TriggerPopoverItems className="slash-command-items">
              {(items) =>
                items.length === 0
                  ? null
                  : items.map((item, index) => (
                      // Single-line rows (label + inline truncated description),
                      // not stacked two-line cards: 24 mixed command/skill rows
                      // scan as names first. Highlight MUST key on
                      // `data-highlighted` — that is the attribute the library
                      // sets on keyboard navigation (`data-selected` is never
                      // set, so styling it leaves arrow-key movement invisible).
                      <ComposerPrimitive.Unstable_TriggerPopoverItem
                        key={item.id}
                        item={item}
                        index={index}
                        className={cn(
                          "flex cursor-pointer flex-row items-baseline gap-2 rounded-lg px-2 py-1.5",
                          "text-sm text-popover-foreground",
                          "hover:bg-accent hover:text-accent-foreground",
                          "data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
                        )}
                      >
                        <span className="shrink-0 font-medium">{item.label}</span>
                        {item.description ? (
                          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                            {item.description}
                          </span>
                        ) : null}
                      </ComposerPrimitive.Unstable_TriggerPopoverItem>
                    ))
              }
            </ComposerPrimitive.Unstable_TriggerPopoverItems>
          </ComposerPrimitive.Unstable_TriggerPopover>
        )}

        {/*
          In-flight marker for a Direct `/compact`.

          Its OWN line between the textarea and the button row, deliberately: the
          button row is a fixed set of chips in a `justify-between` slot, so text
          placed inside it would shift every chip on appearance. A separate line adds
          vertical height only while compacting, which does not move anything.

          `role="status"` so the wait is announced. This is the opposite of the
          transcript divider, which carries no role because its label is static
          content; this one APPEARS, and a silent appearance is indistinguishable
          from a hung app.

          No outcome is shown here, ever. The outcome is the divider in the
          transcript; a composer-level verdict is the toast this replaced.
        */}
        {directCompacting ? (
          <p
            role="status"
            className="mx-3 mb-1 text-xs text-muted-foreground select-none"
          >
            {composerConfig.copy.compactingContext}
          </p>
        ) : null}

        {/* Button row: attach on left, thinking/model/voice/send-stop on right */}
        <div className="flex items-end justify-between gap-1.5 px-3 pb-3 pt-2">
          {/* Left: attach */}
          <div className="flex items-end gap-1.5">
            <AttachDropdown />
          </div>

          {/* Right: thinking, model, voice, send/stop (single slot) */}
          <div className="flex items-center gap-1.5">
            {/* Thinking chip: persists to the conversation default ("Default" =
                 the provider's saved level); also sets a one-shot override for the
                 immediate next message. */}
            {/* OpenCode (both the started Code chat and the new-chat draft) renders
                 the same three independent chips — Agent, Model, Thinking — each
                 persisting to its own store column (bound conversation, or the
                 welcome-engine store in draft). Never the Direct provider chips,
                 and the Thinking chip auto-hides when the model exposes no
                 variants. Direct chat uses the thinking+model chips. */}
            {(isCodeSurface || showOpenCodeDraft) ? (
              <>
                <OpenCodeAgentChip />
                <OpenCodeModelChip />
                <OpenCodeThinkingChip />
                <OpenCodeShieldChip />
              </>
            ) : (
              <>
                <ThinkingChip />
                {/* Model chip */}
                <ModelChip />
              </>
            )}
            {/* Context ring: newest-message token totals against the
                model window (Direct: route metadata; Code: projected message
                tokens). Hidden until usage exists; beside send in all modes. */}
            {isCodeSurface || showOpenCodeDraft ? (
              <OpenCodeContextRing />
            ) : (
              <DirectContextRing {...(compactFromPanel === undefined ? {} : { onCompact: compactFromPanel })} />
            )}
            {/* Voice — always visible, disabled (no DictationAdapter) */}
            <TooltipIconButton tooltip="Voice not available" side="top" className="opacity-40 pointer-events-none">
              <Mic className="size-3.5" />
            </TooltipIconButton>
            {/* Single action slot (docs idiom): exactly one of Send / Cancel
                is mounted — arrow when idle, square Stop while generating.
                Same footprint, so the row never shifts on swap. While the
                backend is offline the Send primitive is replaced by an inert
                button (same footprint) that carries the "you are offline" copy:
                the draft is retained, nothing is sent or queued, and recovery
                never auto-submits.

                The BUTTON is not the gate — a disabled button only stops
                clicks. Enter (which submits the form) and any programmatic
                `aui.composer.send()` are held shut by `isSendDisabled` on the
                runtime; this swap exists for the copy and the affordance. */}
            <AuiIf condition={(s) => !s.thread.isRunning}>
              {isOffline ? (
                <button
                  type="button"
                  disabled
                  aria-label={composerConfig.copy.sendOffline}
                  title={composerConfig.copy.sendOfflineTitle}
                  className={cn(
                    "size-7 rounded-full flex items-center justify-center",
                    "bg-accent text-accent-foreground",
                    "disabled:opacity-30 disabled:pointer-events-none",
                  )}
                >
                  <ArrowUp className="size-3.5" />
                </button>
              ) : showOpenCodeDraft ? (
                <button
                  type="button"
                  onClick={() => void sendOpenCodeDraft()}
                  disabled={codeSending || !composerText.trim()}
                  aria-label={composerConfig.copy.sendMessage}
                  title={codeSendError ?? composerConfig.copy.sendMessage}
                  className={cn(
                    "size-7 rounded-full flex items-center justify-center",
                    "bg-accent text-accent-foreground",
                    "hover:bg-accent/90 active:scale-95",
                    "transition-all duration-150",
                    "disabled:opacity-30 disabled:pointer-events-none",
                  )}
                >
                  <ArrowUp className="size-3.5" />
                </button>
              ) : (
                // A PLAIN submit button, not `ComposerPrimitive.Send`.
                //
                // The primitive sends from its own click handler, which fires before
                // the form's submit event, so it cannot be intercepted from here and
                // would create the `/compact` message before the funnel ever ran.
                // Same footprint, same affordance, same disabled styling as its
                // offline sibling above; the funnel above is the only sender.
                // While a run is active this whole branch is unmounted (see the
                // `AuiIf` on `!thread.isRunning`), so no re-entrant send is possible
                // here, and `sendViaRuntime` remains the library's own send.
                <button
                  type="submit"
                  aria-label={composerConfig.copy.sendMessage}
                  disabled={!composerText.trim()}
                  className={cn(
                    "size-7 rounded-full flex items-center justify-center",
                    "bg-accent text-accent-foreground",
                    "hover:bg-accent/90 active:scale-95",
                    "transition-all duration-150",
                    "disabled:opacity-30 disabled:pointer-events-none",
                  )}
                >
                  <ArrowUp className="size-3.5" />
                </button>
              )}
            </AuiIf>
            <AuiIf condition={(s) => s.thread.isRunning}>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <ComposerPrimitive.Cancel asChild>
                      <button
                        type="button"
                        onClick={() => {
                          // Explicit server cancel: runs are server-owned, so
                          // the browser abort alone merely detaches. Shared
                          // helper looks up the resumable-store stream id and
                          // cancels it; fire-and-forget so the local cancel
                          // proceeds regardless of the outcome.
                          const item = aui.threadListItem.getState() as {
                            remoteId?: string | null;
                            id?: string | null;
                          };
                          void cancelActiveRun(item.remoteId ?? item.id);
                        }}
                        aria-label={composerConfig.copy.stopGenerating}
                        className={cn(
                          "size-7 rounded-full flex items-center justify-center",
                          "bg-destructive text-destructive-foreground",
                          "hover:bg-destructive/90 active:scale-95",
                          "transition-all duration-150",
                          "disabled:opacity-30 disabled:pointer-events-none",
                        )}
                      >
                        <Square className="size-3.5" />
                      </button>
                    </ComposerPrimitive.Cancel>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    {composerConfig.copy.stopGenerating}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </AuiIf>
          </div>
          {codeSendError && (
            <div className="px-3 pb-3" role="alert">
              <p className="text-xs text-destructive">
                Couldn&apos;t start the Code chat: {codeSendError} Your text is kept above.
              </p>
            </div>
          )}
          {compactError && (
            <div className="px-3 pb-3" role="alert">
              <p className="text-xs text-destructive">
                Couldn&apos;t compact the session: {compactError} Nothing was sent.
              </p>
            </div>
          )}
          {recovery && (
            <div className="px-3 pb-3" role="alert">
              <p className="text-xs text-destructive">
                {streamRecoveryCopy(recovery.reason)}
              </p>
              {recovery.canRetry && (
                <button
                  type="button"
                  className="mt-1 text-xs font-medium underline underline-offset-2"
                  onClick={retryInterruptedRun}
                  disabled={retrying}
                >
                  {retrying ? composerConfig.copy.streamRetrying : composerConfig.copy.streamRetry}
                </button>
              )}
            </div>
          )}
        </div>
      </ComposerPrimitive.Root>
      </ComposerPrimitive.Unstable_TriggerPopoverRoot>
    </ComposerContextMenu>
  );
}

export { Composer };
