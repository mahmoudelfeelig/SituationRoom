import { chromium } from "@playwright/test";

const browser = await chromium.launch({
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.goto(process.argv[2] ?? "http://127.0.0.1:4173", { waitUntil: "networkidle" });
const report = await page.evaluate(() => ({
  document: { width: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth },
  roots: [document.documentElement, document.body, document.querySelector("#root"), document.querySelector(".decision-os")].map((element) => ({
    tag: element?.id || element?.className || element?.tagName,
    rect: element ? Math.round(element.getBoundingClientRect().width) : null,
    scrollWidth: element?.scrollWidth,
    clientWidth: element?.clientWidth,
    width: element ? getComputedStyle(element).width : null,
    minWidth: element ? getComputedStyle(element).minWidth : null,
    display: element ? getComputedStyle(element).display : null,
    overflowX: element ? getComputedStyle(element).overflowX : null,
  })),
  offenders: [...document.querySelectorAll("body *")]
    .map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        tag: element.tagName.toLowerCase(),
        className: typeof element.className === "string" ? element.className : "",
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        width: Math.round(rect.width),
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      };
    })
    .filter((entry) => entry.right > innerWidth + 2 || entry.left < -2)
    .sort((left, right) => right.right - left.right)
    .slice(0, 30),
}));
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
await browser.close();
