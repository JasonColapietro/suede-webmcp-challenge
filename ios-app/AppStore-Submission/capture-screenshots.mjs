#!/usr/bin/env node
/** Raw App Store screenshot capture for Suede Agent Studio.
 *  Drives the LIVE site (what the iOS shell renders) at exact ASC pixel sizes:
 *  iPhone 6.9" 1320x2868 (440x956 @3x), iPad 13" 2048x2732 (1024x1366 @2x).
 *  Run: node capture-screenshots.mjs  (from AppStore-Submission/)
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = "https://agents.suedeai.ai";
const SHOTS = [
  ["01-studio", "/"],
  ["02-directory", "/agents"],
  ["03-agent-endpoint", "/a/the-ownership-loop-dwbjc"],
  ["04-flows", "/flows"],
  ["05-docs", "/docs"],
];

const TARGETS = [
  { dir: "iphone-69", viewport: { width: 440, height: 956 }, scale: 3, mobile: true,
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" },
  { dir: "ipad-13", viewport: { width: 1024, height: 1366 }, scale: 2, mobile: true,
    ua: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" },
];

const browser = await chromium.launch();
for (const t of TARGETS) {
  const out = `screenshots-raw/en-US/${t.dir}`;
  mkdirSync(out, { recursive: true });
  const ctx = await browser.newContext({
    viewport: t.viewport,
    deviceScaleFactor: t.scale,
    isMobile: t.mobile,
    hasTouch: t.mobile,
    userAgent: t.ua,
  });
  const page = await ctx.newPage();
  for (const [name, route] of SHOTS) {
    await page.goto(BASE + route, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${out}/${name}.png` });
    console.log(`${t.dir}/${name}.png`);
  }
  await ctx.close();
}
await browser.close();
