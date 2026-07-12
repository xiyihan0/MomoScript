import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const crate = path.join(root, "mmt_lsp");
const output = path.join(root, "editors", "vscode", "wasm");

await run("wasm-pack", [
  "build",
  crate,
  "--target",
  "web",
  "--out-dir",
  output,
  "--release",
  "--no-default-features"
]);

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with ${code ?? signal}`));
      }
    });
  });
}
