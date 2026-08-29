import { defineConfig } from "@playwright/test";

const externalBaseUrl = process.env.SITUATION_ROOM_BASE_URL;
const baseURL = externalBaseUrl ?? "http://127.0.0.1:4173";

export default defineConfig({
  testDir: "./tests",
  testMatch: "black-box-ui.spec.mjs",
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["json", { outputFile: "test-artifacts/playwright-results.json" }]],
  ...(externalBaseUrl ? {} : {
    webServer: {
      command: "node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4173",
      url: baseURL,
      reuseExistingServer: true,
      timeout: 30_000,
    },
  }),
  use: {
    baseURL,
    viewport: { width: 1440, height: 1024 },
    deviceScaleFactor: 1,
    colorScheme: "light",
    reducedMotion: "no-preference",
  },
  projects: [
    {
      name: "chrome",
      use: {
        launchOptions: {
          executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        },
      },
    },
    {
      name: "edge",
      use: {
        launchOptions: {
          executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        },
      },
    },
  ],
});
