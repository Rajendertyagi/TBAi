/**
 * Phase 1 — validate the envelope and resolve the provider.
 *
 * A MOVE out of the `POST /api/chat` handler. Nothing here was rewritten: the
 * bodies, the order of the guards, the log events and the `c.json` bodies are
 * the originals. The only change is that they return a `PhaseResult` instead of
 * writing to a shared closure.
 *
 * ## Why the guards are in this exact order
 *
 * The order is a contract, not a style choice. The engine guard runs BEFORE
 * provider resolution so a persisted OpenCode row is rejected as
 * `ENGINE_MISMATCH` even when the same request also names an unknown provider or
 * omits a credential — the most specific diagnosis wins. Moving any guard ahead
 * of it changes which error a client sees.
 *
 * ## Why the manual `/compact` intercept lives here
 *
 * A compaction command produces NO assistant message, so it must not create a
 * chat run: a run created before this intercept would never be settled, because
 * there is no stream to settle it. The command carries its own cancellable
 * lifecycle instead. See `direct-compact-command.ts` for the full ordering
 * argument.
 */
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  safeValidateUIMessages,
  type UIMessage,
} from "ai";
import { getModel } from "../../services/ai";
import { buildReasoningProviderOptions } from "../chat-provider-options";
import { conversationService } from "../../services/storage";
import { credentialStore } from "../../services/credentials";
import { errorLogFields } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { chatMessageMetadataSchema, chatRequestSchema } from "../../lib/validation";
import { resolveChatModel, UnknownProviderError } from "../chat-model";
import {
  beginCompactCommand,
  detectCompactCommand,
  runManualCompaction,
} from "../direct-compact-command";
import type { ChatContext, DirectRunSetup, PhaseResult } from "./types";

/** A directive field the server owns; a client may not supply one. */
function hasNonEmptyDirective(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/**
 * Validate the request envelope and resolve provider, model and credentials.
 *
 * Returns the populated `DirectRunSetup`, or the finished rejection Response
 * for any early exit (400 / 422 / 500) — including the `/compact` intercept,
 * which answers with a data-only stream and never reaches run creation.
 */
export async function validateAndResolve(
  c: ChatContext,
  requestId: string,
): Promise<PhaseResult<DirectRunSetup>> {
  const parsed = chatRequestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    logger.warn("chat", "chat_request_rejected", {
      requestId,
      reason: "invalid_envelope",
    });
    return {
      ok: false,
      response: c.json(
        {
          error: "Invalid request",
          issues: parsed.error.issues,
          requestId,
        },
        400,
      ),
    };
  }

  const {
    reasoningLevel: reasoningOverride,
    messages: rawMessages,
  } = parsed.data;
  const providerId = parsed.data.providerId?.trim() || undefined;
  const model = parsed.data.model?.trim() || undefined;
  const threadId = parsed.data.id?.trim() || undefined;
  // Row-authoritative engine guard: a persisted OpenCode row must never be
  // served as Direct (the Code surface owns it). This runs before provider
  // resolution so an engine mismatch remains the canonical response even when
  // the request also has an unknown provider or missing credential.
  const conversation = threadId ? await conversationService.get(threadId) : null;
  if (conversation?.engine === "opencode") {
    return {
      ok: false,
      response: c.json(
        {
          error: `Conversation ${threadId} uses the OpenCode engine; open it on the Code surface instead of /api/chat.`,
          code: "ENGINE_MISMATCH",
          requestId,
        },
        422,
      ),
    };
  }

  const directiveField = (["system", "tools", "callSettings", "config"] as const).find(
    (field) => hasNonEmptyDirective(parsed.data[field]),
  );
  if (directiveField) {
    logger.warn("chat", "chat_request_rejected", {
      requestId,
      conversationId: threadId,
      reason: `${directiveField}_directive_not_allowed`,
    });
    return {
      ok: false,
      response: c.json({ error: `${directiveField} is server-owned`, requestId }, 400),
    };
  }

  let resolved: Awaited<ReturnType<typeof resolveChatModel>>;
  try {
    resolved = await resolveChatModel({
      providerId,
      model,
      reasoningLevel: reasoningOverride,
      threadId,
    });
  } catch (e) {
    // Explicit but unknown provider reference: diagnosable 400, never a
    // silent substitution of the active provider (Phase 2 contract).
    if (e instanceof UnknownProviderError) {
      return {
        ok: false,
        response: c.json({ error: e.message, code: e.code, requestId }, 400),
      };
    }
    throw e;
  }
  if (!resolved) {
    return {
      ok: false,
      response: c.json({ error: "No provider configured", requestId }, 400),
    };
  }
  const provider = resolved.provider;
  const effectiveModel = resolved.model;
  const effectiveReasoning = resolved.reasoning;

  const needsKey = provider.type !== "ollama";
  let modelConfig = provider;
  if (needsKey) {
    if (!credentialStore.has(provider.id)) {
      return {
        ok: false,
        response: c.json({ error: "No API key configured for this provider.", requestId }, 400),
      };
    }
    const apiKey = credentialStore.get(provider.id);
    modelConfig = { ...provider, apiKey };
  }
  if (effectiveModel) {
    modelConfig = { ...modelConfig, model: effectiveModel };
  }

  const messageValidation = await safeValidateUIMessages({
    messages: rawMessages,
    metadataSchema: chatMessageMetadataSchema,
  });
  if ("error" in messageValidation) {
    logger.warn("chat", "chat_request_rejected", {
      requestId,
      conversationId: threadId,
      reason: "invalid_messages",
      ...errorLogFields(messageValidation.error, { provider: provider.type }),
    });
    return {
      ok: false,
      response: c.json({ error: "Invalid messages", requestId }, 400),
    };
  }
  if (messageValidation.data.some((message) => message.role === "system")) {
    logger.warn("chat", "chat_request_rejected", {
      requestId,
      conversationId: threadId,
      reason: "system_message_not_allowed",
    });
    return {
      ok: false,
      response: c.json({ error: "System messages are server-owned", requestId }, 400),
    };
  }
  const messages: UIMessage[] = messageValidation.data;

  let approvalSecret: string;
  try {
    approvalSecret = credentialStore.getToolApprovalSecret();
  } catch (error) {
    logger.error("credential", "credential.error", {
      requestId,
      conversationId: threadId,
      ...errorLogFields(error),
    });
    return {
      ok: false,
      response: c.json(
        { error: "Tool approval security is unavailable", requestId },
        500,
      ),
    };
  }

  const languageModel = getModel(modelConfig);
  const reasoning = effectiveReasoning ?? provider.thinking ?? "off";
  // Every provider quirk that decides whether reasoning is returned at all
  // lives in that module — see it for why each option is shaped the way it is.
  const providerOptions = buildReasoningProviderOptions(provider, modelConfig.model, reasoning);

  // ── Manual `/compact` — intercepted ABOVE `chatRuns.create` ───────────────
  // A compaction command produces no assistant message, so it must not create a
  // chat run: a run created before this intercept would be left non-terminal,
  // because there is no stream to settle it. The command carries its own
  // cancellable lifecycle instead. See `direct-compact-command.ts` for the full
  // ordering argument, and for why this still uses the single assembly seam.
  const compactCommand = detectCompactCommand(messages);
  if (compactCommand) {
    const command = beginCompactCommand(c.req.raw.signal);
    const compact = await runManualCompaction({
      operationId: command.operationId,
      requestId,
      conversationId: threadId,
      submittedMessages: messages,
      provider: modelConfig,
      modelId: modelConfig.model,
      // The row may hold NULL; the compaction seam wants `string | undefined`.
      systemPrompt: conversation?.systemPrompt ?? undefined,
      summarizerModel: languageModel,
      // What the user typed after the command word, or `undefined` for a bare
      // `/compact`. Parsed once, here, so the command module never re-reads text.
      instructions: compactCommand.instructions,
      signal: command.controller.signal,
    });
    // Data-only stream: a single status part and NO message parts, so no
    // assistant message exists and nothing enters conversational persistence.
    return {
      ok: false,
      response: createUIMessageStreamResponse({
        stream: createUIMessageStream({
          execute: async ({ writer }) => {
            writer.write({ type: "data-tbai-compact", id: "compact", data: compact });
          },
        }),
      }),
    };
  }

  return {
    ok: true,
    value: {
      requestId,
      threadId,
      conversation,
      provider,
      modelConfig,
      reasoning,
      approvalSecret,
      languageModel,
      providerOptions,
      messages,
    },
  };
}