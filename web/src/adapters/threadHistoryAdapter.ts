import type { ThreadHistoryAdapter, ExportedMessageRepositoryItem } from "@assistant-ui/react";

/**
 * HTTP-backed ThreadHistoryAdapter for assistant-ui's RemoteThreadListRuntime.
 *
 * The AI SDK runtime (`useChatRuntime`) requires the adapter to expose
 * `withFormat(formatAdapter)`. The runtime passes its `storageFormatAdapter`
 * which knows how to encode/decode between the runtime's in-memory message type
 * and an opaque storage format. We persist exactly what the format adapter
 * produces (`{ id, parent_id, format, content }`) and hand it back verbatim on
 * load — we never interpret the message internals.
 *
 * The base `load`/`append`/`update`/`delete` methods (without a format adapter)
 * are kept for type-completeness; the runtime only ever uses the `withFormat`
 * result, so all real persistence flows through it.
 */
export function createThreadHistoryAdapter(
  getAui: () => { threadListItem: { getState: () => { remoteId?: string }; initialize: () => Promise<{ remoteId: string }> } }
): ThreadHistoryAdapter {
  const getRemoteId = (): string | null => {
    try {
      const aui = getAui();
      return (aui?.threadListItem?.getState?.()?.remoteId as string | undefined) ?? null;
    } catch {
      return null;
    }
  };

  const ensureRemoteId = async (): Promise<string> => {
    const aui = getAui();
    const { remoteId } = await aui.threadListItem.initialize();
    return remoteId;
  };

  const appendStored = async (entry: {
    id: string;
    parent_id: string | null;
    format: string;
    content: unknown;
  }) => {
    const remoteId = await ensureRemoteId();
    await fetch(`/api/conversations/${remoteId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: entry }),
    });
  };

  const baseAdapter: ThreadHistoryAdapter = {
    async load() {
      const remoteId = getRemoteId();
      if (!remoteId) return { messages: [] };
      try {
        const res = await fetch(`/api/conversations/${remoteId}/messages`);
        if (!res.ok) return { messages: [] };
        const data = (await res.json()) as { messages: Array<{ content: unknown; parent_id: string | null }> };
        return {
          headId: null,
          messages: (data.messages ?? []).map((m) => ({
            message: m.content as any,
            parentId: m.parent_id ?? null,
          })),
        };
      } catch {
        return { messages: [] };
      }
    },

    async append(item: ExportedMessageRepositoryItem) {
      await appendStored({
        id: item.message.id,
        parent_id: item.parentId ?? null,
        format: "raw",
        content: item.message,
      });
    },

    async update(item: ExportedMessageRepositoryItem) {
      await this.append?.(item);
    },

    async delete(items: ExportedMessageRepositoryItem[]) {
      const remoteId = await ensureRemoteId();
      for (const it of items) {
        await fetch(`/api/conversations/${remoteId}/messages/${it.message.id}`, {
          method: "DELETE",
        });
      }
    },
  };

  return {
    ...baseAdapter,
    withFormat(formatAdapter) {
      const encode = (item: { message: any; parentId: string | null }) => ({
        id: formatAdapter.getId(item.message),
        parent_id: item.parentId ?? null,
        format: formatAdapter.format,
        content: formatAdapter.encode(item),
      });

      return {
        pin() {},

        async append(item) {
          await appendStored(encode(item));
        },

        async update(item) {
          await appendStored(encode(item));
        },

        async delete(items) {
          const remoteId = await ensureRemoteId();
          for (const it of items) {
            await fetch(`/api/conversations/${remoteId}/messages/${formatAdapter.getId(it.message)}`, {
              method: "DELETE",
            });
          }
        },

        reportTelemetry() {},

        async load() {
          const remoteId = getRemoteId();
          if (!remoteId) return { messages: [] };
          try {
            const res = await fetch(`/api/conversations/${remoteId}/messages`);
            if (!res.ok) return { messages: [] };
            const data = (await res.json()) as {
              messages: Array<{ id: string; parent_id: string | null; format: string; content: unknown }>;
            };
            return {
              messages: (data.messages ?? [])
                .filter((e) => e.content != null)
                .map((e) =>
                  formatAdapter.decode({
                    id: e.id,
                    parent_id: e.parent_id ?? null,
                    format: e.format,
                    content: e.content as any,
                  })
                ),
            };
          } catch {
            return { messages: [] };
          }
        },
      };
    },
  };
}
