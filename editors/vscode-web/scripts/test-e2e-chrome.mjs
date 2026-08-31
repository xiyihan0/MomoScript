import { spawnSync } from "node:child_process";
import { withProductionPreview } from "./production-preview-server.mjs";

const groups = [
  { name: "runtime export", tag: "@runtime-export", timeout: 8 * 60_000 },
  { name: "preview navigation", tag: "@preview-navigation", timeout: 8 * 60_000 },
  { name: "preview renderer smoke", tag: "@preview-renderer-smoke", timeout: 8 * 60_000 },
  // Restart Playwright after each full-WASM editor journey so a previous page cannot retain browser-side compiler state.
  { name: "editor runtime materialization", tag: "@editor-runtime-materialization", timeout: 8 * 60_000 },
  { name: "editor runtime notifications", tag: "@editor-runtime-notifications", timeout: 5 * 60_000 },
  { name: "editor runtime sashes", tag: "@editor-runtime-sashes", timeout: 5 * 60_000 },
  { name: "editor surfaces", tag: "@editor-surface", timeout: 10 * 60_000 },
  { name: "GUI Composer", tag: "@gui-composer", timeout: 10 * 60_000 },
  { name: "local history", tag: "@local-history", timeout: 12 * 60_000 },
];

await withProductionPreview(() => {
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
}, { shutdown: "signal" });
