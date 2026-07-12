import { spawn } from "node:child_process";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const manifest = path.join(root, "mmt_lsp", "Cargo.toml");

await run("cargo", ["build", "--manifest-path", manifest, "--release", "--bin", "mmt-lsp"]);

const platform = `${process.platform}-${process.arch}`;
const executable = process.platform === "win32" ? "mmt-lsp.exe" : "mmt-lsp";
const source = path.join(root, "mmt_lsp", "target", "release", executable);
const binRoot = path.join(root, "editors", "vscode", "bin");
const destinationDirectory = path.join(binRoot, platform);
await rm(binRoot, { recursive: true, force: true });
await mkdir(destinationDirectory, { recursive: true });
await copyFile(source, path.join(destinationDirectory, executable));
if (process.env.TINYMIST_BIN) {
  const tinymistExecutable = process.platform === "win32" ? "tinymist.exe" : "tinymist";
  await copyFile(
    path.resolve(process.env.TINYMIST_BIN),
    path.join(destinationDirectory, tinymistExecutable)
  );
}

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
