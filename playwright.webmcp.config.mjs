import { defineConfig } from "@playwright/test";

const externalBaseUrl = process.env.SITUATION_ROOM_BASE_URL;
const baseURL = externalBaseUrl ?? "http://127.0.0.1:4192";

export default defineConfig({
  testDir: "./tests",
  testMatch: "webmcp-browser.spec.mjs",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  ...(externalBaseUrl ? {} : {
    webServer: {
      command: "node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4192",
      url: baseURL,
      reuseExistingServer: true,
      timeout: 30_000,
    },
  }),
  use: {
    baseURL,
    viewport: { width: 1280, height: 900 },
    launchOptions: {
      args: ["--enable-features=WebMCP"],
    },
  },
  projects: [
    {
      name: "chrome-webmcp",
      use: {
        launchOptions: {
          executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          args: ["--enable-features=WebMCP"],
        },
      },
    },
    {
      name: "edge-webmcp",
      use: {
        launchOptions: {
          executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          args: ["--enable-features=WebMCP"],
        },
      },
    },
  ],
});
