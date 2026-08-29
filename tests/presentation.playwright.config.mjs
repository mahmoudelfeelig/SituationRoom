import { defineConfig } from "@playwright/test";

const externalBaseUrl = process.env.SITUATION_ROOM_PRESENTATION_BASE_URL;
const baseURL = externalBaseUrl ?? "http://127.0.0.1:4185";

export default defineConfig({
  testDir: ".",
  testMatch: "presentation-browser.spec.mjs",
  timeout: 45_000,
  expect: { timeout: 8_000 },
  workers: 1,
  reporter: "list",
  ...(externalBaseUrl ? {} : {
    webServer: {
      command: "node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4185",
      cwd: "..",
      url: `${baseURL}/tests/presentation-preview.html`,
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
    launchOptions: {
      executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    },
  },
});
