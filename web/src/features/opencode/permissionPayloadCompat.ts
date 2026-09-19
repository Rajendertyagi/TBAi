import type { OpenCodeRuntimeClient } from "./eventScope";
import { autoAcceptPendingPermissions } from "./permissionCompat";
import { getAutoPolicy } from "./sessionAutoPolicy";

/** The live auto-approval inputs the payload patch closes over. */
interface AutoApproveOptions {
  /** The shared per-runtime answered set (also used by hydration). */
  readonly answered: Set<string>;
  /** The OpenCode session id; undefined ⇒ fail closed (never auto-approve). */
  readonly sessionId: string | undefined;
}

/**
 * OpenCode V2 interaction-payload compatibility layer.
 *
 * `@assistant-ui/react-opencode@0.2.23` is V1-shaped: its event switch handles
 * `permission.asked` / `permission.replied` / `question.asked` /
 * `question.replied` / `question.rejected` and nothing else. This OpenCode build
 * also emits **V2** variants of the same lifecycle under different names, and
 * those frames are currently **dropped on the floor** — the adapter has no case
 * for them, so the request never reaches `pending` and the tool sits at
 * `running` with no card at all. Unlike a missing directory scope, this failure
 * is completely silent: no error, no warning, just a tool that never finishes.
 *
 * Measured against the managed 1.18.31 server (captured SSE frame):
 *
 *   {"type":"permission.v2.asked","properties":{
 *      "id":"per_probe_v2_create_1","sessionID":"ses_…",
 *      "action":"bash","resources":["echo v2-create-probe"],
 *      "metadata":{"probe":true}}}
 *
 *   {"type":"permission.v2.replied","properties":{
 *      "sessionID":"ses_…","requestID":"per_probe_v2_create_1","reply":"once"}}
 *
 * Note the first frame has **no `source`**: a V2 request legitimately has no
 * tool link, so it must stay unlinked and answerable through the fallback panel
 * rather than be attached to an invented tool card.
 *
 * The mapping is deliberately minimal — only the field names the adapter
 * actually reads:
 *
 *   action    -> permission   (the adapter names the request by this)
 *   resources -> patterns     (the panel's description reads `patterns.length`)
 *   save      -> always       (the card reads `always.length`)
 *   source    -> tool         ONLY when `source.type === "tool"`
 *
 * `permission.v2.replied` is field-identical to V1, and every V2 *question*
 * shape is structurally identical to its V1 counterpart (`QuestionV2Info` ===
 * `QuestionInfo`, `QuestionV2Tool` === `QuestionTool`), so for those only the
 * event name is remapped. No property mapping is invented for them.
 *
 * Every function here is pure and non-mutating, and a frame that is already V1,
 * unknown, or too malformed to become a usable V1 request is returned
 * **unchanged** (same reference) so it flows on exactly as before.
 *
 * The layer is deletable the day upstream ships a V2-native adapter.
 */

/**
 * V2 event name → the V1 name the adapter's switch actually handles.
 *
 * A `Map` rather than a record so a lookup is typed `string | undefined`
 * without an index-signature cast.
 */
const V2_TO_V1_EVENT_TYPE: ReadonlyMap<string, string> = new Map([
  ["permission.v2.asked", "permission.asked"],
  ["permission.v2.replied", "permission.replied"],
  ["question.v2.asked", "question.asked"],
  ["question.v2.replied", "question.replied"],
  ["question.v2.rejected", "question.rejected"],
]);

/**
 * The one V2 event whose **properties** differ from its V1 counterpart.
 *
 * `permission.v2.replied` is field-identical to `permission.replied`
 * (`{ sessionID, requestID, reply }`), and every V2 question shape is
 * structurally identical to its V1 counterpart, so only this event needs a
 * property projection. Every other mapped event is a name change alone.
 */
const V2_ASKED_PERMISSION = "permission.v2.asked";

/** A frame's property bag, as far as this layer needs to see it. */
type Properties = Record<string, unknown>;

/**
 * True when a normalized frame is a `permission.asked` event, in either of the
 * two envelopes the adapter's event source accepts (bare or `payload`-wrapped).
 *
 * @param frame - A frame already passed through {@link normalizeOpenCodeInteractionFrame}.
 * @returns True when the frame asks for a permission decision.
 */
function isPermissionAsked(frame: unknown): boolean {
  const outer = asRecord(frame);
  if (!outer) return false;
  const payload = asRecord(outer.payload);
  const record = payload ?? outer;
  return record.type === "permission.asked";
}

/**
 * Reads the permission request id from a normalized `permission.asked` frame.
 *
 * The id is the frame's own `properties.id` — the real permission id, never a
 * toolCallId or messageID.
 *
 * @param frame - A normalized `permission.asked` frame.
 * @returns The request id, or `undefined` when it is unusable.
 */
function permissionIdOf(frame: unknown): string | undefined {
  const outer = asRecord(frame);
  if (!outer) return undefined;
  const payload = asRecord(outer.payload);
  const properties = asRecord((payload ?? outer).properties);
  const id = properties?.id;
  return typeof id === "string" ? id : undefined;
}

/** Reads a value as a plain object, or `undefined` when it is not one. */
function asRecord(value: unknown): Properties | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  // Narrowing after the runtime check above; the alternative is an index
  // signature on `unknown`, which TypeScript does not offer.
  return value as Properties;
}

/** Copies a value into a `string[]`, or `undefined` when it is not one. */
function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return undefined;
    out.push(item);
  }
  return out;
}

/**
 * Projects a V2 `source` onto the V1 `tool` link, refusing to fabricate one.
 *
 * `source` is optional, and its `type` is the literal `"tool"` in this build.
 * A source that is absent, of another type, or missing either id is **not** a
 * tool link: returning `undefined` keeps the request unlinked, which is what
 * makes it render through the fallback panel and stay answerable. Inventing a
 * `callID` would attach it to an unrelated tool card.
 *
 * @param value - The V2 `source` (or an already-V1 `tool`).
 * @returns `{ messageID, callID }`, or `undefined` when there is no real link.
 */
function toV1Tool(value: unknown): Properties | undefined {
  const source = asRecord(value);
  if (!source) return undefined;
  // `type` is required by `PermissionV2Source`; requiring it is what stops a
  // future non-tool source from being mistaken for a tool link.
  if (source.type !== "tool") return undefined;
  const { messageID, callID } = source;
  if (typeof messageID !== "string" || typeof callID !== "string") return undefined;
  return { messageID, callID };
}

/**
 * Maps V2 permission properties onto the V1 names the adapter reads.
 *
 * Unrelated properties are preserved, and the V2 names are kept alongside their
 * V1 equivalents (the adapter only ever reads the V1 ones). `patterns` and
 * `always` are always produced as arrays: the adapter's own types declare them
 * non-optional, and an absent array crashes the card
 * (`patterns.length` / `always.length`), which is the failure this layer exists
 * to prevent.
 *
 * @param properties - The V2 frame's property bag.
 * @returns The V1-shaped bag, or `undefined` when the request has no usable
 *   identity (no `id`/`sessionID`) and should simply be ignored as before.
 */
function toV1PermissionProperties(properties: Properties): Properties | undefined {
  const { id, sessionID } = properties;
  if (typeof id !== "string" || typeof sessionID !== "string") return undefined;

  const permission = properties.permission ?? properties.action;
  const patterns =
    asStringArray(properties.patterns) ?? asStringArray(properties.resources) ?? [];
  const always = asStringArray(properties.always) ?? asStringArray(properties.save) ?? [];
  const metadata = asRecord(properties.metadata) ?? {};
  const tool = toV1Tool(properties.tool ?? properties.source);

  return {
    ...properties,
    id,
    sessionID,
    ...(permission === undefined ? {} : { permission }),
    patterns,
    always,
    metadata,
    ...(tool === undefined ? {} : { tool }),
  };
}

/**
 * Rewrites one `{type, properties}` record when it carries a V2 interaction.
 *
 * @param record - The frame (or its `payload`) as a property bag.
 * @returns A new record for a V2 interaction, otherwise the input unchanged.
 */
function normalizeFrameRecord(record: Properties): Properties {
  const { type } = record;
  if (typeof type !== "string") return record;
  const v1Type = V2_TO_V1_EVENT_TYPE.get(type);
  if (v1Type === undefined) return record;

  const properties = asRecord(record.properties);
  if (!properties) return record;

  if (type === V2_ASKED_PERMISSION) {
    const normalized = toV1PermissionProperties(properties);
    // No usable identity: leave the frame alone so the adapter ignores it, as
    // it does today. Nothing is fabricated to force a request into existence.
    if (normalized === undefined) return record;
    return { ...record, type: v1Type, properties: normalized };
  }

  // Everything else — a V2 reply, and every V2 question event — differs from its
  // V1 counterpart in the event NAME only. Routing a reply through the
  // asked-shaped projection would drop it: a reply carries `requestID`, not
  // `id`, so it would fail the identity check and pass through unmapped.
  return { ...record, type: v1Type };
}

/**
 * Normalizes one raw stream frame.
 *
 * Accepts the same two envelopes the adapter's own event source accepts — bare
 * `{type, properties}` and wrapped `{payload: {type, properties}}` — so this
 * wrapper is transparent to whatever the transport hands it.
 *
 * Pure and non-mutating: the input object is never written to, and a frame that
 * needs no change is returned by reference.
 *
 * @param frame - One raw frame from the OpenCode event stream.
 * @returns The V1-equivalent frame, or the original when no mapping applies.
 */
export function normalizeOpenCodeInteractionFrame(frame: unknown): unknown {
  const outer = asRecord(frame);
  if (!outer) return frame;

  const payload = asRecord(outer.payload);
  if (payload) {
    const normalized = normalizeFrameRecord(payload);
    return normalized === payload ? frame : { ...outer, payload: normalized };
  }
  return normalizeFrameRecord(outer);
}

/**
 * Yields every frame, normalizing the V2 interactions among them and answering
 * a live `permission.asked` automatically when the session's Auto shield is on.
 *
 * **Reply before yield, always yield.** The auto reply is awaited BEFORE the
 * frame is yielded, so a request that is auto-accepted never needs a card; the
 * frame is still yielded afterwards so the event always continues through the
 * normal pipeline. {@link autoAcceptPendingPermissions} never throws (each
 * request is wrapped in its own try/catch), so a failed reply simply yields an
 * unanswered request that falls through to the manual UI — nothing is
 * suppressed and no success is fabricated.
 */
async function* normalizeFrames(
  stream: AsyncIterable<unknown>,
  client: OpenCodeRuntimeClient,
  compat: AutoApproveOptions,
): AsyncGenerator<unknown> {
  for await (const frame of stream) {
    const normalized = normalizeOpenCodeInteractionFrame(frame);
    if (isPermissionAsked(normalized) && getAutoPolicy(compat.sessionId)) {
      const id = permissionIdOf(normalized);
      if (id) {
        await autoAcceptPendingPermissions(client, [{ id }], "auto", compat.answered);
      }
    }
    yield normalized;
  }
}

/**
 * Applies the V2 payload normalization to a client, in place, by wrapping the
 * event subscription it already uses.
 *
 * **Must be applied last**, after the scope patches and after initial hydration.
 * Hydration synthesizes its replayed frames *inside its own wrapper*, so a
 * normalizer applied earlier would never see them; applied last it is the
 * outermost wrapper and therefore sees both live SSE frames and replayed ones
 * through a single mapping.
 *
 * Unlike the scope patches this needs no session id or directory — it is a pure
 * shape mapping — so it is applied unconditionally and stays inert for a stream
 * that is already V1.
 *
 * @param client - The client the assistant-ui OpenCode runtime is built around.
 * @param compat - The shared answered set and session id for live auto-approval.
 */
export function applyPermissionPayloadCompat(
  client: OpenCodeRuntimeClient,
  compat: AutoApproveOptions,
): void {
  const event = client.event;
  const subscribe = event.subscribe.bind(event);

  const normalizingSubscribe = async (
    parameters?: Parameters<OpenCodeRuntimeClient["event"]["subscribe"]>[0],
    options?: Parameters<OpenCodeRuntimeClient["event"]["subscribe"]>[1],
  ) => {
    const subscription = (await subscribe(parameters, options)) as {
      stream: AsyncIterable<unknown>;
    };
    return {
      ...subscription,
      stream: normalizeFrames(subscription.stream, client, compat),
    };
  };

  // The SDK declares `subscribe` as generic in `ThrowOnError`; this replacement
  // is not generic (its return type does not depend on that parameter), so the
  // assignment is asserted to the SDK's own signature — the same documented
  // accommodation `eventScope.ts` and `initialHydration.ts` already make.
  event.subscribe =
    normalizingSubscribe as unknown as OpenCodeRuntimeClient["event"]["subscribe"];
}
