# Visa Exchange-Rate Calculator — Backend API Report

Reverse-engineered from https://www.visa.com.hk/zh_HK/support/consumer/travel-support/exchange-rate-calculator.html
Research date: 2026-10-02 (all live tests performed this day)

## 1. How the endpoint was found

The calculator page is an AEM page hosting a Vue web component:

1. Page HTML loads `` (82 bytes): `$.getScript("/etc/ui/headless-ui/scripts/core/component-ui/dm-calculator.min.js")`
2. `dm-calculator.min.js` (250 KB, Vue 2 + axios) contains in `onSubmit()`:

```js
const t = await da.get("/cmsapi/fx/rates", { params: {
  amount: this.calculator_form.amountPaid,
  fee: this.calculator_form.bankFee,
  utcConvertedDate: this.calculator_form.date,
  exchangedate: this.calculator_form.date,
  fromCurr: this.selectedCurrencyKey(this.calculator_form.to),   // NOTE: swapped!
  toCurr:   this.selectedCurrencyKey(this.calculator_form.from)  // NOTE: swapped!
}});
```

## 2. Endpoint

```
GET https://<regional-visa-host>/cmsapi/fx/rates
```

Same path on every regional Visa site (all behind Cloudflare). Verified working hosts:
`www.visa.com.hk`, `usa.visa.com`, `www.visa.com.sg`, `www.visa.com.tw`, `www.visa.com.au`, `www.visa.co.uk`, `www.visa.co.in`, `www.visa.com.br`, `www.visa.com.mx`, `www.visa.co.jp`, `ae.visamiddleeast.com`, `www.visa.co.za`, `www.visa.ca`.
NOT working: `www.visa.com.cn` (301 redirect), `www.visa.co.kr` (connection failed).
All respond in ~1.0–1.9 s from a US-West (LAX) vantage — same Cloudflare anycast network, no meaningful speed difference; pick any, e.g. `usa.visa.com`.

### Query parameters (ALL required — omit any one → HTTP 400)

| Param | Meaning | Format / example |
|---|---|---|
| `amount` | Amount to convert, denominated in **`toCurr`** | decimal, `100`, `99.99` |
| `fee` | Bank fee percentage added on top of Visa's rate | decimal percent, `0`, `2.5` |
| `utcConvertedDate` | **Selects which day's rate you get** | `MM/DD/YYYY` URL-encoded: `10%2F02%2F2026` |
| `exchangedate` | Echoed back for display only (`conversionInputDate`, `disclaimerDate`) | `MM/DD/YYYY` |
| `fromCurr` | ISO-4217 code, UPPERCASE — the **TARGET** currency you convert INTO | `HKD` |
| `toCurr` | ISO-4217 code, UPPERCASE — the **SOURCE** currency of `amount` | `USD` |

### CRITICAL direction convention (inverted names)

`amount` is in **`toCurr`**; the result (`convertedAmount`) is in **`fromCurr`**.
To convert **100 USD → HKD** you must call: `fromCurr=HKD&toCurr=USD&amount=100`.
The web UI itself swaps its form fields the same way (see JS above). Lowercase codes → HTTP 500.

### Method & headers

- `GET` only. `POST` → 404 (HTML page), `HEAD` → 403, `OPTIONS` → 403.
- **No auth, no API key, no cookies, no special headers required.** Works with curl's default UA over HTTP/1.1. `Accept: application/json` optional. Response `Content-Type: application/json`.

## 3. Real request + raw response

```
curl "https://www.visa.com.hk/cmsapi/fx/rates?amount=100&fee=0&utcConvertedDate=10%2F02%2F2026&exchangedate=10%2F02%2F2026&fromCurr=HKD&toCurr=USD"
```

```json
{"originalValues":{"fromCurrency":"USD","fromCurrencyName":"United States Dollar","toCurrency":"HKD","toCurrencyName":"Hong Kong Dollar","asOfDate":1790899200,"fromAmount":"100","toAmountWithVisaRate":"784.949215","toAmountWithAdditionalFee":"784.949215","fxRateVisa":"7.849492151","fxRateWithAdditionalFee":"7.849492151","lastUpdatedVisaRate":1790898624,"benchmarks":[{"benchmarkSystem":"ECB","benchmarkBaseCurrency":"EUR","benchmarkBaseCurrencyName":"Euro","toAmountWithBenchmarkRate":"784.72296","markupWithoutAdditionalFee":"0.000288","markupWithAdditionalFee":"0.000288","benchmarkFxRate":"7.8472295982","lastUpdatedBenchmarkRate":1790863525}]},"conversionAmountValue":"100","conversionBankFee":"0.0","conversionInputDate":"10/02/2026","conversionFromCurrency":"HKD","conversionToCurrency":"USD","fromCurrencyName":"United States Dollar","toCurrencyName":"Hong Kong Dollar","convertedAmount":"784.949215","benchMarkAmount":"0.03","fxRateWithAdditionalFee":"7.849492151","reverseAmount":"0.127396","disclaimerDate":"October 2, 2026","status":"success"}
```

With `fee=3` (request fromCurr=USD&toCurr=HKD&amount=100): `fxRateVisa=0.1274825986`, `fxRateWithAdditionalFee=0.1313070766` (= ×1.03 exactly), `convertedAmount=13.130708`.

### Field meanings

**`originalValues`** (the raw quote — note `fromCurrency` here = request's `toCurr` = source, `toCurrency` = request's `fromCurr` = target):
- `fxRateVisa` — **the Visa unit rate: target-currency per 1 source-currency** (here 1 USD = 7.849492151 HKD). This is the number you want.
- `fxRateWithAdditionalFee` — same × (1 + fee/100).
- `fromAmount` — echo of `amount`; `toAmountWithVisaRate` / `toAmountWithAdditionalFee` — converted totals without/with fee.
- `asOfDate`, `lastUpdatedVisaRate` — epoch seconds (asOfDate = 00:00 UTC of `utcConvertedDate`).
- `benchmarks[0]` — ECB (euro-based) comparison: `benchmarkFxRate`, `markupWithoutAdditionalFee` (decimal fraction: 0.000288 = 0.0288% above ECB), `markupWithAdditionalFee`.

**Top level** (display-ready values the UI uses):
- `convertedAmount` — final result incl. fee, in `fromCurr` (string, 6 dp).
- `fxRateWithAdditionalFee` — rate incl. fee (dup of originalValues).
- `reverseAmount` — exactly `1 / fxRateWithAdditionalFee` (the rate the other direction).
- `benchMarkAmount` — markup over ECB as % rounded to 2 dp incl. fee ("0.03").
- `conversionInputDate` = `exchangedate` echo; `disclaimerDate` — pretty date; `conversionBankFee` — fee echo; `status` — "success".
- `fromCurrencyName`/`toCurrencyName` — names of target/source respectively.

## 4. CORS (tested with curl -D -)

- `GET` with `Origin: https://example.com` → 200, **no `Access-Control-Allow-Origin` header at all** (also none for `Origin: https://usa.visa.com` or `https://www.visa.com.hk` — not needed, the page calls same-origin).
- `OPTIONS` preflight → **403 Forbidden**.
- ⇒ **Cannot be called from browser JavaScript cross-origin. Server-side / curl only.** (Workaround: proxy through your own backend.)

## 5. Rate limits & reliability

- 20 parallel + ~40 sequential requests at ~10 rps: all 200, no 429, no throttling observed. No documented limit — be polite.
- Auth: none whatsoever.

## 6. Gotchas

1. **Inverted param names** (see §2) — the #1 trap.
2. **Dates strictly `MM/DD/YYYY`** and must be URL-encoded (`%2F`); ISO dates → 400. `utcConvertedDate` picks the rate; `exchangedate` is cosmetic — but both are required.
3. **Date window**: only ~past 12 months (10/05/2025 OK at 362 days back; exactly 365 days back → 500). Future dates → 400.
4. **Error style**: bad params → 400 with an HTML "400 Bad Request" page; unknown currency / out-of-window date / lowercase code → **HTTP 500 with plain body `Error`**. Not JSON errors.
5. **Directional spread**: quotes are NOT reciprocal — USD→HKD gave 7.849492151 while HKD→USD gave 0.1274825986 (1/7.849492151 = 0.127396, ~0.07% different). Always query the exact direction you need.
6. **Cloudflare bot management**: Node/undici `fetch` gets a 403 "Just a moment…" managed challenge (TLS-fingerprint based); curl.exe (Windows schannel) passes with or without a browser UA; real browsers pass. Python `requests` may hit the same challenge — if so, tune TLS/headers or use curl. (The `web_fetch` tool in this harness also passes.)
7. **Legacy/withdrawn codes still quote**: CYP, EEK etc. return 200 with rates. The literal string `None` (UI placeholder) → 500.
8. `POST` → 404 HTML, `HEAD`/`OPTIONS` → 403. GET only.

## 7. Supported currency codes (168, from the page's embedded `currencyList`)

AED AFN ALL AMD AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CLP CNY COP CRC CVE CYP CZK DJF DKK DOP DZD EEK EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GQE GTQ GWP GYD HKD HNL HRK HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KRW KWD KYD KZT LAK LBP LKR LRD LSL LTL LVL LYD MAD MDL MGA MKD MMK MNT MOP MRO MRU MTL MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SIT SKK SLL SOS SRD SSP STD STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU UZS VEF VES VND VUV WST XAF XCD XCG XOF XPF YER ZAR ZMW ZWG ZWL

(Includes long-withdrawn codes — CYP, EEK, LTL, LVL, MTL, SIT, SKK, GWP, ZWL, VEF, MRO, STD — plus current ones; the list also contains a literal `None` placeholder which is not a valid code.)
