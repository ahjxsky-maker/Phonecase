# CURRENT — 产品素材研究库（本机面板）第一阶段

本卡是**本任务自己的**唯一导航卡，只做导航：指向监督目标卡、现行工程单、本轮交付与唯一检查点，**不承载任何量值/字段/预算副本**。

- 建立时间：2026-10-10（Asia/Shanghai）。按 Simon 当日指令：「换成这个新卡吧，这个是独立新的任务，不要带着老的历史进来了」——**旧卡（含其它任务的追加块与历史归档行）不带入本卡**；旧卡整卡逐字节归档在 `outputs/product-material-library-phase1-20261006/CURRENT-history-20261010-c1e5aa7f.md`（5821 B / `c1e5aa7f…ab54`），需要追溯时再读它。

## 唯一入口

- 任务标题：`1006 | 功能 | 产品素材研究库第一阶段`。
- 现行工程单（唯一授权来源，只读）：`R/outputs/phonecase-xmind-closeout-20260917/产品素材研究库-素材面板-Harness工程单-20261009-R13.md`（修订号 **MATERIAL-PANEL-M1-M5-R13**）。
- 监督目标卡（唯一动态监督入口；R 对执行端只读）：`R/outputs/phonecase-xmind-closeout-20260917/产品素材研究库-监督交接与当前目标卡-20261006.md`。
- 唯一检查点（**唯一现场状态源**）：`outputs/product-material-library-phase1-20261006/CHECKPOINT.md`（本阶段见 **§24.68–§24.103**；§24.103 起是收口清点与监督验收记录）。量值、指纹、验收视图与三项交付质量观察**只在检查点与报告中**。
- 本轮交付报告：`harness-reports/1006-功能-产品素材研究库第一阶段-r14.md`（覆盖 M1–M5 整包）。历史报告 r1–r13 按"字节冻结"保留、只作追溯，**引用状态一律以 r14 与检查点为准**。
- 机械门回执：`outputs/product-material-library-phase1-20261006/evidence/gate-r14-final.json`（exec-verify v0.1.18）。

## 本地实例与起停

- **面板（唯一入口）**：`node tools/material-library/panel-sqlite.mjs --serve --port 8792` → `http://127.0.0.1:8792`（读**本机单文件 SQLite**，无外部凭据，仅监听回环）。
- 只读媒体服务：`http://127.0.0.1:8791`（仅回环）。
- **Baserow 已转为只读归档**，不再是运行依赖、无需在 8080 起容器；如需重放导入：`outputs/product-material-library-phase1-20261006/r12/n1-migrate-to-sqlite.mjs --baserow-archive <store/archive/baserow-export-*.json>`。
- 已归档、不再作为入口：`tools/material-library/panel.mjs`（Baserow 实时读取版）。
- 操作说明：`docs/product-material-library/README.md` §8.6（面板与写入口径）／§8.8（拍摄计划 8 步操作 + 三段覆盖限度）。

## 状态与边界

- **里程碑**：M1–M5 均已按工程单完成，各有只读独立复核 PASS（M4 第二十三轮 `FINDINGS=0`；M5 第二十六轮判 MP-10／MP-11、第二十七轮判 MP-12 且 `FINDINGS=0`）。
- **整包监督结论：已接受**——第六轮监督验收 `SUPERVISION VERDICT: ACCEPT（FINDINGS=0）`；第一至第五轮的 REJECT 与逐条修复见检查点 §24.103.1–§24.103.10。**机械门 `verdict=PASS / exit 0`**（`envelope-scope` 10/10，回执 `evidence/gate-r14-final.json`）。
- **维护方待办（不阻断接受）**：① 把工作区根 `CURRENT.md` 单文件补入工程单 `authorized_roots`，完成后删除报告 §8.8 的临时报告侧信封并复跑留证；② 明确"门禁拒写时"的合法修复入口与责任人（执行端在此之前不自行绕过）。
- **未做且不在本单授权内**：新增采集、新凭据/provider、1688、日常调度/自启、云/发布/公开暴露、代理/防火墙/共享检查器改动、产品/版本迁移、破坏性重置或删卷、新 stage/commit/push/部署。
- Git：`main`，HEAD `0a3f3c68cd1b5d45f53d38d37a10f7872e6a0bc0`；本阶段未触碰 Git，改动全部保留为未提交状态。

## 本卡维护

- 只有本任务（产品素材研究库第一阶段）的当前状态写在本卡；其它任务不追加到本卡。
- 更新方式：先把上一版逐字节归档到本任务输出根 `outputs/product-material-library-phase1-20261006/`（文件名 `CURRENT-history-<日期>-<sha8>.md`），再原位替换。
