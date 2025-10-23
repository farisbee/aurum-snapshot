// scraper.js (cell-based parser + sanity checks)
import { chromium, firefox, webkit } from "playwright";
import { writeFileSync, mkdirSync } from "fs";

const TARGET  = process.env.TARGET_URL;
const ENGINE  = (process.env.BROWSER || "firefox").toLowerCase(); // try firefox first
const BROWSERS = { chromium, firefox, webkit };

if (!TARGET) { console.error("Missing TARGET_URL"); process.exit(1); }
if (!BROWSERS[ENGINE]) { console.error("Unknown BROWSER"); process.exit(1); }

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

mkdirSync("debug", { recursive: true });

function toNum(s) {
  if (!s) return null;
  const m = String(s).match(/-?\d[\d\s,]*\.?\d*/);
  if (!m) return null;
  return parseFloat(m[0].replace(/[,\s]/g, ""));
}

function plausible(label, n) {
  if (n == null || Number.isNaN(n)) return false;
  if (/USD\/MYR/.test(label)) return n > 3 && n < 6.5;
  if (/GOLD OZ/.test(label)) return n > 1000 && n < 3500;
  if (/SILVER OZ/.test(label)) return n > 10 && n < 60;
  if (/1 KILO/.test(label)) return n > 100000 && n < 1000000;
  if (/100 GM/.test(label)) return n > 10000 && n < 100000;
  if (/50 GM/.test(label))  return n > 5000  && n < 60000;
  if (/1 TAEL/.test(label)) return n > 5000  && n < 60000;
  if (/SILVER : 1 GRAM/.test(label)) return n > 0.5 && n < 50;
  return true;
}

async function dump(page, note="") {
  try {
    writeFileSync("debug/content.html", await page.content(), "utf8");
    await page.screenshot({ path: "debug/page.png", fullPage: true }).catch(()=>{});
  } catch {}
  if (note) writeFileSync("debug/note.txt", note, "utf8");
}

(async () => {
  const browser = await BROWSERS[ENGINE].launch({
    headless: true,
    args: ["--no-sandbox","--disable-dev-shm-usage","--disable-blink-features=AutomationControlled"]
  });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    locale: "en-US",
    timezoneId: "Asia/Kuala_Lumpur",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    ignoreHTTPSErrors: true
  });
  await context.addInitScript(() => Object.defineProperty(navigator, "webdriver", { get: () => false }));
  const page = await context.newPage();
  page.setDefaultTimeout(150000);

  try {
    await page.goto(TARGET, { waitUntil: "domcontentloaded", timeout: 120000 });

    // consent buttons (best-effort)
    const tryClick = async sel => { try { const el = page.locator(sel).first(); if (await el.isVisible()) await el.click(); } catch {} };
    await tryClick('button:has-text("Accept")');
    await tryClick('button:has-text("I agree")');
    await tryClick('button:has-text("OK")');

    await page.waitForLoadState("networkidle").catch(()=>{});
    await page.waitForFunction(() => {
      const t = document.body?.innerText || "";
      return /WE\s*SELL/i.test(t) || /GOLD\s*:\s*1\s*KILO/i.test(t);
    }, { timeout: 120000 });

    // 1) Try real table rows first
    let rows = await page.evaluate(() => {
      const arr = [];
      document.querySelectorAll("table").forEach(t => {
        t.querySelectorAll("tr").forEach(tr => {
          const cells = Array.from(tr.children).map(td => (td.innerText || "").trim());
          if (cells.length >= 2) arr.push(cells);
        });
      });
      return arr;
    });

    // 2) Fallback to ARIA rows if no <table>
    if (!rows.length) {
      rows = await page.evaluate(() => {
        const arr = [];
        document.querySelectorAll('[role="row"]').forEach(r => {
          const cells = Array.from(r.querySelectorAll('[role="cell"], [role="gridcell"]')).map(
            c => (c.innerText || "").trim()
          );
          if (cells.length >= 2) arr.push(cells);
        });
        return arr;
      });
    }

    writeFileSync("debug/rows.json", JSON.stringify(rows, null, 2), "utf8");

    const data = {};
    for (const label of LABELS) {
      const r = rows.find(x => (x[0] || "").includes(label));
      if (!r) continue;

      // accept up to 3 cells after label (some rows may only have one number)
      const nums = r.slice(1).map(toNum).filter(v => v != null);
      let buy = null, sell = null;

      // choose last two plausible numbers; otherwise, first plausible
      const plausibleNums = nums.filter(n => plausible(label, n));
      if (plausibleNums.length >= 2) {
        buy  = plausibleNums[plausibleNums.length - 2];
        sell = plausibleNums[plausibleNums.length - 1];
      } else if (plausibleNums.length === 1) {
        buy = plausibleNums[0];
      } else if (nums.length) {
        // fallback if nothing passed plausibility (still better than nothing)
        buy = nums[0];
        sell = nums[1] ?? null;
      }

      data[label] = { buy, sell };
    }

    await dump(page, "after-parse");

    if (!Object.keys(data).length) {
      console.error("Parsed 0 rows — check debug/rows.json and debug/page.png");
      process.exit(2);
    }

    mkdirSync("data", { recursive: true });
    writeFileSync("data/quotes.json", JSON.stringify({ updated: Date.now(), data }, null, 2), "utf8");
    console.log("Saved data/quotes.json");
  } catch (e) {
    await dump(page, "error");
    console.error("SCRAPER_ERROR:", e);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
