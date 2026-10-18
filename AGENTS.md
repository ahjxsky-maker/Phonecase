# Phonecase independent-store Harness entry

Updated 2026-10-18. This is the active session/development root for the US phone-case independent-store project, not the phonecase-daily selection task in a Nezha child worktree. The dispatch determines the project, paths, phase and authority; similar names do not transfer business rules, budgets or state.

**新会话先读这里 →** `website/LESSONS-独立站执行经验与坑.md`（2026-10-18 整理的**可复用做法 + 已踩过的坑清单**：判据要测线上件、后台无媒体替换入口只能同 handle 重建、CSV 图片列会整体替换图库、集合选择器只点不打字、数字必须脚本化、复核与记账口径等）。它是**方法与坑**（相对静态）；**动态状态**仍以 `website/CURRENT.md` 为准，两者配合读，避免重复犯错。

**做图/写文案/发社媒前再读 →** `website/BRAND-品牌档案.md`（2026-10-18 建档：标志 `HUSK | FORM` 墨色/反白 SVG 与线上同哈希校验、**官方 tagline `Everyday, in good form.`**、首页三层话术原句、字体 Archivo/Assistant、色板 #3A3E44＋#F7F5F1＋#C9BBA0、6 个分类 handle 与款数、商品内容与价格规则、待定项）。

**续做素材面板 / 素材库 / MP-10 完整链 →** 先读 `docs/product-material-library/经验与坑-云端存储与素材面板-20261014.md` 的 **§12–§21**（2026-10-16/18 增补：资格判定 `qualificationOf()`+`pickAsset()` 与同源媒体路由、播放器定位守卫与竞态、**复核回执怎么写才不再被打回**、报告/机械门的四个新坑、Git 交付与凭据真相、Harness 工具层坑、**共享复核台账的坑（§19）**、**真实库逐字段指纹工具（§21）**、新会话最小启动包（§18））。任务动态状态看 `outputs/product-material-library-phase1-20261006/CHECKPOINT.md`（§24.295 起）与收尾报告 `harness-reports/1006-功能-产品素材研究库第一阶段-r16.md`。

## Scope and history

Read this file, the sole current card in CURRENT.md and the exact issued order path/revision with relevant evidence. Apply the global version/archive rules to nested task cards too: replace, never stack; workspace navigation points to the task card without duplicating dynamic state. Preserve evidence links and distinguish prepared from executor-confirmed versions. New authorized research, implementation and artifacts stay here under assigned paths. `D:/Codex-local/phonecase` (Phonecase-History) is frozen read-only history, never a write/execution root. Consult only history needed for a specific unresolved question.

The 2026-09-19 import was a verified copy, not a move: 1186 files, 241329597 bytes, zero conflicts/network/paid calls; the historical source was verified unchanged (1188/1188). Manifests, exclusions, hashes, pre-import snapshot and report remain in outputs/migration-0919/{import-manifest.json,IMPORT-MANIFEST.md,pre-migration-source-snapshot.json,historical-tree-integrity.json,MIGRATION-REPORT.md}. Imported docs/history rules are provenance, not active instructions or consent. Cline .clinerules, MCP/Auto Approve settings were not migrated into active configuration.

Keep business identity, supplier rights, unit economics, observations and unknowns separate. Candidate SKUs, sample media, fixtures or incomplete rights do not prove commercial readiness. Preserve accepted limitations; do not extend research into publishing, ads or business writes without authority.

## Execution and handback

Follow D:/Codex-local/deepseek-harness/home/AGENTS.md, especially “Execute and preserve the goal”, “Required detail reads”, “交付质量观察（沿用报告与CURRENT）” and “与 Codex 的衔接”. Read the detail reference only at its stated triggers; this project entry does not redefine the global loop, evidence standards, report format or authority.

The exact approved order supplies this package's outcome, acceptance, paths, allowed substitutions and cumulative budget. Use the original task checkpoint to choose the next executable acceptance gap, repair, verify through the actual caller, record evidence and continue. Ordinary technical steps do not need another dispatch. Preserve necessary independent review and release gates.

Follow this workspace's CURRENT navigation to the assigned task's existing sole checkpoint/handoff acceptance section, and retain its exact absolute path/section for startup and compaction recovery. Keep observations there and in the normal report, not in navigation, sibling tasks or imported history. Generated CURRENT files only point there; do not change their generator or a supervisor-owned card. File existence is not loading evidence.

At each business milestone, the designated independent reviewer (currently the read-only subagent_codex) performs acceptance review. After an evidence-backed PASS and closure of acceptance-blocking findings, continue the next milestone already covered by the approved plan and valid authority, without a fresh order or routine confirmation. Changed business criteria or authority still require Simon's decision. Preserve separately reserved gates. Ordinary work and repairs inside the milestone continue autonomously. No Codex-side edits or runtime/tool assumptions are authorized by this entry.

## 本地已有凭证与调用方式（直接可用）

本机凭据已配好、由 `启动-Harness.cmd` 注入；**不要再因为"以为没配"向 Simon 索要密钥**。唯一清单（名称/用途/调用方式，不含密钥值）：`D:/Codex-local/harness-workspaces/tools/CREDENTIALS.md`。

- 已注册的 MCP 工具按 `mcp__*` 前缀直接调用（Harness 侧是 `tikhub`，不是 Codex 侧的 `tikhib`）；缺工具通常是没用启动器启动，而不是密钥没配。
- 批量调 REST 用 `D:/Codex-local/harness-workspaces/tools/CredCall.ps1`；只读盘点用 `CredHelper.ps1` 的 `Get-CredInventory`（只报名称/可读性/长度，不打印值）。
- 读取密钥值、改共享配置、付费调用仍需该任务单独授权；本小节不授予这些动作。

## Integration routes

Use tools actually visible today. Historical setup (2026-09-19) exposed TikHub TikTok for traffic, Douyin/Kuaishou for comparison, and Sorftime. Follow the global launcher/namespace rules; Cline configurations are not live Harness capabilities.

Verify grants and cumulative usage in `D:/Codex-local/harness-workspaces/tools/mcp-usage-ledger.md` and applicable task budget records; do not pool or reset them. Setup: `D:/Codex-local/docs/harness-mcp-setup.md`; quick card: `D:/Codex-local/harness-workspaces/tools/MCP-QUICKSTART.md`; business selection guide: `D:/Codex-local/docs/tikhub-mcp-guide.md`. These pointers grant no calls, credential access, installation, shared configuration, Git publication, publishing, ads or production action.
