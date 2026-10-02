// JCB — static HTML rate pages on www.jcb.jp (no JSON API exists).
//
// Two published tables, one per card billing currency:
//  * JPY-billed cards  -> https://www.jcb.jp/rate/jpy.html
//      "基準レート": 1 foreign unit = R JPY, 15 currencies, current day only.
//  * USD-billed cards  -> https://www.jcb.jp/rate/usdMMDDYYYY.html
//      "Base rate": 1 USD = Buy/Mid/Sell counter-currency units (162 codes).
//
// Column choice: the JPY page's USD row (158.17) equals the USD table's JPY
// Sell column (158.1709) — JCB's own card base rate is the Sell column, so we
// use Sell for USD-billed conversions too. Non-base pairs (e.g. EUR->KRW) are
// cross rates, which JCB's own page note explicitly tells users to compute.
//
// Parsing is regex-based on purpose: the pages are server-rendered static HTML
// unchanged for a decade+, and regex keeps the module dependency-free and
// testable outside the browser (no DOMParser).

import { fetchText, cacheGet, cacheSet, ttlEndOfDayPlus } from "../net.js";
import { t } from "../i18n.js";

export const JPY_CURRENCIES = ["USD","EUR","GBP","HKD","CNY","SGD","AUD","KRW","THB","TWD","MYR","IDR","PHP","VND","CAD"];

// 162 codes appearing in the USD "Base rate" table
export const USD_CURRENCIES = ["AED","AFN","ALL","AMD","ANG","AOA","ARS","AUD","AWG","AZN","BAM","BBD","BDT","BGN","BHD","BIF","BMD","BND","BOB","BRL","BSD","BTN","BWP","BYN","BZD","CAD","CDF","CHF","CLP","CNY","COP","CRC","CUP","CVE","CZK","DJF","DKK","DOP","DZD","EEK","EGP","ERN","ETB","EUR","FJD","FKP","GBP","GEL","GHS","GIP","GMD","GNF","GTQ","GYD","HKD","HNL","HRK","HTG","HUF","IDR","ILS","INR","IQD","IRR","ISK","JMD","JOD","JPY","KES","KGS","KHR","KMF","KRW","KWD","KYD","KZT","LAK","LBP","LKR","LRD","LSL","LTL","LVL","LYD","MAD","MDL","MGA","MKD","MMK","MNT","MOP","MRU","MUR","MVR","MWK","MXN","MYR","MZN","NAD","NGN","NIO","NOK","NPR","NZD","OMR","PAB","PEN","PGK","PHP","PKR","PLN","PYG","QAR","RON","RSD","RUB","RWF","SAR","SBD","SCR","SDD","SDG","SEK","SGD","SHP","SLE","SLL","SOS","SRD","SSP","STN","SVC","SYP","SZL","THB","TJS","TMT","TND","TOP","TRY","TTD","TWD","TZS","UAH","UGX","USD","UYU","UZS","VES","VND","VUV","WST","XAF","XCD","XOF","XPF","YER","ZAR","ZMK","ZMW","ZWD","ZWL"];

export function currencies(billing) {
  return billing === "USD" ? USD_CURRENCIES : [...JPY_CURRENCIES, "JPY"];
}

export function supports(from, to, billing) {
  const list = currencies(billing);
  return list.includes(from) && list.includes(to);
}

export function parseJpyPage(html) {
  const dm = html.match(/(\d{4})年(\d{2})月(\d{2})日/);
  const asOf = dm ? dm[1] + "-" + dm[2] + "-" + dm[3] : "";
  const rowRe = /<tr>\s*<td>([A-Z]{3})<\/td>\s*<td>[^<]*<\/td>\s*<td>[^<]*<\/td>\s*<td>([\d.,]+)<\/td>\s*<td>JPY[^<]*<\/td>\s*<\/tr>/g;
  const rates = {};
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const val = parseFloat(m[2].replace(/,/g, ""));
    if (isFinite(val)) rates[m[1]] = val; // 1 foreign = val JPY
  }
  if (!Object.keys(rates).length) throw new Error("jcb: empty jpy table");
  return { rates, asOf };
}

export function parseUsdPage(html) {
  const dm = html.match(/Base rate for (\d{2})\/(\d{2})\/(\d{4})/);
  const asOf = dm ? dm[3] + "-" + dm[1] + "-" + dm[2] : "";
  const rowRe = /<tr class="(?:odd|even)">\s*<td[^>]*>\s*USD\s*<\/td>\s*<td[^>]*>\s*=\s*<\/td>\s*<td[^>]*>([\d.,\s]+)<\/td>\s*<td[^>]*>([\d.,\s]+)<\/td>\s*<td[^>]*>([\d.,\s]+)<\/td>\s*<td[^>]*>([A-Z]{3})\s*<\/td>/g;
  const rates = {};
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const sell = parseFloat(m[3].replace(/[\s,]/g, "")); // 1 USD = sell counter
    const code = m[4];
    if (isFinite(sell) && code !== "USD") rates[code] = sell;
  }
  if (!Object.keys(rates).length) throw new Error("jcb: empty usd table");
  return { rates, asOf };
}

async function loadTable(billing) {
  const dayKey = new Date().toISOString().slice(0, 10);
  const cacheKey = "jcb:" + billing + ":" + dayKey;
  const cached = cacheGet(cacheKey);
  if (cached) return { ...cached, cached: true, via: "cache" };
  if (billing === "USD") {
    // walk back from today until a dated page resolves (weekends/holidays)
    for (let back = 0; back < 7; back++) {
      const d = new Date(Date.now() - back * 86400000);
      const stamp = String(d.getUTCMonth() + 1).padStart(2, "0") + String(d.getUTCDate()).padStart(2, "0") + d.getUTCFullYear();
      try {
        const { text, via } = await fetchText("https://www.jcb.jp/rate/usd" + stamp + ".html");
        const parsed = parseUsdPage(text);
        cacheSet(cacheKey, parsed, ttlEndOfDayPlus(6));
        return { ...parsed, via };
      } catch (e) { /* try previous day */ }
    }
    throw new Error("jcb: no usd rate page");
  } else {
    const { text, via } = await fetchText("https://www.jcb.jp/rate/jpy.html");
    const parsed = parseJpyPage(text);
    cacheSet(cacheKey, parsed, ttlEndOfDayPlus(6));
    return { ...parsed, via };
  }
}

export async function convert({ from, to, amount, billing = "JPY" }) {
  const { rates, asOf, via, cached } = await loadTable(billing);
  let rate, kind, notes = [t("jcbSellNote")];
  if (billing === "USD") {
    if (from === "USD" && rates[to]) { rate = rates[to]; kind = "direct"; }
    else if (to === "USD" && rates[from]) { rate = 1 / rates[from]; kind = "inverse"; }
    else if (rates[from] && rates[to]) { rate = rates[to] / rates[from]; kind = "cross"; }
    else throw new Error("jcb: unsupported pair");
  } else {
    if (to === "JPY" && rates[from]) { rate = rates[from]; kind = "direct"; }
    else if (from === "JPY" && rates[to]) { rate = 1 / rates[to]; kind = "inverse"; }
    else if (rates[from] && rates[to]) { rate = rates[from] / rates[to]; kind = "cross"; }
    else throw new Error("jcb: unsupported pair");
  }
  if (kind === "cross") notes.push(t("jcbCrossNote"));
  return {
    provider: "jcb",
    billing,
    rate,
    converted: amount * rate,
    asOf,
    fee: null,
    kind,
    notes,
    via,
    cached: !!cached,
  };
}
