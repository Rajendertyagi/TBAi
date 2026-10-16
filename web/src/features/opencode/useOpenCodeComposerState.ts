import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { logger } from "../../lib/logger";
import { clearComposerDraft } from "../chat/state/composerDraft";
import { useCommandsStore } from "./commandsStore";
import { useOpenCodeRuntimeContext } from "./opencodeRuntimeContext";
import { applyCommandSelection, toSlashCommands } from "./slashCommands";
import {
  buildCompactEntry,
  isCompactCommandText,
  runCompactSession,
  shouldOfferCompact,
} from "./compactSession";

/**
 * OpenCode-specific composer state, owned by the OpenCode feature.
 *
 * Encapsulates every OpenCode import the composer surface needs — command
 * feed, runtime context, compact session — so the shared Composer component
 * has zero static opencode imports. The hook receives the shared values it
 * acts on (composer text, setText, threadKey) and returns the derived state
 * and callbacks the shared surface consumes.
 */
export function useOpenCodeComposerState(params: {
  isCodeSurface: boolean;
  showOpenCodeDraft: boolean;
  composerText: string;
  setText: (text: string) => void;
  threadKey: string | null;
}) {
  const { isCodeSurface, showOpenCodeDraft, composerText, setText, threadKey } = params;

  const slashCommandsEnabled = isCodeSurface || showOpenCodeDraft;

  // ── Command feed ───────────────────────────────────────────────────────────
  const openCodeCommands = useCommandsStore((s) => s.commands);
  const loadOpenCodeCommands = useCommandsStore((s) => s.load);
  useEffect(() => {
    if (!slashCommandsEnabled) return;
    void loadOpenCodeCommands();
  }, [slashCommandsEnabled, loadOpenCodeCommands]);

  // ── Runtime context + compact ─────────────────────────────────────────────
  const openCodeRuntimeContext = useOpenCodeRuntimeContext();
  const canCompact = shouldOfferCompact(isCodeSurface, openCodeRuntimeContext);

  // `compactingRef` is the synchronous re-entry lock: set BEFORE the await so
  // two rapid invocations (e.g., double-click before re-render) cannot both
  // observe `false` and both proceed.
  const compactingRef = useRef(false);
  const [compactError, setCompactError] = useState<string | null>(null);

  const runCompact = useCallback(async () => {
    const context = openCodeRuntimeContext;
    if (!context?.compact || compactingRef.current) return;
    // Narrowed to a plain function: the controller builds `compact` as a
    // closure over its own state, so it never reads `this` and is safe to
    // hand to the feature module as a value.
    const compact: () => Promise<void> = context.compact;
    compactingRef.current = true;
    setCompactError(null);
    try {
      // The lifecycle events live with the feature: this hook owns the compact
      // state and execution; the shared Composer owns the form and rendering.
      await runCompactSession(() => compact(), {
        sessionId: context.sessionId,
      });
      setText("");
      clearComposerDraft(threadKey);
    } catch (err) {
      setCompactError(err instanceof Error ? err.message : String(err));
    } finally {
      compactingRef.current = false;
    }
  }, [openCodeRuntimeContext, setText, threadKey]);

  // ── Slash entries (OpenCode feed + built-in compact) ──────────────────────
  // The commands are OpenCode's own; the Direct runtime cannot execute them, so
  // the palette is mounted only where an OpenCode session is behind the send —
  // the bound Code surface or the OpenCode new-chat draft. Showing them on
  // Direct would offer a command that could never run.
  //
  // `/compact` is NOT in the OpenCode `/command` feed, so it is a TBAi-side
  // built-in appended after the feed entries — never a fake feed entry. The
  // ambient runtime context is non-null only inside a session-bound Code
  // surface (null on Direct and on the session-less welcome draft), so gating
  // on it keeps `/compact` off every surface that has no session to compact.
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
        ? [
            buildCompactEntry((name) => {
              setText(applyCommandSelection(composerText, name));
              logger.info("opencode", "command.selected", {
                name,
                source: "builtin",
              });
            }),
          ]
        : []),
    ],
    [slashCommandsEnabled, openCodeCommands, canCompact, composerText, setText],
  );

  // ── Command selection (shared by OpenCode and Direct entries) ──────────────
  const selectCommand = useCallback(
    (name: string) => {
      setText(applyCommandSelection(composerText, name));
    },
    [setText, composerText],
  );

  // ── Submit interception ───────────────────────────────────────────────────
  // Whether the current composer text is a `/compact` invocation that should
  // be diverted to `runCompact` by the shared Composer's submit funnel
  // BEFORE the library's own submit handler runs. The literal text is never
  // sent as a prompt; completion arrives through the normal session/message
  // sync. Failure keeps a truthful error and never claims success.
  const shouldInterceptCompact = useCallback(
    (text: string) => canCompact && isCompactCommandText(text),
    [canCompact],
  );

  return {
    slashEntries,
    shouldInterceptCompact,
    runCompact,
    compactError,
    selectCommand,
  };
}
