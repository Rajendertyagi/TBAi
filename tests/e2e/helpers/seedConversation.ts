import type { APIRequestContext } from "@playwright/test";

/**
 * Create a conversation for a spec to exercise, optionally with one seeded turn.
 *
 * Why this exists: several specs used to read the conversation list, take
 * whatever they found, and `test.skip` when it was empty. That only ever worked
 * by accident - they depended on an EARLIER spec having left a conversation
 * behind. Once the suite gives every spec file its own empty database, the list
 * is always empty, so those specs skipped on every run while still reporting
 * green. A skipped test proves nothing.
 *
 * Seeding explicitly makes each spec self-sufficient and independent of ordering,
 * which is the point of the isolation work.
 */
export interface SeededConversation {
  id: string;
  title: string;
}

/** The title the sidebar shows for a freshly created conversation. */
export const DEFAULT_SEED_TITLE = "New Conversation";

/**
 * Create a conversation and return its id and title.
 *
 * `withMessage` seeds one user turn, so the thread has real history to load.
 * Specs that assert on the boot skeleton or on a reload resuming a bound thread
 * need that; specs that only need a sidebar row do not.
 */
export async function seedConversation(
  request: APIRequestContext,
  options: { title?: string; withMessage?: boolean; messageText?: string } = {},
): Promise<SeededConversation> {
  const title = options.title ?? DEFAULT_SEED_TITLE;

  const created = await request.post("/api/conversations", {
    data: { title, workspaceMode: "simple", engine: "direct" },
  });
  if (!created.ok()) {
    throw new Error(`seed conversation failed: ${created.status()}`);
  }
  const conversation = (await created.json()) as { id: string; title?: string };

  if (options.withMessage) {
    const seeded = await request.post(
      `/api/conversations/${conversation.id}/messages`,
      {
        data: {
          message: {
            id: `seed-user-${conversation.id}`,
            parent_id: null,
            format: "ai-sdk/v6",
            content: {
              role: "user",
              parts: [
                {
                  type: "text",
                  text: options.messageText ?? "an earlier turn",
                },
              ],
            },
          },
        },
      },
    );
    if (!seeded.ok()) {
      // Do not leave a half-seeded conversation behind for the next assertion.
      await removeConversation(request, conversation.id);
      throw new Error(`seed message failed: ${seeded.status()}`);
    }
  }

  return { id: conversation.id, title: conversation.title ?? title };
}

/** Delete a seeded conversation. Never throws: cleanup must not fail a spec. */
export async function removeConversation(
  request: APIRequestContext,
  id: string,
): Promise<void> {
  await request.delete(`/api/conversations/${id}`).catch(() => {});
}
