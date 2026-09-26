import { extendRequestContext, logger } from "./logger";
import { errorLogFields } from "./errors";

/**
 * The tool funnel: every model-invoked tool execute passes through here
 * (native toolkit, MCP bridge, scheduler tools). Emits tool.start/tool.finish
 * (debug) and tool.error (warn) per the taxonomy, binds toolCallId into the
 * request context so nested logs correlate, and classifies failures once.
 * Throw behavior is unchanged — errors propagate to the caller after logging.
 *
 * Lives in lib (not services/tools) so services and the toolkit can all use
 * it with zero import-cycle risk: it depends only on logger + errors.
 */

export interface InstrumentedExecuteOptions {
  toolCallId?: string;
  abortSignal?: AbortSignal;
  /**
   * Validated per-tool context (the AI SDK `toolsContext` entry for this
   * tool, checked against its `contextSchema` before `execute` runs).
   * Absent for tools that declare no `contextSchema`.
   */
  context?: unknown;
  [key: string]: unknown;
}

export function instrumentedExecute<
  TFunc extends (args: any, opts?: any) => unknown | Promise<unknown>,
>(
  toolName: string,
  execute: TFunc,
  extra: Record<string, unknown> = {},
): TFunc {
  // Generic passthrough (cast once, here): call sites keep the original
  // function type, so AI SDK tool() overloads resolve exactly as if the
  // function were passed unwrapped. A fixed signature would poison
  // input/output inference and break overload resolution.
  const wrapped = async (args: any, opts?: InstrumentedExecuteOptions) => {
    const started = Date.now();
    return extendRequestContext({ toolCallId: opts?.toolCallId }, async () => {
      // Tool-funnel correlation: thread identity rides the validated tool
      // context (`{ threadId }` in the native `contextSchema`s — see
      // `src/tools/index.ts`), never a static extra, so the funnel stays
      // correct with no per-request execute rewrapping. Tools whose context
      // carries no threadId (scheduler, browser, process/system, MCP) emit
      // no conversationId — identical to the previous explicit `funnelExtra`
      // wiring, which bound the thread only to fs/run/todo executes.
      const contextThreadId = (opts?.context as { threadId?: unknown } | undefined)
        ?.threadId;
      const ctx = {
        tool: toolName,
        toolCallId: opts?.toolCallId,
        ...(typeof contextThreadId === "string" && contextThreadId.length > 0
          ? { conversationId: contextThreadId }
          : {}),
        ...extra,
      };
      logger.debug("tool", "tool.start", ctx);
      try {
        const out = await execute(args, opts);
        logger.debug("tool", "tool.finish", {
          ...ctx,
          durationMs: Date.now() - started,
        });
        return out;
      } catch (err) {
        logger.warn("tool", "tool.error", {
          ...ctx,
          durationMs: Date.now() - started,
          ...errorLogFields(err),
        });
        throw err;
      }
    });
  };
  return wrapped as unknown as TFunc;
}
