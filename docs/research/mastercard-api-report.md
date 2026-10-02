# Mastercard Currency Converter API — verified 2026-10-02

## 1. Real endpoint (verified from the live page HTML + its JS bundle)

The page https://www.mastercard.com/cn/zh/personal/get-support/currency-exchange-rate-converter.html
embeds the endpoints in hidden inputs:

```html
<input id="currencyListUrl" type="hidden" data-cmp-url="/marketingservices/public/mccom-services/currency-conversions/currencies"/>
<input id="currencyConversionUrl" type="hidden" data-cmp-url="/marketingservices/public/mccom-services/currency-conversions/conversion-rates"/>
```

- Conversion: GET https://www.mastercard.com/marketingservices/public/mccom-services/currency-conversions/conversion-rates
- Currency list: GET https://www.mastercard.com/marketingservices/public/mccom-services/currency-conversions/currencies

Both verified working (HTTP 200 JSON, no auth).

Client JS: /etc.clientlibs/marts/clientlibs/clientlib-site.lc-80c366209f7eadf7d875fbb578f157c8-lc.min.js
(component ./src/main/webpack/components/_currency-converter.js) builds:

```js
const requestData = new URLSearchParams({
    exchange_date: transactionDateValue,            // "YYYY-MM-DD", or "0000-00-00" = latest
    transaction_currency: state.fromCurrency,
    cardholder_billing_currency: state.toCurrency,
    bank_fee: state.bankFee,
    transaction_amount: parseFloat(state.amount),
});
fetch(conversionUrl + "?" + requestData)   // plain GET, no custom headers
```

## 2. Old candidate endpoints — status today

| URL | Status |
|---|---|
| https://api.mastercard.com/gateway/api/rates | 404 {"Errors":{"Error":[{"Source":"Gateway","ReasonCode":"NOT_FOUND",...}]}} |
| https://api.mastercard.com/settlement/currency-rate/rates | 404 same gateway NOT_FOUND |
| https://api.mastercard.com/settlement/currencyrate/conversion-rate (official developer API, snake params) | exists but 400 INVALID_AUTH_HEADER — requires OAuth 1.0a (developer portal key); sandbox same |
| https://www.mastercard.com/settlement/currencyrate/conversion-rate (old unauthenticated mirror used by scrapers) | 403 Akamai Access Denied |

## 3. Request format (new endpoint)

GET, query params only, no headers/auth/cookies required:

| Param | Req | Format / rules |
|---|---|---|
| exchange_date | yes | yyyy-MM-dd, or "0000-00-00" = latest issued rate |
| transaction_currency | yes | ISO-4217 alpha-3, case-insensitive (echoed uppercase) |
| cardholder_billing_currency | yes | ISO-4217 alpha-3 |
| bank_fee | yes | plain number 0–99, up to 2 decimals. NO "%" suffix (rejected) |
| transaction_amount | yes | number > 0 (UI allows 9 int digits + 2 decimals) |

## 4. Raw response samples (captured 2026-10-02)

USD -> CNY, amount 100, bank_fee 0:
```json
{"data":{"conversionRate":"6.7045000","crdhldBillAmt":"670.4500000","crdhldBillCurr":"CNY","fxDate":"2026-10-01","transAmt":"100","transCurr":"USD"}}
```
USD -> CNY, amount 100, bank_fee 2:
```json
{"data":{"bankFee":"2","conversionRate":"6.8385900","crdhldBillAmt":"683.8590000","crdhldBillCurr":"CNY","fxDate":"2026-10-01","transAmt":"100","transCurr":"USD"}}
```
Currencies endpoint returns {"data":{"currencies":[{"alphaCd":"AFN","currNam":"AFGHANISTAN AFGHANI"}, ...]}} (150 entries).

## 5. Field meanings & fee math (empirically verified)

- conversionRate: effective rate — 1 unit of transaction_currency = conversionRate units of cardholder_billing_currency. ALREADY includes the bank-fee markup:
  base(6.7045) x 1.02 = 6.8385900 (fee 2); x 1.025 = 6.8721125 (fee 2.5); x 1.99 = 13.3419550 (fee 99). Exact match.
- crdhldBillAmt = transaction_amount x conversionRate (string, 4-7 decimals).
- fxDate = rate date actually used. With "0000-00-00" (or today before publication) returns the most recent issued date (2026-10-01 when called on 2026-10-02).
- transAmt / transCurr / crdhldBillCurr echo inputs (currency uppercased).
- bankFee echoes the fee and is ABSENT from JSON when 0.
- ALL values are JSON strings, not numbers.

## 6. CORS behavior

GET with "Origin: https://example.com" -> 200 but NO Access-Control-Allow-Origin / -Methods / -Headers at all.
OPTIONS preflight -> 200 "OK" (text/html), also no CORS headers.
=> No ACAO value is returned; cross-origin browser use is blocked. Same-origin only (page is www.mastercard.com). The old api.mastercard.com endpoint used to send "Access-Control-Allow-Origin: *" — this one does not.

## 7. Auth

None. No Authorization, no cookies, no Referer required. Works server-to-server.
(Akamai fronting exists but the API path is lenient: Node fetch with a browser-ish UA -> 200; Python requests -> 200 (via curl_cffi chrome impersonation tested); Windows curl.exe (Schannel TLS) -> 403 Access Denied regardless of UA. Page HTML itself needs full Chrome impersonation.)

## 8. Error responses

- Missing/invalid param: 400 {"data":{"errorMessage":"Transaction amount is required"}} (also "...currency is required", "Bank fee is required", "Invalid value for bank_fee", "Exchange date must be in format yyyy-MM-dd", "Transaction amount must be greater than 0", "Bank fee must be greater than or equal to 0"). When several params are wrong, only ONE is reported per request (appears nondeterministic).
- Invalid currency: 400 {"data":{"errorCode":"400","errorMessage":"Bad Request , Transaction Currency is invalid"}}
- Date too old: 400 "...Requested date is outside of approved historical rate range" — window is last 365 days inclusive of today (2025-10-03 OK / 2025-10-02 rejected on 2026-10-02).
- Future date: 401 {"data":{"errorCode":"401","errorMessage":"Unauthorized access , Rate is not accessible for this date"}}
- POST -> 404; HEAD -> 200.

## 9. Gotchas

1. bank_fee must be a bare number — "%" suffix is rejected ("Invalid value for bank_fee"). (The page's JS stores "2%" for display and would even send it %-encoded — server rejects it; use plain digits.)
2. exchange_date is required; magic value "0000-00-00" = latest.
3. Weekend/holiday dates silently return the last published rate while fxDate echoes the requested date (Sat 2026-09-26 & Sun 2026-09-27 both returned 6.7128).
4. Today's rate may not be issued yet — you get the previous day's (fxDate tells you which).
5. Historical range: only last 365 days; future -> 401 (not 4xx "future" message).
6. No CORS headers -> server-side use only.
7. All numeric fields are strings.
8. Old param names (fxDate, transCurr, crdhldBillCurr, bankFee, transAmt) are NOT accepted — validation errors are misleading (it complains about a random missing field).
9. Windows curl.exe is Akamai-blocked on www.mastercard.com; use Node fetch / Python requests with a browser UA, or a Chrome-impersonating client.
10. Response has no bankFee key when fee = 0.
11. Same-currency conversion returns rate 1.0000000.
12. Lowercase currency codes accepted, echoed uppercase.

## 10. Supported currency codes (150, from /currencies endpoint)

AFN, ALL, DZD, AOA, ARS, AMD, AWG, AUD, AZN, BSD, BHD, BDT, BBD, BYN, BZD, BMD, BTN, BOB, BAM, BWP, BRL, BND, BIF, KHR, CAD, CVE, XCG, KYD, XOF, XAF, XPF, CLP, CNY, COP, KMF, CDF, CRC, CUP, CZK, DKK, DJF, DOP, XCD, EGP, SVC, ETB, EUR, FKP, FJD, GMD, GEL, GHS, GIP, GBP, GTQ, GNF, GYD, HTG, HNL, HKD, HUF, ISK, INR, IDR, IQD, ILS, JMD, JPY, JOD, KZT, KES, KWD, KGS, LAK, LBP, LSL, LRD, LYD, MOP, MKD, MGA, MWK, MYR, MVR, MRU, MUR, MXN, MDL, MNT, MAD, MZN, MMK, NAD, NPR, NZD, NIO, NGN, NOK, OMR, PKR, PAB, PGK, PYG, PEN, PHP, PLN, QAR, RON, RUB, RWF, SHP, WST, STN, SAR, RSD, SCR, SLE, SGD, SBD, SOS, ZAR, KRW, SSP, LKR, SDG, SRD, SZL, SEK, CHF, TWD, TJS, TZS, THB, TOP, TTD, TND, TRY, TMT, UGX, UAH, AED, USD, UYU, UZS, VUV, VES, VND, YER, ZMW, ZWG
