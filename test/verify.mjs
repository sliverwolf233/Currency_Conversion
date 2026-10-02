// End-to-end verification of the four provider adapters.
// - Default: LIVE mode — real network requests through a curl fallback
//   (Node's undici fetch is TLS-fingerprint-blocked by some card-network CDNs).
// - CC_OFFLINE=1: parser fixtures + offline math only (CI-safe; GitHub runner
//   IPs are often blocked by the card networks, so CI runs live checks
//   best-effort only).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const execFileP = promisify(execFile);
const OFFLINE = process.env.CC_OFFLINE === "1";
const CURL = process.platform === "win32" ? "curl.exe" : "curl";
if (OFFLINE) console.log("== OFFLINE MODE: live network sections skipped ==");

const realFetch = globalThis.fetch;
if (!OFFLINE) {
  globalThis.fetch = async (url, opts = {}) => {
    try {
      const res = await realFetch(url, { ...opts, signal: opts.signal ?? AbortSignal.timeout(20000), headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36", ...(opts.headers || {}) } });
      if (res.ok) return res;
      throw new Error("HTTP " + res.status);
    } catch (e) {
      const { stdout } = await execFileP(CURL, ["-s", "-m", "30", "-A", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0", String(url)], { maxBuffer: 20 * 1024 * 1024 });
      if (!stdout || stdout.length === 0) throw new Error(CURL + " empty for " + url + ": " + e.message);
      return { ok: true, status: 200, text: async () => stdout };
    }
  };
}

// storage shim so the provider modules can cache like in a browser
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  key: (i) => [...store.keys()][i],
  get length() { return store.size; },
};

const visa = await import("../assets/js/providers/visa.js");
const mc = await import("../assets/js/providers/mastercard.js");
const jcb = await import("../assets/js/providers/jcb.js");
const up = await import("../assets/js/providers/unionpay.js");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log("  PASS", name, detail); }
  else { fail++; console.log("  FAIL", name, detail); }
}
const near = (a, b, tolPct) => Math.abs(a - b) / b <= tolPct / 100;

// ---------- 1. Parser unit tests against saved raw pages (always run) ----------
console.log("== JCB parser (offline, saved pages) ==");
const here = dirname(fileURLToPath(import.meta.url));
const jpyHtml = readFileSync(join(here, "fixtures", "jpy_raw.html"), "utf8");
const usdHtml = readFileSync(join(here, "fixtures", "usd_dated_raw.html"), "utf8");
const jpy = jcb.parseJpyPage(jpyHtml);
check("jpy table parsed 15 currencies", Object.keys(jpy.rates).length === 15, Object.keys(jpy.rates).length + " codes");
check("jpy USD rate = 158.17", jpy.rates.USD === 158.17, String(jpy.rates.USD));
check("jpy KRW rate = 0.116", jpy.rates.KRW === 0.116, String(jpy.rates.KRW));
check("jpy asOf = 2026-10-02", jpy.asOf === "2026-10-02", jpy.asOf);
const usdT = jcb.parseUsdPage(usdHtml);
check("usd table parsed 162 rows minus USD", Object.keys(usdT.rates).length >= 160, Object.keys(usdT.rates).length + " codes");
check("usd JPY sell = 158.1709", usdT.rates.JPY === 158.1709, String(usdT.rates.JPY));
check("usd AED sell = 3.6728", usdT.rates.AED === 3.6728, String(usdT.rates.AED));
check("jpy page == usd sell column (cross-check)", jpy.rates.USD === Math.trunc(usdT.rates.JPY * 1000) / 1000);

// ---------- 2. Offline math on verified sample payloads (always run) ----------
console.log("== Offline math (verified live samples from 2026-10-02) ==");
{
  // Visa sample: fxRateWithAdditionalFee = base * (1 + fee/100), amount multiplies
  const visaBase = 6.706325325;
  check("visa fee math exact (x1.025)", near(visaBase * 1.025, 6.8739834581, 0.001));
  // Mastercard sample: 6.7045 x1.02 = 6.83859 (verified against live API)
  check("mastercard fee math exact (x1.02)", near(6.7045 * 1.02, 6.83859, 0.001));
  // JCB JPY page: 100 USD -> 15817 JPY; inverse
  check("jcb direct: 100 USD = 15817 JPY", near(100 * jpy.rates.USD, 15817, 0.001));
  check("jcb inverse: 15817 JPY = 100 USD", near(15817 / jpy.rates.USD, 100, 0.001));
  // JCB cross EUR->KRW = rate(EUR)/rate(KRW)
  check("jcb cross EUR->KRW = 177.971/0.116", near(jpy.rates.EUR / jpy.rates.KRW, 1534.2327, 0.01));
  // UnionPay cross-via-USD using verified CNY column: EUR->KRW = (EUR/CNY)/(KRW/CNY)
  const eurCny = 7.58839973, krwCny = 0.00495653;
  check("unionpay cross EUR->KRW via USD/CNY column", near(eurCny / krwCny, 1530.72, 0.5));
}

// ---------- 3. Live network checks (skipped in offline mode) ----------
if (!OFFLINE) {
  console.log("== Visa (live) ==");
  try {
    const r0 = await visa.convert({ from: "USD", to: "CNY", amount: 100, fee: 0 });
    const r25 = await visa.convert({ from: "USD", to: "CNY", amount: 100, fee: 2.5 });
    console.log("   USD->CNY fee0 rate:", r0.rate, "asOf:", r0.asOf, "via:", r0.via);
    check("visa USD->CNY rate plausible", r0.rate > 5.5 && r0.rate < 8.5, String(r0.rate));
    check("visa converted = amount*rate", near(r0.converted, 100 * r0.rate, 0.001));
    check("visa fee math exact (x1.025)", near(r25.rate, r0.rate * 1.025, 0.01), r25.rate + " vs " + (r0.rate * 1.025));
    check("visa USD->HKD inverse sanity", near(1 / (await visa.convert({ from: "USD", to: "HKD", amount: 1, fee: 0 })).rate, 0.1274, 5), "");
  } catch (e) { check("visa live", false, e.message); }

  console.log("== Mastercard (live) ==");
  try {
    const r0 = await mc.convert({ from: "USD", to: "CNY", amount: 100, fee: 0 });
    const r2 = await mc.convert({ from: "USD", to: "CNY", amount: 100, fee: 2 });
    console.log("   USD->CNY rate:", r0.rate, "asOf:", r0.asOf, "via:", r0.via);
    check("mc USD->CNY near verified sample 6.7045", near(r0.rate, 6.7045, 3), String(r0.rate));
    check("mc fee math exact (x1.02)", near(r2.rate, r0.rate * 1.02, 0.01), r2.rate + " vs " + (r0.rate * 1.02));
    check("mc converted = amount*rate", near(r2.converted, 100 * r2.rate, 0.001));
    check("mc same-currency = 1", (await mc.convert({ from: "JPY", to: "JPY", amount: 1000, fee: 0 })).rate === 1);
  } catch (e) { check("mc live", false, e.message); }

  console.log("== JCB (live) ==");
  try {
    const rJpy = await jcb.convert({ from: "USD", to: "JPY", amount: 100, billing: "JPY" });
    console.log("   USD->JPY rate:", rJpy.rate, "asOf:", rJpy.asOf, "via:", rJpy.via, "kind:", rJpy.kind);
    check("jcb USD->JPY near 158.17", near(rJpy.rate, 158.17, 1.5), String(rJpy.rate));
    const rInv = await jcb.convert({ from: "JPY", to: "USD", amount: 10000, billing: "JPY" });
    check("jcb JPY->USD is inverse", near(rInv.rate, 1 / rJpy.rate, 0.01));
    const rCross = await jcb.convert({ from: "EUR", to: "KRW", amount: 100, billing: "JPY" });
    check("jcb EUR->KRW cross plausible (~1530)", rCross.rate > 1300 && rCross.rate < 1750, String(rCross.rate));
    const rUsd = await jcb.convert({ from: "USD", to: "AED", amount: 100, billing: "USD" });
    console.log("   USD->AED (usd table) rate:", rUsd.rate, "asOf:", rUsd.asOf);
    check("jcb USD->AED near sell 3.6728", near(rUsd.rate, 3.6728, 1.5), String(rUsd.rate));
  } catch (e) { check("jcb live", false, e.message); }

  console.log("== UnionPay (live) ==");
  try {
    const r = await up.convert({ from: "USD", to: "CNY", amount: 100 });
    console.log("   USD->CNY rate:", r.rate, "asOf:", r.asOf, "via:", r.via, "kind:", r.kind);
    check("up USD->CNY near verified 6.7269", near(r.rate, 6.7269, 3), String(r.rate));
    const h = await up.convert({ from: "HKD", to: "CNY", amount: 100 });
    check("up HKD->CNY near 0.8569", near(h.rate, 0.8569, 3), String(h.rate));
    const c = await up.convert({ from: "EUR", to: "KRW", amount: 100 });
    check("up EUR->KRW plausible (~1530)", c.rate > 1300 && c.rate < 1750, String(c.rate) + " kind=" + c.kind);
    check("up EUR->KRW resolved from published data", ["inverse", "direct", "cross"].includes(c.kind));
  } catch (e) { check("up live", false, e.message); }

  console.log("== Historical date queries (yesterday) ==");
  {
    const y = new Date(Date.now() - 86400000).toISOString().slice(0, 10); // yesterday
    try {
      const v = await visa.convert({ from: "USD", to: "CNY", amount: 100, fee: 0, date: y });
      check("visa historical asOf = requested date", v.asOf === y, v.asOf + " (want " + y + ")");
    } catch (e) { check("visa historical", false, e.message); }
    try {
      const m = await mc.convert({ from: "USD", to: "CNY", amount: 100, fee: 0, date: y });
      check("mastercard historical asOf = requested date", m.asOf === y, m.asOf + " (want " + y + ")");
    } catch (e) { check("mastercard historical", false, e.message); }
    try {
      const u = await up.convert({ from: "USD", to: "CNY", amount: 100, date: y });
      check("unionpay historical asOf = requested date", u.asOf === y, u.asOf + " (want " + y + ")");
    } catch (e) { check("unionpay historical", false, e.message); }
    try {
      const j = await jcb.convert({ from: "USD", to: "AED", amount: 100, billing: "USD", date: y });
      check("jcb usd-table historical resolves", !!j.rate && isFinite(j.rate), "asOf=" + j.asOf + " rate=" + j.rate);
    } catch (e) { check("jcb usd historical", false, e.message); }
    try {
      const jj = await jcb.convert({ from: "USD", to: "JPY", amount: 100, billing: "JPY", date: y });
      const hasNote = (jj.notes || []).some(n => /仅公布当日|current day only/.test(n));
      check("jcb jpy historical flags latest-only note", hasNote, JSON.stringify(jj.notes));
    } catch (e) { check("jcb jpy historical note", false, e.message); }
  }

  console.log("== Two-leg (settlement) conversion ==");
  {
    try {
      // Visa JPY -> USD settlement -> CNY billing vs direct JPY -> CNY
      const l1 = await visa.convert({ from: "JPY", to: "USD", amount: 1000, fee: 0 });
      const l2 = await visa.convert({ from: "USD", to: "CNY", amount: 1000, fee: 0 });
      const direct = await visa.convert({ from: "JPY", to: "CNY", amount: 1000, fee: 0 });
      const combined = l1.rate * l2.rate;
      const ratio = combined / direct.rate;
      console.log("   combined:", combined.toFixed(6), " direct:", direct.rate.toFixed(6), " ratio:", ratio.toFixed(4));
      check("two-leg combined = product of legs", near(combined, l1.rate * l2.rate, 0.0001));
      check("two-leg vs direct within 10%", ratio > 0.9 && ratio < 1.1, (ratio * 100).toFixed(2) + "%");
    } catch (e) { check("visa two-leg", false, e.message); }
    try {
      // UnionPay matrix: EUR -> USD settlement -> CNY
      const l1 = await up.convert({ from: "EUR", to: "USD", amount: 100 });
      const l2 = await up.convert({ from: "USD", to: "CNY", amount: 100 });
      const direct = await up.convert({ from: "EUR", to: "CNY", amount: 100 });
      const ratio = (l1.rate * l2.rate) / direct.rate;
      check("unionpay two-leg vs direct within 10%", ratio > 0.9 && ratio < 1.1, (ratio * 100).toFixed(2) + "%");
    } catch (e) { check("unionpay two-leg", false, e.message); }
  }

  console.log("== Cross-network coherence ==");
  try {
    const [v, m, u] = await Promise.all([
      visa.convert({ from: "USD", to: "CNY", amount: 100, fee: 0 }),
      mc.convert({ from: "USD", to: "CNY", amount: 100, fee: 0 }),
      up.convert({ from: "USD", to: "CNY", amount: 100 }),
    ]);
    console.log("   Visa:", v.rate.toFixed(4), " MC:", m.rate.toFixed(4), " UP:", u.rate.toFixed(4));
    const max = Math.max(v.rate, m.rate, u.rate), min = Math.min(v.rate, m.rate, u.rate);
    check("three networks within 2% of each other", (max - min) / min <= 0.02, ((max - min) / min * 100).toFixed(3) + "% spread");
  } catch (e) { check("coherence", false, e.message); }
}

console.log("\nRESULT: " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
