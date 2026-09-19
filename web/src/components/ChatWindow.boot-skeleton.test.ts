import { describe, it, expect, beforeAll } from "bun:test";

/**
 * Boot-skeleton sharing guard (Phase 2 Step 2).
 *
 * `ThreadBootSkeleton` must live in exactly ONE place — the shared element
 * `assistant-ui/elements/thread-boot-skeleton.tsx` — and be imported by both
 * the Direct chat surface (`ChatWindow`) and the OpenCode surface
 * (`OpenCodeView`). The old local copy in `ChatWindow.tsx` must not return.
 *
 * Source-guard convention (same as `ChatWindow.blocks.test.ts`): `web/` has no
 * DOM runner, so the sharing contract is pinned against the source.
 */
const SHARED_PATH = "assistant-ui/elements/thread-boot-skeleton";

let chatWindowSource = "";
let openCodeViewSource = "";
let sharedSource = "";

beforeAll(async () => {
  chatWindowSource = await Bun.file(
    new URL("../components/ChatWindow.tsx", import.meta.url),
  ).text();
  openCodeViewSource = await Bun.file(
    new URL("../features/opencode/OpenCodeView.tsx", import.meta.url),
  ).text();
  sharedSource = await Bun.file(
    new URL("../components/assistant-ui/elements/thread-boot-skeleton.tsx", import.meta.url),
  ).text();
});

describe("ThreadBootSkeleton — single shared implementation", () => {
  it("ChatWindow still renders the boot skeleton in its existing supported mode", () => {
    expect(chatWindowSource).toContain("showBoot ? <ThreadBootSkeleton /> : null");
  });

  it("ChatWindow imports the shared component", () => {
    expect(chatWindowSource).toContain(
      `import { ThreadBootSkeleton } from "./${SHARED_PATH}";`,
    );
  });

  it("OpenCodeView imports the same shared component", () => {
    expect(openCodeViewSource).toContain(
      `import { ThreadBootSkeleton } from "@/components/${SHARED_PATH}";`,
    );
  });

  it("ChatWindow no longer contains a local ThreadBootSkeleton implementation", () => {
    expect(chatWindowSource).not.toContain("function ThreadBootSkeleton");
  });

  it("OpenCodeView does not define a local ThreadBootSkeleton either", () => {
    expect(openCodeViewSource).not.toContain("function ThreadBootSkeleton");
  });

  it("the shared element is the single implementation", () => {
    expect(sharedSource).toContain("export function ThreadBootSkeleton");
    // The shared element keeps the exact loading copy from historyConfig.
    expect(sharedSource).toContain("historyConfig.copy.loadingConversation");
  });
});