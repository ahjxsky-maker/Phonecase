# 产品素材研究库 · P1 源合同与字段映射（Phase A / R2）

- 版本：`field-map/1.0.0`，规则实现版本 `material-library-rules/1.0.0`（`tools/material-library/rules.mjs`）
- 生成时间（Asia/Shanghai）：2026-10-06
- 状态：**执行端自验**。本文件是 P1/A1 的交付物，不构成监督验收。
- 本阶段新增提供方（TikHub/AI/媒体）请求：**0**。本文件只读既定普查与既有本地证据。

---

## 1. 这份合同解决什么

把已验收的八平台普查证据，变成导入器可以**无歧义**执行的源合同：哪一条记录是谁、哪个字段来自哪里、单位是什么、观测于何时、当前是「有值 / 观测零 / 缺失 / 来源不可用 / 不可用 / 未知」，以及**哪些结论不能由此得出**。

它不重开普查、不改 V8420 口径、不发起任何新采集。

## 2. 只读输入（本文件所依据的确切证据）

| 用途 | 路径（W = `D:/Codex-local/harness-workspaces/Phonecase`） | 指纹 |
| --- | --- | --- |
| 实体决策层（成员资格权威来源） | `outputs/platform-volume-census-20260922/evidence/entity-usability-v514.jsonl` | 15 157 行；sha256 `532d804f78aa3ded0dfe5c7da4feb56d27f135913e27668918eda42e5a8199e5`（由 `current-view-v514.json#authoritative_artifacts` 声明） |
| 逐实体逐字段观测 | `.../evidence/entity-field-values-v514.jsonl` | 224 814 行；sha256 `f3ca34d2f36ad662858540601d502322ba82cea805d3ffb6f39f803399925532` |
| 权威整合视图 | `.../evidence/current-view-v514.json` | sha256 `f0464146de8c1022572b5a0b1d41ad3bd50086a69e69a7dcd860fb71fa31ff9e` |
| YouTube 日期订正（单条，V5.13） | `.../evidence/v513-youtube-detail-correction.json` | 1 条 |
| YouTube 日期订正层（V5.14/V5.15 合并） | `.../evidence/v514-youtube-detail-corrections.json` | 336 条 |
| 唯一数据检查点（对账基准） | `.../evidence/v515-session-checkpoint-r629.json` | 169 236 B；sha256 `52347c293ae42d3a008c275c7f23a8cef3188a553a2ad51a9ea1a46928db893c` |
| 逐字段可用性矩阵（r629 只读复制） | `outputs/product-material-library-phase1-20261006/evidence/field-readiness-r629.json` | 见 `field-readiness-r629.md` |
| 既有本地媒体（20 条） | `outputs/material-analysis-20-20260920/sample-manifest.json` | 20 条 |
| v5 字段合同（只读引用，**本阶段不发起任何 TikHub 请求**） | `outputs/tikhub-capability-verification-20260922/field-dictionary-v5.json`（入口 `R/docs/knowledge/topics/tikhub-mcp.md`） | `schema_version=2`，`revision=v5-R7F1`；377 观测条目/60 unknown |
| v5 合同摘录（本包只读副本） | `outputs/product-material-library-phase1-20261006/evidence/v5-field-contract-reference.json` | — |
| 素材调研成果总览与复用入口（2026-09-21） | `R/outputs/phonecase-xmind-closeout-20260917/素材调研成果总览与复用入口-20260921.md` | §原始文档的阅读陷阱 1–5 |
| 素材调研本地证据索引（2026-09-21） | `R/outputs/phonecase-xmind-closeout-20260917/素材调研-本地证据索引-20260921.json`（只读副本 `evidence/local-evidence-index-reference.json`） | 20 条，含逐条 `media_record_source` |

`evidence/v518-v-member-keys.json` **只是逐字段/逐组合的子集名册，本身不是完整成员名册**，本导入器**不使用**它界定成员。

## 3. 已验证的「接受连接」（exact accepted join）

这是 P1 的关键结论，已实测对账通过：

```
成员 = entity-usability-v514.jsonl 的 decision
       经 v513-youtube-detail-correction.json（1 条）
       与 v514-youtube-detail-corrections.json（336 条）覆盖后
       取 decision == INCLUDE_VIDEO

主口径 = namespace == "main"    → 8420
aid 分支 = namespace == "aid"   →  222（单列，永不并入合并唯一总数）
```

**为什么必须叠加覆盖层**：`entity-usability-v514.jsonl` 自身对 YouTube 只给 3 条 `INCLUDE_VIDEO`；已接受的 YouTube 日期订正把另外 40 条移入窗口（另 6 条 replay、290 条出窗、1 条出窗）。不叠加则得到 8380 而非 8420。叠加后逐平台与 r629 检查点**完全一致**：

| 分支 | 期望 V | 实测 V |
| --- | --- | --- |
| TikTok \| main | 128 | 128 |
| Instagram \| main | 116 | 116 |
| YouTube \| main | 43 | 43 |
| Douyin \| main | 5883 | 5883 |
| Kuaishou \| main | 59 | 59 |
| Xiaohongshu \| main | 821 | 821 |
| Bilibili \| main（BV） | 1200 | 1200 |
| WeChat Channels \| main | 170 | 170 |
| **主口径合计** | **8420** | **8420** |
| Bilibili \| aid | 222 | 222 |

实测命令与回执：`outputs/product-material-library-phase1-20261006/normalized/reconciliation.json`（`ok: true`，`mismatches: []`）。

## 4. 命名与标识合同

| 层 | platform 取值 | namespace | 说明 |
| --- | --- | --- | --- |
| 实体决策层（显示名） | `TikTok` `Instagram` `YouTube` `Douyin` `Kuaishou` `Xiaohongshu` `Bilibili` `WeChat Channels` | `main` / `aid` | 成员资格权威层 |
| 字段观测层（slug） | `tiktok` `instagram` `youtube` `douyin` `kuaishou` `xiaohongshu` `bilibili` `wechat` | `main` / `aid` | 逐字段值 |

- 两层命名不同，导入器用**显式映射表**转换，不做模糊匹配（`rules.mjs#DISPLAY_TO_SLUG`）。
- `entity_key = platform|namespace|native_id`。**同一平台同一 id 文本在不同 namespace 下是不同实体**（Bilibili BV 与 aid 已实测保持分离）。
- **所有 id 一律以字符串承载**。实测 8 642 条成员中 6 356 条纯数字 id 超过 `2^53-1`，其中 6 351 条经 `Number()` 往返即失真 → 必须以字符串入库。非数字 id（YouTube 11 字符、Bilibili BV 12 字符）共 2 064 条同样原样保留。
- 身份保真自验：8 642 条成员的 `native_id` 与保留证据逐字符一致（`identity_fidelity_vs_retained_evidence`，mismatches=0）。

## 5. 观测状态模型（缺失绝不写 0）

| 归一化状态 | 含义 | 来源 | 是否进 Baserow |
| --- | --- | --- | --- |
| `value` | 保留证据中有可用值 | `present_and_usable`（非零） | 是，带单位与观测时刻 |
| `observed_zero` | **观测到的 0**，是事实不是缺失 | `zero_valued=true` | 是 |
| `absent` | 该来源在受检范围内没有此字段 | `absent_in_inspected_source` | 是（显式缺失） |
| `unusable` | 有值但歧义/不可用 | `present_but_ambiguous_or_unusable` | 是（显式不可用） |
| `source_unavailable` | **整体没有保留来源**（无响应副本 / 页面未归档 / 临时溢出未留存） | 实体级 `fields.reason_class` | 是（成员仍入库，字段空） |
| `unknown` | 仅有转写或声明未确立，无法判定 | `transcribed_only_no_copy` / `claimed_payload_not_established` | 是 |
| `error` | 观测到但**未通过本库类型/单位校验**（计数为负、时间非正整数、URL 非 http(s)、派生模板非 URL） | 本导入器校验（仅对普查判为 `present_and_usable` 的值施加，**不回头改写普查结论**） | 是 |

**事实来源分层**：每条观测另带 `fact_origin`（`source_fact` / `derived`），与记录层的人工复核字段分开。实测：65 402 条观测中 `source_fact` 64 350、`derived` 1 052，`error` **0**（真实留存数据上无值违反类型/单位契约）；`error` 路径已用安全隔离反例逐条验证，非「未实现」。

真实分布（本包实测，8 642 条成员的 65 402 条指标观测）：

| 状态 | 条数 |
| --- | --- |
| `absent` | 32 399 |
| `value` | 29 979 |
| `observed_zero` | 2 718 |
| `unusable` | 306 |
| 实体级 `source_unavailable`（无任何字段行） | 6 632 条成员 |

**6 632 条缺口全部带具体原因**（不制造行也不静默丢弃）：Douyin 5 599（`source_page_never_filed`）、Bilibili BV 755、Xiaohongshu 234、TikTok 18（`no_retained_copy_for_platform`）、YouTube 14、WeChat Channels 11、Kuaishou 1。与监督卡 §3 记载的「DY no-source 5599」「BV 源 445/V1200」一致。

## 6. 字段合同（含层间名映射）

普查的 `over_V` 读数使用「语义化字段名」，字段层使用另一套名字，映射如下：

| 普查 over_V 名 | 字段层 field | 归一化含义 | 类型 / 单位 |
| --- | --- | --- | --- |
| `canonical_url_retained` | `canonical_url` | 来源自身给出的规范链接 | string |
| `derived_permalink_not_visited` | `derived_permalink` | 由 id 拼出的链接（**未访问验证**） | derived string |
| `publication_time` | `publication_time` | 发布时间 | epoch 秒 |
| `publication_time_label_only` | `publication_time_label` | 仅相对/文本发布时间标签 | string |
| `engagement_like` | `engagement_like` | 点赞 | count |
| `engagement_play_or_view` | `engagement_play` | 播放/观看 | count |
| `engagement_comment` | `engagement_comment` | 评论 | count |
| `engagement_share` | `engagement_share` | 分享 | count |
| `engagement_collect` | `engagement_collect` | 收藏 | count |
| `engagement_danmaku` | `engagement_danmaku` | 弹幕 | count |
| `author_id` | `author_id` | 作者 id | string |
| `author_display_name` | `author_display_name` | 作者显示名 | string |
| `author_follower_count_not_engagement` | `author_follower_count` | 粉丝数（**≠互动**） | count |
| `geography_or_region` | `geography_or_region` | 地区/地域 | string \| json |
| `language` | `language` | 语言 | string |
| `media_type` | `media_type` | 媒体类型 | string |
| `duration` | `duration` | 时长 | 秒 |
| `ad_marker_search_placement` | `ad_marker_search_placement` | 搜索位广告标记 | boolean \| string |
| `ad_marker_paid_partnership` | `ad_marker_paid_partnership` | 付费合作标记 | boolean \| presence |
| `ad_marker_branded_content` | `ad_marker_branded_content` | 品牌内容标记 | presence \| array_length |
| `product_tag_or_eligibility_not_sales` | `product_tag_or_eligibility` | 商品资格/挂载标记（**≠销量**） | boolean |
| `product_linked_identity` | `product_linked_identity` | 关联商品身份 | product_id_set |
| `product_price_not_sales` | `product_price` | 价格文本（**≠销量**） | string |
| `sales_quantity` | `sales_quantity` | 销量 | count |

### 6.1 逐分支可用性（分母 = 该分支 V）

完整矩阵见 `outputs/product-material-library-phase1-20261006/evidence/field-readiness-r629.json`（只读复制自 r629 检查点 `field_readiness_by_branch`）。关键结论：

| 分支 | 源实体（有字段证据） | V | 互动可用性 | 关键限制 |
| --- | --- | --- | --- | --- |
| TikTok \| main | 212 | 128 | like/play/comment/share 各 110 可用（85.9%），18 条来源不可用 | 无收藏字段（缺失，非 0）；无品牌内容标记 |
| Instagram \| main | 296 | 116 | like/play/comment 100%，share 94.8%（6 条缺失） | 无收藏、无粉丝数、无语言；canonical_url 全缺（仅有派生链接） |
| YouTube \| main | 253 | 43 | like/play 58.1%，comment 46.5%，share 0% | canonical_url 仅 16.3%；语言/地区/类型全缺；14 条来源不可用 |
| Douyin \| main | 355 | 5883 | 各 284 可用（4.8%） | 5 599 条**完全没有留存来源**；这是主要缺口 |
| Kuaishou \| main | 570 | 59 | 各 58 可用（98.3%） | geography 全部歧义；1 条来源不可用 |
| Xiaohongshu \| main | 2635 | 821 | like/comment/share/collect 各 587 可用（71.5%） | **无播放量**（587 条缺失）；234 条来源不可用；canonical_url 全缺 |
| Bilibili \| main（BV） | 445 | 1200 | like/play/comment/share/collect/danmaku 各 445 可用（37.1%） | 755 条来源不可用；canonical_url 全缺；无粉丝数/地区/语言 |
| WeChat Channels \| main | 665 | 170 | **仅 like 85 可用（50%）** | 无播放/评论/分享/收藏；无 author_id |
| Bilibili \| aid（单列） | 1000 | 222 | **仅 play 100%、danmaku 51.4%** | 无 like/comment/share/collect；canonical_url 全缺 |

> 读法提醒：`usable_pct` 是「该分母中来自保留来源的可用值占比」。它**不是**平台总体覆盖率，也不是内容质量指标。

### 6.2 与 v5 已验字段合同的对齐

普查字段层与已验证的 TikHub v5 字段字典（`field-dictionary-v5.json`，`revision=v5-R7F1`）逐字段对齐。本阶段**不发起任何 TikHub 请求**，只用其已验语义校准本库含义。实测统计：24 个实际出现的普查字段中 **17 个映射到 v5 规范含义**、**6 个在 v5 中无等价槽位**、**1 个含义歧义**，**0 个未映射**（`verify/self-check.json#v5_meaning_mapping_complete`）。

| 普查字段 | v5 规范含义 |
| --- | --- |
| `engagement_like` / `engagement_comment` / `engagement_share` / `engagement_collect` / `engagement_play` | `likes` / `comments` / `shares` / `saves` / `views` |
| `canonical_url` | `public_url` |
| `publication_time` | `publication_time` |
| `author_id` | `author_id` |
| `language` | `language` |
| `media_type` | `entity_type` |
| `ad_marker_search_placement` / `ad_marker_paid_partnership` / `ad_marker_branded_content` | `ad_or_promotion_status` |
| `product_tag_or_eligibility` | `product_association` |
| `product_linked_identity` | `product_id` |
| `sales_quantity` | `sales_quantity` |
| `engagement_danmaku`、`publication_time_label`、`author_display_name`、`author_follower_count`、`duration`、`product_price` | **v5 无等价槽位** → 保持平台自有语义并标注，不硬套含义 |
| `derived_permalink` | `public_url`，但**派生且未经访问验证**；v5 明确「URL 身份不等于可达」，与来源自述的 `canonical_url` **不可互换** |
| `geography_or_region` | **歧义**：v5 区分 `query_region` / `author_region` / `audience_region` / `location_tag` 四个不同语义槽位，而普查层只有一个合并槽位 → 归属保持 `unknown`，**不得**默认当作受众市场 |

**v5 的零/空/缺失语义是本库可用性状态机的权威依据**（`rules.mjs#V5_VALUE_SEMANTICS`）：

- 计数型字段的字面 `0` 是**真实上报零**；显示字符串**不得**推断出数值零。
- JSON `null` = present-but-not-set，与「键缺失」和与 `0` 都不同。
- 键缺失 = 该来源对该实体未返回值；**不得**被强制成 `0` 或 `null`；也不证明平台从不暴露该字段。
- 伴随 `*_disabled`/`hidden_*` 标记时平台抑制该值，数值字段可能**无意义**（本阶段保留证据中未观察到此类标记，作为规则保留）。

### 6.3 逐字段 locator 与观测时刻

每个字段在保留证据中的**原始 JSON 路径（locator）**、单位、可用性分布与观测时刻范围，由 `cli.mjs field-contract` 从 `entity-field-values-v514.jsonl` 可复现提取：

- 机器可读：`plan/field-contract.json`
- 可读表格：`plan/field-contract.md`

同一字段可能有**多个** locator（不同路线/容器形状），合同全部列出，不做单一化。示例（TikTok|main）：`engagement_like` 的 locator 取自 `data.data.items[].statistics.digg_count`；`canonical_url` 来自 `data.data.items[].share_info.share_url`。**locator 是来源事实的一部分，导入时随观测一并保留**，用于回答「这个数是从哪读出来的」。

### 6.4 媒体/资产合同

既有 20 条媒体（`media-analysis-20-20260920`）与普查世代**分开标识**；身份落在主口径内的 7 条，口径外 13 条不改动 V8420 分母。

| 规则 | 说明 |
| --- | --- |
| 两级解析 | `sample-manifest.entries.media` → `card.media_evidence.file`。实测 11 条来自 manifest、9 条来自卡。 |
| **图像绝不当作视频** | 成果总览「阅读陷阱」第 2 条：最短的抖音卡 `media_evidence.file` 指向**接触表(JPG)** 而非 MP4。卡回退路径必须做媒体类型守卫，非视频一律显式拒绝并记录 `kind_reject_reason`。实测：20/20 解析为 `video`，0 条图像被当作视频。 |
| 路径一律绝对化 | 来源记录的是 cwd 相对路径；直接交付会使换 cwd 的消费者解析失败。本库统一规范化为绝对路径，同时保留 `local_path_recorded` 原样值。 |
| 独立交叉核对 | 与归档期生成的 `素材调研-本地证据索引-20260921.json` 逐条比对身份/路径/字节/sha256：**20/20 一致，0 处不符**。 |

**片段引用边界**：既有分析卡来自有限帧/ASR 抽样（例如某条 12 格等间隔抽样，格距 0.611s，仅覆盖被采样时刻）。本库只**引用**已存的时间点与来源，**不**据此声称全片已看/已听，也**不**新建语义分析。

### 6.5 时间片段引用与媒体可达性（P4 详情/片段衔接）

**Baserow 能力核查（按官方文档，非运行实测）**：官方 File field 文档列出可生成预览的类型包含 **Audio/Video: `.mp3` / `.mp4` / `.webM` / `.ogg` / `.ogv`**，且「点击文件可打开全屏预览」——本库 20 条资产**全部是 `.mp4`**，故面板内媒体查看属免费核心能力。
**但「拖动到指定时间」未被官方文档记录 → 记为 UNVERIFIED**，不得声称面板内可定位到片段时刻。
来源：<https://baserow.io/user-docs/file-field>（只读抓取；另查得历史特性请求 <https://gitlab.com/baserow/baserow/-/work_items/687> 提议 `<video controls>`，属历史提案，不作为当前行为证据）。

**按 R2 STEP3 提供「必要的最小本地补充」并实测**：用项目既有 FFmpeg 构建验证「片段引用时刻在本地媒体中可达」。

| 项 | 实测 |
| --- | --- |
| 受检片段（身份落在主口径内、且有本地媒体的 7 条资产） | 84 |
| 引用时刻本地可达（`ffmpeg -ss <t> -i <mp4> -frames:v 1 -f null -` 退出码 0） | **84 / 84** |
| 不可达 | 0 |
| 全部资产的片段引用总数（含主口径外资产） | 243（`original_fact` 240 / `unknown` 3） |

**这条实测证明的是**「引用时刻在本地媒体中可解码到达」，**不**证明 Baserow 面板内可拖动播放。回执：`segments/seek-verification.json` / `.md`。

**片段引用的来源与分层**：每条片段带 `origin_card`（来自哪张既有卡）、`origin_method`（如 `per_tile_exact_seek`）、`time_accuracy_note`、`coverage`（`sparse_sampled_tiles_only`）与 `kind`（`original_fact` / `interpretation` / `suggestion` / `unknown`，沿用卡自身的 `class_legend`，**不自行升级**）。`fact_origin` 由 `kind` 推出：`original_fact → source_fact`，其余 → `derived_interpretation`。人工复核字段（`review_status` / `selected_reference` / `human_note`）与来源分层**分开保存**。

### 6.6 与已验收 r629 基线逐字段对账（实测）

本导入链必须**精确复现**已验收的技术基线，否则说明成员范围或可用性判定偏离了已接受的普查口径。自检 `reconciled_against_r629_field_readiness` 把 r629 检查点 `field_readiness_by_branch` 的每一个 `over_V.usable` 与本库逐实体计算结果比对：

| 项 | 实测 |
| --- | --- |
| 对账字段行 | **216**（9 分支 × 24 字段，与 r629 §1.4 的 216 行一致） |
| 字段不符 | **0** |
| `unavailable_no_retained_source` 不符 | **0** |

对账前需把普查的 24 个「语义化字段名」映射到字段层的 24 个名字（7 处不同名），映射表见 `cli.mjs#CENSUS_TO_FIELD`。该检查在首次运行时**确实检出**一处映射遗漏（`publication_time_label_only`），修正后 216/216 相等。

### 6.7 联合可用性必须实测，不得构造（实测反例）

r631 §1.6 明确：边际可用性**不得**用最小可用数「构造」联合覆盖率。本库按实体逐条实测联合可用性，并扫描字段对找出构造法会出错的反例：

| 字段对（主口径 V=8420） | min(边际) 构造值 | **实测联合** | 构造法误差 |
| --- | ---: | ---: | ---: |
| `engagement_play` + `geography_or_region` | 721 | **134** | **+587（构造法高估 5.4 倍）** |

自检 `joint_availability_measured_not_constructed` 断言实测值落在容斥下界与 `min()` 之间，并输出偏差最大的字段对。**任何联合断言都必须回到逐实体证据**。

### 6.8 P4 研究面板：筛选维度、指标定义与用户旅程

**筛选维度覆盖（R2 STEP5 要求 platform / language / date / review-status；product·function 无来源支持）**：视图计划共 **13 个**（`plan/baserow-views.json`），其中视频表 10 个，显式覆盖：

| 维度 | 视图 | 过滤 |
| --- | --- | --- |
| 总览（unknown 不被隐藏） | 全部记录 | 无过滤 |
| 平台 | 按平台：TikTok（可切换） | `platform equal TikTok` |
| 语言 | 语言已明示 | `language not_empty` |
| 日期 | 发布日期已明示 | `publish_date_epoch_s > 0`，按发布时间倒序 |
| 复核状态 | 未复核记录 / 人工精选参考 / 证据变化待复核 | `review_status` / `selected_reference` / `review_stale` |
| 分类缺口 | 分类待补（unknown 可见） | `product_category equal unknown` |
| 证据缺口 | 待补证据 / 缺失与不可用 | `entity_source_state ≠ observed` / 指标 `status = source_unavailable` |

> 产品类别/功能/场景**无来源留存** → 一律 `unknown`，因此不存在「按产品筛选」的数据基础；本库**不**用推断填充以满足该维度，而是用「分类待补」视图让缺口保持可见，并把该限制交业务方裁定（§9）。
> 跨平台排名**不提供**：平台筛选只是分列查看，不是可比性结论。

**指标定义（详情必须能回答「这个数是什么」）**：每条指标观测都带 `metric_definition` 与 `metric_caveat`（`rules.mjs#METRIC_DEFINITIONS`，25 个字段登记 + 未登记字段的显式兜底），并强制 `comparable_across_platforms = false`（普查已明确跨平台可比性未建立）。实测：65 402 条观测**全部带定义**，0 条声称跨平台可比。

**用户旅程（R2 STEP5 要求「Demonstrate one real user journey」）**：`cli.mjs journey` 在**真实留存记录**上执行并留回执（`journey/journey-transcript.{json,md}`），7 步：
检索条件 → 匹配行 → 选中记录 → 详情证据（身份含**显式缺失**、发布时间、可用性、指标+定义、比率、价值标签）→ **显式缺口**（不以推断填充）→ 人工标注入库 → 再次导入后仍可检索。
实测：`platform=TikTok & 有本地视频` 匹配 **7** 条，选中 `TikTok|main|7679078728667778337`；标注后复跑 `inserted=0`、人工备注保留、`stale=false`。
**该旅程是数据链路执行，不是 Baserow 面板 UI 验收**（UI 段仍阻断）。

## 7. 指标与比率口径

### 7.1 TikTok 互动率（本阶段唯一启用的比率）

```
互动率(%) = (点赞 + 评论 + 分享) / 播放 × 100
约束：分子各项与分母必须来自**同一条视频的同一次观测**；播放 > 0；收藏另列，不并入分子。
```

- 口径出处：Rival IQ（`https://help.rivaliq.com/en/articles/2043672-understanding-engagement-rates`）。是**成熟工具口径**，不是全行业唯一公式；Socialinsider 含收藏，基准不可混用。
- 实现：`rules.mjs#RATIO_RULES.tiktok_engagement_rate`；`normalize.mjs#computeRatios`。
- 实测：8 642 条成员中 110 条算出该比率（均为 TikTok，同观测且播放>0）。
- 不支持时**不产生分数**：分母缺失 → `absent`；分母为观测零 → `observed_zero`（比值未定义）；分子分属不同观测 → 不计算；平台未定义该口径 → `not_applicable` 显式记录一行。
- 普查未留存 TikTok 收藏字段 → 收藏记为 `absent`，**不填 0**。

### 7.2 其他平台

保留各自真实可用合同与显式分母（见 §6.1）。**不做跨平台全局表现排名**——分母与可得字段不同，不可比。单次快照**不能**判定增长：本阶段无第二条有效观测的对象一律不输出增长率。

### 7.3 已引用的行业方法论（仅作有证据的标注框架）

| 方法 | 来源 | 用途边界 |
| --- | --- | --- |
| TikTok Top Ads | `https://ads.tiktok.com/business/library/NA_Creative_Center_Top_Ads_One_Pager.pdf` | 按地区/行业/目标/时间分组后比较；广告样本不代表全部内容。本项目普查已排除广告，不得据此改资格或启动广告采集。 |
| Rival IQ 互动率 | `https://help.rivaliq.com/en/articles/2043672-understanding-engagement-rates` | 见 §7.1 |
| TikTok Creative Codes | `https://ads.tiktok.com/business/en-US/creative-codes` | 标注 hook/body/close 表达手法，不据勾选项推销量 |
| Google ABCD | `https://support.google.com/google-ads/answer/14783551?hl=en-1` | 标注注意/品牌·产品/联系/行动，同上 |

### 7.4 数值阈值 = 未批准的项目建议

`rules.mjs#PROPOSED_CUTOFFS`（`status: PROPOSED_NOT_APPROVED`）仅登记两条**建议**：同平台同口径互动率 P75、任何描述性排名的样本下限 30。它们
**不参与自动入选、不做硬筛选**，须业务方在核对既有分布后确认。行业公开资料未提供适用于八平台全部视频的统一价值阈值；平台官方框架、工具口径、行业基准与本项目配置必须分开。

## 8. 分类词表与未知

| 维度 | 来源字段 | 本阶段取值 |
| --- | --- | --- |
| 产品类别 `product_category` | 无 | `unknown` |
| 产品功能 `product_function` | 无 | `unknown` |
| 场景/需求 `scene_or_need` | 无 | `unknown` |
| 平台 | 实体层 `platform` | 有值 |
| 语言 | `language` | 有值或 `unknown`/`absent`（不得由平台推断） |
| 发布时间 | `publication_time` | 有值或 `unknown`（**不得用观测时间顶替**） |
| 观测时间 | `observed_at_epoch_s` | 有值，与发布时间分开保存 |
| 媒体可用性 | `sample-manifest.json` | 20 条既有资产中 7 条身份落在主口径内，13 条在口径外**单独标识**，不改 V8420 分母 |
| 复核状态 | 人工 | 初始 `unreviewed` |

普查未留存产品类别/功能/场景字段，因此**一律 `unknown`**，不臆造。既有产品研究（`D:/Codex-local/docs/phonecase-module02-20260915/README.md`）仅作参考：共有视觉特征**不**确立同 SKU。

## 9. 本数据不能得出的结论（沿用已验收限制）

- 平台总量/总体规模：一切量值仍为 `OBSERVED_LOWER_BOUND`，`coverage_established=false`。
- 跨平台可比性：未建立；不得做跨平台效果或质量排名。
- 销量/ROI/转化：**任何平台都没有已证的逐观测销量**（`sales_quantity` 全为缺失）。热度**不是**销量代理。
- 市场需求或需求规模：未建立。
- 增长：单次快照不能判定。
- 广告资格改动：普查已排除广告，不得技术性改写。

## 10. 复现命令（实际执行的 argv 见 README §4）

```bash
node tools/material-library/cli.mjs field-contract  # → plan/{field-contract.json,field-contract.md}（locator/单位/可用性/v5 对齐）
node tools/material-library/cli.mjs normalize       # → normalized/{records.jsonl,reconciliation.json,gaps.json,summary.json,media-assets.json}
node tools/material-library/cli.mjs segments        # → segments/seek-verification.{json,md}（片段引用时刻本地可达性）
node tools/material-library/cli.mjs journey         # → journey/journey-transcript.{json,md}（A5 数据链路用户旅程）
node tools/material-library/cli.mjs verify          # → verify/self-check.json（30 项）
```
