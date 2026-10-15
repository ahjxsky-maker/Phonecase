// tools/material-library/panel/app.js —— 本地面板前端（M2：实时读取 + 人工字段编辑）。
// 边界：令牌只在服务端；本文件绝不接触凭据，只调用本机 /api/*。
const state = { items: [], selected: null, detail: null, summary: null, meta: new Map(), metaOk: false, saved: null, edits: [], lastDetailError: null,
  // P0：口径与业务词都来自服务端（showCount＝列表实际渲染条数，用于顶栏与列表同口径）
  keyMetricLabels: [], terms: {}, scopeCounts: null, tierSummary: null, shownCount: 0, scope: null, sortRule: null, aiScope: null,
  // P0：loaded=false 时顶栏显示「读取中」而不是 0（0 会被误读成「库里没有素材」）
  // P0.5：view 表示当前视图（list/detail/gaps）——与已批准原型一致的一页两态
  loaded: false, view: 'list', total: 0, page: 1, hasMore: false, pageSize: 60, facets: null,
  // N3：批量选择与键盘焦点
  picked: new Set(), focusIndex: -1, ai: null, segRoleFeedback: null,
  // R-8 ④：列表最近一次读取失败的原因（刷新/保存后的提示要用它，不能在成功提示里把它吞掉）
  lastListError: null, tagFilter: null, dateUnknownFilter: null,
  // M4：当前正在编辑的拍摄计划草稿，以及"按职能取真实片段"的下拉缓存；
  // planExpected ＝ 本次**读到时**的逐字段快照（保存时作为前置条件回传，判据在服务端是库内当前值）
  planDraft: null, planRefPool: {}, planExpected: null };
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (s) => (s ? new Date(s * 1000).toISOString().slice(0, 10) : '—');
const fmtDur = (n) => (typeof n === 'number' && Number.isFinite(n) ? `${n.toFixed(2)} 秒` : '—');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : (v ?? '—'));
const hhmmss = (iso) => { try { const d = new Date(iso); return d.toLocaleTimeString('zh-CN', { hour12: false }); } catch { return iso ?? '—'; } };

// 面板允许编辑的人工字段分组（控件按 Baserow 实际类型渲染）
const GROUP_REVIEW = ['review_status', 'review_reviewer', 'review_reviewed_at', 'review_notes', 'review_value_categories'];
const CLASS_ITEMS = [
  { key: 'product_category', label: '产品类别' },
  { key: 'product_function', label: '产品功能' },
  { key: 'scene_or_need', label: '场景 / 需求' },
];
const ADVANCED = ['review_stale', 'review_stale_reason', 'selected_reference'];

// N2 收尾：自研 SQLite 库与 Baserow 归档的措辞必须分开——库里读不到时不能写成「Baserow 故障」。
function storeName() {
  const src = state.summary?.source;
  if (src === 'sqlite_store') return '自研本地库';
  if (src === 'baserow') return 'Baserow';
  return '数据源';
}

async function loadSummary() {
  const res = await readApiJson('/api/summary', { requiredFields: ['panel_version', 'source', 'counts', 'scope', 'tier_summary'] });
  const r = { status: res.ok ? 200 : 0 };
  const s = res.data;
  if (!res.ok) {
    $('summary').innerHTML = `<b style="color:#b45309">${storeName()} 读取失败（不是“没有数据”）${esc(res.detail)}</b>`;
    throw new Error(`summary_read_failed:${res.detail}`);
  }
  state.summary = s;
  state.ai = s.ai ?? null; // M2-F06：顶部显示 AI 真实进度
  // ★ 2026-10-13（Simon「可以 按你的建议」）：左侧也要显示**作用域内**的 AI 覆盖（默认＝有价值 580）。
  state.aiScope = s.ai_scope ?? null;
  state.meta = new Map((s.writable_field_meta ?? []).map((f) => [f.name, f]));
  state.metaOk = Boolean(s.writable_field_meta_ok);
  state.keyMetricLabels = s.key_metric_labels ?? [];
  state.terms = s.terms ?? {};
  renderHeader();
  return s;
}

// ── 视图与左侧分区导航（P0.5：把 8792 的界面与已批准原型对齐） ──
function setView(name) {
  state.view = name;
  for (const [id, v] of [['view-list', 'list'], ['view-detail', 'detail'], ['view-gaps', 'gaps'], ['view-library', 'library'], ['view-structure', 'structure'], ['view-plan', 'plan'], ['view-analysis', 'analysis']]) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', v !== name);
  }
  document.getElementById('nav-lib')?.classList.toggle('on', name === 'list');
  document.getElementById('nav-library')?.classList.toggle('on', name === 'library');
  document.getElementById('nav-structure')?.classList.toggle('on', name === 'structure');
  document.getElementById('nav-plan')?.classList.toggle('on', name === 'plan');
  document.getElementById('nav-analysis')?.classList.toggle('on', name === 'analysis');
  if (name === 'gaps') {
    document.getElementById('nav-lib')?.classList.remove('on');
    renderGaps();
  }
  if (name === 'library') renderLibrary();
  if (name === 'structure') renderStructure();
  if (name === 'plan') renderPlans();
  if (name === 'analysis') renderAnalysis();
  window.scrollTo({ top: 0 });
}

// ── 存量分析（①指标层趋势 + ②来源链接存活）：只显示**已跑过的只读回执**，未运行就如实说未运行 ──
async function renderAnalysis() {
  const box = $('analysis-body');
  if (!box) return;
  box.innerHTML = '<div class="tl-note">读取中…</div>';
  let j = null;
  try {
    const r = await fetch('/api/rest-analysis');
    j = await r.json();
    if (!r.ok) throw new Error(j?.error ?? `HTTP ${r.status}`);
  } catch (e) {
    box.innerHTML = `<div class="no-media" style="border-color:#b91c1c;color:#b91c1c"><b>分析回执读取失败（不是“没有分析结果”）</b><br>${esc(String(e.message ?? e))}</div>`;
    return;
  }
  const pct = (v) => (v === null || v === undefined ? '—' : `${(Number(v) * 100).toFixed(1)}%`);
  const num = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('en-US'));
  const t = j.trend?.present ? j.trend.data : null;
  const l = j.liveness?.present ? j.liveness.data : null;
  const play = t?.sections?.engagement_distribution?.metrics?.find((m) => m.field === 'engagement_play') ?? null;
  const months = t?.sections?.publish_trend?.by_month ?? [];
  const weeks = t?.sections?.publish_trend?.by_week ?? [];
  const platTier = t?.sections?.platform_x_tier?.rows ?? [];
  const concl = t?.sections?.conclusions ?? [];

  box.innerHTML = `
    <div class="card"><h3>① 指标层趋势/对标${t ? '' : '（未运行）'}</h3>
      ${t ? `
      <div class="tl-note">分母：可浏览 <b>${num(t.sections.engagement_distribution.scope_denominator)}</b> 条；有发布日期 <b>${num(t.sections.publish_trend.dated)}</b> 条，
        <b>日期未知 ${num(t.sections.publish_trend.undated)}</b> 条（缺失率 ${pct(t.sections.publish_trend.missing_rate)}，不按 0 计）。</div>
      <table><thead><tr><th>月份</th><th>条数</th></tr></thead><tbody>
        ${months.map((m) => `<tr><td>${esc(m.ym)}</td><td>${num(m.n)}</td></tr>`).join('') || '<tr><td colspan="2">无</td></tr>'}
      </tbody></table>
      <table><thead><tr><th>周</th><th>条数</th></tr></thead><tbody>
        ${weeks.map((w) => `<tr><td>${esc(w.yw)}</td><td>${num(w.n)}</td></tr>`).join('') || '<tr><td colspan="2">无</td></tr>'}
      </tbody></table>
      ${play ? `<table><thead><tr><th>播放量</th><th>值</th></tr></thead><tbody>
        <tr><td>可浏览内有值 / 分母</td><td><b>${num(play.in_scope_with_value)}</b> / ${num(play.in_scope_denominator)}（缺失 ${pct(play.missing_rate_in_scope)}）</td></tr>
        <tr><td>中位 / p90 / 最大</td><td>${num(play.median)} / ${num(play.p90)} / ${num(play.max)}</td></tr>
        <tr><td>前 10% 占总播放</td><td><b>${pct(play.top10pct_share)}</b>（前 1% ${pct(play.top1pct_share)}）</td></tr>
      </tbody></table>` : '<div class="no-media">播放量指标无可用样本。</div>'}
      <table><thead><tr><th>平台</th><th>档位</th><th>条数</th></tr></thead><tbody>
        ${platTier.map((r) => `<tr><td>${esc(r.platform)}</td><td>${esc(r.value_tier)}</td><td>${num(r.n)}</td></tr>`).join('')}
      </tbody></table>
      <div class="tl-note"><b>可行动结论：</b><ul>${concl.map((c) => `<li>${esc(c.claim)}<br><span class="tl-note">依据：${esc(c.basis)}　→ ${esc(c.action)}</span></li>`).join('')}</ul></div>
      <div class="tl-note">回执：${esc(j.trend.path)}（${num(j.trend.bytes)} B）　可重跑一致：${j.rerun?.present ? (j.rerun.data.verdict === 'PASS' ? '<b style="color:#15803d">是</b>' : '<b style="color:#b91c1c">否</b>') : '未运行'}</div>`
      : `<div class="no-media">还没有跑过分析脚本（预期回执 ${esc(j.trend?.path ?? '')}）。</div>`}
    </div>

    <div class="card"><h3>② 来源链接存活${l ? '' : '（未运行）'}</h3>
      ${l ? `
      <div class="tl-note">共探测 <b>${num(l.probed)}</b> 条；方法：${esc(l.method_policy)}；<b>未下载任何内容</b>（downloaded_bytes=${num(l.downloaded_bytes)}）。</div>
      <table><thead><tr><th>结果</th><th>条数</th></tr></thead><tbody>
        <tr><td>活（2xx/3xx）</td><td><b>${num(l.tally.alive ?? 0)}</b></td></tr>
        <tr><td>死（404/410）</td><td>${num(l.tally.dead ?? 0)}</td></tr>
        <tr><td>未知（超时/被拒等）</td><td>${num(l.tally.unknown ?? 0)}</td></tr>
      </tbody></table>
      <div class="tl-note">存活率 <b>${pct(l.alive_rate)}</b>，95% 区间 ${l.alive_rate_ci95 ? `[${pct(l.alive_rate_ci95[0])}, ${pct(l.alive_rate_ci95[1])}]` : '—'}；失败原因：${esc(JSON.stringify(l.failure_reasons ?? {}))}</div>
      <table><thead><tr><th>平台</th><th>活</th><th>死</th><th>未知</th></tr></thead><tbody>
        ${Object.entries(l.by_platform ?? {}).map(([p, v]) => `<tr><td>${esc(p)}</td><td>${num(v.alive)}</td><td>${num(v.dead)}</td><td>${num(v.unknown)}</td></tr>`).join('')}
      </tbody></table>
      <div class="tl-note">回执：${esc(j.liveness.path)}（${num(j.liveness.bytes)} B）</div>`
      : `<div class="no-media">还没有跑过链接探测（预期回执 ${esc(j.liveness?.path ?? '')}）。</div>`}
    </div>

    <div class="card"><h3>封面覆盖</h3>
      ${(() => {
        const cv = j.covers ?? {};
        const g = (cv.items ?? []).slice().reverse();
        return `<div class="tl-note">已有封面 <b>${num(cv.covers_total ?? 0)}</b> 条素材（平台原生封面 <b>${num(cv.fetched_from_platform ?? 0)}</b> + 本地视频抽帧 <b>${num(cv.extracted_from_video ?? 0)}</b>）；建议入库素材中 <b>${num(cv.in_scope_with_cover ?? 0)}</b> 条有封面、<b style="color:#b45309">${num(cv.in_scope_without_cover ?? 0)}</b> 条还没有。</div>
      <div class="tl-note">${esc(cv.note ?? '')}</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px">
        ${g.slice(0, 24).map((c) => `<span class="cover-thumb" data-cover-key="${esc(c.entity_key)}" title="${esc(c.entity_key)}（点击打开该素材）" style="cursor:pointer">
          <img src="/api/cover-image?key=${encodeURIComponent(c.entity_key)}" alt="封面" loading="lazy" style="width:96px;height:96px;object-fit:cover;border-radius:6px;border:1px solid #e5e7eb;background:#f3f4f6">
          <div class="tl-note" style="width:96px;font-size:11px">${c.result === 'cover_fetched' ? '平台' : '抽帧'} ${num(c.cover_bytes)}B</div></span>`).join('') || '<div class="tl-note">无</div>'}
      </div>
      ${g.length > 24 ? `<div class="tl-note">（此处只显示最近 24 张，共 ${num(cv.covers_total ?? 0)} 张。）</div>` : ''}`;
      })()}
    </div>

    <div class="tl-note">口径与局限：${esc(j.notes?.limits ?? '')}</div>`;

  // 封面缩略图点击即打开该素材详情（与列表点击同一条路径；封面所属素材往往没有视频资产，
  // 只能从这里进详情，所以必须显式绑事件而不是靠 hash 路由）。
  for (const el of box.querySelectorAll('.cover-thumb')) {
    el.addEventListener('click', () => { const k = el.getAttribute('data-cover-key'); if (k) select(k); });
  }
}

// ── M3：素材中心（九个入口，按复用用途）与结构中心（按已批准五段职能） ──
// 两者都按**生效职能**（人工决定优先、AI 兜底）统计；计数单位由服务端逐入口声明，本页只如实显示。
// 本段自带职能中文名，不依赖文件后半段才声明的 ROLE_TERM（避免初始化顺序耦合）。
const LIB_ROLE_TERM = {
  HOOK: '钩子 HOOK', pain: '痛点 pain', scene: '场景 scene', proof: '证据 proof',
  CTA: 'CTA 行动号召', insufficient_evidence: '证据不足',
};
const roleLabel = (r) => LIB_ROLE_TERM[r] ?? r ?? '—';
// M2：人工职能词表（与后端 /api/segment-role 的白名单一致）
const SEG_ROLE_OPTS = ['HOOK', 'pain', 'scene', 'proof', 'CTA', 'insufficient_evidence'];

/** M2：保存人工职能。逐条回报；失败时**不得**闪绿色、也不得让重绘把明细清掉。 */
async function saveSegmentRoles() {
  const els = [...document.querySelectorAll('#detail .seg-role')];
  const changed = els.filter((el) => String(el.value ?? '') !== String(el.dataset.orig ?? ''));
  const out = document.getElementById('seg-role-result');
  if (!changed.length) { if (out) out.textContent = '没有需要保存的人工职能改动'; return; }
  const key = state.selected;
  const lines = [];
  let okCount = 0;
  for (const el of changed) {
    try {
      const r = await fetch('/api/segment-role', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity_key: key, segment_id: el.dataset.seg, role: el.value === '' ? null : el.value, operator: operatorName() }),
      });
      const j = await r.json().catch(() => null);
      const ok = r.ok && j?.result === 'confirmed';
      if (ok) okCount += 1;
      lines.push(`${String(el.dataset.seg).split('|').slice(-2).join('|')}: ${ok ? '已保存并读回确认' : `失败（HTTP ${r.status}${j?.error ? ' / ' + j.error : ''}）`}`);
    } catch (e) { lines.push(`${el.dataset.seg}: 保存异常 ${e.message}`); }
  }
  const failed = changed.length - okCount;
  const head = failed === 0
    ? `人工职能保存：${okCount} 条已保存并读回确认`
    : `人工职能保存：成功 ${okCount} / ${changed.length} 条，**失败 ${failed} 条**（下列选择已在库中保持原值）`;
  // 反馈写进 state，重绘后重新注入——否则刷新会把失败明细吞掉（复审发现过）
  state.segRoleFeedback = `${head}\n${lines.join('\n')}`;
  if (out) out.textContent = state.segRoleFeedback;
  flash(head, failed === 0 ? 'ok' : 'warn');
  await select(key, { keepScroll: true });
}

async function renderLibrary() {
  const box = document.getElementById('library-entries');
  const items = document.getElementById('library-items');
  const note = document.getElementById('library-note');
  if (!box) return;
  box.innerHTML = '<div class="empty">读取素材中心…</div>';
  if (items) items.innerHTML = '';
  // 形状按**实际回执**定：manifest 有 entries/unit_policy，没有 totals（早前误写 totals 造成一次假失败）
  const resLib = await readApiJson('/api/segment-library', { arrayField: 'entries', requiredFields: ['unit_policy'] });
  if (!resLib.ok) { box.innerHTML = readFailedHtml('素材中心', resLib.detail, 'library-retry'); document.getElementById('library-retry')?.addEventListener('click', () => renderLibrary()); return; }
  const j = resLib.data;
  if (note) note.innerHTML = `${esc(j.unit_policy ?? '')}<br>${esc(j.identity_policy ?? '')}<br>${esc(j.media_policy ?? '')}`;
  box.innerHTML = (j.entries ?? []).map((e) => {
    const emptyTxt = e.empty_state
      ? `<div class="no-media" style="border-color:#b45309;color:#b45309"><b>暂无内容（不是 0 条结果）</b>：${esc(e.empty_state.detail ?? '')}</div>`
      : (e.zero_reason ? `<div class="tl-note">${esc(e.zero_reason.detail ?? '')}</div>` : '');
    return `<div class="lib-entry card" data-entry="${esc(e.id)}">
      <div class="lib-entry-head"><b>${esc(e.name)}</b>
        <span class="chip ${e.evidence_backed ? 'ok' : 'warn'}">${e.evidence_backed ? '有证据支撑' : '无留存内容'}</span>
        <span class="tl-note">${esc(e.count_note ?? '')}</span></div>
      <div class="tl-note">纳入：${esc(e.includes ?? '')}　｜　排除：${esc(e.excludes ?? '')}</div>
      ${e.evidence ? `<div class="tl-note">凭什么算有证据：${esc(e.evidence)}</div>` : ''}
      ${emptyTxt}
      ${e.empty_state ? '' : `<button type="button" class="btn lib-open" data-entry="${esc(e.id)}">查看该入口的片段</button>`}
    </div>`;
  }).join('');
  for (const b of box.querySelectorAll('.lib-open')) b.addEventListener('click', () => loadLibraryEntry(b.dataset.entry));
}

/** 片段表的共用渲染（素材中心按入口、结构中心按职能共用同一套列与口径）。 */
function segmentTableHtml(items, emptyText) {
  const rows = (items ?? []).map((it) => {
    const txt = [it.retained_text?.observed, it.retained_text?.onscreen_text, it.retained_text?.speech].filter(Boolean).join(' ／ ');
    const t = it.time_range?.start_seconds;
    return `<tr>
      <td>${esc(it.time_label ?? (t != null ? `${t}s` : '—'))}</td>
      <td>${esc(roleLabel(it.effective_role))}${it.human_role ? ' <span class="chip ok">人工</span>' : ''}</td>
      <td class="lib-txt">${esc(txt.slice(0, 160))}${txt.length > 160 ? '…' : ''}</td>
      <td>${esc(it.source?.platform ?? '—')} · ${esc(String(it.source?.native_id ?? '—'))}</td>
      <td>${it.playable
        ? `<button type="button" class="btn seek-open" data-key="${esc(it.entity_key)}" data-t="${t ?? ''}">打开来源并定位</button>`
        : '<span class="tl-note">没有可取数的媒体（本机无文件、云端也未登记），不能播放</span>'}</td>
    </tr>`;
  }).join('');
  return `<table class="lib-table"><thead><tr><th>时间</th><th>职能</th><th>留存文本（来源事实）</th><th>来源</th><th>播放</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="5" class="tl-note">${esc(emptyText)}</td></tr>`}</tbody></table>`;
}

function bindSeekOpen(scope) {
  for (const b of scope.querySelectorAll('.seek-open')) b.addEventListener('click', () => openSourceAt(b.dataset.key, b.dataset.t));
}

async function loadLibraryEntry(entryId) {
  const items = document.getElementById('library-items');
  if (!items) return;
  items.innerHTML = '<div class="empty">读取片段…</div>';
  const res = await readApiJson('/api/segment-library?entry=' + encodeURIComponent(entryId) + '&limit=200', { arrayField: 'items', requiredFields: ['count', 'unit'] });
  if (!res.ok) { items.innerHTML = readFailedHtml('该入口的片段', res.detail); return; }
  const j = res.data;
  items.innerHTML = `<div class="card" style="margin-top:10px"><h3>${esc(j.name ?? entryId)}（${esc(j.unit ?? '')}：${j.count ?? 0}）</h3>
    <div class="tl-note">同一片段出现在多个入口时，用的是同一个片段编号与同一份来源身份（用途是视图，不是副本）。</div>
    ${segmentTableHtml(j.items, '该入口没有片段')}</div>`;
  bindSeekOpen(items);
}

/**
 * M3-F02（受影响复审，高）：**按职能检索片段**必须在界面上真的可用。
 * 上一轮只加了服务端 GET /api/segment-library?role=<职能>，界面从未消费它——
 * 「结构中心每个职能改指向该端点」当时只是口头断言，属本项目复发性缺陷（未核实就下结论）。
 * 现在职能表的每一行都可点开该职能的片段清单，走的就是该端点；单位与该端点回执一致（segments）。
 */
async function loadRoleSegments(role) {
  const box = document.getElementById('structure-role-items');
  if (!box) return;
  box.innerHTML = '<div class="empty">读取该职能的片段…</div>';
  const res = await readApiJson('/api/segment-library?role=' + encodeURIComponent(role) + '&limit=200', { arrayField: 'items', requiredFields: ['count', 'unit'] });
  if (!res.ok) { box.innerHTML = readFailedHtml('该职能的片段', res.detail); return; }
  const j = res.data;
  const label = typeof roleLabel === 'function' ? roleLabel(j.role ?? role) : (j.role ?? role);
  box.innerHTML = `<div class="card" style="margin-top:10px"><h3>${esc(label)}（${esc(j.unit ?? 'segments')}：${j.count ?? 0}）</h3>
    <div class="tl-note">${esc(j.basis ?? '')}</div>
    ${segmentTableHtml(j.items, '该职能没有片段')}</div>`;
  bindSeekOpen(box);
}

async function renderStructure() {
  const body = document.getElementById('structure-body');
  const note = document.getElementById('structure-note');
  if (!body) return;
  body.innerHTML = '<div class="empty">读取结构中心…</div>';
  const res = await readApiJson('/api/structure-center', { arrayField: 'roles', requiredFields: ['missing_policy', 'units'], nestedNumberFields: ['totals.segments', 'totals.materials_with_segments'] });
  if (!res.ok) { body.innerHTML = readFailedHtml('结构中心', res.detail, 'structure-retry'); document.getElementById('structure-retry')?.addEventListener('click', () => renderStructure()); return; }
  const j = res.data;
  if (note) note.innerHTML = `${esc(j.basis ?? '')}<br>${esc(j.missing_policy ?? '')}<br>${esc(j.units ?? '')}<br><b>当前工作模式：以 AI 建议为生效职能（未经人工确认）</b>——人工决定可随时在素材详情里覆盖；AI 建议不会被写成人工结论。`;
  const share = (v) => (typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '未返回');
  const cnt = (v) => (typeof v === 'number' && Number.isFinite(v) ? Number(v).toLocaleString('en-US') : '—');
  const roles = (j.roles ?? []).map((r) => `<tr><td><a class="role-open" data-role="${esc(r.role)}" href="#">${esc(roleLabel(r.role))}</a></td><td>${cnt(r.segments)}</td><td>${cnt(r.materials)}</td><td>${share(r.share_of_segments)}</td></tr>`).join('');
  const formulas = (j.formulas ?? []).map((f) => `<tr>
      <td>${esc(String(f.entity_key).split('|').pop())}</td>
      <td class="lib-txt">${esc(f.formula_effective)}</td>
      <td>${f.missing_roles.length ? `<span style="color:#b45309">${esc(f.missing_roles.map((x) => roleLabel(x)).join('、'))}</span>` : '<span class="tl-note">五段齐</span>'}</td>
      <td>${f.playable
        ? (f.playable_delivery === 'cloud_relay' ? '<span class="chip ok">可播放（云中转）</span>' : '<span class="chip ok">可播放（本机文件）</span>')
        : '<span class="tl-note">无可取数媒体</span>'}</td>
    </tr>`).join('');
  const pos = (j.positions ?? []).map((p) => `<tr><td>第 ${p.position} 段</td><td>${esc(Object.entries(p.distribution).map(([k, v]) => `${roleLabel(k)}×${v}`).join('、'))}</td></tr>`).join('');
  const trans = (j.top_transitions ?? []).map((t) => `<li><code>${esc(t.pair)}</code> — ${t.segments_adjacent_pairs} 次相邻</li>`).join('');
  body.innerHTML = `
    <div class="card"><h3>职能分布（单位：片段数 / 出现该职能的素材数）</h3>
      <div class="tl-note">点职能名可看该职能的全部片段（按生效职能检索，人工决定优先）。</div>
      <table class="lib-table"><thead><tr><th>职能</th><th>片段数</th><th>素材数</th><th>占全部片段</th></tr></thead><tbody>${roles}</tbody></table></div>
    <div id="structure-role-items" class="lib-items"></div>
    <div class="card" style="margin-top:10px"><h3>逐素材结构公式（生效版＝人工决定优先）</h3>
      <div class="tl-note">缺失的职能如实列出，不为了凑齐五段而补；共 ${j.totals?.segments ?? 0} 个片段／${j.totals?.materials_with_segments ?? 0} 条素材有片段。</div>
      <table class="lib-table"><thead><tr><th>素材</th><th>生效公式</th><th>缺失职能</th><th>本地视频</th></tr></thead><tbody>${formulas}</tbody></table></div>
    <div class="card" style="margin-top:10px"><h3>位置分布（第 N 个片段是什么职能，单位：素材数）</h3>
      <table class="lib-table"><tbody>${pos}</tbody></table></div>
    <div class="card" style="margin-top:10px"><h3>常见相邻组合（供拍摄计划选结构）</h3><ul>${trans}</ul></div>`;
  for (const a of body.querySelectorAll('.role-open')) {
    a.addEventListener('click', (e) => { e.preventDefault(); loadRoleSegments(a.dataset.role); });
  }
}

/** ★ 第 66/67 轮 F66-02/F67-02：定位成功后"播放期间位置/来源是否仍成立"的**纯判定函数**（唯一实现，便于回归）。
 *  第 67 轮复核证明旧版容差（≥1 秒且双向）会把"近起点归零"和"播放源变空"判成成功，故改为：
 *   ① **单向**：允许向前播放（`afterTime` 可以略大于目标），**禁止向后重置**（`afterTime < target - 0.35` ⇒ 失败）；
 *   ② **紧容差**：向前不超过 `目标 + 已播放时长 + 1.0s`（防止跳到别处）；
 *   ③ **来源不得丢失或更换**：`srcBefore` 非空而 `srcAfter` 为空，或两者非空且不同 ⇒ 失败。
 *  返回 { ok, reason }：ok=false 时调用方必须如实报失败，不得显示成功文案。 */
function locateGuardDecision(verifiedAt, afterTime, target, srcBefore, srcAfter, elapsedMs) {
  const bothSrc = Boolean(srcBefore) && Boolean(srcAfter);
  if (bothSrc && srcBefore !== srcAfter) return { ok: false, reason: 'playback_source_swapped' };
  if (srcBefore && !srcAfter) return { ok: false, reason: 'playback_source_lost' };
  if (!Number.isFinite(afterTime)) return { ok: false, reason: 'position_unreadable' };
  if (!Number.isFinite(target)) return { ok: false, reason: 'target_not_finite' };
  if (afterTime < target - 0.35) return { ok: false, reason: 'position_reset_after_play' };
  const elapsedSec = Number.isFinite(Number(elapsedMs)) ? Math.max(0, Number(elapsedMs)) / 1000 : 0;
  if (afterTime > target + elapsedSec + 1.0) return { ok: false, reason: 'position_jumped_forward' };
  void verifiedAt;
  return { ok: true, reason: null };
}

/** MP-07：从素材中心跳到来源素材，并**定位到该片段起点**（仅可播者有此入口）。
 *  ★ 第 64 轮复核（F64-06/定位竞态）：原先 `select()` 之后**立刻**设 `currentTime` 并 play ⇒ 媒体还在重建时
 *  定位会被丢掉（实测点击后立即读可能仍是 0，要等播放开始才生效）。现在：等 `loadedmetadata`/就绪后设时间，
 *  再校验一次（允许一次重试），并把最终读数写进 `#media-state`，让"定位到秒"可被直接观测。
 */
async function openSourceAt(entityKey, startSeconds) {
  const note0 = document.getElementById('media-state');
  await select(entityKey);
  const t = Number(startSeconds);
  const v = document.getElementById('player');
  // ★ 第 65 轮复核 F65-02（高）：此前**忽略** `waitReady()` 的返回值，就绪失败仍在两次设时间后播放
  //   并写"已定位到引用时间点"的**成功**文案（复核方进程内反例：readyState=0、时间恒为 0，仍显示已定位）。
  //   现在：① 就绪失败即退出并显示失败原因；② 只有**校验通过**才播放与显示成功；③ 超时/持续 seeking/设时间失败
  //   分别留失败状态，不再把失败说成成功。
  const fail = (why) => {
    const note = document.getElementById('media-state') ?? note0;
    if (note) note.innerHTML = `<b style="color:#b91c1c">定位失败：${esc(why)}（目标 ${Number.isFinite(t) ? t : '—'}s）</b>`;
    return { ok: false, reason: why };
  };
  if (!Number.isFinite(t)) return fail('引用时间点不是有效数字');
  if (!v) return fail('该素材没有可取数的媒体，页面未提供播放器');
  const waitReady = async (ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (v.error) return false;
      if (v.readyState >= 1) return true;
      await new Promise((r) => setTimeout(r, 120));
    }
    return v.readyState >= 1;
  };
  // ★ 第 67 轮实测：中转冷启动可能 > 6 秒（本轮实测一次"媒体 6 秒内未就绪"），故就绪等待放宽到 20 秒，
  //   并在超时时如实报失败（不退化成"成功"）。
  const ready = await waitReady(20000);
  if (!ready) return fail(v.error ? `媒体错误 code=${v.error.code}` : '媒体 20 秒内未就绪');
  let located = false;
  for (let attempt = 1; attempt <= 2 && !located; attempt += 1) {
    try { v.currentTime = t; } catch { continue; }
    const deadline = Date.now() + 3000;
    let timedOutOnSeeking = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 120));
      if (v.error) return fail(`媒体错误 code=${v.error.code}`);
      if (v.seeking) { timedOutOnSeeking = true; continue; }
      timedOutOnSeeking = false;
      if (Math.abs(v.currentTime - t) <= 0.35) { located = true; break; }
    }
    if (!located && timedOutOnSeeking) return fail('定位超时（媒体持续处于 seeking）');
  }
  if (!located) return fail(`两次设置后位置仍未到达目标（当前读数 ${v.currentTime.toFixed(3)}s）`);
  // ★ 第 66 轮复核 F66-02（中）：此前在这里 `await v.play()` 后**不再复校验**就返回成功——
  //   复核方进程内替身让 play() 期间位置被重置为 0，仍得到 {ok:true,currentTime:0} 并显示"已定位"。
  //   现在把**定位**与**播放**分开报告：播放前记录校验快照，播放后再校验一次位置是否仍在目标附近；
  //   被重置则重试一次定位，仍不行就如实报"定位成功但播放后位置被重置"。
  const verifiedAt = v.currentTime;
  const srcBefore = v.currentSrc || v.src || '';
  let playErr = null;
  const playStartedAt = Date.now();
  try { await v.play(); } catch (e) { playErr = String(e?.message ?? e); }
  await new Promise((r) => setTimeout(r, 350));
  const elapsedMs = Date.now() - playStartedAt;
  const srcAfter = v.currentSrc || v.src || '';
  let gate = locateGuardDecision(verifiedAt, v.currentTime, t, srcBefore, srcAfter, elapsedMs);
  if (!gate.ok) {
    // 一次补救：重设时间并再校验；仍不成立则如实报失败，不写成功文案
    try { v.currentTime = t; } catch { /* 交给下面的校验 */ }
    await new Promise((r) => setTimeout(r, 500));
    gate = locateGuardDecision(verifiedAt, v.seeking ? NaN : v.currentTime, t, srcBefore, v.currentSrc || v.src || '', Date.now() - playStartedAt);
    if (!gate.ok) {
      const note = document.getElementById('media-state') ?? note0;
      if (note) note.innerHTML = `<b style="color:#b91c1c">定位校验后播放时位置/来源失效（目标 ${t}s，播放后读数 ${Number.isFinite(v.currentTime) ? v.currentTime.toFixed(3) : '—'}s，原因 ${esc(gate.reason)}）；未确认定位成功</b>`;
      return { ok: false, located: { ok: true, currentTime: t, verified_at: verifiedAt }, played: { ok: false, reason: gate.reason, currentTime: v.currentTime, playErr }, reason: gate.reason };
    }
  }
  const note = document.getElementById('media-state') ?? note0;
  if (note) note.innerHTML = `<b style="color:#b45309">已定位到引用时间点 ${t}s（播放前校验读数 ${verifiedAt.toFixed(3)}s，播放后读数 ${v.currentTime.toFixed(3)}s，媒体时长 ${Number.isFinite(v.duration) ? v.duration.toFixed(2) : '—'}s）</b>`;
  return { ok: true, located: { ok: true, currentTime: t, verified_at: verifiedAt }, played: { ok: playErr === null, playErr, currentTime: v.currentTime } };
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// M4（MP-08／MP-09）：拍摄计划构建与引用追溯
//
// MP-08：从明确的产品/需求出发，建计划 → 每个结构节点选**真实片段**做参考 → 记录想表达什么（创作建议）、
//        拟口播/文案、拟拍摄画面与**缺口** → 保存 → 可重新打开。
//        创作建议与来源事实**分开存**：这张表里的输入框都是人工新写的内容；参考片段只存身份，
//        时间点与留存文本读取时从素材库现取。
// MP-09：计划看得到每个节点引用的素材；素材详情看得到自己被哪些计划引用；改一份计划不碰别份。
// ═══════════════════════════════════════════════════════════════════════════════════════
const PLAN_DRAFT_EMPTY = () => ({ plan_id: null, rev: null, product_or_need: '', communication_purpose: '', status: 'draft', human_note: '', nodes: [] });

/**
 * 统一的接口读取：**三态**（ok / 读不到），杜绝「失败或字段缺失被当成空/零」。
 * 受影响复审连续两轮各抓出若干处"失败被显示成空或 0"（读取失败→空池→"请标缺口"、详情失败→清空、
 * 反查失败→"被 0 份计划引用"、200-无-items→"确实没有"）。只补单个调用点是治标——
 * 这里给所有计划相关的读取一个共同入口：**HTTP 必须 ok、body 必须是对象、必须没有 error、
 * 期望的字段必须存在且类型正确**；任何一项不满足都返回 `failed`，调用方只能如实说"读不到"。
 */
async function readApiJson(url, { arrayField = null, requiredFields = [], numberFields = [], nestedNumberFields = [] } = {}) {
  try {
    const r = await fetch(url);
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || typeof j !== 'object' || Array.isArray(j) || j.error) {
      return { ok: false, detail: `HTTP ${r.status}${j?.error ? ' / ' + j.error : ''}`, data: null };
    }
    for (const f of requiredFields) {
      if (j[f] === undefined || j[f] === null) return { ok: false, detail: `返回体缺少必需字段 ${f}（HTTP ${r.status}）`, data: null };
    }
    // 第四轮受影响复审指出：只查"存在"不够——`count: false` 也能过关，随后 `if (!count)` 又变成"没有被引用"。
    // 计数类字段必须**是数字**，否则同样按"读不到"处理。
    for (const f of numberFields) {
      if (typeof j[f] !== 'number' || !Number.isFinite(j[f])) return { ok: false, detail: `返回体的 ${f} 不是有效数字（HTTP ${r.status}）`, data: null };
    }
    // 第五轮受影响复审指出：嵌套对象字段（如结构中心的 totals）只查对象存在，
    // `totals: {}` 仍会渲染成「0 个片段／0 条素材」——把"读不到"说成"确实是 0"。这里按点号路径查数字。
    for (const p of nestedNumberFields) {
      const v = p.split('.').reduce((a, k) => (a === null || a === undefined ? undefined : a[k]), j);
      if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false, detail: `返回体的 ${p} 不是有效数字（HTTP ${r.status}）`, data: null };
    }
    if (arrayField && !Array.isArray(j[arrayField])) return { ok: false, detail: `返回体的 ${arrayField} 不是数组（HTTP ${r.status}）`, data: null };
    return { ok: true, detail: null, data: j };
  } catch (e) {
    return { ok: false, detail: String(e?.message ?? e).slice(0, 90), data: null };
  }
}

/** 读不到的统一样子（三态里的第三态，绝不渲染成空或 0）。 */
const readFailedHtml = (what, detail, retryId = null) =>
  `<div class="no-media" style="border-color:#b45309;color:#b45309">${esc(what)}读取失败（<b>不是「没有${esc(what)}」</b>）：${esc(detail)}
   ${retryId ? `<br><button type="button" class="btn" id="${retryId}">重试读取</button>` : ''}</div>`;

// 第十二轮受影响复审（有业务后果）：服务端**没返回**某个创作字段时，早期实现用 `?? ''` 兜成空串，
// 而保存是整份替换 → **用户没清空，原创作意图却被清空**。凡是"从回包构造的草稿"，缺失字段一律**记名**，
// 并在保存时**阻断**，绝不用空值顶替。新增计划（用户自己输入）不经过这里，不受影响。
const PLAN_AUTHORED_FIELDS = ['product_or_need', 'communication_purpose', 'human_note', 'status'];
const NODE_AUTHORED_FIELDS = ['role', 'intended_expression', 'spoken_copy_note', 'proposed_shot', 'missing_reason'];

function planDraftOf(plan) {
  // 第十轮受影响复审：`nodes:[null]` 会让 `n.role` 抛异常（整页打不开）。非对象节点一律过滤并**计数**，
  // 由调用方如实告诉用户"有 N 个节点不是有效对象、已跳过"，而不是静默丢弃或崩溃。
  const rawNodes = Array.isArray(plan.nodes) ? plan.nodes : [];
  const nodes = rawNodes.filter((n) => n && typeof n === 'object').map((n) => ({
      role: n.role, intended_expression: n.intended_expression ?? '', spoken_copy_note: n.spoken_copy_note ?? '',
      proposed_shot: n.proposed_shot ?? '', missing_shot: n.missing_shot === 1, missing_reason: n.missing_reason ?? '',
      references: Array.isArray(n.references) ? n.references.map((r) => ({ entity_key: r?.entity_key, segment_id: r?.segment_id })) : [],
      // 第九轮受影响复审指出：`references: null` 被静默转成 `[]`，等于把"未返回"当成"没有参考"。
      // 这里留下标记，界面上如实显示，且**不允许带着未知状态保存**（否则会把未知写成空）。
      references_unknown: !Array.isArray(n.references),
      // 回包里根本没给这个字段 → 记名，保存时阻断（否则会把没读到的创作文本写成空）
      unknown_fields: NODE_AUTHORED_FIELDS.filter((f) => n[f] === undefined),
  }));
  return {
    plan_id: plan.plan_id, rev: plan.rev,
    product_or_need: plan.product_or_need ?? '', communication_purpose: plan.communication_purpose ?? '',
    status: plan.status ?? 'draft', human_note: plan.human_note ?? '',
    nodes,
    dropped_nodes: rawNodes.length - nodes.length,
    // 第十三轮受影响复审（有业务后果）：回包里 `nodes` 比服务端自报的 `node_count` 少时，编辑器无从察觉，
    // 保存（整份替换）会把**没读到的节点当成被删除**。
    // 关键：这个核对必须在**读取时一次性判定**并存成 `loaded_ok`，不能在保存时比对——
    // 否则用户**主动删掉一个节点**也会被误判成"没读到"而被拒存（那是假拦截）。
    loaded_ok: (() => {
      const dn = typeof plan.node_count === 'number' ? plan.node_count : null;
      const dr = typeof plan.reference_count === 'number' ? plan.reference_count : null;
      const refsSeen = nodes.reduce((a, n) => a + n.references.length, 0);
      // 第十四轮受影响复审：**自报总数本身缺失**也是"读得不完整"——早期写法把 `null` 当成"无需核对"，
      // 于是回包里删掉 `reference_count` 就能绕过核对、静默丢参考。契约上这两个总数必须存在，缺一即判不完整。
      if (dn === null || dr === null) return false;
      if (rawNodes.length !== dn) return false;
      if (refsSeen !== dr) return false;
      return true;
    })(),
    loaded_detail: `服务端自报 节点=${plan.node_count ?? '未返回'}／参考=${plan.reference_count ?? '未返回'}；本次读到 节点=${rawNodes.length}（有效 ${nodes.length}）／参考=${nodes.reduce((a, n) => a + n.references.length, 0)}`,
    unknown_fields: PLAN_AUTHORED_FIELDS.filter((f) => plan[f] === undefined),
  };
}

async function renderPlans() {
  const list = document.getElementById('plan-list');
  const editor = document.getElementById('plan-editor');
  if (!list) return;
  list.innerHTML = '<div class="empty">读取计划…</div>';
  const res = await readApiJson('/api/plans', { arrayField: 'plans', numberFields: ['count'] });
  if (!res.ok) {
    list.innerHTML = `<div class="empty" style="color:#b45309">计划读取失败（不是“没有计划”）</div>` + readFailedHtml('计划', res.detail, 'plan-list-retry');
    document.getElementById('plan-list-retry')?.addEventListener('click', () => renderPlans());
    return;
  }
  const j = res.data;
  // 第七轮受影响复审指出：计划行的计数字段为 null 时仍显示 0（`false`/null 都被 Number() 变成 0）。
  // 计数一律走 cntN()：不是有限数字就写「未返回」，绝不写 0。
  const cntN = (v) => (typeof v === 'number' && Number.isFinite(v) ? Number(v).toLocaleString('en-US') : '<span style="color:#b45309">未返回</span>');
  // 第八轮受影响复审指出：`plans: [null]` 会让 `p.plan_id` 抛异常（整页渲染失败）。
  // 非对象行如实丢弃并计数，不静默当成"没有这个计划"。
  const rawPlans = Array.isArray(j.plans) ? j.plans : [];
  const rows = rawPlans.filter((p) => p && typeof p === 'object').map((p) => `<tr class="plan-row" data-plan="${esc(p.plan_id)}">
      <td><a class="plan-open" data-plan="${esc(p.plan_id)}" href="#">${esc(p.plan_id)}</a></td>
      <td>${esc(p.product_or_need)}</td>
      <td>${esc(p.communication_purpose ?? '—')}</td>
      <td>${cntN(p.node_count)}</td><td>${cntN(p.reference_count)}</td>
      <td>${p.missing_shot_count === 0 ? '0' : `<span style="color:#b45309">${cntN(p.missing_shot_count)}</span>`}</td>
      <td>${esc(String(p.updated_at).slice(0, 19))}</td>
    </tr>`).join('');
  const droppedRows = rawPlans.length - rawPlans.filter((p) => p && typeof p === 'object').length;
  list.innerHTML = `<div class="card"><h3>拍摄计划（${j.count ?? 0}）</h3>
    <div class="tl-note">节点数 / 参考片段数 / 缺口数分开计数：缺口是「没有可用素材、如实记下来」，不会被算成已有素材。${droppedRows ? `<br><b style="color:#b45309">返回体里有 ${droppedRows} 行不是有效计划对象，已如实跳过（不当作"没有这个计划"）。</b>` : ''}</div>
    <table class="lib-table"><thead><tr><th>计划</th><th>产品 / 需求</th><th>传播目的</th><th>节点</th><th>参考片段</th><th>缺口</th><th>更新于</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="7" class="tl-note">${droppedRows ? `返回体里有 ${droppedRows} 行不是有效计划对象，已全部跳过——这**不是「没有计划」**` : '还没有计划'}</td></tr>`}</tbody></table>
    <div class="plan-actions"><button type="button" class="btn" id="plan-new">新建计划</button></div></div>`;
  if (editor) editor.innerHTML = '<div class="empty">选择左侧计划打开，或点「新建计划」</div>';
  document.getElementById('plan-new')?.addEventListener('click', () => openPlan(null));
  for (const a of list.querySelectorAll('.plan-open')) a.addEventListener('click', (e) => { e.preventDefault(); openPlan(a.dataset.plan); });
}

async function openPlan(planId) {
  const editor = document.getElementById('plan-editor');
  if (!editor) return;
  if (!planId) {
    state.planDraft = PLAN_DRAFT_EMPTY();
    state.planDraft.nodes = [
      { role: 'HOOK', intended_expression: '', spoken_copy_note: '', proposed_shot: '', missing_shot: false, missing_reason: '', references: [] },
    ];
    state.planRefPool = {};
    renderPlanEditor();
    return;
  }
  editor.innerHTML = '<div class="empty">读取计划…</div>';
  const res = await readApiJson('/api/plan?id=' + encodeURIComponent(planId), { arrayField: 'nodes', requiredFields: ['plan_id', 'rev'] });
  if (!res.ok) {
    editor.innerHTML = readFailedHtml('这份计划', res.detail, 'plan-open-retry');
    document.getElementById('plan-open-retry')?.addEventListener('click', () => openPlan(planId));
    return;
  }
  state.planDraft = planDraftOf(res.data);
  // 逐字段前置条件的基准＝**这次读到的内容**（用户编辑前）。编辑不再改它，保存时原样回传，
  // 由服务端与库内当前值比对——这样"回包与库不一致"和"并发改动"都会被整笔拒绝。
  state.planExpected = planSnapshotOf(state.planDraft);
  renderPlanEditor();
}

/** 把草稿的**可写内容**做成正则快照（保存时作为 expected_plan / expected_nodes 回传）。
 *  第十六轮受影响复审补正：计划级字段（产品/需求、传播目的、人工备注、状态）也必须纳入，
 *  否则"回包与库不一致"仍能绕过前置条件把备注等清掉。 */
function planSnapshotOf(d) {
  return {
    plan: {
      product_or_need: d?.product_or_need ?? '',
      communication_purpose: d?.communication_purpose ?? '',
      human_note: d?.human_note ?? '',
      status: d?.status ?? 'draft',
    },
    nodes: (d?.nodes ?? []).map((n) => ({
      role: n.role,
      intended_expression: n.intended_expression ?? '',
      spoken_copy_note: n.spoken_copy_note ?? '',
      proposed_shot: n.proposed_shot ?? '',
      missing_shot: n.missing_shot ? 1 : 0,
      missing_reason: n.missing_reason ?? '',
      references: (n.references ?? []).map((r) => ({ entity_key: r.entity_key, segment_id: r.segment_id })),
    })),
  };
}

/** 每个节点按**该节点的职能**取真实片段供选择（复用 M3 的按职能检索端点）。
 *  独立复审判 MP-08 FAIL 的一条正是这里：早期实现把**读取失败**也变成空池并提示"请标缺口"——
 *  那是把"不知道有没有"说成"确实没有"，属于本项目反复出现的「失败被当成空」家族。
 *  现在显式区分三态：ok=true/items=[]（确实没有）/ ok=false（读取失败，绝不据此标缺口）。失败**不缓存**，可重试。
 *
 *  ★ 2026-10-15（第 61 轮复核 F61-04 引出的真实缺口）：只按职能取**前 200 条**时，操作者
 *  「刚检索到并人工确认过的那条素材」很可能不在下拉里 ⇒ 拍计划时引用不到自己正在看的素材。
 *  现在支持传 `q`（素材标题 / 平台编号 / entity_key 子串）**服务端筛选**，界面上每个节点有筛选框。
 */
async function loadPlanRefPool(role, q = '') {
  const key = q ? `${role}\u0000${q}` : role;
  const cached = state.planRefPool?.[key];
  if (cached?.ok && !q) return cached;
  const url = '/api/segment-library?role=' + encodeURIComponent(role) + '&limit=200' + (q ? `&q=${encodeURIComponent(q)}` : '');
  const res = await readApiJson(url, { arrayField: 'items', requiredFields: ['count'] });
  if (!res.ok) return { ok: false, failed: res.detail, items: null };
  state.planRefPool = state.planRefPool ?? {};
  state.planRefPool[key] = { ok: true, failed: null, items: res.data.items };
  return state.planRefPool[key];
}

function renderPlanEditor() {
  const box = document.getElementById('plan-editor');
  const d = state.planDraft;
  if (!box || !d) return;
  const nodeHtml = d.nodes.map((n, i) => {
    // 独立复审（判 MP-08 FAIL）指出：创作文本可以先写一套、引用的却是另一回事，而界面当时不显示来源实际内容。
    // 现在每条参考都并排显示**来源实际留存文本**（现取自素材库），让人一眼能看出"我写的"和"素材实际是什么"是否对得上。
    const hintOf = (r) => {
      const cached = state.planRefHint?.[`${r.entity_key}|${r.segment_id}`];
      if (cached) return cached;
      const items = state.planRefPool?.[n.role]?.items ?? [];
      const hit = items.find((it) => it.entity_key === r.entity_key && it.segment_id === r.segment_id);
      return hit?.retained_text ?? null;
    };
    const refs = n.references.map((r, ri) => {
      const h = hintOf(r);
      const txt = h ? [h.observed, h.onscreen_text, h.speech].filter(Boolean).join(' ／ ') : '';
      return `<div class="plan-ref"><span class="chip-x" data-unref="${i}:${ri}">${esc(String(r.segment_id).split('|').slice(-2).join('@'))} ✕</span>
        <span class="tl-note">来源实际留存文本：${txt ? esc(txt.slice(0, 140)) : '（保存后在下方「已保存内容」里查看，或该来源无留存文本）'}</span></div>`;
    }).join('');
    return `<div class="plan-node card" style="margin-top:10px">
      <div class="plan-node-head"><b>节点 ${i + 1}</b>
        <select class="node-role" data-i="${i}">${SEG_ROLE_OPTS.map((v) => `<option value="${v}"${n.role === v ? ' selected' : ''}>${esc(roleLabel(v))}</option>`).join('')}</select>
        <label class="chk"><input type="checkbox" class="node-missing" data-i="${i}"${n.missing_shot ? ' checked' : ''} /> 这一格没有素材（缺口）</label>
        <span class="spacer"></span>
        <button type="button" class="btn ghost node-up" data-i="${i}"${i === 0 ? ' disabled' : ''}>↑</button>
        <button type="button" class="btn ghost node-down" data-i="${i}"${i === d.nodes.length - 1 ? ' disabled' : ''}>↓</button>
        <button type="button" class="btn ghost node-del" data-i="${i}">删除</button>
      </div>
      <div class="plan-grid">
        <label>想表达什么（创作建议，人工撰写）<textarea class="node-intent" data-i="${i}" rows="2">${esc(n.intended_expression)}</textarea></label>
        <label>拟口播 / 文案备注<textarea class="node-copy" data-i="${i}" rows="2">${esc(n.spoken_copy_note)}</textarea></label>
        <label>拟拍摄画面<textarea class="node-shot" data-i="${i}" rows="2">${esc(n.proposed_shot)}</textarea></label>
      </div>
      ${n.references_unknown ? `<div class="no-media" style="border-color:#b45309;color:#b45309"><b>这个节点的参考状态"未返回"</b>——不等于"没有参考"。请重新打开计划或点重试读取后再编辑（此状态下不允许保存）。</div>`
        : (n.missing_shot ? `<div class="no-media" style="border-color:#b45309;color:#b45309">
          <b>缺口：这一格没有可用素材</b>（不会被显示成已有素材）<br>
          <input class="node-missing-reason" data-i="${i}" style="width:100%" placeholder="缺什么？例如：没有任何通勤/地铁场景的留存素材" value="${esc(n.missing_reason)}" />
        </div>`
          : `<div class="plan-refs">
          <div class="tl-note">参考片段（来源事实从这里现取，计划不存快照）：${refs || '<span style="color:#b45309">还没有参考片段——请加一条，或勾选上面的「缺口」</span>'}</div>
          <div class="plan-ref-add">
            <input class="node-ref-q" data-i="${i}" style="min-width:16em" placeholder="筛素材（标题 / 平台编号 / entity_key 子串）" />
            <select class="node-ref-pick" data-i="${i}"><option value="">选择该职能的真实片段…</option></select>
            <button type="button" class="btn ghost node-ref-btn" data-i="${i}">加入参考</button>
          </div>
        </div>`)}
    </div>`;
  }).join('');
  box.innerHTML = `<div class="card"><h3>${d.plan_id ? `编辑计划 ${esc(d.plan_id)}（rev ${d.rev}）` : '新建计划'}</h3>
    <div class="plan-grid">
      <label>产品 / 需求（必填）<input class="plan-product" style="width:100%" value="${esc(d.product_or_need)}" placeholder="例如：iPhone Duo 磁吸壳 · 通勤防摔需求" /></label>
      <label>传播目的<input class="plan-purpose" style="width:100%" value="${esc(d.communication_purpose ?? '')}" placeholder="例如：让人相信这款壳真的扛摔" /></label>
      <label>备注<textarea class="plan-note" rows="2" style="width:100%">${esc(d.human_note ?? '')}</textarea></label>
    </div>
    <div class="tl-note">创作字段（想表达什么 / 拟口播 / 拟拍摄画面）是**人工新写**的建议，与来源事实分开放；参考片段只存身份，时间点与留存文本读取时现取。</div>
    ${d.dropped_nodes ? `<div class="no-media" style="border-color:#b45309;color:#b45309"><b>返回体里有 ${d.dropped_nodes} 个节点不是有效对象，已跳过</b>——这不等于"计划里没有这些节点"。</div>` : ''}
    <div id="plan-nodes">${nodeHtml || '<div class="empty">还没有节点</div>'}</div>
    <div class="plan-actions">
      <button type="button" class="btn ghost" id="plan-add-node">加一个节点</button>
      <span class="spacer"></span>
      <button type="button" class="btn" id="plan-save">保存计划</button>
    </div>
    <div id="plan-feedback" class="tl-note"></div>
  </div>
  <div id="plan-detail"></div>`;

  const on = (sel, ev, fn) => { for (const el of box.querySelectorAll(sel)) el.addEventListener(ev, fn); };
  box.querySelector('.plan-product')?.addEventListener('input', (e) => { d.product_or_need = e.target.value; });
  box.querySelector('.plan-purpose')?.addEventListener('input', (e) => { d.communication_purpose = e.target.value; });
  box.querySelector('.plan-note')?.addEventListener('input', (e) => { d.human_note = e.target.value; });
  on('.node-role', 'change', (e) => { d.nodes[Number(e.target.dataset.i)].role = e.target.value; state.planRefPool = {}; renderPlanEditor(); });
  on('.node-intent', 'input', (e) => { d.nodes[Number(e.target.dataset.i)].intended_expression = e.target.value; });
  on('.node-copy', 'input', (e) => { d.nodes[Number(e.target.dataset.i)].spoken_copy_note = e.target.value; });
  on('.node-shot', 'input', (e) => { d.nodes[Number(e.target.dataset.i)].proposed_shot = e.target.value; });
  on('.node-missing-reason', 'input', (e) => { d.nodes[Number(e.target.dataset.i)].missing_reason = e.target.value; });
  on('.node-missing', 'change', (e) => {
    const n = d.nodes[Number(e.target.dataset.i)];
    n.missing_shot = e.target.checked;
    if (n.missing_shot) n.references = []; // 缺口不得带引用（服务端同样会拒）
    renderPlanEditor();
  });
  on('.node-up', 'click', (e) => { const i = Number(e.target.dataset.i); if (i > 0) { const [x] = d.nodes.splice(i, 1); d.nodes.splice(i - 1, 0, x); renderPlanEditor(); } });
  on('.node-down', 'click', (e) => { const i = Number(e.target.dataset.i); if (i < d.nodes.length - 1) { const [x] = d.nodes.splice(i, 1); d.nodes.splice(i + 1, 0, x); renderPlanEditor(); } });
  on('.node-del', 'click', (e) => { d.nodes.splice(Number(e.target.dataset.i), 1); renderPlanEditor(); });
  on('.node-ref-pick', 'change', () => { /* 仅记录选择，点按钮才加入 */ });
  on('.node-ref-btn', 'click', async (e) => {
    const i = Number(e.target.dataset.i);
    const sel = box.querySelector(`.node-ref-pick[data-i="${i}"]`);
    const role = d.nodes[i].role;
    // 读不到片段时**不能**当成"没有片段"去标缺口：先重试读取，由操作者决定。
    if (sel?.dataset.poolFailed === '1') {
      delete state.planRefPool?.[role];
      flash('重新读取该职能的片段…（读取失败时不要据此判断"没有素材"）', 'warn');
      renderPlanEditor();
      return;
    }
    if (!sel || sel.value === '') { flash('先在右侧选一个真实片段再点「加入参考」', 'warn'); return; }
    // 选项值用**下标**而不是"身份拼接串"：HTML 属性里不能放 NUL（会被解析成 U+FFFD），
    // 早期用 \u0000 分隔 entity_key/segment_id 的实现因此在真机上把两条身份粘成一条，服务端如实拒绝
    // invalid_reference_shape。改按下标取回候选对象，彻底避开分隔符问题。
    const list = state.planPickMap?.[i] ?? [];
    const it = list[Number(sel.value)];
    if (!it) { flash('这个选项已经失效（片段清单刷新过），请重新选择一次', 'warn'); return; }
    const n = d.nodes[i];
    if (n.references.some((r) => r.entity_key === it.entity_key && r.segment_id === it.segment_id)) { flash('这条片段已经在该节点里了', 'warn'); return; }
    n.references.push({ entity_key: it.entity_key, segment_id: it.segment_id });
    // 把**来源实际留存文本**记在草稿上（仅用于界面并排显示，不提交给服务端）：
    // 独立复审指出"创作文本可以先说一套、引用的是另一回事"，界面必须让两者并排可见，人才判断得了。
    state.planRefHint = state.planRefHint ?? {};
    state.planRefHint[`${it.entity_key}|${it.segment_id}`] = it.retained_text ?? null;
    renderPlanEditor();
  });
  on('[data-unref]', 'click', (e) => {
    const [i, ri] = e.target.dataset.unref.split(':').map(Number);
    d.nodes[i].references.splice(ri, 1);
    renderPlanEditor();
  });
  document.getElementById('plan-add-node')?.addEventListener('click', () => {
    d.nodes.push({ role: 'proof', intended_expression: '', spoken_copy_note: '', proposed_shot: '', missing_shot: false, missing_reason: '', references: [] });
    renderPlanEditor();
  });
  document.getElementById('plan-save')?.addEventListener('click', savePlanDraft);

  // 片段下拉：每个节点按自己的职能异步填充（拉不到就说明该职能没有片段——那正是要标缺口的情形）
  // ★ 第 61 轮 F61-04：每个节点另有**筛选框**（按素材标题 / 平台编号 / entity_key 子串，服务端筛），
  //   否则"刚检索并确认过的那条素材"不在前 200 条池子里时，拍计划根本引用不到它。
  state.planPickMap = {};
  const fillPool = (i, q = '') => {
    const sel = box.querySelector(`.node-ref-pick[data-i="${i}"]`);
    if (!sel || !document.body.contains(sel)) return;
    const role = d.nodes[i].role;
    state.planPickMap[i] = [];
    sel.dataset.filtered = q ? '1' : '';
    loadPlanRefPool(role, q).then((res) => {
      if (!document.body.contains(sel)) return;
      state.planPickMap[i] = [];
      if (!res.ok) {
        // 读取失败 ≠ 没有片段：明确说"现在不知道"，并让按钮变成重试。
        sel.dataset.poolFailed = '1';
        sel.innerHTML = `<option value="">读取失败（${esc(res.failed)}）—— 现在不知道这个职能有没有片段</option>`;
        const btn = box.querySelector(`.node-ref-btn[data-i="${i}"]`);
        if (btn) btn.textContent = '重试读取';
        return;
      }
      delete sel.dataset.poolFailed;
      if (!res.items.length) { sel.innerHTML = q ? '<option value="">这个筛选词下没有该职能的片段（换个词或清空筛选）</option>' : '<option value="">该职能确实没有留存片段（与 M3 同口径）→ 请如实标缺口</option>'; return; }
      const used = new Set(d.nodes[i].references.map((r) => `${r.entity_key}|${r.segment_id}`));
      const filtered = res.items.filter((it) => !used.has(`${it.entity_key}|${it.segment_id}`));
      state.planPickMap[i] = filtered;
      sel.innerHTML = '<option value="">选择该职能的真实片段…</option>' + filtered
        .map((it, k) => `<option value="${k}">${esc(it.source?.platform ?? '')} · ${esc(String(it.source?.native_id ?? ''))} · ${esc(it.time_label ?? '')}</option>`).join('');
    }).catch((e) => {
      sel.dataset.poolFailed = '1';
      sel.innerHTML = `<option value="">读取异常（${esc(String(e?.message ?? e).slice(0, 60))}）—— 现在不知道这个职能有没有片段</option>`;
    });
  };
  const timers = state.planRefQTimers = state.planRefQTimers ?? {};
  for (const sel of box.querySelectorAll('.node-ref-pick')) {
    const i = Number(sel.dataset.i);
    fillPool(i);
    const qBox = box.querySelector(`.node-ref-q[data-i="${i}"]`);
    qBox?.addEventListener('input', () => {
      clearTimeout(timers[i]);
      timers[i] = setTimeout(() => fillPool(i, String(qBox.value ?? '').trim()), 300);
    });
  }
  if (d.plan_id) renderPlanDetail(d.plan_id);
}

/** 计划详情：节点 + 现取的来源事实 + 缺口，与「素材→计划」反查。 */
async function renderPlanDetail(planId) {
  const box = document.getElementById('plan-detail');
  if (!box) return;
  const res = await readApiJson('/api/plan?id=' + encodeURIComponent(planId), { arrayField: 'nodes', requiredFields: ['plan_id', 'rev', 'node_count', 'reference_count', 'missing_shot_count'] });
  if (!res.ok) {
    box.innerHTML = `<div class="card" style="margin-top:10px"><h3>已保存内容</h3>${readFailedHtml('已保存内容', res.detail, 'plan-detail-retry')}</div>`;
    document.getElementById('plan-detail-retry')?.addEventListener('click', () => renderPlanDetail(planId));
    return;
  }
  const j = res.data;
  const nodeRows = (Array.isArray(j.nodes) ? j.nodes : []).filter((n) => n && typeof n === 'object').map((n) => {
    // 第八轮受影响复审指出：节点 `references: null` 时会同时显示「无参考」和「参考 1 条」——自相矛盾。
    // 非数组一律按"未返回"呈现，并与 reference_count 交叉核对，不一致就如实说明。
    const refsKnown = Array.isArray(n.references);
    const refs = (refsKnown ? n.references : []).map((r) => {
      const t = r.retained_text ?? {};
      const txt = [t.observed, t.onscreen_text, t.speech].filter(Boolean).join(' ／ ');
      return `<li>${esc(r.source_identity?.platform ?? '—')} · ${esc(String(r.source_identity?.native_id ?? '—'))} · ${esc(r.time_label ?? '—')}
      ${r.playable ? `<button type="button" class="btn seek-open" data-key="${esc(r.entity_key)}" data-t="${r.start_seconds ?? ''}">打开来源并定位</button>` : `<span class="tl-note">${r.availability === 'file_missing' ? '库里声明了路径但文件已不在，且没有云端可取数对象，不能播放' : '没有可取数的媒体（本机无文件、云端也未登记），不能播放'}</span>`}
      <div class="tl-note">来源实际留存文本：${txt ? esc(txt.slice(0, 200)) : '（该来源没有留存文本）'}</div></li>`;
    }).join('');
    return `<tr><td>第 ${n.position} 段</td><td>${esc(roleLabel(n.role))}</td>
      <td>${n.missing_shot ? `<span style="color:#b45309"><b>缺口</b>：${esc(n.missing_reason ?? '未写原因')}</span>` : (!refsKnown ? '<span style="color:#b45309">该节点的参考未返回（**不等于没有参考**）</span>' : (refs ? `<ul class="plan-reflist">${refs}</ul>` : '<span class="tl-note">无参考</span>'))}</td>
      <td class="lib-txt">${esc(n.intended_expression ?? '—')}</td>
      <td class="lib-txt">${esc(n.spoken_copy_note ?? '—')}${n.proposed_shot ? `<div class="tl-note">拟拍：${esc(n.proposed_shot)}</div>` : ''}</td></tr>`;
  }).join('');
  // 第十轮受影响复审：静默丢弃空节点却仍写"重新读取确认"是把"异常节点"当空。如实计数并写进标题。
  const rawNodeArr = Array.isArray(j.nodes) ? j.nodes : [];
  const badNodes = rawNodeArr.length - rawNodeArr.filter((n) => n && typeof n === 'object').length;
  box.innerHTML = `<div class="card" style="margin-top:10px"><h3>已保存内容（重新读取确认${badNodes ? `；**但返回体里有 ${badNodes} 个节点不是有效对象，已跳过**` : ''}）</h3>
    <div class="tl-note">${esc(j.separation ?? '')}</div>
    <table class="lib-table"><thead><tr><th>位置</th><th>职能</th><th>参考片段 / 缺口</th><th>想表达什么（创作）</th><th>口播 / 拟拍（创作）</th></tr></thead><tbody>${nodeRows}</tbody></table>
    <div class="tl-note">缺口 ${j.missing_shot_count} 个、参考 ${j.reference_count} 条、节点 ${j.node_count} 个。</div></div>
    <div id="plan-reverse"></div>`;
  for (const b of box.querySelectorAll('.seek-open')) b.addEventListener('click', () => openSourceAt(b.dataset.key, b.dataset.t));
  // 第九轮受影响复审指出：`nodes:[null]` 与 `references:false` 会在这里抛 `.map is not a function`。
  // 全部按"只处理对象、只处理数组"来写，未知一律不当成空。
  const safeNodes = (Array.isArray(j.nodes) ? j.nodes : []).filter((n) => n && typeof n === 'object');
  const keys = [...new Set(safeNodes.flatMap((n) => (Array.isArray(n.references) ? n.references.map((r) => r && r.entity_key).filter(Boolean) : [])))];
  const rev = document.getElementById('plan-reverse');
  if (rev && keys.length) {
    const parts = [];
    for (const k of keys) {
      const res = await readApiJson('/api/plans-by-material?entity_key=' + encodeURIComponent(k), { arrayField: 'plans', requiredFields: ['count'] });
      const line = !res.ok
        ? `读取失败（${esc(res.detail)}）—— **不知道**有没有计划引用它，请重试`
        : `被 <b>${res.data.count}</b> 份计划引用（${(res.data.plans ?? []).map((p) => esc(p.plan_id)).join('、') || '—'}）`;
      parts.push(`<li><code>${esc(String(k).split('|').slice(-2).join('|'))}</code> ${line}</li>`);
    }
    rev.innerHTML = `<div class="card" style="margin-top:10px"><h3>复用追溯（素材 → 计划）</h3><ul>${parts.join('')}</ul></div>`;
  }
}

async function renderMaterialPlanRefs(entityKey) {
  const box = document.getElementById('detail-plan-refs');
  if (!box || !entityKey) return;
  const res = await readApiJson('/api/plans-by-material?entity_key=' + encodeURIComponent(entityKey), { arrayField: 'plans', numberFields: ['count', 'reference_count'] });
  if (!document.getElementById('detail-plan-refs')) return; // 期间切换了素材
  if (!res.ok) { box.innerHTML = `<div class="card" style="margin-top:10px"><h3>被哪些拍摄计划引用</h3>${readFailedHtml('引用记录', res.detail)}</div>`; return; }
  const j = res.data;
  if (!j.count) { box.innerHTML = '<div class="card" style="margin-top:10px"><h3>被哪些拍摄计划引用</h3><div class="tl-note">目前没有拍摄计划引用这条素材。</div></div>'; return; }
  const rows = (j.plans ?? []).map((p) => `<tr><td><a class="plan-open" data-plan="${esc(p.plan_id)}" href="#">${esc(p.plan_id)}</a></td>
      <td>${esc(p.product_or_need)}</td>
      <td>${(p.nodes ?? []).map((n) => `第 ${n.position} 段（${esc(roleLabel(n.role))}）`).join('、')}</td></tr>`).join('');
  box.innerHTML = `<div class="card" style="margin-top:10px"><h3>被哪些拍摄计划引用（${j.count} 份 / ${j.reference_count} 处）</h3>
    <div class="tl-note">引用是"指向"而不是"复制"：同一片段可以被多份计划的多个节点引用，改一份计划不会改到别份。</div>
    <table class="lib-table"><thead><tr><th>计划</th><th>产品 / 需求</th><th>用在哪些节点</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  for (const a of box.querySelectorAll('.plan-open')) a.addEventListener('click', (e) => { e.preventDefault(); setView('plan'); openPlan(a.dataset.plan); });
}

async function savePlanDraft() {
  const d = state.planDraft;
  const fb = document.getElementById('plan-feedback');
  const btn = document.getElementById('plan-save');
  if (!d) return;
  // 第十三轮受影响复审（有业务后果）：**读取时**就已判定回包不完整（自报总数与实际读到的不符）→ 拒存。
  // 这个判定是**读取时冻结**的，所以用户之后主动删节点不会被误拦。
  if (d.loaded_ok === false) {
    if (fb) fb.innerHTML = `<b style="color:#b45309">不能保存：这份计划本次**没有完整读到**（${esc(d.loaded_detail ?? '')}）。</b>保存是整份替换，会把**没读到的部分当成被删除**。请先点「重试读取」。`;
    if (btn) { btn.disabled = false; btn.textContent = '保存计划'; }
    return;
  }
  // 第十一轮受影响复审（有业务后果，必须阻断）：回包里若**有节点不是有效对象**，编辑器会把它过滤掉，
  // 而保存是"整份替换"——于是用户没点删除，却会把那个节点连同它的引用**静默删掉**。
  // 这是把"没读到"写成了"删除"，直接破坏计划内容完整性。因此**该状态下禁止保存**。
  if (d.dropped_nodes) {
    if (fb) fb.innerHTML = `<b style="color:#b45309">不能保存：返回体里有 ${d.dropped_nodes} 个节点不是有效对象。</b>保存是整份替换，若此时保存会把那些**没读到的节点当成被删除**。请先点「重试读取」拿到完整计划再改。`;
    if (btn) { btn.disabled = false; btn.textContent = '保存计划'; }
    return;
  }
  // 第十二轮受影响复审（有业务后果）：回包里缺了某个创作字段时，早期实现兜成空串再整份替换 →
  // **用户没清空，原创作意图却被清空**。凡有缺失字段就**禁止保存**，先重试读取拿到完整内容。
  const missingPlanFields = d.unknown_fields ?? [];
  const missingNodeFields = (d.nodes ?? []).map((n, i) => ({ i, fields: n.unknown_fields ?? [] })).filter((x) => x.fields.length);
  if (missingPlanFields.length || missingNodeFields.length) {
    const where = [
      missingPlanFields.length ? `计划本身缺字段：${missingPlanFields.join('、')}` : '',
      ...missingNodeFields.map((x) => `第 ${x.i + 1} 个节点缺字段：${x.fields.join('、')}`),
    ].filter(Boolean).join('；');
    if (fb) fb.innerHTML = `<b style="color:#b45309">不能保存：${esc(where)}。</b>保存是整份替换，若此时保存会把**没读到的内容当成被清空**。请先点「重试读取」拿到完整计划再改。`;
    if (btn) { btn.disabled = false; btn.textContent = '保存计划'; }
    return;
  }
  // 第九轮受影响复审：参考"未返回"的节点**不允许保存**——否则会把未知写成"没有参考"。
  const unknownNodes = (d.nodes ?? []).filter((n) => n.references_unknown);
  if (unknownNodes.length) {
    if (fb) fb.innerHTML = `<b style="color:#b45309">不能保存：第 ${unknownNodes.map((_, i) => i + 1).join('、')} 个节点的参考状态"未返回"。</b>请重新打开计划（或点重试读取）拿到完整内容后再改。`;
    if (btn) { btn.disabled = false; btn.textContent = '保存计划'; }
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
  try {
    const body = {
      plan_id: d.plan_id, expected_rev: d.rev, product_or_need: d.product_or_need,
      communication_purpose: d.communication_purpose, human_note: d.human_note, status: d.status, operator: operatorName(),
      // 第十五轮受影响复审定下的结构性修法：把"我以为我读到的"逐字段回传，服务端与**库内当前值**比对。
      // 判据是库、不是回包，因此并发改动与"回包与库不一致"都会被拒绝，而不是把未知写进去。
      // 第十六轮补正：计划级字段与节点字段都要回传（缺一样就还能被绕过）。
      expected_plan: d.plan_id && state.planExpected ? state.planExpected.plan : undefined,
      expected_nodes: d.plan_id && state.planExpected ? state.planExpected.nodes : undefined,
      nodes: d.nodes.map((n) => ({
        role: n.role, intended_expression: n.intended_expression, spoken_copy_note: n.spoken_copy_note,
        proposed_shot: n.proposed_shot, missing_shot: n.missing_shot, missing_reason: n.missing_reason, references: n.references,
      })),
    };
    const r = await fetch('/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => null);
    if (!j) { if (fb) fb.innerHTML = `<b style="color:#b45309">保存响应无法解析（HTTP ${r.status}）：未确认是否写入，请重新打开计划核对</b>`; return; }
    if (r.status === 409 && j.error === 'stale_plan') {
      if (fb) fb.innerHTML = `<b style="color:#b45309">本次未写入任何内容：${esc(j.detail ?? '这份计划在别处被改过')}。页面将重新读取最新内容。</b>`;
      await openPlan(d.plan_id);
      return;
    }
    if (!r.ok) {
      const list = (j.errors ?? []).map((x) => `第 ${x.position} 段：${esc(x.error)}${x.detail ? `（${esc(x.detail)}）` : ''}`).join('；');
      if (fb) fb.innerHTML = `<b style="color:#b45309">未保存（${esc(j.error)}）</b>${list ? `：${list}` : ''}`;
      return;
    }
    state.planDraft = planDraftOf(j.plan);
    renderPlanEditor();
    renderPlans();
    await openPlan(j.plan_id);
    // 重新渲染会重建 #plan-feedback，所以成功提示要在重渲染**之后**写，否则会被冲掉（实测踩到过）。
    const okMsg = `已保存并重新读取确认：节点 ${j.node_count} 个、参考 ${j.reference_count} 条、缺口 ${j.missing_shot_count} 个（rev ${j.rev}）`;
    const fb2 = document.getElementById('plan-feedback');
    if (fb2) fb2.innerHTML = `<b style="color:#15803d">${esc(okMsg)}</b>`;
    flash(okMsg, 'ok');
  } catch (e) {
    if (fb) fb.innerHTML = `<b style="color:#b45309">保存异常：${esc(e.message)}</b>`;
  } finally {
    const b = document.getElementById('plan-save');
    if (b) { b.disabled = false; b.textContent = '保存计划'; }
  }
}

function showList() { setView('list'); renderList(); }

// 各平台配色（与原型一致；中文名与库内英文名都映射）
const PLAT_STYLE = {
  TikTok: ['#0f172a', '#334155'], Instagram: ['#7c2d12', '#c2410c'], 小红书: ['#7f1d1d', '#dc2626'],
  Xiaohongshu: ['#7f1d1d', '#dc2626'], 抖音: ['#0c1a2b', '#1e3a8a'], Douyin: ['#0c1a2b', '#1e3a8a'],
  快手: ['#7c2d12', '#ea580c'], Kuaishou: ['#7c2d12', '#ea580c'], 视频号: ['#14532d', '#16a34a'],
  'WeChat Channels': ['#14532d', '#16a34a'], B站: ['#0b2545', '#0ea5e9'], Bilibili: ['#0b2545', '#0ea5e9'],
  YouTube: ['#450a0a', '#b91c1c'],
};
const platStyle = (p) => PLAT_STYLE[p] ?? ['#334155', '#64748b'];

const SHORT_PLAT = { Xiaohongshu: '小红书', Douyin: '抖音', Kuaishou: '快手', 'WeChat Channels': '视频号', Bilibili: 'B站' };
const shortPlat = (p) => SHORT_PLAT[p] ?? p;

function reviewStatusTermOf(v) { return OPTION_TERMS.review_status[v] ?? '待人工复核'; }

function navLink(kind, value, label, n) {
  return `<a class="navitem" data-navfilter="${esc(kind)}" data-navvalue="${esc(value)}">${esc(label)} <span class="n">${n}</span></a>`;
}

function renderSidebar() {
  const items = state.items ?? [];
  const by = (f) => {
    const m = new Map();
    for (const i of items) { const k = f(i) || '（空）'; m.set(k, (m.get(k) ?? 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  };
  const st = state.facets ? Object.entries(state.facets.by_review ?? {}).map(([k, n]) => [reviewStatusTermOf(k), n]) : by((i) => i.review_status_term ?? '待人工复核');
  const pf = state.facets ? Object.entries(state.facets.by_platform ?? {}) : by((i) => i.platform);
  const gaps = state.tierSummary?.registered_gaps;
  const el = document.getElementById('nav-lib-n'); if (el) el.textContent = state.facets?.total ?? state.total ?? items.length;
  const gn = document.getElementById('nav-gaps-n'); if (gn) gn.textContent = gaps != null ? Number(gaps).toLocaleString('en-US') : '—';
  const s = document.getElementById('nav-status');
  if (s) s.innerHTML = st.map(([k, n]) => navLink('status', k, k, n)).join('') || '<span class="n">—</span>';
  const p = document.getElementById('nav-platform');
  if (p) p.innerHTML = pf.map(([k, n]) => navLink('platform', k, shortPlat(k), n)).join('') || '<span class="n">—</span>';
  // ★ 2026-10-13（Simon「可以 按你的建议」）：左侧补一行 **AI 标注进度**，与"待人工复核"分开写清——
  //   待人工复核＝人工队列（本链路从不写人工字段），AI 已标注＝本轮画面观测+打标的产出；两者是两条轴。
  const na = document.getElementById('nav-ai');
  if (na) {
    const a = state.aiScope;
    na.innerHTML = (a && typeof a.materials_total === 'number')
      ? `<span style="display:block;padding:2px 10px 6px;color:#8b93a1;font-size:12px;line-height:1.6">AI 已标注 <b style="color:#2f6f4f">${a.materials_generated}/${a.materials_total}</b> 条　·　分段 <b style="color:#2f6f4f">${a.segments_labelled}/${a.segments_total}</b><br><span style="color:#6b7280">（${esc(a.label ?? a.scope ?? '')}；人工复核状态见上方）</span></span>`
      : '<span style="display:block;padding:2px 10px 6px;color:#b45309;font-size:12px">AI 标注进度不可用（未读到 ai_scope，不等于 0）</span>';
  }
  for (const a of document.querySelectorAll('[data-navfilter]')) {
    a.addEventListener('click', () => {
      const kind = a.dataset.navfilter, val = a.dataset.navvalue;
      resetFilters();
      if (kind === 'status') {
        const hit = Object.entries(OPTION_TERMS.review_status).find(([, label]) => label === val);
        $('f-review').value = hit ? hit[0] : '';
      } else if (kind === 'platform') $('f-platform').value = val;
      setView('list');
      renderChips();
      reload(1);
    });
  }
}

// 缺口分区：数字来自 M3 只读筛选证据（服务端读文件，不查库、不改库）
async function renderGaps() {
  const box = document.getElementById('gaps-content');
  if (!box) return;
  const t = state.tierSummary;
  const res = await readApiJson('/api/gaps', { arrayField: 'reasons', requiredFields: ['source'] });
  const j = res.ok ? res.data : null;
  if (!res.ok) {
    box.innerHTML = `<div class="no-media"><b>缺口数字读取失败</b>（不是「没有缺口」）：${esc(res.detail)}<br>
      <span class="tl-note">缺口口径来自 M3 只读筛选证据文件；读不到时不显示任何数字。</span></div>`;
    return;
  }
  // 计数一律经 num()：**只有有限数字才算数**——null/undefined/`false`/字符串都写「—」，
  // 绝不走 Number(null)=0 / Number(false)=0（第七轮复审指出 `count:false` 仍被显示成 0）。
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Number(v).toLocaleString('en-US') : '—');
  // 第六轮受影响复审指出：`{"source":"x","reasons":[{"count":null}]}` 会显示成 **0**——把"没给这个数"说成"确实是 0"。
  // 计数一律经 num()（null/undefined → "—"），不再走 Number(null)=0。
  const rows = (j.reasons ?? []).map((x) => `<tr><td>${esc(x.reason)}</td><td><b>${num(x.count)}</b></td><td>${esc(x.platforms ?? '—')}</td><td>${esc(x.note ?? '—')}</td></tr>`).join('');
  box.innerHTML = `
    <div class="notice">这些记录不是「数据丢了」，而是<b>采集不到来源</b>或<b>信息量过低</b>。登记在这里，是为了让业务知道差额去哪了，
      而不是让素材列表看起来完整。<b>它们不进素材列表。</b></div>
    <div class="card">
      <h3>缺口构成（M3 只读筛选，未入库）</h3>
      <table><thead><tr><th>原因</th><th>条数</th><th>平台分布</th><th>说明</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="tl-note" style="margin-top:8px">来源：<code>${esc(j.source ?? '')}</code>（读于 ${esc(hhmmss(j.read_at))}）</div>
    </div>
    <div class="card" style="margin-top:10px">
      <h3>分档（建议入库口径）</h3>
      <table><thead><tr><th>档位</th><th>条数</th><th>含义</th></tr></thead><tbody>
        <tr><td>T1 有本地视频</td><td><b>${num(t?.t1_media)}</b></td><td>有本地视频文件，可直接播放与定位</td></tr>
        <tr><td>T2 证据充分</td><td><b>${num(t?.t2_strong)}</b></td><td>真实观测较多且有价值标签</td></tr>
        <tr><td>T3 标准证据</td><td><b>${num(t?.t3_standard)}</b></td><td>有标准证据（真实观测）</td></tr>
        <tr><td>T4 低信息量</td><td><b>${num(t?.t4_lowinfo)}</b></td><td>观测很少且无价值标签（建议缓入库）</td></tr>
        <tr><td>建议入库合计</td><td><b>${num(t?.recommended_import)}</b></td><td>T1+T2+T3</td></tr>
      </tbody></table>
      <div class="tl-note" style="margin-top:8px">当前库内行数见顶栏「全库素材行」；分档是<b>待入库清单</b>的口径，不是库内已有条数。</div>
    </div>`;
}

function renderHeader() {
  const s = state.summary ?? {};
  const c = s.counts ?? {};
  const sc = state.scopeCounts ?? {};
  // 读取未完成时**绝不显示 0**：0 会被读成「库里没有素材」，而实际只是还没读完（同「失败不得伪装成空」的既有口径）
  if (!state.loaded) {
    $('summary').innerHTML = '正在从 ' + storeName() + ' 读取素材列表…<span class="tl-note">（读取中，不代表 0 条）</span>';
    const ex0 = $('scope-explain');
    if (ex0) ex0.textContent = '读取中…';
    return;
  }
  const shown = state.total ?? (state.items ?? []).length;
  const total = state.total ?? (state.items ?? []).length;
  const loaded = (state.items ?? []).length;
  const gap = state.tierSummary;
  const gapTxt = gap
    ? `分档筛选（M3 只读）：建议入库 <b>${gap.recommended_import ?? '—'}</b> 条，已登记缺口 <b>${gap.registered_gaps ?? '—'}</b> 条；T4 低信息量 ${gap.t4_lowinfo ?? '—'} 条`
    : '分档结果不可用（未读到 M3 筛选证据）';
  $('summary').innerHTML =
    // ★ 2026-10-13（Simon）：默认作用域＝**有价值那批**；这里把口径写在标题上，避免"看着像 1,934 没同步"的误读。
    `${sc.scope === 'valuable' ? `工作范围 <b>有价值 ${total}</b> 条` : `工作范围 <b>全部可浏览 ${total}</b> 条`}　当前筛选 <b>${shown}</b> 条` + (loaded !== shown ? `　<span class="tl-note">（本页已载入 ${loaded} 条）</span>` : '')
    // ★ 2026-10-13（Simon：「前台面板只看 有价值的」）：**不再显示"不在本工作范围"的条数**（那是非有价值记录的数量）。
    + `　<span class="live-dot"></span>${storeName()} 读取于 <b>${hhmmss(s.read_at)}</b>`;
  const ex = $('scope-explain');
  if (ex) {
    // M2-F06：AI 状态按库里现算显示，杜绝"AI 还没开始"的错觉。
    const aiS = state.ai ?? null;
    // 第五轮受影响复审指出：AI 段的 machine_processing_failed 缺失时，这里会显示「处理失败 0 条」——
    // 把"读不到这个数"说成"确实是 0"。改为缺失即如实写"未返回"。
    // 第六轮受影响复审指出：整个 ai 段缺失时这里会抛异常（不能白屏）。按"没有 ai 段"如实降级。
    const aiFailed = (aiS && typeof aiS.materials_processing_failed === 'number') ? aiS.materials_processing_failed : null;
    const aiTxt = (aiS && typeof aiS === 'object')
      ? `　·　AI（M2）<b>${esc(aiS.status ?? '未返回')}</b>：已生成 <b>${typeof aiS.materials_generated === 'number' ? aiS.materials_generated : '未返回'}</b> 条`
        + (aiFailed === null ? '、处理失败 <span style="color:#b45309">未返回（不等于 0）</span>'
          : (aiFailed ? `、处理失败 <b style="color:#b91c1c">${aiFailed}</b> 条` : '、处理失败 0 条'))
        + `　·　分段标注 <b>${aiS.segments_labelled ?? '未返回'}/${aiS.segments_total ?? '未返回'}</b> 段；人工已决定 <b>${aiS.segments_human_decided ?? '未返回'}</b> 段`
      : '　·　AI 状态不可用（未读到 /api/summary 的 ai 段）';
    ex.innerHTML = `${gapTxt}　·　全库素材行 <b>${c.items ?? '—'}</b>（含建表占位行 ${c.placeholder_rows?.videos ?? '—'}）`
      + `　·　本页有视频资产（**按库存登记，未逐一核实本地文件**）<b>${(state.items ?? []).filter((i) => i.has_playable_media).length}</b> 条`
      + aiTxt;
  }
}

const TERM = (kind, v, fallback) => (state.terms?.[kind]?.[v]) ?? fallback ?? (v ?? '—');

function metricCell(m) {
  const mm = m ?? {};
  const na = mm.value === null || mm.value === undefined;
  return `<div><b class="${na ? 'na' : ''}">${esc(mm.display ?? '—')}</b><span>${esc(mm.label ?? '')}</span></div>`;
}

function cardTags(i) {
  // R-6：复核陈旧必须在列表上可见（证据变了但界面不提示 = 等于没做）。
  // N2 收尾：完全相同的标签只留一个；已被前面标签包含的也去掉（如分档「T1 有本地视频」已含「有本地视频」）。
  const raw = [];
  if (i.tier) raw.push([i.tier, 'tag tier']);
  if (i.has_playable_media) raw.push(['有视频资产', 'tag media']);
  if (i.segment_count) raw.push([`${i.segment_count} 个片段`, 'tag seg']);
  if (i.metrics_observed) raw.push([`${i.metrics_observed} 条关键数据`, 'tag']);
  if (i.note_present) raw.push(['有备注', 'tag']);
  if (i.source_state && i.source_state !== 'observed') raw.push([i.source_state_term ?? '来源异常', 'tag warn']);
  if (i.review_stale) raw.push(['复核已过期', 'tag warn']);
  const out = [];
  for (const [text, cls] of raw) {
    const t = String(text);
    if (out.some((o) => o.n === t || o.n.includes(t))) continue;
    out.push({ n: t, cls });
  }
  if (!out.length) out.push({ n: '暂无标签', cls: 'tag' });
  return out.map((o) => `<span class="${o.cls}">${esc(o.n)}</span>`).join('');
}

function fmtDurShort(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const s = Math.round(n);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function renderList() {
  const rows = filtered();
  state.shownCount = rows.length;
  const labels = state.keyMetricLabels.length ? state.keyMetricLabels : [{ field: 'engagement_play', label: '播放' }, { field: 'engagement_like', label: '点赞' }, { field: 'engagement_comment', label: '评论' }];
  const sortMode = $('f-sort')?.value ?? 'priority';
  $('list-meta').textContent = `库内可浏览 ${state.total ?? state.items.length} 条素材，本页已载入 ${state.items.length} 条（排序：${sortMode === 'priority' ? '行业优先级（分档→有本地视频→播放量）' : sortMode === 'play' ? '播放量高→低' : '发布时间新→旧'}）`;
  // M3-F06：标签词表外的取值服务端按 0 条处理（不忽略条件），界面必须说清「为什么是 0 条」，不能让人以为是没数据。
  const tf = state.tagFilter;
  if (tf && tf.known === false) {
    $('list-meta').textContent += `｜标签「${tf.requested}」不在固定词表内，服务端按 0 条处理（不忽略该条件）`;
  } else if (tf && tf.known) {
    $('list-meta').textContent += `｜标签口径：${tf.matched}`;
  }
  $('list').innerHTML = rows.map((i, idx) => {
    const dur = fmtDurShort(i.duration_seconds);
    const statusTerm = i.review_status_term ?? TERM('review_status', i.review_status, '待人工复核');
    const statusCls = /通过/.test(statusTerm) ? 'ok' : /排除/.test(statusTerm) ? 'bad' : /复核中/.test(statusTerm) ? 'mid' : 'todo';
    const [c1, c2] = platStyle(i.platform);
    return `<article class="mcard${state.selected === i.key ? ' active' : ''}${(state.picked ?? new Set()).has(i.key) ? ' picked' : ''}${state.focusIndex === idx ? ' focus' : ''}" data-key="${esc(i.key)}" data-idx="${idx}" tabindex="0">
      <label class="pick"><input type="checkbox" data-pick="${esc(i.key)}"${(state.picked ?? new Set()).has(i.key) ? ' checked' : ''} /></label>
      <div class="cover${i.has_playable_media ? ' has-media' : ''}${i.cover_url ? ' has-cover' : ''}" style="--c1:${c1};--c2:${c2}">
        ${i.cover_url
          ? `<img class="cover-img" src="${esc(i.cover_url)}" alt="封面" loading="lazy" onerror="this.style.display='none'">`
          : ''}
        <span class="plat">${esc(shortPlat(i.platform))}</span>
        ${dur ? `<span class="dur">${esc(dur)}</span>` : ''}
        ${i.cover_url
          ? `<span class="cover-src">${i.cover_source === 'platform' ? '平台封面' : '抽帧封面'}</span>`
          : `<span class="cover-note" title="${i.has_source_link ? '有来源链接，但平台侧取不到封面' : '本机没有这条的来源链接，也没有本地图像来源'}">${i.has_source_link ? '▤ 无封面（平台侧取不到）' : '▤ 无封面（无来源链接）'}</span>`}
      </div>
      <div class="badge ${statusCls}">${esc(statusTerm)}</div>
      ${i.valuable_state ? `<div class="vbadge ${i.valuable_selected ? 'v-yes' : (i.valuable_state === 'not_rankable' ? 'v-none' : 'v-no')}" title="${esc(i.valuable_selected ? `当前口径判为有价值：${i.valuable_metric === 'engagement_play' ? '播放量' : '互动总量'} ${i.valuable_score ?? '—'}，该平台第 ${i.valuable_rank ?? '—'}/${i.valuable_rankable ?? '—'} 名` : (i.valuable_state === 'not_rankable' ? '没有可比热度值（平台未报播放量，也没有互动计数），不参与排名' : '有热度值但不在该平台前 30%'))}">${i.valuable_selected ? `有价值 #${esc(String(i.valuable_rank ?? '—'))}` : (i.valuable_state === 'not_rankable' ? '不参与排名' : '未入选前30%')}</div>` : ''}
      <div class="cbody">
        <h4 title="${esc(i.title_basis ?? '')}">${esc(i.title)}</h4>
        <div class="csub">${esc(i.account ?? '账号未知')}${i.publish_epoch_s ? ' · ' + esc(fmtDate(i.publish_epoch_s)) : ''}${dur ? ' · ' + esc(dur) : ''}${i.segment_count ? ' · ' + i.segment_count + ' 个片段' : ''}</div>
        <div class="metrics">${labels.map((l) => metricCell(i.key_metrics?.[l.field])).join('')}</div>
        <div class="chips">${cardTags(i)}</div>
      </div>
    </article>`;
  }).join('') || `<div class="empty">没有符合条件的素材。
      <button id="empty-reset" type="button">清空筛选</button></div>`;
  for (const el of document.querySelectorAll('.mcard')) {
    el.addEventListener('click', (e) => {
      if (e.target && e.target.dataset && e.target.dataset.pick) return; // 复选框自己处理
      select(el.dataset.key);
    });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') select(el.dataset.key); });
  }
  for (const cb of document.querySelectorAll('[data-pick]')) {
    cb.addEventListener('change', () => {
      const k = cb.dataset.pick;
      if (!state.picked) state.picked = new Set();
      if (cb.checked) state.picked.add(k); else state.picked.delete(k);
      cb.closest('.mcard')?.classList.toggle('picked', cb.checked);
      renderBatchBar();
    });
  }
  renderBatchBar();
  $('empty-reset')?.addEventListener('click', () => resetFilters());
  const lm = $('load-more');
  if (lm) lm.classList.toggle('hidden', !state.hasMore);
  renderChips();
  renderHeader();
  renderSidebar();
}

// N2：筛选/排序/分页改由服务端（SQLite）执行；本函数保留为恒等，避免其它调用点失效。
function filtered() { return state.items; }

// 把筛选控件读成服务端查询串
function queryString(page = 1) {
  const p = new URLSearchParams();
  const set = (k, v) => { if (v !== null && v !== undefined && v !== '') p.set(k, v); };
  set('q', $('f-keyword').value.trim());
  set('platform', $('f-platform').value);
  set('review', $('f-review').value);
  set('source', $('f-source').value);
  set('tier', $('f-tier').value);
  // M3-F06（独立复审，中）：标签筛选必须进查询串，否则控件在、列表不变。
  set('tag', $('f-tag')?.value);
  set('date_from', $('f-date-from').value);
  set('date_to', $('f-date-to').value);
  if ($('f-media').checked) p.set('media', '1');
  if ($('f-segments').checked) p.set('segments', '1');
  if ($('f-note').checked) p.set('note', '1');
  // 同族缺陷一并修：日期未知复选框此前也只在界面上存在，未进查询串（服务端 /api/items?date_unknown=1 已实现）。
  if ($('f-date-unknown')?.checked) p.set('date_unknown', '1');
  const sort = $('f-sort')?.value ?? 'priority';
  p.set('sort', sort === 'play' ? 'play' : sort === 'publish' ? 'publish' : 'priority');
  p.set('page', String(page));
  p.set('size', String(state.pageSize ?? 60));
  return p.toString();
}

// 服务端重取（page=1 重新加载；page>1 追加）——查询串一律由 queryString() 生成，筛选条件不会丢
// R-10c：加请求序号。筛选/刷新/清除会并发发出多个 /api/items；没有序号时**先发后到的旧响应**
//        可以覆盖新筛选的结果（实测到过一次：筛成 1 条后按 Enter 打开的却是上一轮的条目）。
//        序号不匹配的结果直接丢弃，保证列表状态永远对应最后一次请求。
let listSeq = 0;
async function reload(page = 1) {
  const seq = ++listSeq;
  const res = await readApiJson('/api/items?' + queryString(page), { arrayField: 'items', numberFields: ['total'] });
  if (seq !== listSeq) return; // 已有更新的请求发出：丢弃这次结果，不覆盖界面
  if (!res.ok) { state.lastListError = res.detail; flash(`列表读取失败（${state.lastListError}）`, 'warn'); return; }
  const j = res.data;
  state.lastListError = null;
  state.items = page === 1 ? j.items : [...state.items, ...j.items];
  state.total = j.total;
  state.hasMore = Boolean(j.has_more);
  state.scopeCounts = j.scope_counts ?? null;
  state.tierSummary = j.tier_summary ?? state.tierSummary;
  // M3-F06：服务端回执里的 tag_filter（含 known:false）要在列表口径里如实显示，不能默默显示 0 条。
  state.tagFilter = j.tag_filter ?? null;
  state.dateUnknownFilter = j.date_unknown_filter ?? null;
  state.page = page;
  state.loaded = true;
  // R-10d：第 1 页换了一批条目时，把焦点夹回新列表范围（否则 Enter/1/2/3 会指向已不在列表里的下标）。
  if (page === 1) {
    const n = state.items.length;
    state.focusIndex = n === 0 ? -1 : (state.focusIndex < 0 ? state.focusIndex : Math.min(state.focusIndex, n - 1));
  }
  // R-10d-复审 修复：**先重绘，再去做任何 await**。此前是「赋值 state.items → await loadFacets() → renderList()」：
  // await 期间可见卡片还是旧的一批，而 Enter / keyboardMark 读的是 state.items[state.focusIndex]
  // ⇒ 键盘可能作用于操作者**当前没看到**的身份。现在把「state 变更 → 重绘」放在同一个同步块内；
  // facets 只重建下拉选项与侧栏计数（不改变条目集合），放在其后重建一次。
  renderList();
  if (page === 1) {
    await loadFacets();
    if (seq !== listSeq) return; // facets 期间可能又有新请求发出
    renderList();
  }
}

// R-10b：列表缓存单条同步。在详情里标记后，列表用的是打开详情时的旧快照，
// Esc 返回会显示旧状态（库里已变、界面没变）——必须把缓存改到与库一致，而不是重载整个列表
// （重载会把分页退回第 1 页，破坏「返回后继续当前工作」）。
function syncListItem(key, patch) {
  const it = (state.items ?? []).find((x) => x.key === key);
  if (!it) return false;
  Object.assign(it, patch);
  return true;
}

async function loadMore() { await reload((state.page ?? 1) + 1); }

// R-8 ① 修复：**平台选项一律由 /api/facets 的 by_platform（含计数）生成**，不再从首页已载入数据推断。
// 原因：首页 60 条只覆盖部分平台（实测只有 3 个），下拉一旦缺项，侧栏筛选就依赖了不完整的选项表。
function fillPlatformOptions() {
  const sel = $('f-platform');
  if (!sel) return false;
  const byp = state.facets?.by_platform ?? null;
  if (!byp || !Object.keys(byp).length) return false; // facet 读不到时保留现状，不拿“本页已载入”的平台去顶替
  const cur = sel.value;
  const pairs = Object.entries(byp).sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  sel.innerHTML = '<option value="">全部平台</option>' + pairs.map(([p, n]) => `<option value="${esc(p)}">${esc(shortPlat(p))}（${n}）</option>`).join('');
  sel.value = pairs.some(([p]) => p === cur) ? cur : '';
  return true;
}

// R-9：标签选项由 /api/facets 的 by_tag（含计数）生成；已选标签在重建后保留。
// M3-F06（独立复审，中）：此前重建版只留了 index.html 里的 <select id="f-tag">，没有填选项、没有进查询串、没有绑事件，
// 表现为「控件在、选了标签列表不变」的静默失效。此处恢复填选项；查询串与事件绑定见 queryString() 与 boot()。
function fillTagOptions() {
  const sel = $('f-tag');
  if (!sel) return false;
  const byt = state.facets?.by_tag ?? null;
  if (!byt || !Object.keys(byt).length) return false;
  const cur = sel.value;
  const names = state.facets?.tag_vocabulary ?? Object.keys(byt);
  sel.innerHTML = '<option value="">标签：全部</option>' + names.map((t) => `<option value="${esc(t)}">${esc(t)}（${Number(byt[t] ?? 0).toLocaleString('en-US')}）</option>`).join('');
  sel.value = names.includes(cur) ? cur : '';
  return true;
}

async function loadFacets() {
  const res = await readApiJson('/api/facets', { requiredFields: ['total', 'by_platform', 'by_tag', 'tag_vocabulary'] });
  if (!res.ok) return false;
  const j = res.data;
  state.facets = j; const okP = fillPlatformOptions(); const okT = fillTagOptions(); renderSidebar(); return okP || okT;
}

// P0：已生效条件显示成可点掉的 chip（业务不需要记住自己点过什么）
function renderChips() {
  const defs = [
    ['f-platform', '平台'], ['f-review', '状态'], ['f-source', '来源'], ['f-tier', '分档'], ['f-tag', '标签'],
  ];
  const out = [];
  for (const [id, name] of defs) {
    const el = $(id);
    if (el && el.value) out.push(`<span class="chip-x" data-clear="${id}">${name}：${esc(el.options[el.selectedIndex].text)} ✕</span>`);
  }
  for (const [id, name] of [['f-date-from', '从'], ['f-date-to', '到']]) {
    const el = $(id);
    if (el && el.value) out.push(`<span class="chip-x" data-clear="${id}">${name} ${esc(el.value)} ✕</span>`);
  }
  for (const [id, name] of [['f-media', '只看有本地视频'], ['f-segments', '只看有片段'], ['f-note', '只看有备注'], ['f-date-unknown', '日期未知']]) {
    const el = $(id);
    if (el && el.checked) out.push(`<span class="chip-x" data-clear="${id}">${name} ✕</span>`);
  }
  const kw = $('f-keyword').value.trim();
  if (kw) out.push(`<span class="chip-x" data-clear="f-keyword">搜索：${esc(kw)} ✕</span>`);
  $('chips').innerHTML = out.length ? out.join('') + '<span class="chip-x all" data-clear="__all__">全部清空</span>' : '';
  for (const el of document.querySelectorAll('#chips [data-clear]')) {
    el.addEventListener('click', () => {
      const id = el.dataset.clear;
      if (id === '__all__') return resetFilters();
      const f = $(id);
      if (!f) return;
      if (f.type === 'checkbox') f.checked = false;
      else if (f.tagName === 'SELECT') f.selectedIndex = 0;
      else f.value = '';
      // R-8 ③ 修复：移除 chip 后必须**带着剩余筛选条件重新查询**（以前只 renderList()，列表还是旧结果）
      reload(1);
    });
  }
}

function resetFilters() {
  for (const id of ['f-keyword', 'f-platform', 'f-review', 'f-source', 'f-tier', 'f-tag', 'f-date-from', 'f-date-to']) {
    const el = $(id); if (!el) continue;
    if (el.tagName === 'SELECT') el.selectedIndex = 0; else el.value = '';
  }
  for (const id of ['f-media', 'f-segments', 'f-note', 'f-date-unknown']) { const el = $(id); if (el) el.checked = false; }
  if ($('f-sort')) $('f-sort').value = 'priority';
  renderChips();
  reload(1);
}

async function refreshAll(reason) {
  await loadSummary();
  // R-8 ④ 修复：「刷新数据」必须**带着当前全部筛选条件**重新走服务端查询。
  // 以前这里请求无参 /api/items（无条件），一次刷新就把筛选结果换成了全量首页数据。
  // 现在统一走 reload(1) → queryString()（筛选状态的唯一来源），不再存在第二条列表读取路径。
  await reload(1);
  if (state.lastListError) {
    renderLoadError(`列表读取失败（${state.lastListError}）：刷新时未能从服务端取到素材列表`, null);
    return;
  }
  renderChips();
  const problems = [];
  // M3-F06：facet 读不到时平台与标签下拉只剩「全部」，必须在提示条上说明，否则用户会以为词表就是空的。
  if (!state.facets) problems.push('筛选口径（facet：平台/状态/标签计数）读取失败：平台与标签下拉选项不完整');
  const editsRes = await readApiJson('/api/edits', { arrayField: 'edits' });
  if (!editsRes.ok) problems.push(`审计列表读取失败（${editsRes.detail}）：本页“最近编辑”不完整`);
  const edits = editsRes.data;
  if (edits?.parse_failed) problems.push(`审计文件有 ${edits.parse_failed} 行无法解析（未计入列表）`);
  state.edits = edits?.edits ?? [];
  state.lastDetailError = null;
  if (state.selected) await select(state.selected, { keepScroll: true });
  // R12 三次复核修复：所有子步骤的问题**汇总后**再决定提示，成功提示不得覆盖失败提示。
  if (state.lastDetailError) problems.push(`详情读取失败：${state.lastDetailError}`);
  if (problems.length) flash(`刷新未完全成功 —— ${problems.join('；')}`, 'warn');
  else if (reason) flash(`已刷新（${reason}）`, 'ok');
}

function flash(msg, kind) {
  const el = $('flash');
  if (!el) return;
  el.textContent = msg;
  el.className = 'flash' + (kind ? ' ' + kind : '');
  el.style.display = 'block';
  clearTimeout(flash._t);
  flash._t = setTimeout(() => { el.style.display = 'none'; }, 6000);
}

async function select(key, opts = {}) {
  state.selected = key;
  renderList();
  setView('detail');
  const crumb = document.getElementById('detail-crumb');
  if (crumb) crumb.textContent = '读取中…';
  const dres = await readApiJson('/api/item?key=' + encodeURIComponent(key), { requiredFields: ['key'] });
  const d = dres.data;
  // R12 修复（复核发现）：必须检查 HTTP 状态；否则服务端 503 会被渲染成“没有媒体/没有指标”。
  if (!dres.ok) {
    renderLoadError(`详情读取失败（${dres.detail}）${d?.failed_tables ? ' 失败表：' + d.failed_tables.join('、') : ''}${d?.note ? '｜' + d.note : ''}`, key);
    return;
  }
  state.detail = d;
  state.saved = null;
  renderDetail();
  if (crumb) crumb.textContent = `${d.title ?? ''}（返回列表后筛选条件与滚动位置保留）`;
  const pane = document.querySelector('.detail');
  if (pane && !opts.keepScroll) pane.scrollTop = 0;
}

// 读取失败 ≠ 该素材没有内容：单独渲染，不复用“无媒体/无指标”的文案。
function renderLoadError(msg, key) {
  state.detail = null;
  state.lastDetailError = msg;
  const el = $('detail');
  if (el) {
    el.innerHTML = `<div class="no-media"><b>数据读取失败（不是“该素材没有内容”）</b><br>${esc(msg)}<br>
      <span class="tl-note">素材 ${esc(key ?? '')}；请确认 ${storeName()} 与面板服务在线后点右上角“刷新数据”。</span></div>`;
  }
  flash(`面板读取失败：${msg}`, 'warn');
}

// ---- 编辑控件 ----
// 回显值一律取“库里当前值”（human_fields），不用推断值，避免把已有内容当空值覆盖。
const TIER_LABEL_TO_KEY = { 'T1 有本地视频': 'T1_media', 'T2 证据充分': 'T2_strong', 'T3 标准证据': 'T3_standard', 'T4 低信息量': 'T4_lowinfo' };
const TIER_KEY_TO_LABEL = Object.fromEntries(Object.entries(TIER_LABEL_TO_KEY).map(([k, v]) => [v, k]));

function valueOf(field) {
  const raw = valueOfRaw(field);
  // R-3 修复：分档在接口与库内统一用稳定键（T1_media…），中文标签只在 OPTION_TERMS 里做显示。
  if (field === 'value_tier') return raw ?? null;
  // 布尔：库内是 0/1，控件用 true/false
  const fm = state.meta.get(field);
  if (fm?.type === 'boolean' && raw !== null && raw !== undefined) return raw === 1 || raw === true;
  return raw;
}

function valueOfRaw(field) {
  const hf = state.detail?.human_fields;
  if (hf && field in hf) return hf[field];
  const cl = state.detail?.classification;
  for (const c of CLASS_ITEMS) {
    if (field === c.key) return cl?.[c.key] ?? null;
    if (field === c.key + '_origin') return cl?.origins?.[c.key] ?? null;
    if (field === c.key + '_state') return cl?.states?.[c.key] ?? null;
  }
  return state.detail?.[field] ?? null;
}

function control(field) {
  const fm = state.meta.get(field) ?? { name: field, type: 'text', options: [] };
  const v = valueOf(field);
  const id = `ed-${field}`;
  if (fm.type === 'single_select') {
    // P0：下拉里显示业务词，写回仍是库内取值（选项值不变，只是标签业务化）
    const term = OPTION_TERMS[field] ?? {};
    const opts = ['<option value=""></option>'].concat(fm.options.map((o) => `<option value="${esc(o)}"${o === v ? ' selected' : ''}>${esc(term[o] ?? o)}</option>`));
    return `<select id="${id}" data-field="${esc(field)}">${opts.join('')}</select>`;
  }
  if (fm.type === 'long_text') return `<textarea id="${id}" data-field="${esc(field)}" rows="3" placeholder="人工备注（留空＝清空）">${esc(v ?? '')}</textarea>`;
  if (fm.type === 'date' && fm.date_include_time) return `<input id="${id}" data-field="${esc(field)}" type="datetime-local" step="1" value="${esc(String(v ?? '').slice(0, 19))}" title="按 UTC 显示与写回" />`;
  if (fm.type === 'date') return `<input id="${id}" data-field="${esc(field)}" type="date" value="${esc(String(v ?? '').slice(0, 10))}" />`;
  if (fm.type === 'boolean') return `<select id="${id}" data-field="${esc(field)}"><option value=""${v === null || v === undefined ? ' selected' : ''}></option><option value="true"${v === true ? ' selected' : ''}>是</option><option value="false"${v === false ? ' selected' : ''}>否</option></select>`;
  return `<input id="${id}" data-field="${esc(field)}" type="text" value="${esc(v ?? '')}" />`;
}

const CLASS_FIELDS = CLASS_ITEMS.flatMap((c) => [c.key, c.key + '_origin', c.key + '_state']);
function advancedFields() {
  const all = [...state.meta.keys()].filter((f) => !GROUP_REVIEW.includes(f) && !CLASS_FIELDS.includes(f));
  const preferred = ['review_stale', 'review_stale_reason', 'selected_reference'].filter((f) => all.includes(f));
  return preferred.concat(all.filter((f) => !preferred.includes(f)));
}

// P0：数据项与状态的业务词（只在详情的关键数据表里用；未知字段保持原样，不臆造译名）
const METRIC_FIELD_TERM = {
  engagement_play: '播放量', engagement_like: '点赞量', engagement_comment: '评论量',
  engagement_share: '分享量', engagement_collect: '收藏量', engagement_danmaku: '弹幕量',
  author_follower_count: '账号粉丝数', sales_quantity: '销量', product_price: '商品价格',
  duration: '时长', publication_time: '发布时间', media_type: '媒体类型', language: '语言',
  canonical_url: '原始链接', author_display_name: '账号名称', geography_or_region: '地区',
};
const METRIC_STATUS_TERM = {
  value: '有值', observed_zero: '观测到 0', absent: '未观测到', unusable: '不可用', unknown: '未知',
};

function renderDetail() {
  const d = state.detail;
  if (!d) return;
  const known = (s) => (s && !/^未知/.test(s) ? esc(s) : '<span style="color:#b45309">未知（来源未支持）</span>');
  const classic = CLASS_ITEMS.map((c) => `<tr>
      <td>${c.label}</td>
      <td>${known(d.classification?.[c.key])}</td>
      <td><span class="chip">${esc(d.classification?.origins?.[c.key] ?? '未知')}</span></td>
    </tr>`).join('');

  // ★ 第 63 轮 F63-01 + 第 64 轮 F64-01：播放器入口**只认服务端标为选中的那条资产**，
  //   且要求 `playable === true` 与**去空白后非空**的 `media_url`（此前会接受 `"   "`、也会在选中资产不可播时
  //   改挑另一条资产，等于绕过"只消费选中结论"的声明）。
  const sel0 = (d.assets ?? []).find((a) => a.selected) ?? null;
  const validUrl = (a) => typeof a?.media_url === 'string' && a.media_url.trim() !== '';
  const player0 = (sel0 && sel0.playable === true && validUrl(sel0)) ? sel0 : null;
  const unplayableReason = (() => {
    const a = sel0 ?? (d.assets ?? [])[0] ?? null;
    if (!a) return '没有资产记录';
    if (a.usable_as_video !== true) return '该资产在库里标为「不可作视频」（例如封面图）';
    if (a.cloud_unready_reason === 'cloud_key_blank' || a.cloud_unready_reason === 'cloud_bytes_not_positive') return `云端登记不完整（${a.cloud_unready_reason}）`;
    if (a.local_missing) return '库里声明了本机路径但文件已不在，且没有可用的云端副本';
    return '本机无文件、云端也未登记可用对象';
  })();
  const cloud0 = (sel0 && sel0.cloud_ready === true) ? sel0 : null;
  const localMissing0 = Boolean(player0 && player0.local_missing);
  const segs = d.segments ?? [];
  // 刻度按片段起点在总时长上的百分比定位（此前所有刻度重叠在同一位置，无法分别点击）
  const span = Math.max(
    Number(player0?.duration_seconds) || 0,
    Number(d.duration_seconds) || 0,
    ...segs.map((s) => Number(s.start_seconds) || 0),
    0.001,
  );
  // M6 三态（云上／仅本地／已失效）+ 该素材按当前口径是否有价值（口径文件：outputs/.../cloud-policy.json）
  const TRI = { cloud: ['云上', '#15803d'], stale: ['已失效(stale)', '#b91c1c'], local_only: ['仅本地', '#b45309'] };
  const tri0 = cloud0 ?? (d.assets ?? []).find((a) => a.usable_as_video === true) ?? null;
  const triKey = tri0?.cloud_tri_state ?? (tri0 ? 'local_only' : null);
  const triTag = triKey ? `<span style="color:${TRI[triKey][1]};font-weight:600">${TRI[triKey][0]}</span>` : '<span style="color:#6b7280">无资产</span>';
  const val = tri0?.value_decision ?? null;
  // 采集轮（2026-10-12）：**各平台热度前 30%** 是当前生效的"有价值"口径；
  // 旧口径（AI 角色/拍摄计划）对新采素材永远命中不了，所以两行都要如实显示，不能让页面自相矛盾。
  const vv = d.valuable ?? null;
  const shareTxt = esc(String(Math.round((vv?.share ?? 0.3) * 100)));
  const metricTxt = vv?.metric === 'engagement_play' ? '播放量' : '互动总量（点赞+评论+收藏+分享）';
  // ★ 复核 F12/F14 修复：三种状态分开说，且不再出现"系统按前 30% 传了视频，页面却写不算有价值"的自相矛盾。
  //   selected＝在平台前 30% 内（给出排名与依据）；rankable_but_not_selected＝有热度值但没进前 30%；
  //   not_rankable＝该素材**根本没有可比热度值**，不参与排名（先前被错写成"不在前 30%"）。
  const valuableLine = !vv
    ? '采集口径（各平台热度前 30%）：未运行判定（缺少 valuable-selection.json）'
    : vv.error
      ? `采集口径（各平台热度前 30%）：<b style="color:#b91c1c">判定文件读取失败</b>：${esc(vv.error)}`
      : vv.state === 'selected'
        ? `采集口径（各平台热度前 30%）：<b style="color:#15803d">判为有价值</b>　依据：${metricTxt} = ${esc(String(vv.score ?? '—'))}　该平台第 <b>${esc(String(vv.rank ?? '—'))}</b> / ${esc(String(vv.rankable ?? '—'))} 名（取前 ${shareTxt}%，共 ${esc(String(vv.quota ?? '—'))} 条）`
        : vv.state === 'not_rankable'
          ? `采集口径（各平台热度前 30%）：<b style="color:#6b7280">不参与排名</b>（该素材没有可比热度值：平台未报播放量，也没有互动计数）　⇒ <b>本轮采集不会为它上传视频</b>${triKey === 'cloud' ? '（页面显示的云端副本是**更早一轮**就存在的，不是本轮按此口径上传的）' : ''}`
          : `采集口径（各平台热度前 30%）：<b style="color:#6b7280">未入选</b>（有热度值，但不在该平台前 ${shareTxt}%；可排名 ${esc(String(vv.rankable ?? '—'))} 条，取前 ${esc(String(vv.quota ?? '—'))} 条）${triKey === 'cloud' ? '　（云端副本来自更早一轮，不是本轮按此口径上传的）' : ''}`;
  // 判定依据那次运行的时间/口径（避免"页面显示的是旧一次判定"这种看不出新旧的情况）
  const valuableMeta = vv
    ? `<div class="tl-note" style="color:#6b7280">判定文件：<code>valuable-selection.json</code>　判定时间 ${esc(vv.rule_at ?? '—')}　文件修改时间 ${esc(vv.selection_file_mtime ?? '—')}${vv.metric ? `　该平台口径：${metricTxt}` : ''}</div>`
    : '';
  // 抽帧秒数：只有"抽帧封面"才有；平台原生封面没有秒数（如实留空，不假装是抽帧）。
  const coverAt = d.cover_at_seconds;
  // 封面归属**素材**（不是某条资产）：平台原生封面所属素材往往没有视频资产，所以封面块必须在
  // "有媒体/无媒体"两个分支里都出现，否则这 100+ 条素材在面板里永远看不到封面（2026-10-11 修）。
  const COVER_LABEL = { platform: '平台原生封面', extracted_frame: '从本地视频抽帧' };
  const coverBlock = d.cover_url
    ? `<div class="tl-note">封面（<b>${esc(COVER_LABEL[d.cover_source] ?? '来源未标注')}</b>${d.cover_source === 'extracted_frame' && coverAt !== null && coverAt !== undefined ? `，第 ${esc(String(coverAt))} 秒` : ''}${d.cover_source === 'platform' ? '，非官方主图' : ''}）：<br><img src="${esc(d.cover_url)}" alt="封面" loading="lazy" style="max-width:180px;border-radius:6px;border:1px solid #e5e7eb"></div>`
    : '<div class="tl-note">封面：<b style="color:#b45309">缺封面</b>（本机与平台两侧都没取到该素材的图像来源；受限平台见「存量分析」页说明）。</div>';
  // ★ 复核 F12 修复：这行是**旧口径**（AI 角色/拍摄计划）。本轮上传用的是"各平台热度前 30%"，
  //   两行同时出现时必须写清谁说话算数，否则同一页会出现"历史口径说不算、采集口径说有"的矛盾。
  const OLD_RULE = '历史口径（AI 角色判定/拍摄计划，2026-10-11 之前）';
  const valLine = val
    ? `${OLD_RULE}：<b>${val.upload_video ? '算有价值（可上云）' : '不算（只留文字与封面）'}</b>　命中：${esc((val.reasons ?? []).join('、'))}　口径版本 ${esc(val.policy_id)}${val.policy_fallback ? '（⚠ 读不到口径文件，用了内置兜底）' : ''}${vv && !vv.error ? '　⇒ <b>本轮上传以采集口径为准</b>，这一行仅供历史对照。' : ''}`
    : `${OLD_RULE}：该素材无视频资产，不参与该口径的上传判定。`;

  const mediaBlock = player0
    ? `<video id="player" controls preload="metadata" src="${esc(player0.media_url)}"${cloud0 ? ` data-cloud-asset="${esc(cloud0.asset_id)}"` : ''}></video>
       <div class="timeline" id="timeline">${segs.map((g) => {
         const t = Number(g.start_seconds) || 0;
         const pct = Math.min(99.6, Math.max(0, (t / span) * 100));
         return `<div class="tick" data-t="${t}" style="left:${pct.toFixed(2)}%" title="${esc((g.t_label ?? '') + ' ' + t.toFixed(2) + 's')}"></div>`;
       }).join('')}</div>
       <div class="tl-note">时间轴刻度＝已拆解片段起点（点刻度或“定位”跳转）。片段 ${segs.length} 条，总时长 ${span.toFixed(2)} 秒。 <span id="media-state"></span></div>
       <div class="tl-note">云端状态：${triTag}　${valLine}</div>
       <div class="tl-note">${valuableLine}</div>
       ${valuableMeta}
       ${cloud0 ? `<div class="tl-note">云端副本：<b>${esc(cloud0.cloud.bucket)}</b> / ${esc(cloud0.cloud.key)}（${esc(String(cloud0.cloud.bytes ?? '—'))} 字节，已校验）。本机文件缺失时自动改从云端取短效链接。</div>` : ''}
       ${coverBlock}`
    : `<div class="no-media">该素材<b>没有可取数的媒体</b>：${esc(unplayableReason)}。这里不提供播放控件与定位按钮，也不以占位内容冒充。</div>
       <div class="tl-note">云端状态：${triTag}　${valLine}</div>
       <div class="tl-note">${valuableLine}</div>
       ${valuableMeta}
       ${coverBlock}`;

  // M2：AI 溯源（模型/时间/输入指纹/调用回执）与失败态——只看真实值，没有就写「无」。
  const ai = d.ai ?? {};
  // M2-F01：厂商失败必须显式区别于「未生成」。失败时给出原因与回执，操作者据此决定是否重跑。
  const aiFailure = ai.status === 'processing_failed'
    ? `<div class="no-media" style="border-color:#b91c1c;color:#b91c1c"><b>AI 处理失败（不是“未生成”）</b><br>${esc(ai.status_detail ?? '未记录原因')}<br><span class="tl-note">该素材已发起过调用但未取得可用产出；可重新发起。${ai.summary ? '下方摘要来自<b>更早一次成功调用</b>，本次未覆盖它。' : ''}</span></div>`
    : '';
  const aiProvenance = (() => {
    if (!ai.summary && !ai.structure_formula) {
      return ai.status === 'processing_failed'
        ? '<span class="tl-note">无产出（处理失败，原因见上方）</span>'
        : '<span class="tl-note">无（该记录没有 AI 输出）</span>';
    }
    const bits = [];
    if (ai.summary_model) bits.push(`模型 ${esc(ai.summary_model)}`);
    if (ai.summary_at) bits.push(`生成于 ${esc(String(ai.summary_at).slice(0, 19))}`);
    if (ai.summary_input_fingerprint) bits.push(`摘要输入指纹 ${esc(String(ai.summary_input_fingerprint).slice(0, 12))}…`);
    if (ai.labels_input_fingerprint) bits.push(`打标输入指纹 ${esc(String(ai.labels_input_fingerprint).slice(0, 12))}…`);
    if (ai.summary_receipt_ref) bits.push(`摘要回执 ${esc(String(ai.summary_receipt_ref).split('/').pop())}`);
    if (ai.labels_receipt_ref) bits.push(`打标回执 ${esc(String(ai.labels_receipt_ref).split('/').pop())}`);
    return bits.length ? bits.join(' · ') : '<span class="tl-note">无</span>';
  })();

  const segRows = segs.map((g) => {
    const body = [g.observed, g.onscreen_text ? `屏幕文字：${g.onscreen_text}` : '', g.speech ? `语音：${g.speech}` : ''].filter(Boolean).join('　|　');
    const short = esc(body.slice(0, 110));
    // M2：AI 建议（ai_role*）与人工决定（human_role*）分列展示，绝不合并成一列。
    const aiCell = g.ai_role
      ? `${esc(roleLabel(g.ai_role))}<div class="tl-note">${esc(String(g.ai_role_reason ?? '').slice(0, 90))}</div>`
      : '<span class="tl-note">未标注</span>';
    const humanCell = `<select class="seg-role" data-seg="${esc(g.segment_id)}" data-orig="${esc(g.human_role ?? '')}"><option value="">（未人工确认）</option>${SEG_ROLE_OPTS.map((v) => `<option value="${v}"${g.human_role === v ? ' selected' : ''}>${esc(roleLabel(v))}</option>`).join('')}</select>${g.human_role_at ? `<div class="tl-note">${esc(String(g.human_role_at).slice(0, 19))} ${esc(g.human_role_reviewer ?? '')}</div>` : ''}`;
    // R12 修复（复核发现）：来源文本只按**文本**处理；展开用 textContent，绝不走 innerHTML。
    return `<tr>
      <td>${esc(g.t_label ?? '')}</td>
      <td class="seg-text" data-full="${esc(body)}">${short}${body.length > 110 ? ' <span class="more">展开</span>' : ''}</td>
      <td>${esc(g.kind ?? '—')}<br><span class="chip">${esc(g.fact_origin ?? '')}</span></td>
      <td>${aiCell}</td>
      <td>${humanCell}</td>
      <td>${esc(g.coverage ?? '')}</td>
      <td>${g.start_seconds != null
        ? (player0 ? `<button class="seek" data-t="${g.start_seconds}">定位</button>` : '<span class="tl-note" title="该素材没有可取数的媒体，定位按钮不可用">不可定位</span>')
        : '—'}</td>
    </tr>`;
  }).join('');

  const metricRows = (d.metric_summary ?? []).slice(0, 24).map((m) => {
    // R12 修复（复核发现）：有值指标以前读 m.value（库里无此字段）→ 页面上显示成“—”；现用服务端算好的 display_value。
    const val = m.status === 'value'
      ? (m.display_value ? esc(m.display_value) : '<span class="chip warn">有值但缺可显示字段</span>')
      : `<span class="chip warn">${esc(METRIC_STATUS_TERM[m.status] ?? m.status ?? '—')}</span>`;
    const title = esc([m.metric_definition, m.metric_caveat, m.validation_rule ? '校验规则：' + m.validation_rule : ''].filter(Boolean).join(' ｜ '));
    return `<tr title="${title}"><td>${esc(METRIC_FIELD_TERM[m.field] ?? m.field)}</td><td>${val}</td><td>${m.observed_at_epoch_s ? fmtDate(m.observed_at_epoch_s) : '—'}</td></tr>`;
  }).join('');

  const reviewForm = GROUP_REVIEW.map((f) => `<div class="fld"><label for="ed-${f}">${labelOf(f)}</label>${control(f)}</div>`).join('');
  const classForm = CLASS_ITEMS.map((c) => `<div class="cls-row">
      <div class="fld"><label>${c.label}（人工值）</label>${control(c.key)}</div>
      <div class="fld"><label>来源</label>${control(c.key + '_origin')}</div>
      <div class="fld"><label>状态</label>${control(c.key + '_state')}</div>
    </div>`).join('');
  const advForm = advancedFields().map((f) => `<div class="fld"><label>${labelOf(f)}</label>${control(f)}</div>`).join('');

  const auditList = (state.edits ?? []).filter((e) => e.entity_key === d.key).slice(0, 5).map((e) => `<li><code>${hhmmss(e.at)}</code> ${esc(e.operator)} → ${esc(Object.keys(e.changed ?? {}).map((f) => labelOf(f)).join('、'))} <span class="chip ${e.result === 'confirmed' ? 'ok' : 'warn'}">${esc(RESULT_TERMS[e.result] ?? e.result)}</span></li>`).join('');

  const saved = state.saved;

  $('detail').innerHTML = `
    <div class="d-head">
      <div class="d-title">${esc(d.title ?? d.summary)}</div>
      <div class="d-sub">${esc(d.platform)} · ${esc(d.account ?? '账号未知')} · ${d.publish_epoch_s ? esc(fmtDate(d.publish_epoch_s)) : '日期未知'} · 素材编号 ${esc(d.short_key ?? d.key)}${d.tier ? ` · 分档 ${esc(d.tier)}` : ''} · 状态 ${esc(d.review_status_term ?? '—')}</div>
      <div class="chips">${(d.tags ?? []).map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>
      <div class="d-sub">标题依据：${esc(d.title_basis ?? '—')} · 读取于 ${hhmmss(d.read_at)}（${storeName()}·实时读取）· 行 ID ${d.row_id}</div>
    </div>
    <div class="grid2">
      <div>
        <div class="card"><h3>播放与片段</h3>${mediaBlock}</div>
        <div class="card" style="margin-top:10px"><h3>片段清单（${segs.length}）：来源事实 ｜ AI 建议 ｜ 人工决定</h3>
          ${segRows ? `<table><thead><tr><th>时间</th><th>内容（来源事实）</th><th>类型</th><th>AI 职能（建议）</th><th>人工职能（决定）</th><th>覆盖</th><th>播放</th></tr></thead><tbody>${segRows}</tbody></table>
            <div class="edit-actions"><button type="button" id="save-seg-roles">保存人工职能修改</button><span id="seg-role-result" class="tl-note" style="white-space:pre-line">${esc(state.segRoleFeedback ?? '')}</span></div>
            <div class="tl-note">人工决定与 AI 建议**分列存放**：人工修正只写人工列，重跑 AI 不会覆盖它；AI 建议也不会自动成为人工通过。</div>` : '<div class="tl-note">该素材无片段记录。</div>'}
        </div>
        <div class="card" style="margin-top:10px"><h3>结构公式 / AI 摘要（AI 建议，不是人工结论）</h3>${aiFailure}
          <dl class="kv">
            <dt>结构公式</dt><dd>${d.structure_formula ? esc(d.structure_formula) : '<span style="color:#b45309">未拆解（按已批准的顾小北五段：钩子 HOOK → 痛点 → 场景 → 证据 → CTA 行动号召）</span>'}</dd>
            <dt>AI 摘要</dt><dd>${d.ai_summary ? `<div class="ai-summary">${esc(d.ai_summary).replace(/\n/g, '<br>')}</div>` : (ai.status === 'processing_failed' ? '<span style="color:#b91c1c">未产出（处理失败，原因见上方；不代表“没做过”）</span>' : '<span style="color:#b45309">未生成（该记录不在七条可分析素材内，或没有可用的留存文本；不放假内容）</span>')}</dd>
            <dt>AI 溯源</dt><dd>${aiProvenance}</dd>
          </dl>
          <div class="tl-note">三层分开看：<b>来源事实</b>＝画面描述/屏幕文字/语音；<b>AI 建议</b>＝「AI 职能」列与本节；<b>人工决定</b>＝「人工职能」列与复核状态。<b>AI 建议不会自动成为人工通过</b>。五段是叙事职能（第三段＝场景）；卖点是独立的复用分类，不是五段之一。缺哪段就空哪段，不强行凑齐。</div>
        </div>
        <div class="card" style="margin-top:10px"><h3>关键数据（每个指标最新一次观测，前 24 项）</h3>
          ${metricRows ? `<table><thead><tr><th>数据项</th><th>值 / 状态</th><th>观测日</th></tr></thead><tbody>${metricRows}</tbody></table>` : '<div class="tl-note">该素材没有关键数据记录（不是 0，是没有观测）。</div>'}
        </div>
      </div>
      <div>
        <div class="card edit-card"><h3>人工复核（可直接修改并保存）</h3>
          <div class="edit-grid">${reviewForm}</div>
          <h4>人工分类（只覆盖人工值，来源/状态一起标注）</h4>
          ${classForm}
          <details><summary>其它人工字段（陈旧标记 / 参考）</summary><div class="edit-grid">${advForm}</div></details>
          <div class="edit-actions">
            <label class="op-label">操作人 <input id="ed-operator" type="text" value="${esc(operatorName())}" placeholder="例如 Simon" /></label>
            <button id="save" type="button" class="primary">保存修改</button>
            <button id="revert" type="button">放弃未保存修改</button>
            <span id="dirty" class="tl-note"></span>
          </div>
          <div id="save-result" class="save-result">${saved ? renderSaved(saved) : ''}</div>
          ${auditList ? `<div class="tl-note" style="margin-top:8px">本素材最近编辑：<ul class="audit">${auditList}</ul></div>` : ''}
        </div>
        <div class="card" style="margin-top:10px"><h3>身份与来源（采集所得，只读）</h3>
          <dl class="kv">
            <dt>平台</dt><dd>${esc(d.platform)}</dd>
            <dt>长 ID</dt><dd>${esc(d.native_id)}</dd>
            <dt>账号</dt><dd>${esc(d.account ?? '未知')}</dd>
            <dt>时长</dt><dd>${fmtDur(d.duration_seconds)}</dd>
            <dt>发布日期</dt><dd>${esc(d.publish_label ?? '')} ${fmtDate(d.publish_epoch_s)}</dd>
            <dt>来源状态</dt><dd>${esc(d.source_state_term ?? '来源待确认')}</dd>
            <dt>证据指纹</dt><dd>${esc((d.evidence_fingerprint ?? '').slice(0, 24) || '—')}</dd>
            <dt>保留路径</dt><dd>${esc(d.retained_path ?? '—')}</dd>
            <dt>媒体文件</dt><dd>${esc((d.assets ?? [])[0]?.local_path ?? '无')}</dd>
          </dl>
        </div>
        <div class="card" style="margin-top:10px"><h3>当前分类与复核状态</h3>
          <table><thead><tr><th>分类项</th><th>当前值</th><th>来源</th></tr></thead><tbody>${classic}</tbody></table>
          <div class="tl-note" style="margin-top:6px">复核状态：<b>${esc(d.review_status_term ?? '待人工复核')}</b>${d.review_reviewer ? ` · 复核人 ${esc(d.review_reviewer)}` : ''}${d.review_reviewed_at ? ` · ${esc(d.review_reviewed_at)}` : ''}</div>
        </div>
        <div class="card links" style="margin-top:10px">
          <h3>链接</h3>
          <a href="${esc(state.summary.base_url)}/database/${esc(String(state.summary.database_id))}/table/1354/${esc(String(d.row_id))}" target="_blank" rel="noreferrer">在 Baserow 中打开这一行</a>
          ${(d.assets ?? [])[0]?.viewer_url ? `<a href="${esc(d.assets[0].viewer_url)}" target="_blank" rel="noreferrer">外部媒体查看器</a>` : ''}
          <div class="tl-note" style="margin-top:6px">分类与复核这类“人工字段”在上面的编辑卡里改；采集字段（身份、指标、片段）只读。</div>
        </div>
      </div>
    </div>`;

  // R14-追加（浏览器实测发现，非自报）：`localMissing0` 原本只在 `renderDetail` 里用 `const` 声明，
  // 而这里（`bindDetail`，顶层函数）引用它 ⇒ 只要素材有本地视频就抛 `localMissing0 is not defined`，
  // **播放器之后的绑定全部中断**（人工字段监听、保存/撤销按钮、计划引用）——即"能播但不能存"。
  // 修法：由调用方显式传入（默认 false，不猜）。
  bindDetail({ localMissing0 });
}

function renderSaved(s) {
  if (!s) return '';
  const confirmed = s.result === 'confirmed';
  const badge = confirmed ? '<span class="chip ok">已确认</span>' : '<span class="chip warn">未确认</span>';
  const rows = Object.entries(s.confirmed_values ?? {}).map(([k, v]) => `<li><code>${esc(k)}</code> → ${esc(v === null || v === '' ? '（空）' : String(v))}</li>`).join('');
  const mis = (s.mismatches ?? []).length ? `<div class="no-media">与目标值不一致：${esc(JSON.stringify(s.mismatches))}</div>` : '';
  // R12 修复（复核发现）：服务端返回的 audit_written/audit_warning 必须被页面消费，不能在留痕失败时仍显示“已确认”。
  const auditBad = s.audit_written === false
    ? `<div class="no-media"><b>写入已发生，但审计行未能写入本地文件</b>（audit_written=false）：${esc(s.audit_warning ?? '请人工登记')}</div>`
    : `<div class="tl-note">审计：${esc(s.audit_path ?? '（未返回路径）')}（audit_written=${esc(String(s.audit_written ?? 'unknown'))}）</div>`;
  // M3 受影响复审（新发现 D）：`unconfirmed` 也是回执的一种，**不能一律写成“已重新读取确认”**——
  // 那正是在本项目反复出现的「没核实就下断言」。按服务端真实 result 分支措辞，未确认时给出读回值。
  const verdictTxt = confirmed
    ? '服务端已重新读取确认'
    : `<b style="color:#b45309">未确认（服务端返回 ${esc(String(s.result ?? 'unknown'))}），请以库内读回值为准，不要当成已保存</b>`;
  const readback = s.confirmed_values && Object.keys(s.confirmed_values).length ? '' : '（本次未返回读回值）';
  return `<div class="tl-note">保存结果：${badge} 写入行 ${esc(String(s.row_id))}，${verdictTxt}。${readback}${mis}</div>${auditBad}<ul class="audit">${rows}</ul>`;
}

// P0：下拉与状态标签的业务词（写回仍是库内取值，只改显示）
const OPTION_TERMS = {
  review_status: { unreviewed: '待人工复核', in_review: '复核中', reviewed: '通过', rejected: '排除' },
  product_category_state: { proposed: '待确认', reviewed: '已确认', rejected: '已否决' },
  product_function_state: { proposed: '待确认', reviewed: '已确认', rejected: '已否决' },
  scene_or_need_state: { proposed: '待确认', reviewed: '已确认', rejected: '已否决' },
  value_tier: TIER_KEY_TO_LABEL,
};
const RESULT_TERMS = { confirmed: '已确认', unconfirmed: '未确认', rejected: '被拒绝' };

function labelOf(f) {
  const map = {
    review_status: '复核状态', review_reviewer: '复核人', review_reviewed_at: '复核日期（UTC）', review_notes: '人工备注', review_value_categories: '价值分类',
    review_stale: '标记为陈旧', review_stale_reason: '陈旧原因', selected_reference: '选为参考样本',
    value_tier: '素材分档',
    review_status: '复核状态', review_reviewer: '复核人', review_reviewed_at: '复核日期（UTC）', review_notes: '人工备注', review_value_categories: '价值分类',
    product_category_origin: '产品类别 · 来源', product_function_origin: '产品功能 · 来源', scene_or_need_origin: '场景/需求 · 来源',
    product_category_state: '产品类别 · 状态', product_function_state: '产品功能 · 状态', scene_or_need_state: '场景/需求 · 状态',
  };
  return map[f] ?? f;
}

function bindDetail({ localMissing0 = false } = {}) {
  // M3-F04（独立复审，高）：`#save-seg-roles` 是**详情渲染时**才生成的，只在 boot() 里绑定会绑到
  // 当时并不存在的元素（复审实测点击处理器数为 0，导致界面里根本改不了人工职能）。
  // 每次详情渲染后由 bindDetail() 补绑；元素随 innerHTML 重建，不会重复叠加。
  $('save-seg-roles')?.addEventListener('click', saveSegmentRoles);
  // M4（MP-09）：素材也要看得到"自己被哪些拍摄计划引用"——反向追溯不能只做一半。
  const refHolder = document.createElement('div');
  refHolder.id = 'detail-plan-refs';
  document.getElementById('detail')?.appendChild(refHolder);
  renderMaterialPlanRefs(state.selected);
  const player = $('player');
  const seek = (t) => { if (!player) return; player.currentTime = Number(t) || 0; player.play().catch(() => {}); };
  for (const el of document.querySelectorAll('.tick')) el.addEventListener('click', () => seek(el.dataset.t));
  for (const el of document.querySelectorAll('.seek')) el.addEventListener('click', () => seek(el.dataset.t));
  for (const el of document.querySelectorAll('.seg-text .more')) el.addEventListener('click', () => { const td = el.closest('.seg-text'); td.textContent = td.dataset.full || ''; });
  if (player) {
    const note = $('media-state');
    // ★ 2026-10-14（Simon：「本地端打开这个视频都很慢」的处置之二）：
    //   云上独有的素材（本机没有文件）原先仍要走"先试本机 → 失败 → 直连 OSS（本机浏览器被网络层关闭，要等失败）
    //   → 最后才落到面板中转"这条**注定前两步都失败**的路，白等好几秒。这里**直接一步到位**用面板中转；
    //   有本地文件的素材保持原逻辑（先本机最快）。
    // ★ 第 62 轮 F62-01（阻断）：播放器的起点**就是服务端判定的选中资产地址**（`media_url`，两条路由都同源），
    //   不再"先用 mediaBase(8791) 拼本机地址、失败了再想办法"——那条路在本地媒体服务没跑时注定白等。
    const selAsset = (state.detail?.assets ?? []).find((a) => a.selected) ?? (state.detail?.assets ?? [])[0] ?? null;
    const selectedUrl = selAsset?.media_url ?? null;
    let triedCloud = false;
    let mediaSource = 'local';
    const noLocalCopy = !selAsset?.local_file;
    if (selectedUrl) {
      player.src = selectedUrl;
      player.load();
      mediaSource = selAsset?.delivery === 'cloud_relay' ? 'proxy' : 'local';
      if (note) {
        note.innerHTML = selAsset?.delivery === 'cloud_relay'
          ? '<b style="color:#b45309">本机没有可取数文件 ⇒ 直接走<b>云端副本（经本机面板中转）</b>，不再先试本机与浏览器直连。</b>'
          : '<b style="color:#b45309">本机文件存在 ⇒ 直接走<b>面板同源本机路由</b>（/media/asset/&lt;id&gt;）。</b>';
      }
    }
    const useCloud = (why) => {
      const assetId = player.dataset.cloudAsset;
      if (triedCloud || !assetId) {
        if (note && !assetId) note.innerHTML = `<b style="color:#b45309">媒体不可达：本机取不到，且该素材<b>没有登记云端副本</b>（${esc(why)}）。</b>`;
        return;
      }
      triedCloud = true;
      mediaSource = 'cloud_pending';
      if (note) note.innerHTML = '<b style="color:#b45309">本机取不到，正在改用云端短效链接…</b>';
      fetch(`/api/media-url?asset=${encodeURIComponent(assetId)}`)
        .then(async (r) => ({ ok: r.ok, status: r.status, j: await r.json().catch(() => ({})) }))
        .then(({ ok, status, j }) => {
          if (!ok || !j.url) throw new Error(`${j.error ?? 'media_url_failed'}${j.detail ? '：' + j.detail : ''}（HTTP ${status}）`);
          mediaSource = 'cloud';
          player.src = j.url;
          player.load();
          const mins = Math.max(1, Math.round((j.ttl_seconds ?? 900) / 60));
          if (note) note.innerHTML = `<b style="color:#b45309">已切到云端副本（${esc(j.bucket ?? '')}），等待播放确认…链接 ${mins} 分钟后失效，刷新页面会自动换新。</b>`;
        })
        .catch((e) => { mediaSource = 'cloud_failed'; if (note) note.innerHTML = `<b style="color:#b91c1c">云端也不可用：${esc(String(e.message ?? e))}</b>（本机原因：${esc(why)}）`; });
    };
    // 第三级：本机浏览器直连 OSS 被网络层关闭时（实测 `ERR_CONNECTION_CLOSED`），改由**本机面板中转**同一对象。
    const useProxy = () => {
      const assetId = player.dataset.cloudAsset;
      if (!assetId || mediaSource === 'proxy') return;
      mediaSource = 'proxy';
      if (note) note.innerHTML = '<b style="color:#b45309">直连云端失败，改为经本机面板中转…</b>';
      player.src = `/api/cloud-media?asset=${encodeURIComponent(assetId)}`;
      player.load();
    };
    // 复核修复（F06）：`loadedmetadata` 只证明"读到了元数据"，不等于"能播"。真正可播要等 `playing`（或时间真的前进）。
    const sourceLabel = () => (mediaSource === 'cloud' ? '云端副本（短效链接）' : mediaSource === 'proxy' ? '云端副本（经本机面板中转）' : mediaSource === 'local' || mediaSource === 'cloud_pending' ? '本机文件（面板同源路由 /media/asset/）' : '未知来源');
    player.addEventListener('loadedmetadata', () => {
      if (!note) return;
      const dur = Number.isFinite(player.duration) ? `，时长 ${player.duration.toFixed(2)} 秒` : '';
      note.innerHTML = `<b style="color:#b45309">已读取媒体信息（${esc(sourceLabel())}${dur}），等待播放确认…</b>`;
    });
    player.addEventListener('playing', () => {
      if (!note) return;
      if (mediaSource === 'cloud') note.innerHTML = '<b style="color:#15803d">媒体可播（来自云端副本，短效链接）</b>';
      else if (mediaSource === 'proxy') note.innerHTML = '<b style="color:#15803d">媒体可播（来自云端副本，经本机面板中转）</b>';
      else if (mediaSource === 'local' || mediaSource === 'cloud_pending') note.innerHTML = '<b style="color:#15803d">媒体可播（来自本机文件，面板同源路由 /media/asset/）</b>';
      else note.innerHTML = '<b style="color:#b45309">媒体已开始播放，但来源状态未确认</b>';
    });
    player.addEventListener('error', () => {
      // 复核修复（F02 第二轮）：浏览器是**先改 src 再抛 error**，判断只能看 mediaSource 状态，不能看"当前 src"。
      // 三级链路：本机(8791) → 云端签名直连 → 本机面板中转（直连被网络层关闭时的兜底）。
      if (!triedCloud && mediaSource === 'local') useCloud('本地媒体服务未启动或本地文件缺失（media --serve --port 8791）');
      else if (mediaSource === 'cloud') useProxy();
      else if (mediaSource === 'cloud_pending' && note) note.innerHTML = '<b style="color:#b45309">云端链接还在协商中被中断，稍后重试或刷新页面。</b>';
      else if (mediaSource === 'cloud_failed' && note) note.innerHTML = '<b style="color:#b91c1c">云端不可用</b>（签名未能取得，见上一条原因）。';
      else if (note) note.innerHTML = '<b style="color:#b91c1c">本机与云端中转都播放失败</b>（请确认面板进程仍在线）。';
    });
    // 本地文件已知缺失时不必等浏览器报错：直接走云端（少一次无谓失败）。
    if (localMissing0) useCloud('台账记录该素材本地文件已缺失');
  }
  for (const el of document.querySelectorAll('#detail [data-field]')) el.addEventListener('input', markDirty);
  for (const el of document.querySelectorAll('#detail [data-field]')) el.addEventListener('change', markDirty);
  $('save')?.addEventListener('click', save);
  $('revert')?.addEventListener('click', () => { state.saved = null; select(state.selected, { keepScroll: true }); });
}

function collect() {
  const out = {};
  for (const el of document.querySelectorAll('#detail [data-field]')) {
    const f = el.dataset.field;
    const fm = state.meta.get(f) ?? { type: 'text' };
    const orig = valueOf(f);
    // R-7 修复：单选/枚举的当前值**不在选项表内**（迁移后新增的合法值，界面无法回显）时，
    // 不得被当成“用户清空”而提交 null。
    // F-04 更正：这里必须限定「原值不在选项表内」。此前对所有「原值非空＋控件为空」的单选字段都跳过，
    // 结果用户**主动清空**一个正常枚举（如分类来源）会被静默丢弃——页面给了空选项、服务端也收 null，却永远写不进去。
    if (fm.type === 'single_select' && el.value === '' && orig !== null && orig !== undefined && orig !== ''
      && !(fm.options ?? []).includes(String(orig))) continue;
    let v;
    // R-2 修复：按类型互斥赋值——此前布尔值算完又被下面的 else 分支覆盖成字符串 'true'/'false'（服务端 400 / 读回不一致）
    if (fm.type === 'boolean') v = el.value === '' ? null : el.value === 'true';
    else if (f === 'value_tier') v = el.value === '' ? null : (TIER_LABEL_TO_KEY[el.value] ?? el.value);
    else if (fm.type === 'text' || fm.type === 'long_text') v = el.value.trim() === '' ? null : el.value.trim();
    else v = el.value === '' ? null : el.value;
    const norm = (x) => String(x ?? '').replace(' ', 'T').replace(/\.\d+/, '').replace(/Z$/, '').slice(0, 19);
    let same;
    if (fm.type === 'date') same = norm(orig) === norm(v);
    else if ((orig === null || orig === undefined || orig === '') && v === null) same = true;
    else if (typeof orig === 'boolean') same = orig === v;
    else same = String(orig ?? '') === String(v ?? '');
    if (!same) out[f] = v;
  }
  return out;
}

function markDirty() {
  const n = Object.keys(collect()).length;
  const el = $('dirty');
  if (el) el.innerHTML = n ? `有 <b>${n}</b> 个字段待保存` : '';
}

// R-6：并发前置条件——把「本次要改的字段在本页加载到的原值」一并提交，
// 服务端在同一事务内比对；不一致**整笔拒绝**（409 stale_write），不再静默后写覆盖。
function expectedOf(fields) {
  const out = {};
  for (const f of Object.keys(fields)) out[f] = valueOf(f);
  return out;
}

async function save() {
  const fields = collect();
  const names = Object.keys(fields);
  if (!names.length) { flash('没有需要保存的改动', 'warn'); return; }
  const btn = $('save');
  const saveProblems = []; // 函数级：任何失败/告警都汇总到这里，finally 统一出结论
  let outcome = null;      // 'ok' | 'warn'
  rememberOperator();
  btn.disabled = true; btn.textContent = '保存中…';
  try {
    const r = await fetch('/api/edit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: state.selected, operator: operatorName(), fields, expected: expectedOf(fields) }),
    });
    const j = await r.json().catch(() => null);
    if (!j) {
      // 响应不是 JSON：不能说“已保存”，也不能假设没写
      flash(`保存响应无法解析（HTTP ${r.status}）：**未确认是否写入**，请点“刷新数据”核对后再决定`, 'warn');
      state.saved = null;
      return;
    }
    if (!r.ok && j.error && !j.result) {
      // 未写入（被拒绝）：只提示，不假装成功。
      // R12 第 6 批复核 R6-3：被拒绝分支也必须保留“审计未落盘”告警，不能在提前返回时丢掉它。
      // R-6：并发冲突（409 stale_write）单独说清——本次一个字段都没写，库里的值已被别人改过。
      if (j.error === 'stale_write') {
        const line = (j.conflicts ?? []).map((c) => `${labelOf(c.field)}：本页读到 ${JSON.stringify(c.expected)}，库里已变成 ${JSON.stringify(c.actual)}`).join('；');
        flash(`本次未写入任何字段：库里的值在你打开详情之后被改过（${line}）。页面将重新读取最新值，请核对后再决定。`, 'warn');
        state.saved = null;
        await select(state.selected, { keepScroll: true });
        await reload(1);
        return;
      }
      const bits = [`保存失败：${j.error ?? r.status}${j.rejected ? '（' + j.rejected.join(',') + '）' : ''}${j.response ? ' ' + j.response : ''}`];
      if (j.audit_written === false) bits.push(`审计未落盘 —— ${j.audit_warning ?? '请人工登记'}`);
      flash(bits.join('；'), 'warn');
      state.saved = null;
      return;
    }
    // 已写入（200 确认 / 409 未确认）：无论哪种都重新读取，显示库里的真实值
    state.saved = j;
    // R12 四次复核修复：失败原因收集在**函数级**变量里，任何异常分支都不会丢掉已收集的告警，
    // 解析失败也要计入（此前 JSON 解析失败被吞成空对象 → 仍显示“已保存”）。
    saveProblems.length = 0;
    if (!r.ok) saveProblems.push(`读取确认不一致：${JSON.stringify(j.mismatches ?? []).slice(0, 200)}`);
    if (j.error) saveProblems.push(`服务端同时返回 error=${j.error}`);
    if (j.audit_written === false) saveProblems.push(`写入已发生但审计未落盘 —— ${j.audit_warning ?? '请人工登记'}`);
    // R12 修复（复核发现）：重新读取也必须检查状态，否则会拿一个 503 当详情渲染出去。
    const [dres, eres] = await Promise.all([
      readApiJson('/api/item?key=' + encodeURIComponent(state.selected), { requiredFields: ['key'] }),
      readApiJson('/api/edits', { arrayField: 'edits' }),
    ]);
    const d = dres.data; const e = eres.data;
    if (!eres.ok) saveProblems.push(`保存后审计列表读取失败（${eres.detail}）`);
    else if (e?.parse_failed) saveProblems.push(`保存后审计文件有 ${e.parse_failed} 行无法解析（未计入列表）`);
    if (!dres.ok) {
      renderLoadError(`保存后回读失败（${dres.detail}）；写入结果以服务端回执为准`, state.selected);
      return;
    }
    state.detail = d; state.edits = e?.edits ?? []; state.saved = j;
    renderDetail();
    await loadSummary();
    // R-8 ③ 同因修复：保存后的列表刷新也必须带当前筛选条件（以前请求无参 /api/items）
    await reload(1);
    if (state.lastListError) saveProblems.push(`保存后列表刷新失败（${state.lastListError}）`);
    outcome = saveProblems.length ? 'warn' : (j.result === 'confirmed' ? 'ok' : 'warn');
    return;
  } catch (e) {
    saveProblems.push(`保存过程异常：${e.message}`);
    outcome = 'warn';
  } finally {
    // R12 四次复核修复：统一在 finally 里出结论，确保任何分支都不丢告警
    const b = $('save'); if (b) { b.disabled = false; b.textContent = '保存修改'; }
    if (outcome === 'ok' && !saveProblems.length) flash('已保存，并经服务端重新读取确认', 'ok');
    else if (saveProblems.length) flash(`保存未完全成功 —— ${saveProblems.join('；')}`, 'warn');
    markDirty();
  }
}

function operatorName() {
  try {
    const el = document.getElementById('ed-operator');
    const fromEl = el && el.value ? el.value.trim() : '';
    if (fromEl) return fromEl;
    return localStorage.getItem('ml-operator') || 'panel';
  } catch { return 'panel'; }
}

function rememberOperator() {
  try {
    const el = $('ed-operator');
    if (el && el.value.trim()) localStorage.setItem('ml-operator', el.value.trim());
  } catch { /* 记录失败不影响保存 */ }
}

// R-10：键盘流。J/K 上下移动焦点、Enter 打开详情、1/2/3 标记（列表标记选中行／详情标记当前行）、Esc 返回。
// 标记走**真实接口**并读回确认；失败一律 warn，不假装成功。
async function keyboardMark(status) {
  const target = state.view === 'detail' ? state.selected : state.items[state.focusIndex]?.key;
  if (!target) return;
  const r = await fetch('/api/edit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entity_key: target, fields: { review_status: status }, operator: operatorName() }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.error) { flash(`标记失败（HTTP ${r.status}${j?.error ? ' / ' + j.error : ''}）`, 'warn'); return; }
  const term = OPTION_TERMS.review_status[status] ?? status;
  flash(`已标记「${term}」并读回确认（${j.result}）`, 'ok');
  // 注意：徽标文本来自 `review_status_term`（服务端词），只改 `review_status` 列表看起来仍是旧状态
  // ——实测踩到过，所以同步时必须把**显示词**一起改。
  const patch = { review_status: status, review_status_term: term };
  if (status === 'reviewed') patch.review_stale = false; // 复核落定会清掉陈旧标记（store 侧派生规则）
  if (state.view === 'detail') {
    await select(target, { keepScroll: true });
    if (syncListItem(target, patch)) renderList();
  } else {
    syncListItem(target, patch);
    renderList();
  }
}

function moveFocus(delta) {
  if (state.view !== 'list') return;
  const n = (state.items ?? []).length;
  if (!n) return;
  const cur = Number.isInteger(state.focusIndex) && state.focusIndex >= 0 ? state.focusIndex : 0;
  state.focusIndex = Math.min(Math.max(cur + delta, 0), n - 1);
  renderList();
  const el = document.querySelectorAll('#list .mcard')[state.focusIndex];
  if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
}

// ── N3：批量条与批量写入（逐条回报，失败不静默）──
function renderBatchBar() {
  const bar = $('batchbar');
  if (!bar) return;
  const n = (state.picked ?? new Set()).size;
  bar.classList.toggle('hidden', n === 0);
  const el = $('batch-n');
  if (el) el.textContent = String(n);
}

async function batchApply(target) {
  const keys = [...(state.picked ?? new Set())];
  if (!keys.length) return;
  const label = OPTION_TERMS.review_status[target] ?? target;
  const btn = document.querySelector(`#batchbar [data-batch="${target}"]`);
  if (btn) { btn.disabled = true; btn.textContent = '写入中…'; }
  try {
    const r = await fetch('/api/batch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys, fields: { review_status: target }, operator: operatorName() }),
    });
    const j = await r.json().catch(() => null);
    if (!j) { flash(`批量「${label}」失败：服务端返回无法解析（HTTP ${r.status}）`, 'warn'); return; }
    rememberOperator();
    if (j.error) { flash(`批量「${label}」被拒绝：${j.error}`, 'warn'); return; }
    const failed = typeof j.failed === 'number' ? j.failed : null;
    if (failed === null) {
      // 批量回执里没有 failed 字段：**不能**当成"0 条失败"（那是把"不知道"说成"全部成功"）。
      flash(`批量「${label}」回执缺少 failed 字段（HTTP ${r.status}）：**未确认逐条结果**，请点「刷新数据」核对后再决定`, 'warn');
      renderBatchBar();
      return;
    }
    if (failed) {
      // F-03 更正：条级失败必须**逐条完整可见、可核对、可重试**。
      // 此前只显示前 3 条、身份截断到 24 字符、随即清空选择、几秒后提示消失——
      // 超过 3 条失败时操作者无法从页面识别全部失败对象，不满足 MP-03 的「条级部分失败」要求。
      const failures = j.failures ?? [];
      renderBatchFailures(label, j, failures);
      flash(`批量「${label}」：成功 ${j.confirmed}/${j.requested} 条，**失败 ${failed} 条**（明细见下方清单，已保留这些选择以便重试）`, 'warn');
      // 只清掉已成功的身份，失败的身份留在选择里供重试
      const failedKeys = new Set(failures.map((x) => x.key));
      state.picked = new Set([...state.picked].filter((k) => failedKeys.has(k)));
    } else {
      clearBatchFailures();
      flash(`批量「${label}」：${j.confirmed}/${j.requested} 条已写入并读回确认`, 'ok');
      state.picked.clear();
    }
    renderBatchBar();
    await reload(1);
    await loadFacets();
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}

// F-03：批量失败的持久清单（不随提示自动消失；完整身份不截断；可复制）
function clearBatchFailures() {
  const box = $('batch-failures');
  if (box) { box.innerHTML = ''; box.classList.add('hidden'); }
}

function renderBatchFailures(label, j, failures) {
  const box = $('batch-failures');
  if (!box) return;
  const rows = failures.map((x) => `<tr><td class="mono">${esc(String(x.key))}</td><td>${esc(String(x.error ?? '未确认'))}</td></tr>`).join('');
  box.innerHTML = `<div class="bf-head">批量「${esc(label)}」未完成：成功 <b>${j.confirmed}</b>／未确认或失败 <b>${failures.length}</b>（共请求 ${j.requested}）</div>
    <table><thead><tr><th>素材身份（完整）</th><th>结果</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="bf-note">这些身份仍处于勾选状态，可直接重试；清单不会自动消失，点「关闭」清除。</div>
    <button type="button" id="batch-failures-close">关闭</button>`;
  box.classList.remove('hidden');
  $('batch-failures-close')?.addEventListener('click', clearBatchFailures);
}

async function boot() {
  $('refresh').addEventListener('click', () => refreshAll('手动刷新').catch((e) => flash('刷新失败：' + e.message, 'warn')));
  // 文本类用 input（边打字边筛），下拉/勾选/日期用 change（避免一次操作触发两次查询）
  for (const id of ['f-keyword']) { const el = $(id); if (el) el.addEventListener('input', () => { reload(1); }); }
  for (const id of ['f-platform', 'f-source', 'f-review', 'f-tier', 'f-tag', 'f-media', 'f-segments', 'f-note', 'f-date-from', 'f-date-to', 'f-date-unknown']) {
    const el = $(id);
    // R-10c（重建时漏项，本轮补回）：下拉/勾选/日期在 change 之后必须交还焦点。
    // 否则 keydown 里 `input,textarea,select` 的早退会继续生效 → J/K/Enter/1/2/3 静默失效，
    // 操作者必须再点一下空白处才能继续键盘分诊（实测：选完平台后按 J 无任何反应）。
    // 文本输入框（f-keyword）**不**模糊化——那里正是在打字。
    if (el) el.addEventListener('change', () => { reload(1); el.blur(); });
  }
  $('f-sort').addEventListener('change', (e) => { reload(1); e.target.blur(); });
  $('more-btn').addEventListener('click', () => {
    const m = $('more');
    m.classList.toggle('open');
    $('more-btn').textContent = m.classList.contains('open') ? '收起筛选 ▴' : '更多筛选 ▾';
  });
  $('f-reset').addEventListener('click', () => resetFilters());
  for (const b of document.querySelectorAll('#batchbar [data-batch]')) b.addEventListener('click', () => batchApply(b.dataset.batch));
  $('batch-clear')?.addEventListener('click', () => { state.picked = new Set(); renderList(); renderBatchBar(); });
  $('load-more')?.addEventListener('click', () => loadMore());
  // P0.5：返回列表 / Esc 返回；返回后筛选条件与滚动位置保留
  $('back-to-list')?.addEventListener('click', () => showList());
  $('save-seg-roles')?.addEventListener('click', saveSegmentRoles);
  $('back-from-gaps')?.addEventListener('click', () => showList());
  $('back-from-library')?.addEventListener('click', () => showList());
  $('back-from-structure')?.addEventListener('click', () => showList());
  document.getElementById('nav-lib')?.addEventListener('click', () => showList());
  document.getElementById('nav-gaps')?.addEventListener('click', () => setView('gaps'));
  document.getElementById('nav-library')?.addEventListener('click', () => setView('library'));
  document.getElementById('nav-structure')?.addEventListener('click', () => setView('structure'));
  document.getElementById('nav-plan')?.addEventListener('click', () => setView('plan'));
  document.getElementById('nav-analysis')?.addEventListener('click', () => setView('analysis'));
  $('back-from-plan')?.addEventListener('click', () => showList());
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = t && typeof t.matches === 'function' && t.matches('input,textarea,select');
    if (typing) { if (e.key === 'Escape') { t.blur(); showList(); } return; }
    if (e.key === 'Escape' && state.view !== 'list') { showList(); return; }
    // R-10 键盘流：j/k 移动焦点、Enter 打开、1/2/3 标记、Esc 返回
    if (e.key === 'j' || e.key === 'J') { moveFocus(1); return; }
    if (e.key === 'k' || e.key === 'K') { moveFocus(-1); return; }
    if (e.key === 'Enter') {
      const target = state.view === 'detail' ? state.selected : (state.items ?? [])[state.focusIndex]?.key;
      if (target) { e.preventDefault(); select(target).catch(() => {}); }
      return;
    }
    // M3-F05（独立复审，高）：快捷键必须与界面提示一致——index.html 写的是「2 排除、3 复核中」。
    if (e.key === '1') { e.preventDefault(); keyboardMark('reviewed').catch(() => {}); return; }
    if (e.key === '2') { e.preventDefault(); keyboardMark('rejected').catch(() => {}); return; }
    if (e.key === '3') { e.preventDefault(); keyboardMark('in_review').catch(() => {}); return; }
  });
  setView('list');
  await refreshAll();
  // R12 四次复核修复：元数据是否可用必须在**读取完成之后**判断，否则初始值 false 会在正常启动时误报警。
  if (!state.metaOk) flash('人工字段元数据读取失败，编辑控件可能不可用', 'warn');
  // 每 60 秒自动刷新一次“数据读取时间”，保证看到的是库里的值
  setInterval(() => { loadSummary().catch(() => {}); }, 60000);
}

boot().catch((e) => { $('detail').innerHTML = `<div class="no-media">面板加载失败：${esc(e.message)}</div>`; });
