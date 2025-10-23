// scraper.js
import { chromium, firefox, webkit } from "playwright";
import { writeFileSync, mkdirSync } from "fs";

const TARGET  = process.env.TARGET_URL;
const ENGINE  = (process.env.BROWSER || "firefox").toLowerCase(); // try firefox first
const BROWSERS = { chromium, firefox, webkit };
if (!TARGET) { console.error("Missing TARGET_URL env"); process.exit(1); }
if (!BROWSERS[ENGINE]) { console.error("Unknown BROWSER engine"); process.exit(1); }

const LABELS = [
  "GOLD : 1 KILO 999.9 (MYR)",
  "GOLD : 100 GM 999.9 (MYR)",
  "GOLD : 50 GM 999.9 (MYR)",
  "GOLD : 1 TAEL 999.9 (MYR)",
  "SCRAP GOLD IN FINE WEIGHT OF 1KG",
  "SILVER : 1 GRAM 999.0 (MYR)",
  "GOLD OZ",
  "SILVER OZ",
  "USD/MYR"
];

let browser, context, page;
mkdirSync("debug", { recursive: true });

async function dumpDebug(note = "") {
  try {
    const content = page ? await page.content() : "<no page>";
    const inner   = page ? await page.evaluate(() => document.body?.innerText || "") : "<no page>";
    writeFileSync("debug/content.html", content, "utf8");
    writeFileSync("debug/text.txt", (note ? note + "\n\n" : "") + inner, "utf8");
    if (page) await page.screenshot({ path: "debug/page.png", fullPage: true }).catch(()=>{});
  } catch (e) {
    writeFileSync("debug/text.txt", (note ? note + "\n\n" : "") + "debug failed: " + e, "utf8");
  }
}

function extractNums(s){
  return (s.match(/(\d[\d\s,]*\.?\d*)/g) || [])
    .map(x => parseFloat(x.replace(/[,\s]/g, "")))
    .filter(n => !Number.isNaN(n));
}

(async () => {
  try {
    browser = await BROWSERS[ENGINE].launch({
      headless: true,
      args: ["--no-sandbox","--disable-dev-shm-usage","--disable-blink-features=AutomationControlled"]
    });

    context = await browser.newContext({
      viewport: { width: 1366, height: 900 },
      locale: "en-US",
      timezoneId: "Asia/Kuala_Lumpur",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      ignoreHTTPSErrors: true
    });
    await context.addInitScript(() => Object.defineProperty(navigator, "webdriver", { get: () => false }));

    page = await context.newPage();
    page.setDefaultTimeout(150000);

    await page.goto(TARGET, { waitUntil: "domcontentloaded", timeout: 120000 });

    // Try dismiss typical consent overlays
    const tryClick = async (sel) => { try { const el = page.locator(sel).first(); if (await el.isVisible()) await el.click(); } catch {} };
    await tryClick('button:has-text("Accept")');
    await tryClick('button:has-text("I agree")');
    await tryClick('button:has-text("OK")');

    // Give the app breathing room, scroll a bit (some SPAs lazy-load)
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight/3));
    await page.waitForTimeout(3000);

    // Wait until *either* key header or a known label shows up anywhere in body text
    await page.waitForFunction(() => {
      const t = (document.body && document.body.innerText) || "";
      return /WE\s*BUY/i.test(t) || /GOLD\s*:\s*1\s*KILO/i.test(t);
    }, { timeout: 120000 });

    // Gather text lines and parse
    const lines = await page.evaluate(() =>
      Array.from(document.querySelectorAll("tr, li, div, span"))
        .map(el => (el.innerText || "").replace(/\s+/g, " ").trim())
        .filter(Boolean)
    );

    const data = {};
    for (const label of LABELS) {
      const row = lines.find(l => l.includes(label));
      if (!row) continue;
      const nums = extractNums(row);
      let buy = null, sell = null;
      if (nums.length >= 2) { buy = nums[nums.length-2]; sell = nums[nums.length-1]; if (buy === sell) sell = null; }
      else if (nums.length === 1) { buy = nums[0]; }
      data[label] = { buy, sell };
    }

    await dumpDebug("After parse");

    if (!Object.keys(data).length) {
      console.error("Parsed 0 rows — check debug artifacts for Cloudflare/challenge/overlay.");
      process.exit(2);
    }

    mkdirSync("data", { recursive: true });
    const out = { updated: Date.now(), data };
    writeFileSync("data/quotes.json", JSON.stringify(out, null, 2), "utf8");
    console.log("Saved data/quotes.json");
  } catch (err) {
    console.error("SCRAPER_ERROR:", err);
    await dumpDebug("Error path");
    process.exit(1);
  } finally {
    await browser?.close();
  }
})();
