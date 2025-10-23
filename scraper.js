import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "fs";

const TARGET = process.env.TARGET_URL;               // set via Actions secret
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

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
});
await page.goto(TARGET, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector("text=WE BUY", { timeout: 60000 });

const lines = await page.$$eval("tr, li, div, span", els =>
  els.map(e => (e.innerText || "").replace(/\s+/g, " ").trim()).filter(Boolean)
);
const nums = s => (s.match(/(\d[\d\s,]*\.?\d*)/g) || [])
  .map(x => parseFloat(x.replace(/[,\s]/g, "")))
  .filter(n => !Number.isNaN(n));

const data = {};
for (const label of LABELS) {
  const row = lines.find(l => l.includes(label));
  if (!row) continue;
  const n = nums(row);
  let buy = null, sell = null;
  if (n.length >= 2) { buy = n[n.length-2]; sell = n[n.length-1]; if (buy === sell) sell = null; }
  else if (n.length === 1) { buy = n[0]; }
  data[label] = { buy, sell };
}

await browser.close();
mkdirSync("data", { recursive: true });
const out = { updated: Date.now(), data };
writeFileSync("data/quotes.json", JSON.stringify(out, null, 2), "utf8");
console.log("Saved data/quotes.json");
