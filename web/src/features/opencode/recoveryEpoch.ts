/**
 * Recovery-epoch reconnect gate for the OpenCode session runtime.
 *
 * Pure decision function behind `AgentRuntime`'s recovery effect: reconnect
 * only on a recovery-epoch CHANGE while mounted (a genuine backend
 * recovery). A normal mount must never rebuild the client merely because the
 * epoch is already non-zero — the client was just created, so rebuilding it
 * would swap the frozen thread-list adapter (client identity change) while
 * the first thread switch/append is still pending, which assistant-ui turns
 * into `ThreadListAdapterChangedError`.
 *
 * Semantics:
 * - mount with epoch 0 → no reconnect.
 * - mount with a stale non-zero epoch → no reconnect (recorded as seen).
 * - epoch transition while mounted → exactly one reconnect.
 * - re-render with the unchanged epoch → no reconnect.
 * - no session bound → no reconnect, seen epoch untouched.
 * - the global epoch is never reset or mutated here.
 */
export function shouldReconnectForEpoch(args: {
  sessionId: string | undefined;
  recoveryEpoch: number;
  seenRecoveryEpoch: number;
}): { reconnect: boolean; seenRecoveryEpoch: number } {
  const { sessionId, recoveryEpoch, seenRecoveryEpoch } = args;
  if (!sessionId) return { reconnect: false, seenRecoveryEpoch };
  if (seenRecoveryEpoch === recoveryEpoch) {
    return { reconnect: false, seenRecoveryEpoch };
  }
  if (recoveryEpoch === 0) {
    return { reconnect: false, seenRecoveryEpoch: recoveryEpoch };
  }
  return { reconnect: true, seenRecoveryEpoch: recoveryEpoch };
}
