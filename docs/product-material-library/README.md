# 产品素材研究库 · 第一阶段（Phase A / P1–P4）操作说明

- 代码根：`tools/material-library/`（W = `D:/Codex-local/harness-workspaces/Phonecase`）
- 输出根：`outputs/product-material-library-phase1-20261006/`
- 运行时：Node **v24.13.0**（实测 `node -v`）
- Baserow 目标版本：**`baserow/baserow:2.4.0`**（固定，不追 latest）
- 规则版本：`material-library-rules/1.0.0`；适配器版本 `material-library-baserow/1.0.0`

> **当前状态（重要）**：本包已完成 P1 源合同与 P3 归一化/对账的可执行实现与自验；
> **P2 的真实 Baserow 实例在本机无法建立**（无容器运行时、非管理员、Docker 仓库不可达，
> 详见 `outputs/product-material-library-phase1-20261006/CHECKPOINT.md` §3）。
> 因此 A2/A5 的 Baserow 与 UI 验收为 **阻断/OPEN**，本包**不**声称 Baserow 已验证。

---

## 1. 本阶段范围

P1 字段/规则合同 → P2 底座验证 → P3 存量分类导入 → P4 研究视图。
P5–P9（每日采集、内容拆解、研究产出、云端部署、持续运行）**不在本包**。

数据源全部为已验收普查与既有本地媒体，**只读**。本阶段新增 provider 请求 = **0**。

## 2. 目录

```
tools/material-library/
  rules.mjs                 源合同、规则、可用性状态、比率口径、方法论归属、v5 字段合同对齐
  normalize.mjs             实体决策+覆盖层 → 成员名册；字段观测 → 归一化记录；媒体两级解析+类型守卫
  review.mjs                人工复核覆盖层（人工字段与来源事实分开保存）
  baserow.mjs               Baserow REST 适配器 + 合并/保留/去重语义 + schema/视图计划
  cli.mjs                   显式输入/输出/目标编排（field-contract 提取 / segments 校验 / journey 旅程）
  tests/phase1.test.mjs     82 项聚焦语义测试（含 R9 journey 只读/写入记账/导出双身份/恢复身份与计数）
docs/product-material-library/
  README.md                 本文件
  field-map.md              P1 源合同与字段映射（A1 交付物）
outputs/product-material-library-phase1-20261006/
  CHECKPOINT.md             唯一执行检查点
  normalized/               records.jsonl / reconciliation.json / gaps.json / summary.json / media-assets.json
  plan/                     baserow-schema.json / baserow-views.json / rules-config.json
  sample/                   代表性真实小样（12 条）+ 小样回执
  import/                   dry-run 回执；http 目标回执
  portable/                 可移植包 + 读回结果
  verify/                   self-check.json（35 项）
  deploy/baserow/           隔离本地 Baserow 启动配置（已备待用，未在本机执行）
  evidence/                 指纹、字段可用性矩阵、重构中间产物
```

## 3. 环境要求

| 项 | 要求 | 本机实测 |
| --- | --- | --- |
| Node | ≥ 20（用到 `node:test`、顶层 await） | v24.13.0 ✅ |
| 容器运行时 | Docker / Podman（Baserow 官方仅提供容器安装） | **缺失** ❌ |
| 管理员 | 不需要（本项目不授权主机级安装） | 否 |
| 端口 | 仅回环 `127.0.0.1:8080` | — |

## 4. 实际执行过的命令（argv / cwd / 结果）

cwd = `D:/Codex-local/harness-workspaces/Phonecase`

| # | 命令 | 实测结果 |
| --- | --- | --- |
| 1 | `node tools/material-library/cli.mjs normalize` | `records=8642 gaps=6632 main_v=8420 aid_v=222 reconcile_ok=true`；媒体 total=20 in_cohort=7 outside=13 |
| 2 | `node tools/material-library/cli.mjs plan` | `tables=4 views=6 pinned_image=baserow/baserow:2.4.0` |
| 3 | `node tools/material-library/cli.mjs sample --size 12` | `records=12 videos=12 metrics=484 assets=1`（目标为 memory，**非** Baserow） |
| 4 | `node tools/material-library/cli.mjs import --dry-run` | `planned={"Videos":8642,"Metric observations":65402,"Ratios":8642,"Assets":7}` |
| 5 | `node tools/material-library/cli.mjs import --target memory` | 首跑 `inserted=8642`；复跑 `inserted=0 updated=0 unchanged=8642`（零重复） |
| 6 | `node tools/material-library/cli.mjs export` | `tables=4 views=6` → `portable/material-library-bundle.json` |
| 7 | `node tools/material-library/cli.mjs verify` | `passed=18 failed=0` |
| 8 | `node tools/material-library/tests/phase1.test.mjs` | `pass 16 fail 0` |
| 9 | `node tools/material-library/cli.mjs import --target http --base-url http://127.0.0.1:8080` | **失败并如实回执**（无实例在监听，`fetch failed`，exit 3）→ `import/http-receipt.json` |
| 10 | `node tools/material-library/cli.mjs import --target http --base-url http://example.com` | **被拒绝**：`refused_non_loopback_target:example.com`（只允许回环，exit 1） |
| 11 | `node tools/material-library/cli.mjs review --entity-key "TikTok\|main\|7679078728667778337" --status reviewed --reviewer simon-selftest --category creative_reference --note "…" --select-reference true --based-on <fingerprint>` | 写入人工覆盖层；`human-review/review-overlay.json` |
| 12 | `node tools/material-library/cli.mjs apply --base-url http://127.0.0.1:8080` | **失败并如实回执**（exit 5）→ `apply/apply-receipt.json` |
| 13 | `node tools/material-library/cli.mjs field-contract` | `branches=9 field_rows=180 lines=224814` → `plan/field-contract.json`、`plan/field-contract.md` |
| 14 | `node outputs/product-material-library-phase1-20261006/crosscheck-media.mjs` | `checked=20 missing=0 path_mismatch=0 bytes_mismatch=0 sha_mismatch=0` |
| 15 | `node tools/material-library/cli.mjs segments` | `checked=84 reachable=84 unreachable=0` → `segments/seek-verification.json` |
| 16 | `node tools/material-library/cli.mjs plan` | `tables=5 views=13 pinned_image=baserow/baserow:2.4.0`（Segments 表 + 片段视图 + 平台/语言/日期/复核状态/分类缺口筛选视图） |
| 17 | `node tools/material-library/cli.mjs journey --platform TikTok --require-media true --setup-fixture` | 隔离演示：`chosen=TikTok\\|main\\|…`；标注→再导入 `inserted=0`、备注保留、`stale=false` → `journey/journey-transcript.json`。**R7 起 `--setup-fixture` 是必需开关**；不带它时旅程只做**只读查询**（R9 起 `--edit` 被显式拒绝），不写夹具 |

### 4.2 Baserow 媒体与片段衔接的能力核查（按官方文档，非运行实测）

- 官方 File field 文档列出可生成预览的类型含 **Audio/Video: `.mp3`/`.mp4`/`.webM`/`.ogg`/`.ogv`**，并可点击打开全屏预览 → 本库 20 条资产全为 `.mp4`，**面板内媒体查看属免费核心能力**。来源：<https://baserow.io/user-docs/file-field>。
- **「拖动到指定时间」未被官方文档记录 → UNVERIFIED**。按 R2 要求提供**必要的最小本地补充**并实测：
  - 用项目既有 FFmpeg 构建验证片段引用时刻在本地媒体中可达：**84/84 可达（退出码 0）、0 不可达**；
  - 人工到达某时刻的两种最小方式（不新增语义分析）：
    ```powershell
    # 方式一：导出该时刻的单帧查看
    & "D:\Codex-local\phone-case-video\.tools\ffmpeg-9.0.1-essentials_build\bin\ffmpeg.exe" -hide_banner -v error -ss <start_seconds> -i "<local_path>" -frames:v 1 "<out.jpg>"
    # 方式二：交给系统播放器后手动拖动到 t_label
    Start-Process "<local_path>"
    ```
  - 回执：`segments/seek-verification.json` / `.md`。
- **这条实测证明的是**「引用时刻在本地媒体中可解码到达」，**不**证明 Baserow 面板内可拖动播放；面板内行为仍未验证。

> 说明：`--target memory` 与 `--target http` 的区别是刻意的。memory 目标只用于验证
> **本适配器的合并语义**；它不是 Baserow，**不能**作为 Baserow 验收证据。
> `apply` 用真实实例建表/建字段/建视图；本机无实例，故其回执为失败，未获执行证据。

### 4.1 既有媒体路径的已知坑（实测）

`outputs/material-analysis-20-20260920/sample-manifest.json` 中 **9 条 TikTok 条目的 `media` 字段为 `null`**，
真实媒体路径记录在**卡**的 `media_evidence.file` 中。导入器按 `manifest.media.file → card.media_evidence.file`
两级解析。实测结果（`normalized/media-assets.json`、`verify/self-check.json`）：

| 项 | 实测 |
| --- | --- |
| 资产条目 | 20 |
| 路径已解析 | 20（其中 9 条经卡解析，11 条来自 manifest） |
| 文件在盘 | 20 |
| sha256 复核一致 | 20 |
| 解析为 `video` 类型 | 20（图像被误当作视频：**0**） |
| 路径为绝对路径 | 20 |
| 身份落在 V8420 主口径内 | 7（另有 13 条在口径外**单独标识**，不改分母） |

只按 manifest 读取会把 9 条误判为「无媒体」；只按卡回退则会把**抖音接触表(JPG)** 误当作视频
（成果总览「阅读陷阱」第 2 条）。两者都必须防，导入器的媒体类型守卫会显式拒绝非视频并记录
`kind_reject_reason`。

**路径绝对化（本包修复项）**：来源记录的是 cwd 相对路径，直接交付会让换 cwd 的消费者解析失败。
本库统一规范化为绝对路径并保留 `local_path_recorded` 原样值；修复前与归档索引比对有 10 处路径不符
（纯表示差异、字节与 sha 一致），修复后 **0 处不符**。

**独立交叉核对**：与归档期生成的 `素材调研-本地证据索引-20260921.json` 逐条比对身份/路径/字节/sha256 →
**20/20 一致**（脚本 `outputs/product-material-library-phase1-20261006/crosscheck-media.mjs`）。

## 5. 启动 / 停止 / 打开 Baserow（需先具备容器运行时）

```powershell
cd outputs/product-material-library-phase1-20261006/deploy/baserow
Copy-Item .env.example .env      # 填入 SECRET_KEY（命令见 .env.example 注释）
docker compose up -d
# 首次启动需等迁移完成，约 1–3 分钟；查看：
docker logs -f ml-baserow
# 看到 "Baserow is now available at" 后打开：
Start-Process http://127.0.0.1:8080
```

停止与数据：

```powershell
docker compose down            # 停止，保留数据卷 ml-baserow-data
docker compose down -v         # 同时删除数据（未备份时勿用）
```

明文口令不入库、不进报告；`.env` 不得提交。

## 6. 导入 / 读回 / 导出

```powershell
# 1) 结构先落地（幂等：重复执行复用既有表/字段/视图，不重复创建；既有视图会**补齐**缺失的过滤/排序）
#    需要两种鉴权：数据行用数据库 Token；建表/字段/视图用用户 JWT（--mgmt-token）
#    --database-id 必填：结构工作按库作用域列目录（GET /api/database/tables/database/{database_id}/，仅 JWT）
node tools/material-library/cli.mjs apply --base-url http://127.0.0.1:8080 --database-id 1 --token <DB_TOKEN> --mgmt-token <JWT>

# 2) 真实导入：样本 / 有限批次 / 全量是**三条不同命令**（--limit 显式选择输入，回执记录输入口径）
node tools/material-library/cli.mjs import --target http --base-url http://127.0.0.1:8080 --database-id 1 --token <DB_TOKEN> --mgmt-token <JWT> --limit 25
node tools/material-library/cli.mjs import --target http --base-url http://127.0.0.1:8080 --database-id 1 --token <DB_TOKEN> --mgmt-token <JWT> --limit 200
node tools/material-library/cli.mjs import --target http --base-url http://127.0.0.1:8080 --database-id 1 --token <DB_TOKEN> --mgmt-token <JWT>
#    → import/http-receipt.json（input_selection + per-table inserted/updated/unchanged/rejected/error/unresolved/skipped
#       + errors + post_write_reconciliation：写后按源主键/字段/关联对账）
#    → import/source-row-bindings.json（真实目标行 ID，不是合成序号）

# 3) 离线部分（无需实例）
node tools/material-library/cli.mjs plan
node tools/material-library/cli.mjs normalize
node tools/material-library/cli.mjs media          # 只读回环媒体适配器自检（--serve 持续服务）
```

### 4.3 R8：只读查询 / 显式身份绑定编辑 / 只读导出 / 从磁盘字节恢复

R8 把「查」与「改」彻底分开，并让**导出**只读、**恢复**必须消费磁盘字节：

```powershell
# ① 只读查询（消费**已存在**目标；不建表、不导入、不写覆盖层、不加默认备注）
node tools/material-library/cli.mjs query --target http --base-url http://127.0.0.1:8080 --database-id <DB_ID> --token <DB_TOKEN> [--mgmt-token <JWT>] [--product-category <C>]
#    → query/query-receipt.json（read_only=true / mutated=false / writes_performed=0 / hits / duplicate_keys / problems）
#    · 目标缺表 → 如实拒绝（exit 11，错误 target_schema_missing），**绝不建表**

# ② 显式编辑（身份必须来自查询命中 + 显式选择；内容/操作者/状态/证据都是**必填意图**）
node tools/material-library/cli.mjs edit --target http --base-url … --database-id <DB_ID> --token <T> `
  --entity-key "<entity_key>" --note "<原因>" --reviewer "<操作者>" `
  --product-category "<分类值>" --classification-state proposed --classification-evidence "<证据引用>"
#    · --query-product-category 等只用于**限定命中范围**（与写入内容分开）
#    · 无命中 / 身份不符 / 主键歧义 / 缺显式意图 → 拒绝（exit 12，writes_performed=0，**一行都不改**）
#    · 分类状态由 `--classification-state` 显式给出；**复核状态由 `--review-status` 显式给出**——
#      两者未给即**保留**目标既有值；工具**不会**代填 reviewed，也不冒充 Simon 复核
#    → edit/edit-receipt.json（identity_checks / intended / target_row_before|after / verification 逐项）

# ③ 只读导出（快照既有目标的五张表最终行；不导入、不建结构、不编辑、不复跑）
node tools/material-library/cli.mjs export --target http --base-url … --token <T> [--entity-key "<K>"] [--row-id <N>] [--bundle <PATH>]
#    · **同时**给出 row-id 与 entity-key 时必须指向**同一唯一行**；冲突即 exit 14（不伪造 selected-row 成功）
#    · 选中行会带全**三个分类基准**各自的 值/origin/reviewer/evidence_ref/state
#    → portable/material-library-bundle.json（schema/views/rules/**data** + snapshot 期望）、portable/export-receipt.json

# ④ 从**磁盘字节**恢复并逐项核对（默认恢复到 O/tests-tmp/restore-*，写前校验授权根）
node tools/material-library/cli.mjs restore --bundle <PATH> [--restore-into <DIR>]
#    · 核：五表键集合**与计数**、必需关联必须指向**身份正确**的那一行（不是“任意存在的行 ID”）、选中行的三个分类基准逐字段、
#      资产/片段的身份与 URL/发布状态一致
#    · 截断 JSON / 缺行 / 分类值或来源被改 / 媒体 URL 被改 / 链接指向别的行 / 计数不符 → exit 15 且**显式失败**（不回落内存数据）
#    → restore/restore-receipt.json（bundle_sha256 + 五表键集合/计数 + 关联 + 选中行逐字段 + 媒体链接）
```

- **隔离验证用的传输替身**：无真实 Baserow 时，可用 `ML_TRANSPORT=baserow-double` 指向回环 Baserow 形状替身（严格
  2.4.0 行/结构形状，状态存 JSON 文件 → **多次 CLI 调用共享同一目标**）。此时回执一律 `baserow_verified=false`
  并在回执里写明「传输被替代」，**不得**当作 Baserow 验收。
- **`baserow_verified` 的语义（R12 修复，原为硬编码 false）**：该字段现在表示「**本次运行是否真的对真实 Baserow 完成过一次读取**」：
  · 回环替身（`ML_TRANSPORT=baserow-double`）→ 恒 `false`（不是 Baserow 实例）；
  · `--target memory` → `false`（只验证适配器语义）；
  · `--target http` 且真的读到表/字段（只读命令）或 ping 到真实版本（import）→ `true`，并带
  `verification_method` 与 `verification_at`；目标打不开的“如实拒绝回执” → `false`（本次什么都没验证）。
  前态证据：修复前真实 Baserow 跑出的回执也是 `false`（如 `r12/export-final/portable/export-receipt.json`）；
  修复后对照证据：`evidence/r12-transport-verified-fix.json`（真实库→true / 无凭据拒绝→false / memory→false）。
  已知小瑕疵（未修，登记）：`--target memory` 的回执里 `transport` 仍显示 `baserow_http`（该字段只看 `ML_TRANSPORT`，不看 `--target`），
  区分目标请用回执里的 `target_mode`。
- **旅程（`journey`）是纯只读路径**：消费既有目标并给出「身份解析 + 详情/媒体 + 问题列表」回执（`writes_attempted=0`）。
  **R9 起 journey 不再有任何写入路径**：传 `--edit` 会在**任何写入之前**被显式拒绝（exit 16，`journey_edit_removed`）并指向独立的
  `edit` 命令——不静默忽略、也不保留第二条公共写入路径。需要写入请用：
  `cli.mjs edit --target http … --entity-key/--row-id … --note … --reviewer <操作者> [--review-status unreviewed|in_review|reviewed|rejected] [--product-category … --classification-state … --classification-evidence …]`
  · **复核状态不会被自动写成 reviewed**：只在显式给出 `--review-status` 时才写，否则**保留**目标既有值（加备注/加提案 ≠ 已复核）；
  分类值必须带 `--classification-evidence`；`--classification-state` 可选，未给则保留既有状态。
  · 回执把**写入状态与读回验证分开记账**：`writes_attempted` / `writes_performed`（=被接受）/ `writes_confirmed` / `uncertain_outcome` / `mutation.state`
  （`refused` | `not_written` | `unknown_write` | `written_unverified` | `written_but_mismatched` | `confirmed`）。
  隔离夹具演示仍是 `--setup-fixture`（只写 `fixtures/journey-overlay.json`，绝不碰正式覆盖层，也不做目标侧编辑）。

**鉴权与路由（F2 修复，已按官方 2.4.0 核对）**：
- 数据行读写：`Authorization: Token <数据库 Token>`；建表/字段/视图：`Authorization: JWT <用户 JWT>`。官方原文「Database tokens only allow reading or manipulating the data of a table. If you want to create, update or delete the structure of the table, you need a JWT token.」JWT 由 `POST /api/user/token-auth/` 取得。
- **JWT 时效**：官方两页分别记 **7 分钟** 与 **60 分钟**（冲突）→ 本库按短时效处理，**不缓存不落盘**，401/403 时给出「重新取用后立即 apply」提示。请在 `apply` 前即时取得 JWT。
- **`--database-id` 必填**（建表需要）；缺失时明确报错，不会去撞不存在的路径。
- **路由已离线核对官方固定版 OpenAPI**：`evidence/baserow-openapi-schema.json`（`info.version=2.4.0`，来自 <https://api.baserow.io/api/schema.json>），自检 `baserow_routes_exist_in_pinned_spec` 保证 19/19 客户端路由存在。
- **两种列目录端点按鉴权分开（R4 / F2a）**：结构工作用 `GET /api/database/tables/database/{database_id}/`（官方规范 security **仅 JWT**，按库作用域，杜绝跨库同名表被复用）；`GET /api/database/tables/all-tables/` 的 security **仅 Database token**，只用于令牌范围内自查，**不**用于结构判定。仅持数据库 Token 时调用前者会明确报 `list_tables_in_database_requires_jwt`。
- **视图过滤/排序按类型编码（R4 / F2b）**：`single_select` 过滤值发**选项 ID**（解析不到就记为 unresolved 并拒绝，不拿 label 冒充）；布尔发 `'true'/'false'`；`not_empty`/`empty` 发空值。既有视图会读回 filters/sortings 做差集补齐，**同名不再直接跳过**（可修复“建视图后、配过滤前中断”的复跑）。
- **写入契约（R4 / F1a、F1b）**：更新失败后**必须按写入意图逐字段读回比对**——旧行仍在但值没变 = **确定性失败**，不得报 updated；读回也失败 = `unresolved`（不确定），同样不得报成功；写入只发**可写意图**（丢弃 `id`/`order` 等只读字段，`file` 字段不在行写入里伪造，空 `link_row` 不发以免清空既有关系）；读回把 API 形状（select 对象、link 对象数组）解码为逻辑值。正常完成后按**源主键/接受字段/关联目标**做写后对账；父行未写入时子行**不写**并带 `parent_row_not_written` 原因，避免孤儿“成功”。计划内主键重复会在写入前报 `duplicate_primary_key_in_planned_payload`。

**基线与顺序**：先**代表样本**（`--manifest representative-sample-r5.json`：跨平台/长 ID/中文/媒体覆盖）→ 再有限批次（`--limit 200`，按文件顺序前 N 条，**不是**代表样本）→ 再全量。`Videos` 先于其它表（关联依赖它），`Assets` 先于 `Segments`。
**重复目标键（R6）**：目标里同一主键出现多行时，`importRecords` 在折叠进 Map **之前**保留身份并**阻断**这些键及其依赖子行的写入（不选赢家、不删除、不静默重绑），回执记 `blocked_ambiguous_writes` 且 `ok=false`；不受影响的独立键继续处理。
**目标侧人工编辑（R6 / R9 路径归位）**：人工判断必须写**目标 backend**（`applyTargetEdit` → `updateRow` → 复读逐项核对）；只改源侧覆盖层不会改变既有目标行（人工字段保护策略会挡回），因此不作为“编辑已生效”的证据。R9 起这条写入路径**只**存在于独立的 `edit` 命令里（`journey` 已改为纯只读并显式拒绝 `--edit`）；`applyTargetEdit` 的复核状态与分类状态**只在显式给出时**才写，否则保留既有值，且回执把“被接受”“读回一致”“不确定”分开记账。
**绝对媒体链接（R6 / R7 三态）**：`media --serve --port <N>` 会写 `media/media-publication.json`（state=published/base_url）；随后 `import --media-base-url <loopback url>`（或读该发布文件）会把**绝对**链接写入 `Assets.media_view_url` / `Segments.view_url`，用户点击即达；未发布时显式 `media_service_state=not_published` 且不产生坏链接。R7 起 `mediaBaseUrl` 是**三态**，避免“没配发布”被当成“撤销发布”：
- **显式发布**：`--media-base-url http://127.0.0.1:<port>`（或发布记录 `state=published`）→ 写绝对链接 + `published`；
- **显式停止发布**：`--unpublish`（或 `--media-base-url ""`，或发布记录 `state=not_published`）→ 清除链接 + `not_published`；
- **未指定**：两者都没有 → **保留**目标行里已有的发布字段，回执记 `media_service.semantics=unspecified_preserve_existing_target_links`，且把“本次载荷本会撤销但被保留”的字段记进 `media_publication_preserved`。
`journey`（含其内部两次导入）与 `import` 共用同一解析，因此旅程复导入不会再清空已发布链接。

**幂等**：同一输入复跑零新增（实测 8 642 条首跑、复跑 `inserted=0`）。
**人工字段**：`review_*`、`selected_reference`、以及 F4 的产品/功能/场景分类字段永不因导入被覆盖；来源证据变化时保留文本、仅将 `review_stale` 置真。
**中断恢复**：重放前先读回并按主键去重，只补缺失行。

### 6.0 人工分类与测试标注隔离（R3 / F4、F5）

- **F4 人工分类**：`product_category` / `product_function` / `scene_or_need` 的来源值恒为 `unknown`（普查未留存）。人工可赋予有效值，但**必须**同时提供复核人与证据引用，否则命令直接报错拒绝；有效值旁附 `*_origin`（`source_value` / `human_review` / `unknown_no_source`）、`*_reviewer`、`*_evidence_ref`、`*_state`（`proposed` / `reviewed` / `rejected`），UI 可据此区分**来源事实**与**人工复核**。执行端提出的分类标为 `proposed`，**不**冒充 Simon 已复核。
  ```powershell
  node tools/material-library/cli.mjs review --entity-key "<key>" --reviewer "harness-executor-proposal" `
    --product-category "手机壳（豹纹压纹背板）" --product-function "未知（被检范围内未演示任何功能）" `
    --scene-or-need "审美静物展示" --classification-state proposed `
    --classification-evidence "<卡路径>#timeline[0].observed"
  ```
- **F5 隔离**：`journey --setup-fixture` 才写**隔离夹具**覆盖层（默认 `outputs/.../fixtures/journey-overlay.json`，可用 `--overlay <path>` 指定）；不带该开关时旅程**不写任何覆盖层**（真实用户路径）。**测试身份**（`journey-selftest` 等）写入的条目**永不算**人工精选。清理并归档既有测试标注：
  ```powershell
  node tools/material-library/cli.mjs archive-test-annotations
  # → human-review/review-overlay-selftest-archive-<ts>.json（逐字保留，不删除）
  # → human-review/selftest-archive-receipt.json
  ```

## 6.1 研究面板视图与用户旅程

- 视图计划 **15 个**（`plan/baserow-views.json`），显式覆盖要求的筛选维度：**平台**（按平台：TikTok 可切换）、**语言**（语言已明示）、**日期**（发布日期已明示 + 倒序）、**复核状态**（未复核 / 人工精选 / 证据变化待复核）、**产品类别**（`按产品类别检索（人工分类）`、`人工分类：待复核提案`），另有**无过滤总览**保证 unknown 不被隐藏、以及**分类待补**视图让无来源支持的分类缺口保持可见。
- **产品/功能/场景筛选**：来源未留存这些字段 → 缺省 `unknown`（视图 `分类待补（unknown 可见）` 保持缺口可见）。**带证据的人工/执行端分类**一经写入（用 `edit` 命令），即可用 `按产品类别检索` 视图或只读的 `cli.mjs journey --product-function …` 检索到；不批量杜撰、不设填充数量目标。
- **不提供跨平台排名**：平台视图只是分列查看，不构成可比性结论。
- **用户旅程**（`cli.mjs journey`）在真实留存记录上执行**只读**链路并留回执：**产品/需求检索条件 → 匹配行 → 详情证据 → 现有媒体/片段 →（显式可选）隔离夹具准备**。命中来自**目标库行**（`lookupTarget` 读 backend），回执含 `target_row_snapshot`（选中行的身份 + 三个人工字段 + 三个分类基准的 值/origin/reviewer/evidence_ref/state）。
  - **R9 起旅程是纯只读命令**：它**没有**目标侧写入路径——传 `--edit` 会在任何写入之前被显式拒绝（exit 16，`journey_edit_removed`）并指向独立的 `edit` 命令。写目标行请用
    `cli.mjs edit --target http … --entity-key/--row-id … --note … --reviewer … [--review-status …] [--product-category … --classification-state … --classification-evidence …]`；
    该命令**未显式给状态就保留既有状态**（加备注/加提案 ≠ 已复核），并把 `writes_attempted` / `writes_performed` / `writes_confirmed` / `uncertain_outcome` / `mutation.state` 分开记账。
  - **R7 起夹具准备是显式动作**：默认**不**写隔离覆盖层；只有 `--setup-fixture` 才做「分类提案 + 夹具人工编辑」这一**隔离演示**（写 `--overlay`/默认 `fixtures/journey-overlay.json`，**不碰正式覆盖层、也不做目标侧编辑**）。在**已填充的真实目标**上，旅程仍要求既有目标行的人工状态、行 ID 与命名空间在后续导入后**原样保留**（`prepopulated_target_row`）；把上一次的目标状态覆盖成新夹具备注是**错误**行为。
  - **分类编辑只写契约字段**：`product_category` / `product_function` / `scene_or_need` 三个**值**字段，外加既有的 `*_origin` / `*_reviewer` / `*_evidence_ref` / `*_state`；`state`、证据、复核人在 API 里是**元数据**，不会被当成 `state` / `state_origin` 之类新字段写进行（回执记 `ignored_classification_keys`）。请求的**值、状态与来源**三者都会逐项核对——只保留来源元数据却丢掉值的 backend 必须**判失败**。
  - 复现路径（同一已填充目标上的顺序链）由 `tests/phase1.test.mjs` 的 `R7-STEP2` 用例覆盖：只用**真实** `createHttpClient`/`createHttpBackend`/`encodeWritePayload`/`decodeApiRow`，**仅** mock 外部传输（严格 API 形状：`single_select={id,value}`、`link_row=[{id}]`、未知字段名 400）。
  - 这仍是**数据链路执行，不是 Baserow 面板 UI 验收**。
- **媒体入口（R5 / STEP4）**：`cli.mjs media` 起一个**只读回环**服务，提供**可操作的点播与定位入口**：
  - 路由（记录里的相对路径，绝对地址由实际监听端口发布）：`/viewer?asset=<asset_id>&t=<seconds>`、`/media/asset/<asset_id>`（支持 `Range` 206，浏览器才能 seek）、`/media/asset/<asset_id>/segment/<index>`、`/media/index.json`。
  - 记录侧链接：`Assets.media_view_path` / `Assets.media_seek_seconds` / `Segments.view_path` 与该路由**同一套**，因此「记录 → asset → segment → 入口」身份连续。
  - **启动（长驻，直到你结束它）**：`node tools/material-library/cli.mjs media --serve --port 8791`
    然后把 `Assets.media_view_path` 的相对路由接到 `http://127.0.0.1:8791` 上打开；`t` 为片段起始秒（非零即定位点）。
  - **停止**：在该终端按 `Ctrl+C`（或结束该 node 进程）。**恢复**：重新执行上面的 `--serve` 命令即可，端口可复用；只读，不改动任何原始媒体。
  - **自检（不是交付的观看服务）**：`node tools/material-library/cli.mjs media`（不带 `--serve`）会做一次真实回环自检后关闭，回执里明确写 `process_lifetime=self_check_then_exit`。
  - 缺文件 → `410`、非视频当视频取 → `415`、未知资产 → `404`，均显式说明；不做公网监听、不下载、不转码。
  - **浏览器内真实播放/seek（R6 实测）**：R6 用本机 MCP 打开 viewer 页面实测：请求起点 3.056s 时 `currentTime=3.056`、`duration=7.333`、`readyState=4`、`error=null`；播放 1.8s 后 `currentTime=4.816`（`paused=false`）；再 seek 到 6.111s，0.9s 后 `currentTime=6.959` → **播放前进与非零 seek 均观测到**。证据：`media/playback-observation-r6.json`（执行端观测记录；协调方未收到原始 MCP 返回，转录不等于独立测量），R5 轮那次 `UNVERIFIED` 保留在 `media/playback-observation-r5.json` 作为历史记录。
  - **超时原因订正（R7）**：R6 曾把 R5 的多次超时写成“连接层问题”。**当前** Chrome 在跑且 `127.0.0.1:9222` 在监听，**并不能证明过去那些超时的原因**——真实原因按现有证据为 **UNKNOWN**；本轮未再发生超时，也不据此重跑或改配置。R7 已尝试在本任务历史中定位原始 MCP 工具返回（见报告 §4/§8）。
  - **边界**：以上是**本机回环观看入口**的真实播放/seek；**不等于** Baserow UI 内的播放（仍 OPEN），也不等于任何语义复核。R6 的 MCP 未向受限 workspace 之外写文件（截图请求被该 MCP 的 workspace 限制拒绝，故以页面内实测数值为证据）。

### 6.2 代表身份清单（R5 / STEP3）

- `node tools/material-library/cli.mjs sample --size 25` 会写出 `O/representative-sample-r5.json`：
  `{version:1, entity_keys:[…], coverage:{…}}`。选择规则是「跨 platform|namespace 分组 → 优先含片段/长 ID/中文/来源不可用/有媒体/观测最多 → 跨平台轮转补齐」，**不是** `records.slice(0,25)` 那种文件前缀。
- 用同一 HTTP 导入消费该清单：
  `node tools/material-library/cli.mjs import --target http --base-url … --database-id <DB_ID> --token <DB_TOKEN> --mgmt-token <JWT> --manifest <W>/outputs/product-material-library-phase1-20261006/representative-sample-r5.json`
  本地无实例时可用 `--target memory` 走同一解析路径验证（回执里 `input_selection.source=manifest:…`）。
- 未知键 / 重复键 / 形状不符 → **显式报错**（`invalid_sample_manifest:…`），不合成替代、不自动扩张为全量；`--manifest` 与 `--limit` 互斥。
- 目标库查询是**只读**的：`journey.mjs#lookupTarget` 消费所选 backend 的行并报告目标行 ID/entity key/query，不调用 `setReview`、不改覆盖层与行；`filterByNeed` 只是内存谓词，**不是**数据库查询的证据。

## 7. 自验与局限

- `cli.mjs verify` 的 **35 项**覆盖：V8420/aid222 对账、**与 r629 的 216 字段行逐字段对账**、长 id（>2^53）无损、
  身份与保留证据逐字符一致、命名空间隔离、缺失≠0、缺失不带值、不支持比率无分数、同观测比率、
  缺媒体显式、缺口带原因、既有媒体解析+哈希+绝对路径+图像守卫、**事实来源分层与 error 状态自洽**、
  **联合可用性实测非构造**、**片段引用带来源/种类且时刻本地可达**、
  **P4 筛选维度覆盖**、**指标定义齐备且不声称跨平台可比**、**用户旅程回执完整**、v5 含义对齐完整、
  复跑幂等、人工备注保留、证据变化失效、中断恢复、平台/命名空间不匹配拒绝。
- 局限（**必须随结果一起读**）：
  > **R11 更正（2026-10-07）**：下列第 1–3 条描述的是 R11 **之前**的状态；本轮已在**本地真实实例 + 固定 25 条小样**范围内实测打通（见 §8），因此“未验证”现在只对**全量 8642 / 其他范围**成立。第 8 条（面板内拖动到片段时刻）仍 OPEN，R11 用的是**外部本地只读查看器**的非零定位，不是 Baserow 原生内嵌播放。
  1. Baserow 实例、原生筛选/关联/文件预览、中文与长 id 在真实库中的行为 —— **未验证**（无运行时）。
  2. UI 用户流程（P4/A5）—— **未验证**。
  3. `--target http` 与 `apply` 的请求路径未对真实实例执行过（已执行但失败，属失败证据）。
  4. 6 632 条成员无任何字段观测（来源不可用），已显式入库而非丢弃，但其字段为空。
  5. 产品类别/功能/场景无来源支持 → 全部 `unknown`。
  6. `geography_or_region` 在普查层是**合并槽位**，而 v5 已证 `query_region`/`author_region`/`audience_region`/`location_tag`
     是四个不同语义 → 归属保持 `unknown`，**不得**默认当作受众市场；另有 6 个普查字段在 v5 中无等价槽位。
  7. 既有分析卡来自有限帧/ASR 抽样，本库只引用其时间点与来源，**不**声称全片已看/已听，也不新建语义分析。
  8. **Baserow 面板内拖动到片段时刻未验证**；已提供并实测最小本地补充（84/84 可达），但面板内行为仍 OPEN。
  9. 真实留存数据上 `error` 状态实测为 **0** 条（无值违反类型/单位契约）；该路径由安全隔离反例验证，不是未实现。

## 8. R11 真实小样面板（实测，2026-10-07）

本节记录**本地真实 Baserow 实例上跑通的最小代表小样**（25 条固定身份），以及与之配套的安全用法。

### 8.1 样本位置与结构

- 工作区 `产品素材研究库-R11`（id 661）→ 库 `产品素材研究库-R11小样`（id 661）。
- 五表：`Videos` 1354 / `Segments` 1355 / `Metric observations` 1356 / `Ratios` 1357 / `Assets` 1358；视图共 20 个（Videos 13、Segments 3、Metric 2、Ratios 1、Assets 1）。
- 浏览器入口（仅回环）：`http://127.0.0.1:8080/database/661/table/1354/4126`。
- 每张表另有 **2 行 Baserow 建表自带的空主键占位行**（无身份主张，工具不删除、只在回执里登记 `empty_primary_key_rows`）。
- 覆盖（与清单一致）：25 身份 / 8 平台 + `Bilibili|aid` 单列 1 条 / 16 个长 ID / 11 条中文 / 1 资产 12 片段 / 1819 指标 / 25 比率；其中 9 条来源不可用（`entity_source_state=source_unavailable`，unknown 可见）。

### 8.2 命令（**令牌走文件/环境变量，不进 argv**）

```bash
# 0) 凭据文件（受 ACL 限制、被 .gitignore 排除；值不回显）
#    O/deploy/baserow/.task-credentials.json = { base_url, database_id, db_token, jwt, refresh_token, ... }

# 1) 结构 + 真实导入（幂等：重复执行复用表/字段/视图并补齐缺失的过滤/排序）
node tools/material-library/cli.mjs import --target http \
  --creds-file outputs/product-material-library-phase1-20261006/deploy/baserow/.task-credentials.json \
  --manifest outputs/product-material-library-phase1-20261006/representative-sample-r5.json \
  --media-base-url http://127.0.0.1:8791 \
  --out outputs/product-material-library-phase1-20261006/r11/runs/full1

# 2) 只读查询（消费既有目标；不建表、不导入）
node tools/material-library/cli.mjs query --target http --creds-file <同上> --out <OUT>

# 3) 本地只读媒体服务（手动起停；退出后链接状态应显式改为未发布）
node tools/material-library/cli.mjs media --serve --port 8791
```

- 也支持环境变量：`ML_BASE_URL` / `ML_DATABASE_ID` / `ML_DB_TOKEN` / `ML_MGMT_TOKEN`；显式 argv 优先，其次 `--creds-file`，再次环境变量；回执只记**来源**与“是否存在”，不记值。

### 8.3 Baserow 2.4.0 的真实编码事实（都是实测 400 换来的）

| 事实 | 正确做法 |
| --- | --- |
| 行写入的 `single_select` | 发**选项值**（如 `observed`）；发选项 ID 会被拒 `The provided select option value '3898' is not a valid select option.`。视图**过滤**则必须用选项 ID —— 两者不混用 |
| `number` 字段 | 建字段时显式声明小数位（本项目 `decimals: 6`）；写入前把二进制浮点噪声（`0.6110000000000001`）收敛到 6 位 |
| `date` 字段 | 要存时间戳必须 `date_include_time: true`，否则只收 `YYYY-MM-DD` |
| `url` 字段 | 只收绝对地址；来源里的相对路径/裸 ID（`DddloSbTQoI`、`BV1jkYr6hEDF`）原样存进并列文本字段 `*_recorded`，**不**拼接域名 |
| 读回比较 | number 字段读回是**字符串**（`"7.334000"`），按数值语义比较，避免每次复导入都误判为“需要更新” |
| 建表 API | 新表自带 2 行空主键占位行；重复判定必须忽略它们（但要登记行 ID） |

### 8.4 本轮实测结论（自验，非业务验收）

- 25 条真实身份导入后 `ok=true`；同源**复跑零新增**（全部 `unchanged`，0 重复、0 错误）。
- 独立读回：计数 25/1/12/1819/25、16/16 长 ID 字符串精确、9/9 来源不可用、11/11 中文、aid 单列、806 条 `absent` 可见、关联全部解析。
- 浏览器：`按平台：TikTok（可切换）` 只显示 4 条 TikTok；`语言已明示`/`发布日期已明示`/`未复核记录`/`分类待补（unknown 可见）` 过滤字段正确。
- 媒体：从 Segments 行的 `view_url` 打开**外部本地只读查看器**（不是 Baserow 原生内嵌播放）：`<video>` 播放中 currentTime 0.611→3.051 s，可非零定位。
- 人工备注：原生 UI 在 Videos 行 id=3（`TikTok|main|7679078728667778337`）的 `review_notes` 写入备注 → 普通同源复导入后仍在 → 刷新浏览器后仍在。
- **仍未验证**：全量 8642、F1–F3、Baserow 原生文件字段上传、证据变化触发的 `review_stale` 路径、开机自启。

### 8.5 起停与“打不开”排查（R11 交回后实测补充）

**为什么会打不开**：本实例跑在专用 WSL 发行版 `Ubuntu-24.04` 里；**该发行版在最后一个 `wsl` 会话结束时就会停止**，容器随之停止 → `127.0.0.1:8080` 无监听 → 浏览器报连接失败。这不是数据丢失。

```powershell
# 1) 打开发行版并【保持这个窗口开着】（关掉窗口 = 服务停）
wsl -d Ubuntu-24.04

# 2) 等 1–3 分钟：非正常停止后嵌入式 Postgres 要恢复重放，恢复期页面可能仍连不上（预期）
#    想主动确认，另开一个窗口执行：
wsl -d Ubuntu-24.04 -u root -- docker ps          # 期望看到 ml-baserow Up ... 127.0.0.1:8080->80/tcp

# 3) 容器不存在时（执行过 docker compose down）才需要重新拉起：
wsl -d Ubuntu-24.04 -u root -- docker compose -f /mnt/d/Codex-local/harness-workspaces/Phonecase/outputs/product-material-library-phase1-20261006/deploy/baserow/docker-compose.yml up -d

# 4) 浏览器打开（仅回环）：
#    http://127.0.0.1:8080  → 用【你本人的管理员账号】登录 → 工作区「产品素材研究库-R11」
```

- 片段定位播放需要本地只读媒体服务（手动起停；它是 Windows 侧进程，不受 WSL 停止影响）：
  ```powershell
  cd D:\Codex-local\harness-workspaces\Phonecase
  node tools/material-library/cli.mjs media --serve --port 8791      # 停止：Ctrl+C 或结束该 node 进程
  ```
- 权限：Simon 的管理员账号已被加入 `产品素材研究库-R11`（ADMIN）。若登录后**看不到**该工作区，说明加入动作未生效或登录了别的账号，请先确认账号。
- 停止服务但保留数据：在 compose 目录执行 `docker compose down`（**不要**加 `-v`）。

### 8.6 本地“素材面板”（**自研 SQLite 版：panel-sqlite.mjs**；R12/N1–N2）

用一个**中文本地小页面**代替“让人去翻 5 张表 / 20 个视图”，并且**业务修改不再需要打开 Baserow 重界面**：
左边一列素材 + 顶部筛选，点一条，右边出详情（播放器 + 片段时间轴 + 片段清单 + 指标摘要 + **人工复核/人工分类编辑卡**）。
**当前唯一入口是 `panel-sqlite.mjs`**（读本机单文件 SQLite，不依赖 Baserow 凭据）。

```powershell
# 启动（手动起停；只监听 127.0.0.1；不需要任何外部凭据）
cd D:\Codex-local\harness-workspaces\Phonecase
node tools/material-library/panel-sqlite.mjs --serve --port 8792
# 浏览器打开： http://127.0.0.1:8792
# 媒体（只读文件服务，与面板分开）：node tools/material-library/cli.mjs media --serve --port 8791
```

> **已归档（不再是入口）**：`node tools/material-library/panel.mjs --serve --port 8792` 是 Baserow 实时读取版，**已被 `panel-sqlite.mjs` 取代**；仅作为回退/历史路径保留，不要再作为启动指引使用。其审计写入的 `evidence/r12-panel-edits.jsonl` 与 `deploy/baserow/.task-credentials.json` 也只属于该归档版本。

- **数据来源＝本机单文件 SQLite 库**（`outputs/product-material-library-phase1-20261006/store/material-library.sqlite`，WAL；Node 内置 `node:sqlite`，无第三方依赖、无外部凭据）。素材 8,642／可浏览 1,934（T1+T2+T3）／缺口 6,630。**读取失败照样不拿旧快照冒充**（`panel_version=panel-sqlite-v1`、`source=sqlite_store` 可在 `/api/summary` 自证）。
- **筛选**（按 R12 第 35 行）：关键词 / 平台 / **发布日期范围（起止）** / **日期未知** / 来源状态 / 复核状态 / 仅有本地媒体 / 仅有片段 / 仅有备注；**默认排序＝行业优先级**（分档 T1→T3 → 有本地视频 → 播放量高→低 → 片段多→少 → 关键数据多→少 → 发布时间新→旧），下拉可切「发布时间 / 播放量」（F-06 更正：此处原写「默认按发布日期倒序」，与 `default_sort=industry_priority` 不符）；日期未知的显示“—”。
- **本机 SQLite 库是唯一仓库**：面板只是操作面；**Baserow 已转为只读归档**（容器与数据卷保留、不再作为读写依赖）。没有第二个数据库、没有第二份真值。
- **可改的只有“人工字段”**（白名单见 `panel-sqlite.mjs` 的 `HUMAN_FIELDS`，25 项）：复核状态 / 复核人 / 复核日期 / 人工备注 / 价值分类 / 三个分类值及其 `_origin`、`_state`、`_reviewer`、`_evidence_ref`、陈旧标记等。**采集所得字段（身份、指标、片段）在页面里是只读的**，防止人工值被覆盖。
- **写后必回读**：保存时服务端 UPDATE → 再读回同一行 → 逐字段比对（布尔按库内编码 0/1 比较）；一致才显示“已确认”，不一致显示差异并照实登记。**审计写在库内 `edits` 表**（服务端 `GET /api/edits` 可查），**不再写 `evidence/r12-panel-edits.jsonl`**（那是已归档的 `panel.mjs` 的行为）。
- **日期字段精度**：`review_reviewed_at` 带时间（`date_include_time=true`），面板按 **UTC** 显示到秒并原样写回；比较时忽略小数秒，因此“只改秒级”不会误报不一致（若原值含小数秒而用户确实改了日期，小数秒会归零）。
- **时间轴**：12 个刻度按片段起点在总时长上的百分比排布（此前所有刻度重叠在起点）；实测点第 0/3/5/11 个刻度与片段表“定位”按钮，播放位置与目标秒数**完全一致**（`evidence/r12-m2-browser-seek.json`）。
- **写入门槛（R-12/R-6 更正）**：**没有“代表清单 25 条身份”白名单**——那是 R11 的 Baserow 期口径，SQLite 面板**不对身份设限**：库内任意存在的 `entity_key` 都可写（不存在 → 404），非白名单字段 / 非法选项 / 非法日期 / 空负载一律 400。实际操作范围由**操作者显式选择**决定（详情卡单条、批量条勾选、键盘焦点行），不是由清单决定。这一条此前写成“清单外身份 400 拒绝”，与代码不符，已更正；而**不在代表清单内**的 `Douyin|main|7677907525970721514` 同样可写（`evidence/m1-ui-fixes-verify.json` F-04：经真实表单保存并读回）。**更正一处引述错误（F-06 复审指出）**：`evidence/r6-recovery-isolation-stale.json` 的 B 段实际是**向 `Bilibili|main|BV1128d6VEAZ` 写入**（该键经核对**不在** `representative-sample-r5.json` 的 25 个身份里）、并核对 `Bilibili|aid|117149108538509` **未被改动**；此前本行写成「写入 aid 行」，与证据不符，已改。
- **并发前置条件（R-6）**：详情表单保存时会带上「本页加载到的原值」（`expected`）；服务端在**同一个事务内**比对，不一致则**整笔拒绝**并返回 **409 `stale_write`**（一个字段都不写），同时落一条 `rejected_stale_write` 审计行。界面会说明「本次未写入任何字段」并重读该条。**批量条与键盘 1/2/3 标记仍是不带前置条件的后写覆盖**（每次都有审计、逐条回报），这是有意保留的差异——快速分诊场景不因另一标签页改过同一行而中断。
- **证据变化 → 复核过期（R-6）**：把某条标为「通过」时，服务端会把当时的 `evidence_fingerprint` 快照进 `review_based_on_fingerprint`。当证据变到与依据不一致时：① 面板启动、② 导入/重放之后、③ 显式 `POST /api/reconcile-evidence`，都会把它标成**复核已过期**（`review_stale=1`，原因 `evidence_changed:<旧>-><新>`，并落审计，操作人写作 `system:evidence-reconcile`）。详情页显示横幅与「复核依据指纹」，列表卡片显示「复核已过期」标签；**重新复核为「通过」会更新依据指纹并清掉过期标记**。该特性上线前复核过的行 `review_based_on_fingerprint` 为空，保持「无法判断」而**不臆造**。校正动作**幂等**（已陈旧的行不重复标、不重复写审计）且**由交付的导入命令本身执行**（`n1-migrate-to-sqlite.mjs` 在人工值核对之后调用，见其 `r6_stale_reconcile` 证据字段）——不是由验证脚本额外补一步。
- **库不可用时不提供「空库」假象（F-05 验证）**：若库文件缺失或根本不是合法库（连 `materials` 表都没有），`openStore`/`ensureSchemaUpgrades` 会直接抛错，**面板拒绝启动**，不提供任何页面；若库能打开但结构不完整，接口返回 **HTTP 500**，页面顶部显示「数据源 读取失败（不是"没有数据"）HTTP 500」、侧栏计数显示「—」而不是 0，列表停在「读取中…」。证据：`evidence/m1-ui-fixes-verify.json`（F-05_error_state_page_rendering）。
- **Baserow 已停用（实测 `8080` 无监听）**：迁移脚本 `r12/n1-migrate-to-sqlite.mjs` 默认仍走 8080 只读；在停用状态下重放请显式加 `--baserow-archive <本任务 store/archive/baserow-export-*.json>` 用既有只读归档作等价输入（证据里会写 `replayed_from_archive`）。**默认行为未改**，不需要为它重启 Baserow。
- **浏览器里没有令牌**：SQLite 版面板**不需要任何外部凭据**（无 Baserow 令牌、无 JWT）；页面只访问 `127.0.0.1:8792`（面板）与 `127.0.0.1:8791`（媒体），不会直连 8080。
- **AI 摘要与结构标签（M2 已实施，2026-10-09）**：`materials` 的 `ai_summary`／`structure_formula` 与新建的 `segment_labels` 表已由本机既有 DeepSeek 凭据（Windows 凭据管理器 `Codex-DeepSeek-API`；端点 `https://api.deepseek.com/responses`、模型 `deepseek-flash`）生成，**覆盖有留存的 7 条文本素材 / 84 个片段**；累计用量 **21 次尝试 / 500**（19 次真实厂商调用共 118,511 tokens：输入 47,307 / 输出 71,204；2 次本地失败、零厂商请求）——**更正（M5 第二十五轮复核指出）**：此处原写"18 次尝试 / 16 次调用 / 87,002 tokens"，是 M2 中途的旧值，与逐份回执及 `evidence/m2-acceptance.json` 不符，已按现行回执口径更新。**其余素材仍显示「未生成」**——它们没有可分析的留存文本，需要先有文本来源（＝新增采集，不在本单授权内）；这与「证据不足」（有产出但不足以判定，**当前结构中心实测 26 段 / 7 条素材**）和「处理失败」（当前 0 段）是三种不同状态，界面可区分。调用与证据见 `outputs/product-material-library-phase1-20261006/evidence/m2-receipts/`（每次尝试一份回执）与 `evidence/m2-acceptance.json`。
- **三层信息在看板里分开呈现，不合并**：**来源事实**＝画面描述/屏幕文字/语音（采集所得，只读）；**AI 建议**＝摘要、结构公式与片段表的「AI 职能（建议）」列，并附「AI 溯源」（模型／生成时间／输入指纹／调用回执）；**人工决定**＝复核状态与「人工职能（决定）」列。**AI 建议不会自动成为人工通过**：两者存在不同列，保存人工职能只写人工列，重跑 AI 也不会覆盖人工修正。缺哪一段就空哪一段（本轮 CTA 实测 0 段），不强行凑齐五段。
- **无媒体不伪装**：没有可用本地媒体时，详情里明确写“该素材没有可用的本地媒体”，不给占位播放器。
- **计数口径**：`/api/summary` 的 `counts.placeholder_rows` 在**自研 SQLite 库上五个维度全为 0**（`{videos:0, segments:0, metrics:0, ratios:0, assets:0}`，附说明「自研库无建表占位行（原 Baserow 的 10 行占位已按空主键识别并排除）」）。**F-06 更正**：此处原写「五表各 2 行、共 10 行」，那是 Baserow 期的事实，对当前自研库**已不成立**。`counts.items`＝素材 8,642、`counts.segments`＝84、`counts.metrics`＝65,402、`counts.ratios`＝8,642、`counts.assets`＝7，均按实际行数如实给出。
- 可选参数：`--manifest` / `--creds-file` / `--audit` / `--media-base` / `--baserow-base` / `--database-id` / `--port`；不带 `--serve` 时只打印表清单摘要（便于自检）。
- **实测（2026-10-07/08，M2；含五轮独立复审后的返修）**：25 条素材 / 12 片段 / 1821 指标 / 27 比率 / 3 资产 / Videos 13 视图（**以上是 M2 冻结时的口径**；M3 写入后库内行数已增长，见 §8.7）；筛选（**日期给两种口径**）：TikTok=4、关键词“豹纹”=1、发布日期=2026-09-20 **不叠加平台时 3 条**（叠加 TikTok 后 1 条）、日期未知 **不叠加时 9 条**（叠加后 2 条）、来源不可用=6、复核中=1、仅媒体=1、仅片段=1、仅有备注=1；唯一带媒体条目（资产 `tiktok-10`）可播（`readyState=4`，媒体服务 Range 请求 **206** `bytes 0-1023/688112`），**12 刻度 + 12 个“定位”按钮共 24 次全部触发真实 `seeked`、最大偏差 0**；护栏：人工字段之外/未知字段/清单外身份/非法选项→400，`text/plain`→**415**，跨站 `Origin`/`Sec-Fetch-Site`→**403**，`application/json-patch+json`→**415**；面板写入 Baserow 后独立回读一致（两态：写入态 + 回滚态，回滚后与 R11 原值逐字段相同）。证据：`evidence/r12-m2-acceptance.json`（**28/28 布尔判定，exit 0**）、`r12-m2-acceptance-negative.json`（4 类缺证反例全部判失败）、`r12-m2-review-rework.json`（14/14）、`r12-m2-write-readback-A/B.json`、`r12-m2-write-twostate.json`、`r12-m2-browser-probe.json`、`r12-m2-browser-seek.json`、`r12-m2-browser-network.json`、`r12-m2-failure-honesty.json`、`r12-panel-edits.jsonl`。五轮独立复审的发现与处置：`evidence/r12-codex-review.json`、`r12-codex-review-m1m2.json`、`r12-codex-review-rework.json`、`r12-codex-review-third.json`、`r12-codex-review-fourth.json`、`r12-codex-review-m2-final.json`。
- 历史：v1（R12 早期）是**只读**快照面板，证据 `evidence/r12-panel-verify.json`；v2 起改为实时 + 可编辑。

#### 8.6b P0 界面改造（`panel-p0-v2`，2026-10-08，按 Simon 三项决定）

> **【历史归档 · F-06 标注】** 本节记录的是 **Baserow 时期**（2026-10-08）的 P0 面板状态。其中的数字与限制**已被 §8.6（自研 SQLite 面板）取代**，例如「全库素材行 97」「后端只放行 25 条身份」「建表占位行 2」——这些对当前候选**都不成立**（现在全库 8,642 行、无身份白名单、无占位行）。保留本节只为追溯 P0 的决策与踩坑记录，**不要按它判断当前行为**；当前事实以 §8.6 与检查点为准。

Simon 决定：**① 先做列表、再做批量；② 列表默认排序按行业看数据的优先级；③ 只加分档字段**（不加标题/封面字段）。
本轮只做 P0（列表卡片化 + 筛选折叠 + 口径统一 + 术语业务化 + 行业优先级排序 + 分档字段），**批量与键盘流属 P1，未开始**。方案与原型：`panel-v3/PLAN.md`、`panel-v3/mock.html`。

- **列表＝卡片**：封面位（有本地视频＝深色可播放块；没有＝一条「未采到本地文件」说明带，不摆假图）＋ 3 个关键数字（播放/点赞/评论）＋ 状态徽标（待看/复核中/通过/排除）＋ 标签（有本地视频 / N 个片段 / N 条关键数据 / 有备注 / 来源异常）。
- **3 个关键数字的口径**（代码：`tools/material-library/panel-metrics.mjs`，有单测）：只认 `Metric observations` 里 `status ∈ {value, observed_zero}` 的**最新一条**观测；**缺失显示「—」、真实观测到的 0 显示 `0`**（两者语义不同）；显示串由服务端生成（`key_metrics[].display`），前端不再各算一套。
- **默认排序＝行业优先级**（服务端 `default_sort=industry_priority`）：分档 T1→T4 → 有本地视频优先 → 播放量高→低 → 片段多→少 → 关键数据多→少 → 发布时间新→旧；**没有播放量 ≠ 播放量 0**（P0 实测踩过并修：`Number(null)===0` 会把「无量」当成「0」排到前面，已加回归 `tests/phase1.test.mjs`）。下拉里仍可切「发布时间 / 播放量」。
- **筛选折叠**：默认只留 搜索 / 平台 / 状态 / 排序；来源、分档、日期范围、是否有本地视频/片段/备注 收进「更多筛选」。已生效条件显示为**可点掉的 chip**（含「全部清空」）。
- **口径统一**：顶栏＝`当前筛选 N 条 ／ 库内可浏览素材 M 条`＋`另有 X 条在库但不在浏览范围（名单外）`；下一行写清 `分档筛选（M3 只读）：建议入库 1,934 / 已登记缺口 6,630 / T4 低信息量 78`＋`全库素材行 97（含建表占位行 2）`。**未加载完成时显示「读取中，不代表 0 条」，绝不先显示 0**（实测踩过：0 会被读成「库里没有素材」）。
- **术语业务化**：界面可见文字里不出现 `entity_key`/`namespace`/`source_unavailable`/`unreviewed`/`in_review`/`reviewed`/`rejected`/`身份串`/`无媒体`/`aid 单列`（浏览器全页扫描 0 命中）。**写回仍是库内取值**，只翻译显示：复核状态 `unreviewed/in_review/reviewed/rejected` → 待看/复核中/通过/排除；来源状态 → 来源正常/采集不到来源/来源待确认；分类状态 → 待确认/已确认/已否决；指标字段 → 播放量/点赞量/评论量…（未收录的字段名保持原样，不臆造译名）。
- **标题**：库里**没有标题字段**（Simon 决策③未加），所以标题＝人工分类（`product_category`，非「未知」时）或 `平台 · 账号 · MM-DD`；卡片同时给出短编号（如 `TikTok-778337`），**绝不显示身份主键**。
- **分档字段 `value_tier`**：已在 Videos 表建立（single_select，字段 id **9516**，选项 `T1 有本地视频 / T2 证据充分 / T3 标准证据 / T4 低信息量`），并入人工字段白名单（`HUMAN_FIELDS`，重新导入不被覆盖）。**当前全表未回填**（`tiers_set=0`）：分档值将在 M3 入库时随批次写入，或另行授权后回填 —— 本轮**只加字段、不写行**（行数证明：Videos 99 / Assets 8 / Segments 74 / Metrics 4,461 / Ratios 99，与 M3 筛选结束时一致）。
- **本轮实测证据**：`evidence/r12-panel-p0-verify.json`（**26/26 检查 PASS，exit 0**，含零写入证明）、`evidence/panel-p0/verify-browser.json`（4 轮真实浏览器实测：发现并修复 `P0-1`~`P0-5` 五处缺陷）、截图 `evidence/panel-p0/panel-p0-{list,detail,loading-state}.png`、`evidence/r12-panel-p0-metric-probe{2,}.json`（指标名与 25 条身份的观测盘点）、`evidence/r12-panel-p0-add-tier-field.json`（建字段回执）。
- **已知未验证（历史，Baserow 期）**：全库（1,934 条）规模的性能与翻页（当时后端仍只放行 25 条身份）；窄屏布局；分档回填后的排序/筛选；P1 的批量与键盘流。**这些限制对当前自研 SQLite 面板已不适用**（现在无身份白名单、批量与键盘流已实现并验收，见 §8.6）。

#### 8.6c 与已批准原型对齐（P0.5，2026-10-08）

Simon 反馈「我贴的页面（原型）才符合要求」，故把 **8792 的界面结构改成与原型一致**（原型 `panel-v3/mock.html` 是**静态示例页**，真正连库的是 8792）：

- **左侧分区导航**：工作区（素材库 N / 缺口 N）、按状态（待看/复核中/通过/排除 各多少条）、按平台（各多少条）——点一下就筛，导航讲业务分类不讲表名。
- **通栏卡片网格**：封面用**平台配色**（TikTok/小红书/抖音/快手/视频号/B站/YouTube/Instagram），有本地视频＝深色可播放块，没有＝平台色块 + 「未采到本地文件」；卡片含标题、账号·日期·时长·片段数、3 个关键数字、标签、状态徽标。
- **一页两态**：点卡片进**整页详情**（← 返回列表；Esc 也返回），返回后筛选条件与滚动位置保留；不再左右两栏挤在一起。
- **缺口分区**（新接口 `GET /api/gaps`，只读证据文件，不查库不改库）：列出 采集不到来源 6,609 / 来源待确认 21 / 信息量过低 78 的原因与平台分布，并附 T1–T4 分档与「建议入库 1,934」口径；**这些记录不进素材列表**。接口读不到证据文件时返回 **503** 并说明，不显示 0。
- **实测**：`evidence/r12-panel-p0-verify.json`（**33/33 PASS**，含新增的侧栏/视图切换/缺口数字与证据一致/平台配色/通栏网格检查）＋浏览器实测（侧栏筛选、点卡片进详情、Esc 返回、缺口分区、术语扫描 0 命中）＋截图 `evidence/panel-p0/panel-p05-{list,detail,gaps}.png`。回归：CLI 97/97、M2 验收 28/28、反例 27 类全失败。


### 8.7 失败语义收紧（R12 第 6 批复核 R6-3/R6-4）与 M3 写入/中断恢复（R12）

- **不把“读失败”伪装成“没有数据”（R6-4）**：Baserow 返回 HTTP 200 但正文不是预期结构（JSON 解析失败、缺少 `results` 数组）时，`listRows` 判为**读取失败**并回传 `rows_body_unparseable` / `rows_body_unexpected_shape`（旧版用 `?? []` 兜底成“零行 + ok:true”，页面会显示成“没有媒体/没有指标”）；`/api/summary` 对 `tables`/`views`/可写字段元数据做同样的结构校验。**判据**：只要读回正文无法解析，就必须是错误状态，绝不降级成空数据。
- **审计告警端到端（R6-3）**：`/api/edits` 读取失败返回 **500 `audit_read_failed`**（不再 200 + 空列表）；部分行解析失败返回 `parse_failed` 计数与 `warning`，页面把它计入“刷新未完全成功”。保存被拒绝（502）时页面**仍会显示** `audit_written:false` 告警，不会因为提前返回而丢掉。
- **M3 单条/小批量与受控中断排练**：单条身份 8/8、小批量 50 条 11/12（唯一未闭合项＝**本批重放前对账快照未留存**）。另用一批 5 条新身份做了**受控中断排练**（短超时故意杀掉导入）：中断时 `Ratios 0/5`、`Metrics 94` 部分写 → **先留存 `pre_replay=true` 的对账快照**（`evidence/r12-m3-step2-reconcile-<UTC>.json`，永不覆盖）→ 同源重放补齐（`ok=true`）→ 第二次重放**零新增**（`evidence/r12-m3-step2-interrupt-rehearsal.json`，7/7 PASS）。**注意**：这仍不是 R12 M4 要求的隔离命名空间验证，M4 需另做。
- **写后对账的 link 字段口径（R6-1）**：**自动反向字段**（`REVERSE_LINK_FIELDS`：Videos 的 `Segments`/`Metric observations`/`Ratios`/`Assets`，Assets 的 `Segments`）由子行写入后投影到父行，本轮开始时与结束时的集合本就不同 → **不参与逐字段比较**，改为按**目标 id 集合**核对关系；**主动写入字段**（`LINK_FIELDS`）仍比较，仅“意图为空、实际非空”的顺序产物豁免。旧版只查 `LINK_FIELDS`（Videos 为空集），豁免等于没生效。

### 8.8 拍摄计划（M4/M5）：怎么用、写什么、以及**这份交付没有覆盖什么**

> 本节是操作说明的当前版本（M5 补写）。**覆盖限度分三段写清**，不要把它们读成"全都做完了"。

**一句话**：从"要做什么产品/需求"出发，按已批准五段结构（钩子 HOOK／痛点 pain／场景 scene／证据 proof／CTA 行动号召）逐节点挑**真实片段**当参考，把**创作建议**（想表达什么／拟口播／拟拍摄画面）人工写进去，保存后可以重开、可以顺着引用回到原始片段与秒数。

> **当前工作模式：以 AI 建议作为生效职能（2026-10-10，Simon 决定"人工暂时没法逐段确认，先全部走 AI 判断"）。** 生效规则仍是 `COALESCE(human_role, ai_role)`——已由人确认过的段以人工为准，其余段以 **AI 建议**为准；接口会在 `/api/summary.role_mode` 如实报出"AI 已标注 = X 段 / 人工已决定 = Y 段 / **按 AI 模式已判定入库 = Z 段**"，每个片段也带 `effective_role_source`（`human`/`ai`/`none`）与 `ai_mode_decided`。**「判断入库」不等于把 AI 变成人工结论**：`human_role` 列不被写入（仍只有人工确认过的那些），面板与详情照旧把"AI 建议"与"人工决定"分列显示；人工随时可在素材详情里覆盖，覆盖后该段生效来源变为 `human`。**当前状态：7 条素材的 84 个片段已全部按 AI 模式判定入库**（操作人 `ai-only-mode`，含时间戳与库内审计；见 `evidence/ai-mode-ingest.json`）。

**操作步骤（都在左侧「拍摄计划」入口）**
1. **看候选**：先在「结构中心」看五段各有多少片段、每条素材的"生效公式"和**缺失职能**。候选数就是你能挑的范围（例：钩子 8 / 痛点 3 / 场景 10 / 证据 37 / **CTA 0**）。
2. **确认职能**：在素材详情里，段表有「来源事实 ｜ AI 建议 ｜ 人工决定」三列。人工确认＝在"人工职能（决定）"里选与 AI 建议相同的职能，然后点**保存人工职能修改**；页面会回"已保存并读回确认"。人工列与 AI 列分开存，确认不会覆盖 AI 建议。
3. **新建计划**：点「新建计划」→ 填**产品/需求**与**传播目的**（这里要写清"到底复用哪条素材的什么"，别把不同素材的热度拼在一起）。
4. **逐节点选参考**：每个节点选职能 → 下拉里只会列出**该职能**的真实片段（含素材身份与起点秒数）→ 点「加入参考」。加进去后页面立刻显示该片段的"来源实际留存文本"——这是**读取时现取**的，计划里**不存快照**，所以来源事实只有一份。
5. **缺口如实记**：某一格没有可用素材时，勾选「这一格没有素材（缺口）」并写明原因。**缺口不会被算成已有素材**，列表与详情都单独计数。
6. **保存**：点「保存计划」→ 服务端写后**重新读取确认**再回显（`write_confirmed`）。列表给出节点数／参考数／缺口数。
7. **重开与追溯**：点计划编号重开，标题是"已保存内容（重新读取确认）"；每条参考可点「打开来源并定位」跳到素材详情并定位到该秒；素材详情反向显示"计划引用（N 份 / M 处）"。
8. **改已有计划**：更新是**整份替换**，且必须带上"你这次读到的内容"（前置条件）。库里的内容与你读到的对不上时会**整笔拒绝**（409）并列出**哪个字段/哪个节点**不一致——不会静默覆盖，也不会把"没读到"写成"清空"。

**三段覆盖限度（分开陈述，勿混）**
- **AI 试点＝7 条**：只有 7 条有留存文本的素材做过 AI 摘要与分段职能建议（84 个片段全部有建议）；**其余 8,635 条未生成**，因为它们没有可分析的留存文本。
- **其余记录＝无证据/不判定**：库内 8,642 条身份里，可浏览 1,934 条、已登记缺口 6,630 条、T4 低信息量 78 条；缺口不进素材列表。片段层面有 26 段被标为"证据不足"，它们**不算可用职能**。
- **未做的生产化能力**：本阶段只交付**本机面板 + 7 条素材的 AI 试点**，不含真实拍摄、成片生产、发布/投放/云化/定时任务，也不含全语料 AI 覆盖。

**证据（可自查）**
- 端到端连续案例（真实页面逐步观测值）：`evidence/m5-ui-e2e-receipts.json`
- 集成验收（语义保留／同源重放／同字段冲突／受控中断／版本身份）：`evidence/m5-integrated-verify.json`
- 计划写入的完整保护：`evidence/m4-plan-verify.json`（含"篡改回包必被 409 拒绝""诚实编辑不被误拦""缺口与引用分开计数"）
- 同源重导入（重放）保计划：`evidence/n1-sqlite-migration.json`（快照与恢复都覆盖 `plans/plan_nodes/plan_references`）
