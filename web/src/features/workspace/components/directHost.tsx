/**
 * The ONE Direct-host assistant-ui contract.
 *
 * Two distinct responsibilities, deliberately split by provider:
 *
 * - `DirectHostProvider` is an ISOLATION-ONLY boundary. `extends={null}` with an
 *   EMPTY config makes `useRemoteThreadListRuntime` see a root client (it throws
 *   when nested). It owns no toolkit, suggestions, or data UIs.
 * - `createDirectAuiConfig()` is the shared tools + suggestions config. Each host
 *   passes it to its OWN `AssistantRuntimeProvider` via the official `config`
 *   prop, because that provider installs the `AuiProvider` whose client scope
 *   `part.toolUI` reads. Putting the config on the outer boundary leaves that
 *   scope empty and every tool part falls through to `ToolFallback`.
 *
 * `DirectDataUIs` mounts PER HOST, inside that host's runtime provider:
 * `makeAssistantDataUI` registers a renderer into the nearest assistant-ui
 * context while mounted, and an isolated host cannot see a renderer mounted in
 * a different provider.
 */
import type { ReactNode } from "react";
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

/** Empty config for the isolation-only boundary; it owns no scopes. */
const emptyConfig = AuiConfig({});

/**
 * The isolation boundary for a Direct host. `extends={null}` is the official
 * assistant-ui contract required because `useRemoteThreadListRuntime` throws
 * when nested; the config is deliberately EMPTY — tools, suggestions and data
 * UIs belong to each host's `AssistantRuntimeProvider`, not here.
 */
export function DirectHostProvider({ children }: { children: ReactNode }) {
  return (
    <AuiProvider extends={null} config={emptyConfig}>
      {children}
    </AuiProvider>
  );
}
