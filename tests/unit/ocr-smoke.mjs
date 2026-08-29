import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { parseImportInputs } from "../../src/import/index.js";

const browser = await chromium.launch({
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
});
let image;
try {
  const page = await browser.newPage({ viewport: { width: 760, height: 220 }, deviceScaleFactor: 1 });
  await page.setContent(`
    <style>
      body { margin: 0; background: white; color: black; font: 700 54px Arial, sans-serif; }
      div { padding: 70px 24px 0; white-space: nowrap; }
    </style>
    <div>SITUATION ROOM 2040</div>
  `);
  image = await page.screenshot({ type: "png" });
} finally {
  await browser.close();
}

const parsed = await parseImportInputs(
  [{ name: "ocr-smoke.png", type: "image/png", bytes: new Uint8Array(image) }],
  { importId: "import:ocr-smoke" },
);
const text = parsed.documents[0].blocks.map((block) => block.text).join(" ").toUpperCase();
assert.match(text, /SITUATION\s+ROOM\s+2040/);
assert.equal(parsed.documents[0].diagnostics.some((entry) => entry.code === "OCR_REQUIRES_REVIEW"), true);
console.log("OCR smoke passed", { text, blocks: parsed.documents[0].blocks.length });
