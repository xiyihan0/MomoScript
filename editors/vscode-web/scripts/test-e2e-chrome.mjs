import { spawn, spawnSync } from "node:child_process";

const tests = [
  "e2e/current-preview-export.spec.ts:16",
  "e2e/editor.spec.ts:22",
  "e2e/editor.spec.ts:551",
  "e2e/editor.spec.ts:582",
  "e2e/editor.spec.ts:621",
  "e2e/editor.spec.ts:666",
  "e2e/editor.spec.ts:748",
  "e2e/exact-export.spec.ts:12",
  "e2e/local-history.spec.ts:3",
  "e2e/local-history.spec.ts:25",
  "e2e/local-history.spec.ts:110",
  "e2e/local-history.spec.ts:180",
  "e2e/local-history.spec.ts:199",
  "e2e/preview-interaction.spec.ts:17",
  "e2e/preview-interaction.spec.ts:108",
  "e2e/preview-interaction.spec.ts:244",
];

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const runtimeEnv = { ...process.env, VITE_MMT_E2E: "1" };
const build = spawnSync(npm, ["run", "build"], { stdio: "inherit", env: runtimeEnv });
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

const server = spawn(
  process.execPath,
  ["node_modules/vite/bin/vite.js", "preview", "--host", "127.0.0.1", "--port", "4173", "--strictPort"],
  { stdio: "inherit", env: runtimeEnv },
);

try {
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      const response = await fetch("http://127.0.0.1:4173/");
      if (response.ok) break;
    } catch {
      if (server.exitCode !== null) throw new Error(`Vite preview exited with code ${server.exitCode}`);
    }
    if (Date.now() >= deadline) throw new Error("Vite preview did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const env = { ...process.env, MMT_E2E_EXTERNAL_SERVER: "1" };
  for (const entry of tests) {
    const result = spawnSync(
      process.execPath,
      ["node_modules/@playwright/test/cli.js", "test", "--project=chrome", entry],
      { stdio: "inherit", env },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${entry} failed with exit code ${result.status ?? 1}`);
  }
} finally {
  server.kill("SIGTERM");
}
