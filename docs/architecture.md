# 架构决策：一次查询四接口 vs Switch 切换 · Architecture: one-shot all four vs a switch

> The page implements **both**: a provider switch as the default interaction, plus an opt-in "对比全部 / Compare All" tab. 本页面**两者兼得**：默认以 Switch 切换卡组织为主交互，另提供可选的"对比全部"页签。

## 1. 四个数据源的真实差异 How the four sources actually differ

Reverse-engineered and live-verified on 2026-10-02 (reports in [`research/`](research/)):

| | Visa | Mastercard | JCB | UnionPay 银联 |
|---|---|---|---|---|
| Source 数据源 | `/cmsapi/fx/rates` JSON | `mccom-services/…/conversion-rates` JSON | 静态 HTML 表格（无 JSON API） | 每日 `jfimg/YYYYMMDD.json` |
| Coverage 覆盖 | 168 币种任意对 | 150 币种任意对 | 日元表 15 币种 / 美元表 162 币种（基准对） | 160 交易币 × 15 记账币 |
| Fee param 手续费 | `fee` 百分比，精确乘算 | `bank_fee` 百分比，精确乘算 | 无（发卡行后加 1.6–2%） | 无 |
| Update 更新 | 每日（UTC 参数可选历史） | 每日（`0000-00-00`=最新） | 每营业日 | 每日（节假日缺口需回退） |
| CDN / 边缘 | Cloudflare | Akamai | CloudFront | TencentEdgeOne |
| CORS | ❌ 无 ACAO | ❌ 无 ACAO | ❌ 无 ACAO（OPTIONS 403） | ❌ 无 ACAO |

**关键事实 Key facts:**

1. **四个接口全部没有 CORS 头**，浏览器直连必挂，一切请求都要经代理转发 —— 通道可靠性是第一约束。
2. **报价语义互不相同**：Visa/MC 是"任意对+可选银行费"；JCB 官方只发布 JPY/USD 基准表（并明示非基准对需自行交叉计算）；银联发布的是全矩阵但无手续费概念。
3. **数据日期可能不同步**：实测同日 Visa/MC/银联的 USD→CNY 分别为 6.7063 / 6.7045 / 6.7269（价差 0.334%），MC 的 `fxDate` 还常指向前一营业日。

## 2. 方案 A：一次查询访问 4 个接口 Option A: query all four at once

**优点 Pros**
- 一步到位回答"刷哪张卡最划算" —— 决策价值最高。
- 代码上看似更简单（无切换状态）。

**缺点 Cons**
- **最慢通道决定整体延迟**：四个源分属四家 CDN，再各叠一层公共代理，串行重试时 P95 延迟会到 10–30 秒级；任一代理被限流就整体报错。
- **语义鸿沟**：JCB 无手续费参数、部分货币对只能交叉估算；强制四家同显必须归一化（除以/乘上加点），否则就是误导。
- **代理放大效应**：请求数 ×4，公共代理（allorigins/codetabs 限流 5–20 req/min）更容易被触发限流，越多人用越快挂。
- 日常使用中多数人只持有一两张卡，一次拉四家是浪费。

## 3. 方案 B：Switch 切换不同 API Option B: a switch between APIs

**优点 Pros**
- **延迟低、容错好**：单通道失败只影响单卡组织，重试成本低；配合当日缓存（localStorage TTL 到次日）几乎瞬开。
- **语义保真**：每家按自己的规则展示（Visa/MC 显示含费率、JCB 标注"基准汇率+发卡加点"、银联标注矩阵直报/交叉）。
- 交互专注，UI 不必为"有的卡组织不支持该货币对"做大量禁用逻辑。

**缺点 Cons**
- 想对比就得手动切四次并人肉记数 —— 而这恰是最高频需求之一。

## 4. 结论与实现 Conclusion & implementation

**Switch 为默认 + "对比全部"为可选增强**，兼得两家之长：

- 默认单卡模式：只打一个接口，展示完整语义（含费/不含费、直报/倒数/交叉、汇率日期、来源链接）。
- "对比全部"页签：`Promise.allSettled` 并行查四家，逐行独立成败与重试；手续费仅对 Visa/MC 生效；JCB/银联行标注"未含发卡加点"；交叉汇率行明确打标；排序展示换汇结果。
- 数据层四个 provider 适配器输出统一结构（`{provider, rate, converted, asOf, fee, kind, notes}`），UI 层零差异消费 —— 未来加 AMEX 等只需新增一个适配器文件。

**量化佐证（2026-10-02 实测）Quantified evidence:**
- 直连延迟：Visa ~1.0–1.9s、MC ~1s、JCB ~0.5s、银联 ~0.5s（本地网络）。
- 经公共代理：成功与否高度波动（allorigins 当日成功率 0–25%），故页面实现多代理并发竞速 + 两轮重试 + 当日缓存，并推荐自建 Cloudflare Worker。
- 跨家一致性：USD→CNY 价差 0.334%（同日三源），对比模式有真实决策价值。
