import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import puppeteer from "puppeteer-core";

import type { DigestData } from "./digest.js";
import { renderDigestHtml } from "./digest-html.js";

const CHROMIUM_PATHS = [
  "/snap/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
];

function findChromium(): string {
  for (const p of CHROMIUM_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error("Chromium not found — install chromium-browser for image/PDF generation");
}

async function launchBrowser() {
  return puppeteer.launch({
    executablePath: findChromium(),
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
  });
}

export async function generateDigestImage(data: DigestData): Promise<string> {
  const html = renderDigestHtml(data);
  const date = new Date().toISOString().slice(0, 10);
  const outPath = path.join(os.tmpdir(), `clawmonitor-digest-${date}.png`);

  const browser = await launchBrowser();

  try {
    const page = await browser.newPage();
    // Set viewport wide enough for the content, height will be determined by content
    await page.setViewport({ width: 700, height: 100 });
    await page.setContent(html, { waitUntil: "networkidle0" });

    // Get the actual content height
    const bodyHandle = await page.$("body");
    const boundingBox = await bodyHandle?.boundingBox();
    const contentHeight = Math.ceil(boundingBox?.height ?? 800);

    // Resize viewport to fit content, then screenshot
    await page.setViewport({ width: 700, height: contentHeight + 40 });

    await page.screenshot({
      path: outPath,
      type: "png",
      fullPage: true,
      omitBackground: false,
    });
  } finally {
    await browser.close();
  }

  return outPath;
}

export async function generateDigestPdf(data: DigestData): Promise<string> {
  const html = renderDigestHtml(data);
  const date = new Date().toISOString().slice(0, 10);
  const outPath = path.join(os.tmpdir(), `clawmonitor-digest-${date}.pdf`);

  const browser = await launchBrowser();

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    await page.pdf({
      path: outPath,
      format: "A4",
      margin: { top: "20px", right: "20px", bottom: "20px", left: "20px" },
      printBackground: true,
    });
  } finally {
    await browser.close();
  }

  return outPath;
}
