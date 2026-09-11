import {
  createResumableStreamContext,
  createInMemoryResumableStreamStore,
} from "assistant-stream/resumable";

/**
 * Official assistant-stream resumable-stream context. The in-memory store
 * keeps streams process-local (dev-appropriate); durable stores can replace
 * this via the same ResumableStreamStore interface later.
 * Constructed once per process.
 */
export const resumableContext = createResumableStreamContext({
  store: createInMemoryResumableStreamStore(),
});
