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

await runTests({
  extensionDevelopmentPath,
  extensionTestsPath,
  launchArgs: ["--disable-extensions"]
});
