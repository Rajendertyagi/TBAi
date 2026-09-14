import { extendRequestContext, logger } from "./logger";
import { classifyError } from "./errors";

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
      const ctx = { tool: toolName, toolCallId: opts?.toolCallId, ...extra };
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
          ...classifyError(err),
        });
        throw err;
      }
    });
  };
  return wrapped as unknown as TFunc;
}
