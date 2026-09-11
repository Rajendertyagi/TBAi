import fs from "fs";
import path from "path";
import { PATHS } from "electrobun/main";

// Runs first in the ElectroBun main process to point the backend at portable,
// next-to-executable locations. Imported before ../server (which pulls in the DB
// module that reads process.env.DATA_DIR at load time).
const appDir = path.dirname(process.execPath);

if (!process.env.DATA_DIR) {
  process.env.DATA_DIR = path.join(appDir, "data");
}

// The web build is copied into the app bundle by electrobun.config.ts
// (build.copy: { "web/dist": "resources/web" }), which lands at
// <Resources>/app/resources/web. PATHS.RESOURCES_FOLDER points at <Resources>,
// so resolve the web dist robustly by checking the likely candidates.
if (!process.env.WEB_DIST_DIR) {
  const candidates = [
    path.join(PATHS.RESOURCES_FOLDER, "app", "resources", "web"),
    path.join(PATHS.RESOURCES_FOLDER, "resources", "web"),
    path.join(PATHS.RESOURCES_FOLDER, "web"),
  ];
  const found = candidates.find((c) =>
    fs.existsSync(path.join(c, "index.html")),
  );
  process.env.WEB_DIST_DIR = found ?? candidates[0];
}
