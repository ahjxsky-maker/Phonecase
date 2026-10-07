// tools/material-library/rules.mjs
// P1 源合同与规则（版本化）。只读既定普查证据，不重跑普查、不发起任何提供方请求。
//
// 设计原则（与 R2 / 监督卡一致）：
//  - 数值阈值只是「可配置的项目建议」，不是已批准的行业标准，也不做自动硬筛选。
//  - 缺失(absent) / 来源不可用(unavailable) / 不可用(unusable) / 未知(unknown) / 错误(error)
//    / 观测零(observed_zero) 必须互相区分；缺失绝不写成 0。
//  - 不跨平台做全局表现排名；单次快照不能判定增长。
import fs from 'node:fs';
import path from 'node:path';

export const RULES_VERSION = 'material-library-rules/1.0.0';

export const DEFAULT_ROOT = process.env.MATERIAL_LIBRARY_ROOT
  || 'D:/Codex-local/harness-workspaces/Phonecase';

export function sourcePaths(root = DEFAULT_ROOT) {
  const census = path.join(root, 'outputs/platform-volume-census-20260922');
  const analysis = path.join(root, 'outputs/material-analysis-20-20260920');
  return {
    root,
    census,
    evidence: path.join(census, 'evidence'),
    entityDecisions: path.join(census, 'evidence/entity-usability-v514.jsonl'),
    entityDecisionsSummary: path.join(census, 'evidence/entity-usability-v514.summary.json'),
    fieldValues: path.join(census, 'evidence/entity-field-values-v514.jsonl'),
    fieldValuesSummary: path.join(census, 'evidence/field-values-v514.summary.json'),
    currentView: path.join(census, 'evidence/current-view-v514.json'),
    checkpointR629: path.join(census, 'evidence/v515-session-checkpoint-r629.json'),
    youtubeCorrectionsV513: path.join(census, 'evidence/v513-youtube-detail-correction.json'),
    youtubeCorrectionsV514: path.join(census, 'evidence/v514-youtube-detail-corrections.json'),
    memberKeysV518: path.join(census, 'evidence/v518-v-member-keys.json'),
    mediaManifest: path.join(analysis, 'sample-manifest.json'),
    analysisRoot: analysis,
    outRoot: path.join(root, 'outputs/product-material-library-phase1-20261006'),
    docsRoot: path.join(root, 'docs/product-material-library'),
    codeRoot: path.join(root, 'tools/material-library'),
  };
}

// 平台显示名（实体决策层）↔ 源 slug（字段层）。两层命名不同，join 必须显式映射。
export const PLATFORMS = [
  { key: 'TikTok', slug: 'tiktok', label: 'TikTok', namespace: 'main', expectedV: 128 },
  { key: 'Instagram', slug: 'instagram', label: 'Instagram', namespace: 'main', expectedV: 116 },
  { key: 'YouTube', slug: 'youtube', label: 'YouTube', namespace: 'main', expectedV: 43 },
  { key: 'Douyin', slug: 'douyin', label: 'Douyin', namespace: 'main', expectedV: 5883 },
  { key: 'Kuaishou', slug: 'kuaishou', label: 'Kuaishou', namespace: 'main', expectedV: 59 },
  { key: 'Xiaohongshu', slug: 'xiaohongshu', label: 'Xiaohongshu', namespace: 'main', expectedV: 821 },
  { key: 'Bilibili', slug: 'bilibili', label: 'Bilibili (BV main series)', namespace: 'main', expectedV: 1200 },
  { key: 'WeChat Channels', slug: 'wechat', label: 'WeChat Channels', namespace: 'main', expectedV: 170 },
];

// aid 分支：同一平台不同 id 命名空间，**永不**并入任何合并唯一总数。
export const AID_BRANCH = {
  key: 'Bilibili', slug: 'bilibili', label: 'Bilibili (aid branch)', namespace: 'aid', expectedV: 222,
};

export const EXPECTED_MAIN_V = 8420;

export const DISPLAY_TO_SLUG = Object.fromEntries(
  [...PLATFORMS, AID_BRANCH].map((p) => [`${p.key}|${p.namespace}`, p.slug]),
);

// 冻结发布窗口（半开区间，Asia/Shanghai 2026-08-23 01:08:44 .. 2026-09-22 01:08:44）
export const WINDOW = { start: 1787418524, end: 1790010524 };

// 实体决策 → 归一化成员资格
export const DECISION_INCLUDE = 'INCLUDE_VIDEO';
export const DECISION_REPLAY = 'INCLUDE_STREAM_REPLAY';
export const DECISION_IMAGE_NOTE = 'EXCLUDE_IMAGE_NOTE';
export const DECISION_AD = 'EXCLUDE_CONFIRMED_AD';
export const DECISION_OUT_OF_WINDOW = 'EXCLUDE_OUT_OF_WINDOW';

// 源字段可用性（保留证据的原始取值）
export const SOURCE_AVAILABILITY = {
  PRESENT: 'present_and_usable',
  UNUSABLE: 'present_but_ambiguous_or_unusable',
  ABSENT: 'absent_in_inspected_source',
};

// 归一化后的观测状态。缺失/来源不可用/不可用/未知/错误/观测零互不混同。
export const OBSERVATION_STATUS = {
  VALUE: 'value',
  OBSERVED_ZERO: 'observed_zero',
  ABSENT: 'absent',
  UNAVAILABLE_SOURCE: 'source_unavailable',
  UNUSABLE: 'unusable',
  UNKNOWN: 'unknown',
  ERROR: 'error',
};

// 实体级「字段从未被观测到」的原因类 → 归一化来源可用性
export const JOIN_REASON_TO_SOURCE_STATE = {
  no_retained_copy_for_platform: OBSERVATION_STATUS.UNAVAILABLE_SOURCE,
  source_page_never_filed: OBSERVATION_STATUS.UNAVAILABLE_SOURCE,
  unretained_temp_spill: OBSERVATION_STATUS.UNAVAILABLE_SOURCE,
  retained_copies_lack_this_id: OBSERVATION_STATUS.UNAVAILABLE_SOURCE,
  transcribed_only_no_copy: OBSERVATION_STATUS.UNKNOWN,
  claimed_payload_not_established: OBSERVATION_STATUS.UNKNOWN,
};

// 计量语义：哪些字段是互动计量、哪些是身份/元数据（不是互动，不得当互动用）
export const NON_ENGAGEMENT_FIELDS = new Set([
  'author_follower_count', 'duration', 'product_price', 'sales_quantity',
  'publication_time', 'author_id', 'author_display_name', 'canonical_url',
  'derived_permalink', 'media_type', 'language', 'geography_or_region',
  'ad_marker_branded_content', 'ad_marker_paid_partnership', 'ad_marker_search_placement',
  'product_linked_identity', 'product_tag_or_eligibility', 'publication_time_label',
]);

export const ENGAGEMENT_FIELDS = new Set([
  'engagement_like', 'engagement_comment', 'engagement_share',
  'engagement_play', 'engagement_collect', 'engagement_danmaku',
]);

// 互动率口径。TikTok 采用讨论中引用的 Rival IQ 口径；其余平台保留各自真实可用合同。
// 参与方必须同一条视频、同一次观测，且分母 > 0；收藏(saves/collect)另列，不并入分子。
export const RATIO_RULES = {
  tiktok_engagement_rate: {
    key: 'tiktok_engagement_rate',
    label: 'TikTok 互动率 (likes+comments+shares)/views*100%',
    platforms: ['TikTok'],
    numeratorFields: ['engagement_like', 'engagement_comment', 'engagement_share'],
    denominatorField: 'engagement_play',
    scale: 100,
    unit: 'percent',
    requiresSameObservation: true,
    denominatorMustBePositive: true,
    savesField: null, // 普查未留存 TikTok 收藏字段 → 记为 absent，不填 0
    attribution: 'Rival IQ engagement-rate definition (attributed methodology, not a universal industry standard)',
    source: 'https://help.rivaliq.com/en/articles/2043672-understanding-engagement-rates',
  },
};

// 行业方法论（标注来源，用于人工判断；不据勾选项推销量）
export const METHODOLOGY = [
  {
    id: 'tiktok_top_ads',
    label: 'TikTok Top Ads（按地区/行业/目标/时间分组后比较）',
    source: 'https://ads.tiktok.com/business/library/NA_Creative_Center_Top_Ads_One_Pager.pdf',
    note: '广告样本，不代表全部内容；本项目普查已排除广告，不得据此改资格或启动广告采集。',
  },
  {
    id: 'rival_iq_engagement',
    label: 'Rival IQ 互动率口径',
    source: 'https://help.rivaliq.com/en/articles/2043672-understanding-engagement-rates',
    note: '成熟工具口径，非全行业唯一公式；Socialinsider 含收藏，不能混用其基准。',
  },
  {
    id: 'tiktok_creative_codes',
    label: 'TikTok Creative Codes（hook / body / close）',
    source: 'https://ads.tiktok.com/business/en-US/creative-codes',
    note: '用于标注有证据的表达手法，不据勾选项推销量。',
  },
  {
    id: 'google_abcd',
    label: 'Google ABCD（注意 / 品牌·产品 / 联系 / 行动）',
    source: 'https://support.google.com/google-ads/answer/14783551?hl=en-1',
    note: '同上，仅作有证据的标注框架。',
  },
];

// 价值类别（可解释标签）。标签只由「有证据的事实」推出，不由数值阈值推出。
export const VALUE_CATEGORIES = ['performance_reference', 'creative_reference', 'product_demand_clue'];

// 数值入选阈值：**项目建议**，未批准，不参与自动筛选，仅供人工复核时参考。
export const PROPOSED_CUTOFFS = {
  status: 'PROPOSED_NOT_APPROVED',
  note: '数值阈值必须在核对既有数据分布后由业务方确认；本阶段不用于自动入选或硬筛选。',
  proposals: [
    {
      id: 'tiktok_engagement_rate_p75',
      basis: 'same platform + same window + same ratio rule',
      minSample: 30,
      rule: '在同平台同口径可比集合内，互动率位于第 75 百分位及以上者可作为「表现参考」人工复核候选',
      approved: false,
    },
    {
      id: 'min_sample_for_ranking',
      basis: 'any descriptive ranking',
      minSample: 30,
      rule: '可比集合样本 < 30 时只输出描述统计，不输出排名',
      approved: false,
    },
  ],
};

// 支持来源支持的分类词表；普查未留存这些字段 → 一律 unknown，不臆造。
export const TAXONOMY = {
  product_category: { sourceFields: [], note: '普查未留存产品类别字段 → unknown' },
  product_function: { sourceFields: [], note: '普查未留存产品功能字段 → unknown' },
  scene_or_need: { sourceFields: [], note: '普查未留存场景/需求字段 → unknown' },
  platform: { sourceFields: ['platform'], note: '来自实体层 platform' },
  language: { sourceFields: ['language'], note: '仅部分平台留存；缺失记 unknown' },
  publish_date: { sourceFields: ['publication_time'], note: 'epoch 秒；缺失记 unknown（不得用观测时间顶替）' },
  observation_date: { sourceFields: ['observed_at_epoch_s'], note: '字段观测时刻，与发布时间分开' },
  media_availability: { sourceFields: ['media'], note: '仅 20 条既有媒体；其余 available=false' },
  review_status: { sourceFields: ['review'], note: '人工复核状态，初始 pending/未复核' },
};

export function slugFor(platformDisplay, namespace) {
  return DISPLAY_TO_SLUG[`${platformDisplay}|${namespace}`] ?? null;
}

// ── v5 字段合同对齐（只读引用，不改写能力包） ─────────────────────────────────
// 来源：D:/Codex-local/harness-workspaces/Phonecase/outputs/tikhub-capability-verification-20260922/field-dictionary-v5.json
// 入口：R/docs/knowledge/topics/tikhub-mcp.md。本阶段**不发起任何 TikHub 请求**，只用其已验语义对齐本库字段含义。
export const V5_FIELD_CONTRACT = {
  entry: 'C:/Users/ahjxs/Documents/Codex/2026-08-24/new-chat/outputs/claude-to-codex-migration/docs/knowledge/topics/tikhub-mcp.md',
  dictionary: 'D:/Codex-local/harness-workspaces/Phonecase/outputs/tikhub-capability-verification-20260922/field-dictionary-v5.json',
  schema_version: 2,
  revision: 'v5-R7F1',
  required_field_meanings: [
    'native_id', 'public_url', 'publication_time', 'entity_type', 'ad_or_promotion_status',
    'views', 'likes', 'comments', 'shares', 'saves', 'language', 'query_region',
    'author_region', 'location_tag', 'audience_region', 'author_id', 'product_id',
    'product_association', 'sales_quantity', 'sales_time_window', 'requested_entity_flag',
    'declared_result_total',
  ],
};

// v5 的零/空/缺失/隐藏语义是本库可用性状态机的权威依据。
export const V5_VALUE_SEMANTICS = {
  zero: 'A literal 0 is a real reported zero for a COUNT field; for a display STRING no numeric zero may be inferred.',
  zero_route_qualified: 'A literal 0 on a COUNT field is a provider-reported value for that route; it is NOT a universal "missing" marker.',
  null: 'JSON null means present-but-not-set; it is distinct from an absent key and from 0.',
  missing: 'An absent key means the provider returned no value for that entity; it must not be coerced to 0 or null.',
  missing_route_scoped: 'An absent key means this route returned no value for that entity; it does not establish that the platform never exposes the field.',
  hidden: 'A companion *_disabled / hidden_* flag means the platform suppresses the value; the numeric field may then be meaningless.',
};

// 普查字段层 → v5 规范 field_meaning 的显式映射。
// null 表示 v5 已验含义表中**没有**等价槽位：此时不得硬套一个含义，保持平台自有语义并标注。
export const CENSUS_FIELD_TO_V5_MEANING = {
  engagement_like: 'likes',
  engagement_comment: 'comments',
  engagement_share: 'shares',
  engagement_collect: 'saves',
  engagement_play: 'views',
  engagement_danmaku: null,               // 平台特有；v5 无等价槽位
  canonical_url: 'public_url',
  derived_permalink: 'public_url',        // 派生且未访问验证 → 见 DERIVED_URL_NOTE
  publication_time: 'publication_time',
  publication_time_label: null,           // 相对/文本标签，非绝对时间
  author_id: 'author_id',
  author_display_name: null,              // 显示名，非 v5 含义槽位
  author_follower_count: null,            // 明确 not_engagement；v5 无等价槽位
  geography_or_region: 'AMBIGUOUS',       // v5 区分 query/author/audience_region 与 location_tag
  language: 'language',
  media_type: 'entity_type',
  duration: null,                         // v5 无等价槽位（且单位/含义需逐路线核对）
  ad_marker_search_placement: 'ad_or_promotion_status',
  ad_marker_paid_partnership: 'ad_or_promotion_status',
  ad_marker_branded_content: 'ad_or_promotion_status',
  product_tag_or_eligibility: 'product_association',
  product_linked_identity: 'product_id',
  product_price: null,                    // 价格文本 ≠ 销量；v5 无等价槽位
  sales_quantity: 'sales_quantity',
};

export const DERIVED_URL_NOTE = 'derived_permalink 由 id 拼接而成、**未经访问验证**；v5 明确「URL身份不等于可达」。它与来源自述的 canonical_url 不可互换。';

// 含义歧义字段：单一普查字段对应 v5 多个不同语义槽位 → 必须逐条判定，不得整体套用。
export const AMBIGUOUS_MEANING_FIELDS = {
  geography_or_region: {
    may_mean: ['query_region', 'author_region', 'audience_region', 'location_tag'],
    rule: '普查层只有一个合并槽位；v5 证明这四个是不同语义。导入时保持 unknown 归属，只有来源明示归属才可标注，不得默认当作受众市场。',
  },
};

// 指标定义：详情页必须能说明「这个数是什么」。文案只陈述来源与口径边界，不做效果结论。
// 跨平台可比性一律为 false —— 普查已明确「跨平台可比性未建立」。
export const METRIC_DEFINITIONS = {
  engagement_like: { definition: '平台公开点赞计数（对应 v5 规范含义 likes）', unit_basis: '平台公开count字段', caveat: '提供商上报值；未独立复核，跨平台不可比' },
  engagement_comment: { definition: '平台公开评论计数（v5: comments）', unit_basis: '平台公开count字段', caveat: '不含未展开的二级评论含义差异' },
  engagement_share: { definition: '平台公开分享计数（v5: shares）', unit_basis: '平台公开count字段', caveat: '各平台分享定义未逐一验证' },
  engagement_collect: { definition: '平台公开收藏计数（v5: saves）', unit_basis: '平台公开count字段', caveat: '收藏不并入互动率分子' },
  engagement_play: { definition: '平台播放/观看计数（v5: views）', unit_basis: '平台公开count字段', caveat: '各平台“播放/观看”定义不同，跨平台不可比' },
  engagement_danmaku: { definition: '弹幕计数（平台特有）', unit_basis: '平台公开count字段', caveat: 'v5 无等价含义槽位；属平台特有计量' },
  author_follower_count: { definition: '作者粉丝数', unit_basis: '平台公开count字段', caveat: '粉丝数≠互动量；可用范围很窄' },
  publication_time: { definition: '作品发布时间（epoch 秒）', unit_basis: '来源自述绝对时间', caveat: '相对标签不得当作绝对时间' },
  publication_time_label: { definition: '仅相对/文本形式的时间标签', unit_basis: '来源自述文本', caveat: '不是绝对时间，不参与窗口判定' },
  duration: { definition: '作品时长（秒）', unit_basis: '来源自述时长', caveat: '部分平台单位/含义未逐一验证' },
  canonical_url: { definition: '来源自述的规范链接', unit_basis: '来源payload', caveat: '保留 URL ≠ 当前可访问' },
  derived_permalink: { definition: '由 id 拼接得到的派生链接', unit_basis: '本地派生', caveat: '未经访问验证；与 canonical_url 不可互换' },
  author_id: { definition: '作者稳定标识', unit_basis: '来源payload', caveat: '缺失时不得按显示名归并' },
  author_display_name: { definition: '作者显示名', unit_basis: '来源payload', caveat: '显示名不是稳定身份' },
  language: { definition: '来源标注/推断的语言', unit_basis: '来源payload或查询身份', caveat: '查询语言身份不等于内容语言；缺失保持 unknown' },
  geography_or_region: { definition: '地区/地域（普查层的合并槽位）', unit_basis: '来源payload', caveat: 'v5 区分 query/author/audience_region 与 location_tag 四个语义 → 本库保持 unknown，不得当作受众市场' },
  media_type: { definition: '媒体类型（视频/图文/回放等）', unit_basis: '来源payload', caveat: null },
  ad_marker_search_placement: { definition: '搜索位广告/推广标记', unit_basis: '来源payload', caveat: '标记存在不证明投放效果' },
  ad_marker_paid_partnership: { definition: '付费合作标记', unit_basis: '来源payload', caveat: '标记存在不证明品牌合作已成立' },
  ad_marker_branded_content: { definition: '品牌内容标记', unit_basis: '来源payload', caveat: '同上' },
  product_tag_or_eligibility: { definition: '商品挂载/资格标记', unit_basis: '来源payload', caveat: '挂载/资格≠销售，也≠带货' },
  product_linked_identity: { definition: '关联商品身份', unit_basis: '来源payload', caveat: '关联≠销量，也≠同SKU证明' },
  product_price: { definition: '价格文本', unit_basis: '来源payload', caveat: '不是成交价，也不是销量' },
  sales_quantity: { definition: '销量', unit_basis: '来源payload', caveat: '本阶段八平台均无留存；不得由热度代理' },
};

export function metricDefinitionFor(field) {
  const d = METRIC_DEFINITIONS[field];
  if (d) return { ...d, comparable_across_platforms: false, source: 'census-field-contract + v5 alignment' };
  return {
    definition: `未登记的字段：${field}（按来源原样保留，未赋予额外含义）`,
    unit_basis: null, caveat: '本库未为该字段登记定义，不得据其作事实陈述',
    comparable_across_platforms: false, source: 'unregistered',
  };
}

export function v5MeaningFor(censusField) {  const m = CENSUS_FIELD_TO_V5_MEANING[censusField];
  if (m === undefined) return { mapping: 'unmapped', canonical: null };
  if (m === null) return { mapping: 'no_equivalent_slot', canonical: null };
  if (m === 'AMBIGUOUS') return { mapping: 'ambiguous_multi_meaning', canonical: null, candidates: AMBIGUOUS_MEANING_FIELDS[censusField]?.may_mean ?? [] };
  return { mapping: 'mapped', canonical: m };
}


export function expectedVFor(platformDisplay, namespace) {
  const p = [...PLATFORMS, AID_BRANCH].find((x) => x.key === platformDisplay && x.namespace === namespace);
  return p ? p.expectedV : null;
}

// 类型/单位校验：只在**普查已判定为 present_and_usable** 的值上做本库自己的校验。
// 不得回头改写普查已判定的 absent/unusable —— 那是来源事实，不是本库的判断。
export const COUNT_FIELDS = new Set([
  'engagement_like', 'engagement_comment', 'engagement_share',
  'engagement_collect', 'engagement_danmaku', 'engagement_play', 'author_follower_count',
]);
export const EPOCH_FIELDS = new Set(['publication_time']);
export const URL_FIELDS = new Set(['canonical_url']);
export const DERIVED_URL_TEMPLATE_FIELDS = new Set(['derived_permalink']);

export function validateObservation({ field, value, numericValue, derivation, rawAvailability }) {
  // 只校验普查认为可用（present_and_usable）的值；其余状态保持来源事实。
  if (rawAvailability !== SOURCE_AVAILABILITY.PRESENT) return { valid: true, rule: 'not_applicable_non_usable_availability' };
  if (COUNT_FIELDS.has(field)) {
    if (numericValue === null) return { valid: false, rule: 'count_field_value_not_numeric', detail: String(value).slice(0, 80) };
    if (numericValue < 0) return { valid: false, rule: 'count_field_negative', detail: String(numericValue) };
    return { valid: true, rule: 'count_field_non_negative_numeric' };
  }
  if (EPOCH_FIELDS.has(field)) {
    if (numericValue === null) return { valid: false, rule: 'epoch_field_value_not_numeric', detail: String(value).slice(0, 80) };
    if (!Number.isInteger(numericValue) || numericValue <= 0) return { valid: false, rule: 'epoch_field_not_positive_integer', detail: String(numericValue) };
    return { valid: true, rule: 'epoch_field_positive_integer' };
  }
  if (URL_FIELDS.has(field)) {
    if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return { valid: false, rule: 'url_field_not_http_url', detail: String(value).slice(0, 80) };
    return { valid: true, rule: 'url_field_http_url' };
  }
  if (DERIVED_URL_TEMPLATE_FIELDS.has(field)) {
    // 注意：该字段的 value 是 id，URL 在 derivation 模板里；不得对 value 做 URL 形状校验。
    if (derivation && !/^https?:\/\//i.test(derivation)) return { valid: false, rule: 'derivation_template_not_http_url', detail: String(derivation).slice(0, 80) };
    return { valid: true, rule: 'derivation_template_http_url_or_absent' };
  }
  return { valid: true, rule: 'no_type_rule_for_field' };
}

// 归一化单条字段观测。输入为保留证据中的一行 field record。
export function normalizeFieldObservation(raw) {
  const avail = raw.availability;
  const rawValue = raw.raw_value;

  let status;
  if (avail === SOURCE_AVAILABILITY.UNUSABLE) status = OBSERVATION_STATUS.UNUSABLE;
  else if (avail === SOURCE_AVAILABILITY.ABSENT) status = OBSERVATION_STATUS.ABSENT;
  else if (avail === SOURCE_AVAILABILITY.PRESENT) {
    // 观测零 vs 有值：零是**观测到的值**，不是缺失。
    const isZero = raw.zero_valued === true
      || (typeof rawValue === 'number' && rawValue === 0)
      || (typeof raw.normalized_value === 'number' && raw.normalized_value === 0);
    status = isZero ? OBSERVATION_STATUS.OBSERVED_ZERO : OBSERVATION_STATUS.VALUE;
  } else status = OBSERVATION_STATUS.UNKNOWN;

  // 长 ID / 大整数：一律以字符串承载，绝不经 Number() 丢失精度。
  let value = null;
  if (status === OBSERVATION_STATUS.VALUE || status === OBSERVATION_STATUS.OBSERVED_ZERO) {
    value = rawValue === null || rawValue === undefined ? null : String(rawValue);
  }

  const numericValue = numericOrNull(raw.normalized_value ?? rawValue);
  const v = validateObservation({ field: raw.field, value, numericValue, derivation: raw.derivation, rawAvailability: avail });
  let errorReason = null;
  if (!v.valid) {
    errorReason = v.rule;
    status = OBSERVATION_STATUS.ERROR;
  }

  return {
    field: raw.field,
    status,
    value,
    numeric_value: numericValue,
    unit: raw.unit ?? null,
    unit_basis: raw.unit_basis ?? null,
    derived: raw.derived === true,
    // 事实来源分层：来源事实 / 派生值。（人工复核在记录层，不混入观测层。）
    fact_origin: raw.derived === true ? 'derived' : 'source_fact',
    // 指标定义：详情必须能回答「这个数是什么、口径边界是什么」
    metric_definition: metricDefinitionFor(raw.field).definition,
    metric_caveat: metricDefinitionFor(raw.field).caveat,
    comparable_across_platforms: false,
    derivation: raw.derivation ?? null,
    validation: { rule: v.rule, valid: v.valid, checked_against: raw.availability },
    error_reason: errorReason,
    not_engagement: raw.not_engagement === true || NON_ENGAGEMENT_FIELDS.has(raw.field),
    product_ids: raw.product_ids ?? null,
    reason: raw.reason ?? null,
    observed_at_epoch_s: raw.observed_at_epoch_s ?? null,
    observation_basis: raw.observation_basis ?? null,
    identity_basis: raw.identity_basis ?? null,
    retention_grade: raw.retention_grade ?? null,
    locator: raw.locator ?? null,
    source_file: raw.source?.file ?? null,
    source_sha256: raw.source?.sha256 ?? null,
    source_availability: avail,
  };
}

function numericOrNull(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && !/^-?\d+(\.\d+)?$/.test(v.trim())) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// 多平台观测身份：平台/命名空间/来源/观测时刻连续性 —— 不复用旧 owned-content 的四段键。
export function observationIdentity(obs) {
  return [
    obs.platform ?? 'no_platform',
    obs.namespace ?? 'no_namespace',
    obs.native_id ?? 'no_id',
    obs.field ?? 'no_field',
    obs.observed_at_epoch_s ?? 'no_time',
    obs.source_sha256 ?? obs.source_file ?? 'no_source',
  ].join('|');
}

export function entityKey(platformDisplay, namespace, nativeId) {
  return `${platformDisplay}|${namespace}|${nativeId}`;
}

export function loadRulesConfig(root = DEFAULT_ROOT) {
  return {
    rules_version: RULES_VERSION,
    window: WINDOW,
    platforms: PLATFORMS,
    aid_branch: AID_BRANCH,
    expected_main_v: EXPECTED_MAIN_V,
    observation_status: OBSERVATION_STATUS,
    ratio_rules: RATIO_RULES,
    methodology: METHODOLOGY,
    value_categories: VALUE_CATEGORIES,
    taxonomy: TAXONOMY,
    proposed_cutoffs: PROPOSED_CUTOFFS,
  };
}

export function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); return p; }
