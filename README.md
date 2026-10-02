# CardRate (Win32 Edition) · 四卡汇率换算器 桌面版

Classic-style Windows desktop build of the Currency Conversion project — pure Win32 API (C++), chosen for its tiny memory footprint and near-zero runtime overhead: no XAML, no WinRT, no runtime dependencies, a single static-linked EXE.

主仓库网页版的 Win32 桌面版：纯 Win32 API（C++）编写，古早经典 Windows 风格（原生控件、宋体 9pt、3D 灰界面、菜单栏），内存占用小、性能损耗少，MSVC 静态链接单文件 EXE，无任何运行时依赖。

> 本分支基于 main（网页版）独立演进；main 分支保留网页版。
> This branch lives alongside the web edition on main.

## 特性 Features

- 纯 Win32 原生控件（COMCTL32 经典外观，无视觉样式清单 = 真·古早风）
- WinHTTP 直连四家卡组织官方接口（桌面应用无 CORS 限制）：Visa cmsapi、Mastercard mccom-services、JCB 静态 HTML 表、银联每日 JSON 矩阵
- 发卡行手续费（0–10% 可填）
- 历史汇率（Visa/万事达约一年、银联 2021 起、JCB 美元表；日元表仅当日并提示）
- 可选中间结算货币（两跳换汇，展示两跳明细与综合汇率）
- "对比全部"：一次并排四家
- --selftest 离线自测（解析器 + 数学，CI 安全）；--cli 命令行模式

## 界面 Interface

- 卡组织：Visa / Mastercard / JCB（日元记账）/ JCB（美元记账）/ 银联
- 输入：金额、从/到货币（可编辑下拉，含常用币种）、手续费%、结算货币（可空 = 直换）、日期（可空 = 最新）
- 输出：换算结果、双向汇率、报价类型（直报/倒数/交叉）、两跳明细、汇率日期、备注

## 编译 Build

本地（VS 开发者命令行）：

    cl /nologo /utf-8 /EHsc /MT /O2 /DUNICODE /D_UNICODE main.cpp /link /SUBSYSTEM:WINDOWS /OUT:CardRate.exe

或直接交给 GitHub Actions（推荐）：push 到 win32 分支即自动编译、自测并上传产物。

## GitHub Actions 产物 Artifacts

每次 push 自动构建：Actions → Build Win32 → Artifacts → CardRate-win32（含 CardRate.exe 单文件）。

命令行验证示例：

    CardRate.exe --selftest
    CardRate.exe --cli USD CNY 100 0 "" "" mastercard

## 免责声明 Disclaimer

汇率来自各卡组织公开接口，仅供参考；实际扣款以发卡行为准。与 Visa / Mastercard / JCB / 银联无隶属关系。

## License

AGPL-3.0（沿自主仓库）。
