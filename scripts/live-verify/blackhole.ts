// Live-verification blackhole: accepts HTTP requests and never responds, so a
// chat/scheduler provider call against it stays genuinely in-flight until the
// caller's abort controller fires canvass it.
Bun.serve({
  port: 9999,
  async fetch() {
    await new Promise<never>(() => {});
    return new Response("unreachable");
  },
});
