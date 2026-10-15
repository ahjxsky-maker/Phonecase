// tools/material-library/store.mjs —— 自研存储层（单文件 SQLite，Node 内置 `node:sqlite`，不装第三方）。
// 依据：Simon 2026-10-08 19:2x 指令（存储采方案 A）与 panel-v3/NEXT-PLAN.md §1.2/1.3/1.4。
// 边界：只读写本机单文件；不联网；不含凭据；写人工字段走「事务 + 读回确认」；审计写入 edits 表。
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const STORE_SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);

CREATE TABLE IF NOT EXISTS materials (
  entity_key TEXT PRIMARY KEY,
  platform TEXT, platform_slug TEXT, namespace TEXT, branch TEXT, native_id TEXT, aid_branch INTEGER,
  canonical_url TEXT, derived_permalink TEXT,
  author_id TEXT, author_display_name TEXT, author_follower_count REAL,
  media_type TEXT, duration_seconds REAL, publish_date_epoch_s INTEGER, publish_date_label TEXT, language TEXT,
  product_category TEXT, product_function TEXT, scene_or_need TEXT,
  product_category_origin TEXT, product_function_origin TEXT, scene_or_need_origin TEXT,
  product_category_state TEXT, product_function_state TEXT, scene_or_need_state TEXT,
  product_category_reviewer TEXT, product_function_reviewer TEXT, scene_or_need_reviewer TEXT,
  product_category_evidence_ref TEXT, product_function_evidence_ref TEXT, scene_or_need_evidence_ref TEXT,
  review_status TEXT, review_reviewer TEXT, review_reviewed_at TEXT, review_notes TEXT,
  review_value_categories TEXT, selected_reference INTEGER, review_stale INTEGER, review_stale_reason TEXT, human_note TEXT,
  review_based_on_fingerprint TEXT,
  value_tier TEXT, title TEXT, cover_url TEXT,
  entity_source_state TEXT, join_reason_class TEXT, identity_confidence TEXT, provenance_class TEXT, decision TEXT,
  retained_path TEXT, evidence_fingerprint TEXT, metrics_observed INTEGER, value_labels_json TEXT, availability_json TEXT,
  ai_summary TEXT, ai_summary_at TEXT, ai_summary_model TEXT, ai_summary_cost_usd REAL,
  structure_formula TEXT,
  migrated_from TEXT, migrated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_mat_platform ON materials(platform);
CREATE INDEX IF NOT EXISTS idx_mat_review ON materials(review_status);
CREATE INDEX IF NOT EXISTS idx_mat_tier ON materials(value_tier);
CREATE INDEX IF NOT EXISTS idx_mat_src ON materials(entity_source_state);
CREATE INDEX IF NOT EXISTS idx_mat_pub ON materials(publish_date_epoch_s);

CREATE TABLE IF NOT EXISTS metrics (
  entity_key TEXT NOT NULL, field TEXT NOT NULL, status TEXT,
  numeric_value REAL, value_text TEXT, unit TEXT, observed_at_epoch_s INTEGER,
  metric_definition TEXT, metric_caveat TEXT, validation_rule TEXT, fact_origin TEXT,
  comparable_across_platforms INTEGER, error_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_met_key_field ON metrics(entity_key, field);
CREATE INDEX IF NOT EXISTS idx_met_field ON metrics(field);

CREATE TABLE IF NOT EXISTS segments (
  entity_key TEXT NOT NULL, segment_id TEXT, asset_id TEXT,
  t_label TEXT, start_seconds REAL, end_seconds REAL, observed TEXT, onscreen_text TEXT, speech TEXT,
  kind TEXT, fact_origin TEXT, coverage TEXT, human_note TEXT, review_status TEXT
);
CREATE INDEX IF NOT EXISTS idx_seg_key ON segments(entity_key);

CREATE TABLE IF NOT EXISTS assets (
  entity_key TEXT NOT NULL, asset_id TEXT, media_kind TEXT, usable_as_video INTEGER,
  local_path TEXT, bytes INTEGER, duration_seconds REAL, sha256 TEXT, cohort TEXT, path_source TEXT
);
CREATE INDEX IF NOT EXISTS idx_ast_key ON assets(entity_key);

CREATE TABLE IF NOT EXISTS ratios (
  entity_key TEXT NOT NULL, key TEXT, status TEXT, value REAL, unit TEXT, observation_group TEXT, operands_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_rat_key ON ratios(entity_key);

CREATE TABLE IF NOT EXISTS edits (
  at TEXT, entity_key TEXT, operator TEXT, changed_json TEXT, result TEXT, row_id TEXT, source TEXT
);
CREATE INDEX IF NOT EXISTS idx_ed_key ON edits(entity_key);

CREATE TABLE IF NOT EXISTS gaps (
  entity_key TEXT PRIMARY KEY, reason TEXT, platform TEXT, detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_gap_reason ON gaps(reason);

CREATE TABLE IF NOT EXISTS tiers (
  tier TEXT PRIMARY KEY, records INTEGER, by_platform_json TEXT, note TEXT
);
`;

const nowIso = () => new Date().toISOString();

export function openStore({ dbPath, mustExist = true }) {
  if (mustExist && !fs.existsSync(dbPath)) throw new Error(`store_missing:${dbPath}`);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  if (!mustExist) db.exec(SCHEMA_SQL);
  db.exec('PRAGMA busy_timeout = 5000');
  ensureSchemaUpgrades(db);
  return db;
}

/**
 * R-6：增量列升级（幂等）。已存在的库不会重跑 SCHEMA_SQL，新列必须显式补。
 * 只做 ADD COLUMN（不改已有列、不删数据），失败即抛出，不静默跳过。
 *
 * M2 增补：分段 AI 标注表 `segment_labels`。
 *   AI 标注与**人工修正分列**存放（ai_role_* / human_role_*），AI 永远不会覆盖人工决定，
 *   人工修正也不会被重新生成覆盖——这是 MP-05「AI 建议绝不自动成为人工通过」的结构性保证。
 */
export function ensureSchemaUpgrades(db) {
  const have = new Set(db.prepare('PRAGMA table_info(materials)').all().map((r) => r.name));
  const added = [];
  const addCol = (name, ddl) => { if (!have.has(name)) { db.exec(`ALTER TABLE materials ADD COLUMN ${name} ${ddl}`); added.push(name); } };
  addCol('review_based_on_fingerprint', 'TEXT');
  // M2 溯源列（迁移不写，属「库里独有」）
  addCol('ai_input_fingerprint', 'TEXT');
  addCol('ai_receipt_ref', 'TEXT');
  addCol('ai_labels_input_fingerprint', 'TEXT');
  addCol('ai_labels_receipt_ref', 'TEXT');
  // M2-F01（独立复审）：把「未生成 / 已生成 / 处理失败」在数据层面分开，
  // 否则一次厂商失败会显示成「未生成」，操作者无法区分"没做"和"做了但失败"。
  addCol('ai_status', 'TEXT');
  addCol('ai_status_detail', 'TEXT');
  db.exec(`CREATE TABLE IF NOT EXISTS segment_labels (
    entity_key TEXT NOT NULL,
    segment_id TEXT NOT NULL,
    ai_role TEXT,
    ai_role_reason TEXT,
    ai_role_model TEXT,
    ai_role_at TEXT,
    ai_input_fingerprint TEXT,
    ai_receipt_ref TEXT,
    human_role TEXT,
    human_role_reviewer TEXT,
    human_role_at TEXT,
    human_role_note TEXT,
    PRIMARY KEY (entity_key, segment_id)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_seglab_role ON segment_labels(ai_role)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_seglab_human ON segment_labels(human_role)');
  // AI-only 模式（Simon 2026-10-10）：把"这一段已按 AI 模式判定并入库"独立记下来。
  // **刻意不动 human_role**：AI 判断不冒充人工结论；生效职能仍是 COALESCE(human_role, ai_role)，
  // 这里记的是"这批 AI 判断已被执行端正式确认为当前入库口径"（含时间与操作人，便于追溯与将来被人工覆盖）。
  const labCols = new Set(db.prepare('PRAGMA table_info(segment_labels)').all().map((r) => r.name));
  for (const [name, ddl] of [['ai_mode_decided', 'INTEGER DEFAULT 0'], ['ai_mode_decided_at', 'TEXT'], ['ai_mode_operator', 'TEXT']]) {
    if (!labCols.has(name)) { db.exec(`ALTER TABLE segment_labels ADD COLUMN ${name} ${ddl}`); added.push(`segment_labels.${name}`); }
  }

  // ── M4（MP-08／MP-09）：拍摄计划与引用追溯 ─────────────────────────────────────────────
  // 设计要点（都是判据直接要求的）：
  //   * **创作与事实分开**：计划里的"想表达什么／拟口播／拟拍画面"是**人工新写**的创作建议，只存在
  //     plan_nodes 的 *_expression/*_note/proposed_shot 列；引用只存**身份**（entity_key + segment_id），
  //     时间点与留存文本一律在读取时从 segments 现取——来源事实永远只有一份。
  //   * **缺口不是素材**：missing_shot=1 的节点按结构写入校验**不得带任何引用**，且界面/接口一律以
  //     "缺口"呈现，绝不把它显示成"已有素材"。
  //   * **一份计划一行归属**：引用按 (plan_id, position, ref_index) 独立存行，改一份计划不触碰别份。
  db.exec(`CREATE TABLE IF NOT EXISTS plans (
    plan_id TEXT PRIMARY KEY,
    product_or_need TEXT NOT NULL,
    communication_purpose TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    operator TEXT,
    human_note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    rev INTEGER NOT NULL DEFAULT 1
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS plan_nodes (
    plan_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    role TEXT NOT NULL,
    intended_expression TEXT,
    spoken_copy_note TEXT,
    proposed_shot TEXT,
    missing_shot INTEGER NOT NULL DEFAULT 0,
    missing_reason TEXT,
    PRIMARY KEY (plan_id, position)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS plan_references (
    plan_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    ref_index INTEGER NOT NULL,
    entity_key TEXT NOT NULL,
    segment_id TEXT NOT NULL,
    PRIMARY KEY (plan_id, position, ref_index)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_plan_ref_key ON plan_references(entity_key)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_plan_ref_seg ON plan_references(entity_key, segment_id)');

  // ── M6（云存储，Simon 2026-10-10 批复）：素材文件的云端位置登记 ─────────────────────────
  // 设计要点：
  //   * **本地台账仍是唯一主库**：云只存文件；这里只记"云端在哪、多大、指纹是什么、状态如何"。
  //   * **状态不是布尔**：local_only / uploaded / archived / deleted 分开，避免"已删除"被读成"没有上传过"。
  //   * 幂等：同 cloud_key + 同 cloud_etag 不重复上传（由上传脚本据此判断）。
  const astCols = new Set(db.prepare('PRAGMA table_info(assets)').all().map((r) => r.name));
  for (const [name, ddl] of [
    ['cloud_provider', 'TEXT'],
    ['cloud_bucket', 'TEXT'],
    ['cloud_region', 'TEXT'],
    ['cloud_key', 'TEXT'],
    ['cloud_etag', 'TEXT'],
    ['cloud_bytes', 'INTEGER'],
    ['cloud_uploaded_at', 'TEXT'],
    ['cloud_state', 'TEXT'],
  ]) {
    if (!astCols.has(name)) { db.exec(`ALTER TABLE assets ADD COLUMN ${name} ${ddl}`); added.push(`assets.${name}`); }
  }
  return { added };
}

/** M2：把某条素材的分段 AI 标注与素材级摘要一起读出来（人工决定与 AI 建议分开返回）。 */
export function aiStateOf(db, entityKey) {
  const mat = db.prepare(`SELECT ai_summary, ai_summary_at, ai_summary_model, ai_input_fingerprint, ai_receipt_ref,
    ai_labels_receipt_ref, ai_labels_input_fingerprint, structure_formula, ai_status, ai_status_detail
    FROM materials WHERE entity_key = ?`).get(entityKey) ?? {};
  const labels = db.prepare('SELECT * FROM segment_labels WHERE entity_key = ? ORDER BY segment_id').all(entityKey);
  // M2R-F01（第二轮独立复审）：状态必须是**全函数**——库里 8,635 条从未被 AI 处理过的行
  // `ai_status` 是 NULL，原先直接返回 null，接口对"未生成"给不出答案，而 /api/summary 又把
  // 同一批行算成 not_generated，两处口径不一致。这里统一：NULL 且无任何 AI 产出 → not_generated；
  // NULL 但有 AI 产出（历史遗留）→ status_unknown_legacy（如实说明，不猜）。
  const hasAiContent = Boolean(mat.ai_summary) || labels.some((r) => r.ai_role !== null);
  const aiStatus = mat.ai_status ?? (hasAiContent ? 'status_unknown_legacy' : 'not_generated');
  return {
    ai_status: aiStatus,
    ai_status_detail: mat.ai_status_detail ?? (aiStatus === 'not_generated' ? '该素材不在 M2 的七条可分析素材内，未发起过 AI 调用（不等于调用失败）。' : null),
    ai_summary: mat.ai_summary ?? null,
    ai_summary_at: mat.ai_summary_at ?? null,
    ai_summary_model: mat.ai_summary_model ?? null,
    ai_input_fingerprint: mat.ai_input_fingerprint ?? null,
    ai_receipt_ref: mat.ai_receipt_ref ?? null,
    ai_labels_receipt_ref: mat.ai_labels_receipt_ref ?? null,
    ai_labels_input_fingerprint: mat.ai_labels_input_fingerprint ?? null,
    structure_formula: mat.structure_formula ?? null,
    segments: labels.map((r) => ({
      segment_id: r.segment_id,
      ai_role: r.ai_role, ai_role_reason: r.ai_role_reason, ai_role_model: r.ai_role_model, ai_role_at: r.ai_role_at,
      ai_input_fingerprint: r.ai_input_fingerprint, ai_receipt_ref: r.ai_receipt_ref,
      human_role: r.human_role, human_role_reviewer: r.human_role_reviewer, human_role_at: r.human_role_at, human_role_note: r.human_role_note,
    })),
  };
}

/**
 * M2-F06（独立复审）：`/api/summary` 原先硬编码 `no_ai_calls_yet: true`，与库里已有的 7 条摘要、
 * 84 条分段标注矛盾——面板顶部会显示"AI 尚未开始"，操作者据此会重跑已完成的活。这里改为**从库里现算**。
 * 只读聚合，不写库；三态（generated / processing_failed / not_generated）分别计数，不合并。
 */
export function aiSummary(db) {
  // M2R2-F01（第三轮独立复审）：聚合口径必须与 aiStateOf 的**同一个推导**一致。
  // 原先这里用 IFNULL(ai_status,'not_generated')，而详情函数对"NULL 但有 AI 产出"给
  // status_unknown_legacy —— 同一批行两处会显示不同状态。现在两侧同规则。
  const by = Object.fromEntries(db.prepare(`
    SELECT CASE
      WHEN m.ai_status IS NOT NULL THEN m.ai_status
      WHEN COALESCE(m.ai_summary,'') <> ''
        OR EXISTS (SELECT 1 FROM segment_labels l WHERE l.entity_key = m.entity_key AND l.ai_role IS NOT NULL)
        THEN 'status_unknown_legacy'
      ELSE 'not_generated' END AS s, COUNT(*) AS n
    FROM materials m GROUP BY s`).all().map((r) => [r.s, r.n]));
  const segTotal = db.prepare('SELECT COUNT(*) AS n FROM segment_labels').get().n;
  const labelled = db.prepare('SELECT COUNT(*) AS n FROM segment_labels WHERE ai_role IS NOT NULL').get().n;
  const humanDecided = db.prepare('SELECT COUNT(*) AS n FROM segment_labels WHERE human_role IS NOT NULL').get().n;
  const receipts = db.prepare(`SELECT COUNT(DISTINCT r) AS n FROM (
      SELECT ai_receipt_ref AS r FROM materials WHERE ai_receipt_ref IS NOT NULL
      UNION SELECT ai_labels_receipt_ref FROM materials WHERE ai_labels_receipt_ref IS NOT NULL
      UNION SELECT ai_receipt_ref FROM segment_labels WHERE ai_receipt_ref IS NOT NULL
    )`).get().n;
  const roleTally = Object.fromEntries(db.prepare(
    `SELECT IFNULL(ai_role, '(未标注)') AS r, COUNT(*) AS n FROM segment_labels GROUP BY r ORDER BY n DESC`).all().map((r) => [r.r, r.n]));
  const failed = db.prepare(`SELECT entity_key, ai_status_detail FROM materials
    WHERE ai_status = 'processing_failed' ORDER BY entity_key`).all();
  const generated = by.generated ?? 0;
  return {
    // 面板会拼成「AI（M2）<b>状态</b>」，所以这里不再重复 "M2" 前缀。
    status: receipts > 0 ? (generated > 0 ? '已执行' : '已发起但未产出') : '未开始',
    materials_generated: generated,
    materials_processing_failed: by.processing_failed ?? 0,
    materials_not_generated: by.not_generated ?? 0,
    // 与详情函数同一推导：NULL 但有 AI 产出的历史遗留行单独列出，不混进 not_generated。
    materials_status_unknown_legacy: by.status_unknown_legacy ?? 0,
    by_status: by,
    segments_total: segTotal, segments_labelled: labelled, segments_human_decided: humanDecided,
    distinct_receipts: receipts,
    by_role: roleTally,
    failures: failed.map((r) => ({ entity_key: r.entity_key, detail: r.ai_status_detail })),
    last_ai_at: db.prepare('SELECT MAX(ai_summary_at) AS t FROM materials').get().t ?? null,
    note: 'AI 建议列（ai_role_*）与人工决定列（human_role_*）分列存放，互不覆盖；此处计数只反映库内现状。',
  };
}

/** R-6：证据变化 → 复核陈旧。与已退役 Baserow 路径（baserow.mjs 重放）同口径：evidence_changed:<旧>-><新>。 */
export const EVIDENCE_STALE_PREFIX = 'evidence_changed:';

/**
 * 把「复核时依据的证据指纹」与「当前证据指纹」不一致的已复核行标成陈旧。
 * 只处理 basis 非空的已复核行；basis 为空（该特性上线前复核的）保持未知，不臆造。
 * R-6 修正：这是对人工决策字段的状态变更，必须**落审计**（operator=system:evidence-reconcile）。
 *   否则库里的值与"最后一次审计写入"不一致，迁移脚本自带的 r5_audit_values_match_db 检查会（正确地）判 FAIL——
 *   已退役 Baserow 路径的做法同样是把它记成一次带 changed 的更新。
 */
export function reconcileStaleReviews(db) {
  // 幂等条件：只处理**尚未**标陈旧的已复核行。否则每次调用都会为同一个条件重复写审计行
  // （实测：同一库上第二次调用原本会再标一次，changed=1，属重复动作）。
  // 证据再次变化时该行已经是 stale=1，不会重复标记；详情页仍会通过 evidence_changed 与实际指纹显示差异。
  const pending = db.prepare(`SELECT entity_key, review_based_on_fingerprint AS based, IFNULL(evidence_fingerprint,'') AS now
    FROM materials
    WHERE review_status = 'reviewed'
      AND IFNULL(review_stale, 0) <> 1
      AND review_based_on_fingerprint IS NOT NULL AND review_based_on_fingerprint <> ''
      AND IFNULL(evidence_fingerprint,'') <> review_based_on_fingerprint`).all();
  if (!pending.length) return { at: nowIso(), changed: 0, keys: [] };
  const at = nowIso();
  const upd = db.prepare('UPDATE materials SET review_stale = 1, review_stale_reason = ? WHERE entity_key = ?');
  const insEdit = db.prepare('INSERT INTO edits (at, entity_key, operator, changed_json, result, row_id, source) VALUES (?,?,?,?,?,?,?)');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const r of pending) {
      const reason = `${EVIDENCE_STALE_PREFIX}${r.based}->${r.now}`;
      upd.run(reason, r.entity_key);
      insEdit.run(at, r.entity_key, 'system:evidence-reconcile', JSON.stringify({ review_stale: 1, review_stale_reason: reason }), 'confirmed', r.entity_key, 'store-reconcile');
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 回滚失败也如实抛出 */ }
    throw e;
  }
  return { at, changed: pending.length, keys: pending.map((r) => r.entity_key) };
}

export function storeMeta(db) {
  const get = (k) => { const r = db.prepare('SELECT v FROM meta WHERE k = ?').get(k); return r ? r.v : null; };
  return {
    schema_version: Number(get('schema_version') ?? 0),
    migrated_at: get('migrated_at'),
    migration_source: get('migration_source'),
    corpus_records: Number(get('corpus_records') ?? 0),
  };
}

export function storeStats(db) {
  const one = (sql) => db.prepare(sql).get();
  return {
    materials: one('SELECT COUNT(*) AS n FROM materials').n,
    segments: one('SELECT COUNT(*) AS n FROM segments').n,
    metrics: one('SELECT COUNT(*) AS n FROM metrics').n,
    ratios: one('SELECT COUNT(*) AS n FROM ratios').n,
    assets: one('SELECT COUNT(*) AS n FROM assets').n,
    gaps: one('SELECT COUNT(*) AS n FROM gaps').n,
    edits: one('SELECT COUNT(*) AS n FROM edits').n,
    playable_media: one('SELECT COUNT(*) AS n FROM materials WHERE EXISTS (SELECT 1 FROM assets a WHERE a.entity_key = materials.entity_key AND a.usable_as_video = 1)').n,
    with_metrics: one('SELECT COUNT(*) AS n FROM materials WHERE metrics_observed > 0').n,
    tiers: Object.fromEntries(db.prepare('SELECT tier, records FROM tiers').all().map((r) => [r.tier, r.records])),
    by_platform: Object.fromEntries(db.prepare('SELECT platform, COUNT(*) AS n FROM materials GROUP BY platform ORDER BY n DESC').all().map((r) => [r.platform, r.n])),
    by_review: Object.fromEntries(db.prepare("SELECT COALESCE(review_status,'unreviewed') AS s, COUNT(*) AS n FROM materials GROUP BY s").all().map((r) => [r.s, r.n])),
    by_source_state: Object.fromEntries(db.prepare('SELECT COALESCE(entity_source_state,\'(空)\') AS s, COUNT(*) AS n FROM materials GROUP BY s').all().map((r) => [r.s, r.n])),
  };
}

export const KEY_METRIC_FIELDS = ['engagement_play', 'engagement_like', 'engagement_comment'];

/** 每个身份 3 个关键数字：取该字段最新一条「真实观测」（value / observed_zero）。 */
export function keyMetricsFor(db, entityKey, fields = KEY_METRIC_FIELDS) {
  const out = {};
  for (const f of fields) {
    const row = db.prepare(`SELECT status, numeric_value, value_text, unit, observed_at_epoch_s FROM metrics
       WHERE entity_key = ? AND field = ? AND status IN ('value','observed_zero')
       ORDER BY CAST(observed_at_epoch_s AS INTEGER) DESC LIMIT 1`).get(entityKey, f);
    let value = null;
    if (row) {
      const n = row.numeric_value === null || row.numeric_value === undefined ? Number(String(row.value_text ?? '').trim()) : Number(row.numeric_value);
      value = Number.isFinite(n) ? n : null;
    }
    out[f] = { field: f, value, display: value === null ? '—' : (Math.abs(value) >= 100000 ? `${(value / 10000).toFixed(1).replace(/\.0$/, '')}万` : String(value)),
      status: row?.status ?? null, observed_at_epoch_s: row ? Number(row.observed_at_epoch_s) : null };
  }
  return out;
}

/** 批量取关键数字（全表一次查询，避免 N+1）。 */
export function keyMetricsBulk(db, fields = KEY_METRIC_FIELDS) {
  const inList = fields.map(() => '?').join(',');
  const rows = db.prepare(`SELECT entity_key, field, status, numeric_value, value_text, observed_at_epoch_s FROM metrics
     WHERE field IN (${inList}) AND status IN ('value','observed_zero')`).all(...fields);
  const latest = new Map();
  for (const r of rows) {
    const at = Number(r.observed_at_epoch_s) || 0;
    const k = `${r.entity_key}\u0000${r.field}`;
    const prev = latest.get(k);
    if (!prev || at >= (Number(prev.observed_at_epoch_s) || 0)) latest.set(k, r);
  }
  const out = new Map();
  for (const [k, r] of latest) {
    const [key, field] = k.split('\u0000');
    if (!out.has(key)) out.set(key, {});
    const n = r.numeric_value === null || r.numeric_value === undefined ? Number(String(r.value_text ?? '').trim()) : Number(r.numeric_value);
    const value = Number.isFinite(n) ? n : null;
    out.get(key)[field] = { field, value, display: value === null ? '—' : (Math.abs(value) >= 100000 ? `${(value / 10000).toFixed(1).replace(/\.0$/, '')}万` : String(value)), status: r.status, observed_at_epoch_s: Number(r.observed_at_epoch_s) };
  }
  return out;
}

/**
 * 人工字段写入：事务内 UPDATE → 读回 → 一致才算 confirmed；同时写审计行。
 * R-6 增补：
 *   · `expected`（可选）＝调用方上次读到的值。在**同一个 BEGIN IMMEDIATE 事务内**比对，
 *     不一致则整笔拒绝（stale_write，不写任何字段），并落一条 rejected_stale_write 审计行——
 *     同字段并发不再是「后写静默覆盖」，而是可观察、可审计的冲突。
 *   · 复核落定（review_status='reviewed'）时把当前证据指纹快照进 review_based_on_fingerprint，
 *     并在调用方未显式给 review_stale 时清掉陈旧标记（人已重新确认）；证据再变时由
 *     reconcileStaleReviews() 标回陈旧。
 */
export function updateHumanFields(db, { entityKey, fields, allowedFields, operator, expected = null }) {
  const names = Object.keys(fields);
  const rejected = names.filter((n) => !allowedFields.includes(n));
  if (rejected.length) return { ok: false, error: 'field_not_writable', rejected };
  const row = db.prepare('SELECT entity_key, evidence_fingerprint FROM materials WHERE entity_key = ?').get(entityKey);
  if (!row) return { ok: false, error: 'row_not_found' };
  if (!names.length) return { ok: false, error: 'empty_write_intent' };
  const expNames = expected ? Object.keys(expected) : [];
  if (expected && !expNames.length) return { ok: false, error: 'empty_precondition', detail: 'expected 给了但没有任何字段' };
  const at = nowIso();
  // 读回比较用与写库相同的编码（true/false ↔ 1/0），否则布尔字段永远报「不一致」
  const norm = (v) => (v === true ? '1' : v === false ? '0' : (v === null || v === undefined ? '' : String(v)));
  db.exec('BEGIN IMMEDIATE');
  try {
    // ── R-6：并发前置条件（同一事务内读，避免 TOCTOU） ──
    if (expNames.length) {
      const cur = db.prepare(`SELECT ${expNames.map((n) => `"${n}"`).join(', ')} FROM materials WHERE entity_key = ?`).get(entityKey);
      const conflicts = expNames.filter((n) => norm(cur[n]) !== norm(expected[n])).map((n) => ({ field: n, expected: expected[n], actual: cur[n] }));
      if (conflicts.length) {
        // 被拒绝的尝试也留审计，但**形状必须与"已生效的改动"可区分**：
        // 用 {attempted, expected, rejected}，而不是直接放字段名，避免任何按字段名求值的消费者误读成已写入。
        db.prepare('INSERT INTO edits (at, entity_key, operator, changed_json, result, row_id, source) VALUES (?,?,?,?,?,?,?)')
          .run(at, entityKey, operator ?? 'panel', JSON.stringify({ attempted: fields, expected, rejected: true }), 'rejected_stale_write', String(row.entity_key), 'panel-sqlite');
        db.exec('COMMIT');
        return { ok: false, error: 'stale_write', at, entity_key: entityKey, conflicts };
      }
    }
    // ── 复核落定：快照证据指纹，并在人未显式表态时清掉陈旧标记 ──
    const extra = {};
    if (fields.review_status === 'reviewed') {
      extra.review_based_on_fingerprint = row.evidence_fingerprint ?? null;
      if (fields.review_stale === undefined) { extra.review_stale = 0; extra.review_stale_reason = null; }
    }
    const writeFields = { ...fields, ...extra };
    const writeNames = Object.keys(writeFields);
    const setSql = writeNames.map((n) => `${n} = ?`).join(', ');
    // node:sqlite 不接受 JS boolean → 统一转 0/1（否则报 ERR_INVALID_ARG_TYPE）
    const bind = (v) => (v === true ? 1 : v === false ? 0 : v);
    db.prepare(`UPDATE materials SET ${setSql} WHERE entity_key = ?`).run(...writeNames.map((n) => bind(writeFields[n])), entityKey);
    const readback = db.prepare(`SELECT ${writeNames.join(', ')} FROM materials WHERE entity_key = ?`).get(entityKey);
    const mismatches = [];
    for (const n of writeNames) {
      const eq = norm(writeFields[n]) === norm(readback[n]);
      if (!eq) mismatches.push({ field: n, want: writeFields[n], got: readback[n] });
    }
    const result = mismatches.length ? 'unconfirmed' : 'confirmed';
    db.prepare('INSERT INTO edits (at, entity_key, operator, changed_json, result, row_id, source) VALUES (?,?,?,?,?,?,?)')
      .run(at, entityKey, operator ?? 'panel', JSON.stringify(writeFields), result, String(row.entity_key), 'panel-sqlite');
    db.exec('COMMIT');
    return { ok: !mismatches.length, result, at, confirmed_values: readback, mismatches, entity_key: entityKey, derived: extra, requested: fields };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 回滚失败也要如实返回 */ }
    return { ok: false, error: 'write_failed', detail: String(e).slice(0, 200) };
  }
}

export function listEdits(db, entityKey = null, limit = 200) {
  const rows = entityKey
    ? db.prepare('SELECT * FROM edits WHERE entity_key = ? ORDER BY at DESC LIMIT ?').all(entityKey, limit)
    : db.prepare('SELECT * FROM edits ORDER BY at DESC LIMIT ?').all(limit);
  return rows.map((r) => {
    let changed = {}; let rejected = false;
    try {
      const p = JSON.parse(r.changed_json ?? '{}');
      if (p && typeof p === 'object' && p.rejected === true) { changed = p.attempted ?? {}; rejected = true; } else { changed = (p && typeof p === 'object') ? p : {}; }
    } catch { changed = {}; }
    return { at: r.at, entity_key: r.entity_key, operator: r.operator, changed, result: r.result, row_id: r.row_id, source: r.source, rejected };
  });
}

export function gapsSummary(db) {
  const rows = db.prepare('SELECT reason, COUNT(*) AS n FROM gaps GROUP BY reason ORDER BY n DESC').all();
  const platforms = db.prepare(`SELECT reason, platform, COUNT(*) AS n FROM gaps GROUP BY reason, platform ORDER BY n DESC`).all();
  const byPlat = {};
  for (const p of platforms) { (byPlat[p.reason] ??= []).push({ platform: p.platform, n: p.n }); }
  return rows.map((r) => ({
    reason: r.reason, count: r.n,
    platforms: (byPlat[r.reason] ?? []).slice(0, 6).map((x) => `${x.platform} ${Number(x.n).toLocaleString('en-US')}`).join(' / '),
  }));
}
