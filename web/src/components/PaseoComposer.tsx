"use client";

import { useEffect, useRef, useState } from "react";
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
  ChevronDown,
  File,
  Image,
  Mic,
  Paperclip,
  Square,
} from "lucide-react";
import { useSettingsStore } from "../stores";
import { useMcpStore } from "../stores/mcpStore";
import { TooltipIconButton } from "./assistant-ui/elements/tooltip-icon-button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "./ui/dropdown-menu";

const THINKING_OPTIONS = [
  { id: "default", label: "Default" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
];

function useTextareaAutoGrow(textareaRef: React.RefObject<HTMLTextAreaElement | null>) {
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const adjust = () => {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    };
    adjust();
    el.addEventListener("input", adjust);
    return () => el.removeEventListener("input", adjust);
  }, [textareaRef]);
}

type ConversationCustom = {
  providerId?: string | null;
  modelId?: string | null;
  reasoningLevel?: string | null;
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

  // Every provider's models, grouped under its name (not just the active
  // provider's). A provider with no explicit list contributes its default.
  const groups = providers.map((p) => ({
    provider: p,
    models: p.models?.length
      ? p.models
      : p.model
        ? [{ id: p.model, provider: p.type, label: p.model }]
        : [],
  }));

  // Effective selection: one-shot picker override wins, else the conversation
  // default (custom), else the global active provider's model.
  let currentProviderId =
    selectedProviderId ?? custom?.providerId ?? activeProviderId;
  let currentModelId: string | undefined;
  if (selectedModelId) {
    for (const g of groups) {
      if (g.models.some((m) => m.id === selectedModelId)) {
        currentProviderId = g.provider.id;
        currentModelId = selectedModelId;
        break;
      }
    }
  }
  currentModelId ??= custom?.modelId ?? undefined;
  const currentProvider = providers.find((p) => p.id === currentProviderId);
  currentModelId ??= currentProvider?.model ?? "";
  const currentModel =
    groups
      .flatMap((g) => g.models)
      .find((m) => m.id === currentModelId) ?? undefined;
  const label = currentModel?.label ?? currentModelId ?? "Select model";

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
          <span className="max-w-[120px] truncate">{label}</span>
          <ChevronDown className="size-3 shrink-0 opacity-50" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="min-w-[220px] max-h-[320px] overflow-y-auto">
        {groups.length === 0 || groups.every((g) => g.models.length === 0) ? (
          <DropdownMenuItem disabled>
            <span className="text-muted-foreground">No models configured</span>
          </DropdownMenuItem>
        ) : (
          groups.map((g) =>
            g.models.length === 0 ? null : (
              <div key={g.provider.id}>
                <div className="px-2 pt-2 pb-1 text-[11px] font-medium text-muted-foreground">
                  {g.provider.name}
                  {g.provider.id === activeProviderId && " · default"}
                </div>
                {g.models.map((m) => (
                  <DropdownMenuItem
                    key={`${g.provider.id}:${m.id}`}
                    className={cn(
                      "justify-between",
                      m.id === currentModelId &&
                        g.provider.id === currentProviderId &&
                        "bg-accent text-accent-foreground",
                    )}
                    onSelect={() => handleSelect(g.provider.id, m.id)}
                  >
                    <span className="truncate">{m.label ?? m.id}</span>
                    {m.id === currentModelId &&
                      g.provider.id === currentProviderId && (
                        <span className="ml-auto text-[10px]">✓</span>
                      )}
                  </DropdownMenuItem>
                ))}
              </div>
            ),
          )
        )}
        {currentProvider && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-xs text-muted-foreground cursor-default">
              Next message: {currentProvider.name} · {currentModelId || "default"}
            </DropdownMenuItem>
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
  const effective = stored ?? custom?.reasoningLevel ?? providerDefault;
  const selected = effective === "off" ? "default" : effective;

  const handleSelect = (id: string) => {
    setOpen(false);
    // "default" means the provider's saved level; persist that concrete value.
    const level = id === "default" ? null : (id as "low" | "medium" | "high");
    useSettingsStore.getState().setSelectedReasoningLevel(level);
    const base = (aui.threadListItem.getState().custom ?? {}) as ConversationCustom;
    aui.threadListItem.updateCustom({
      ...base,
      reasoningLevel: level ?? providerDefault,
    });
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
          <span className="max-w-[80px] truncate">
            {THINKING_OPTIONS.find((o) => o.id === selected)?.label ?? "Thinking"}
          </span>
          <ChevronDown className="size-3 shrink-0 opacity-50" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="min-w-[120px]">
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
            {opt.id === selected && <span className="ml-auto text-[10px]">✓</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AttachDropdown() {
  const handlePickImage = async () => {
    console.log("[composer] pick image — not yet wired");
  };
  const handlePickFile = async () => {
    console.log("[composer] pick file — not yet wired");
  };
  const handlePickGithub = async () => {
    console.log("[composer] pick github — not yet wired");
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <TooltipIconButton tooltip="Attach" side="top">
          <Paperclip className="size-3.5" />
        </TooltipIconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start">
        <DropdownMenuItem onSelect={handlePickImage}>
          <Image className="size-3.5" />
          <span>Add Image</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={handlePickFile}>
          <File className="size-3.5" />
          <span>Add File</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={handlePickGithub}>
          <span>Add GitHub PR / Issue</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PaseoComposer() {
  const { setText } = unstable_useComposerInput();
  const pendingInsert = useMcpStore((s) => s.pendingInsert);
  const clearPendingInsert = useMcpStore((s) => s.clearPendingInsert);
  useEffect(() => {
    if (pendingInsert) {
      setText(pendingInsert);
      clearPendingInsert();
    }
  }, [pendingInsert, setText, clearPendingInsert]);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useTextareaAutoGrow(textareaRef);

  return (
    <ComposerPrimitive.Root
      className={cn(
        "relative flex flex-col",
        "rounded-2xl border border-border bg-card",
        "transition-[border-color] duration-200 ease-in-out",
        "focus-within:border-ring",
      )}
    >
      {/* Textarea */}
      <div className="px-3 pb-1">
        <ComposerPrimitive.Input
          asChild
          autoFocus
          submitMode="enter"
        >
          <textarea
            ref={textareaRef}
            placeholder="Send a message…  (Enter to send)"
            rows={1}
            className={cn(
              "w-full resize-none bg-transparent text-sm text-foreground",
              "placeholder:text-muted-foreground",
              "min-h-[2.5rem] max-h-40",
              "outline-none",
            )}
          />
        </ComposerPrimitive.Input>
      </div>

      {/* Focus hint — shown when empty and not focused */}
      <AuiIf
        condition={(s) => s.composer.isEmpty}
      >
        <div className="absolute right-3 top-3 text-[11px] text-muted-foreground/50 pointer-events-none">
          ⌘K to focus
        </div>
      </AuiIf>

      {/* Button row: attach on left, model/thinking/voice/cancel/send on right */}
      <div className="flex items-end justify-between gap-1.5 px-3 pb-3 pt-2">
        {/* Left: attach */}
        <div className="flex items-end gap-1">
          <AttachDropdown />
        </div>

        {/* Right: model, thinking, voice, cancel, send */}
        <div className="flex items-center gap-1">
          {/* Model chip */}
          <ModelChip />
          {/* Thinking chip: persists to the conversation default ("Default" =
              the provider's saved level); also sets a one-shot override for the
              immediate next message. */}
          <ThinkingChip />
          {/* Voice — always visible, disabled (no DictationAdapter) */}
          <TooltipIconButton tooltip="Voice not available" side="top" className="opacity-40 pointer-events-none">
            <Mic className="size-3.5" />
          </TooltipIconButton>
          {/* Cancel — shown while streaming */}
          <AuiIf condition={(s) => s.thread.isRunning}>
            <ComposerPrimitive.Cancel asChild>
              <TooltipIconButton tooltip="Stop generating" side="top">
                <Square className="size-3.5" />
              </TooltipIconButton>
            </ComposerPrimitive.Cancel>
          </AuiIf>
          {/* Send — always rendered; disabled automatically by primitive when no content */}
          <ComposerPrimitive.Send asChild>
            <button
              type="submit"
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
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
}

export { PaseoComposer };
