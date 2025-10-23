import { chromium /* or: firefox, webkit */ } from "playwright";
import { writeFileSync, mkdirSync } from "fs";

const TARGET = process.env.TARGET_URL;
if (!TARGET) { console.error("Missing TARGET_URL"); process.exit(1); }

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

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled"
    ]
  });

  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    locale: "en-US",
    timezoneId: "Asia/Kuala_Lumpur",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });

  // Small stealth tweak
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  const page = await context.newPage();
  page.setDefaultTimeout(120000);

  // (Optional) skip heavy stuff
  await page.route("**/*", route => {
    const url = route.request().url();
    if (/\.(woff2?|ttf|eot)$/.test(url) || /googletag|gtag|analytics/i.test(url)) {
      return route.abort();
    }
    route.continue();
  });

  await page.goto(TARGET, { waitUntil: "domcontentloaded", timeout: 90000 });

  // Try to accept common cookie/consent
  const tryClick = async (sel) => {
    try { const el = page.locator(sel).first(); if (await el.isVisible()) await el.click(); } catch {}
  };
  await tryClick('button:has-text("Accept")');
  await tryClick('button:has-text("I agree")');
  await tryClick('button:has-text("OK")');

  // Wait until either the table labels OR header text is present in body text
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForFunction(() => {
    const t = (document.body && document.body.innerText) || "";
    return /GOLD\s*:\s*1\s*KILO/i.test(t) || /WE\s*BUY/i.test(t);
  }, { timeout: 120000 });

  // Collect body text lines and parse
  const lines = await page.evaluate(() =>
    Array.from(document.querySelectorAll("tr, li, div, span"))
      .map(e => (e.innerText || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
  );

  const parseNums = (s) =>
    (s.match(/(\d[\d\s,]*\.?\d*)/g) || [])
      .map(x => parseFloat(x.replace(/[,\s]/g, "")))
      .filter(n => !Number.isNaN(n));

  const data = {};
  for (const label of LABELS) {
    const row = lines.find(l => l.includes(label));
    if (!row) continue;
    const nums = parseNums(row);
    let buy = null, sell = null;
    if (nums.length >= 2) {
      buy = nums[nums.length - 2];
      sell = nums[nums.length - 1];
      if (buy === sell) sell = null; // some rows only show one value
    } else if (nums.length === 1) {
      buy = nums[0];
    }
    data[label] = { buy, sell };
  }

  // --- Debug dumps every run ---
  mkdirSync("debug", { recursive: true });
  writeFileSync("debug/content.html", await page.content(), "utf8");
  writeFileSync("debug/text.txt", await page.evaluate(() => document.body?.innerText || ""), "utf8");
  await page.screenshot({ path: "debug/page.png", fullPage: true });

  await browser.close();

  if (!Object.keys(data).length) {
    console.error("Parsed 0 rows. Check debug artifacts.");
    process.exit(2);
  }

  mkdirSync("data", { recursive: true });
  const out = { updated: Date.now(), data };
  writeFileSync("data/quotes.json", JSON.stringify(out, null, 2), "utf8");
  console.log("Saved data/quotes.json");
})();
