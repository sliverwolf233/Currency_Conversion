// Visa — official anonymous rate API used by visa.com's own calculator
// (GET /cmsapi/fx/rates on any regional Visa host).
//
// Direction gotcha (verified against the live site): amount is denominated in
// toCurr and convertedAmount comes back in fromCurr, so to convert FROM->TO we
// must call fromCurr=TO, toCurr=FROM. Dates are MM/DD/YYYY. All six params are
// required or the API answers 400.

import { fetchJSON, cacheGet, cacheSet, ttlEndOfDayPlus } from "../net.js";

const HOST = "https://www.visa.com.hk";
const API = HOST + "/cmsapi/fx/rates";

// Visa's calculator currency list (168 codes, incl. legacy ones that still quote)
export const CURRENCIES = ["AED","AFN","ALL","AMD","AOA","ARS","AUD","AWG","AZN","BAM","BBD","BDT","BGN","BHD","BIF","BMD","BND","BOB","BRL","BSD","BTN","BWP","BYN","BZD","CAD","CDF","CHF","CLP","CNY","COP","CRC","CVE","CYP","CZK","DJF","DKK","DOP","DZD","EEK","EGP","ERN","ETB","EUR","FJD","FKP","GBP","GEL","GHS","GIP","GMD","GNF","GQE","GTQ","GWP","GYD","HKD","HNL","HRK","HTG","HUF","IDR","ILS","INR","IQD","IRR","ISK","JMD","JOD","JPY","KES","KGS","KHR","KMF","KRW","KWD","KYD","KZT","LAK","LBP","LKR","LRD","LSL","LTL","LVL","LYD","MAD","MDL","MGA","MKD","MMK","MNT","MOP","MRO","MRU","MTL","MUR","MVR","MWK","MXN","MYR","MZN","NAD","NGN","NIO","NOK","NPR","NZD","OMR","PAB","PEN","PGK","PHP","PKR","PLN","PYG","QAR","RON","RSD","RUB","RWF","SAR","SBD","SCR","SDG","SEK","SGD","SHP","SIT","SKK","SLL","SOS","SRD","SSP","STD","STN","SVC","SYP","SZL","THB","TJS","TMT","TND","TOP","TRY","TTD","TWD","TZS","UAH","UGX","USD","UYU","UZS","VEF","VES","VND","VUV","WST","XAF","XCD","XCG","XOF","XPF","YER","ZAR","ZMW","ZWG","ZWL"];

export function supports() { return true; } // any pair among CURRENCIES

function mmddyyyy(d) {
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return m + "/" + day + "/" + d.getUTCFullYear();
}

async function queryDay(from, to, fee, date, via) {
  const params = new URLSearchParams({
    amount: "100",
    fee: String(fee),
    utcConvertedDate: mmddyyyy(date),
    exchangedate: mmddyyyy(date),
    fromCurr: to,   // NOTE: intentionally swapped — see header comment
    toCurr: from,
  });
  const url = API + "?" + params.toString();
  const { json, via: usedVia } = await fetchJSON(url);
  if (!json || json.status !== "success" || !json.fxRateWithAdditionalFee) {
    throw new Error("visa: unexpected payload");
  }
  return { json, via: usedVia };
}

export async function convert({ from, to, amount, fee = 0, date = null }) {
  // date: "YYYY-MM-DD" historical rate day, or null = today (with walk-back)
  const dayKey = date || new Date().toISOString().slice(0, 10);
  const cacheKey = "visa:" + from + to + ":" + Number(fee).toFixed(1) + ":" + dayKey;
  const cached = cacheGet(cacheKey);
  let payload, via, cachedFlag = false;
  if (cached) { payload = cached; via = "cache"; cachedFlag = true; }
  else {
    let lastErr;
    const base = date ? new Date(date + "T00:00:00Z") : new Date();
    // Walk back a few days from the requested day (weekends / holidays / not-yet-published)
    for (let back = 0; back < 5; back++) {
      const d = new Date(base.getTime() - back * 86400000);
      try {
        const r = await queryDay(from, to, fee, d);
        payload = r.json; via = r.via;
        cacheSet(cacheKey, payload, date ? 7 * 24 * 3600 * 1000 : ttlEndOfDayPlus(6));
        break;
      } catch (e) { lastErr = e; }
    }
    if (!payload) throw lastErr || new Error("visa: no data");
  }
  const rate = parseFloat(payload.fxRateWithAdditionalFee);
  const asOfEpoch = payload.originalValues && payload.originalValues.asOfDate;
  const asOf = asOfEpoch ? new Date(asOfEpoch * 1000).toISOString().slice(0, 10) : dayKey;
  return {
    provider: "visa",
    rate,                     // 1 FROM = rate TO
    converted: amount * rate,
    asOf,
    fee,
    kind: "direct",
    via,
    cached: cachedFlag,
  };
}
