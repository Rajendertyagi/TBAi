import "./env";
import { BrowserWindow } from "electrobun/main";
import { startServer } from "../server";

const PORT = parseInt(process.env.PORT || "3000", 10);

async function main() {
  // Start the Hono server (serves /api/* and the bundled web app) on localhost.
  await startServer(PORT);

  // Open the desktop window pointing at the local server.
  new BrowserWindow({
    title: "TBAi",
    url: `http://localhost:${PORT}`,
    frame: {
      width: 1280,
      height: 800,
    },
  });
}

main().catch(console.error);
