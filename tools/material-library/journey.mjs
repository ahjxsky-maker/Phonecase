// tools/material-library/journey.mjs
// R4 STEP4 → R5 STEP3：产品/需求检索 → 详情 → 现有媒体/片段 → 人工编辑 → 再导入 → 目标行断言。
//
// R5 复审（5.6）指出的真实缺陷：旅程「自己制造查询命中」——它只在**源数组**上做谓词过滤，
// 并没有查目标库；于是“检索到同一记录”不需要目标行真的存在，也不证明人工编辑落到目标。
// 本模块据此拆成三件互相独立、可分别验证的事：
//   ① prepareFixtureSetup(...)  —— 显式、隔离的分类提案与人工编辑（写入**隔离夹具**覆盖层）
//   ② lookupTarget(...)         —— **只读**目标库查询：消费所选 backend 的行，报告目标行 ID / entity key / query，
//                                  不调用 setReview、不改覆盖层、不改行
//   ③ runJourney(...)           —— 编排：导入 → 只读查询（命中/未命中）→ 单独人工编辑 → 再导入 → 再查询 → 目标行断言
import { ALL_TABLES, CLASSIFICATION_BASE_FIELDS, TABLE_ASSETS, TABLE_PRIMARY_KEY, TABLE_SEGMENTS, TABLE_VIDEOS, importRecords } from './baserow.mjs';
import { loadOverlay, saveOverlay, setReview } from './review.mjs';

export function classificationGapsOf(record) {
  return ['product_category', 'product_function', 'scene_or_need']
    .filter((k) => (record?.classification?.[k] ?? 'unknown') === 'unknown');
}

/** 谓词工具（**不是**数据库查询的证据）：按产品/功能/需求筛选内存中的记录。 */
export function filterByNeed(records, { need = null, productFunction = null, productCategory = null, product_function = null, product_category = null, scene_or_need = null } = {}) {
  const pf = productFunction ?? product_function;
  const pc = productCategory ?? product_category;
  const nd = need ?? scene_or_need;
  return records.filter((r) => {
    if (r.aid_branch) return false;
    if (pf && r.classification.product_function !== pf) return false;
    if (pc && r.classification.product_category !== pc) return false;
    if (nd && r.classification.scene_or_need !== nd) return false;
    return true;
  });
}

const NEED_FIELDS = { product_category: 'product_category', product_function: 'product_function', scene_or_need: 'scene_or_need' };

/**
 * R5 STEP3：**只读**目标库查询。行来自所选 backend（`listAllRows`），因此这就是“目标库里的行”，
 * 而不是源数组。返回目标行 ID 与 entity key，并明确 `mutated:false`。
 * @returns {{query:object, table:string, backend_kind:string, scanned_rows:number, hits:Array, mutated:boolean}}
 */
export async function lookupTarget({ backend, query = {}, table = TABLE_VIDEOS, includeUnknown = false } = {}) {
  if (!backend) throw new Error('lookup_target_requires_backend');
  const rows = await backend.listAllRows(table);
  for (const field of Object.keys(query)) {
    if (!(field in NEED_FIELDS)) throw new Error(`unsupported_lookup_dimension:${field}（受支持：${Object.keys(NEED_FIELDS).join('/')}）`);
  }
  const criteria = Object.entries(query).filter(([, v]) => v !== null && v !== undefined && v !== '');
  const hits = [];
  for (const r of rows) {
    let match = true;
    for (const [field, want] of criteria) {
      const have = r[field];
      if (have === want) continue;
      if (includeUnknown && (have === 'unknown' || have === null || have === undefined)) continue;
      match = false; break;
    }
    if (match) hits.push({
      row_id: r.id ?? null, entity_key: r.entity_key,
      product_category: r.product_category ?? null, product_function: r.product_function ?? null,
      scene_or_need: r.scene_or_need ?? null,
      product_category_origin: r.product_category_origin ?? null,
      product_function_origin: r.product_function_origin ?? null,
      review_status: r.review_status ?? null, review_stale: r.review_stale === true,
    });
  }
  return {
    query: Object.fromEntries(criteria), table, backend_kind: backend.kind ?? null,
    scanned_rows: rows.length, hits, hit_count: hits.length, mutated: false,
    note: '只读：查询不写行、不写覆盖层、不改分类。',
  };
}

/**
 * R8-STEP2：**身份解析**（只读）。查询消费既有目标行；写入目标必须由**实际查询结果 + 显式选择**共同确定，
 * 不允许“取第一行”。同时在编辑前校验：主键唯一（重复即歧义）、实体键命中、命名空间一致。
 * @returns {{ok:boolean, lookup:object, hits:Array, selected:object|null, selected_row_id:*, problems:string[], duplicate_keys:Array}}
 */
export async function resolveTargetSelection({ backend, query = {}, selection = {}, table = TABLE_VIDEOS } = {}) {
  if (!backend) throw new Error('resolve_selection_requires_backend');
  const pk = TABLE_PRIMARY_KEY[table];
  const lookup = await lookupTarget({ backend, query, table });
  const rows = await backend.listAllRows(table);

  // 目标主键重复 = 歧义：不选赢家，直接拒绝按该键写入
  const seen = new Map();
  const duplicate_keys = [];
  for (const r of rows) {
    const k = String(r?.[pk]);
    if (seen.has(k)) duplicate_keys.push({ key: k, row_ids: [seen.get(k)?.id ?? null, r?.id ?? null] });
    else seen.set(k, r);
  }

  const wantedKey = selection.entityKey ?? null;
  const wantedRowId = selection.rowId === undefined || selection.rowId === null || selection.rowId === '' ? null : selection.rowId;
  const wantedNamespace = selection.namespace ?? null;
  const selectionRequested = wantedKey !== null || wantedRowId !== null;
  const problems = [];

  let candidates = rows;
  if (wantedRowId !== null) candidates = rows.filter((r) => String(r.id) === String(wantedRowId));
  else if (wantedKey !== null) candidates = rows.filter((r) => String(r?.[pk]) === String(wantedKey));

  let selected = null;
  if (selectionRequested) {
    if (candidates.length === 0) problems.push(wantedRowId !== null ? `selection_row_id_not_found:${wantedRowId}` : `selection_entity_key_not_found:${wantedKey}`);
    else if (candidates.length > 1) problems.push(`selection_ambiguous:${candidates.length}_rows`);
    else selected = candidates[0];
  }

  if (selected) {
    const key = String(selected?.[pk]);
    if (duplicate_keys.some((d) => d.key === key)) problems.push(`selected_key_is_ambiguous_in_target:${key}`);
    if (wantedKey !== null && String(selected?.[pk]) !== String(wantedKey)) problems.push(`selected_key_mismatch:${wantedKey}`);
    if (wantedNamespace !== null && String(selected?.namespace ?? '') !== String(wantedNamespace)) {
      problems.push(`selected_namespace_mismatch:${wantedNamespace}!=${String(selected?.namespace ?? '')}`);
    }
    // 选中的身份必须真的来自**本次查询命中**，而不是绕过查询直接按 ID 写
    const hitKeys = new Set(lookup.hits.map((h) => String(h.entity_key)));
    if (!hitKeys.has(key)) problems.push(`selected_not_in_query_hits:${key}`);
  } else if (selectionRequested) {
    problems.push('selection_unresolved');
  }

  return {
    ok: problems.length === 0,
    lookup, hits: lookup.hits, hit_count: lookup.hit_count,
    selection_requested: selectionRequested,
    selected: selected ? serializeTargetRow(selected) : null,
    selected_row_id: selected?.id ?? null,
    selected_entity_key: selected ? selected[pk] : null,
    problems, duplicate_keys,
    duplicate_key_count: duplicate_keys.length,
    scanned_rows: rows.length,
    mutated: false,
    note: '只读身份解析：不写行、不建结构、不选“第一行”。',
  };
}

/**
 * R5 STEP3：显式、隔离的**夹具准备**（分类提案 + 人工编辑）。与查询严格分开。
 * 只主张留存证据支持的部分：产品类别与展示场景由静态产品卡支持；**产品功能保持 unknown**。
 */
export function prepareFixtureSetup({
  overlayPath, root, entityKey, classification, classificationEvidenceRef,
  reviewer = 'journey-fixture-executor', note = null, basedOn = null,
}) {
  if (!overlayPath) throw new Error('fixture_setup_requires_overlay_path');
  const overlay = loadOverlay(root, overlayPath);
  const written = setReview({
    entityKey, status: 'reviewed', reviewer, category: 'creative_reference',
    note: note ?? `隔离夹具人工编辑：${entityKey}`, selectReference: true, basedOn,
    classification, classificationEvidenceRef,
  }, overlay);
  const savedPath = saveOverlay(overlay, root, overlayPath);
  return { written, savedPath, isolated_fixture: true, reviewer };
}

/**
 * R6-STEP2：**目标侧**显式人工编辑。走目标 backend 的 updateRow，然后复读并逐项核对，
 * 而不是只改源侧覆盖层（那只会在下一次导入时被人工字段保护策略挡回，目标行根本不会变）。
 */
/**
 * R6-STEP2 / R9-STEP2：**目标侧**显式人工编辑。走目标 backend 的 updateRow，然后复读并逐项核对。
 *
 * R9 三条诚实性要求（本轮修正）：
 *  · **不**为一条备注或执行端提案强行把 `review_status` 改成 `reviewed`——未显式请求就**保留原状态**；
 *    显式请求时只接受既有复核契约的取值（review.mjs 的 REVIEW_STATUS）。
 *  · 分类状态（`*_state`）同理：未显式给出就保留原值，不再默认写成 `reviewed`。
 *  · **写入状态与读回验证分开记账**：请求被接受但复读失败 → 不得声称“零写入”；被拒绝 → 不得因为
 *    调用方传了意图就算一次写入。返回 `mutation` 明确 attempted / write_accepted / confirmed / state。
 */
export async function applyTargetEdit({
  backend, table = TABLE_VIDEOS, rowId, entityKey = null, note,
  reviewer = null, classification = null, evidenceRef = null, selectReference = true,
  reviewStatus = null, origin = 'human_review',
} = {}) {
  if (!backend) throw new Error('target_edit_requires_backend');
  if (rowId === null || rowId === undefined) throw new Error('target_edit_requires_row_id');
  const VALID_REVIEW_STATUS = ['unreviewed', 'in_review', 'reviewed', 'rejected'];
  const VALID_CLASSIFICATION_STATE = ['proposed', 'reviewed', 'rejected'];
  const requestedReviewStatus = reviewStatus === null || reviewStatus === undefined || reviewStatus === '' ? null : String(reviewStatus);
  if (requestedReviewStatus && !VALID_REVIEW_STATUS.includes(requestedReviewStatus)) {
    return {
      ok: false, refused: true, row_id: rowId, reviewer, before: null, after: null,
      problems: [`invalid_review_status:${requestedReviewStatus}（允许：${VALID_REVIEW_STATUS.join('|')}）`],
      mutation: { attempted: false, write_accepted: false, confirmed: false, readback_ok: false, state: 'refused' },
      checks: [{ name: 'review_status_valid', ok: false, detail: { wanted: requestedReviewStatus } }],
    };
  }
  const pk = TABLE_PRIMARY_KEY[table];
  const rows = await backend.listAllRows(table);
  const before = rows.find((r) => String(r.id) === String(rowId)) ?? null;
  if (!before) {
    return {
      ok: false, refused: true, row_id: rowId, reviewer, before: null, after: null,
      problems: [`target_row_not_found:${rowId}`],
      mutation: { attempted: false, write_accepted: false, confirmed: false, readback_ok: false, state: 'refused' },
      checks: [{ name: 'target_row_exists', ok: false, detail: { row_id: rowId } }],
    };
  }
  if (entityKey && before[pk] !== undefined && String(before[pk]) !== String(entityKey)) {
    return {
      ok: false, refused: true, row_id: rowId, reviewer, before, after: null,
      problems: [`target_row_identity_mismatch:${entityKey}!=${before[pk]}`],
      mutation: { attempted: false, write_accepted: false, confirmed: false, readback_ok: false, state: 'refused' },
      checks: [{ name: 'target_row_identity_match', ok: false, detail: { wanted: entityKey, actual: before[pk] } }],
    };
  }
  const appended = [before.review_notes, note].filter(Boolean).join('\n') || String(note ?? '');
  const patch = {
    review_notes: appended, review_reviewer: reviewer ?? null, selected_reference: selectReference === true,
  };
  // R9：只有**显式请求**才写 review_status；否则保留目标既有状态（不把“加备注”等同于“已复核”）
  if (requestedReviewStatus) patch.review_status = requestedReviewStatus;
  // R7-STEP2：只允许既有分类契约的三个**值**字段；`state` 与 evidence/reviewer 是**元数据**，
  // 不能当成字段写进去（否则 memory 会存下 state/state_origin/state_reviewer 之类非 schema 垃圾，
  // 而 HTTP 边界又会把它们丢掉 —— 两端行为不一致）。
  const CLASSIFICATION_BASES = ['product_category', 'product_function', 'scene_or_need'];
  const appliedClassification = {};
  const ignoredKeys = [];
  if (classification) {
    for (const key of Object.keys(classification)) {
      if (key === 'state' || key === 'evidence_ref' || key === 'origin' || CLASSIFICATION_BASES.includes(key)) continue;
      ignoredKeys.push(key);
    }
    const requestedState = classification.state === null || classification.state === undefined || classification.state === ''
      ? null : String(classification.state);
    if (requestedState && !VALID_CLASSIFICATION_STATE.includes(requestedState)) {
      return {
        ok: false, refused: true, row_id: rowId, reviewer, before, after: null,
        problems: [`invalid_classification_state:${requestedState}（允许：${VALID_CLASSIFICATION_STATE.join('|')}）`],
        mutation: { attempted: false, write_accepted: false, confirmed: false, readback_ok: false, state: 'refused' },
        checks: [{ name: 'classification_state_valid', ok: false, detail: { wanted: requestedState } }],
      };
    }
    const requestedOrigin = classification.origin ?? origin ?? null;
    for (const base of CLASSIFICATION_BASES) {
      const v = classification[base];
      if (v === null || v === undefined || v === '') continue;
      patch[base] = String(v);
      patch[`${base}_origin`] = requestedOrigin;
      patch[`${base}_reviewer`] = reviewer ?? null;
      patch[`${base}_evidence_ref`] = evidenceRef ?? null;
      // 未显式给出状态 → **保留目标既有状态**（读回时按 before 核对，而不是按“应该等于 reviewed”）
      const keepState = requestedState === null ? (before[`${base}_state`] ?? null) : requestedState;
      if (requestedState !== null) patch[`${base}_state`] = requestedState;
      appliedClassification[base] = { value: String(v), state: keepState, state_requested: requestedState !== null };
    }
  }

  // ---- 写入与读回**分开记账**（R9 STEP2.4）----
  const mutation = { attempted: true, write_accepted: false, confirmed: false, readback_ok: false, state: 'not_written', error: null };
  try {
    await backend.updateRow(table, rowId, patch);
    mutation.write_accepted = true;
    mutation.state = 'written_unverified';
  } catch (e) {
    // 写入抛错 ≠ 确定没写进去（可能是超时/不确定写入）→ 先复读再判定
    mutation.error = String(e.message);
    mutation.state = 'unknown_write';
  }
  let after = null;
  try {
    after = (await backend.listAllRows(table)).find((r) => String(r.id) === String(rowId)) ?? null;
    mutation.readback_ok = !!after;
  } catch (e) {
    mutation.readback_error = String(e.message);
  }
  if (!mutation.readback_ok) {
    // 读回失败：写入是否落地**未知**，不得声称零写入
    mutation.state = mutation.write_accepted ? 'written_unverified' : 'unknown_write';
  }

  const expectedReviewStatus = requestedReviewStatus ?? (before.review_status ?? null);
  const checks = [
    { name: 'target_row_exists', ok: true },
    { name: 'reread_row_present', ok: !!after },
    { name: 'review_notes_applied', ok: (after?.review_notes ?? null) === appended, detail: { wanted: appended, actual: after?.review_notes ?? null } },
    { name: 'review_status_preserved_or_requested', ok: (after?.review_status ?? null) === expectedReviewStatus, detail: { wanted: expectedReviewStatus, actual: after?.review_status ?? null, explicitly_requested: requestedReviewStatus } },
    { name: 'reviewer_applied', ok: (after?.review_reviewer ?? null) === (reviewer ?? null) },
    { name: 'selected_reference_applied', ok: after?.selected_reference === (selectReference === true) },
  ];
  if (ignoredKeys.length) checks.push({ name: 'unsupported_classification_keys_not_written', ok: true, detail: ignoredKeys });
  for (const [base, want] of Object.entries(appliedClassification)) {
    checks.push({
      name: `${base}_value_applied`, ok: after?.[base] === want.value,
      detail: { wanted: want.value, actual: after?.[base] ?? null },
    });
    checks.push({
      name: `${base}_state_applied`, ok: (after?.[`${base}_state`] ?? null) === want.state,
      detail: { wanted: want.state, actual: after?.[`${base}_state`] ?? null, explicitly_requested: want.state_requested },
    });
    checks.push({
      name: `${base}_provenance_applied`,
      ok: after?.[`${base}_origin`] === patch[`${base}_origin`]
        && (after?.[`${base}_evidence_ref`] ?? null) === (evidenceRef ?? null)
        && (after?.[`${base}_reviewer`] ?? null) === (reviewer ?? null),
      detail: { origin: after?.[`${base}_origin`] ?? null, evidence_ref: after?.[`${base}_evidence_ref`] ?? null, reviewer: after?.[`${base}_reviewer`] ?? null },
    });
  }
  const allChecksOk = checks.every((c) => c.ok);
  if (mutation.readback_ok) mutation.confirmed = allChecksOk;
  if (mutation.readback_ok && !allChecksOk) mutation.state = mutation.write_accepted ? 'written_but_mismatched' : 'not_written';
  if (mutation.readback_ok && allChecksOk && mutation.write_accepted) mutation.state = 'confirmed';
  if (!mutation.write_accepted && !mutation.readback_ok) mutation.state = 'unknown_write';
  return {
    ok: mutation.state === 'confirmed',
    refused: false,
    row_id: rowId, reviewer,
    requested_review_status: requestedReviewStatus,
    applied: patch, classification: appliedClassification, ignored_classification_keys: ignoredKeys,
    checks, before, after,
    mutation,
    note: '写入状态与读回验证分开记账：attempted/write_accepted/confirmed/state 各自独立。',
  };
}

/**
 * 目标行的可核对序列化（R9-STEP3.2）：**三个分类基准各自的**值 + 来源 + 复核人 + 证据引用 + 状态，
 * 加上既有手工字段。不臆造未填充的分类（缺失即为 null），也不丢任何一个维度。
 */
export function serializeTargetRow(row) {
  if (!row) return null;
  const fields = ['review_status', 'review_notes', 'review_reviewer', 'selected_reference', 'review_stale', 'review_stale_reason'];
  const out = { row_id: row.id ?? null, entity_key: row.entity_key ?? null };
  for (const f of fields) out[f] = row[f] ?? null;
  for (const base of CLASSIFICATION_BASE_FIELDS) {
    out[base] = row[base] ?? null;
    out[`${base}_origin`] = row[`${base}_origin`] ?? null;
    out[`${base}_reviewer`] = row[`${base}_reviewer`] ?? null;
    out[`${base}_evidence_ref`] = row[`${base}_evidence_ref`] ?? null;
    out[`${base}_state`] = row[`${base}_state`] ?? null;
  }
  return out;
}

/** 目标侧媒体发布状态快照（只读）：用于断言“再导入没有把已发布链接/状态清空”。 */
async function mediaStateOf(backend, entityKey) {
  const assets = (await backend.listAllRows(TABLE_ASSETS)).filter((r) => r.entity_key === entityKey);
  const segments = (await backend.listAllRows(TABLE_SEGMENTS)).filter((r) => r.entity_key === entityKey);
  return {
    assets: assets.map((r) => ({ asset_id: r.asset_id, media_view_url: r.media_view_url ?? null, media_view_path: r.media_view_path ?? null, media_service_state: r.media_service_state ?? null })),
    segments: segments.map((r) => ({ segment_id: r.segment_id, view_url: r.view_url ?? null, view_path: r.view_path ?? null, media_service_state: r.media_service_state ?? null })),
  };
}

/**
 * 走完整条链并返回可写回执。写覆盖层与读覆盖层使用**同一个** overlayPath；
 * 第 7 步的检索是**目标库只读查询**（不是源数组谓词）。
 *
 * R7-STEP2 的两处语义修正：
 *  - `setupFixture`：夹具准备改为**显式可选**。真实用户路径（已填充目标）不得自动写夹具覆盖层。
 *  - `mediaBaseUrl`：**三态**透传（undefined=未指定 → 保留目标既有发布字段）。
 */
export async function runJourney({
  records, loadWithOverlay, overlayPath, root,
  platform = 'TikTok', requireMedia = true,
  classification = null, classificationEvidenceRef = null,
  reviewer = 'journey-fixture-executor', note = null,
  createBackend, backendMode = null, createHttpBackend = null,
  mode = 'journey_memory_semantics_only',
  allTables = ALL_TABLES,
  manualEdit = null,                 // {classification, evidenceRef, note} —— 与查询分开的显式人工动作
  noMatchQuery = null,               // 明确验证“没有命中也要诚实”
  setupFixture = null,               // R7-STEP2：显式夹具准备（隔离演示）；默认**不**执行
  mediaBaseUrl,                      // R7-STEP3：三态（undefined=未指定 → 保留目标既有发布字段）
} = {}) {
  const failures = [];
  const T = [];
  const step = (n, title, data) => T.push({ step: n, title, ...data });
  const hasMedia = (r) => (r.assets ?? []).some((a) => a.usable_as_video === true);

  // 1) 检索条件
  const needQuery = {
    product_category: classification?.product_category ?? null,
    product_function: classification?.product_function ?? null,
    scene_or_need: classification?.scene_or_need ?? null,
  };
  step(1, '检索条件', {
    need_dimension: needQuery,
    supplemental: { platform, require_local_video: requireMedia },
    note: '产品/需求是主维度；来源无留存 → unknown。平台+是否有媒体只是补充条件。**查询在目标库上执行**（见第 7 步）。',
  });

  // 2) 源侧候选（信息用，不作为命中证据）
  const candidateRows = records.filter((r) => !r.aid_branch && r.platform === platform && (!requireMedia || hasMedia(r)));
  step(2, '源侧候选（非命中证据）', {
    candidate_count: candidateRows.length,
    rows: candidateRows.slice(0, 5).map((r) => ({
      entity_key: r.entity_key, source_state: r.availability.entity_source_state,
      metrics: r.availability.fields_observed, assets: (r.assets ?? []).length,
      classification_gaps: classificationGapsOf(r),
    })),
    note: '这里只是候选来源；**是否命中由第 7 步的目标库只读查询决定**。',
  });
  if (candidateRows.length === 0) {
    step(2.1, '无候选记录', { note: '按当前条件无候选；不放宽条件、不制造记录。' });
    return { ok: false, transcript: { steps: T, matched: 0 }, failures: ['no_candidate_record'] };
  }

  const pick = candidateRows.find((r) => (r.assets ?? []).some((a) => (a.segments ?? []).length > 0)) ?? candidateRows[0];
  step(3, '选中记录', { entity_key: pick.entity_key, native_id: pick.native_id, namespace: pick.namespace });

  // 4) 详情证据
  const usable = (m) => m.status === 'value' || m.status === 'observed_zero';
  step(4, '详情证据', {
    identity: {
      canonical_url: pick.identity.canonical_url, derived_permalink: pick.identity.derived_permalink,
      derived_permalink_note: '派生且未经访问验证',
    },
    publication: { epoch_s: pick.classification.publish_date_epoch_s, label: pick.classification.publish_date_label },
    availability: pick.availability,
    metrics_sample: pick.metrics.filter(usable).slice(0, 8).map((m) => ({
      field: m.field, status: m.status, value: m.value, unit: m.unit,
      observed_at_epoch_s: m.observed_at_epoch_s, fact_origin: m.fact_origin,
      metric_definition: m.metric_definition, metric_caveat: m.metric_caveat,
      comparable_across_platforms: m.comparable_across_platforms, source_file: m.source_file,
    })),
    value_labels: pick.value_labels,
  });

  // 5) 现有媒体 / 片段
  const media = (pick.assets ?? []).filter((a) => a.usable_as_video === true).map((a) => ({
    asset_id: a.asset_id, local_path: a.local_path, media_kind: a.media_kind,
    duration_seconds: a.duration_seconds, sha256: a.sha256, verified_present_locally: a.verified_present_locally,
    segments: (a.segments ?? []).map((s) => ({ segment_id: s.segment_id, t_label: s.t_label, start_seconds: s.start_seconds, origin_card: s.origin_card })),
  }));
  step(5, '现有媒体与时间引用', {
    media,
    media_gap: media.length === 0 ? 'no_local_video_for_this_entity' : null,
    classification_gaps: classificationGapsOf(pick),
    note: '缺媒体/缺分类显式可见，不用推断填充；片段为稀疏抽样。',
  });

  // 6) 夹具准备：**显式可选动作**。真实用户路径（已填充目标）绝不自动写隔离覆盖层。
  if (!overlayPath) return { ok: false, transcript: { steps: T }, failures: ['missing_overlay_path'] };
  let setup = null;
  if (setupFixture) {
    const fx = setupFixture === true ? {} : setupFixture;
    setup = prepareFixtureSetup({
      overlayPath, root, entityKey: pick.entity_key,
      classification: fx.classification ?? classification,
      classificationEvidenceRef: fx.classificationEvidenceRef ?? classificationEvidenceRef,
      reviewer: fx.reviewer ?? reviewer,
      note: fx.note ?? note ?? `隔离夹具人工编辑：平台 ${pick.platform}，媒体 ${media[0]?.asset_id ?? 'none'}，片段 ${media[0]?.segments?.length ?? 0} 条`,
      basedOn: pick.evidence_fingerprint,
    });
    step(6, '隔离夹具准备（**显式演示动作**；非查询）', {
      entity_key: pick.entity_key, store: setup.savedPath, isolated_fixture: true,
      reviewer: setup.reviewer, written_status: setup.written.status, written_notes: setup.written.notes.length,
      written_classification: setup.written.classification ?? null,
      note: '夹具身份与隔离覆盖层；正式 human-review 覆盖层未被写入。执行端提案标 proposed，不冒充 Simon 复核。',
    });
  } else {
    step(6, '夹具准备：**未执行**（真实用户路径）', {
      entity_key: pick.entity_key, isolated_fixture: false, overlay_written: false,
      note: 'R7-STEP2：已填充目标上的查询/显式编辑不得自动制造夹具行或覆盖人工状态；本次未写任何覆盖层，目标状态完全来自既有目标库。',
    });
  }

  // 7) 载入来源 → 目标 backend → 导入 → 只读查询 → 显式编辑 → 复导入 → 再查询 → 目标行断言
  const after = await loadWithOverlay(overlayPath);
  const reloaded = after.find((r) => r.entity_key === pick.entity_key);
  if (!reloaded) failures.push('record_missing_after_reload_with_same_overlay');
  if (setup) {
    const reloadedNotes = reloaded?.review?.notes ?? [];
    if (reloadedNotes.length !== setup.written.notes.length) {
      failures.push(`overlay_not_consumed: written=${setup.written.notes.length} reloaded=${reloadedNotes.length}`);
    }
  } else {
    step(6.1, '来源加载（真实路径：不消费夹具覆盖层）', {
      entity_key: pick.entity_key, source_records: after.length,
      loaded_review_notes: (reloaded?.review?.notes ?? []).length,
      note: '只使用交付的 loadWithOverlay 读取来源；未写入覆盖层，故不存在“夹具被消费”的等价断言。',
    });
  }

  // R6-STEP2：后端模式必须**显式声明**；不支持的模式直接拒绝，绝不悄悄退回内存替身。
  const requestedMode = backendMode ?? (createBackend ? 'memory_isolation' : null);
  if (!requestedMode) throw new Error('journey_requires_explicit_backend_mode:memory_isolation|http');
  if (!['memory_isolation', 'http'].includes(requestedMode)) throw new Error(`unsupported_journey_backend_mode:${requestedMode}`);
  if (requestedMode === 'http' && !createHttpBackend) {
    throw new Error('journey_http_backend_not_configured：--backend http 需要 base-url/database-id 与凭据；不回落 memory');
  }
  const backend = requestedMode === 'http' ? await createHttpBackend() : createBackend();
  // R7-STEP3：三态透传 —— 未提供 mediaBaseUrl 时不把该选项交给 importRecords（保留目标既有发布字段）。
  const importOptions = { mode };
  if (mediaBaseUrl !== undefined) importOptions.mediaBaseUrl = mediaBaseUrl;
  let lookup = null, noMatch = null, importFirst = null, importReplay = null, row = null, editResult = null, lookupAfterEdit = null, rowAfterEdit = null;
  let preImportRow = null, prepopulated = false, mediaBefore = null, mediaAfter = null;
  if (backend) {
    for (const t of allTables) if (backend.createTable) await backend.createTable(t);
    // R7-STEP2：导入**前**的目标快照 —— 真实路径据此证明“再导入没有覆盖既有目标状态”。
    const preImport = await backend.listAllRows(TABLE_VIDEOS);
    preImportRow = preImport.find((r) => r.entity_key === pick.entity_key) ?? null;
    prepopulated = !!preImportRow;
    mediaBefore = await mediaStateOf(backend, pick.entity_key);
    importFirst = await importRecords({ records: after, backend, ...importOptions });
    // R6-STEP2：导入本身失败不得被后续步骤掩盖
    if (importFirst?.ok !== true) failures.push(`initial_import_not_ok:${JSON.stringify(importFirst?.errors?.slice(0, 2) ?? [])}`);
    // 只读查询（命中）
    lookup = await lookupTarget({ backend, query: needQuery });
    // R6-STEP2：命中必须是**期望的那一条**，不能只看“有命中”
    if (lookup.hit_count === 0) failures.push('lookup_returned_no_hit');
    else if (!lookup.hits.some((h) => h.entity_key === pick.entity_key)) failures.push(`lookup_hit_wrong_entity:${JSON.stringify(lookup.hits.map((h) => h.entity_key))}`);
    // 只读查询（未命中）——声明探针必须真的为空
    if (noMatchQuery) {
      noMatch = await lookupTarget({ backend, query: noMatchQuery });
      if (noMatch.hit_count !== 0) failures.push(`no_match_probe_unexpected_hits:${noMatch.hit_count}`);
    }
    // 目标行断言
    const rows = await backend.listAllRows(TABLE_VIDEOS);
    row = rows.find((r) => r.entity_key === pick.entity_key) ?? null;
    if (!row) failures.push('target_video_row_missing');
    else if (setup) {
      if (row.review_status !== setup.written.status) failures.push(`target_review_status=${row.review_status} expected=${setup.written.status}`);
      if ((row.review_notes ?? null) !== (setup.written.notes.join('\n') || null)) failures.push(`target_review_notes_mismatch:${JSON.stringify(row.review_notes)}`);
      if (row.selected_reference !== true) failures.push('target_selected_reference_not_true');
      if (row.review_stale === true) failures.push('target_review_marked_stale');
    } else if (prepopulated) {
      // R7-STEP2：真实路径的核心断言 —— 既有目标行的人工状态、行 ID 与命名空间必须原样保留。
      if (row.id !== preImportRow.id) failures.push(`prepopulated_target_row_id_changed:${preImportRow.id}->${row.id}`);
      if (row.namespace !== preImportRow.namespace) failures.push(`prepopulated_target_namespace_changed:${preImportRow.namespace}->${row.namespace}`);
      for (const f of ['review_status', 'review_notes', 'review_reviewer', 'selected_reference', 'product_category', 'product_category_origin', 'product_category_reviewer', 'scene_or_need']) {
        if ((row[f] ?? null) !== (preImportRow[f] ?? null)) {
          failures.push(`prepopulated_target_field_overwritten:${f}:${JSON.stringify(preImportRow[f] ?? null)}->${JSON.stringify(row[f] ?? null)}`);
        }
      }
    } else {
      // 目标里原本没有这一行：本次是**新增**，不得声称“保留了既有状态”。
      if (row.review_status === undefined) failures.push('inserted_target_row_missing_default_review_status');
    }
    // R6-STEP2：**显式人工编辑走目标 backend**（不是只改源侧覆盖层）→ 复读 → 普通来源复导入 → 再复读同一目标
    if (manualEdit && row) {
      editResult = await applyTargetEdit({
        backend, table: TABLE_VIDEOS, rowId: row.id, entityKey: pick.entity_key,
        note: manualEdit.note ?? '隔离夹具：目标侧显式人工编辑（带原因）',
        reviewer: manualEdit.reviewer ?? reviewer,
        classification: manualEdit.classification ?? null,
        evidenceRef: manualEdit.evidenceRef ?? null,
        selectReference: manualEdit.selectReference ?? true,
      });
      if (editResult.ok !== true) failures.push(`target_edit_not_applied:${JSON.stringify(editResult.checks.filter((c) => !c.ok))}`);
      const afterEdit = await loadWithOverlay(overlayPath);
      importReplay = await importRecords({ records: afterEdit, backend, ...importOptions });
      if (importReplay?.ok !== true) failures.push(`replay_import_not_ok:${JSON.stringify(importReplay?.errors?.slice(0, 2) ?? [])}`);
      if (importReplay?.tables?.[TABLE_VIDEOS]?.inserted !== 0) failures.push(`replay_inserted=${importReplay?.tables?.[TABLE_VIDEOS]?.inserted}`);
      lookupAfterEdit = await lookupTarget({ backend, query: needQuery });
      if (lookupAfterEdit.hit_count === 0) failures.push('lookup_after_edit_returned_no_hit');
      // 序列化**编辑后**的目标行，而不是编辑前的快照
      rowAfterEdit = (await backend.listAllRows(TABLE_VIDEOS)).find((r) => r.entity_key === pick.entity_key) ?? null;
      if (!rowAfterEdit) failures.push('target_row_missing_after_manual_edit');
      else {
        const expectedNotes = editResult.after.review_notes;
        if ((rowAfterEdit.review_notes ?? null) !== (expectedNotes ?? null)) failures.push(`edited_notes_lost_after_reimport:${JSON.stringify(rowAfterEdit.review_notes)}`);
        if (rowAfterEdit.review_reviewer !== (editResult.after.review_reviewer ?? null)) failures.push(`edited_reviewer_lost:${rowAfterEdit.review_reviewer}`);
        if ((rowAfterEdit[`${'product_category'}_reviewer`] ?? null) !== (editResult.after.product_category_reviewer ?? null) && editResult.after.product_category_reviewer) {
          failures.push(`edited_classification_reviewer_lost:${rowAfterEdit.product_category_reviewer}`);
        }
        // R7-STEP2：请求的**值**与状态本身必须落地（只核 origin/reviewer 不够；值丢失必须失败）。
        for (const [base, want] of Object.entries(editResult.classification ?? {})) {
          if (rowAfterEdit[base] !== want.value) failures.push(`edited_classification_value_lost:${base}:${JSON.stringify(rowAfterEdit[base] ?? null)}!=${JSON.stringify(want.value)}`);
          if (rowAfterEdit[`${base}_state`] !== want.state) failures.push(`edited_classification_state_lost:${base}:${JSON.stringify(rowAfterEdit[`${base}_state`] ?? null)}!=${JSON.stringify(want.state)}`);
        }
      }
    }
    // R7-STEP3：编辑+复导入之后，目标侧媒体发布状态快照（供“链接未被清空”的断言使用）。
    mediaAfter = await mediaStateOf(backend, pick.entity_key);
    if (mediaBefore && mediaBefore.assets.length && mediaBaseUrl === undefined) {
      const publishedBefore = mediaBefore.assets.filter((a) => a.media_view_url);
      const byId = new Map(mediaAfter.assets.map((a) => [String(a.asset_id), a]));
      for (const b of publishedBefore) {
        const a = byId.get(String(b.asset_id));
        if (!a) { failures.push(`published_asset_row_missing_after_reimport:${b.asset_id}`); continue; }
        if ((a.media_view_url ?? null) !== (b.media_view_url ?? null)) failures.push(`published_media_view_url_revoked_by_unconfigured_import:${b.asset_id}:${JSON.stringify(b.media_view_url)}->${JSON.stringify(a.media_view_url ?? null)}`);
        if ((a.media_service_state ?? null) !== (b.media_service_state ?? null)) failures.push(`published_media_service_state_changed:${b.asset_id}:${JSON.stringify(b.media_service_state ?? null)}->${JSON.stringify(a.media_service_state ?? null)}`);
      }
    }
  }

  step(7, '导入 → 目标库只读查询 → **目标侧**显式人工编辑 → 复导入 → 再查询（目标行断言）', {
    overlay_path: overlayPath,
    fixture_setup: setup ? { written_notes: setup.written.notes.length, isolated_fixture: true } : null,
    prepopulated_target_row: prepopulated,
    pre_import_row: preImportRow ? serializeTargetRow(preImportRow) : null,
    import_options: { mode, media_base_url_provided: mediaBaseUrl !== undefined },
    media_publication_before: mediaBefore,
    media_publication_after: mediaAfter,
    import_first: importFirst?.tables?.[TABLE_VIDEOS] ?? null,
    lookup, no_match_lookup: noMatch,
    target_side_manual_edit: editResult ? {
      row_id: editResult.row_id, reviewer: editResult.reviewer, ok: editResult.ok,
      before_notes: editResult.before?.review_notes ?? null, after_notes: editResult.after?.review_notes ?? null,
      applied_fields: Object.keys(editResult.applied ?? {}),
      classification: editResult.classification ?? null,
      ignored_classification_keys: editResult.ignored_classification_keys ?? [],
    } : null,
    import_replay: importReplay?.tables?.[TABLE_VIDEOS] ?? null,
    lookup_after_edit: lookupAfterEdit,
    target_row_after_edit: rowAfterEdit ? serializeTargetRow(rowAfterEdit) : null,
    target_row_pre_edit: row ? serializeTargetRow(row) : null,
    note: '命中来自**目标库行**（lookupTarget 读 backend）；人工编辑走**目标 backend 的 updateRow**，再导入只读来源、不得覆盖它。',
  });

  const transcript = {
    at: new Date().toISOString(),
    platform, require_media: requireMedia, classification: classification ?? null,
    candidate_count: candidateRows.length, chosen_entity_key: pick.entity_key,
    backend_mode: requestedMode, fixture_setup_executed: !!setup,
    media_base_url_provided: mediaBaseUrl !== undefined,
    baserow_ui_verified: false,
    failures,
    steps: T,
    interpretation: '本旅程在交付代码与真实留存数据上执行；**不**等于 Baserow 面板内 UI 验收，也不等于真实实例上的查询。',
  };
  return { ok: failures.length === 0, transcript, failures };
}
