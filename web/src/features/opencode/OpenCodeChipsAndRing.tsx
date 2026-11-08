import { OpenCodeAgentChip } from "./OpenCodeAgentChip";
import { OpenCodeModelChip } from "./OpenCodeModelChip";
import { OpenCodeThinkingChip } from "./OpenCodeThinkingChip";
import { OpenCodeShieldChip } from "./OpenCodeShieldChip";
import { OpenCodeContextRing } from "./OpenCodeContextRing";

/**
 * OpenCode composer chips and context ring. Encapsulates all OpenCode
 * chip/ring imports so Composer has no static opencode imports.
 *
 * Renders the same three independent chips — Agent, Model, Thinking — each
 * persisting to its own store column (bound conversation, or the
 * welcome-engine store in draft), plus the Shield chip and the context ring.
 * Never the Direct provider chips, and the Thinking chip auto-hides when the
 * model exposes no variants.
 */
export function OpenCodeChipsAndRing() {
  return (
    <>
      <OpenCodeAgentChip />
      <OpenCodeModelChip />
      <OpenCodeThinkingChip />
      <OpenCodeShieldChip />
      <OpenCodeContextRing />
    </>
  );
}
