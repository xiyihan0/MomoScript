import { spawn, spawnSync } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const runtimeEnv = { ...process.env, VITE_MMT_E2E: "1" };

/**
 * Build the E2E production bundle, run one fixed Vite preview server, and invoke
 * the caller only after the server is ready.
 *
 * @param {() => void | Promise<void>} run
 * @param {{ shutdown: "signal" | "signal-then-kill" }} [options]
 * @returns {Promise<void>}
 */
export async function withProductionPreview(run, options = { shutdown: "signal" }) {
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

    await run();
  } finally {
    if (options.shutdown === "signal") {
      server.kill("SIGTERM");
    } else if (server.exitCode === null && server.signalCode === null) {
      const exited = new Promise((resolve) => server.once("exit", resolve));
      server.kill("SIGTERM");
      await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
      if (server.exitCode === null && server.signalCode === null) {
        server.kill("SIGKILL");
        await exited;
      }
    }
  }
}
