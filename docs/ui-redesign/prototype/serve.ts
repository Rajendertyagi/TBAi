// Temporary static server for capturing prototype screenshots.
// Not part of the production app. Run with: bun run docs/ui-redesign/prototype/serve.ts
const dir = new URL("./", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
const server = Bun.serve({
  port: 4599,
  async fetch(req) {
    const url = new URL(req.url);
    const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = Bun.file(dir + name);
    if (await file.exists()) {
      return new Response(file, { headers: { "Content-Type": name.endsWith(".html") ? "text/html" : "text/plain" } });
    }
    return new Response("Not found", { status: 404 });
  },
});
console.log("prototype server on http://localhost:4599");
