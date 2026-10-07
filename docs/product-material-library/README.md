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
  tests/phase1.test.mjs     16 项聚焦语义测试
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
  verify/                   self-check.json（18 项）
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
| 17 | `node tools/material-library/cli.mjs journey --platform TikTok --require-media true --setup-fixture` | 隔离演示：`chosen=TikTok\\|main\\|…`；标注→再导入 `inserted=0`、备注保留、`stale=false` → `journey/journey-transcript.json`。**R7 起 `--setup-fixture` 是必需开关**；不带它时旅程只做只读查询/显式编辑，不写夹具 |

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
#    · 状态由 `--classification-state` 显式给出；工具**不会**代填 reviewed，也不冒充 Simon 复核
#    → edit/edit-receipt.json（identity_checks / intended / target_row_before|after / verification 逐项）

# ③ 只读导出（快照既有目标的五张表最终行；不导入、不建结构、不编辑、不复跑）
node tools/material-library/cli.mjs export --target http --base-url … --token <T> [--entity-key "<K>"] [--bundle <PATH>]
#    · 声明了选中身份却不在快照里 → exit 14（不伪造 selected-row 成功）
#    → portable/material-library-bundle.json（schema/views/rules/**data** + snapshot 期望）、portable/export-receipt.json

# ④ 从**磁盘字节**恢复并逐项核对（默认恢复到 O/tests-tmp/restore-*，写前校验授权根）
node tools/material-library/cli.mjs restore --bundle <PATH> [--restore-into <DIR>]
#    · 截断 JSON / 缺行 / 分类值被改 / 媒体或片段链接被改 → exit 15 且**显式失败**（不回落内存数据）
#    → restore/restore-receipt.json（bundle_sha256 + 五表键集合/计数 + 关联 + 选中行逐字段 + 媒体链接）
```

- **隔离验证用的传输替身**：无真实 Baserow 时，可用 `ML_TRANSPORT=baserow-double` 指向回环 Baserow 形状替身（严格
  2.4.0 行/结构形状，状态存 JSON 文件 → **多次 CLI 调用共享同一目标**）。此时回执一律 `baserow_verified=false`
  并在回执里写明「传输被替代」，**不得**当作 Baserow 验收。
- **旅程（`journey`）默认为只读**：消费既有目标并给出「身份解析 + 详情/媒体 + 问题列表」回执；
  需要写入时必须显式 `--edit`，并给出 `--reviewer`（以及带分类时的 `--classification-state` 与 `--classification-evidence`）。
  隔离夹具演示仍是 `--setup-fixture`（写 `fixtures/journey-overlay.json`，绝不碰正式覆盖层）。

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
**目标侧人工编辑（R6）**：人工判断必须写**目标 backend**（`applyTargetEdit` → `updateRow` → 复读逐项核对）；只改源侧覆盖层不会改变既有目标行（人工字段保护策略会挡回），因此不作为“编辑已生效”的证据。
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
- **产品/功能/场景筛选**：来源未留存这些字段 → 缺省 `unknown`（视图 `分类待补（unknown 可见）` 保持缺口可见）。**带证据的人工/执行端分类**一经写入，即可用 `按产品类别检索` 视图或 `cli.mjs journey --product-function … --classification-evidence …` 检索到；不批量杜撰、不设填充数量目标。
- **不提供跨平台排名**：平台视图只是分列查看，不构成可比性结论。
- **用户旅程**（`cli.mjs journey`）在真实留存记录上执行 7 步并留回执：**产品/需求检索条件 → 匹配行 → 详情证据 → 现有媒体/片段 →（可选）隔离夹具准备 → 再导入 → 目标行断言**。第 7 步的命中来自**目标库行**（`lookupTarget` 读 backend），人工编辑走**目标 backend 的 `updateRow`**，复导入后逐项核对最终目标行。
  - **R7 起夹具准备是显式动作**：默认**不**写隔离覆盖层；只有 `--setup-fixture` 才做「分类提案 + 夹具人工编辑」这一**隔离演示**（写 `--overlay`/默认 `fixtures/journey-overlay.json`）。在**已填充的真实目标**上，旅程默认只做只读查询 + 显式编辑，并要求既有目标行的人工状态、行 ID 与命名空间在导入后**原样保留**（`prepopulated_target_row`）；把上一次的目标状态覆盖成新夹具备注是**错误**行为。
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
