import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const MODES = Object.freeze({
  presentation: {
    config: "tests/presentation.playwright.config.mjs",
    environmentKey: "SITUATION_ROOM_PRESENTATION_BASE_URL",
  },
  ui: {
    config: "playwright.config.mjs",
    environmentKey: "SITUATION_ROOM_BASE_URL",
  },
  webmcp: {
    config: "playwright.webmcp.config.mjs",
    environmentKey: "SITUATION_ROOM_BASE_URL",
  },
});

const mode = process.argv[2];
const selected = MODES[mode];
if (!selected) {
  throw new Error(`Choose one browser-test mode: ${Object.keys(MODES).join(", ")}.`);
}

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const playwrightCli = fileURLToPath(new URL("../node_modules/@playwright/test/cli.js", import.meta.url));
const server = await createServer({
  root: projectRoot,
  logLevel: "warn",
  server: {
    host: "127.0.0.1",
    port: 0,
    strictPort: false,
  },
});

let child = null;
try {
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Vite did not expose a local TCP address.");
  const baseURL = `http://127.0.0.1:${address.port}`;
  child = spawn(
    process.execPath,
    [playwrightCli, "test", `--config=${selected.config}`],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        [selected.environmentKey]: baseURL,
      },
      stdio: "inherit",
      windowsHide: true,
    },
  );
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`Playwright ended after signal ${signal}.`));
      else resolve(code ?? 1);
    });
  });
  if (exitCode !== 0) process.exitCode = exitCode;
} finally {
  child?.removeAllListeners();
  await server.close();
}
