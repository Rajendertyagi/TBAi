"use client";

import { useEffect } from "react";
import { useNavigate, useParams } from "react-router";
import { ThreadBootSkeleton } from "@/components/assistant-ui/elements/thread-boot-skeleton";
import { ROUTES } from "@/config/navigation";
import { useConversationTab } from "@/features/chat/state/useConversationTab";
import { OpenCodeChatHost } from "./OpenCodeChatHost";

/**
 * Code-mode route adapter. Owns route param reading, tab validation, and the
 * no-agent redirect; delegates the full OpenCode lifecycle to OpenCodeChatHost.
 */
export function OpenCodeView() {
  const { agentId } = useParams();
  const navigate = useNavigate();

  // Shared route→tab binding with existence validation: a deleted agent
  // conversation closes its tabs and falls back to a draft instead of
  // mounting a stale view. No-op while no conversation is routed.
  useConversationTab(agentId, "agent");

  useEffect(() => {
    if (!agentId?.trim()) {
      // No auto-created conversation: Code mode shares the welcome draft
      // with normal chat (engine picker). The first send with the OpenCode
      // engine mints the conversation and routes here, so visiting /code
      // alone must never leave phantom rows behind.
      navigate(ROUTES.CHAT_NEW, { replace: true });
    }
  }, [agentId, navigate]);

  if (!agentId?.trim()) {
    // Preserve the existing loading behavior for a missing agent id while the
    // redirect effect navigates to the welcome draft.
    return (
      <div className="flex h-full min-h-0 flex-col overflow-y-auto px-4 py-6 pb-4">
        <ThreadBootSkeleton />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <OpenCodeChatHost conversationId={agentId} />
    </div>
  );
}
