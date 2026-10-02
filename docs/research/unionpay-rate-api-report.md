# UnionPay International Rate API — Verified Report (2026-10-02)

## TL;DR
The old POST `/cn/service/forex/queryCurrencyRate` API is **DEAD (HTTP 404)** on both m. and www hosts (cn and en variants). The rate page (CN and EN, desktop and mobile) now uses **static daily JSON files on a CDN** — a plain GET, no auth, no special headers.

## Endpoints (all verified 200 today)

| Purpose | URL |
|---|---|
| Daily rates (mobile path) | `GET https://m.unionpayintl.com/jfimg/YYYYMMDD.json` |
| Daily rates (desktop path) | `GET https://www.unionpayintl.com/upload/jfimg/YYYYMMDD.json` |
| Daily rates (alt, also works) | `GET https://www.unionpayintl.com/jfimg/YYYYMMDD.json` |
| Base-currency list (15) | `GET https://m.unionpayintl.com/jfimg/rateData/base.json` (desktop: `https://www.unionpayintl.com/upload/jfimg/rateData/base.json`) |
| Transaction-currency list (159) | `GET https://m.unionpayintl.com/jfimg/rateData/tran.json` (desktop: `/upload/jfimg/rateData/tran.json`) |

Note: `https://m.unionpayintl.com/upload/jfimg/...` = 404. Date format: `20261002.json` (no dashes).

## Request format
- Method: GET (HEAD also fine). No body, no query params. "Pagination": none — one file contains ALL pairs for the day.
- Headers: **none required**. Works with empty UA, curl default UA, no Referer, no cookies, no Origin. Response sets a `tgw_l7_route` cookie (Tencent gateway routing; safe to ignore).
- Response headers: `Content-Type: application/json`, `Server: TencentEdgeOne`, ETag + Last-Modified (conditional GET supported).

## Raw response sample (`https://m.unionpayintl.com/jfimg/20261002.json`, 136,912 bytes)
Head/tail of file:
```json
{"exchangeRateJson":[{"transCur":"AED","baseCur":"AUD","rateData":0.39586529},{"transCur":"AFN","baseCur":"AUD","rateData":0.02240015},{"transCur":"ALL","baseCur":"AUD","rateData":0.01774245}, ... ,{"transCur":"ZMW","baseCur":"MNT","rateData":184.33839097},{"transCur":"ZWL","baseCur":"MNT","rateData":0.11795373},{"transCur":"XCG","baseCur":"MNT","rateData":2007.2913984}],"curDate":"2026-10-02"}
```
USD rows (all 15 baseCurs):
```json
[{"transCur":"USD","baseCur":"AUD","rateData":1.44963145},{"transCur":"USD","baseCur":"CNY","rateData":6.7269},{"transCur":"USD","baseCur":"CAD","rateData":1.4271687},{"transCur":"USD","baseCur":"EUR","rateData":0.89258699},{"transCur":"USD","baseCur":"GBP","rateData":0.76045339},{"transCur":"USD","baseCur":"HKD","rateData":7.8696383},{"transCur":"USD","baseCur":"JPY","rateData":158.55424},{"transCur":"USD","baseCur":"MOP","rateData":8.1097565},{"transCur":"USD","baseCur":"NZD","rateData":1.79187137},{"transCur":"USD","baseCur":"SGD","rateData":1.2849433},{"transCur":"USD","baseCur":"THB","rateData":33.776025},{"transCur":"USD","baseCur":"USD","rateData":1},{"transCur":"USD","baseCur":"HUF","rateData":329.520605},{"transCur":"USD","baseCur":"VND","rateData":26073.4865},{"transCur":"USD","baseCur":"MNT","rateData":3606.788}]
```
The CNY column (1 foreign = X CNY), i.e. all rows with baseCur=CNY:
```json
[{"transCur":"AUD","baseCur":"CNY","rateData":4.66360007},{"transCur":"CAD","baseCur":"CNY","rateData":4.73560008},{"transCur":"EUR","baseCur":"CNY","rateData":7.58839973},{"transCur":"GBP","baseCur":"CNY","rateData":8.90080014},{"transCur":"HKD","baseCur":"CNY","rateData":0.8569},{"transCur":"HUF","baseCur":"CNY","rateData":0.02053706},{"transCur":"JPY","baseCur":"CNY","rateData":0.042594},{"transCur":"KRW","baseCur":"CNY","rateData":0.00495653},{"transCur":"MNT","baseCur":"CNY","rateData":0.00187629},{"transCur":"MOP","baseCur":"CNY","rateData":0.8324},{"transCur":"NZD","baseCur":"CNY","rateData":3.77292814},{"transCur":"SGD","baseCur":"CNY","rateData":5.25550008},{"transCur":"THB","baseCur":"CNY","rateData":0.20015979},{"transCur":"USD","baseCur":"CNY","rateData":6.7269},{"transCur":"VND","baseCur":"CNY","rateData":0.00025955}]
```

## Field meanings & direction
- `exchangeRateJson`: array of 2,400 rows = 160 transCur x 15 baseCur, each `{"transCur","baseCur","rateData"}`.
- `rateData` **is the rate**: **1 transCur = rateData baseCur** (page renders: `1 {transCur} = {rateData} {baseCur}`). E.g. `{"transCur":"USD","baseCur":"CNY","rateData":6.7269}` = 1 USD = 6.7269 CNY.
- Semantics per the page form: transCur = transaction currency, baseCur = account/debit currency. So the CN-page quote "1 foreign = X CNY" = row with transCur=foreign, baseCur=CNY.
- `curDate`: the quote date, `YYYY-MM-DD`.

## CORS
**No CORS support.** With `-H "Origin: https://example.com"` the response has NO `Access-Control-Allow-Origin` (nothing is echoed). Browser cross-origin fetch/XHR will fail — use a server-side fetch/proxy. This is precisely why the page itself works: it requests same-origin relative URLs (`../../upload/jfimg/...` on www, `/jfimg/...` on m.).

## Auth
None. No tokens, cookies, referer checks, or UA checks observed.

## Date availability (gotchas)
- One file per **calendar day including weekends** (past Sat/Sun files exist, e.g. 20260926/20260927 = 200).
- Future dates 404 until published. Today's file (2026-10-02) Last-Modified = 08:40 UTC (16:40 Beijing) — published during the day; if today 404s in the morning, fall back to yesterday.
- History starts ~2021-01-01 (2020 and older = 404), despite the page date picker claiming minDate 2020-10-23.
- Gaps on some Chinese holidays: 2022-01-01, 2022-10-01, 2023-01-01 = 404 (regular 2022/2023 dates = 200).
- Page JS rolls Sat/Sun selections back to Friday and the date picker disables weekends — but weekend files genuinely exist; for practical use, walk back day-by-day until HTTP 200.
- 404 responses return a full HTML 404 page (with a JS redirect to the homepage) — do not JSON-parse blindly; check Content-Type or HTTP code first.

## Currency lists
base.json (15 baseCur / "account" currencies): AUD, CAD, CNY, EUR, GBP, HKD, HUF, JPY, MNT, MOP, NZD, SGD, THB, USD, VND.

tran.json (159 transaction currencies): USD, AED, AFN, ALL, AMD, AOA, ARS, AUD, AWG, AZN, BAM, BBD, BDT, BGN, BHD, BIF, BMD, BND, BOB, BRL, BSD, BTN, BWP, BYN, BYR, BZD, CAD, CDF, CHF, CLP, CNY, COP, CRC, CUC, CVE, CZK, DJF, DKK, DOP, DZD, EGP, ERN, ETB, EUR, FJD, FKP, GBP, GEL, GHS, GIP, GMD, GNF, GTQ, GYD, HKD, HNL, HRK, HTG, HUF, IDR, ILS, INR, IQD, IRR, ISK, JMD, JOD, JPY, KES, KGS, KHR, KMF, KRW, KWD, KYD, KZT, LAK, LBP, LKR, LRD, LSL, LTL, LYD, MAD, MDL, MGA, MKD, MMK, MNT, MOP, MRO, MRU, MUR, MVR, MWK, MXN, MYR, MZN, NAD, NGN, NIO, NOK, NPR, NZD, OMR, PAB, PEN, PGK, PHP, PKR, PLN, PYG, QAR, RON, RSD, RUB, RWF, SAR, SBD, SCR, SDG, SEK, SGD, SHP, SLL, SOS, SRD, SSP, STD, SVC, SYP, SZL, THB, TJS, TMT, TND, TOP, TRY, TTD, TWD, TZS, UAH, UGX, UYU, UZS, VEF, VES, VND, VUV, WST, XAF, XCD, XCG, XOF, XPF, YER, ZAR, ZMK, ZMW

Note: daily files contain 160 transCur — CUP, STN, ZWL appear in files but not in tran.json; LTL, ZMK are listed in tran.json but absent from current files (dead codes).

## Legacy endpoints (all DEAD, verified today)
- POST https://m.unionpayintl.com/cn/service/forex/queryCurrencyRate → 404 (HTML)
- POST https://www.unionpayintl.com/cn/service/forex/queryCurrencyRate → 404
- POST /en/service/forex/queryCurrencyRate (m. and www) → 404
- POST /service/forex/queryCurrencyRate (no locale) → 504 Gateway Time-out (stgw)
- Old page https://www.unionpayintl.com/cardholderServ/serviceCenter/rate → 404

## Local artifacts
- rate_20261002.json (full daily file), base.json, tran.json, downloaded HTML pages — all in D:\Codes\Currency_Conversion\
