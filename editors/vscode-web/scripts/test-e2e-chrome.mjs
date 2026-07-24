import { spawn, spawnSync } from "node:child_process";

const groups = [
  { name: "runtime export", tag: "@runtime-export", timeout: 8 * 60_000 },
  { name: "preview navigation", tag: "@preview-navigation", timeout: 8 * 60_000 },
  // Restart Playwright after each full-WASM editor journey so a previous page cannot retain browser-side compiler state.
  { name: "editor runtime materialization", tag: "@editor-runtime-materialization", timeout: 8 * 60_000 },
  { name: "editor runtime notifications", tag: "@editor-runtime-notifications", timeout: 5 * 60_000 },
  { name: "editor runtime sashes", tag: "@editor-runtime-sashes", timeout: 5 * 60_000 },
  { name: "editor surfaces", tag: "@editor-surface", timeout: 10 * 60_000 },
  { name: "local history", tag: "@local-history", timeout: 12 * 60_000 },
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

  const env = {
    ...process.env,
    MMT_E2E_EXTERNAL_SERVER: "1",
    MMT_E2E_CHROME_GROUP: "1",
  };
  for (const group of groups) {
    console.log(`\n=== Chrome E2E group: ${group.name} (${group.tag}) ===`);
    const result = spawnSync(
      process.execPath,
      [
        "node_modules/@playwright/test/cli.js",
        "test",
        "--project=chrome",
        "--workers=1",
        "--grep",
        group.tag,
      ],
      { stdio: "inherit", env, timeout: group.timeout, killSignal: "SIGTERM" },
    );
    if (result.error) {
      throw new Error(`${group.name} did not complete within ${group.timeout / 60_000} minutes`, {
        cause: result.error,
      });
    }
    if (result.status !== 0) {
      throw new Error(`${group.name} failed with exit code ${result.status ?? 1}`);
    }
  }
} finally {
  server.kill("SIGTERM");
}
