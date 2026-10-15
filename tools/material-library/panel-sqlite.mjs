// tools/material-library/panel-sqlite.mjs —— N1/N2：**自研存储版面板服务**（读 `store/material-library.sqlite`）。
// 依据：Simon 2026-10-08 19:2x 指令（存储采 SQLite；面板用我们自己开发的页面）+ panel-v3/NEXT-PLAN.md。
// 边界：只监听 127.0.0.1；**无任何外部凭据**（不再需要 Baserow token/JWT）；只写人工字段白名单；写后读回确认 + 审计入 edits 表。
// 用法：node tools/material-library/panel-sqlite.mjs --serve --port 8792 [--db <path>] [--panel <dir>]
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, storeStats, storeMeta, keyMetricsBulk, updateHumanFields, listEdits, gapsSummary, reconcileStaleReviews, aiStateOf, aiSummary } from './store.mjs';
import { KEY_METRIC_FIELDS, reviewStatusTerm, sourceStateTerm, businessTitleOf, shortKey, formatMetricValue } from './panel-metrics.mjs';
import { LIBRARY_ENTRIES, ENTRY_BY_ID, STRUCTURE_ROLES, buildSegmentLibrary, listEntrySegments, buildStructureCenter, listSegmentsByRole, qualificationOf, pickAsset, assetRowsOf } from './segment-library.mjs';
// R-9 修复：标签维度（固定词表 + SQL 谓词，计数口径＝可浏览范围 T1+T2+T3）
import { TAG_DEFS, TAG_NAMES, tagPredicateOf, DATE_UNKNOWN_PREDICATE } from './panel-tags.mjs';
// M4（MP-08／MP-09）：拍摄计划与引用追溯
import { PLAN_ROLES, PLAN_RULES, savePlan, listPlans, readPlan, plansByMaterial, planStats } from './plan-store.mjs';
// M6（云存储，Simon 2026-10-10 批复）：面板在"本地取不到"时改发**短效签名 URL**从自有桶直取。
// 边界：只在真的需要签名时才读凭据（惰性）；读不到就如实报 `cloud_unavailable`，**不降级成公开链接**；签名 URL 不落盘、不进日志。
import { presignedGetUrl, streamGetObject } from './cloud-store.mjs';
import { backupDaily, restoreDrill, listBackups } from './cloud-backup.mjs';
import { readPolicy, decideVideoUpload, factsFor } from './cloud-policy.mjs';

export const PANEL_VERSION = 'panel-sqlite-v1';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = 'D:/Codex-local/harness-workspaces/Phonecase';
const DEFAULT_OUT = 'outputs/product-material-library-phase1-20261006';

export const HUMAN_FIELDS = ['review_status', 'review_reviewer', 'review_reviewed_at', 'review_notes', 'review_value_categories', 'selected_reference', 'review_stale', 'review_stale_reason', 'human_note',
  'product_category', 'product_function', 'scene_or_need',
  'product_category_origin', 'product_function_origin', 'scene_or_need_origin',
  'product_category_reviewer', 'product_function_reviewer', 'scene_or_need_reviewer',
  'product_category_evidence_ref', 'product_function_evidence_ref', 'scene_or_need_evidence_ref',
  'product_category_state', 'product_function_state', 'scene_or_need_state', 'value_tier'];

const SS = (options) => ({ type: 'single_select', options });
export const FIELD_META = [
  { name: 'review_status', ...SS(['unreviewed', 'in_review', 'reviewed', 'rejected']) },
  { name: 'review_reviewer', type: 'text' },
  { name: 'review_reviewed_at', type: 'date', date_include_time: true },
  { name: 'review_notes', type: 'long_text' },
  { name: 'review_value_categories', type: 'text' },
  { name: 'selected_reference', type: 'boolean' },
  { name: 'review_stale', type: 'boolean' },
  { name: 'review_stale_reason', type: 'text' },
  { name: 'human_note', type: 'long_text' },
  { name: 'product_category', type: 'text' },
  { name: 'product_function', type: 'text' },
  { name: 'scene_or_need', type: 'text' },
  { name: 'product_category_origin', ...SS(['human_review', 'source_derived', 'unknown', 'no_source', 'unknown_no_source']) },
  { name: 'product_function_origin', ...SS(['human_review', 'source_derived', 'unknown', 'no_source', 'unknown_no_source']) },
  { name: 'scene_or_need_origin', ...SS(['human_review', 'source_derived', 'unknown', 'no_source', 'unknown_no_source']) },
  { name: 'product_category_reviewer', type: 'text' },
  { name: 'product_function_reviewer', type: 'text' },
  { name: 'scene_or_need_reviewer', type: 'text' },
  { name: 'product_category_evidence_ref', type: 'text' },
  { name: 'product_function_evidence_ref', type: 'text' },
  { name: 'scene_or_need_evidence_ref', type: 'text' },
  { name: 'product_category_state', ...SS(['proposed', 'reviewed', 'rejected']) },
  { name: 'product_function_state', ...SS(['proposed', 'reviewed', 'rejected']) },
  { name: 'scene_or_need_state', ...SS(['proposed', 'reviewed', 'rejected']) },
  { name: 'value_tier', ...SS(['T1_media', 'T2_strong', 'T3_standard', 'T4_lowinfo']) },
];
const FIELD_TYPE = Object.fromEntries(FIELD_META.map((f) => [f.name, f]));

// M2：五段叙事职能（＋证据不足）。人工修正只允许取这些值；AI 输出同一套词表。
const SEGMENT_ROLES = ['HOOK', 'pain', 'scene', 'proof', 'CTA', 'insufficient_evidence'];

const TERMS = {
  review_status: { unreviewed: '待人工复核', in_review: '复核中', reviewed: '通过', rejected: '排除' },
  source_state: { observed: '来源正常', source_unavailable: '采集不到来源', unknown: '来源待确认' },
};
const TIER_TERM = { T1_media: 'T1 有本地视频', T2_strong: 'T2 证据充分', T3_standard: 'T3 标准证据', T4_lowinfo: 'T4 低信息量' };
const TIER_RANK = { T1_media: 0, T2_strong: 1, T3_standard: 2, T4_lowinfo: 3 };
// R-3 修复：分档一律以库内键为准（中文标签只用于界面显示）；服务端在边界处统一映射，键与标签都接受
const TIER_KEY_OF = {
  'T1 有本地视频': 'T1_media', 'T2 证据充分': 'T2_strong', 'T3 标准证据': 'T3_standard', 'T4 低信息量': 'T4_lowinfo',
  T1_media: 'T1_media', T2_strong: 'T2_strong', T3_standard: 'T3_standard', T4_lowinfo: 'T4_lowinfo',
};
const tierKey = (v) => TIER_KEY_OF[String(v)] ?? String(v);
// 浏览范围＝建议入库（T1+T2+T3）；T4（低信息量）与缺口另列，不在素材列表里
const BROWSE_TIERS = ['T1_media', 'T2_strong', 'T3_standard'];

const json = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(b), 'Cache-Control': 'no-store' }); res.end(b); };
const text = (v) => (typeof v === 'string' ? v.trim() : '');
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

// 封面归属**素材**（entity_key），不是某条 assets 记录：102 条平台封面所属素材本身没有视频资产，
// 若把封面挂在 assets 上，这些素材在面板里就永远看不到封面（2026-10-11 修）。
// 三态口径：最新一条封面审计决定来源——cover_fetched=平台原生封面；cover_uploaded=本地视频抽帧。
function coverInfoOf(db, key) {
  const row = db.prepare("SELECT at, changed_json, result FROM edits WHERE entity_key = ? AND result IN ('cover_fetched','cover_uploaded') ORDER BY at DESC LIMIT 1").get(key);
  if (!row) return null;
  let c = {}; try { c = JSON.parse(row.changed_json ?? '{}'); } catch { /* 留空 */ }
  const coverKey = c?.cover_key ?? null;
  if (!coverKey) return null;
  return {
    cover_key: coverKey,
    source: row.result === 'cover_fetched' ? 'platform' : 'extracted_frame',
    source_detail: c?.cover_source ?? null,
    at_seconds: c?.extracted_at_seconds ?? null,
    bytes: c?.cover_bytes ?? null,
    at: row.at ?? null,
  };
}

// 采集轮（2026-10-12）新增的"有价值"口径：**各平台热度前 30%**（判定脚本产出 valuable-selection.json）。
// 面板必须显示这条口径，否则会出现"系统已经按前 30% 传了视频，但面板写『不算有价值』"的自相矛盾。
const VALUABLE_PATH = path.join(DEFAULT_ROOT, DEFAULT_OUT, 'evidence', 'valuable-selection.json');
let valuableCache = { mtime: 0, map: new Map(), meta: null, notRankable: new Set(), platformInfo: {} };
function valuableOf(db2, key) {
  try {
    const st = fs.statSync(VALUABLE_PATH);
    const mt = st.mtimeMs;
    if (mt !== valuableCache.mtime) {
      const j = JSON.parse(fs.readFileSync(VALUABLE_PATH, 'utf8'));
      const map = new Map();
      const notRankable = new Set();
      const platformInfo = {};
      // ★ 复核 F11/F14 修复：随文件一起装载**每平台排名**（picked 本身就是按热度降序的），
      //   以及完整的"无可比热度值、不参与排名"名单；页面据此区分三种状态，而不是把两者都说成"没进前 30%"。
      for (const [platform, s] of Object.entries(j.selection ?? {})) {
        (s.picked ?? []).forEach((p, i) => map.set(p.entity_key, {
          metric: s.metric_used, score: p.score, share: j.share,
          rank: i + 1, rankable: s.rankable, quota: s.quota, browsable: s.browsable, platform,
        }));
        for (const k of (s.not_rankable_keys ?? [])) notRankable.add(k);
        // 平台级口径数字：没入选的素材也要能显示"可排名多少条、取前多少条"，否则页面上是空折线
        platformInfo[platform] = { metric_used: s.metric_used, rankable: s.rankable, quota: s.quota, browsable: s.browsable, not_rankable: s.not_rankable, play_usable: s.play_usable !== false };
      }
      valuableCache = {
        mtime: mt, map, notRankable, platformInfo,
        meta: { at: j.at, share: j.share, rule: j.rule, totals: j.totals, file_mtime: new Date(mt).toISOString(), play_usability_note: j.play_usability_note ?? null },
      };
    }
    const hit = valuableCache.map.get(key) ?? null;
    const isNotRankable = valuableCache.notRankable.has(key);
    const platform = String(key).split('|')[0];
    const pi = valuableCache.platformInfo[platform] ?? null;
    return {
      selected: Boolean(hit), ...(hit ?? {}),
      // 未入选时也带上该平台的口径数字（名次为空、条数不为空），页面才不会显示"— 条"
      platform: hit?.platform ?? platform,
      metric: hit?.metric ?? pi?.metric_used ?? null,
      rankable: hit?.rankable ?? pi?.rankable ?? null,
      quota: hit?.quota ?? pi?.quota ?? null,
      browsable: hit?.browsable ?? pi?.browsable ?? null,
      not_rankable: !hit && isNotRankable,
      state: hit ? 'selected' : (isNotRankable ? 'not_rankable' : 'rankable_but_not_selected'),
      rule_at: valuableCache.meta?.at ?? null, share: valuableCache.meta?.share ?? null,
      selection_file_mtime: valuableCache.meta?.file_mtime ?? null,
    };
  } catch (e) { return { selected: false, error: String(e?.message ?? e).slice(0, 80) }; }
}
/** 每个平台的**排名口径**（谁能用播放量排名）——单一事实来源就是判定文件本身，
 *  列表排序据此决定用播放量还是互动总量，避免"抖音播放量恒为 0 却按播放量排序"这种假排序（复核 F11）。 */
function valuablePlatformMetrics() {
  try {
    const st = fs.statSync(VALUABLE_PATH);
    if (st.mtimeMs !== valuableCache.mtime) valuableOf(null, '__warmup__');
    return Object.fromEntries(Object.entries(valuableCache.platformInfo).map(([p, s]) => [p, { play_usable: s.play_usable !== false, metric: s.metric_used }]));
  } catch { return {}; }
}

/** ★ 2026-10-13（Simon：「把左边的这些历史信息一一对应成有价值的 580 条，因为那些没价值的没用了」）：
 *  面板**作用域**由"可浏览范围（T1+T2+T3＝1,934）"改为"**有价值那批**"（valuable-selection.json 的入选集合，现值 580）。
 *  · 库内数据**不删**；`?scope=all` 可随时回到旧的 1,934 视图（可逆）。
 *  · 用 entity_key IN (?) 列表实现（580 个绑定参数，远低于 SQLite 变量上限）。
 *  · 价值名单读取失败时**退回**旧范围并在回执里写明原因，绝不静默显示 0。 */
function valuableKeys() {
  try {
    const st = fs.statSync(VALUABLE_PATH);
    if (st.mtimeMs !== valuableCache.mtime) valuableOf(null, '__warmup__');
    return [...valuableCache.map.keys()];
  } catch { return []; }
}
function scopePredicate(scopeParam) {
  const tierSql = `value_tier IN ('${BROWSE_TIERS.join("','")}')`;
  if (scopeParam === 'all') return { sql: tierSql, params: [], scope: 'browse_tiers_T1_T2_T3', label: '可浏览范围（T1+T2+T3）', fallback_reason: null };
  const keys = valuableKeys();
  if (!keys.length) return { sql: tierSql, params: [], scope: 'browse_tiers_T1_T2_T3', label: '可浏览范围（T1+T2+T3）', fallback_reason: 'valuable_selection_unavailable' };
  return { sql: `${tierSql} AND entity_key IN (${keys.map(() => '?').join(',')})`, params: keys, scope: 'valuable', label: `有价值（${keys.length} 条）`, fallback_reason: null };
}

// ★ 2026-10-13（Simon「可以 按你的建议」）：左侧要显示"AI 已标注 N/N 条 · 分段 M/M"，
//   所以 /api/summary 里补一个**跟着当前作用域走**的 AI 覆盖块（默认＝有价值 580；?scope=all 回到可浏览 1,934）。
function aiScopeOf(db, scopeParam) {
  const sp = scopePredicate(scopeParam ?? null);
  const matWhere = sp.sql;
  const inScope = `entity_key IN (SELECT entity_key FROM materials WHERE ${matWhere})`;
  const one = (q) => db.prepare(q).get(...sp.params).n;
  return {
    scope: sp.scope, label: sp.label, fallback_reason: sp.fallback_reason,
    materials_total: one(`SELECT COUNT(*) n FROM materials WHERE ${matWhere}`),
    materials_generated: one(`SELECT COUNT(*) n FROM materials WHERE ${matWhere} AND ai_status = 'generated'`),
    segments_total: one(`SELECT COUNT(*) n FROM segments WHERE ${inScope}`),
    segments_labelled: one(`SELECT COUNT(*) n FROM segment_labels WHERE ${inScope} AND ai_role IS NOT NULL`),
    note: '作用域内 AI 覆盖（materials.ai_status / segment_labels.ai_role）；与"人工待复核"是两条轴，互不影响。',
  };
}

function tierSummaryFromDb(db) {
  const rows = db.prepare('SELECT tier, records FROM tiers').all();
  const t = Object.fromEntries(rows.map((r) => [r.tier, r.records]));
  return {
    source: 'store/material-library.sqlite#tiers',
    read_at: new Date().toISOString(),
    t1_media: t.T1_media ?? null, t2_strong: t.T2_strong ?? null, t3_standard: t.T3_standard ?? null, t4_lowinfo: t.T4_lowinfo ?? null,
    recommended_import: (t.T1_media ?? 0) + (t.T2_strong ?? 0) + (t.T3_standard ?? 0),
    registered_gaps: db.prepare('SELECT COUNT(*) AS n FROM gaps').get().n,
    note: '分档与缺口来自本机 SQLite（由语料 8,642 条算得，与 M3 只读筛选证据一致）。',
  };
}

function itemOf(db, row, metrics) {
  const key = row.entity_key;
  const t = businessTitleOf(row, { key });
  const km = metrics.get(key) ?? {};
  const key_metrics = {};
  for (const f of KEY_METRIC_FIELDS) {
    const hit = km[f.field];
    key_metrics[f.field] = { field: f.field, label: f.label, value: hit ? hit.value : null, display: hit ? hit.display : '—', status: hit ? hit.status : null, observed_at_epoch_s: hit ? hit.observed_at_epoch_s : null };
  }
  const segCount = db.prepare('SELECT COUNT(*) AS n FROM segments WHERE entity_key = ?').get(key).n;
  const hasMedia = db.prepare('SELECT COUNT(*) AS n FROM assets WHERE entity_key = ? AND usable_as_video = 1').get(key).n > 0;
  return {
    key, short_key: shortKey(key), title: row.title || t.title, title_basis: row.title ? '人工标题' : t.basis, title_subtitle: t.subtitle,
    platform: row.platform, namespace: row.namespace, native_id: row.native_id, account: row.author_display_name,
    summary: row.product_category || t.title,
    publish_epoch_s: row.publish_date_epoch_s, publish_label: row.publish_date_label, duration_seconds: row.duration_seconds,
    source_state: row.entity_source_state, source_state_term: sourceStateTerm(row.entity_source_state),
    review_status: row.review_status ?? 'unreviewed', review_status_term: reviewStatusTerm(row.review_status),
    note_present: Boolean(text(row.review_notes) || text(row.human_note)), segment_count: segCount, has_playable_media: hasMedia,
    key_metrics, metrics_observed: row.metrics_observed ?? 0, tier: TIER_TERM[row.value_tier] ?? null, tier_key: row.value_tier ?? null,
    review_stale: row.review_stale === 1,
    evidence_changed: Boolean(row.review_based_on_fingerprint && (row.evidence_fingerprint ?? '') !== row.review_based_on_fingerprint),
    row_id: key,
  };
}

export function createSqlitePanelServer({ dbPath, panelDir = path.join(HERE, 'panel'), mediaBase = 'http://127.0.0.1:8791', log = console.log } = {}) {
  const db = openStore({ dbPath });
  // R-6：启动时把「复核依据的证据指纹 ≠ 当前证据指纹」的已复核行标成陈旧（真实消费路径之一）。
  const staleReconcile = { at_startup: null, last: null };
  try {
    staleReconcile.at_startup = reconcileStaleReviews(db);
    staleReconcile.last = staleReconcile.at_startup;
    if (staleReconcile.at_startup.changed) log(`stale_reconcile_at_startup:${staleReconcile.at_startup.changed}`);
  } catch (e) { staleReconcile.at_startup = { error: String(e).slice(0, 200) }; }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (url.pathname === '/api/summary') {
        const stats = storeStats(db);
        const metaInfo = storeMeta(db);
        const tier_summary = tierSummaryFromDb(db);
        return json(res, 200, {
          panel_version: PANEL_VERSION, source: 'sqlite_store', store: { path: dbPath, bytes: fs.statSync(dbPath).size, ...metaInfo },
          read_at: new Date().toISOString(),
          counts: { items: stats.materials, segments: stats.segments, metrics: stats.metrics, ratios: stats.ratios, assets: stats.assets, placeholder_rows: { note: '自研库无建表占位行（原 Baserow 的 10 行占位已按空主键识别并排除）', videos: 0, segments: 0, metrics: 0, ratios: 0, assets: 0 } },
          by_platform: stats.by_platform, by_review: stats.by_review, by_source_state: stats.by_source_state,
          writable_fields: HUMAN_FIELDS, writable_field_meta: FIELD_META, writable_field_meta_ok: true,
          key_metric_labels: KEY_METRIC_FIELDS.map((x) => ({ field: x.field, label: x.label })),
          terms: TERMS, tier_summary,
          scope: { browse_tiers: BROWSE_TIERS.map((t) => TIER_TERM[t]), browse_count: tier_summary.recommended_import, gap_count: tier_summary.registered_gaps,
      // ★ 2026-10-13：面板**默认作用域**改为"有价值那批"（见 /api/facets、/api/items 的 ?scope 参数）；这里只报口径数字。
      default_scope: 'valuable', valuable_count: valuableKeys().length, scope_all_count: tier_summary.recommended_import },
          read_only_elsewhere: true,
          // M2-F06：原先硬编码 no_ai_calls_yet:true，与库内已有的摘要/标注矛盾；改为按库现算。
          ai: aiSummary(db),
          ai_scope: aiScopeOf(db, url.searchParams.get('scope')),
          plans: planStats(db),
          // 当前工作模式（Simon 2026-10-10）：人工暂无法逐段确认，故**以 AI 建议作为生效职能**。
          // 这不会把 AI 建议写进人工列（human_role 保持原样、由人后续覆盖），只是把"生效来源"如实说出来。
          role_mode: {
            mode: 'ai_only',
            effective_source: 'ai_role',
            effective_rule: 'COALESCE(human_role, ai_role)',
            ai_labelled_segments: db.prepare('SELECT COUNT(*) AS n FROM segment_labels WHERE ai_role IS NOT NULL').get().n,
            human_decided_segments: db.prepare('SELECT COUNT(*) AS n FROM segment_labels WHERE human_role IS NOT NULL').get().n,
            // Simon 2026-10-10「先把这84条写完 判断入库」：AI 判断已被执行端正式确认为当前入库口径
            ai_mode_decided_segments: db.prepare('SELECT COUNT(*) AS n FROM segment_labels WHERE COALESCE(ai_mode_decided,0)=1').get().n,
            ai_mode_operator: 'ai-only-mode',
            note: '当前生效职能＝AI 建议（未经人工确认）；人工决定可随时在素材详情里覆盖，AI 建议不会被写成人工结论。',
          },
          stale_reconcile: staleReconcile.last,
          note: '自研 SQLite 单文件存储；浏览器不含任何凭据；仅监听回环；人工字段写后读回确认并写入 edits 表。',
        });
      }

      // M3／MP-06＋MP-07：素材中心九个入口（单位明确的计数 + 诚实空状态）与片段→来源溯源/seek。
      if (url.pathname === '/api/segment-library') {
        // M3-F02（独立复审）：结构中心的每个职能必须能取到**按该职能过滤**的片段集合。
        const roleQ = url.searchParams.get('role');
        if (roleQ) {
          if (!STRUCTURE_ROLES.includes(roleQ)) return json(res, 400, { error: 'unknown_role', role: roleQ, allowed: STRUCTURE_ROLES });
          const limitR = Math.min(Number(url.searchParams.get('limit') ?? 500) || 500, 1000);
          // ★ 第 61 轮 F61-04：支持按素材筛（`q` 子串 / `entity_key` 精确），否则计划编辑器只能取前 N 条，
          //   操作者引用不到"自己刚检索并确认过的那条素材"。
          const body = listSegmentsByRole(db, roleQ, { mediaBase, limit: limitR, q: url.searchParams.get('q'), entityKey: url.searchParams.get('entity_key') });
          return json(res, 200, { panel_version: PANEL_VERSION, role: roleQ, ...body });
        }
        const entry = url.searchParams.get('entry');
        if (!entry) {
          return json(res, 200, {
            panel_version: PANEL_VERSION,
            ...buildSegmentLibrary(db, { browseTiers: BROWSE_TIERS, mediaBase }),
          });
        }
        const one = ENTRY_BY_ID.get(entry);
        if (!one) return json(res, 404, { error: 'unknown_entry', entry, allowed: LIBRARY_ENTRIES.map((e) => e.id) });
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 200) || 200, 500);
        const offset = Math.max(Number(url.searchParams.get('offset') ?? 0) || 0, 0);
        const body = listEntrySegments(db, entry, { mediaBase, limit, offset });
        return json(res, 200, { panel_version: PANEL_VERSION, entry, name: one.name, ...body });
      }

      // M3／结构中心：按已批准五段职能浏览（与素材中心同一口径）。
      if (url.pathname === '/api/structure-center') {
        return json(res, 200, { panel_version: PANEL_VERSION, ...buildStructureCenter(db, { mediaBase }) });
      }

      // ── M4（MP-08／MP-09）：拍摄计划 ──────────────────────────────────────────────
      // MP-08：可建、可存、可重开；节点带职能、参考、**人工撰写的创作字段**与**缺口**。
      // MP-09：双向可查（计划→素材、素材→计划）；引用只存身份，改一份计划不触碰别份。
      if (url.pathname === '/api/plans') {
        return json(res, 200, { panel_version: PANEL_VERSION, at: new Date().toISOString(), ...listPlans(db), rules: PLAN_RULES });
      }

      if (url.pathname === '/api/plan' && req.method === 'GET') {
        const id = String(url.searchParams.get('id') ?? '').trim();
        if (!id) return json(res, 400, { error: 'plan_id_required' });
        const plan = readPlan(db, id, { mediaBase });
        if (!plan) return json(res, 404, { error: 'plan_not_found', plan_id: id, note: '未找到该计划（不是"空计划"）。' });
        return json(res, 200, { panel_version: PANEL_VERSION, at: new Date().toISOString(), ...plan });
      }

      if (url.pathname === '/api/plans-by-material') {
        const key = String(url.searchParams.get('entity_key') ?? '').trim();
        if (!key) return json(res, 400, { error: 'entity_key_required' });
        const segId = url.searchParams.get('segment_id');
        return json(res, 200, { panel_version: PANEL_VERSION, at: new Date().toISOString(), ...plansByMaterial(db, key, { segmentId: segId ? String(segId).trim() : null }) });
      }

      if (url.pathname === '/api/facets') {
        const sp = scopePredicate(url.searchParams.get('scope'));
        const sc = sp.sql;
        const P = sp.params;
        return json(res, 200, {
          at: new Date().toISOString(),
          scope: sp.scope, scope_label: sp.label, scope_fallback_reason: sp.fallback_reason, scope_params: P.length,
          total: db.prepare(`SELECT COUNT(*) AS n FROM materials WHERE ${sc}`).get(...P).n,
          by_platform: Object.fromEntries(db.prepare(`SELECT platform, COUNT(*) AS n FROM materials WHERE ${sc} GROUP BY platform ORDER BY n DESC`).all(...P).map((r) => [r.platform, r.n])),
          by_review: Object.fromEntries(db.prepare(`SELECT COALESCE(review_status,'unreviewed') AS s, COUNT(*) AS n FROM materials WHERE ${sc} GROUP BY s`).all(...P).map((r) => [r.s, r.n])),
          by_source_state: Object.fromEntries(db.prepare(`SELECT COALESCE(entity_source_state,'unknown') AS s, COUNT(*) AS n FROM materials WHERE ${sc} GROUP BY s`).all(...P).map((r) => [r.s, r.n])),
          by_tier: Object.fromEntries(db.prepare('SELECT value_tier AS t, COUNT(*) AS n FROM materials GROUP BY t').all().map((r) => [r.t ?? 'gap', r.n])),
          // R-9 修复：标签 facet（与界面卡片标签同源；计数口径＝当前作用域，逐项来自固定词表的 SQL 谓词）
          by_tag: Object.fromEntries(TAG_DEFS.map((t) => [t.tag, db.prepare(`SELECT COUNT(*) AS n FROM materials WHERE ${sc} AND (${t.predicate})`).get(...P).n])),
          tag_vocabulary: TAG_NAMES,
          tag_predicates: Object.fromEntries(TAG_DEFS.map((t) => [t.tag, t.predicate])),
          date_unknown: { predicate: DATE_UNKNOWN_PREDICATE, count: db.prepare(`SELECT COUNT(*) AS n FROM materials WHERE ${sc} AND ${DATE_UNKNOWN_PREDICATE}`).get(...P).n },
        });
      }

      if (url.pathname === '/api/items') {
        const q = url.searchParams;
        const size = Math.min(200, Math.max(1, Number(q.get('size') ?? 60)));
        const page = Math.max(1, Number(q.get('page') ?? 1));
        const sp = scopePredicate(q.get('scope'));
        const where = [sp.sql];
        const args = [...sp.params];
        if (q.get('platform')) { where.push('platform = ?'); args.push(q.get('platform')); }
        if (q.get('review')) { where.push("COALESCE(review_status,'unreviewed') = ?"); args.push(q.get('review')); }
        if (q.get('source')) { where.push('entity_source_state = ?'); args.push(q.get('source')); }
        if (q.get('tier')) { where.push('value_tier = ?'); args.push(tierKey(q.get('tier'))); }
        if (q.get('media') === '1') where.push('EXISTS (SELECT 1 FROM assets a WHERE a.entity_key = materials.entity_key AND a.usable_as_video = 1)');
        if (q.get('segments') === '1') where.push('EXISTS (SELECT 1 FROM segments s WHERE s.entity_key = materials.entity_key)');
        if (q.get('note') === '1') where.push("(COALESCE(review_notes,'') <> '' OR COALESCE(human_note,'') <> '')");
        if (q.get('date_from')) { where.push('publish_date_epoch_s >= ?'); args.push(Math.floor(Date.parse(q.get('date_from') + 'T00:00:00Z') / 1000)); }
        if (q.get('date_to')) { where.push('publish_date_epoch_s <= ?'); args.push(Math.floor(Date.parse(q.get('date_to') + 'T23:59:59Z') / 1000)); }
        // R-8 ② 修复：日期未知可筛（谓词与 /api/facets 的 date_unknown 完全一致）
        if (q.get('date_unknown') === '1') where.push(DATE_UNKNOWN_PREDICATE);
        // R-9 修复：标签筛选。词表内 → 用固定谓词；词表外 → 恒假（返回 0 条，绝不退化成「忽略该条件」）
        let tagFilter = null;
        if (q.get('tag') !== null && String(q.get('tag')).trim() !== '') {
          const tp = tagPredicateOf(q.get('tag'));
          tagFilter = { requested: String(q.get('tag')), matched: tp.tag, known: tp.known, predicate: tp.predicate ?? '0 = 1', basis: tp.basis };
          where.push(tagFilter.known ? tp.predicate : '0 = 1');
        }
        if (q.get('q')) {
          const like = `%${String(q.get('q')).toLowerCase()}%`;
          where.push("(LOWER(COALESCE(title,'')) LIKE ? OR LOWER(COALESCE(product_category,'')) LIKE ? OR LOWER(COALESCE(author_display_name,'')) LIKE ? OR LOWER(entity_key) LIKE ? OR LOWER(COALESCE(value_labels_json,'')) LIKE ?)");
          args.push(like, like, like, like, like);
        }
        const W = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const total = db.prepare(`SELECT COUNT(*) AS n FROM materials ${W}`).get(...args).n;
        const sort = q.get('sort') ?? 'priority';
        // ★ 复核 F11 修复：列表排序必须跟着**当前排名口径**走。
        //   抖音的播放量恒为 0（平台不报）、小红书/视频号没有播放量字段 ⇒ 按 `play_value DESC` 排等于没排。
        //   这里按判定文件里的 `play_usable` 动态决定：能用播放量的平台用播放量，其余用**互动总量**。
        const pm = valuablePlatformMetrics();
        const playPlatforms = Object.keys(pm).filter((p) => pm[p].play_usable);
        // 互动总量：每个互动字段取该素材的最新一次观测再求和（避免把时间序列的多次观测叠加）
        const INTERACTION_EXPR = `(SELECT SUM(latest.v) FROM (
            SELECT (SELECT CAST(x2.numeric_value AS REAL) FROM metrics x2
                     WHERE x2.entity_key = m.entity_key AND x2.field = x.field
                     ORDER BY x2.observed_at_epoch_s DESC LIMIT 1) AS v
              FROM metrics x WHERE x.entity_key = m.entity_key
               AND x.field IN ('engagement_like','engagement_comment','engagement_collect','engagement_share')
             GROUP BY x.field) AS latest)`;
        const SCORE_EXPR = playPlatforms.length
          ? `CASE WHEN m.platform IN (${playPlatforms.map(() => '?').join(',')}) THEN play_value ELSE ${INTERACTION_EXPR} END`
          : INTERACTION_EXPR;
        const scoreArgs = playPlatforms;
        const orderBy = sort === 'publish' ? 'publish_date_epoch_s DESC NULLS LAST'
          : sort === 'play' ? `${SCORE_EXPR} DESC NULLS LAST`
            : `CASE value_tier WHEN 'T1_media' THEN 0 WHEN 'T2_strong' THEN 1 WHEN 'T3_standard' THEN 2 ELSE 3 END,
               has_media_flag DESC, ${SCORE_EXPR} DESC NULLS LAST, (SELECT COUNT(*) FROM segments s WHERE s.entity_key = m.entity_key) DESC,
               metrics_observed DESC, publish_date_epoch_s DESC NULLS LAST`;
        const rows = db.prepare(`
          SELECT m.*,
            (SELECT MAX(CAST(x.numeric_value AS REAL)) FROM metrics x WHERE x.entity_key = m.entity_key AND x.field='engagement_play' AND x.status IN ('value','observed_zero')) AS play_value,
            (SELECT COUNT(*) FROM assets a WHERE a.entity_key = m.entity_key AND a.usable_as_video = 1) AS has_media_flag
          FROM materials m ${W.replace(/materials\./g, 'm.')} ORDER BY ${orderBy} LIMIT ? OFFSET ?`).all(...args, ...scoreArgs, size, (page - 1) * size);
        const metrics = keyMetricsBulk(db);
        // 列表卡片也要显示真封面（此前列表只有"平台配色块"，所以人以为"还是没有封面"）。
        // 一次查全部封面归属再套到本页行上，避免每行一次查询；来源口径与详情页一致（最新一条决定）。
        const coverMap = (() => {
          const m = new Map();
          for (const r of db.prepare("SELECT entity_key, result FROM edits WHERE result IN ('cover_fetched','cover_uploaded') ORDER BY at").all()) m.set(r.entity_key, r.result);
          return m;
        })();
        const items = rows.map((r) => {
          const it = itemOf(db, { ...r, has_media: r.has_media_flag > 0 }, metrics);
          const src = coverMap.get(r.entity_key) ?? null;
          const vv = valuableOf(db, r.entity_key);
          return {
            ...it,
            cover_url: src ? `/api/cover-image?key=${encodeURIComponent(r.entity_key)}` : null,
            cover_source: src === 'cover_fetched' ? 'platform' : (src === 'cover_uploaded' ? 'extracted_frame' : null),
            // 列表也带上"当前口径"的判定结果（状态/名次/依据），与详情页同一份判定文件，避免两处口径不一致
            valuable_state: vv.state ?? null,
            valuable_selected: Boolean(vv.selected),
            valuable_rank: vv.rank ?? null,
            valuable_rankable: vv.rankable ?? null,
            valuable_metric: vv.metric ?? null,
            valuable_score: vv.score ?? null,
            // 「没有封面」有两种完全不同的原因，界面上必须分开说：
            // ①本机**连来源链接都没有**（从未采集过该平台链接）⇒ 想补必须先做采集；
            // ②有链接但平台侧取不到（例如 TikTok 仅作者可见）⇒ 采集也补不到。
            has_source_link: Boolean(r.canonical_url && String(r.canonical_url).trim()),
          };
        });
        return json(res, 200, {
          read_at: new Date().toISOString(), scope: sp.scope, scope_label: sp.label, scope_fallback_reason: sp.fallback_reason, default_sort: 'industry_priority',
          sort_rule: `分档（T1→T3）→ 有本地视频 → **按当前热度口径**（可用播放量的平台用播放量：${playPlatforms.join('、') || '（无）'}；其余平台用互动总量：点赞+评论+收藏+分享）高→低 → 片段多→少 → 关键数据多→少 → 发布时间新→旧`,
          play_usable_platforms: playPlatforms, platform_metrics: pm,
          items, page, size, total, has_more: page * size < total,
          // R-8/R-9：回执里如实说明当前生效的标签/日期未知条件（词表外标签 = known:false，total 必为 0）
          tag_filter: tagFilter, tag_vocabulary: TAG_NAMES,
          date_unknown_filter: q.get('date_unknown') === '1' ? { predicate: DATE_UNKNOWN_PREDICATE, applied: true } : { predicate: DATE_UNKNOWN_PREDICATE, applied: false },
          // ★ 2026-10-13：作用域默认＝**有价值那批**（580），`?scope=all` 可回到旧的 1,934 视图；
          //   out_of_scope 一律＝「全库 − 当前作用域」，与筛选条件无关（避免筛平台时显示成 8,617 的老问题）。
          scope_counts: (() => {
            const libraryRows = db.prepare('SELECT COUNT(*) AS n FROM materials').get().n;
            const inScopeRows = db.prepare(`SELECT COUNT(*) AS n FROM materials WHERE ${sp.sql}`).get(...sp.params).n;
            const browseRows = db.prepare(`SELECT COUNT(*) AS n FROM materials WHERE value_tier IN ('${BROWSE_TIERS.join("','")}')`).get().n;
            return { in_scope: inScopeRows, browse_tiers_total: browseRows, filtered_total: total, library_rows: libraryRows, out_of_scope: libraryRows - inScopeRows, scope: sp.scope, source: 'store/material-library.sqlite' };
          })(),
          tier_summary: tierSummaryFromDb(db),
        });
      }

      if (url.pathname === '/api/item') {
        const key = url.searchParams.get('key') ?? '';
        const row = db.prepare('SELECT * FROM materials WHERE entity_key = ?').get(key);
        if (!row) return json(res, 404, { error: 'row_not_found', key });
        const policyForPanel = readPolicy();
        const metrics = keyMetricsBulk(db);
        const item = itemOf(db, row, metrics);
        const segs = db.prepare('SELECT * FROM segments WHERE entity_key = ? ORDER BY start_seconds NULLS LAST').all(key);
        // M2：把 AI 标注与人工角色修正一起取出来（AI 建议 / 人工决定在响应里就分开放）
        const ai = aiStateOf(db, key);
        const labelOf = new Map((ai.segments ?? []).map((x) => [x.segment_id, x]));
        const assets = db.prepare('SELECT * FROM assets WHERE entity_key = ?').all(key);
        const ratios = db.prepare('SELECT * FROM ratios WHERE entity_key = ?').all(key);
        const metricRows = db.prepare('SELECT * FROM metrics WHERE entity_key = ? ORDER BY field').all(key);
        const latest = new Map();
        for (const m of metricRows) { const at = Number(m.observed_at_epoch_s) || 0; const prev = latest.get(m.field); if (!prev || at >= (Number(prev.observed_at_epoch_s) || 0)) latest.set(m.field, m); }
        const human_fields = Object.fromEntries(HUMAN_FIELDS.map((f) => [f, row[f] === undefined ? null : row[f]]));
        const cover = coverInfoOf(db, key);
        return json(res, 200, {
          read_at: new Date().toISOString(), key, row_id: key, short_key: shortKey(key),
          // 封面（条目级）：面板经 /api/cover-image 中转显示（浏览器直连 OSS 被网络层关闭）；
          // 没有登记封面就为 null，界面如实写"缺封面"，不拿抽帧图冒充平台官方封面。
          cover_url: cover ? `/api/cover-image?key=${encodeURIComponent(key)}` : null,
          cover_source: cover?.source ?? null,
          cover_source_detail: cover?.source_detail ?? null,
          cover_at_seconds: cover?.at_seconds ?? null,
          cover_bytes: cover?.bytes ?? null,
          cover_key: cover?.cover_key ?? null,
          // 采集轮口径：该素材是否被"各平台热度前 30%"判为有价值（以及用的哪个指标、分数多少）
          valuable: valuableOf(db, key),
          title: item.title, title_basis: item.title_basis, platform: item.platform, namespace: item.namespace, native_id: item.native_id, account: item.account,
          summary: item.summary, publish_epoch_s: item.publish_epoch_s, publish_label: item.publish_label, duration_seconds: item.duration_seconds,
          source_state: item.source_state, source_state_term: item.source_state_term, review_status: item.review_status, review_status_term: item.review_status_term,
          tier: item.tier, tier_key: item.tier_key, key_metrics: item.key_metrics, structure_formula: row.structure_formula ?? null,
          ai_summary: row.ai_summary ?? null, ai_summary_at: row.ai_summary_at ?? null, ai_summary_model: row.ai_summary_model ?? null,
          // M2：AI 建议与人工决定分开呈现，并给出可核的溯源（输入指纹 + 调用回执）
          ai: {
            // M2-F01：三态显式返回（generated / processing_failed / not_generated），
            // 前端据此区分"没做"与"做了但厂商失败"，不再把失败显示成未生成。
            status: ai.ai_status, status_detail: ai.ai_status_detail,
            summary: ai.ai_summary, summary_at: ai.ai_summary_at, summary_model: ai.ai_summary_model,
            summary_input_fingerprint: ai.ai_input_fingerprint, summary_receipt_ref: ai.ai_receipt_ref,
            labels_input_fingerprint: ai.ai_labels_input_fingerprint, labels_receipt_ref: ai.ai_labels_receipt_ref,
            structure_formula: ai.structure_formula,
            note: 'AI 建议来自已核准的 DeepSeek 文本路线，只依据本素材留存文本；它不自动成为人工复核结论。',
          },
          review_notes: row.review_notes ?? '', review_reviewer: row.review_reviewer ?? null, review_reviewed_at: row.review_reviewed_at ?? null,
          classification: {
            product_category: row.product_category ?? null, product_function: row.product_function ?? null, scene_or_need: row.scene_or_need ?? null,
            origins: { product_category: row.product_category_origin ?? null, product_function: row.product_function_origin ?? null, scene_or_need: row.scene_or_need_origin ?? null },
            states: { product_category: row.product_category_state ?? null, product_function: row.product_function_state ?? null, scene_or_need: row.scene_or_need_state ?? null },
          },
          human_fields, writable_fields: HUMAN_FIELDS, writable_field_meta: FIELD_META,
          evidence_fingerprint: row.evidence_fingerprint ?? null, retained_path: row.retained_path ?? null,
          review_based_on_fingerprint: row.review_based_on_fingerprint ?? null,
          evidence_changed: Boolean(row.review_based_on_fingerprint && (row.evidence_fingerprint ?? '') !== row.review_based_on_fingerprint),
          stale_reason: row.review_stale_reason ?? null,
          has_playable_media: item.has_playable_media,
          segments: segs.map((s) => {
            const lb = labelOf.get(s.segment_id) ?? {};
            return {
              segment_id: s.segment_id, t_label: s.t_label, start_seconds: s.start_seconds, end_seconds: s.end_seconds, observed: s.observed,
              onscreen_text: s.onscreen_text, speech: s.speech, kind: s.kind, fact_origin: s.fact_origin, coverage: s.coverage,
              human_note: s.human_note, review_status: s.review_status,
              // 三类信息在字段层面就分开：来源事实（上面的 observed/onscreen_text/speech）、
              // AI 建议（ai_role*）、人工决定（human_role*）。前端不得把它们混成一个"标签"。
              ai_role: lb.ai_role ?? null, ai_role_reason: lb.ai_role_reason ?? null, ai_role_model: lb.ai_role_model ?? null,
              ai_role_at: lb.ai_role_at ?? null, ai_role_receipt_ref: lb.ai_receipt_ref ?? null, ai_role_input_fingerprint: lb.ai_input_fingerprint ?? null,
              human_role: lb.human_role ?? null, human_role_reviewer: lb.human_role_reviewer ?? null, human_role_at: lb.human_role_at ?? null, human_role_note: lb.human_role_note ?? null,
              // AI-only 模式（Simon 2026-10-10）：把"当前生效的是谁"如实标出来，避免把 AI 建议误读成人工结论。
              effective_role: lb.human_role ?? lb.ai_role ?? null,
              effective_role_source: lb.human_role ? 'human' : (lb.ai_role ? 'ai' : 'none'),
              ai_mode_decided: lb.ai_mode_decided === 1,
            };
          }),
          assets: (() => {
            // ★ 第 62 轮 F62-01（阻断）：详情页/播放器必须消费**来源选中的那条资产**及其同源播放地址。
            //   此前这里对每条资产都用 `mediaBase`（默认 8791，另一个进程、当前未运行）拼地址 ⇒ 纯本地素材
            //   在候选/引用里"显示可播"，实际播放器却去连一个没在跑的服务。现在逐条给出资格事实与同源地址，
            //   并把 `pickAsset()` 选中的那条标成 `selected: true`（与来源解析/结构中心/计划引用同一份结论）。
            const chosen = pickAsset(assets);
            return assets.map((a) => {
              const q = qualificationOf(a);
              return {
                asset_id: a.asset_id, media_kind: a.media_kind, usable_as_video: a.usable_as_video === 1, local_path: a.local_path, bytes: a.bytes, duration_seconds: a.duration_seconds, sha256: a.sha256,
                // 同源地址（面板自己提供两条路由），与 `sourceOf()` 返回的 `media_url` 同规则同优先级。
                media_url: q.media_url,
                media_url_local: q.local_file ? `/media/asset/${encodeURIComponent(a.asset_id ?? '')}` : null,
                playable: q.playable, delivery: q.delivery, cloud_ready: q.cloud_ready, local_file: q.local_file,
                cloud_unready_reason: q.cloud_unready_reason,
                selected: chosen != null && a.asset_id === chosen.asset_id,
                // M6 云存储：把"云端有没有、在哪、多大"如实带出来。
                cloud: a.cloud_key ? { provider: a.cloud_provider ?? null, bucket: a.cloud_bucket ?? null, region: a.cloud_region ?? null, key: a.cloud_key, etag: a.cloud_etag ?? null, bytes: a.cloud_bytes ?? null, uploaded_at: a.cloud_uploaded_at ?? null, state: a.cloud_state ?? null } : null,
                local_missing: a.usable_as_video === 1 && !q.local_file,
                cloud_tri_state: String(a.cloud_state ?? '').trim().toLowerCase() === 'uploaded' ? 'cloud' : (a.cloud_state === 'stale' ? 'stale' : (a.cloud_state === 'mismatch' ? 'stale' : 'local_only')),
                value_decision: a.usable_as_video === 1 ? decideVideoUpload(factsFor(db, key), policyForPanel) : null,
              };
            });
          })(),
          ratios: ratios.map((r) => ({ key: r.key, status: r.status, value: r.value, unit: r.unit, observation_group: r.observation_group })),
          metric_summary: [...latest.values()].map((m) => ({
            field: m.field, status: m.status, display_value: m.status === 'value' ? (m.value_text || (m.numeric_value === null ? null : String(m.numeric_value))) : null,
            numeric_value: m.numeric_value, unit: m.unit, observed_at_epoch_s: m.observed_at_epoch_s,
            metric_definition: m.metric_definition, metric_caveat: m.metric_caveat, validation_rule: m.validation_rule, fact_origin: m.fact_origin,
          })).sort((a, b) => String(a.field).localeCompare(String(b.field))),
        });
      }

      // M6 云存储：面板回退链路。本地文件缺失（或本机 8791 取不到）时，用这里换一个**短效签名 URL**直取云端。
      // 契约：① 只读，不改任何数据；② 只对**桶内已登记且 state=uploaded** 的对象签名；③ 过期时间默认 900 秒、上限 1 小时；
      //       ④ 凭据缺失/对象未上传时如实返回错误码，**绝不**改为公开链接或伪造 URL。
      if (url.pathname === '/api/media-url' && req.method === 'GET') {
        const assetId = url.searchParams.get('asset') ?? '';
        // 复核修复（F05）：签名端点只服务本机页面——Host 必须是回环地址，且不接受跨站发起的请求。
        // 理由：这是唯一会产出"带权限的临时链接"的端点，被跨站页面调用等于把签名能力借出去。
        const host = String(req.headers.host ?? '').toLowerCase().split(':')[0];
        if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) return json(res, 403, { error: 'host_not_loopback', host: host || '(none)' });
        const site = String(req.headers['sec-fetch-site'] ?? '');
        if (site && !['same-origin', 'none'].includes(site)) return json(res, 403, { error: 'cross_site_blocked', sec_fetch_site: site });
        const origin = String(req.headers.origin ?? '');
        if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(origin)) return json(res, 403, { error: 'origin_not_loopback', origin });
        // 复核修复（F04）：**默认值与钳制分开**——没传/传了非数字 → 默认 900；传了数字 → 钳制到 [30, 3600]（0 应落到下限 30，而不是悄悄变回 900）。
        const rawTtl = url.searchParams.get('ttl');
        const parsedTtl = rawTtl === null || rawTtl.trim() === '' ? NaN : Number(rawTtl);
        const ttl = Number.isFinite(parsedTtl) ? Math.min(Math.max(Math.trunc(parsedTtl), 30), 3600) : 900;
        if (!assetId) return json(res, 400, { error: 'asset_required' });
        const a = db.prepare('SELECT * FROM assets WHERE asset_id = ?').get(assetId);
        if (!a) return json(res, 404, { error: 'asset_not_found', asset_id: assetId });
        // ★ 第 62 轮 F62-02：签名端点也走**同一资格判定**（此前自己写 `!a.cloud_key || a.cloud_state !== 'uploaded'`：
        //   空白 key、零字节、大小写混写都会与来源/中转得出不同结论）。
        const qa = qualificationOf(a);
        if (!qa.is_video) return json(res, 409, { error: 'asset_not_video', asset_id: assetId });
        if (!qa.cloud_ready) return json(res, 404, { error: 'cloud_object_not_recorded', asset_id: assetId, cloud_state: a.cloud_state ?? null, reason: qa.cloud_unready_reason });
        try {
          const sig = presignedGetUrl({ key: a.cloud_key, expiresInSeconds: ttl, bucket: a.cloud_bucket || undefined, region: a.cloud_region || undefined });
          return json(res, 200, {
            asset_id: assetId, kind: 'cloud_signed_url', url: sig.url, expires_at_epoch_s: sig.expiresAtEpochS, ttl_seconds: ttl,
            bucket: a.cloud_bucket, region: a.cloud_region, key: a.cloud_key, cloud_bytes: a.cloud_bytes, cloud_etag: a.cloud_etag,
            note: '私有不公开：链接短效且只对这一个对象；面板不缓存、不写日志。',
          });
        } catch (e) {
          return json(res, 503, { error: 'cloud_unavailable', detail: String(e?.message ?? e).slice(0, 200), asset_id: assetId, hint: '本机未配置该桶的运行时凭据；请按 O/CLOUD-RESOURCE-CHECKLIST-20261010.md 核对。' });
        }
      }

      // M6 云端中转（复核修复）：把云端字节**从面板自己（127.0.0.1）转出去**，供浏览器在"本机没有文件"时播放。
      // 为什么必须有这条路：本机浏览器直连 `oss-cn-hongkong` 实测被网络层关闭（ERR_CONNECTION_CLOSED），签名 URL 在 Node/curl 侧正常。
      // 契约：只中转**已登记且 state=uploaded**的对象；只允许 Range 与 GET；透传 200/206 与必要的头；不改任何数据；不落盘、不写日志。
/**
 * ★ 2026-10-14（Simon：「OSS(香港)上行的问题导致打开慢，能解决这个问题吗？不然一个视频一个高码一个低码 存储 2 次 也浪费资源」）
 *   实测结论：慢的**不是总带宽，而是单连接**——同一条连接只有 **0.09 MB/s**，而 4/8/16 条并发分别到 **0.58 / 0.92 / 1.7 MB/s**（约 6–19 倍）。
 *   所以不用存第二份低码率文件：把"面板→OSS"这一段改成**多连接并发分块预读**，按顺序回吐给浏览器即可。
 *   实现：把要发的字节切成 `chunkBytes` 大小的块，最多 `concurrency` 块同时在飞，**按序**写回响应；
 *   客户端断开（播放器缓冲够了就会断开）时立刻取消在飞的请求，不浪费流量、不落盘。
 *   失败处理：任何一块非 200/206 或超时 ⇒ 停止后续块并**销毁响应**（浏览器会自行重试），不会把坏数据当成功。
 */
function parseRangeHeader(rangeHeader, totalBytes) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader ?? '').trim());
  if (!m) return { start: 0, end: totalBytes - 1, partial: false };
  const startRaw = m[1]; const endRaw = m[2];
  let start = startRaw === '' ? null : Number(startRaw);
  let end = endRaw === '' ? null : Number(endRaw);
  if (start === null && end === null) return { start: 0, end: totalBytes - 1, partial: false };
  if (start === null) { start = Math.max(0, totalBytes - end); end = totalBytes - 1; }   // 后缀 Range
  if (end === null || end >= totalBytes) end = totalBytes - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return null;
  return { start, end, partial: true };
}

async function relayParallel(req, res, { key, bucket, region, rangeHeader, totalBytes }) {
  const parsed = parseRangeHeader(rangeHeader, totalBytes);
  if (!parsed) { json(res, 416, { error: 'range_not_satisfiable', range: rangeHeader, total_bytes: totalBytes }); return; }
  const { start, end, partial } = parsed;
  const length = end - start + 1;
  const concurrency = Math.max(1, Math.min(8, Number(process.env.PHONECASE_MEDIA_PARALLEL ?? 4)));
  const chunkBytes = Math.max(262144, Number(process.env.PHONECASE_MEDIA_CHUNK_BYTES ?? 2 * 1024 * 1024));
  res.writeHead(partial ? 206 : 200, {
    'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': String(length),
    'Cache-Control': 'private, max-age=3600',
    ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${totalBytes}` } : {}),
  });
  let aborted = false;
  req.on('close', () => { aborted = true; });
  const inflight = new Set();
  // 关键：拿到上游**响应流就返回**（不等整块下完）⇒ 首字节只需等 OSS 的 TTFB，而不是等一整个块。
  const openChunk = (from, to) => new Promise((resolve) => {
    let settled = false;
    let cancel = () => {};
    const done = (v) => { if (!settled) { settled = true; inflight.delete(cancel); resolve(v); } };
    cancel = () => { try { if (cur) cur.stream?.destroy(); } catch { /* ignore */ } done({ ok: false, cancelled: true }); };
    inflight.add(cancel);
    let cur = null;
    streamGetObject({ key, range: `bytes=${from}-${to}`, bucket, region })
      .then((u) => { cur = u; if (u.stream && (u.status === 200 || u.status === 206)) done({ ok: true, stream: u.stream }); else done({ ok: false, status: u.status ?? 0 }); })
      .catch((e) => done({ ok: false, error: String(e?.message ?? e) }));
  });
  const offsets = [];
  for (let o = start; o <= end; o += chunkBytes) offsets.push(o);
  const pending = new Map();
  let next = 0;
  const startNext = () => { if (next >= offsets.length) return; const o = offsets[next++]; pending.set(o, openChunk(o, Math.min(end, o + chunkBytes - 1))); };
  for (let i = 0; i < Math.min(concurrency, offsets.length); i += 1) startNext();
  let wrote = 0;
  for (const o of offsets) {
    if (aborted) break;
    const r = await pending.get(o);
    pending.delete(o);
    if (!r?.ok) {
      for (const c of inflight) c();
      if (!res.writableEnded) res.destroy(new Error(`upstream_chunk_failed offset=${o} status=${r?.status ?? 0}`));
      return;
    }
    // 把这一块的字节**边到边发**（背压交给 pipe），发完再处理下一块；其余块在后台并行下载。
    // ★ 2026-10-14 修复"偶发不结束"：① 同时监听 'close'（不只是 'end'）；② 每块加**硬超时**，超时就销毁响应（浏览器会自行重试），不再无限等。
    const chunkTimeoutMs = Math.max(5000, Number(process.env.PHONECASE_MEDIA_CHUNK_TIMEOUT_MS ?? 45000));
    await new Promise((resolve) => {
      let n = 0; let settled = false;
      const finish = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } };
      const timer = setTimeout(() => { if (!res.writableEnded) res.destroy(new Error(`upstream_chunk_timeout offset=${o}`)); finish(); }, chunkTimeoutMs);
      r.stream.on('data', (c) => { n += c.length; });
      r.stream.on('error', () => { if (!res.writableEnded) res.destroy(new Error('upstream_stream_error')); finish(); });
      r.stream.on('end', () => { wrote += n; finish(); });
      r.stream.on('close', () => { wrote += n; finish(); });
      r.stream.pipe(res, { end: false });
    });
    if (aborted || res.writableEnded) break;
    startNext();
  }
  if (!aborted && !res.writableEnded) res.end();
  if (aborted) for (const c of inflight) c();
  return { wrote, of: length };
}

      // ★ 2026-10-15（第 61 轮复核 F61-03，高）：本面板**自己**提供本机文件取流路由，供"本机文件在"的素材使用。
      //   此前本机分支给的是 `${mediaBase}/media/asset/<id>`，而 `mediaBase` 默认指向**另一个进程**
      //   （`media --serve --port 8791`）——那个进程没在跑时，返回的"可播地址"实际不可达。
      //   现在同源提供：只要文件真的存在就按 Range 流式返回；文件不在/行不可播则如实回 404/409。
      if (url.pathname.startsWith('/media/asset/') && (req.method === 'GET' || req.method === 'HEAD')) {
        const host = String(req.headers.host ?? '').toLowerCase().split(':')[0];
        if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) return json(res, 403, { error: 'host_not_loopback', host: host || '(none)' });
        const assetId = decodeURIComponent(url.pathname.slice('/media/asset/'.length));
        const a = db.prepare('SELECT asset_id, usable_as_video, local_path, cloud_state, cloud_key, cloud_bytes FROM assets WHERE asset_id = ?').get(assetId);
        if (!a) return json(res, 404, { error: 'asset_not_found', asset_id: assetId });
        // ★ 第 62 轮 F62-02/F62-04：与来源/结构中心/云中转**同一资格判定**；本机文件必须是**普通文件**（目录不算）。
        const ql = qualificationOf(a);
        if (!ql.is_video) return json(res, 409, { error: 'asset_not_video', asset_id: assetId });
        if (!ql.local_file) return json(res, 404, { error: 'local_file_missing', asset_id: assetId, local_path: ql.local_path, cloud_ready: ql.cloud_ready, hint: ql.cloud_ready ? '本机没有可取数文件；请改用同源云中转 /api/cloud-media?asset=<id>' : '本机文件不在、云上也没登记' });
        const file = ql.local_path;
        let size = 0;
        try { size = fs.statSync(file).size; } catch (e) { return json(res, 503, { error: 'local_stat_failed', detail: String(e?.message ?? e).slice(0, 120) }); }
        const baseHeaders = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600' };
        const range = String(req.headers.range ?? '').trim();
        if (range) {
          const m = /^bytes=(\d*)-(\d*)$/.exec(range);
          if (!m) return json(res, 400, { error: 'bad_range', range });
          let start; let end;
          if (m[1] === '') {
            // ★ F62-04：后缀区间 `bytes=-N` ＝"最后 N 个字节"（此前实现按 `size - Number(m[2])` 之外还错判可满足性，
            //   实测 `bytes=-100` 回 416、`bytes=-600` 回 206 但只发 201 字节）。
            const suffix = Number(m[2] || 0);
            if (!Number.isFinite(suffix) || suffix <= 0) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
            start = Math.max(0, size - suffix); end = size - 1;
          } else {
            start = Number(m[1]);
            end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
          }
          if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
            res.writeHead(416, { 'Content-Range': `bytes */${size}` });
            return res.end();
          }
          res.writeHead(206, { ...baseHeaders, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}` });
          if (req.method === 'HEAD') return res.end();
          const st = fs.createReadStream(file, { start, end });
          st.on('error', () => { if (!res.writableEnded) res.destroy(new Error('local_stream_error')); });
          return st.pipe(res);
        }
        res.writeHead(200, { ...baseHeaders, 'Content-Length': size });
        if (req.method === 'HEAD') return res.end();
        const st = fs.createReadStream(file);
        st.on('error', () => { if (!res.writableEnded) res.destroy(new Error('local_stream_error')); });
        return st.pipe(res);
      }

      if (url.pathname === '/api/cloud-media' && req.method === 'GET') {
        const host = String(req.headers.host ?? '').toLowerCase().split(':')[0];
        if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) return json(res, 403, { error: 'host_not_loopback', host: host || '(none)' });
        const assetId = url.searchParams.get('asset') ?? '';
        if (!assetId) return json(res, 400, { error: 'asset_required' });
        const a = db.prepare('SELECT asset_id, usable_as_video, cloud_key, cloud_state, cloud_bucket, cloud_region, cloud_bytes FROM assets WHERE asset_id = ?').get(assetId);
        if (!a) return json(res, 404, { error: 'asset_not_found', asset_id: assetId });
        // ★ 第 61 轮 F61-01 + 第 62 轮 F62-02：**与来源/结构中心/详情同一资格判定**（`qualificationOf()` 是唯一实现）。
        const qc = qualificationOf(a);
        if (!qc.is_video) return json(res, 409, { error: 'asset_not_video', asset_id: assetId });
        if (!qc.cloud_ready) return json(res, 404, { error: 'cloud_object_not_recorded', asset_id: assetId, cloud_state: a.cloud_state ?? null, reason: qc.cloud_unready_reason });
        const range = String(req.headers.range ?? '');
        if (range && !/^bytes=\d*-\d*$/.test(range)) return json(res, 400, { error: 'bad_range', range });
        try {
          // ★ 2026-10-14：并发预读**默认关闭**（`PHONECASE_MEDIA_PARALLEL=1` 才开）。
          //   实测：OSS 侧 4 条并发比 1 条快 **3–4.5×**（交替实测 0.19→0.62、0.36→1.46、0.47→2.10 MB/s），
          //   说明"慢"主要是**单连接**限制；但本面板的并发实现本轮出现**偶发不结束**（16MB 请求挂住、无超时兜底），
          //   在把它做成"有超时 + 失败自动降级"之前**不默认开启**，以免为了快把可播性弄坏。
          //   优先级更高的结构性方案（见检查点 §24.256）：① 开 OSS 传输加速；② 把桶复制到国内地域（服务端 copy，不过本机带宽）。
          const parallelOn = process.env.PHONECASE_MEDIA_PARALLEL === '1';
          const total = Number(a.cloud_bytes ?? 0);
          if (parallelOn && total > 0) {
            await relayParallel(req, res, { key: a.cloud_key, bucket: a.cloud_bucket || undefined, region: a.cloud_region || undefined, rangeHeader: range, totalBytes: total });
            return undefined;
          }
          const up = await streamGetObject({ key: a.cloud_key, range: range || null, bucket: a.cloud_bucket || undefined, region: a.cloud_region || undefined });
          if (!up.stream) return json(res, 502, { error: 'cloud_upstream_failed', detail: up.error ?? null, asset_id: assetId });
          if (up.status !== 200 && up.status !== 206) {
            up.stream.resume();
            return json(res, 502, { error: 'cloud_upstream_status', status: up.status, asset_id: assetId });
          }
          // ★ 2026-10-14（Simon：「打开视频都很慢」的处置之一）：原先 `Cache-Control: no-store` 让浏览器
          //   **一个字节都不许缓存** —— 每次重开/拖动进度条都要重新从 OSS(香港) 拉，而上游实测只有 ~0.2–1.7 MB/s。
          //   改为 `private, max-age=3600`（回环私有，仅本机浏览器缓存）并**透传 ETag/Last-Modified**，
          //   这样同一条素材的重开、回看、来回拖动不必再付一次跨网下载；对象键不变⇒内容不变（换片会换键）。
          const headers = { 'Content-Type': up.headers['content-type'] ?? 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600' };
          for (const k of ['content-length', 'content-range', 'etag', 'last-modified']) if (up.headers[k]) headers[k === 'content-length' ? 'Content-Length' : k === 'content-range' ? 'Content-Range' : k === 'etag' ? 'ETag' : 'Last-Modified'] = up.headers[k];
          res.writeHead(up.status, headers);
          up.stream.pipe(res);
          return undefined;
        } catch (e) {
          return json(res, 503, { error: 'cloud_unavailable', detail: String(e?.message ?? e).slice(0, 200), asset_id: assetId });
        }
      }

      // M6 步骤4 收尾：把"什么算有价值"的口径与逐条判定暴露成只读接口（同一份 cloud-policy.json，一处可改）。
      if (url.pathname === '/api/cloud-policy' && req.method === 'GET') {
        const host = String(req.headers.host ?? '').toLowerCase().split(':')[0];
        if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) return json(res, 403, { error: 'host_not_loopback', host: host || '(none)' });
        const p = readPolicy();
        const vids = db.prepare("SELECT entity_key, asset_id FROM assets WHERE usable_as_video = 1 ORDER BY asset_id").all();
        const decisions = vids.map((v) => ({ asset_id: v.asset_id, ...decideVideoUpload(factsFor(db, v.entity_key), p) }));
        return json(res, 200, {
          at: new Date().toISOString(),
          policy: { policy_id: p.policy_id, path: p._path, fallback: Boolean(p._fallback), error: p._error ?? null, upload_video_when: p.upload_video_when, upload_cover: p.upload_cover, explicit_entity_keys: p.explicit_entity_keys ?? [], updated_at: p.updated_at ?? null, change_note: p.change_note ?? null },
          decisions,
          summary: { videos: vids.length, would_upload: decisions.filter((d) => d.upload_video).length, would_skip: decisions.filter((d) => !d.upload_video).length },
          cover_note: '封面两类：**平台原生封面**（cover_fetched，从平台缩略图取回）与**本地视频抽帧封面**（cover_uploaded）。抽帧封面不是平台官方封面，口径里已写明规则；两类都按同一键位规范存放。',
        });
      }

      // M7-分析：把"①趋势 + ②链接存活"的**只读回执**直接透给面板（回执不存在就如实说"未运行"，不返回 0）。
      if (url.pathname === '/api/rest-analysis' && req.method === 'GET') {
        const host = String(req.headers.host ?? '').toLowerCase().split(':')[0];
        if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) return json(res, 403, { error: 'host_not_loopback', host: host || '(none)' });
        const readReceipt = (name) => {
          try {
            const p = path.join(DEFAULT_ROOT, DEFAULT_OUT, 'evidence', name);
            const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
            return { present: true, path: `outputs/product-material-library-phase1-20261006/evidence/${name}`, bytes: fs.statSync(p).size, data: raw };
          } catch (e) { return { present: false, path: `outputs/product-material-library-phase1-20261006/evidence/${name}`, error: String(e?.message ?? e).slice(0, 160) }; }
        };
        const trend = readReceipt('rest-trend-analysis.json');
        const liveness = readReceipt('rest-link-liveness.json');
        const rerun = readReceipt('rest-analysis-rerun.json');
        return json(res, 200, {
          at: new Date().toISOString(),
          trend, liveness, rerun,
          covers: (() => {
            // 两类封面分开算：平台原生封面 vs 本地视频抽帧。同一素材两类都有时，"当前封面"取最新一条（与详情页一致）。
            const rows = db.prepare("SELECT entity_key, changed_json, result, at FROM edits WHERE result IN ('cover_fetched','cover_uploaded') ORDER BY at").all();
            const items = rows.map((r) => { let j = null; try { j = JSON.parse(r.changed_json); } catch { /* 留空 */ } return { entity_key: r.entity_key, result: r.result, at: r.at, cover_key: j?.cover_key ?? null, cover_bytes: j?.cover_bytes ?? null, at_seconds: j?.extracted_at_seconds ?? null, platform_source: j?.cover_source ?? null }; });
            const fetched = items.filter((x) => x.result === 'cover_fetched');
            const extracted = items.filter((x) => x.result === 'cover_uploaded');
            const uniqueKeys = new Set(items.map((x) => x.entity_key));
            const withCover = db.prepare(`SELECT COUNT(*) AS n FROM materials WHERE ${scopePredicate(url.searchParams.get('scope')).sql} AND entity_key IN (SELECT DISTINCT entity_key FROM edits WHERE result IN ('cover_fetched','cover_uploaded'))`).get(...scopePredicate(url.searchParams.get('scope')).params).n;
            const linkedNoCover = db.prepare(`SELECT COUNT(*) AS n FROM materials WHERE ${scopePredicate(url.searchParams.get('scope')).sql} AND entity_key NOT IN (SELECT DISTINCT entity_key FROM edits WHERE result IN ('cover_fetched','cover_uploaded'))`).get(...scopePredicate(url.searchParams.get('scope')).params).n;
            return {
              covers_total: uniqueKeys.size, audit_rows: items.length, fetched_from_platform: fetched.length, extracted_from_video: extracted.length,
              in_scope_with_cover: withCover, in_scope_without_cover: linkedNoCover,
              // 同一素材两类封面都有时，"当前封面"取最新一条（与详情页一致）；这里给出这类重合条数，便于对账。
              both_sources: items.length - uniqueKeys.size,
              items, note: '平台原生封面（cover_fetched）与本地抽帧封面（cover_uploaded）分开计数；抽帧封面**不是平台官方封面**。口径：covers_total 按素材去重，audit_rows 为审计条数（两类重合时同一素材出现两次）。缺封面的原因与受限平台见 cover-fetch 回执。',
            };
          })(),
          notes: {
            source: '只读回执：①来自本机 SQLite 的分析脚本；②来自只读 HTTP 探测（HEAD / Range 0-0）。',
            limits: '链接存活只证明"能连上"，不证明内容还在或可下载；本机对 tiktok.com / youtube.com 不可达，那两个平台的结论是"本机不可判"。',
          },
        });
      }

      // M6 步骤4：每日整库备份与取回演练（只读端点；只写自有桶的 phonecase/backup/<UTC 日期>.sqlite）。
      if (url.pathname === '/api/cloud-backup' && req.method === 'GET') {
        const host = String(req.headers.host ?? '').toLowerCase().split(':')[0];
        if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) return json(res, 403, { error: 'host_not_loopback', host: host || '(none)' });
        const what = url.searchParams.get('do') ?? 'status';
        if (what === 'status') {
          const list = await listBackups();
          return json(res, list.ok ? 200 : 502, { at: new Date().toISOString(), ...list });
        }
        if (what === 'run') {
          const r = await backupDaily(db, { force: url.searchParams.get('force') === '1' });
          if (r.ok) {
            db.prepare('INSERT INTO edits (at, entity_key, operator, changed_json, result, row_id, source) VALUES (?,?,?,?,?,?,?)')
              .run(new Date().toISOString(), '(library-backup)', 'cloud-backup', JSON.stringify(r), r.action, null, 'cloud-backup');
          }
          return json(res, r.ok ? 200 : 502, r);
        }
        if (what === 'drill') {
          const r = await restoreDrill(db);
          return json(res, r.ok ? 200 : 502, r);
        }
        return json(res, 400, { error: 'unknown_backup_action', got: what, allowed: ['status', 'run', 'drill'] });
      }

      // M6 云存储（封面）：把封面图经面板中转给浏览器（与视频同一套中转理由：本机浏览器直连 OSS 被网络层关闭）。
      // 封面归属**素材**：优先 `key=<entity_key>`；`asset=<asset_id>` 仅作旧链接兼容（映射到该资产所属素材）。
      // 只认**已登记封面**（edits.result='cover_fetched'|'cover_uploaded'）；没登记就如实 404，不猜键位。
      if (url.pathname === '/api/cover-image' && req.method === 'GET') {
        const host = String(req.headers.host ?? '').toLowerCase().split(':')[0];
        if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) return json(res, 403, { error: 'host_not_loopback', host: host || '(none)' });
        const keyParam = url.searchParams.get('key') ?? '';
        const assetId = url.searchParams.get('asset') ?? '';
        if (!keyParam && !assetId) return json(res, 400, { error: 'key_or_asset_required' });
        let entityKey = keyParam;
        if (!entityKey) {
          const a = db.prepare('SELECT entity_key FROM assets WHERE asset_id = ?').get(assetId);
          if (!a) return json(res, 404, { error: 'asset_not_found', asset_id: assetId });
          entityKey = a.entity_key;
        }
        const cover = coverInfoOf(db, entityKey);
        if (!cover) return json(res, 404, { error: 'cover_not_recorded', key: entityKey });
        const coverKey = cover.cover_key;
        try {
          const up = await streamGetObject({ key: coverKey });
          if (!up.stream) return json(res, 502, { error: 'cloud_upstream_failed', detail: up.error ?? null });
          if (up.status !== 200) { up.stream.resume(); return json(res, 502, { error: 'cloud_upstream_status', status: up.status }); }
          const extType = /\.webp$/i.test(coverKey) ? 'image/webp' : (/\.png$/i.test(coverKey) ? 'image/png' : 'image/jpeg');
          res.writeHead(200, { 'Content-Type': up.headers['content-type'] ?? extType, 'Content-Length': up.headers['content-length'] ?? undefined, 'Cache-Control': 'no-store' });
          up.stream.pipe(res);
          return undefined;
        } catch (e) {
          return json(res, 503, { error: 'cloud_unavailable', detail: String(e?.message ?? e).slice(0, 160) });
        }
      }

      if (url.pathname === '/api/batch' && req.method === 'POST') {
        // N3：批量动作（通过／排除／待定）。逐条写 + 逐条读回 + 逐条审计；失败逐条回报，不静默。
        const ctype = String(req.headers['content-type'] ?? '');
        if (!/^application\/json\s*(;.*)?$/i.test(ctype)) return json(res, 415, { error: 'content_type_must_be_application_json', got: ctype || '(none)' });
        const site = String(req.headers['sec-fetch-site'] ?? '');
        if (site && !['same-origin', 'none'].includes(site)) return json(res, 403, { error: 'cross_site_write_blocked', sec_fetch_site: site });
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 4e6) return json(res, 413, { error: 'body_too_large' }); }
        let payload; try { payload = JSON.parse(body); } catch { return json(res, 400, { error: 'invalid_json' }); }
        const keys = Array.isArray(payload.keys) ? payload.keys.map(String) : [];
        const fields = payload.fields ?? {};
        if (!keys.length) return json(res, 400, { error: 'empty_selection' });
        if (keys.length > 500) return json(res, 400, { error: 'selection_too_large', max: 500, got: keys.length });
        const bad = Object.entries(fields).filter(([k, v]) => {
          const fm = FIELD_TYPE[k]; if (!fm) return true;
          if (fm.type === 'single_select') return v !== null && v !== '' && !fm.options.includes(String(v));
          if (fm.type === 'boolean') return !(v === null || v === true || v === false);
          if (fm.type === 'date') return v !== null && v !== '' && Number.isNaN(Date.parse(String(v)));
          return typeof v !== 'string' && v !== null;
        });
        if (bad.length) return json(res, 400, { error: 'invalid_field_value', rejected_fields: bad.map(([k]) => k) });
        const results = keys.map((key) => {
          const r = updateHumanFields(db, { entityKey: key, fields, allowedFields: HUMAN_FIELDS, operator: payload.operator ?? 'panel' });
          return { key, ok: Boolean(r.ok), result: r.result ?? null, error: r.error ?? null, mismatches: r.mismatches ?? [] };
        });
        const okCount = results.filter((r) => r.ok).length;
        return json(res, okCount === results.length ? 200 : 207, {
          at: new Date().toISOString(), requested: keys.length, confirmed: okCount, failed: results.length - okCount,
          results, failures: results.filter((r) => !r.ok),
        });
      }

      if (url.pathname === '/api/gaps') {
        const tiers = tierSummaryFromDb(db);
        return json(res, 200, {
          read_at: new Date().toISOString(), source: 'store/material-library.sqlite#gaps',
          reasons: gapsSummary(db),
          t4_lowinfo: { reason: '信息量过低（观察保留）', count: tiers.t4_lowinfo, platforms: '', note: '有少量真实观测、无价值标签；建议缓入库' },
        });
      }

      if (url.pathname === '/api/edits') {
        return json(res, 200, { at: new Date().toISOString(), edits: listEdits(db, null, 200).map((e) => ({ at: e.at, entity_key: e.entity_key, operator: e.operator, changed: e.changed, result: e.result })) });
      }

      if (url.pathname === '/api/edit' && req.method === 'POST') {
        const ctype = String(req.headers['content-type'] ?? '');
        if (!/^application\/json\s*(;.*)?$/i.test(ctype)) return json(res, 415, { error: 'content_type_must_be_application_json', got: ctype || '(none)' });
        const site = String(req.headers['sec-fetch-site'] ?? '');
        if (site && !['same-origin', 'none'].includes(site)) return json(res, 403, { error: 'cross_site_write_blocked', sec_fetch_site: site });
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 1e6) return json(res, 413, { error: 'body_too_large' }); }
        let payload; try { payload = JSON.parse(body); } catch { return json(res, 400, { error: 'invalid_json' }); }
        const key = String(payload.key ?? payload.entity_key ?? '');
        const fields = payload.fields ?? {};
        // R-3 修复：界面可能提交中文分档标签或库内键，这里统一成库内键再做枚举/白名单校验
        if (fields.value_tier !== undefined && fields.value_tier !== null && fields.value_tier !== '') fields.value_tier = tierKey(fields.value_tier);
        const bad = Object.entries(fields).filter(([k, v]) => {
          const fm = FIELD_TYPE[k]; if (!fm) return true;
          if (fm.type === 'single_select') return v !== null && v !== '' && !fm.options.includes(String(v));
          if (fm.type === 'boolean') return !(v === null || v === true || v === false);
          if (fm.type === 'date') return v !== null && v !== '' && Number.isNaN(Date.parse(String(v)));
          return typeof v !== 'string' && v !== null;
        });
        if (bad.length) return json(res, 400, { error: 'invalid_field_value', rejected_fields: bad.map(([k]) => k) });
        // R-6：可选并发前置条件——调用方带上"上次读到的值"，同一事务内比对，不一致整笔拒绝。
        const expected = (payload.expected && typeof payload.expected === 'object' && !Array.isArray(payload.expected)) ? payload.expected : null;
        const expBad = expected ? Object.keys(expected).filter((k) => !FIELD_TYPE[k]) : [];
        if (expBad.length) return json(res, 400, { error: 'invalid_precondition_field', rejected_fields: expBad });
        const out = updateHumanFields(db, { entityKey: key, fields, allowedFields: HUMAN_FIELDS, operator: payload.operator ?? 'panel', expected });
        if (!out.ok && out.error === 'stale_write') {
          return json(res, 409, {
            error: 'stale_write', entity_key: key, conflicts: out.conflicts ?? [],
            note: '库里的值已被别的写入改过：本次未写入任何字段，请重新读取后再决定。',
            audit_written: true, audit_result: 'rejected_stale_write', write_confirmed: false,
          });
        }
        if (!out.ok && out.error) return json(res, out.error === 'row_not_found' ? 404 : 400, out);
        return json(res, out.mismatches?.length ? 409 : 200, {
          result: out.result, entity_key: key, row_id: key, confirmed_values: out.confirmed_values, mismatches: out.mismatches ?? [],
          derived: out.derived ?? {}, requested: out.requested ?? fields,
          audit_written: true, audit_path: `${dbPath}#edits`, write_confirmed: out.result === 'confirmed',
        });
      }

      if (url.pathname === '/api/segment-role' && req.method === 'POST') {
        // M2／MP-05：人工修正分段叙事职能。只写 human_role_* 列，**永不触碰 ai_role_***——
        // 这样「AI 建议」与「人工决定」在数据结构层面就是两件事，AI 不会自动成为人工通过。
        const ctype = String(req.headers['content-type'] ?? '');
        if (!/^application\/json\s*(;.*)?$/i.test(ctype)) return json(res, 415, { error: 'content_type_must_be_application_json', got: ctype || '(none)' });
        const site = String(req.headers['sec-fetch-site'] ?? '');
        if (site && !['same-origin', 'none'].includes(site)) return json(res, 403, { error: 'cross_site_write_blocked', sec_fetch_site: site });
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 1e6) return json(res, 413, { error: 'body_too_large' }); }
        let payload; try { payload = JSON.parse(body); } catch { return json(res, 400, { error: 'invalid_json' }); }
        const key = String(payload.entity_key ?? payload.key ?? '');
        const segId = String(payload.segment_id ?? '');
        const role = payload.role === null || payload.role === '' ? null : String(payload.role);
        if (!key || !segId) return json(res, 400, { error: 'missing_identity' });
        if (role !== null && !SEGMENT_ROLES.includes(role)) return json(res, 400, { error: 'invalid_role', allowed: SEGMENT_ROLES });
        const seg = db.prepare('SELECT segment_id FROM segments WHERE entity_key = ? AND segment_id = ?').get(key, segId);
        if (!seg) return json(res, 404, { error: 'segment_not_found', entity_key: key, segment_id: segId });
        const at = new Date().toISOString();
        const operator = String(payload.operator ?? 'panel');
        db.exec('BEGIN IMMEDIATE');
        try {
          // M2-F03（独立复审）：撤销人工决定时，必须一并清掉它的"是谁、何时、备注"。
          // 否则 human_role=NULL 的行仍挂着上一位复核人与时间——界面会显示成"已确认过"。
          const reviewer = role === null ? null : operator;
          const atWritten = role === null ? null : at;
          db.prepare(`INSERT INTO segment_labels (entity_key, segment_id, human_role, human_role_reviewer, human_role_at, human_role_note)
            VALUES (?,?,?,?,?,?)
            ON CONFLICT(entity_key, segment_id) DO UPDATE SET
              human_role = excluded.human_role, human_role_reviewer = excluded.human_role_reviewer,
              human_role_at = excluded.human_role_at, human_role_note = excluded.human_role_note`)
            .run(key, segId, role, reviewer, atWritten, role === null ? null : (payload.note === undefined || payload.note === null ? null : String(payload.note)));
          const rb = db.prepare('SELECT human_role, human_role_reviewer, human_role_at, ai_role FROM segment_labels WHERE entity_key = ? AND segment_id = ?').get(key, segId);
          const okReadback = (rb.human_role ?? null) === role;
          // 审计必须**点名被写的列**：原先只写 { "segment_role:<id>": role }，
          // 按 human_role 检索审计会一无所获（本次 F-03 收口时就是这样发现的）。
          db.prepare('INSERT INTO edits (at, entity_key, operator, changed_json, result, row_id, source) VALUES (?,?,?,?,?,?,?)')
            .run(at, key, operator, JSON.stringify({ [`segment_role:${segId}`]: role, human_role: role, human_role_reviewer: reviewer, human_role_at: atWritten }), okReadback ? 'confirmed' : 'unconfirmed', segId, 'panel-sqlite');
          db.exec('COMMIT');
          return json(res, okReadback ? 200 : 409, {
            result: okReadback ? 'confirmed' : 'unconfirmed', entity_key: key, segment_id: segId,
            human_role: rb.human_role ?? null, human_role_at: rb.human_role_at ?? null, human_role_reviewer: rb.human_role_reviewer ?? null,
            cleared_provenance: role === null,
            ai_role_unchanged: rb.ai_role ?? null,
            audit_written: true, note: 'AI 建议列未被修改（ai_role 原样保留）；撤销人工决定会同时清除其复核人与时间。',
          });
        } catch (e) {
          try { db.exec('ROLLBACK'); } catch { /* 回滚失败也如实返回 */ }
          return json(res, 500, { error: 'write_failed', detail: String(e).slice(0, 200) });
        }
      }

      if (url.pathname === '/api/plan' && req.method === 'POST') {
        // 与 /api/edit 同一套写入守卫：必须是同源 JSON 请求，且请求体大小有上限。
        const ctype = String(req.headers['content-type'] ?? '');
        if (!/^application\/json\s*(;.*)?$/i.test(ctype)) return json(res, 415, { error: 'content_type_must_be_application_json', got: ctype || '(none)' });
        const site = String(req.headers['sec-fetch-site'] ?? '');
        if (site && !['same-origin', 'none'].includes(site)) return json(res, 403, { error: 'cross_site_write_blocked', sec_fetch_site: site });
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 1e6) return json(res, 413, { error: 'body_too_large' }); }
        let payload; try { payload = JSON.parse(body); } catch { return json(res, 400, { error: 'invalid_json' }); }
        const out = savePlan(db, payload);
        if (!out.ok && (out.error === 'plan_precondition_required' || out.error === 'plan_fields_required' || out.error === 'plan_field_type_invalid')) {
          return json(res, 400, { ...out, write_confirmed: false, rules: PLAN_RULES });
        }
        if (!out.ok && out.error === 'stale_plan') {
          return json(res, 409, {
            error: 'stale_plan', plan_id: payload.plan_id ?? null, detail: out.detail ?? null,
            // 逐字段差异要一并回执，否则调用方只知道"被拒了"，不知道**哪里**不一致（无法据此修正或核对）。
            conflicts: out.conflicts ?? [],
            note: '这份计划与你读到的内容不一致（别处改过，或本次没有完整读到）：未写入任何内容，请重新读取后再决定。',
            write_confirmed: false, rules: PLAN_RULES,
          });
        }
        if (!out.ok) return json(res, 400, { ...out, rules: PLAN_RULES });
        // MP-08「can reopen it」：写后**重新读取**再回显，返回的就是重开时会看到的内容。
        const reread = readPlan(db, out.plan_id, { mediaBase });
        return json(res, 200, {
          result: 'confirmed', plan_id: out.plan_id, created: out.created, rev: out.rev,
          node_count: reread.node_count, reference_count: reread.reference_count, missing_shot_count: reread.missing_shot_count,
          plan: reread, write_confirmed: true, audit_path: `${dbPath}#plans`, rules: PLAN_RULES,
        });
      }

      if (url.pathname === '/api/reconcile-evidence' && req.method === 'POST') {
        // R-6：显式触发「证据变化 → 复核陈旧」校正（真实消费路径之三；另两处＝启动时与导入后）。
        const site = String(req.headers['sec-fetch-site'] ?? '');
        if (site && !['same-origin', 'none'].includes(site)) return json(res, 403, { error: 'cross_site_write_blocked', sec_fetch_site: site });
        try {
          const r = reconcileStaleReviews(db);
          staleReconcile.last = r;
          return json(res, 200, { ok: true, ...r });
        } catch (e) {
          return json(res, 500, { ok: false, error: 'reconcile_failed', detail: String(e).slice(0, 200) });
        }
      }

      // 静态资源（与 Baserow 版面板用同一套前端）
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '');
      const file = path.join(panelDir, rel);
      if (!file.startsWith(panelDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('not found'); }
      const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'application/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream';
      const b = fs.readFileSync(file);
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': b.length, 'Cache-Control': 'no-store' });
      return res.end(b);
    } catch (e) {
      log(`panel_error:${String(e).slice(0, 200)}`);
      return json(res, 500, { error: 'panel_internal_error', detail: String(e).slice(0, 200) });
    }
  });
  return { server, db, close: () => db.close() };
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); if (v !== undefined) out[k] = v; else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[k] = argv[++i]; else out[k] = true; } else out._.push(a);
  }
  return out;
}

if (process.argv[1] && process.argv[1].endsWith('panel-sqlite.mjs')) {
  const argv = parseArgs(process.argv.slice(2));
  const root = argv.root ?? DEFAULT_ROOT;
  const out = path.resolve(root, argv.out ?? DEFAULT_OUT);
  const dbPath = path.resolve(argv.db ?? path.join(out, 'store', 'material-library.sqlite'));
  const port = Number(argv.port ?? 8792);
  if (argv.serve || argv._.includes('serve')) {
    if (!fs.existsSync(dbPath)) { console.error(`store_missing:${dbPath}`); process.exit(1); }
    const { server } = createSqlitePanelServer({ dbPath, panelDir: path.resolve(argv.panel ?? path.join(HERE, 'panel')), mediaBase: argv['media-base'] ?? 'http://127.0.0.1:8791' });
    server.listen(port, '127.0.0.1', async () => {
      console.log(`素材面板（自研 SQLite 存储）已启动：http://127.0.0.1:${port}`);
      console.log(`存储：${dbPath}（无外部凭据；仅监听回环；人工字段写后读回确认）`);
      // ★ 2026-10-14（Simon：「打开视频都很慢」的处置之三）：进程启动后**预热到 OSS 的连接**（一次 1 字节 Range GET），
      //   把 TCP+TLS 握手（实测首次要 ~1.5–2.0 秒）挪到启动时，用户点开第一个视频时直接复用热连接。
      //   纯预热：不写任何数据、不改文件、失败只是打一行日志。
      try {
        const warmDb = openStore({ dbPath, mustExist: true });
        const a = warmDb.prepare("SELECT cloud_key, cloud_bucket, cloud_region FROM assets WHERE usable_as_video = 1 AND cloud_state = 'uploaded' LIMIT 1").get();
        warmDb.close();
        if (a?.cloud_key) {
          const t0 = Date.now();
          const up = await streamGetObject({ key: a.cloud_key, range: 'bytes=0-1', bucket: a.cloud_bucket || undefined, region: a.cloud_region || undefined });
          if (up.stream) up.stream.resume();
          console.log(`OSS 连接预热：status=${up.status ?? 0} 用时 ${Date.now() - t0} ms（失败不影响面板）`);
        }
      } catch (e) { console.log(`OSS 连接预热跳过：${String(e?.message ?? e).slice(0, 120)}`); }
    });
  } else {
    const db = openStore({ dbPath });
    console.log(JSON.stringify({ panel_version: PANEL_VERSION, db_path: dbPath, ...storeMeta(db), stats: storeStats(db) }, null, 2));
    db.close();
  }
}
