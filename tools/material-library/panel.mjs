// tools/material-library/panel.mjs
// R12 · M2：本地中文“素材面板”——**服务端实时读 Baserow** + **人工字段业务编辑**（凭据只在服务端进程内）。
//
// 边界（写死在代码里）：
//   - Baserow 仍是**唯一仓库**；本页面只是轻量中文操作面（Simon 不必打开 Baserow 重界面）。
//   - **只允许写人工字段**（备注/复核/人工分类及其来源标注）；**绝不**写来源派生字段（白名单见 HUMAN_FIELDS）。
//   - 只允许清单内的 25 条身份；写后**重新读取确认**再回显；失败/不一致如实报告，不做乐观假回显。
//   - 凭据只在服务端进程内（受限文件），**浏览器不出现任何令牌**；仅监听 127.0.0.1。
//   - 没有 AI 调用、没有外部采集。
//
// 用法：
//   node tools/material-library/panel.mjs --serve --port 8792
//   浏览器打开 http://127.0.0.1:8792
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// P0 列表卡片化：关键数字与业务词的纯函数（可单测，见 tests/phase1.test.mjs）
import {
  KEY_METRIC_FIELDS, indexLatestRealMetrics, keyMetricsOf, countRealObservations,
  businessTitleOf, shortKey, reviewStatusTerm, sourceStateTerm, sortByIndustryPriority,
} from './panel-metrics.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = 'D:/Codex-local/harness-workspaces/Phonecase';
const DEFAULT_OUT = 'outputs/product-material-library-phase1-20261006';

export const PANEL_VERSION = 'panel-p0-v2';

// 人工字段白名单（与 baserow.mjs 的 HUMAN_FIELDS 同源；这里内联一份，避免把整个模块的副作用带进服务）
const HUMAN_FIELDS = new Set([
  'review_status', 'review_reviewer', 'review_reviewed_at', 'review_notes',
  'review_value_categories', 'selected_reference', 'review_stale', 'review_stale_reason', 'human_note',
  'product_category', 'product_function', 'scene_or_need',
  'product_category_origin', 'product_function_origin', 'scene_or_need_origin',
  'product_category_reviewer', 'product_function_reviewer', 'scene_or_need_reviewer',
  'product_category_evidence_ref', 'product_function_evidence_ref', 'scene_or_need_evidence_ref',
  'product_category_state', 'product_function_state', 'scene_or_need_state',
  // P0（Simon 2026-10-08 决策③「加分档就可以了」）：素材分档，人工字段，重新导入时不被来源派生字段覆盖
  'value_tier',
]);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) out[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

const scalar = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v.value : v);
const num = (v) => (v === null || v === '' || v === undefined ? null : Number(v));
const round = (n, dp = 3) => (typeof n === 'number' && Number.isFinite(n) ? Number(n.toFixed(dp)) : null);
const text = (v) => (typeof v === 'string' ? v.trim() : '');
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

function ruleTags(row, segCount, hasMedia) {
  // P0 术语业务化：标签一律用业务词（实现词只留在数据里，不给业务看）
  const tags = [String(scalar(row.platform) ?? '')];
  if (String(scalar(row.namespace)) === 'aid') tags.push('单列补充记录');
  tags.push(hasMedia ? '有本地视频' : '无本地视频');
  if (segCount) tags.push(`${segCount} 个片段`);
  tags.push(sourceStateTerm(scalar(row.entity_source_state)));
  tags.push(reviewStatusTerm(scalar(row.review_status)));
  if (text(row.review_notes)) tags.push('有备注');
  return tags.filter(Boolean);
}

function summaryOf(row) {
  const cat = text(scalar(row.product_category));
  if (cat && !/^未知/.test(cat) && cat !== 'unknown') return { text: clip(cat, 28), basis: '人工分类' };
  return { text: `${scalar(row.platform)}|${scalar(row.namespace)}|${scalar(row.native_id)}`, basis: '身份串（无标题字段）' };
}

export function createLiveClient(cfg) {
  const creds = JSON.parse(fs.readFileSync(cfg.credsPath, 'utf8'));
  const base = cfg.baserowBase ?? creds.base_url;
  const state = { jwtRefreshedAt: null };

  const refreshJwt = async () => {
    try {
      const r = await fetch(base + '/api/user/token-refresh/', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: creds.refresh_token }),
      });
      if (r.status !== 200) return { ok: false, status: r.status };
      const j = await r.json();
      creds.jwt = j.token;
      if (j.refresh_token) creds.refresh_token = j.refresh_token;
      fs.writeFileSync(cfg.credsPath, JSON.stringify(creds, null, 2), 'utf8');
      state.jwtRefreshedAt = new Date().toISOString();
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e).slice(0, 80) }; }
  };

  const call = async (method, url, { body, auth = 'data', retry = true } = {}) => {
    const headers = {};
    if (auth === 'data') headers.Authorization = 'Token ' + creds.db_token;
    else headers.Authorization = 'JWT ' + creds.jwt;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let r;
    try {
      r = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      // 网络层异常也要留下可诊断信息（不把它伪装成“没有数据”）
      if (auth === 'mgmt') state.lastMgmt = { url, error: String(e?.message ?? e).slice(0, 160), at: new Date().toISOString() };
      return { status: 0, json: null, raw: `fetch_failed:${String(e?.message ?? e).slice(0, 120)}` };
    }
    const t = await r.text();
    let j = null; let parseError = null;
    if (t) { try { j = JSON.parse(t); } catch (e) { parseError = String(e?.message ?? e).slice(0, 120); } }
    if (r.status === 401 && auth === 'mgmt' && retry) {
      const rr = await refreshJwt();
      state.lastMgmt = { url, status: 401, refresh: rr, at: new Date().toISOString() };
      if (rr.ok) return call(method, url, { body, auth, retry: false });
    } else if (auth === 'mgmt' && r.status !== 200) {
      state.lastMgmt = { url, status: r.status, body: String(t).slice(0, 200), at: new Date().toISOString() };
    }
    return { ok: r.status === 200, status: r.status, json: j, raw: t, parse_error: parseError };
  };

  return {
    base,
    credsPath: cfg.credsPath,
    refreshJwt,
    jwtRefreshedAt: () => state.jwtRefreshedAt,
    mgmtDebug: () => state.lastMgmt ?? null,
    listRows: async (tableId, query = '') => {
      const out = []; let page = 1; const MAX_PAGES = 5000; // 1,000,000 行上限；超过就**如实报错**，绝不静默截断
      for (;;) {
        const r = await call('GET', `/api/database/rows/table/${tableId}/?user_field_names=true&size=200&page=${page}${query}`);
        if (r.status !== 200) return { ok: false, status: r.status, rows: out, error: `rows_read_failed:${r.status}` };
        // R12 第 6 批复核 R6-4：HTTP 200 但正文体不是预期结构（JSON 解析失败 / 没有 results 数组）时，
        // 旧实现用 `?? []` 兜底成“零行 + ok:true”，会被上层渲染成“没有媒体/没有指标”。
        // 这里显式判为读取失败，绝不把解析失败伪装成空数据。
        if (!r.json || !Array.isArray(r.json.results)) {
          return {
            ok: false, status: 200, rows: out,
            error: r.parse_error ? `rows_body_unparseable:${r.parse_error}` : 'rows_body_unexpected_shape',
            body_head: String(r.raw ?? '').slice(0, 200),
          };
        }
        out.push(...r.json.results);
        if (!r.json.next || r.json.results.length === 0) break;
        if (page >= MAX_PAGES) {
          return { ok: false, status: 200, rows: out, pages: page, truncated: true, error: `pagination_cap_reached:${MAX_PAGES}_pages（已读 ${out.length} 行）：不返回被截断的结果` };
        }
        page += 1;
      }
      return { ok: true, status: 200, rows: out, pages: page };
    },
    listFields: (tableId) => call('GET', `/api/database/fields/table/${tableId}/`, { auth: 'data' }),
    listViews: (tableId) => call('GET', `/api/database/views/table/${tableId}/`, { auth: 'mgmt' }),
    listTables: () => call('GET', `/api/database/tables/database/${cfg.databaseId}/`, { auth: 'mgmt' }),
    patchRow: (tableId, rowId, fields) => call('PATCH', `/api/database/rows/table/${tableId}/${rowId}/?user_field_names=true`, { body: fields, auth: 'data' }),
    getRow: async (tableId, rowId) => call('GET', `/api/database/rows/table/${tableId}/${rowId}/?user_field_names=true`, { auth: 'data' }),
  };
}

export function createPanelServer({ cfg, log = console.log } = {}) {
  const client = createLiveClient(cfg);
  const manifest = JSON.parse(fs.readFileSync(cfg.manifestPath, 'utf8'));
  const allowedKeys = new Set(manifest.entity_keys);
  const auditPath = cfg.auditPath;
  const T = cfg.tables;

  // P0.5：缺口分区数据（只读 M3 筛选证据文件；查不到就如实报错，不编数字）
  const readGaps = () => {
    const p = path.join(cfg.out, 'evidence', 'r12-m3-value-tiers.json');
    let j = null;
    try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return { error: 'gaps_evidence_unreadable', detail: String(e).slice(0, 120), source: p }; }
    const byState = j.gaps?.byState ?? {};
    const byPlat = j.gaps?.byPlat ?? {};
    const t4 = j.tiers?.T4_lowinfo ?? {};
    const fmtPlat = (o) => Object.entries(o ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${Number(v).toLocaleString('en-US')}`).join(' / ');
    const reasons = [
      { reason: '采集不到来源', count: byState.source_unavailable ?? 0, platforms: fmtPlat(byPlat), note: '需要来源恢复或人工补链；本轮不新增采集' },
      { reason: '来源待确认', count: byState.unknown ?? 0, platforms: '零散', note: '身份未确认，需人工判断' },
      { reason: '信息量过低（观察保留）', count: t4.records ?? 0, platforms: fmtPlat(t4.by_platform), note: '有少量真实观测、无价值标签；建议缓入库' },
    ].filter((x) => x.count > 0 || x.reason !== '来源待确认');
    return { read_at: new Date().toISOString(), source: 'outputs/product-material-library-phase1-20261006/evidence/r12-m3-value-tiers.json', reasons };
  };

  // P0：分档筛选结果（M3 只读筛选的产物）。只读证据文件；读不到就返回 null，
  // 前端据此显示「分档结果不可用」，绝不编造数字，也不用它替代实时行数。
  const readTierSummary = () => {
    const p = path.join(cfg.out, 'evidence', 'r12-m3-value-tiers.json');
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      const s = j.summary ?? j.tiers ?? null;
      const pick = (k) => (s && s[k] && typeof s[k].records === 'number' ? s[k].records : null);
      const t1 = pick('T1_media'), t2 = pick('T2_strong'), t3 = pick('T3_standard'), t4 = pick('T4_lowinfo');
      const gaps = j.gaps?.n ?? (j.gaps && typeof j.gaps === 'number' ? j.gaps : null);
      if (t1 === null && t2 === null && t3 === null && t4 === null) return null;
      return {
        source: 'outputs/product-material-library-phase1-20261006/evidence/r12-m3-value-tiers.json',
        read_at: new Date().toISOString(),
        t1_media: t1, t2_strong: t2, t3_standard: t3, t4_lowinfo: t4,
        recommended_import: (t1 ?? 0) + (t2 ?? 0) + (t3 ?? 0),
        registered_gaps: gaps,
        note: '分档来自 M3 只读筛选（未入库）；recommended_import 是「建议入库」的条数口径，不是当前库内行数。',
      };
    } catch (e) {
      return null;
    }
  };

  const audit = (line) => { try { fs.mkdirSync(path.dirname(auditPath), { recursive: true }); fs.appendFileSync(auditPath, JSON.stringify(line) + '\n', 'utf8'); return true; } catch { return false; } };

  const liveRows = async (table) => {
    const r = await client.listRows(T[table]);
    if (!r.ok) return { ok: false, status: r.status, rows: [], error: r.error ?? null, truncated: r.truncated ?? false };
    return { ok: true, status: 200, rows: r.rows, pages: r.pages ?? null, truncated: false };
  };

  const realVideos = async () => {
    const r = await liveRows('Videos');
    if (!r.ok) return r;
    const real = r.rows.filter((x) => text(x.entity_key) !== '');
    return { ok: true, status: 200, rows: real, allRows: r.rows, pages: r.pages, placeholder_rows: r.rows.length - real.length };
  };

  const segmentCounts = async () => {
    const r = await liveRows('Segments');
    const map = new Map();
    if (r.ok) for (const s of r.rows) { const k = text(s.entity_key); if (k) map.set(k, (map.get(k) ?? 0) + 1); }
    return { ok: r.ok, status: r.status, map, rows: r.rows, pages: r.pages, placeholder_rows: r.ok ? r.rows.filter((s) => text(s.entity_key) === '').length : null };
  };

  // 可播放媒体以 Assets 表的 usable_as_video 为准（Videos.media_view_url 在小样里为空，不能当作依据）。
  const playableKeys = async () => {
    const r = await liveRows('Assets');
    const set = new Set();
    if (r.ok) for (const a of r.rows) if (a.usable_as_video === true) set.add(text(a.entity_key));
    return { ok: r.ok, status: r.status, set, rows: r.rows, pages: r.pages, placeholder_rows: r.ok ? r.rows.filter((a) => text(a.entity_key) === '').length : null };
  };

  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };

  // 人工字段的元数据（类型/选项/必填），供页面正确渲染控件；不含任何凭据。
  const writableMeta = async () => {
    const r = await client.listFields(T.Videos);
    if (r.status !== 200) return { ok: false, status: r.status, fields: [] };
    // R12 第 6 批复核 R6-4 同类：HTTP 200 但正文不可解析 → 不得当成“没有可写字段”
    if (!Array.isArray(r.json)) return { ok: false, status: 200, fields: [], parse_error: r.parse_error ?? 'fields_body_unexpected_shape' };
    const fields = r.json.filter((f) => HUMAN_FIELDS.has(f.name)).map((f) => ({
      name: f.name, type: f.type, required: Boolean(f.required),
      date_include_time: Boolean(f.date_include_time),
      options: (f.select_options ?? []).map((o) => o.value),
    })).sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, status: 200, fields };
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (url.pathname === '/api/summary') {
        const [videos, segs, assets, metrics, ratios, tables, views, meta] = await Promise.all([
          realVideos(), segmentCounts(), liveRows('Assets'), liveRows('Metric observations'), liveRows('Ratios'), client.listTables(), client.listViews(T.Videos), writableMeta(),
        ]);
        const failed = [
          !videos.ok && 'Videos', !segs.ok && 'Segments', !assets.ok && 'Assets',
          !metrics.ok && 'Metric observations', !ratios.ok && 'Ratios', !tables.ok && 'tables', !views.ok && 'views',
          // R12 第 6 批复核 R6-4 同类：200 但正文结构不对（解析失败/不是数组）也算读取失败
          !Array.isArray(tables.json) && 'tables_unparseable', !Array.isArray(views.json) && 'views_unparseable',
          // 只把“200 但不可解析”升级为失败；非 200 的情况仍按原样回传 writable_field_meta_ok=false 由前端告警（不改变既有语义）
          Boolean(meta.parse_error) && 'writable_field_meta_unparseable',
        ].filter(Boolean);
        if (failed.length) {
          return json(res, 503, {
            error: 'baserow_read_failed', failed_tables: failed, statuses: { videos: videos.status, segs: segs.status, assets: assets.status, metrics: metrics.status, ratios: ratios.status, tables: tables.status, views: views.status },
            mgmt_diagnostic: client.mgmtDebug(),
            note: '实时读取失败（不是“没有数据”）：不提供快照替代数据，也不把失败显示成业务缺失。',
          });
        }
        const videosViews = (views.json ?? []).length;
        return json(res, 200, {
          panel_version: PANEL_VERSION,
          source: 'baserow_live',
          base_url: client.base,
          database_id: cfg.databaseId,
          read_at: new Date().toISOString(),
          jwt_refreshed_at: client.jwtRefreshedAt(),
          counts: {
            items: videos.rows.length,
            segments: [...segs.map.values()].reduce((a, b) => a + b, 0),
            metrics: metrics.rows.length,
            ratios: ratios.rows.length,
            assets: assets.rows.length,
            placeholder_rows: {
              note: '以下按“主键（entity_key）为空”识别出的 Baserow 建表示例行（五表各 2 行，共 10 行），属占位数据、不是样本素材。分母差异：counts.items/segments 已**排除**占位行；metrics/ratios/assets 仍**包含**占位行（见各项数值）。',
              videos: videos.placeholder_rows ?? null,
              segments: segs.placeholder_rows,
              metrics: metrics.rows.filter((x) => text(x.entity_key) === '').length,
              ratios: ratios.rows.filter((x) => text(x.entity_key) === '').length,
              assets: assets.rows.filter((x) => text(x.entity_key) === '').length,
            },
          },
          tables: (tables.json ?? []).map((t) => ({ id: t.id, name: t.name })),
          views_count: videosViews,
          views_scope: `仅 Videos 表；本页未统计其余表的视图数`,
          media_base: cfg.mediaBase,
          writable_fields: [...HUMAN_FIELDS],
          writable_field_meta: meta.fields,
          writable_field_meta_ok: meta.ok,
          writable_entity_keys: [...allowedKeys].length,
          read_only_elsewhere: true,
          no_ai_calls: true,
          // P0：列表卡片显示的 3 个关键数字（口径写在 panel-metrics.mjs，前端不另起一套）
          key_metric_labels: KEY_METRIC_FIELDS.map((x) => ({ field: x.field, label: x.label })),
          // P0：业务词表（前端只用这套词，禁止出现 entity_key/namespace/source_unavailable 等实现词）
          terms: {
            review_status: { unreviewed: '待人工复核', in_review: '复核中', reviewed: '通过', rejected: '排除' },
            source_state: { observed: '来源正常', source_unavailable: '采集不到来源', unknown: '来源待确认' },
          },
          // P0：分档筛选结果（M3 只读筛选，直接读证据文件；读不到就是 null，不假装有数）
          tier_summary: readTierSummary(),
          note: '服务端实时读 Baserow；凭据只在服务端进程内，浏览器不出现令牌；只允许写人工字段与清单内身份。',
        });
      }

      if (url.pathname === '/api/gaps') {
        // P0.5：缺口分区（只读证据文件；不查库、不改库）。查不到 → 503 并说明，不显示 0。
        const g = readGaps();
        if (g.error) return json(res, 503, g);
        return json(res, 200, g);
      }

      if (url.pathname === '/api/items') {
        const [videos, segs, playable, metricRows] = await Promise.all([realVideos(), segmentCounts(), playableKeys(), liveRows('Metric observations')]);
        const failed = [!videos.ok && 'Videos', !segs.ok && 'Segments', !playable.ok && 'Assets', !metricRows.ok && 'Metric observations'].filter(Boolean);
        if (failed.length) return json(res, 503, { error: 'baserow_read_failed', failed_tables: failed, details: [videos.error, segs.error, playable.error, metricRows.error].filter(Boolean) });
        // P0：先建「每身份每指标最新真实观测」索引，列表的 3 个关键数字全部取自它（缺失＝—，不显示 0）
        const metricIndex = indexLatestRealMetrics(metricRows.rows);
        // M2 范围＝代表清单内的 25 条身份；清单外的行**不进列表**（否则会出现“看得到、点不开”）。
        // M3 要扩到全量时，这里与下面的 /api/item 白名单必须一起放开。
        const inScope = videos.rows.filter((row) => allowedKeys.has(text(row.entity_key)));
        const items = inScope.map((row) => {
          const s = summaryOf(row);
          const key = text(row.entity_key);
          const hasMedia = playable.set.has(key);
          const titleInfo = businessTitleOf(row, { key });
          return {
            key, short_key: shortKey(key), title: titleInfo.title, title_basis: titleInfo.basis, title_subtitle: titleInfo.subtitle,
            platform: String(scalar(row.platform) ?? ''), namespace: String(scalar(row.namespace) ?? ''),
            native_id: String(scalar(row.native_id) ?? ''), account: text(scalar(row.author_display_name)) || null,
            summary: s.text, summary_basis: s.basis,
            publish_epoch_s: num(row.publish_date_epoch_s), publish_label: text(scalar(row.publish_date_label)) || null,
            duration_seconds: round(num(row.duration_seconds)),
            source_state: String(scalar(row.entity_source_state) ?? ''), source_state_term: sourceStateTerm(scalar(row.entity_source_state)),
            review_status: String(scalar(row.review_status) ?? 'unreviewed'), review_status_term: reviewStatusTerm(scalar(row.review_status)),
            note_present: text(row.review_notes) !== '', segment_count: segs.map.get(key) ?? 0,
            has_playable_media: hasMedia,
            key_metrics: keyMetricsOf(metricIndex, key),
            metrics_observed: countRealObservations(metricRows.rows, key),
            tier: text(scalar(row.value_tier)) || null,
            tags: ruleTags(row, segs.map.get(key) ?? 0, hasMedia),
            baserow_row_id: row.id,
          };
        }).sort((a, b) => (b.publish_epoch_s ?? 0) - (a.publish_epoch_s ?? 0) || a.key.localeCompare(b.key));
        // P0 默认排序＝行业优先级（Simon 2026-10-08 决策②）：分档 → 有本地视频 → 播放量 → 片段 → 观测数 → 发布时间。
        // 排序口径写在 panel-metrics.mjs（有单测）；服务端返回的顺序就是前端「行业优先级」档位的顺序，避免两处各排一套。
        const ordered = sortByIndustryPriority(items);
        return json(res, 200, {
          read_at: new Date().toISOString(),
          scope: 'representative_manifest_25',
          default_sort: 'industry_priority',
          sort_rule: '分档（T1→T4）→ 有本地视频 → 播放量高→低 → 片段多→少 → 关键数据多→少 → 发布时间新→旧',
          items: ordered,
          // P0 口径统一：一次把「列表条数 / 全库行数 / 两者差额」都带出来，前端不再各算一套
          scope_counts: {
            in_scope: items.length,
            library_rows: videos.rows.length,
            out_of_scope: videos.rows.length - inScope.length,
            placeholder_rows: videos.placeholder_rows ?? null,
            manifest_keys: allowedKeys.size,
          },
          out_of_scope_rows: videos.rows.length - inScope.length,
          tier_summary: readTierSummary(),
          pages_read: { videos: videos.pages, segments: segs.pages, assets: playable.pages, metrics: metricRows.pages },
          note: '列表只含代表清单内身份；Baserow 中其余行（例如 M3 全量导入后的 8000+ 条）需要等到 M3 放开白名单后才会出现。',
        });
      }

      if (url.pathname === '/api/item') {
        const key = url.searchParams.get('key') ?? '';
        if (!allowedKeys.has(key)) return json(res, 404, { error: 'entity_key_not_in_manifest', key });
        const videos = await realVideos();
        if (!videos.ok) return json(res, 503, { error: 'baserow_read_failed', failed_tables: ['Videos'], status: videos.status });
        const row = videos.rows.find((x) => text(x.entity_key) === key);
        if (!row) return json(res, 404, { error: 'row_not_found', key });
        const q = `&filter__entity_key__equal=${encodeURIComponent(key)}`;
        const [segRows, assetRows, metricRows, meta] = await Promise.all([
          client.listRows(T.Segments, q), client.listRows(T.Assets, q), client.listRows(T['Metric observations'], q), writableMeta(),
        ]);
        const failed = [!segRows.ok && 'Segments', !assetRows.ok && 'Assets', !metricRows.ok && 'Metric observations'].filter(Boolean);
        if (failed.length) {
          return json(res, 503, {
            error: 'baserow_read_failed', failed_tables: failed, key,
            statuses: { segs: segRows.status, assets: assetRows.status, metrics: metricRows.status },
            note: '关联表读取失败（不是“该素材没有片段/媒体/指标”）：不返回半份详情。',
          });
        }
        const byField = new Map();
        for (const m of metricRows.rows ?? []) {
          const f = text(m.field); const at = num(m.observed_at_epoch_s) ?? 0;
          const prev = byField.get(f);
          if (!prev || at >= (num(prev.observed_at_epoch_s) ?? 0)) byField.set(f, m);
        }
        return json(res, 200, {
          read_at: new Date().toISOString(),
          key, row_id: row.id, short_key: shortKey(key),
          title: businessTitleOf(row, { key }).title, title_basis: businessTitleOf(row, { key }).basis,
          platform: String(scalar(row.platform) ?? ''), namespace: String(scalar(row.namespace) ?? ''),
          native_id: String(scalar(row.native_id) ?? ''), account: text(scalar(row.author_display_name)) || null,
          summary: summaryOf(row).text, summary_basis: summaryOf(row).basis,
          publish_epoch_s: num(row.publish_date_epoch_s), publish_label: text(scalar(row.publish_date_label)) || null,
          duration_seconds: round(num(row.duration_seconds)),
          source_state: String(scalar(row.entity_source_state) ?? ''), source_state_term: sourceStateTerm(scalar(row.entity_source_state)),
          review_status: String(scalar(row.review_status) ?? 'unreviewed'), review_status_term: reviewStatusTerm(scalar(row.review_status)),
          tier: text(scalar(row.value_tier)) || null,
          key_metrics: keyMetricsOf(indexLatestRealMetrics(metricRows.rows ?? []), key),
          review_notes: text(row.review_notes), review_reviewer: text(scalar(row.review_reviewer)) || null,
          review_reviewed_at: text(row.review_reviewed_at) || null,
          classification: {
            product_category: text(scalar(row.product_category)) || null,
            product_function: text(scalar(row.product_function)) || null,
            scene_or_need: text(scalar(row.scene_or_need)) || null,
            origins: {
              product_category: text(scalar(row.product_category_origin)) || null,
              product_function: text(scalar(row.product_function_origin)) || null,
              scene_or_need: text(scalar(row.scene_or_need_origin)) || null,
            },
            states: {
              product_category: text(scalar(row.product_category_state)) || null,
              product_function: text(scalar(row.product_function_state)) || null,
              scene_or_need: text(scalar(row.scene_or_need_state)) || null,
            },
          },
          // 人工字段的原样值（编辑控件用它回显“库里当前值”，避免用空值覆盖已有内容）
          human_fields: Object.fromEntries([...HUMAN_FIELDS].map((f) => {
            const v = row[f];
            const sv = Array.isArray(v) ? v : scalar(v);
            return [f, sv === undefined ? null : (typeof sv === 'string' ? (sv === '' ? null : sv) : sv)];
          })),
          evidence_fingerprint: text(row.evidence_fingerprint) || null,
          retained_path: text(row.retained_path) || null,
          media_view_url: text(row.media_view_url) || null,
          has_playable_media: (assetRows.rows ?? []).some((a) => a.usable_as_video === true),
          tags: ruleTags(row, (segRows.rows ?? []).length, (assetRows.rows ?? []).some((a) => a.usable_as_video === true)),
          segments: (segRows.rows ?? []).map((s) => ({
            segment_id: text(s.segment_id), t_label: text(s.t_label), start_seconds: round(num(s.start_seconds)),
            observed: s.observed ?? null, onscreen_text: s.onscreen_text ?? null, speech: s.speech ?? null,
            kind: scalar(s.kind) ?? null, fact_origin: scalar(s.fact_origin) ?? null, coverage: text(s.coverage) || null,
            human_note: text(s.human_note) || null, review_status: scalar(s.review_status) ?? null,
          })),
          assets: (assetRows.rows ?? []).map((a) => ({
            asset_id: text(a.asset_id), media_kind: scalar(a.media_kind) ?? null, usable_as_video: a.usable_as_video === true,
            local_path: text(a.local_path) || null, bytes: num(a.bytes), duration_seconds: round(num(a.duration_seconds)),
            media_url: a.usable_as_video === true ? `${cfg.mediaBase}/media/asset/${encodeURIComponent(text(a.asset_id))}` : null,
            viewer_url: a.usable_as_video === true ? `${cfg.mediaBase}/viewer?asset=${encodeURIComponent(text(a.asset_id))}` : null,
          })),
          metric_summary: [...byField.values()].map((m) => {
            // R12 修复（复核发现）：库里存的是 value_text / numeric_value，**不是** value；
            // 早先只读 m.value 导致有值的指标在页面上显示成“—”。
            // 二次复核又发现：直接把 numeric_value 显示出来会让**长 ID 丢精度**
            // （author_id 的 value_text=7625248362203939862 → Number 后变成 …940000）。
            // 规则：字符串型 / 超出安全整数范围的长数字 → 一律用 value_text 原文；其余才用数值。
            const status = scalar(m.status) ?? null;
            const numeric = num(m.numeric_value);
            const vtext = text(m.value_text);
            const unit = text(scalar(m.unit)) || null;
            const longInteger = /^-?\d{16,}$/.test(vtext);
            const preferText = unit === 'string' || longInteger;
            const display = status === 'value'
              ? (preferText && vtext
                ? `${vtext}${unit ? ' ' + unit : ''}`
                : (numeric !== null ? `${numeric}${unit ? ' ' + unit : ''}` : (vtext || '（有值但无文本/数值字段）')))
              : null;
            return {
              field: text(m.field), status, display_value: display, value_text: vtext || null,
              display_source: display === null ? null : (preferText && vtext ? 'value_text（原文，避免长 ID 丢精度）' : (numeric !== null ? 'numeric_value' : 'value_text')),
              numeric_value: numeric === null ? null : round(numeric), unit,
              observed_at_epoch_s: num(m.observed_at_epoch_s),
              metric_definition: text(m.metric_definition) || null, metric_caveat: text(m.metric_caveat) || null,
              validation_rule: text(m.validation_rule) || null, fact_origin: text(scalar(m.fact_origin)) || null,
              comparable_across_platforms: m.comparable_across_platforms === true,
            };
          }).sort((a, b) => a.field.localeCompare(b.field)),
          writable_fields: [...HUMAN_FIELDS],
          writable_field_meta: meta.fields,
        });
      }

      if (url.pathname === '/api/edit' && req.method === 'POST') {
        // R12 修复（复核发现）：写入口必须校验请求来源与内容类型。
        // 回环监听 + 字段白名单不能阻止“跨站表单/文本类型”的简单请求打到本地写接口。
        const ctype = String(req.headers['content-type'] ?? '');
        if (!/^application\/json\s*(;.*)?$/i.test(ctype)) {
          return json(res, 415, { error: 'content_type_must_be_application_json', got: ctype || '(none)', note: '写接口只接受 application/json（避免跨站简单请求写入）。' });
        }
        const site = String(req.headers['sec-fetch-site'] ?? '');
        const origin = String(req.headers['origin'] ?? '');
        const selfOrigins = [`http://127.0.0.1:${cfg.port ?? 8792}`, `http://localhost:${cfg.port ?? 8792}`];
        if (site && site !== 'same-origin' && site !== 'none') {
          return json(res, 403, { error: 'cross_site_write_refused', sec_fetch_site: site, note: '跨站来源的写入被拒绝。' });
        }
        if (origin && !selfOrigins.includes(origin)) {
          return json(res, 403, { error: 'cross_origin_write_refused', origin, allowed: selfOrigins, note: '只接受本面板自身的来源。' });
        }
        let raw = '';
        for await (const chunk of req) raw += chunk;
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch { return json(res, 400, { error: 'invalid_json' }); }
        const key = String(body.entity_key ?? '');
        const operator = String(body.operator ?? 'panel');
        if (!allowedKeys.has(key)) return json(res, 400, { error: 'entity_key_not_in_manifest', key });
        const fields = body.fields && typeof body.fields === 'object' ? body.fields : {};
        const names = Object.keys(fields);
        if (!names.length) return json(res, 400, { error: 'no_fields' });
        const rejected = names.filter((n) => !HUMAN_FIELDS.has(n));
        if (rejected.length) return json(res, 400, { error: 'field_not_writable', rejected, note: '只允许人工字段；来源派生字段不可由面板写入。' });

        const videos = await realVideos();
        if (!videos.ok) return json(res, 503, { error: 'baserow_unavailable', status: videos.status });
        const row = videos.rows.find((x) => text(x.entity_key) === key);
        if (!row) return json(res, 404, { error: 'row_not_found', key });

        // 选项校验（single_select 必须落在既有选项内）
        const meta = await writableMeta();
        if (!meta.ok) return json(res, 503, { error: 'field_meta_unavailable', status: meta.status });
        const metaByName = new Map(meta.fields.map((f) => [f.name, f]));
        for (const n of names) {
          const fm = metaByName.get(n);
          if (!fm) return json(res, 400, { error: 'field_not_in_table_or_not_writable', field: n });
          if (fm.type === 'single_select') {
            const v = fields[n];
            if (v !== null && !fm.options.includes(v)) return json(res, 400, { error: 'invalid_select_option', field: n, value: v, allowed: fm.options });
          }
          if (fm.type === 'date' && fields[n] !== null) {
            const rawv = String(fields[n]);
            const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(rawv);
            // R12 修复（复核发现）：Date.parse('2026-02-30') 会把非法日期规范化后“通过”，必须按字段回读校验。
            const realDate = m && (() => {
              const [Y, M, D, h, mi, s] = [m[1], m[2], m[3], m[4] ?? '00', m[5] ?? '00', m[6] ?? '00'].map(Number);
              const d = new Date(Date.UTC(Y, M - 1, D, h, mi, s));
              return d.getUTCFullYear() === Y && d.getUTCMonth() === M - 1 && d.getUTCDate() === D
                && d.getUTCHours() === h && d.getUTCMinutes() === mi && d.getUTCSeconds() === s;
            })();
            if (!realDate) {
              return json(res, 400, { error: 'invalid_date', field: n, value: fields[n], hint: 'YYYY-MM-DD 或 YYYY-MM-DDTHH:MM:SS（UTC），且必须是真实存在的日期/时刻' });
            }
          }
          if (fm.type === 'boolean' && fields[n] !== null && typeof fields[n] !== 'boolean') {
            return json(res, 400, { error: 'invalid_boolean', field: n, value: fields[n] });
          }
          if (fm.type === 'link_row') return json(res, 400, { error: 'link_field_not_supported_in_panel', field: n, note: '关联字段请在 Baserow 中改。' });
        }

        const before = Object.fromEntries(names.map((n) => [n, scalar(row[n] ?? null)]));
        const patch = await client.patchRow(T.Videos, row.id, fields);
        if (patch.status >= 300) {
          const wrote = audit({ at: new Date().toISOString(), operator, entity_key: key, row_id: row.id, attempted: fields, result: 'rejected', status: patch.status, response: String(patch.raw).slice(0, 300) });
          return json(res, 502, { error: 'write_rejected', status: patch.status, response: String(patch.raw).slice(0, 300), audit_written: wrote });
        }
        // 回读：网络/接口异常也必须留痕并如实报告，绝不静默当作成功。
        let after = null; let readbackError = null;
        try { after = await client.getRow(T.Videos, row.id); } catch (e) { readbackError = String(e?.message ?? e).slice(0, 160); }
        const confirmed = after && after.status === 200 ? after.json : null;
        // 单选项在行接口里返回 {id,value,color}，比较前统一取标量值；日期字段去掉小数秒与 Z 再比。
        const norm = (x) => { const s = scalar(x); return s === undefined || s === '' ? null : s; };
        const normDate = (x) => { const s = norm(x); return s === null ? null : String(s).replace(' ', 'T').replace(/\.\d+/, '').replace(/Z$/, '').slice(0, 19); };
        const isDate = (n) => (metaByName.get(n)?.type === 'date');
        const mismatches = [];
        if (!confirmed) mismatches.push({ field: '*', issue: 'readback_failed', status: after?.status ?? null, readback_error: readbackError });
        else for (const n of names) {
          const want = fields[n] === '' ? null : fields[n];
          const got = norm(confirmed[n]);
          const ok = isDate(n) ? normDate(want) === normDate(got)
            : typeof want === 'boolean' ? got === want
              : typeof want === 'number' ? Number(got) === want
                : String(got ?? '') === String(want ?? '');
          if (!ok) mismatches.push({ field: n, wanted: want, actual: got });
        }
        const line = {
          at: new Date().toISOString(), operator, entity_key: key, row_id: row.id,
          changed: Object.fromEntries(names.map((n) => [n, { from: before[n] ?? null, to: fields[n] ?? null }])),
          result: mismatches.length ? 'unconfirmed' : 'confirmed',
          mismatches,
        };
        const auditWritten = audit(line);
        return json(res, mismatches.length ? 409 : 200, {
          ...line,
          audit_path: auditPath,
          audit_written: auditWritten,
          audit_warning: auditWritten ? null : '审计行未能写入本地文件（写入本身已发生）——请人工登记',
          confirmed_values: confirmed ? Object.fromEntries(names.map((n) => [n, norm(confirmed[n])])) : null,
        });
      }

      if (url.pathname === '/api/edits') {
        // R12 第 6 批复核 R6-3：读取失败/解析失败**不得**变成“200 + 空列表”（那会被读作“没有编辑记录”）。
        let lines = []; let readError = null; let parseFailed = 0;
        try {
          const raw = fs.readFileSync(auditPath, 'utf8');
          for (const l of raw.split('\n').filter(Boolean).slice(-20)) {
            try { lines.push(JSON.parse(l)); } catch { parseFailed += 1; }
          }
        } catch (e) {
          readError = String(e?.code ?? e?.message ?? e).slice(0, 160);
        }
        if (readError) {
          return json(res, 500, {
            error: 'audit_read_failed', audit_path: auditPath, detail: readError,
            note: '审计文件读取失败：本页“最近编辑”不可信，不等于“没有编辑记录”。',
          });
        }
        return json(res, 200, {
          audit_path: auditPath, count: lines.length, parse_failed: parseFailed, edits: lines.reverse(),
          warning: parseFailed ? `审计文件有 ${parseFailed} 行无法解析（未计入列表）` : null,
        });
      }

      const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'], '/app.css': ['app.css', 'text/css; charset=utf-8'], '/app.js': ['app.js', 'application/javascript; charset=utf-8'] };
      const entry = files[url.pathname];
      if (!entry) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('not_found'); return; }
      const [name, type] = entry;
      const buf = fs.readFileSync(path.join(cfg.staticDir ?? path.join(HERE, 'panel'), name));
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(buf);
    } catch (e) {
      json(res, 500, { error: 'panel_server_error', message: String(e.message).slice(0, 200) });
    }
  });
  return { server, client, manifest, auditPath };
}

async function main() {
  const log = (...a) => console.log(...a);
  const argv = parseArgs(process.argv.slice(2));
  const root = argv.root ?? DEFAULT_ROOT;
  const out = path.resolve(root, argv.out ?? DEFAULT_OUT);
  const cfg = {
    out,
    manifestPath: argv.manifest ?? path.join(out, 'representative-sample-r5.json'),
    credsPath: argv['creds-file'] ?? path.join(out, 'deploy', 'baserow', '.task-credentials.json'),
    auditPath: argv.audit ?? path.join(out, 'evidence', 'r12-panel-edits.jsonl'),
    mediaBase: argv['media-base'] ?? 'http://127.0.0.1:8791',
    baserowBase: argv['baserow-base'] ?? 'http://127.0.0.1:8080',
    databaseId: argv['database-id'] ?? '661',
    tables: { Videos: 1354, Segments: 1355, 'Metric observations': 1356, Ratios: 1357, Assets: 1358 },
  };
  for (const [k, p] of Object.entries({ manifestPath: cfg.manifestPath, credsPath: cfg.credsPath })) {
    if (!fs.existsSync(p)) throw new Error(`missing_input:${k}:${p}`);
  }
  const port = Number(argv.port ?? 8792);
  if (argv.serve || argv._.includes('serve')) {
    const { server } = createPanelServer({ cfg });
    server.listen(port, '127.0.0.1', () => {
      log(`素材面板（M2 实时+可编辑）已启动：http://127.0.0.1:${port}`);
      log('数据来源＝Baserow 实时（服务端读取）；浏览器不含任何令牌；仅监听回环；停止：Ctrl+C');
    });
  } else {
    const { client } = createPanelServer({ cfg });
    const t = await client.listTables();
    log(JSON.stringify({ panel_version: PANEL_VERSION, base_url: client.base, database_id: cfg.databaseId, tables_status: t.status, tables: (t.json ?? []).map((x) => x.name) }, null, 2));
  }
}

if (process.argv[1] && process.argv[1].endsWith('panel.mjs')) {
  main().catch((e) => { console.error(`panel_failed:${e.message}`); process.exitCode = 1; });
}
