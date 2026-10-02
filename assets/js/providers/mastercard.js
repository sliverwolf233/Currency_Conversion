// Mastercard — anonymous JSON API embedded in the mastercard.com converter page
// (found as hidden inputs in the page HTML):
//   /marketingservices/public/mccom-services/currency-conversions/conversion-rates
//
// Unlike Visa, direction here is natural: transaction_currency is the source,
// cardholder_billing_currency the target, and conversionRate (1 trans = R bill)
// already includes bank_fee. exchange_date="0000-00-00" selects the latest
// issued rate, so no date walk-back is needed.

import { fetchJSON, cacheGet, cacheSet, ttlEndOfDayPlus } from "../net.js";

const API = "https://www.mastercard.com/marketingservices/public/mccom-services/currency-conversions/conversion-rates";

// 150 currencies from the official /currencies endpoint
export const CURRENCIES = ["AFN","ALL","DZD","AOA","ARS","AMD","AWG","AUD","AZN","BSD","BHD","BDT","BBD","BYN","BZD","BMD","BTN","BOB","BAM","BWP","BRL","BND","BIF","KHR","CAD","CVE","XCG","KYD","XOF","XAF","XPF","CLP","CNY","COP","KMF","CDF","CRC","CUP","CZK","DKK","DJF","DOP","XCD","EGP","SVC","ETB","EUR","FKP","FJD","GMD","GEL","GHS","GIP","GBP","GTQ","GNF","GYD","HTG","HNL","HKD","HUF","ISK","INR","IDR","IQD","ILS","JMD","JPY","JOD","KZT","KES","KWD","KGS","LAK","LBP","LSL","LRD","LYD","MOP","MKD","MGA","MWK","MYR","MVR","MRU","MUR","MXN","MDL","MNT","MAD","MZN","MMK","NAD","NPR","NZD","NIO","NGN","NOK","OMR","PKR","PAB","PGK","PYG","PEN","PHP","PLN","QAR","RON","RUB","RWF","SHP","WST","STN","SAR","RSD","SCR","SLE","SGD","SBD","SOS","ZAR","KRW","SSP","LKR","SDG","SRD","SZL","SEK","CHF","TWD","TJS","TZS","THB","TOP","TTD","TND","TRY","TMT","UGX","UAH","AED","USD","UYU","UZS","VUV","VES","VND","YER","ZMW","ZWG"];

export function supports() { return true; } // any pair among CURRENCIES

export async function convert({ from, to, amount, fee = 0 }) {
  const dayKey = new Date().toISOString().slice(0, 10);
  const cacheKey = "mc:" + from + to + ":" + Number(fee).toFixed(1) + ":" + dayKey;
  const cached = cacheGet(cacheKey);
  let payload, via, cachedFlag = false;
  if (cached) { payload = cached; via = "cache"; cachedFlag = true; }
  else {
    const params = new URLSearchParams({
      exchange_date: "0000-00-00",
      transaction_currency: from,
      cardholder_billing_currency: to,
      bank_fee: String(fee),
      transaction_amount: "100",
    });
    const { json, via: usedVia } = await fetchJSON(API + "?" + params.toString());
    if (!json || !json.data || !json.data.conversionRate || json.data.errorMessage) {
      throw new Error("mastercard: " + (json && json.data && json.data.errorMessage || "unexpected payload"));
    }
    payload = json;
    cacheSet(cacheKey, payload, ttlEndOfDayPlus(6));
    via = usedVia;
  }
  const rate = parseFloat(payload.data.conversionRate); // 1 FROM = rate TO (fee included)
  return {
    provider: "mastercard",
    rate,
    converted: amount * rate,
    asOf: payload.data.fxDate || dayKey,
    fee,
    kind: "direct",
    via,
    cached: cachedFlag,
  };
}
