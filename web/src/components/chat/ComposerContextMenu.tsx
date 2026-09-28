import { useRef, useState, type ReactNode } from "react";
import { unstable_useComposerInput } from "@assistant-ui/react";
import {
  ClipboardPaste,
  Copy,
  MessageSquareText,
  Scissors,
  SpellCheck,
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
import {
  couldBeMisspelling,
  ensureSpellchecker,
  getSpellingSuggestions,
} from "@/lib/spellcheck";
import {
  findWordAtCaret,
  replaceWord,
  type WordAtCaret,
} from "@/lib/word-suggestions";
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
 * A spelling suggestion resolved for one specific right-click.
 *
 * The word and its offsets are captured at menu-open time and carried with the
 * suggestions, so clicking a row still targets the word the user actually
 * right-clicked even if focus has moved by then.
 */
interface SpellingOffer {
  readonly target: WordAtCaret;
  readonly suggestions: readonly string[];
}

/**
 * The composer's own right-click menu (Codeg parity): spelling corrections for
 * the word under the caret, then Cut / Copy / Paste-as-plain-text / Select All
 * + live Quick Messages submenu. Only Paste depends on clipboard-read support —
 * everything else (including snippet insertion) stays reachable where reads are
 * blocked, falling back to the native menu solely for pasting. Cut is atomic:
 * text is removed only after a confirmed clipboard write. Snippets insert at the
 * caret, never replacing the in-progress draft.
 *
 * The caret is read from the textarea in the `contextmenu` handler, not from
 * `onOpenChange`: Radix opens the menu after it has taken focus, so by then the
 * selection has already collapsed and the word under the cursor is unknown.
 */
export function ComposerContextMenu({ children }: { children: ReactNode }) {
  const copy = composerConfig.copy;
  const boxRef = useRef<HTMLDivElement | null>(null);
  const { setText } = unstable_useComposerInput();
  const [spellingOffer, setSpellingOffer] = useState<SpellingOffer | null>(null);

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

  /**
   * Resolves spelling corrections for the word at the caret.
   *
   * Dictionary load and lookup are both deferred to here so nothing happens
   * until a right-click actually asks for it. The lookup is synchronous once
   * loaded, but the load is a dynamic import, so this stays async.
   */
  const resolveSpellingOffer = async (
    ta: HTMLTextAreaElement,
  ): Promise<SpellingOffer | null> => {
    const target = findWordAtCaret(ta.value, {
      selectionStart: ta.selectionStart ?? 0,
      selectionEnd: ta.selectionEnd ?? 0,
    });
    if (!target) return null;
    // Shape check before the dictionary: a right-click on `TypeScript`, `utf8`
    // or a two-letter token is answerable without loading anything, so those
    // never pay the dictionary's cost.
    if (!couldBeMisspelling(target.word)) return null;
    try {
      await ensureSpellchecker();
    } catch (error) {
      // A missing dictionary degrades the menu; it must not break right-click.
      logger.warn("composer", "spellcheck_load_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    const suggestions = getSpellingSuggestions(target.word);
    if (suggestions.length === 0) return null;
    return { target, suggestions };
  };

  /**
   * Replaces the captured word with a chosen correction, then returns focus and
   * caret to the composer.
   *
   * `setText` is the supported way to update the controlled composer; the
   * follow-up `setRangeText` is what lands the caret, because re-rendering a
   * controlled input resets selection to its end. No timeout: the reflow has
   * already happened by the time this runs.
   */
  const applySuggestion = (replacement: string) => {
    if (!spellingOffer) return;
    const ta = findTextarea();
    const { target } = spellingOffer;
    if (!ta) {
      // Box unresolvable (defensive): the snapshot still yields correct text.
      setText(replaceWord(target.word, target, replacement).text);
      return;
    }
    const { text, caret } = replaceWord(ta.value, target, replacement);
    setText(text);
    ta.focus();
    ta.setRangeText(replacement, target.start, target.end, "end");
    ta.setSelectionRange(caret, caret);
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
    <ContextMenu
      onOpenChange={(open) => {
        if (open) void loadQuickMessages({ silent: true });
      }}
    >
      {/* The trigger adopts THIS div, not `children`.
          `children` is assistant-ui's `Unstable_TriggerPopoverRoot`, which
          renders no DOM and forwards no props - so `asChild` on it silently
          dropped every prop Radix injects (ref, onContextMenu, data-slot) and
          the composer's menu had no trigger in the DOM at all. Adopting a real
          element is what makes the menu openable.

          The `onContextMenu` guard lives here, on the outermost composer
          element, and NOT on `ComposerPrimitive.Root` inside it. A
          stopPropagation on an inner element runs first and kills the event
          before it ever reaches this trigger - the menu could not open while
          the page menu was correctly suppressed. Radix composes this handler
          ahead of its own on the same element, so stopping here still opens
          THIS menu and still keeps the app-shell page menu from firing.

          This is also where the caret is read. `contextmenu` fires before
          Radix opens its content and takes focus, so this is the last moment
          the textarea's selection still describes the user's right-click. */}
      <ContextMenuTrigger
        asChild
        onContextMenu={(event) => {
          event.stopPropagation();
          setSpellingOffer(null);
          const ta = boxRef.current?.querySelector("textarea");
          if (ta) void resolveSpellingOffer(ta).then(setSpellingOffer);
        }}
      >
        <div ref={boxRef}>{children}</div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {spellingOffer && (
          <>
            <ContextMenuItem disabled>
              <SpellCheck aria-hidden="true" className="size-4" />
              {copy.spellingSuggestions}
            </ContextMenuItem>
            {spellingOffer.suggestions.map((suggestion) => (
              <ContextMenuItem
                key={suggestion}
                onSelect={() => applySuggestion(suggestion)}
              >
                {suggestion}
              </ContextMenuItem>
            ))}
            <ContextMenuSeparator />
          </>
        )}
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
  );
}
