import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "lifecycle.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 45_000 },
  use: {
    baseURL: "http://127.0.0.1:4174",
    trace: "retain-on-failure",
    permissions: ["clipboard-read", "clipboard-write"],
    screenshot: "only-on-failure"
  },
  projects: [
    { name: "lifecycle", use: { ...devices["Desktop Chrome"], channel: "chrome" } }
  ],
  webServer: {
    command: "VITE_MMT_E2E=1 npm run dev -- --host 127.0.0.1 --port 4174 --strictPort",
    url: "http://127.0.0.1:4174",
    reuseExistingServer: false,
    timeout: 240_000
  }
});
