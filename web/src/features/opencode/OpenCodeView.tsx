"use client";

import { useEffect } from "react";
import { useNavigate, useParams } from "react-router";
import { ROUTES } from "@/config/navigation";
import { useConversationTab } from "@/features/chat/state/useConversationTab";

/**
 * Code-mode route adapter — Phase E thin focus/open trigger.
 *
 * The OpenCode conversation is rendered by the persistent Dockview workspace's
 * `OpenCodePanel`, which mounts `OpenCodeChatHost` inside its own isolation
 * boundary and provider. This view owns NO host of its own: mounting one here
 * would create a second runtime for an already-open panel. It keeps only route
 * param reading, tab validation and the no-agent redirect; the focus controller
 * then converges `localActiveKey` with the Dockview panel.
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
      // No auto-created conversation: Code mode shares the welcome draft with
      // normal chat (engine picker). The first send with the OpenCode engine
      // mints the conversation and routes here, so visiting /code alone must
      // never leave phantom rows behind.
      navigate(ROUTES.CHAT_NEW, { replace: true });
    }
  }, [agentId, navigate]);

  return null;
}
