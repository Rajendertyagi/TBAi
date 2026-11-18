/**
 * The single "is this assistant message a failure" decision.
 *
 * Both the error card (`AssistantError`) and the message action bar read this so
 * a failed message shows exactly one retry control: the card's Retry button.
 * The action bar hides its Regenerate button when this returns a value, because
 * the two controls call the same `onReload` handler and showing both is a
 * duplicate action.
 *
 * The two sources mirror the runtime's own error contract:
 * - a live `status: incomplete / error` (the turn that just failed), and
 * - a stored `metadata.custom.error` on the last message (a reloaded failure,
 *   whose status the AI SDK converter drops on the way in).
 */

/** The minimal slice of assistant-ui state this selector reads. */
export interface MessageErrorState {
  readonly message: {
    readonly id: string;
    readonly role: string;
    readonly status?:
      | { readonly type: string; readonly reason?: string; readonly error?: unknown }
      | undefined;
    readonly metadata?: { readonly custom?: unknown } | undefined;
  };
  readonly thread: {
    readonly messages: readonly { readonly id: string }[];
  };
}

/** Return the failure text for this message, or undefined when it is not a failure. */
export function messageErrorText(s: MessageErrorState): string | undefined {
  const status = s.message.status;
  if (status?.type === "incomplete" && status.reason === "error") {
    const err = status.error;
    if (typeof err === "string") return err;
    if (
      typeof err === "object" &&
      err !== null &&
      "message" in err &&
      typeof (err as { message?: unknown }).message === "string"
    ) {
      return (err as { message: string }).message;
    }
    return err ? String(err) : "An error occurred";
  }

  // A stored failure has no `status`; its text lives in metadata.custom.error.
  // Gated on the last message so a turn the user has moved past does not keep
  // wearing a retry action that would re-run it.
  if (s.message.role !== "assistant") return undefined;
  if (s.thread.messages.at(-1)?.id !== s.message.id) return undefined;
  const custom = s.message.metadata?.custom as { error?: unknown } | undefined;
  const text = custom?.error;
  return typeof text === "string" && text.length > 0 ? text : undefined;
}
