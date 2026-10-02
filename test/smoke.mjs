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

function offlineFetch(url) {
  const u = String(url);
  let body = null;
  if (u.includes("cmsapi/fx/rates")) body = VISA_SAMPLE;
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

// 1. boot state
check("tabs rendered", dom.window.document.querySelectorAll(".tab").length === 5);
check("visa tab active by default", dom.window.document.querySelector(".tab.visa").classList.contains("active"));
check("from select populated", $("sel-from").options.length > 50, $("sel-from").options.length + " options");
check("defaults USD->CNY", $("sel-from").value === "USD" && $("sel-to").value === "CNY");

// 2. Visa convert
$("btn-convert").click();
const okV = await sleepUntil(() => $("res-converted").textContent.match(/[\d,]+/) && !$("res-converted").textContent.includes("spin"));
await sleep(500);
console.log("   visa result:", $("res-converted").textContent, $("res-unit").textContent, "|", $("res-rate").textContent.slice(0, 40));
check("visa renders converted amount", okV && parseFloat($("res-converted").textContent.replace(/,/g, "")) > 600, $("res-converted").textContent);
check("visa badge set", $("res-provider").textContent === "Visa");
check("visa asof shown", $("res-asof").textContent.includes("汇率日期") || $("res-asof").textContent.includes("Rate date"), $("res-asof").textContent);

// 3. mastercard tab
dom.window.document.querySelector(".tab.mastercard").click();
$("sel-from").value = "USD"; $("sel-to").value = "CNY";
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
check("jcb defaults USD->JPY", $("sel-from").value === "USD" && $("sel-to").value === "JPY", $("sel-from").value + "->" + $("sel-to").value);
$("btn-convert").click();
const okJ = await sleepUntil(() => parseFloat($("res-converted").textContent.replace(/,/g, "")) > 15000 && !$("res-converted").textContent.includes("spin"));
await sleep(300);
console.log("   jcb result:", $("res-converted").textContent, $("res-unit").textContent);
check("jcb 100 USD -> ~15800 JPY", okJ, $("res-converted").textContent);

// 5. unionpay tab
dom.window.document.querySelector(".tab.unionpay").click();
$("sel-from").value = "USD"; $("sel-to").value = "CNY";
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
const f1 = $("sel-from").value, t1 = $("sel-to").value;
$("btn-swap").click();
check("swap exchanges currencies", $("sel-from").value === t1 && $("sel-to").value === f1);

console.log("\nSMOKE RESULT: " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
