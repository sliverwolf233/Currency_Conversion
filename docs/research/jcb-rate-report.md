# JCB Official Rate Page — Data Source Report
(Researched live on 2026-10-02; all requests via web_fetch + curl.exe from PowerShell)

## 1. Data source type: STATIC HTML. No JSON/XHR API.

https://www.jcb.jp/rate/ is a legacy static-HTML island on www.jcb.jp (Apache behind CloudFront).
- Every rate table is server-rendered inline in the HTML.
- The dated USD pages reference jQuery 1.4.2 + a "csvToTable" plugin (/rate/testrate/...), but ALL of those JS files return 404 — dead references, no runtime fetch. The table is fully present in raw HTML.

## 2. Exact URL landscape

| URL | Status | Content |
|---|---|---|
| https://www.jcb.jp/rate/jpy.html | 200 | **The page that matters for Japanese JCB cards.** Japanese "海外でのお取り引きにおける基準レート". Single table: 15 foreign currencies -> JPY, current business day only. NO history pages (jpyMMDDYYYY.html -> 404). |
| https://www.jcb.jp/rate/usd.html | 200 | English "Base rate" index for **USD-billed** cardmembers. Body = ONLY a `<ul id="list-rate">` of dated permalinks (no table itself). |
| https://www.jcb.jp/rate/usdMMDDYYYY.html | 200 | Dated USD base-rate table (MMDDYYYY, US date order: usd10022026.html = Oct 2 2026). 162 currencies, Buy/Mid/Sell. Rolling list on usd.html shows ~132 days (currently 2026-07-03..2026-10-02) but older permalinks keep resolving (verified usd04172026.html -> 200). |
| https://www.jcb.jp/rate/index.html, /rate/, /rate/eur.html, gbp, chf, aud, cad, nzd, hkd, sgd, cny, krw, twd, thb, myr, idr, php, vnd, inr (.html) | 404 | Only jpy.html and usd.html exist. There is NO index.html. 404s serve HTTP 404 + a large branded not-found page. |

## 3. Raw snippets (verbatim from curl.exe -s)

### jpy.html (current-day JPY billing base rate)
```html
<div class="rate2TableArea">
<p>2026年10月02日換算日の基準レート</p>
<table>
<tr><td>USD</td><td>（米ドル）</td><td>＝</td><td>158.17</td><td>JPY（日本円）</td></tr>
<tr><td>EUR</td><td>（欧州ユーロ）</td><td>＝</td><td>177.971</td><td>JPY（日本円）</td></tr>
<tr><td>GBP</td><td>（イギリスポンド）</td><td>＝</td><td>208.768</td><td>JPY（日本円）</td></tr>
<tr><td>KRW</td><td>（韓国ウォン）</td><td>＝</td><td>0.116</td><td>JPY（日本円）</td></tr>
... (15 rows total)
</table>
</div>
```

### usd10022026.html (dated USD table)
```html
<div class="rate2TableArea">
<p>Base rate for 10/02/2026</p>
<div id="CSVTable" style="display: block;">
<tdead class=""></tdead>
<table class="CSVTable">
<tbody>
<tr class="odd">
<td></td><td></td><td>Buy</td><td>Mid</td><td>Sell</td><td></td></tr>
<tr class="even"><td class="">USD</td><td class="">=</td><td class="">3.672600000  </td><td class="">3.672700000  </td><td class="">3.672800000  </td><td class="">AED</td></tr>
<tr class="odd"><td class="">USD</td><td class="">=</td><td class="">157.689100000  </td><td class="">157.930000000  </td><td class="">158.170900000  </td><td class="">JPY</td></tr>
... (162 data rows)
</tbody></table></div>
```

## 4. Parsing strategy (CSS selectors / regex)

### jpy.html
- Container: `div.rate2TableArea` ; date: the `<p>` inside it, regex `(\d{4})年(\d{2})月(\d{2})日換算日の基準レート` → YYYY-MM-DD 換算日.
- Rows: `div.rate2TableArea table tr` (plain table, no thead/tbody, no classes). Each row 5 `<td>`: [0]=ISO code, [1]=JP currency name in （）, [2]="＝", [3]=rate (string→float), [4]="JPY（日本円）".
- Semantic: **1 unit of foreign currency = rate JPY**. Foreign-currency charge × rate = JPY amount.

### usdMMDDYYYY.html
- Rows: `table.CSVTable tbody tr` with class `odd`/`even`. SKIP the first tr (header "Buy/Mid/Sell" with two empty leading tds).
- tds: [0]="USD", [1]="=", [2]=Buy, [3]=Mid, [4]=Sell (9-decimal strings with trailing spaces — trim), [5]=counter-currency ISO code.
- Date: `<p>Base rate for MM/DD/YYYY</p>` (US date order).
- Malformed `<tdead>` tag exists (typo of thead) — ignore it; do not require a valid thead.

## 5. Rate semantics & direction

- jpy.html is JCB's 基準レート ("base rate") for **cards billed in JPY** ("上の基準レートは、日本円でお支払いになるカード会員の方に適用されます"). It is NOT TTS/TTB and NOT labelled 当社レート — single published rate per currency.
- Direction: **1 foreign currency unit = X JPY** (USD=158.17, KRW=0.116). Multiply, don't divide.
- The rate actually charged to a cardmember = 基準レート **+ issuer markup**: "下の基準レートに一定の率を加えた換算レートで日本円に換算します" — the "一定の率" is set by the card issuer, so the effective rate is issuer-specific (typically ~1.6–2.0% above base; JCB's page does not publish the markup).
- 換算日 semantics: rate is fixed on the day **JCB International pays the overseas merchant** — explicitly NOT the card-usage date and NOT the bank-debit date.
- Cross-check: jpy.html USD 158.17 (2026-10-02) == usd10022026 JPY row **Sell** 158.1709 truncated to 3 decimals → JPY billing uses the Sell side of the USD table. (Buy 157.6891 / Mid 157.93 / Sell 158.1709.)
- usdMMDDYYYY pages are for **USD-billed** cardmembers ("The exchange rate below is used when converting to USD."), quoted as 1 USD = Buy/Mid/Sell in counter-currency; page note says to compute cross-rates yourself for non-USD pairs.
- Rounding: published JPY rates are **truncated** (切捨て) below the 3rd decimal; KRW/IDR/VND below the 4th. Actual applied rate can differ from published (rounding, market unavailability → may use a different day's rate, refunds may use different rates, DCC at merchant uses the MERCHANT's own rate, not JCB's).

## 6. Update frequency
- **Once per JCB business day** (換算日). usd.html list skips Sat/Sun (10/02 Fri, 10/01 Thu, ... 09/28 Mon, 09/25 Fri). Latest entry = research day (2026-10-02).
- jpy.html carries only the current day; usd.html links ~132 dated pages (~3 months, 2026-07-03..2026-10-02); older dated URLs still resolve (200) if you know/guess the name.

## 7. CORS / embedding
- `curl.exe -sI -H "Origin: https://example.com" https://www.jcb.jp/rate/usd.html` → 200 with **NO Access-Control-Allow-Origin** (nor any access-control-* on GET either; count=0).
- OPTIONS preflight → **403 Forbidden** from CloudFront.
- Also X-Frame-Options: SAMEORIGIN (no iframe embedding).
- ⇒ Browser-side cross-origin fetch is impossible; a server-side proxy/scraper is required.
- Served via CloudFront (X-Cache Miss/Hit; observed Age up to ~7h) — cache may briefly lag the daily update.

## 8. Currencies covered
- jpy.html (15): USD, EUR, GBP, HKD, CNY, SGD, AUD, KRW, THB, TWD, MYR, IDR, PHP, VND, CAD.
- usdMMDDYYYY.html (162 codes, incl. obsolete & a self USD=USD row):
AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CLP CNY COP CRC CUP CVE CZK DJF DKK DOP DZD EEK EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HRK HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KRW KWD KYD KZT LAK LBP LKR LRD LSL LTL LVL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDD SDG SEK SGD SHP SLE SLL SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU UZS VES VND VUV WST XAF XCD XOF XPF YER ZAR ZMK ZMW ZWD ZWL
(Obsolete codes present: EEK, LTL, LVL, SDD, ZMK, ZWD — filter as needed.)

## 9. Gotchas
1. **usd.html contains no table** — only the dated-permalink list; scrape the first link for today's USD table. jpy.html DOES contain the table directly.
2. Date-in-URL is **MMDDYYYY** (usd10022026.html = Oct 2, 2026).
3. Dated pages' `<link rel="canonical">` points to /rate/usd.html — never dedupe by canonical.
4. 404s are HTTP 404 with a full branded page; detect by status code, not body.
5. Charset is utf-8 via meta only; Content-Type header lacks a charset param.
6. Trailing whitespace inside rate `<td>`s; 9-decimal values in USD table; JPY page shows 2–4 significant decimals (truncated, not rounded).
7. `<tdead>` malformed tag; header `<tr>` has empty leading tds; table rows alternate odd/even classes — skip row with "Buy".
8. No JSON endpoint exists (the /rate/testrate/ JS is 404 dead); don't hunt for XHR.
9. No JPY-rate history is published (only USD history permalinks).
10. Politeness: static pages, cheap to poll once/day after ~morning JST; CloudFront caching may add a small lag.

## Raw artifacts saved in workspace (D:\Codes\Currency_Conversion)
- jpy_raw.html (jpy.html as fetched by curl.exe)
- usd_dated_raw.html (usd10022026.html)
- usd_raw.html (usd.html index list)
