import { useRef, type ReactNode } from "react";
import { unstable_useComposerInput } from "@assistant-ui/react";
import {
  ClipboardPaste,
  Copy,
  MessageSquareText,
  Scissors,
  TextSelect,
} from "lucide-react";
import { composerConfig } from "@/config/composer";
import { useQuickMessagesStore } from "@/stores/quickMessagesStore";
import {
  copyTextFromMenu,
  cutTextareaSelection,
  insertTextAtCursor,
  pastePlainTextInto,
  selectAllTextareaText,
} from "@/lib/clipboard";
import { logger } from "@/lib/logger";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

/**
 * The composer's own right-click menu (Codeg parity): Cut / Copy /
 * Paste-as-plain-text / Select All + live Quick Messages submenu. Only Paste
 * depends on clipboard-read support — everything else (including snippet
 * insertion) stays reachable where reads are blocked, falling back to the
 * native menu solely for pasting. Cut is atomic: text is removed only after
 * a confirmed clipboard write. Snippets insert at the caret, never replacing
 * the in-progress draft.
 */
export function ComposerContextMenu({ children }: { children: ReactNode }) {
  const copy = composerConfig.copy;
  const boxRef = useRef<HTMLDivElement | null>(null);
  const { setText } = unstable_useComposerInput();

  const findTextarea = (): HTMLTextAreaElement | null =>
    boxRef.current?.querySelector("textarea") ?? null;

  const clipboardReadSupported =
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.readText === "function";

  // Live saved snippets (SQLite source of truth). Refreshed on menu open
  // only — no polling, no cache. Failures stay in logs; the menu never
  // lights the settings page's error banner.
  const quickItems = useQuickMessagesStore((s) => s.messages);
  const quickLoading = useQuickMessagesStore((s) => s.loading);
  const loadQuickMessages = useQuickMessagesStore((s) => s.load);

  const reportWriteFailed = () => {
    logger.warn("composer", "clipboard_write_failed", {
      message: copy.clipboardWriteFailed,
    });
  };

  const handleCut = async () => {
    const ta = findTextarea();
    if (!ta) return;
    await cutTextareaSelection(ta, reportWriteFailed);
  };

  const handleCopy = async () => {
    const ta = findTextarea();
    if (!ta) return;
    const { selectionStart, selectionEnd, value } = ta;
    const text = value.slice(selectionStart ?? 0, selectionEnd ?? value.length);
    if (!text) return;
    const ok = await copyTextFromMenu(text);
    if (!ok) reportWriteFailed();
  };

  const handlePaste = async () => {
    const ta = findTextarea();
    if (!ta) return;
    await pastePlainTextInto(ta, reportWriteFailed);
  };

  const handleSelectAll = () => {
    const ta = findTextarea();
    if (!ta) return;
    selectAllTextareaText(ta);
  };

  const handleInsertSnippet = (content: string) => {
    if (!content) return;
    const ta = findTextarea();
    // Caret insert preserves the draft; fall back to replace only when the
    // box cannot be resolved (never expected — defensive only).
    if (ta) insertTextAtCursor(ta, content);
    else setText(content);
  };

  return (
    <div ref={boxRef}>
      <ContextMenu
        onOpenChange={(open) => {
          if (open) void loadQuickMessages({ silent: true });
        }}
      >
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => void handleCut()}>
            <Scissors aria-hidden="true" className="size-4" />
            {copy.cut}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => void handleCopy()}>
            <Copy aria-hidden="true" className="size-4" />
            {copy.copy}
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!clipboardReadSupported}
            onSelect={() => void handlePaste()}
          >
            <ClipboardPaste aria-hidden="true" className="size-4" />
            {copy.pasteAsPlainText}
          </ContextMenuItem>
          <ContextMenuItem onSelect={handleSelectAll}>
            <TextSelect aria-hidden="true" className="size-4" />
            {copy.selectAll}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <MessageSquareText aria-hidden="true" className="size-4" />
              {copy.quickMessages}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="min-w-40 overflow-y-auto">
              {quickItems.length === 0 ? (
                <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                  {quickLoading ? copy.quickMessagesLoading : copy.quickMessagesEmpty}
                </div>
              ) : (
                quickItems.map((item) => (
                  <ContextMenuItem
                    key={item.id}
                    onSelect={() => handleInsertSnippet(item.content)}
                  >
                    <span className="truncate">
                      {item.title || (
                        <span className="italic text-muted-foreground">
                          {copy.quickMessageUntitled}
                        </span>
                      )}
                    </span>
                  </ContextMenuItem>
                ))
              )}
            </ContextMenuSubContent>
          </ContextMenuSub>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}
