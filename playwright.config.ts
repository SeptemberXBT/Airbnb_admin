import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3100";

export default defineConfig({
  testDir: "./e2e",
  use: { baseURL, trace: "on-first-retry" },
  webServer: {
    command: process.env.PLAYWRIGHT_WEB_SERVER_COMMAND ?? "npm run dev -- --hostname 127.0.0.1 --port 3100",
    env: { DEMO_MODE: process.env.DEMO_MODE ?? "true" },
    url: `${baseURL}/login`,
    reuseExistingServer: false,
  },
  projects: [
    { name: "mobile", use: { ...devices["iPhone 13"], browserName: "chromium" } },
    { name: "tablet", use: { viewport: { width: 768, height: 1024 } } },
    { name: "desktop", use: { viewport: { width: 1440, height: 900 } } },
  ],
});
