// UnionPay International — static daily JSON on the rate page's CDN.
//
// The old POST API is dead; the current page loads one immutable JSON file per
// calendar day containing the full 160x15 rate matrix (transaction currency ->
// base/account currency). Weekends exist; publication gaps (CN holidays) mean
// we walk back a few days when today's file 404s.

import { fetchJSON, cacheGet, cacheSet, ttlEndOfDayPlus } from "../net.js";
import { t } from "../i18n.js";

const BASE_LIST = ["AUD","CAD","CNY","EUR","GBP","HKD","HUF","JPY","MNT","MOP","NZD","SGD","THB","USD","VND"];

const TRANS_LIST = ["USD","AED","AFN","ALL","AMD","AOA","ARS","AUD","AWG","AZN","BAM","BBD","BDT","BGN","BHD","BIF","BMD","BND","BOB","BRL","BSD","BTN","BWP","BYN","BYR","BZD","CAD","CDF","CHF","CLP","CNY","COP","CRC","CUC","CUP","CVE","CZK","DJF","DKK","DOP","DZD","EGP","ERN","ETB","EUR","FJD","FKP","GBP","GEL","GHS","GIP","GMD","GNF","GTQ","GYD","HKD","HNL","HRK","HTG","HUF","IDR","ILS","INR","IQD","IRR","ISK","JMD","JOD","JPY","KES","KGS","KHR","KMF","KRW","KWD","KYD","KZT","LAK","LBP","LKR","LRD","LSL","LTL","LYD","MAD","MDL","MGA","MKD","MMK","MNT","MOP","MRO","MRU","MUR","MVR","MWK","MXN","MYR","MZN","NAD","NGN","NIO","NOK","NPR","NZD","OMR","PAB","PEN","PGK","PHP","PKR","PLN","PYG","QAR","RON","RSD","RUB","RWF","SAR","SBD","SCR","SDG","SEK","SGD","SHP","SLL","SOS","SRD","SSP","STD","STN","SVC","SYP","SZL","THB","TJS","TMT","TND","TOP","TRY","TTD","TWD","TZS","UAH","UGX","UYU","UZS","VEF","VES","VND","VUV","WST","XAF","XCD","XCG","XOF","XPF","YER","ZAR","ZMK","ZMW","ZWL"];

export function currencies() { return [...new Set([...TRANS_LIST, ...BASE_LIST])]; }

export function supports(from, to) { return currencies().includes(from) && currencies().includes(to); }

async function loadDay() {
  // Immutable per-day files: cache "which day worked + matrix" for 12h.
  const hit = cacheGet("up:today");
  if (hit) return { ...hit, via: "cache", cached: true };
  for (let back = 0; back < 15; back++) {
    const d = new Date(Date.now() - back * 86400000);
    const stamp = d.toISOString().slice(0, 10).replace(/-/g, "");
    try {
      const { json, via } = await fetchJSON("https://m.unionpayintl.com/jfimg/" + stamp + ".json");
      if (!json || !Array.isArray(json.exchangeRateJson) || !json.exchangeRateJson.length) throw new Error("up: bad payload");
      const data = { rows: json.exchangeRateJson, asOf: json.curDate || d.toISOString().slice(0, 10) };
      cacheSet("up:today", data, 12 * 3600 * 1000);
      return { ...data, via };
    } catch (e) { /* walk back a day */ }
  }
  throw new Error("up: no rate file");
}

export async function convert({ from, to, amount }) {
  const { rows, asOf, via, cached } = await loadDay();
  const map = new Map(rows.map(r => [r.transCur + "|" + r.baseCur, r.rateData]));
  let rate, kind, notes = [];
  if (map.has(from + "|" + to)) { rate = map.get(from + "|" + to); kind = "direct"; }
  else if (map.has(to + "|" + from)) { rate = 1 / map.get(to + "|" + from); kind = "inverse"; }
  else if (map.has(from + "|USD") && map.has(to + "|USD")) {
    rate = map.get(from + "|USD") / map.get(to + "|USD"); kind = "cross";
    notes.push(t("upCrossNote"));
  } else throw new Error("up: unsupported pair");
  return {
    provider: "unionpay",
    rate,                    // 1 FROM = rate TO
    converted: amount * rate,
    asOf,
    fee: null,
    kind,
    notes,
    via,
    cached: !!cached,
  };
}
