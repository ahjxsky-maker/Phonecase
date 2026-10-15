// tools/material-library/panel-metrics.mjs —— P0「列表卡片化」用的纯函数（无副作用、可单测）。
// 职责：把 Metric observations 的原始行，按业务口径折成列表卡片需要的 3 个关键数字；
//       把实现词（unreviewed/observed/…）翻成业务词；给没有标题字段的素材一个可读标题。
// 边界：只读入参、不改任何数据；不接触凭据；不发起网络请求。

/** 列表卡片显示的 3 个关键数字（顺序即展示顺序）。改这里就等于改口径。 */
export const KEY_METRIC_FIELDS = [
  { field: 'engagement_play', label: '播放' },
  { field: 'engagement_like', label: '点赞' },
  { field: 'engagement_comment', label: '评论' },
];

/** 只有这两种状态算「真实观测」；absent / unusable / 空 一律不算（显示「—」而不是 0）。 */
export const REAL_METRIC_STATUS = new Set(['value', 'observed_zero']);

const scalar = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v.value : v);

function toNumber(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 取一条观测的数值：优先 numeric_value，退回 value_text（长 ID 不参与这里的数值比较）。 */
export function metricNumber(row) {
  const n = toNumber(row?.numeric_value);
  if (n !== null) return n;
  return toNumber(row?.value_text);
}

export function metricStatus(row) {
  return String(scalar(row?.status) ?? '');
}

export function isRealObservation(row) {
  return REAL_METRIC_STATUS.has(metricStatus(row));
}

/** 每条身份的真实观测条数（列表用「N 条关键数据」表达）。 */
export function countRealObservations(rows, entityKey) {
  let n = 0;
  for (const r of rows ?? []) if (String(r?.entity_key ?? '') === entityKey && isRealObservation(r)) n += 1;
  return n;
}

/**
 * 从全量观测行中，为每个身份挑出「每个指标字段最新的一条真实观测」。
 * 返回 Map<entity_key, Map<field, row>>；非真实观测不进入结果（不会把 absent 当成最新值）。
 */
export function indexLatestRealMetrics(rows) {
  const byKey = new Map();
  for (const r of rows ?? []) {
    if (!isRealObservation(r)) continue;
    const key = String(r?.entity_key ?? '');
    if (!key) continue;
    const field = String(r?.field ?? '');
    if (!field) continue;
    const at = toNumber(r?.observed_at_epoch_s) ?? 0;
    if (!byKey.has(key)) byKey.set(key, new Map());
    const per = byKey.get(key);
    const prev = per.get(field);
    const prevAt = prev ? (toNumber(prev?.observed_at_epoch_s) ?? 0) : -1;
    if (!prev || at >= prevAt) per.set(field, r);
  }
  return byKey;
}

/**
 * 列表卡片要显示的 3 个关键数字。
 * 缺失 → 该位置为 null（页面显示「—」）；真实观测到的 0 → value:0（页面显示 0，两者语义不同）。
 */
export function keyMetricsOf(index, entityKey) {
  const per = index instanceof Map ? index.get(String(entityKey)) : null;
  const out = {};
  for (const { field, label } of KEY_METRIC_FIELDS) {
    const row = per ? per.get(field) : null;
    const value = row ? metricNumber(row) : null;
    out[field] = {
      label,
      value: row && value !== null ? value : null,
      // 显示串由服务端统一生成（唯一口径）：缺失显示「—」，真实观测到的 0 显示 0
      display: formatMetricValue(row && value !== null ? value : null),
      status: row ? metricStatus(row) : null,
      observed_at_epoch_s: row ? (toNumber(row.observed_at_epoch_s) ?? null) : null,
    };
  }
  return out;
}

/** 复核状态 → 业务词（只改显示，写库仍用原值）。 */
export const REVIEW_STATUS_TERMS = {
  unreviewed: '待人工复核',
  in_review: '复核中',
  reviewed: '通过',
  rejected: '排除',
};

export function reviewStatusTerm(v) {
  const s = String(v ?? '');
  return REVIEW_STATUS_TERMS[s] ?? '待人工复核';
}

/** 来源状态 → 业务词。 */
export const SOURCE_STATE_TERMS = {
  observed: '来源正常',
  source_unavailable: '采集不到来源',
  unknown: '来源待确认',
};

export function sourceStateTerm(v) {
  const s = String(v ?? '');
  return SOURCE_STATE_TERMS[s] ?? '来源待确认';
}

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * 素材标题：库里**没有标题字段**，所以按业务能读的顺序拼：
 *   人工分类（product_category，且不是「未知」）→ 平台 · 账号 · MM-DD。
 * 绝不返回 entity_key / native_id 这类实现词。
 */
export function businessTitleOf(row, { key = '' } = {}) {
  const cat = String(scalar(row?.product_category) ?? '').trim();
  const platform = String(scalar(row?.platform) ?? '').trim();
  const account = String(scalar(row?.author_display_name) ?? '').trim();
  const epoch = toNumber(scalar(row?.publish_date_epoch_s));
  let date = null;
  if (epoch !== null && epoch > 0) { // 0 视为「没有发布日期」，不能显示成 1970-01-01
    const d = new Date(epoch * 1000);
    if (!Number.isNaN(d.getTime())) date = `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  }
  const parts = [platform, account, date].filter(Boolean);
  if (cat && !/^未知/.test(cat) && cat.toLowerCase() !== 'unknown') {
    return { title: cat, basis: '人工分类', subtitle: parts.join(' · ') };
  }
  if (parts.length) return { title: parts.join(' · '), basis: '平台/账号/日期（无标题字段）', subtitle: key ? `素材编号 ${shortKey(key)}` : '' };
  return { title: key ? `素材 ${shortKey(key)}` : '（无标题信息）', basis: '无标题信息', subtitle: '' };
}

/** 展示用的短编号：只保留平台与短哈希，避免把 30+ 字符主键塞进卡片。 */
export function shortKey(key) {
  const s = String(key ?? '');
  const parts = s.split('|');
  if (parts.length >= 3) return `${parts[0]}-${String(parts[2]).slice(-6)}`;
  return s.slice(-8) || '—';
}

/** 关键数字显示格式：整数按原样，十万以上折成「万」（列表只需要量级）。 */
export function formatMetricValue(n) {
  if (n === null || n === undefined) return '—';
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 100000) return `${(v / 10000).toFixed(1).replace(/\.0$/, '')}万`;
  return String(v);
}

/** 列表默认排序键（Simon 2026-10-08 决策②「按行业看数据的优先级来」）：
 *  第一优先：有本地视频（T1）→ 证据充分（T2）→ 标准证据（T3）→ 低信息量/未分档；
 *  第二优先：播放量高的在前（没有播放量的排后）；
 *  第三优先：有片段、有条数更多的关键数据；
 *  最后：发布时间新的在前。
 *  返回一个可比较数组（越小越靠前）。 */
export function industryPriorityKey(item) {
  const tierRank = { 'T1 有本地视频': 0, 'T2 证据充分': 1, 'T3 标准证据': 2, 'T4 低信息量': 3 };
  const t = tierRank[String(item?.tier ?? '')] ?? 4;
  const media = item?.has_playable_media ? 0 : 1;
  // 注意：Number(null) 是 0，直接 Number.isFinite 会把「没有播放量」当成「播放量 0」排到真实 0 前面。
  // 规则：只有真正的数值才参与比较；没有播放量的一律排在最后（无量 ≠ 零）。
  const raw = item?.key_metrics?.engagement_play?.value;
  const play = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
  const playRank = play === null ? Number.POSITIVE_INFINITY : (-play || 0); // `|| 0` 把 -0 归一成 0，避免排序键出现 -0
  const segs = -(Number(item?.segment_count) || 0);
  const observed = -(Number(item?.metrics_observed) || 0);
  const publish = -(Number(item?.publish_epoch_s) || 0);
  return [t, media, playRank, segs, observed, publish];
}

/** 行业优先级排序（稳定：同键时按 key 字典序，保证结果可复现）。 */
export function sortByIndustryPriority(items) {
  return [...(items ?? [])].sort((a, b) => {
    const ka = industryPriorityKey(a), kb = industryPriorityKey(b);
    for (let i = 0; i < ka.length; i += 1) {
      if (ka[i] === kb[i]) continue;
      if (typeof ka[i] === 'number' && typeof kb[i] === 'number' && !Number.isFinite(ka[i]) && !Number.isFinite(kb[i])) continue;
      return ka[i] < kb[i] ? -1 : 1;
    }
    return String(a?.key ?? '').localeCompare(String(b?.key ?? ''));
  });
}
