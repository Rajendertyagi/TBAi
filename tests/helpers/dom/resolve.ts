/**
 * Portable module resolver for the permanent DOM/contract suite.
 *
 * `@ai-sdk/react` and `@assistant-ui/core` are nested inside bun's isolated
 * store and are NOT hoisted into `web/node_modules`, so a bare specifier cannot
 * resolve them from `web/`. `@assistant-ui/ai-sdk` IS resolvable from `web/`,
 * and it depends on both — so anchoring a `createRequire` at its location
 * resolves them portably, with no machine-specific absolute path.
 *
 * Two resolution styles are used, deliberately:
 *
 *  - Public entry points (`@ai-sdk/react`, `@assistant-ui/core/internal`) go
 *    through `require.resolve`, honouring each package's `exports` map.
 *  - Deep `dist/*` modules (`sliceMessagesUntil`, `toCreateMessage`,
 *    `AISDKMessageConverter`, `getExternalStoreMessages`) are NOT public
 *    exports. They are resolved from the package root and imported by absolute
 *    file URL, bypassing the `exports` map. These pin the INTERNAL behaviour of
 *    the installed versions — which is exactly what a contract test wants — at
 *    the cost of being sensitive to a future upgrade that moves the files.
 */

import { createRequire } from "node:module";
import path from "node:path";

/**
 * Shapes of the assistant-ui internals this harness reaches into.
 *
 * These are deep implementation modules with no published types, so each is
 * declared here for the surface the contract tests actually exercise. The
 * previous alternative was `as never` on every re-export, which reads as "no
 * type" but is the worst possible choice: property access on `never` is TS2339,
 * calling it is TS2349 and constructing it is TS2351, so every call site became
 * an error. Declaring the members keeps those call sites checked against the
 * real arity instead of disabling checking on them.
 *
 * Arguments and return values are deliberately `unknown`: these tests assert on
 * the shape the converter produces, so the harness must not itself assume it.
 */

/**
 * The `@ai-sdk/react` Chat the harness instantiates directly.
 *
 * `web/` has no DOM runner that can mount the real thread, so the harness builds
 * its own Chat and drives it. It is a CLASS at runtime (`new Chat({...})`) and an
 * instance type at the call sites (`chat.messages`), so both a value and a type of
 * the same name are exported.
 *
 * `T` must be a real message-array type, not `never`: `setMessages` takes either
 * the next array or an updater, and `never | ((current: never) => never)`
 * collapses to `never`, which silently drops the updater branch and leaves every
 * `(current) => ...` callback with an implicit `any` parameter.
 */
export interface ChatInstance<T> {
  messages: T;
  setMessages: (next: T | ((current: T) => T)) => void;
  sendMessage: (message: never, options?: { metadata?: unknown }) => Promise<unknown>;
  regenerate: (options?: { metadata?: unknown }) => Promise<unknown>;
  /**
   * Run state, which the composition contracts branch on (`"submitted"` /
   * `"streaming"` mean a run is in flight). Declared here because this harness
   * pins the installed version's shape explicitly rather than importing the
   * deep-internal types that have no published declarations.
   */
  status: string;
}

/** A stored thread message, as far as the harness needs to see it. */
export interface StoredMessage {
  id: string;
  parentId?: string | null;
  [key: string]: unknown;
}

/**
 * `ExternalStoreThreadRuntimeCore` as the harness constructs it.
 *
 * The mutation surface is declared here rather than imported: these are DEEP
 * `dist/*` internals with no published types, so the harness pins the installed
 * version's shape explicitly. Every member below is one a contract test actually
 * calls, so adding one is a deliberate statement that the surface exists — not a
 * way to silence an error.
 */
export interface ExternalStoreThreadRuntimeInstance {
  readonly repository: MessageRepositoryInstance;
  readonly messages: StoredMessage[];
  addOrUpdateMessage: (parentId: string, message: unknown) => void;
  append: (message: unknown) => Promise<unknown>;
  capabilities: unknown;
  __internal_setAdapter: (adapter: unknown) => void;
  /** Begin a run for an optimistic message, as the composer does. */
  startRun: (options?: unknown) => Promise<unknown>;
  /** Remove a persisted message by id (branch-aware delete). */
  deleteMessage: (messageId: string) => Promise<unknown>;
  /** Repoint the repository at a sibling branch of the same parent. */
  switchToBranch: (parentId: string) => Promise<unknown>;
  /** Runtime lifecycle flags the contract asserts on. */
  isRunning: boolean;
  historical: boolean;
  /**
   * The composer surface the send-gate proofs drive.
   *
   * Declared with a narrow shape rather than `unknown` so a contract can call
   * it directly instead of casting at every use; the proofs still narrow further
   * where they assert on a specific member.
   */
  composer: {
    canSend: boolean;
    setText?: (text: string) => void;
    send: (options?: unknown) => Promise<unknown>;
  };
}

/**
 * The serialized form of the repository, as the round-trip contracts consume it.
 *
 * Previously declared `export: () => unknown`, which pushed a cast onto every
 * caller: five separate `.messages` accesses needed `as unknown as ...` before a
 * single field could be read. The shape is not a guess — `StoredMessage`
 * already models the message record, and every call site reads exactly
 * `{ messages: [{ message }] }`.
 */
export interface MessageRepositoryExport {
  readonly messages: readonly {
    /**
     * The recorded parent of this ENTRY.
     *
     * On the entry, not on the message. `navigation-eviction.test.ts` asserts a
     * parent's id against this field, and reading `parentId` from the message
     * instead silently yields `null` — a wrong-answer bug that still typechecks
     * when `StoredMessage` carries an index signature.
     */
    readonly parentId: string | null;
    readonly message: StoredMessage;
  }[];
}

/**
 * `MessageRepository` is referenced as an instance type and by the members the
 * history contracts exercise.
 */
export interface MessageRepositoryInstance {
  readonly canonicalHeadId: string;
  import: (input: { headId: string; messages: unknown }) => unknown;
  /** Serialize the repository's messages (used to prove round-trip identity). */
  export: () => MessageRepositoryExport;
}

const here = createRequire(import.meta.url);

/** Resolve a package's install root via an already-anchored require. */
function packageRoot(req: NodeRequire, pkgName: string): string {
  return path.dirname(req.resolve(`${pkgName}/package.json`));
}

/** Import a file inside a package by absolute URL, bypassing `exports`. */
async function importDist(root: string, rel: string): Promise<Record<string, unknown>> {
  const url = `file:///${path.join(root, rel).replace(/\\/g, "/")}`;
  return (await import(url)) as Record<string, unknown>;
}

// `@assistant-ui/ai-sdk` resolves from web/ and depends on the nested packages.
const aiSdkEntry = here.resolve("@assistant-ui/ai-sdk");
const aiSdkRequire = createRequire(aiSdkEntry);

const aiSdkRoot = packageRoot(here, "@assistant-ui/ai-sdk");
const coreRoot = packageRoot(aiSdkRequire, "@assistant-ui/core");

/* ── @ai-sdk/react (public entry) ─────────────────────────────────────────── */
const aiSdkReact = (await import(aiSdkRequire.resolve("@ai-sdk/react"))) as Record<string, unknown>;

export const Chat = aiSdkReact.Chat as unknown as new <T>(config: unknown) => ChatInstance<T>;
export type Chat<T> = ChatInstance<T>;

export const useChat = aiSdkReact.useChat as unknown as (
  config: unknown,
) => ChatInstance<unknown[]>;

/* ── @assistant-ui/core (public `internal` subpath) ───────────────────────── */
const coreInternal = (await import(aiSdkRequire.resolve("@assistant-ui/core/internal"))) as Record<
  string,
  unknown
>;

export const ExternalStoreThreadRuntimeCore =
  coreInternal.ExternalStoreThreadRuntimeCore as unknown as new (
    contextProvider: unknown,
    adapter: unknown,
  ) => ExternalStoreThreadRuntimeInstance;

export const MessageRepository =
  coreInternal.MessageRepository as unknown as abstract new () => MessageRepositoryInstance;

export const ExportedMessageRepository = coreInternal.ExportedMessageRepository as unknown as {
  fromBranchableArray: (
    rows: unknown,
    options: { headId: string },
  ) => { messages: unknown; headId: string };
};
export const coreInternalAll = coreInternal;

/* ── @assistant-ui/ai-sdk deep internals (not public exports) ─────────────── */
const sliceMod = await importDist(aiSdkRoot, "dist/utils/sliceMessagesUntil.js");
export const sliceMessagesUntil = sliceMod.sliceMessagesUntil as (
  messages: unknown,
  // `null` is meaningful: the assistant-ui runtime passes `parentId` straight
  // through, and the root of a thread has no parent.
  untilId: string | null,
) => unknown[];

const createMod = await importDist(aiSdkRoot, "dist/converters/toCreateMessage.js");
export const toCreateMessage = createMod.toCreateMessage as (message: unknown) => {
  parts: unknown;
};

const convertMod = await importDist(aiSdkRoot, "dist/converters/convertMessage.js");
export const AISDKMessageConverter = convertMod.AISDKMessageConverter as {
  toThreadMessages: (messages: unknown, isRestart: boolean, metadata: unknown) => unknown[];
};

/* ── @assistant-ui/core deep internal (not a public export) ───────────────── */
const esmMod = await importDist(coreRoot, "dist/runtime/utils/external-store-message.js");
export const getExternalStoreMessages = esmMod.getExternalStoreMessages as (
  thread: unknown,
) => unknown[];
