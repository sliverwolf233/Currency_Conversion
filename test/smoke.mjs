// Headless UI smoke test: boot the real page in jsdom, click through every
// provider tab and compare mode, verify rendering.
//
// Modes:
//   node test/smoke.mjs            live mode (real card-network APIs via curl fallback)
//   CC_OFFLINE=1 node test/smoke.mjs   offline mode — fetch is stubbed with the
//                                  verified live samples captured 2026-10-02, so the
//                                  full UI flow is exercised deterministically (CI-safe).
//
// Needs Node 18+ and jsdom:  mkdir _smoke_env && cd _smoke_env && npm i jsdom@24
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileP = promisify(execFile);

const OFFLINE = process.env.CC_OFFLINE === "1";
const CURL = process.platform === "win32" ? "curl.exe" : "curl";
const here = dirname(fileURLToPath(import.meta.url));

const html = readFileSync(join(here, "..", "index.html"), "utf8");
const dom = new JSDOM(html, { url: "https://sliverwolf233.github.io/Currency_Conversion/", pretendToBeVisual: true });

// ---- offline stubs: verified live payloads captured 2026-10-02 ----
const jpyFixture = readFileSync(join(here, "fixtures", "jpy_raw.html"), "utf8");
const VISA_SAMPLE = JSON.stringify({
  status: "success",
  conversionAmountValue: "100",
  convertedAmount: "670.6325325",
  fxRateWithAdditionalFee: "6.706325325",
  originalValues: { asOfDate: 1790899200 },
});
// same shape for a historical query (asOfDate = 2026-10-01T00:00Z = 1790812800)
const VISA_SAMPLE_HIST = JSON.stringify({
  status: "success",
  convertedAmount: "671.2345000",
  fxRateWithAdditionalFee: "6.712345",
  originalValues: { asOfDate: 1790812800 },
});
const MC_SAMPLE = JSON.stringify({ data: { conversionRate: "6.7045000", crdhldBillAmt: "670.4500000", crdhldBillCurr: "CNY", fxDate: "2026-10-01", transAmt: "100", transCurr: "USD" } });
const UP_SAMPLE = JSON.stringify({
  exchangeRateJson: [
    { transCur: "USD", baseCur: "CNY", rateData: 6.7269 },
    { transCur: "HKD", baseCur: "CNY", rateData: 0.8569 },
    { transCur: "EUR", baseCur: "CNY", rateData: 7.58839973 },
    { transCur: "KRW", baseCur: "CNY", rateData: 0.00495653 },
    { transCur: "CNY", baseCur: "USD", rateData: 0.148879 },
    { transCur: "JPY", baseCur: "USD", rateData: 0.0063415 },
  ],
  curDate: "2026-10-02",
});

function utcToday() {
  const d = new Date();
  return String(d.getUTCMonth() + 1).padStart(2, "0") + "/" + String(d.getUTCDate()).padStart(2, "0") + "/" + d.getUTCFullYear();
}

function offlineFetch(url) {
  const u = String(url);
  let body = null;
  if (u.includes("cmsapi/fx/rates")) {
    // a historical request carries utcConvertedDate=MM/DD/YYYY; params arrive %-encoded
    const dec = decodeURIComponent(u);
    const m = dec.match(/utcConvertedDate=(\d{2}\/\d{2}\/\d{4})/);
    body = m && m[1] !== utcToday() ? VISA_SAMPLE_HIST : VISA_SAMPLE;
  }
  else if (u.includes("conversion-rates")) body = MC_SAMPLE;
  else if (u.includes("jfimg")) body = UP_SAMPLE;
  else if (u.includes("jcb.jp/rate/jpy")) body = jpyFixture;
  else if (u.includes("jcb.jp/rate/usd")) body = readFileSync(join(here, "fixtures", "usd_dated_raw.html"), "utf8");
  if (body === null) return Promise.reject(new Error("offline stub: no sample for " + u));
  return Promise.resolve({ ok: true, status: 200, text: async () => body });
}

// ---- live fetch with curl fallback ----
const realFetch = globalThis.fetch;
const liveFetch = async (url, opts = {}) => {
  try {
    const res = await realFetch(url, { ...opts, signal: opts.signal ?? AbortSignal.timeout(20000), headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36", ...(opts.headers || {}) } });
    if (res.ok) return res;
    throw new Error("HTTP " + res.status);
  } catch (e) {
    const { stdout } = await execFileP(CURL, ["-s", "-m", "30", "-A", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0", String(url)], { maxBuffer: 20 * 1024 * 1024 });
    if (!stdout) throw new Error(CURL + " empty: " + e.message);
    return { ok: true, status: 200, text: async () => stdout };
  }
};
globalThis.fetch = OFFLINE ? offlineFetch : liveFetch;

globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.window = dom.window;
globalThis.DOMParser = dom.window.DOMParser;
globalThis.AbortController = dom.window.AbortController;
dom.window.fetch = globalThis.fetch;
if (!globalThis.requestAnimationFrame) globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 16);

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => cond ? (pass++, console.log("  PASS", name, detail)) : (fail++, console.log("  FAIL", name, detail));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sleepUntil = async (fn, ms = 90000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(300); } return false; };

console.log(OFFLINE ? "== SMOKE (offline stubs) ==" : "== SMOKE (live) ==");
await import("file://" + join(here, "..", "assets", "js", "app.js").replace(/\\/g, "/"));
const $ = (id) => dom.window.document.getElementById(id);

// drive the searchable currency picker like a user: open, type, pick
function pickCurrency(hostId, code) {
  const host = $(hostId);
  host.querySelector(".cpicker-btn").click();
  const search = host.querySelector(".cpicker-search");
  search.value = code;
  search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  const opt = [...host.querySelectorAll(".cpicker-option")].find(o => o.dataset.code === code);
  if (!opt) throw new Error("picker option not found: " + code);
  opt.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
}
function pickerLabel(hostId) { return $(hostId).querySelector(".cpicker-value").textContent; }

// 1. boot state
check("tabs rendered", dom.window.document.querySelectorAll(".tab").length === 5);
check("visa tab active by default", dom.window.document.querySelector(".tab.visa").classList.contains("active"));
check("from picker rendered", pickerLabel("pick-from").startsWith("USD"), pickerLabel("pick-from"));
check("defaults USD->CNY", pickerLabel("pick-from").startsWith("USD") && pickerLabel("pick-to").startsWith("CNY"));

// 1b. searchable picker behaviour (Apple HIG combobox)
{
  const host = $("pick-from");
  const btn = host.querySelector(".cpicker-btn");
  btn.click();
  const pop = host.querySelector(".cpicker-pop");
  check("picker opens on click", !pop.classList.contains("hidden") && btn.getAttribute("aria-expanded") === "true");
  const search = host.querySelector(".cpicker-search");
  const allCount = host.querySelectorAll(".cpicker-option").length;
  check("picker lists many currencies", allCount > 50, allCount + " options");
  search.value = "HKD";
  search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  const filtered = host.querySelectorAll(".cpicker-option");
  check("search filters the list", filtered.length >= 1 && filtered.length < 10, filtered.length + " match");
  check("match highlighted with mark", !!host.querySelector(".cpicker-option mark"));
  search.value = "ZZZZ";
  search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  check("no-match shows empty state", !host.querySelector(".cpicker-empty").classList.contains("hidden"));
  search.value = "JPY";
  search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  search.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  check("keyboard nav marks active option", !!host.querySelector(".cpicker-option.active"));
  search.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  check("Enter picks the currency", pickerLabel("pick-from").startsWith("JPY"), pickerLabel("pick-from"));
  check("picker closes after pick", pop.classList.contains("hidden") && btn.getAttribute("aria-expanded") === "false");
  btn.click();
  search.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  check("Esc closes the popover", pop.classList.contains("hidden"));
  pickCurrency("pick-from", "USD"); // restore
}

// 2. Visa convert
$("btn-convert").click();
const okV = await sleepUntil(() => $("res-converted").textContent.match(/[\d,]+/) && !$("res-converted").textContent.includes("spin"));
await sleep(500);
console.log("   visa result:", $("res-converted").textContent, $("res-unit").textContent, "|", $("res-rate").textContent.slice(0, 40));
check("visa renders converted amount", okV && parseFloat($("res-converted").textContent.replace(/,/g, "")) > 600, $("res-converted").textContent);
check("visa badge set", $("res-provider").textContent === "Visa");
check("visa asof shown", $("res-asof").textContent.includes("汇率日期") || $("res-asof").textContent.includes("Rate date"), $("res-asof").textContent);

// 2b. historical date flow (visa): pick a fixed past date, expect its asOf
$("inp-date").value = "2026-10-01";
$("btn-convert").click();
const okH = await sleepUntil(() => $("res-asof").textContent.includes("2026-10-01") && !$("res-converted").textContent.includes("spin"));
await sleep(400);
console.log("   visa hist asof:", $("res-asof").textContent, "| amount:", $("res-converted").textContent);
check("visa historical date reflected in asOf", okH, $("res-asof").textContent);
check("visa historical amount rendered", parseFloat($("res-converted").textContent.replace(/,/g, "")) > 600);
$("inp-date").value = ""; // clear back to latest

// 2c. JCB + historical date shows the latest-only note
dom.window.document.querySelector(".tab.jcb").click();
await sleep(200);
$("inp-date").value = "2026-10-01";
$("btn-convert").click();
await sleepUntil(() => !$("res-converted").textContent.includes("spin") && parseFloat($("res-converted").textContent.replace(/,/g, "")) > 15000, 30000);
await sleep(400);
const jcbNotes = $("res-notes").textContent;
check("jcb historical shows latest-only note", /仅公布当日|current day only/.test(jcbNotes), jcbNotes.slice(0, 60));
$("inp-date").value = "";
dom.window.document.querySelector(".tab.visa").click();

// 2d. two-leg conversion via settlement currency (visa, offline stubs)
{
  pickCurrency("pick-from", "JPY");
  pickCurrency("pick-to", "CNY");
  pickCurrency("pick-settle", "USD");
  $("btn-convert").click();
  const okL = await sleepUntil(() => !$("res-converted").textContent.includes("spin") && parseFloat($("res-converted").textContent.replace(/,/g, "")) > 0);
  await sleep(400);
  const legsTxt = $("res-legs").textContent;
  console.log("   two-leg:", $("res-converted").textContent, "|", legsTxt.slice(0, 80));
  check("two-leg renders both legs detail", legsTxt.includes("1") && $("res-legs").textContent.length > 10, legsTxt.slice(0, 50));
  check("two-leg combined amount rendered", okL, $("res-converted").textContent);
  pickCurrency("pick-settle", ""); // back to direct
  pickCurrency("pick-from", "USD");
}

// 3. mastercard tab
dom.window.document.querySelector(".tab.mastercard").click();
pickCurrency("pick-from", "USD"); pickCurrency("pick-to", "CNY");
$("btn-convert").click();
const okM = await sleepUntil(() => parseFloat($("res-converted").textContent.replace(/,/g, "")) > 600 && !$("res-converted").textContent.includes("spin"));
await sleep(300);
console.log("   mc result:", $("res-converted").textContent);
check("mastercard renders", okM, $("res-converted").textContent);
check("mc badge set", $("res-provider").textContent === "Mastercard");

// 4. jcb tab (JPY billing default)
dom.window.document.querySelector(".tab.jcb").click();
await sleep(200);
check("jcb billing selector visible", !$("sel-jcb-billing").closest(".field").classList.contains("hidden"));
check("jcb defaults USD->JPY", pickerLabel("pick-from").startsWith("USD") && pickerLabel("pick-to").startsWith("JPY"), pickerLabel("pick-from") + "->" + pickerLabel("pick-to"));
$("btn-convert").click();
const okJ = await sleepUntil(() => parseFloat($("res-converted").textContent.replace(/,/g, "")) > 15000 && !$("res-converted").textContent.includes("spin"));
await sleep(300);
console.log("   jcb result:", $("res-converted").textContent, $("res-unit").textContent);
check("jcb 100 USD -> ~15800 JPY", okJ, $("res-converted").textContent);

// 5. unionpay tab
dom.window.document.querySelector(".tab.unionpay").click();
pickCurrency("pick-from", "USD"); pickCurrency("pick-to", "CNY");
$("btn-convert").click();
const okU = await sleepUntil(() => parseFloat($("res-converted").textContent.replace(/,/g, "")) > 600 && !$("res-converted").textContent.includes("spin"));
await sleep(300);
console.log("   up result:", $("res-converted").textContent);
check("unionpay renders", okU, $("res-converted").textContent);
check("up badge set", $("res-provider").textContent === "银联 UnionPay" || $("res-provider").textContent === "UnionPay");

// 6. compare mode (tab switch auto-runs the comparison)
dom.window.document.querySelector(".tab.compare").click();
await sleepUntil(() => dom.window.document.querySelectorAll(".compare-row").length === 4, 30000);
check("compare card visible", !$("compare-card").classList.contains("hidden"));
check("compare has 4 rows", dom.window.document.querySelectorAll(".compare-row").length === 4);
await sleepUntil(() => [...dom.window.document.querySelectorAll(".compare-conv")].every(el => el.textContent !== ""), 120000);
await sleep(800);
const rows = [...dom.window.document.querySelectorAll(".compare-row")].map(r => ({
  org: r.querySelector(".compare-org").textContent,
  rate: r.querySelector(".compare-rate").textContent.slice(0, 32),
  conv: r.querySelector(".compare-conv").textContent,
}));
rows.forEach(r => console.log("   ", r.org, "|", r.rate, "|", r.conv));
const succeeded = rows.filter(r => /[\d,]/.test(r.conv) && r.conv !== "—").length;
check("compare rendered >= 3 networks with numbers", succeeded >= 3, succeeded + "/4");

// 7. language toggle
$("btn-lang").click();
await sleep(200);
check("lang toggled to EN title", dom.window.document.querySelector("h1").textContent === "Card Network Rate Converter", dom.window.document.querySelector("h1").textContent);
$("btn-lang").click();
await sleep(200);
check("lang toggled back to zh", dom.window.document.querySelector("h1").textContent === "四大卡组织汇率换算器");

// 8. swap button
const f1 = pickerLabel("pick-from"), t1 = pickerLabel("pick-to");
$("btn-swap").click();
await sleep(300);
check("swap exchanges currencies", pickerLabel("pick-from") === t1 && pickerLabel("pick-to") === f1);

console.log("\nSMOKE RESULT: " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
