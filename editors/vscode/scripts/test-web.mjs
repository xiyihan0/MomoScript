import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";

const VSCODE_1_95_3_COMMIT = "f1a4fb101478ce6ec82fe9627c43efbf9e98c813";
const require = createRequire(import.meta.url);
const testWebEntry = require.resolve("@vscode/test-web");

const port = await new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "localhost", () => {
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      reject(new Error("failed to reserve a local Web Extension Host port"));
      return;
    }
    server.close((error) => {
      if (error) reject(error);
      else resolve(address.port);
    });
  });
});

const child = spawn(
  process.execPath,
  [
    testWebEntry,
    "--quality=stable",
    `--commit=${VSCODE_1_95_3_COMMIT}`,
    "--browser=chromium",
    "--host=localhost",
    `--port=${port}`,
    "--extensionDevelopmentPath=.",
    "--extensionTestsPath=dist/test/suite/index.js",
    "--headless=true",
    "--esm=true",
  ],
  { stdio: "inherit" },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.kill(signal));
}

const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    resolve(code ?? (signal === null ? 1 : 128));
  });
});

process.exitCode = exitCode;
