/**
 * The ONE Direct-host assistant-ui contract.
 *
 * Every Direct host (the bound panel host, the POC host, and the future
 * draft-aware host) must use this config and these data UIs. Before this module
 * existed `DirectChatHost` used `AuiConfig({})` and mounted no data UIs, while
 * the root AppShell provider registered tools, suggestions, progress stages and
 * the compaction divider — so a Direct panel silently lost all of them.
 *
 * DECISION — data UIs mount PER HOST, inside that host's runtime provider:
 * `makeAssistantDataUI` registers a renderer into the nearest assistant-ui
 * context while mounted. A Direct host is isolated (`AuiProvider extends={null}`)
 * and cannot see a renderer mounted in a different provider, so a single global
 * mount cannot reach it. Mounting here is the only location that gives every
 * isolated host the same tool UI, suggestions, progress and compaction divider.
 */
import { useMemo, type ReactNode } from "react";
import {
  AuiConfig,
  AuiProvider,
  Tools,
  Suggestions,
  makeAssistantDataUI,
} from "@assistant-ui/react";
import { appToolkit } from "@/tools/toolkit";
import { ProgressStages } from "@/components/assistant-ui/elements/progress-stages";
import { CompactionDivider } from "@/components/assistant-ui/elements/compaction-divider";
import { DIRECT_COMPACT_DATA_NAME } from "@/features/chat/compactCommand";

const TbaiProgressDataUI = makeAssistantDataUI({
  name: "tbai-progress",
  render: ProgressStages,
});

const TbaiCompactDataUI = makeAssistantDataUI({
  name: DIRECT_COMPACT_DATA_NAME,
  render: CompactionDivider,
});

const DIRECT_SUGGESTIONS = [
  "What can you help me with?",
  "Explain a concept",
  "Help me write code",
] as const;

/** The single AuiConfig used by every Direct host. */
export function createDirectAuiConfig() {
  return AuiConfig({
    tools: Tools({ toolkit: appToolkit }),
    suggestions: Suggestions([...DIRECT_SUGGESTIONS]),
  });
}

/**
 * Mount inside each host's `AssistantRuntimeProvider` so that host's messages
 * render TBAi progress stages and the compaction divider.
 */
export function DirectDataUIs() {
  return (
    <>
      <TbaiProgressDataUI />
      <TbaiCompactDataUI />
    </>
  );
}

/**
 * The isolation boundary for a Direct host. `extends={null}` is the official
 * assistant-ui contract required because `useRemoteThreadListRuntime` throws
 * when nested; the shared config keeps tool/suggestion parity with AppShell.
 */
export function DirectHostProvider({ children }: { children: ReactNode }) {
  const config = useMemo(() => createDirectAuiConfig(), []);
  return (
    <AuiProvider extends={null} config={config}>
      {children}
    </AuiProvider>
  );
}
