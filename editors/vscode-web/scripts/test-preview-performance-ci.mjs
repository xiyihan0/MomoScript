import { spawnSync } from "node:child_process";
import { withProductionPreview } from "./production-preview-server.mjs";

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

await withProductionPreview(() => {
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
}, { shutdown: "signal-then-kill" });
