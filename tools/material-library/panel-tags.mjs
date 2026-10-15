// tools/material-library/panel-tags.mjs —— R-9：标签维度（词表 + SQL 谓词）。
// 口径：与卡片上已有的标签同源（app.js `cardTags()`）；所有计数/筛选都在**可浏览范围 T1+T2+T3** 之内。
// 边界：纯只读常量 + 纯函数；不联网、不写库、不含凭据。
// 词表原文与谓词原文同时写入验收证据：O/evidence/r8r9-filter-tag-verify.json。
export const BROWSE_TIERS = ['T1_media', 'T2_strong', 'T3_standard'];

const SC = `value_tier IN ('${BROWSE_TIERS.join("','")}')`;
const EXISTS_SEG = 'EXISTS (SELECT 1 FROM segments s WHERE s.entity_key = materials.entity_key)';
const EXISTS_MEDIA = 'EXISTS (SELECT 1 FROM assets a WHERE a.entity_key = materials.entity_key AND a.usable_as_video = 1)';
const NOTE_PRED = "(COALESCE(review_notes,'') <> '' OR COALESCE(human_note,'') <> '')";

export const TAG_DEFS = [
  { tag: 'T1 有本地视频', predicate: "value_tier = 'T1_media'", basis: '库内 value_tier 键' },
  { tag: 'T2 证据充分', predicate: "value_tier = 'T2_strong'", basis: '库内 value_tier 键' },
  { tag: 'T3 标准证据', predicate: "value_tier = 'T3_standard'", basis: '库内 value_tier 键' },
  { tag: 'T4 低信息量', predicate: "value_tier = 'T4_lowinfo'", basis: '库内 value_tier 键（浏览范围内应为 0）' },
  { tag: '有本地视频', predicate: EXISTS_MEDIA, basis: '存在 usable_as_video=1 的资产' },
  { tag: '有片段', predicate: EXISTS_SEG, basis: '存在 segments 行（即 segment_count>0）' },
  { tag: '有备注', predicate: NOTE_PRED, basis: 'review_notes 或 human_note 非空' },
  { tag: '有关键数据', predicate: 'COALESCE(metrics_observed,0) > 0', basis: 'metrics_observed > 0' },
  { tag: '来源待确认', predicate: "entity_source_state IS NULL OR entity_source_state = 'unknown'", basis: `浏览范围内为空或 'unknown'` },
  { tag: '采集不到来源', predicate: "entity_source_state = 'source_unavailable'", basis: `库内 entity_source_state='source_unavailable'` },
  { tag: '日期未知', predicate: 'publish_date_epoch_s IS NULL', basis: '无发布日期的观测（与 /api/items?date_unknown=1 同一谓词）' },
];

export const TAG_NAMES = TAG_DEFS.map((t) => t.tag);

export const DATE_UNKNOWN_PREDICATE = 'publish_date_epoch_s IS NULL';

export function tagDefOf(name) {
  const key = String(name ?? '');
  return TAG_DEFS.find((t) => t.tag === key) ?? TAG_DEFS.find((t) => t.tag.toLowerCase() === key.toLowerCase()) ?? null;
}

// tag ← 名称；verdict 说明是否命中固定词表（未知词表项返回 { predicate: null }，调用方据此返回 0 条而不是忽略该条件）
export function tagPredicateOf(name) {
  const def = tagDefOf(name);
  if (!def) return { known: false, tag: String(name ?? ''), predicate: null, basis: null };
  return { known: true, tag: def.tag, predicate: `(${def.predicate})`, basis: def.basis };
}

export function tagCountsSql() {
  return Object.fromEntries(TAG_DEFS.map((t) => [t.tag, `SELECT COUNT(*) AS n FROM materials WHERE ${SC} AND (${t.predicate})`]));
}
