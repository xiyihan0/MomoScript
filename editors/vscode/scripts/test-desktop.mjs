import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runTests } from "@vscode/test-electron";

const extensionDevelopmentPath = path.resolve(
  fileURLToPath(new URL("..", import.meta.url))
);
const extensionTestsPath = path.join(
  extensionDevelopmentPath,
  "dist",
  "test",
  "desktop",
  "index.js"
);

const tinymist = process.env.TINYMIST_BIN;
if (!tinymist) throw new Error("TINYMIST_BIN is required for Desktop Extension Host tests");
const userDataDir = await mkdtemp(path.join(os.tmpdir(), "mmt-vscode-desktop-"));
const exportPath = path.join(userDataDir, "mmt-desktop-export.pdf");
await mkdir(path.join(userDataDir, "User"), { recursive: true });
await writeFile(path.join(userDataDir, "User", "settings.json"), JSON.stringify({
  "mmt.typst.server.path": tinymist
}));
process.env.MMT_DESKTOP_EXPORT_PATH = exportPath;
try {
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: ["--disable-extensions", "--disable-workspace-trust", "--user-data-dir", userDataDir]
  });
} finally {
  await rm(userDataDir, { recursive: true, force: true });
}
