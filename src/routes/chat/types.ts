/**
 * Shared types for the `POST /api/chat` pipeline.
 *
 * ## Why a state object rather than arguments
 *
 * The route handler passed ~70 locals through one scope. Once the phases become
 * modules, the values that cross a phase boundary have to travel somehow. They
 * travel in these objects, NOT as long parameter lists: `DirectRunSetup` and its
 * successors are threaded deliberately, and a phase signature that grows past a
 * handful of parameters is the signal that the boundary is in the wrong place.
 *
 * ## Why every field is derived from `typeof`
 *
 * The field types are written as `ReturnType<typeof …>` rather than as copied
 * interface names. A move must not be able to change a type: deriving from the
 * real function means a drift in an upstream signature becomes a compile error
 * here instead of a silent mismatch at the boundary.
 */
import type { UIMessage } from "ai";
import type { Context } from "hono";
import type { resolveChatModel } from "../chat-model";
import type { conversationService } from "../../services/storage";
import type { buildReasoningProviderOptions } from "../chat-provider-options";
import type { getModel } from "../../services/ai";

/** The Hono context shape this route runs under. */
export type ChatContext = Context<{ Variables: { requestId: string } }>;

/**
 * Result of a pipeline phase.
 *
 * `ok: false` means the phase REJECTED the request and owns the finished
 * Response; the route returns it verbatim. `ok: true` carries the next phase's
 * input. Keeping the rejection Response inside this union is deliberate: a phase
 * never returns a half-built response for the caller to finish.
 *
 * ## Why `?: never` on the unused branch
 *
 * The backend tsconfig does NOT enable `strict` or `strictNullChecks`, and
 * TypeScript does not narrow a discriminated union without it. A plain
 * `{ ok: true; value } | { ok: false; response }` therefore fails to compile at
 * every read site with "property 'response' does not exist on the union".
 *
 * The `?: never` markers make both properties readable on both branches while
 * still refusing, at each construction site, to set the wrong one. Read-side
 * soundness is therefore weaker here than it would be under `strictNullChecks` —
 * that is a property of this project's compiler configuration, not a choice
 * made in this file, and it is the one place the phase contract is not enforced
 * by the type system.
 */
export type PhaseResult<T> =
  | { readonly ok: true; readonly value: T; readonly response?: never }
  | { readonly ok: false; readonly response: Response; readonly value?: never };

/** What `resolveChatModel` resolves to, minus the null case handled in phase 1. */
type ResolvedModel = NonNullable<Awaited<ReturnType<typeof resolveChatModel>>>;

/**
 * Everything decided before the run exists and streaming starts.
 *
 * Assembled by `validateAndResolve`, consumed by `createRunAndAssemble`. Holds
 * only what phase 1 produces; nothing here is written after this phase returns.
 */
export type DirectRunSetup = {
  readonly requestId: string;
  /** From the request envelope; `undefined` starts a new conversation. */
  readonly threadId: string | undefined;
  /** Authoritative row when the conversation exists, else null. */
  readonly conversation: Awaited<ReturnType<typeof conversationService.get>>;
  readonly provider: ResolvedModel["provider"];
  /** Provider config with the credential resolved and the model pinned. */
  readonly modelConfig: ResolvedModel["provider"] & {
    apiKey?: string;
    model?: string;
  };
  readonly reasoning: string;
  readonly approvalSecret: string;
  readonly languageModel: ReturnType<typeof getModel>;
  readonly providerOptions: ReturnType<typeof buildReasoningProviderOptions>;
  readonly messages: UIMessage[];
};

/**
 * The live stream writer, shared by reference between the route and the stream phase.
 *
 * The route creates the terminal batcher BEFORE assembly, because assembly wires the
 * tap into `run_command`. That batcher's sink has to reach the writer the stream
 * installs when it opens. A plain closure over a route-local `let` cannot: the phase
 * assigns its own binding, so the sink would capture a variable that stays null and
 * every terminal part would be dropped. One mutable holder, owned by the route and
 * filled by the phase, is the smallest thing that actually connects them.
 */
export type StreamWriterHolder = {
  current: { write: (part: any) => void } | null;
};
