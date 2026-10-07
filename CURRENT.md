# Phonecase Harness entry status

Updated 2026-10-07（Asia/Shanghai）。本页是该工作区的**唯一当前导航卡**，只做导航：指向监督目标卡、现行工程单、本轮交付与唯一检查点，**不承载任何量值/字段/预算副本**。

上一版（R7 导航）逐字节归档：`outputs/product-material-library-phase1-20261006/CURRENT-history-20261007-c0319fae3f49.md`，SHA256 `c0319fae3f49e18cd85010618e47448117fbbd77dbea16bc4c6e94367e6b827d`，3649 字节。

## 唯一入口（导航）

- 任务标题：`1006 | 功能 | 产品素材研究库第一阶段`。
- 监督目标卡（唯一动态监督入口；R 对执行端只读）：`R/outputs/phonecase-xmind-closeout-20260917/产品素材研究库-监督交接与当前目标卡-20261006.md`，章节「5.13 已批准完整下一步方案（R8）」；复审记录见 5.2/5.4/5.6/5.8/5.10/5.12。
- 现行工程单：**R8** `R/outputs/phonecase-xmind-closeout-20260917/产品素材研究库-第一阶段-Harness工程单-20261007-R8.md`（R1–R7 按原路径原文冻结）。同目录 `产品素材研究库-R8派单前-history-20261007.md` 是**历史件**，不是工程单。
- 唯一检查点（**唯一现场状态源**）：`outputs/product-material-library-phase1-20261006/CHECKPOINT.md`（R8 轮见 §20）。量值、指纹、验收视图与三项交付质量观察**只在检查点与报告中**，本卡不复制。
- 本轮报告：`harness-reports/1006-功能-产品素材研究库第一阶段-r7.md`（r1–r6 冻结不改）。
- 代码根：`tools/material-library/`（`cli.mjs` 含 `query`/`edit`/`export`/`restore`/`journey`/`media` 等命令）；测试：`tools/material-library/tests/`（`phase1.test.mjs`、`fixture-root.mjs`、`baserow-double.mjs` 替身、`r8-sequence.mjs` 顺序编排）；文档：`docs/product-material-library/`；输出根：`outputs/product-material-library-phase1-20261006/`。
- 环境前提包：`environment-plan.md`（`material-library-R7-env-v1`；旧版归档 `environment-plan-history-{ff28bc0a8264,f382e84f5392,ee42def786b7,68dff659eac6}.md`）。
- 代表输入清单：`representative-sample-r5.json`；媒体发布状态：`media/media-publication.json`（仅 `--serve` 期间为 published；未指定发布选项 ≠ 撤销既有链接）。
- R8 顺序证据：`evidence/r8-sequence.json`（同一持久隔离目标上 8 步真实 CLI）、`evidence/r8-adoption-check.json`、`evidence/r8-session-events.json`、`evidence/r8-r6-recovery-scan.json`。

## 边界（指针，正文以工程单/监督卡为准）

- 活动根：W=`D:/Codex-local/harness-workspaces/Phonecase`；R=`C:/Users/ahjxs/Documents/Codex/2026-08-24/new-chat/outputs/claude-to-codex-migration`（执行端只读）。`D:/Codex-local/phonecase` 仍是冻结只读历史。
- **Git**：W 是 Git 仓库（`main`、**0 提交**、8 项未跟踪）。`init`＋`.gitignore` 已由 Simon 批准**保留**（General 会话 seq1048 / seq1687），**不回退**；`stage`/`commit`/`push` **仍各自待批**。
- 本阶段新增 provider（TikHub/AI/媒体）请求 = 0；旧任务预算不迁入、不重置；共享账本 `tools/mcp-usage-ledger.md` 无写授权。
- 八平台普查保持**已验收/已关闭**：不重开、不改冻结工件、不重试 48 未知、不释放预占。配音保持 PAUSED_UNFINISHED。
- R8 未授权：主机安装/提权、镜像下载·传输·导入、共享配置/网络、凭据创建、Git stage/commit/push、云与调度；**也不得绕过报告写拒绝**（不得用 patch 脚本/路径拆写/换传输/关钩子）。
- 正式交回后流程：Codex 独立复审 → 完整下一步方案 → Simon 确认 → 派单；执行端不自行开始下一单。

## 本卡维护

- 由执行端按既有安全文档写入方式更新：上一版逐字节归档到任务输出根后原位替换（R8 `additional_path_semantics`）。
- 旧盘点的卡片守卫脚本 `logs/v526-check-current-card.mjs` 面向旧卡格式，本卡**不**改造它、也不以它校验本卡。
