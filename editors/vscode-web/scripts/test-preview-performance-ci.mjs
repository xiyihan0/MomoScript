import { spawn, spawnSync } from "node:child_process";

const tiers = {
  differential: [
    {
      name: "preview renderer differential",
      spec: "preview-renderer-differential.benchmark.spec.ts",
      reportDirectory: ".tmp/preview-performance/ci/differential",
      timeout: 15 * 60_000,
    },
  ],
  nightly: [
    {
      name: "preview performance planes",
      spec: "preview-performance-planes.benchmark.spec.ts",
      reportDirectory: ".tmp/preview-performance/ci/planes",
      timeout: 25 * 60_000,
    },
    {
      name: "preview renderer stress",
      spec: "preview-renderer-stress.benchmark.spec.ts",
      reportDirectory: ".tmp/preview-performance/ci/stress",
      timeout: 15 * 60_000,
    },
    {
      name: "preview performance qualification",
      spec: "preview-performance-qualification.benchmark.spec.ts",
      reportDirectory: ".tmp/preview-performance/ci/qualification",
      timeout: 45 * 60_000,
    },
  ],
};

const args = process.argv.slice(2);
const tier = args.length === 1 ? args[0] : undefined;
if (!tier || !Object.hasOwn(tiers, tier)) {
  console.error("usage: node ./scripts/test-preview-performance-ci.mjs <differential|nightly>");
  process.exit(2);
}

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

  for (const scenario of tiers[tier]) {
    console.log(`\n=== Preview performance: ${scenario.name} ===`);
    const env = {
      ...process.env,
      MMT_E2E_EXTERNAL_SERVER: "1",
      MMT_E2E_BENCHMARKS: "1",
      MMT_PREVIEW_REPORT_DIR: scenario.reportDirectory,
    };
    const result = spawnSync(
      process.execPath,
      [
        "node_modules/@playwright/test/cli.js",
        "test",
        "--project=local",
        "--workers=1",
        scenario.spec,
      ],
      { stdio: "inherit", env, timeout: scenario.timeout, killSignal: "SIGTERM" },
    );
    if (result.error) {
      throw new Error(`${scenario.name} did not complete within ${scenario.timeout / 60_000} minutes`, {
        cause: result.error,
      });
    }
    if (result.status !== 0) {
      throw new Error(`${scenario.name} failed with exit code ${result.status ?? 1}`);
    }
  }
} finally {
  if (server.exitCode === null && server.signalCode === null) {
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
