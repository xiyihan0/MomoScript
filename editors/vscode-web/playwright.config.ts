import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testIgnore: ["lifecycle.spec.ts", "pwa-offline.spec.ts"],
  fullyParallel: false,
  // CI runners cannot reliably compile two full Tinymist/Typst WASM stacks concurrently.
  workers: process.env.CI ? 1 : 2,
  timeout: 180_000,
  expect: { timeout: 120_000 },
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
  webServer: {
    command: "VITE_MMT_E2E=1 npm run build && npm run preview -- --host 127.0.0.1 --port 4173 --strictPort",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
    timeout: 240_000
  }
});
