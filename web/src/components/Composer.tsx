"use client";

import { useEffect, useState } from "react";
import {
  AuiIf,
  ComposerPrimitive,
  unstable_useComposerInput,
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
import { composerConfig } from "../config/composer";
import { logger } from "../lib/logger";
import { useSettingsStore } from "../stores";
import type { ReasoningLevel } from "../types";
import { useWelcomeEngineStore } from "../features/chat/state/welcomeEngine";
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
import { ModelOptionList } from "./chat/ModelOptionList";
import { buildModelGroups, resolveModelOwner } from "../lib/model-groups";
import { OpenCodeAgentChip } from "../features/opencode/OpenCodeAgentChip";
import { OpenCodeModelChip } from "../features/opencode/OpenCodeModelChip";
import { OpenCodeThinkingChip } from "../features/opencode/OpenCodeThinkingChip";
import { OpenCodeShieldChip } from "../features/opencode/OpenCodeShieldChip";
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
    // and is the baseline for subsequent messages.
    selectChatTarget(providerId, modelId);
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
            "inline-flex items-center gap-1.5 h-7 rounded-full border border-border",
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
    // pick, so the very next message uses exactly what was chosen.
    useSettingsStore.getState().setSelectedReasoningLevel(level);
    const base = (aui.threadListItem.getState().custom ?? {}) as ConversationCustom;
    aui.threadListItem.updateCustom({ ...base, reasoningLevel: level });
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-1.5 h-7 rounded-full border border-border",
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
  const { setText } = unstable_useComposerInput();
  const aui = useAui();
  // Draft engine for the welcome surface. Bound threads never set
  // isWelcomeDraft, so showOpenCodeDraft is true only on the new-chat draft
  // with the OpenCode engine — never inferred, always explicit.
  const draftEngine = useWelcomeEngineStore((s) => s.engine);
  const showOpenCodeDraft = isWelcomeDraft && draftEngine === "opencode";
  const pendingInsert = useMcpStore((s) => s.pendingInsert);
  const clearPendingInsert = useMcpStore((s) => s.clearPendingInsert);
  useEffect(() => {
    if (pendingInsert) {
      setText(pendingInsert);
      clearPendingInsert();
    }
  }, [pendingInsert, setText, clearPendingInsert]);

  return (
    <ComposerContextMenu>
      <ComposerPrimitive.Root
        // Own context menu (not the page menu): stop the event here so the
        // app-shell menu never fires inside the composer. Non-mouse presses
        // keep bubbling so panel selection bookkeeping is untouched.
        onContextMenu={(event) => event.stopPropagation()}
        onPointerDown={(event) => {
          if (event.pointerType !== "mouse") event.stopPropagation();
        }}
        className={cn(
          "relative flex flex-col",
          "rounded-2xl border border-border bg-card",
          "transition-[border-color] duration-200 ease-in-out",
          "focus-within:border-ring",
        )}
      >
        {/* Textarea: the primitive owns auto-resize (controlled by the
            runtime, including programmatic clears on send) — no hand-rolled
            height hook, so paste-then-send always shrinks back. */}
        <div className="px-3 pb-1">
          <ComposerPrimitive.Input
            autoFocus
            submitMode="enter"
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

        {/* Button row: attach on left, thinking/model/voice/send-stop on right */}
        <div className="flex items-end justify-between gap-1.5 px-3 pb-3 pt-2">
          {/* Left: attach */}
          <div className="flex items-end gap-1">
            <AttachDropdown />
          </div>

          {/* Right: thinking, model, voice, send/stop (single slot) */}
          <div className="flex items-center gap-1">
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
            {/* Voice — always visible, disabled (no DictationAdapter) */}
            <TooltipIconButton tooltip="Voice not available" side="top" className="opacity-40 pointer-events-none">
              <Mic className="size-3.5" />
            </TooltipIconButton>
            {/* Single action slot (docs idiom): exactly one of Send / Cancel
                is mounted — arrow when idle, square Stop while generating.
                Same footprint, so the row never shifts on swap. */}
            <AuiIf condition={(s) => !s.thread.isRunning}>
              <ComposerPrimitive.Send asChild>
                <button
                  type="submit"
                  aria-label={composerConfig.copy.sendMessage}
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
              </ComposerPrimitive.Send>
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
        </div>
      </ComposerPrimitive.Root>
    </ComposerContextMenu>
  );
}

export { Composer };
