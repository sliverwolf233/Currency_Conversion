# Currency_Conversion · 四大卡组织汇率换算器

**Card Network Rate Converter** — a static, dependency-free web page that converts currencies using the *official public rate data* of the four major card networks: **Visa, Mastercard, JCB and UnionPay (银联)**.

**四大卡组织汇率换算器** —— 一个零依赖的纯静态网页，使用 **Visa、Mastercard、JCB、银联** 四家卡组织的官方公开汇率数据进行货币换算，支持单卡查询与四卡对比。

**Live demo · 在线体验**: <https://sliverwolf233.github.io/Currency_Conversion/>

---

## 功能 Features

| | English | 中文 |
|---|---|---|
| 🔄 | Convert with any of the four networks, each via its real official data source | 四家卡组织任选其一，各自对接官方真实数据源 |
| ⚖️ | **Compare All** mode queries all four networks in parallel and ranks them | **对比全部** 模式并行查询四家并排对比 |
| 💳 | Issuer-fee input (0–10%, type any value) applied to Visa/Mastercard rates, exactly like their official calculators | 发卡行手续费可直接输入（0–10%），仅作用于 Visa/Mastercard 汇率，与其官网计算器一致 |
| 📅 | Historical rate dates: Visa/Mastercard ~1 year back, UnionPay since 2021, JCB USD table (JPY table is current-day only and says so) | 历史汇率查询：Visa/万事达约一年内、银联自 2021 年、JCB 美元表（日元表仅当日并明确提示） |
| 🔍 | Searchable currency picker (Apple HIG style combobox): filter by code / 中文 / English, full keyboard navigation, match highlighting | 可搜索币种选择器（Apple HIG 风格）：代码/中文/英文过滤、完整键盘导航、命中高亮 |
| 🔁 | Optional settlement currency (two-leg conversion): spend A, billed via USD etc., stored in B — shows both legs and the combined rate | 可选中间结算货币（两跳换汇）：花 A 货币、经 USD 等结算、入账 B 货币，展示两跳明细与综合汇率 |
| 🇯🇵 | JCB dual billing modes: JPY-billed (基準レート) and USD-billed (Base rate) | JCB 双记账模式：日元记账（基準レート）与美元记账（Base rate） |
| 🌐 | Bilingual UI (中文 / English), dark mode, mobile-friendly | 中英双语界面、深色模式、移动端适配 |
| 📦 | 100% static — perfect for GitHub Pages; no build step, no backend | 纯静态、零构建、无后端，适合 GitHub Pages |
| 🔌 | Resilient fetching: direct → custom proxy → public CORS proxies raced in parallel, plus all-day localStorage caching | 多通道容灾：直连 → 自建代理 → 公共代理并发竞速，当日结果本地缓存 |
| 🧪 | Offline + live test suites (66 assertions) run locally and in GitHub Actions | 离线+真实数据测试套件（66 项断言），本地与 GitHub Actions 均可运行 |

## 数据来源 Data sources

| Network 卡组织 | Official source 官方数据源 | Type 类型 | Pair semantics 报价语义 |
|---|---|---|---|
| **Visa** | `cmsapi/fx/rates` behind the official [rate calculator](https://www.visa.com.hk/zh_HK/support/consumer/travel-support/exchange-rate-calculator.html) | JSON API | Any→any pair, optional issuer fee 任意货币对，可选发卡行手续费 |
| **Mastercard** | `mccom-services/currency-conversions/conversion-rates` behind the official [converter](https://www.mastercard.com/cn/zh/personal/get-support/currency-exchange-rate-converter.html) | JSON API | Any→any pair, optional issuer fee 任意货币对，可选发卡行手续费 |
| **JCB** | [www.jcb.jp/rate](https://www.jcb.jp/rate/usd.html) static pages (no JSON API exists) | HTML | JPY/USD base-rate tables; non-base pairs via cross rate 基准汇率表；非基准货币对按官方提示做交叉汇率 |
| **UnionPay 银联** | Daily JSON behind the official [rate page](https://www.unionpayintl.com/cn/rate/) | JSON | 160 transaction × 15 account currencies matrix 交易货币×记账货币全矩阵 |

Rate-direction semantics, fee math, date handling and every gotcha were reverse-engineered from each network's own page code and verified with live requests — full research reports live in [`docs/research/`](docs/research/). 汇率方向、手续费计算、日期处理等细节均逆向自各官网页面代码并经真实请求验证，完整调研报告见 [`docs/research/`](docs/research/)。

## 设计决策：一次查询四接口，还是 Switch 切换？ Architecture: one-shot all four, or a switch?

**Short answer / 简短结论：both — switch as the default, opt-in "Compare All". 两者兼得：默认 Switch 单卡查询，另提供可选的"对比全部"。**

The full analysis (with measurements) is in [`docs/architecture.md`](docs/architecture.md); the essentials:

完整分析（含实测数据）见 [`docs/architecture.md`](docs/architecture.md)，要点如下：

- **报价语义不可比 Rate semantics are not directly comparable** — Visa/Mastercard quote any pair with an optional bank fee; JCB publishes JPY/USD *base rates* (issuer adds ~1.6–2% later); UnionPay quotes a 160×15 matrix with no fee concept. A forced all-four query must either normalize or mislead.
  Visa/Mastercard 报任意货币对且可带发卡行手续费；JCB 只公布日元/美元基准汇率（发卡行另加约 1.6–2%）；银联是 160×15 矩阵且无手续费概念。强行一次查四家，要么归一化处理、要么误导用户。
- **延迟与可靠性 Latency & reliability** — the four sources sit behind different CDNs (Cloudflare / Akamai / CloudFront / TencentEdgeOne), none with CORS; every request goes through proxies. Batching all four makes the slowest or flakiest channel gate the whole result. Switch mode touches one channel; failures are isolated.
  四个数据源分属不同 CDN 且均无 CORS，全靠代理转发。一次查四家时最慢/最不稳的通道拖累整体；Switch 模式只碰一条通道，故障隔离。
- **决策价值 Decision value** — the reason to query all four at once is choosing which card to pay with. That is exactly what the optional **Compare All** tab does (`Promise.allSettled`, per-network status, fee applied only where meaningful, cross-rate rows flagged).
  一次查四家的真正价值是"刷哪张卡更划算"——这正是可选的**对比全部**页签所做的（`Promise.allSettled`、逐家状态、仅对适用卡组织计费、交叉汇率明确标注）。

## 使用自建代理（推荐） Self-hosted proxy (recommended)

Public CORS proxies are rate-limited; for daily use deploy the bundled Cloudflare Worker (`worker/proxy.js`, ~2 minutes, free tier is plenty), then enter its URL in the page's 设置 → 自定义代理:

公共 CORS 代理有限流；日常使用建议部署内置的 Cloudflare Worker（`worker/proxy.js`，约 2 分钟，免费额度绰绰有余），然后在页面"设置 → 自定义代理"填入：

```
https://your-worker.workers.dev/?url={url}
```

## 本地开发与测试 Local development & tests

```bash
npm ci          # installs jsdom for the headless smoke test
npm test        # live end-to-end verification against the four networks
npm run smoke   # headless UI test: tabs, convert, compare mode, i18n, swap
npm run test:offline   # CI-safe offline suites (fixture parsers + stubbed UI flow)
npm run serve    # any static server works locally
```

GitHub Actions runs the syntax checks and offline suites on every push/PR (required), plus the live suites on a best-effort basis (runner IPs are frequently blocked by the card networks — [`.github/workflows/tests.yml`](.github/workflows/tests.yml)).

The verify suite unit-tests the JCB HTML parsers against saved fixtures and live-queries all four networks — rate plausibility, exact fee math, inverse/cross-rate consistency, historical-date queries (Visa/Mastercard/UnionPay all return exactly the requested past day) and cross-network coherence (Visa/MC/UnionPay agreed within 0.34% on USD→CNY at verification time). The smoke suite boots the real page headlessly and drives it like a user: every provider tab, the searchable currency picker (filter, keyboard navigation, Enter/Esc), the historical-date flow, the compare-all mode, the zh/EN toggle and the swap button (32 assertions).

测试套件对 JCB 解析器做离线断言，并对四家做真实查询，校验汇率合理性、手续费精确计算、倒数/交叉汇率一致性与跨卡组织一致性（验证时 USD→CNY 三家价差仅 0.34%）。

## 部署到 GitHub Pages Deploy to GitHub Pages

1. Push this repo to `github.com/sliverwolf233/Currency_Conversion` (main branch). 推送到 main 分支。
2. Repo **Settings → Pages → Source: Deploy from a branch → main / (root)** → Save.
3. Your page is live at <https://sliverwolf233.github.io/Currency_Conversion/> .

The repo includes `.nojekyll` so GitHub serves `assets/` untouched. 仓库含 `.nojekyll`，确保 `assets/` 目录原样发布。

## 目录结构 Project structure

```
├── index.html                  # page shell 页面骨架
├── assets/
│   ├── css/style.css           # styles (auto dark mode 深色模式自适应)
│   └── js/
│       ├── app.js              # UI logic, switch + compare UI 逻辑
│       ├── i18n.js             # zh/en strings 中英文案
│       ├── currencies.js       # currency metadata 币种元数据
│       ├── net.js              # proxy-chain fetch + cache 代理链与缓存
│       └── providers/          # one adapter per network 每家卡组织一个适配器
│           ├── visa.js         #   /cmsapi/fx/rates (params intentionally swapped!)
│           ├── mastercard.js   #   mccom-services conversion-rates
│           ├── jcb.js          #   static HTML tables (jpy.html / usdMMDDYYYY.html)
│           └── unionpay.js     #   daily jfimg/YYYYMMDD.json matrix
├── worker/proxy.js             # optional Cloudflare Worker CORS proxy
├── docs/
│   ├── architecture.md         # switch-vs-one-shot analysis 架构分析
│   └── research/               # API research reports 接口调研报告
└── test/
    ├── verify.mjs              # live e2e checks 端到端验证
    ├── smoke.mjs               # headless UI test (jsdom) 无头 UI 测试
    └── fixtures/               # saved JCB pages JCB 页面存档
```

## 免责声明 Disclaimer

Rates are fetched from the card networks' public pages and are indicative only; the rate actually applied depends on your issuer (JCB/UnionPay issuers typically add ~1.6–2%). This project is not affiliated with Visa, Mastercard, JCB or UnionPay.

汇率来自各卡组织公开页面，仅供参考；实际扣款汇率以发卡行为准（JCB/银联发卡行通常另加约 1.6–2%）。本项目与 Visa、Mastercard、JCB、银联无隶属关系。

## License

AGPL-3.0 — see [LICENSE](LICENSE).
