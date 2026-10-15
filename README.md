# 独立站 Harness 入口

本目录（`D:/Codex-local/harness-workspaces/Phonecase`，侧栏名称 Phonecase）是**唯一活动工作根**：已授权代码、产出及本地任务记录写入限定在本根的获准路径。共享调用账本另按实际权限和工程单核对，本句不授权写入共享账本，也不允许以本地记录绕过计费前置。2026-09-19 已完成从旧 Cline 工作区的**复制式导入**（1186 文件 / 241,329,597 字节，0 冲突），并完成路径与运行假设修复。

`D:/Codex-local/phonecase`（侧栏名称 Phonecase-History）是**冻结的只读历史源**：原 Cline 研究目录，1188 文件 / 241,330,665 字节。迁移完成时逐文件核验**零变更**，纠偏期间零写入。仅在需要查阅历史证据时只读访问，**不得再写入**。

## 迁移与状态入口

| 内容 | 路径（均在活动工作根内） |
|---|---|
| 逐文件导入清单（源/目标 sha256） | `outputs/migration-0919/import-manifest.json` |
| 可读清单（含排除项与理由） | `outputs/migration-0919/IMPORT-MANIFEST.md` |
| 迁移报告 | `outputs/migration-0919/MIGRATION-REPORT.md` |
| 迁移前源快照 / 迁移后历史树完整性 | `outputs/migration-0919/pre-migration-source-snapshot.json`、`historical-tree-integrity.json` |
| 当前状态卡 | `CURRENT.md` |
| 流量端阶段报告（接手轮） | `outputs/traffic-local-10/report/REPORT-0919-harness-takeover.md` |
| 历史 TikTok 路线执行手册（仅在当前派单仍适用时使用） | `outputs/traffic-local-10/planning/RUN-PLAN-0919.md` |
| 迁移时十源状态矩阵（历史快照） | `outputs/traffic-local-10/ten-source-status-0919-newroot.json` |

## 当前业务状态入口

只以 [CURRENT.md](CURRENT.md) 的唯一现值卡、准确工程单版本与对应证据核对进展和剩余验收；有任务子卡时本入口只导航，不复制动态状态。历史迁移、旧网络阻断及旧计数从 CURRENT 的归档指针按需追溯，不把旧卡全文留在活动入口，也不据旧状态重启任务。正在执行的有效旧单在正常检查点衔接新版维护规则，不因格式整理停工或重复提交。

开发默认由 Harness 执行，Codex 监督验收；Cline 已退役。已有成果和相关失败经验须先复用，普通授权内问题连续处理，交回条件按全局规则。

## 运行与依赖

- 入口说明：`AGENTS.md` / `CURRENT.md` / 本文件。业务规则文件已随迁移进入本目录（`docs/history/Cline-AGENTS-20260917.md` 等为历史溯源，**不是**活动配置）。
- 外部只读依赖（可用环境变量覆盖）：FFmpeg/ffprobe 目录 `PHONECASE_FFMPEG_DIR`；Python 解释器 `PHONECASE_PYTHON`；历史账本夹具位于 `D:/Codex-local/docs/…`。
- **未导入**：`.clinerules`、Cline MCP 条目与 `autoApprove` 列表（见清单的排除项）。Cline 的 MCP、模型配置、历史会话和额度不会自动转入 Harness。
- 先核对当前派单的范围与授权；工作区可写不等于业务授权。
