import { convertToModelMessages, type ToolSet, type UIMessage } from "ai";
import { pruneStaleMessages } from "./prune-messages";
import { logger } from "./logger";

/**
 * The single production path from stored UI-message history to ModelMessages:
 *
 *   incoming UIMessages → pruneStaleMessages (lifecycle repair) →
 *   convertToModelMessages({ tools, ignoreIncompleteToolCalls: true })
 *
 * Both the chat route and the integration tests go through this function so
 * the pruning step can never be bypassed by a test that "mirrors" the route.
 */
export async function prepareModelMessages(
  messages: UIMessage[],
  tools: ToolSet,
  opts: { threadId?: string } = {},
): Promise<Awaited<ReturnType<typeof convertToModelMessages>>> {
  const { messages: pruned, stats } = pruneStaleMessages(messages);

  // Diagnostics: only when pruning actually changed something. Ids are random
  // correlation identifiers — safe to log; never message content.
  if (stats.removedToolParts.length > 0 || stats.removedEmptyTurns > 0) {
    logger.debug("chat", "stale_part_pruned", {
      threadId: opts.threadId,
      message: `toolParts=${stats.removedToolParts.length} emptyTurns=${stats.removedEmptyTurns}`,
      toolCallIds: stats.removedToolParts.slice(0, 20),
    });
  }
  if (stats.preservedApprovals.length > 0) {
    logger.debug("chat", "approval_preserved", {
      threadId: opts.threadId,
      message: `count=${stats.preservedApprovals.length}`,
      toolCallIds: stats.preservedApprovals.slice(0, 20),
    });
  }

  return convertToModelMessages(pruned, {
    tools,
    ignoreIncompleteToolCalls: true,
  });
}
