import { defineConfig, devices } from "@playwright/test";

const groupedChromeRun = process.env.MMT_E2E_CHROME_GROUP === "1";

export default defineConfig({
  testDir: "./e2e",
  testIgnore: ["lifecycle.spec.ts", "pwa-offline.spec.ts"],
  fullyParallel: false,
  // Bound each browser process to a subset of the full-WASM journeys to avoid long-run compiler buildup.
  workers: groupedChromeRun ? 1 : 2,
  retries: groupedChromeRun && process.env.CI ? 1 : 0,
  timeout: groupedChromeRun ? 240_000 : 600_000,
  expect: { timeout: groupedChromeRun ? 90_000 : 300_000 },
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    permissions: ["clipboard-read", "clipboard-write"],
    screenshot: "only-on-failure"
  },
  projects: [
    { name: "local", use: { ...devices["Desktop Chrome"] } },
    { name: "chrome", use: { ...devices["Desktop Chrome"], channel: "chrome" } },
    { name: "remote", use: { ...devices["Desktop Chrome"] } }
  ],
  webServer: process.env.MMT_E2E_EXTERNAL_SERVER ? undefined : {
    command: "VITE_MMT_E2E=1 npm run build && npm run preview -- --host 127.0.0.1 --port 4173 --strictPort",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
    timeout: 240_000
  }
});
