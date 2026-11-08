import { useOpenCodeConversationConfig } from "./useOpenCodeConversationConfig";

/**
 * Code-mode status label for the StatusBar. Encapsulates the OpenCode
 * conversation config read so StatusBar has no static opencode import.
 */
export function OpenCodeStatusBarLabel({
  agentId,
  openProviders,
}: {
  agentId: string | undefined;
  openProviders: () => void;
}) {
  const codeConfig = useOpenCodeConversationConfig(agentId);
  const codeLabel = codeConfig
    ? [codeConfig.opencodeAgent, codeConfig.opencodeModel]
        .filter((v): v is string => !!v)
        .join(" · ")
    : null;

  if (!codeLabel) return null;

  return (
    <button
      type="button"
      onClick={openProviders}
      title={codeLabel}
      className="hidden min-w-0 max-w-55 truncate rounded outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring md:block"
    >
      {codeLabel}
    </button>
  );
}
