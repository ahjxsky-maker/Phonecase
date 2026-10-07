// tools/material-library/sample.mjs
// R5 STEP3：**代表身份清单**的构造、校验与解析。
//
// 复审事实（5.6）：r4 用的 `records.slice(0, 25)` 只是文件前缀——独立检查显示那 25 条全是 TikTok、
// 6 资产/72 片段，不能代表原批准条件（八平台、长 ID、中文、媒体/片段、来源不可用分支）。
// 本模块把「代表性」变成可复核的对象：显式覆盖条件 + 稳定身份键 + 覆盖说明，供同一 HTTP 导入消费。
import { TABLE_ASSETS, TABLE_METRICS, TABLE_RATIOS, TABLE_SEGMENTS, TABLE_VIDEOS } from './baserow.mjs';

export const SAMPLE_MANIFEST_VERSION = 1;

const hasChinese = (s) => typeof s === 'string' && /[\u4e00-\u9fff]/.test(s);
const isLongId = (s) => typeof s === 'string' && /^\d+$/.test(s) && BigInt(s) > 9007199254740991n;

function chineseSignal(r) {
  if (hasChinese(r.identity.author_display_name)) return true;
  for (const a of r.assets ?? []) for (const s of a.segments ?? []) {
    if (hasChinese(s.observed) || hasChinese(s.onscreen_text) || hasChinese(s.speech)) return true;
  }
  return false;
}

/** 逐条覆盖说明：用**实际被选中的身份**说明覆盖情况，而不是宣称。 */
export function coverageOf(records) {
  const byBranch = {};
  let longIds = 0, chinese = 0, withMedia = 0, withSegments = 0, observed = 0, unobserved = 0;
  const relationEdges = { video_asset: 0, asset_segment: 0, video_metric: 0, video_ratio: 0 };
  for (const r of records) {
    const b = `${r.platform}|${r.namespace}`;
    byBranch[b] = (byBranch[b] ?? 0) + 1;
    if (isLongId(r.native_id)) longIds++;
    if (chineseSignal(r)) chinese++;
    const assets = r.assets ?? [];
    if (assets.length) withMedia++;
    const segs = assets.reduce((n, a) => n + (a.segments ?? []).length, 0);
    if (segs) withSegments++;
    if (r.availability?.entity_source_state === 'observed') observed++; else unobserved++;
    relationEdges.video_asset += assets.length;
    relationEdges.asset_segment += segs;
    relationEdges.video_metric += (r.metrics ?? []).length;
    relationEdges.video_ratio += (r.ratios ?? []).length;
  }
  return {
    chosen: records.length,
    by_platform_namespace: byBranch,
    distinct_platforms: new Set(records.map((r) => r.platform)).size,
    distinct_namespaces: new Set(records.map((r) => r.namespace)).size,
    long_id_count: longIds,
    chinese_text_count: chinese,
    with_media_count: withMedia,
    with_segments_count: withSegments,
    source_state: { observed, not_observed: unobserved },
    relation_edges: relationEdges,
    note: '覆盖按**实际选中的身份**统计；缺失项以 0 呈现，不用推断补齐，也不代表全量比例。',
  };
}

/**
 * 构造代表性清单（确定性、非前缀）：按 platform|namespace 分组，每组优先纳入
 * 「有媒体且带片段 / 长 ID / 中文文本 / 来源不可用 / 观测最多」这几类条件持有者，再轮转补齐到 size。
 */
export function buildRepresentativeSample(records, { size = 25 } = {}) {
  const groups = new Map();
  for (const r of records) {
    const b = `${r.platform}|${r.namespace}`;
    if (!groups.has(b)) groups.set(b, []);
    groups.get(b).push(r);
  }
  const picked = [];
  const seen = new Set();
  const add = (r) => {
    if (!r || seen.has(r.entity_key)) return false;
    seen.add(r.entity_key); picked.push(r); return true;
  };
  const conds = [
    (l) => l.find((r) => (r.assets ?? []).some((a) => (a.segments ?? []).length > 0)),
    (l) => l.find((r) => isLongId(r.native_id)),
    (l) => l.find((r) => chineseSignal(r)),
    (l) => l.find((r) => r.availability?.entity_source_state !== 'observed'),
    (l) => l.find((r) => (r.assets ?? []).length > 0),
    (l) => [...l].sort((a, b) => (b.availability?.fields_observed ?? 0) - (a.availability?.fields_observed ?? 0))[0],
  ];
  for (const [, list] of groups) for (const c of conds) add(c(list));
  // 轮转补齐：跨平台交替，避免再次退化成单一平台的前缀
  const queues = [...groups.values()].map((l) => l.filter((r) => !seen.has(r.entity_key)));
  let progress = true;
  while (picked.length < size && progress) {
    progress = false;
    for (const q of queues) {
      if (picked.length >= size) break;
      const next = q.shift();
      if (next) { add(next); progress = true; }
    }
  }
  const chosen = picked.slice(0, size);
  return {
    version: SAMPLE_MANIFEST_VERSION,
    entity_keys: chosen.map((r) => r.entity_key),
    coverage: coverageOf(chosen),
    selection_rule: 'platform|namespace 分组后按「含片段 / 长 ID / 中文 / 来源不可用 / 有媒体 / 观测最多」优先，再跨平台轮转补齐；非文件前缀。',
    generated_from: { total_records: records.length, groups: groups.size },
  };
}

/** 形状校验：不接受缺字段/错类型的清单（避免“看起来像清单”就算通过）。 */
export function validateManifest(manifest) {
  const problems = [];
  if (!manifest || typeof manifest !== 'object') problems.push('manifest_not_an_object');
  else {
    if (manifest.version !== SAMPLE_MANIFEST_VERSION) problems.push(`unexpected_version:${manifest.version}`);
    if (!Array.isArray(manifest.entity_keys)) problems.push('entity_keys_not_an_array');
    else if (manifest.entity_keys.some((k) => typeof k !== 'string' || !k.includes('|'))) problems.push('entity_keys_must_be_non_empty_string_keys');
    if (manifest.coverage === undefined || typeof manifest.coverage !== 'object') problems.push('coverage_missing');
  }
  return { ok: problems.length === 0, problems };
}

/**
 * 解析清单为记录：未知键与重复键**显式拒绝**，不合成替代、不自动扩张为全量。
 * @returns {{ok:boolean, records:Array, unknown_keys:string[], duplicate_keys:string[], problems:string[]}}
 */
export function resolveManifest(records, manifest) {
  const shape = validateManifest(manifest);
  if (!shape.ok) return { ok: false, records: [], unknown_keys: [], duplicate_keys: [], problems: shape.problems };
  const byKey = new Map(records.map((r) => [r.entity_key, r]));
  const unknown = [], duplicate = [], out = [], seen = new Set();
  for (const k of manifest.entity_keys) {
    if (seen.has(k)) { duplicate.push(k); continue; }
    seen.add(k);
    const r = byKey.get(k);
    if (!r) { unknown.push(k); continue; }
    out.push(r);
  }
  const problems = [];
  if (unknown.length) problems.push(`unknown_entity_keys:${unknown.length}`);
  if (duplicate.length) problems.push(`duplicate_entity_keys:${duplicate.length}`);
  return { ok: problems.length === 0, records: out, unknown_keys: unknown, duplicate_keys: duplicate, problems };
}

/** 清单选择涉及的五表规模（供回执与“代表样本 → 有限批次 → 全量”的命令区分）。 */
export function plannedTables(records) {
  const n = { [TABLE_VIDEOS]: 0, [TABLE_ASSETS]: 0, [TABLE_SEGMENTS]: 0, [TABLE_METRICS]: 0, [TABLE_RATIOS]: 0 };
  for (const r of records) {
    n[TABLE_VIDEOS]++;
    n[TABLE_METRICS] += (r.metrics ?? []).length;
    n[TABLE_RATIOS] += (r.ratios ?? []).length;
    n[TABLE_ASSETS] += (r.assets ?? []).length;
    n[TABLE_SEGMENTS] += (r.assets ?? []).reduce((a, x) => a + (x.segments ?? []).length, 0);
  }
  return n;
}
