// tools/material-library/normalize.mjs
// P3 归一化：保留普查证据（只读） → 归一化研究记录。
// 关键不变量：
//  - 成员资格来自实体决策层 + 已记录的 YouTube 日期订正覆盖层（不是 v518 的逐字段子集）。
//  - 大整数 id 全程字符串，绝不经 Number()。
//  - 缺失 / 来源不可用 / 不可用 / 未知 / 错误 / 观测零 互相区分；缺失不写 0。
//  - 每个成员要么入导入集合，要么带**具体原因**进入 gap 清单；不用总数捏造成员。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';
import {
  AID_BRANCH, DECISION_INCLUDE, DEFAULT_ROOT, ENGAGEMENT_FIELDS, EXPECTED_MAIN_V,
  JOIN_REASON_TO_SOURCE_STATE, OBSERVATION_STATUS, PLATFORMS, RATIO_RULES, SOURCE_AVAILABILITY,
  entityKey, normalizeFieldObservation, observationIdentity, slugFor, sourcePaths,
} from './rules.mjs';
import { applyOverlay, loadOverlay } from './review.mjs';

export function sha256Hex(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

async function streamJsonl(file, onRow) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let n = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    onRow(JSON.parse(line));
    n++;
  }
  rl.close();
  return n;
}

// ---- 1. 实体决策层 + 已记录覆盖层 -------------------------------------------------
export async function loadEntityDecisions(root = DEFAULT_ROOT) {
  const P = sourcePaths(root);
  const decisions = new Map();
  const raw = new Map();
  const n = await streamJsonl(P.entityDecisions, (r) => {
    const k = entityKey(r.platform, r.namespace, r.native_id);
    decisions.set(k, r.decision);
    raw.set(k, r);
  });

  // v513：单条具名 YouTube 日期订正；v514：批量 YouTube 日期订正层。
  // 两者都是普查已接受的订正，必须叠加后才是验收口径的成员资格。
  const overlays = [];
  for (const [label, file] of [['v513-youtube-detail-correction', P.youtubeCorrectionsV513], ['v514-youtube-detail-corrections', P.youtubeCorrectionsV514]]) {
    if (!fs.existsSync(file)) { overlays.push({ label, file, applied: 0, missing: true }); continue; }
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = j.corrections ?? [j];
    let applied = 0, notFound = 0;
    for (const c of list) {
      const ek = c.entity_key ?? c;
      const k = entityKey(ek.platform, ek.namespace, ek.native_id);
      if (!decisions.has(k)) { notFound++; continue; }
      decisions.set(k, c.new_decision ?? decisions.get(k));
      if (raw.has(k)) raw.get(k).applied_correction = { from: label, new_decision: c.new_decision, resolved_epoch_s: c.resolved_epoch_s ?? null };
      applied++;
    }
    overlays.push({ label, file, applied, notFound, missing: false });
  }
  return { decisions, raw, lineCount: n, overlays };
}

// ---- 2. 字段值层（逐实体逐字段，可含多次观测） ------------------------------------
export async function loadFieldValues(root = DEFAULT_ROOT) {
  const P = sourcePaths(root);
  const byEntity = new Map();
  const n = await streamJsonl(P.fieldValues, (r) => {
    const k = entityKey(displayPlatform(r.platform), r.namespace, r.native_id);
    if (!byEntity.has(k)) byEntity.set(k, []);
    byEntity.get(k).push(r);
  });
  return { byEntity, lineCount: n };
}

// 字段层使用小写 slug；实体层使用显示名。显式映射，不做模糊匹配。
const SLUG_TO_DISPLAY = {
  tiktok: 'TikTok', instagram: 'Instagram', youtube: 'YouTube', douyin: 'Douyin',
  kuaishou: 'Kuaishou', xiaohongshu: 'Xiaohongshu', bilibili: 'Bilibili', wechat: 'WeChat Channels',
};
export function displayPlatform(slug) { return SLUG_TO_DISPLAY[String(slug).toLowerCase()] ?? slug; }

// ---- 3. 既有本地媒体（仅 20 条；与普查世代分开标识） ------------------------------
// 已知坑（监督卡 §4「原始文档阅读陷阱」）：manifest 的 media 字段对 TikTok 条目为 null，
// 真实媒体路径记录在**卡**的 media_evidence.file 中。必须两级解析，否则会误判为「无媒体」。
export function loadMediaIndex(root = DEFAULT_ROOT, { verifyHashes = true } = {}) {
  const P = sourcePaths(root);
  const index = new Map();
  const meta = { available: false, manifest: P.mediaManifest, entries: 0, resolved_from_card: 0, note: null };
  if (!fs.existsSync(P.mediaManifest)) { meta.note = 'manifest missing'; return { index, meta }; }
  const j = JSON.parse(fs.readFileSync(P.mediaManifest, 'utf8'));
  for (const e of j.entries ?? []) {
    const plat = displayPlatform(e.platform);
    const vid = String(e.identity?.aweme_id ?? e.identity?.video_id ?? e.identity?.id ?? e.video_id ?? '')
      .replace(/^[a-z]+-/, '');
    const key = entityKey(plat, 'main', vid);

    // 两级解析：manifest.media.file → card.media_evidence.file
    // 陷阱（成果总览 §原始文档的阅读陷阱 第2条）：最短的抖音卡 media_evidence.file 指向**接触表(JPG)**，
    // 不是 MP4。因此卡回退必须做媒体类型守卫，绝不能把图像当作视频媒体。
    let localPath = e.media?.file ?? null;
    let pathSource = localPath ? 'manifest.media.file' : null;
    let recordedSha = e.media?.sha256 ?? null;
    let recordedBytes = e.media?.bytes ?? null;
    let duration = e.media?.duration_seconds ?? null;
    let resolution = e.media?.resolution ?? null;
    let contactSheet = e.contact_sheet ?? null;
    let kindRejectReason = null;
    let card = null;
    // 卡始终尝试读取：即使 manifest 已给出媒体，时间片段引用（timeline）也只在卡里。
    if (e.card_file) {
      const cp = path.join(P.analysisRoot, e.card_file);
      if (fs.existsSync(cp)) {
        try { card = JSON.parse(fs.readFileSync(cp, 'utf8')); } catch { card = null; }
      }
    }
    if (!localPath && card) {
      const me = card.media_evidence ?? {};
      if (me.file) {
        if (mediaKindOf(me.file) === 'video') {
          localPath = me.file;
          pathSource = 'card.media_evidence.file';
          recordedSha = me.sha256 ?? recordedSha;
          recordedBytes = me.bytes ?? recordedBytes;
          duration = me.duration_seconds ?? duration;
          resolution = me.resolution ?? resolution;
          contactSheet = contactSheet ?? me.contact_sheet ?? null;
          meta.resolved_from_card++;
        } else {
          // 卡的 media_evidence 指向图像 → 明确拒绝作为视频来源，不做静默替代
          kindRejectReason = `card_media_evidence_not_a_video:${mediaKindOf(me.file)}`;
          contactSheet = contactSheet ?? me.file;
          meta.kind_rejected++;
        }
      }
    }

    // 既有时间片段引用：来自卡，带来源与种类；不新建任何语义分析。
    const segments = (card?.timeline ?? []).map((seg, i) => ({
      segment_id: `${key}|${i}|${seg.t_seconds ?? seg.t ?? i}`,
      index: i,
      t_label: seg.t ?? null,
      start_seconds: typeof seg.t_seconds === 'number' ? seg.t_seconds : null,
      observed: seg.observed ?? null,
      onscreen_text: seg.onscreen_text ?? null,
      speech: seg.speech ?? null,
      kind: seg.kind ?? 'unknown',
      // 来源事实 vs 分析判断/建议：沿用卡的 class_legend，不自行升级
      fact_origin: seg.kind === 'original_fact' ? 'source_fact' : 'derived_interpretation',
      origin_card: e.card_file ?? null,
      origin_method: card?.media_evidence?.timestamp_method ?? null,
      time_accuracy_note: card?.media_evidence?.time_accuracy_scope ?? null,
      coverage: 'sparse_sampled_tiles_only',
      review_status: 'unreviewed',
      selected_reference: false,
      human_note: null,
    }));

    // 路径一律规范化为绝对路径：相对路径依赖 cwd，换消费者就会解析失败。
    const absPath = localPath ? path.resolve(P.root, localPath) : null;
    const mediaKind = absPath ? mediaKindOf(absPath) : null;
    const exists = absPath ? fs.existsSync(absPath) : false;
    let recomputed = null, match = null;
    if (exists && verifyHashes) {
      try {
        recomputed = crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
        match = recordedSha ? recomputed === recordedSha : null;
      } catch { recomputed = null; match = null; }
    }

    index.set(key, {
      asset_id: e.slot,
      platform: plat,
      native_id: vid,
      cohort: 'media-analysis-20-20260920 (outside frozen census cohort where identity not proven)',
      local_path: absPath,
      local_path_recorded: localPath,
      path_source: pathSource,
      path_is_absolute: absPath ? path.isAbsolute(absPath) : null,
      media_kind: mediaKind,
      usable_as_video: mediaKind === 'video' && exists,
      kind_reject_reason: kindRejectReason,
      bytes: recordedBytes,
      recorded_bytes: recordedBytes,
      actual_bytes: exists ? fs.statSync(absPath).size : null,
      sha256: recordedSha,
      sha256_recomputed: recomputed,
      sha256_match: match,
      duration_seconds: duration,
      resolution,
      contact_sheet: contactSheet,
      card_file: e.card_file ?? null,
      timeline_entries: e.timeline_entries ?? null,
      asr: e.asr ?? null,
      rights_status: e.identity?.rights_status ?? 'unknown',
      metrics_snapshot: e.metrics_snapshot ?? null,
      source_grade: e.source_grade ?? null,
      manifest_media_null_resolved_from_card: !e.media?.file && !!pathSource,
      segments,
      segment_count: segments.length,
      media_evidence_frame_time_note: card?.media_evidence?.frame_time_evidence ?? null,
    });
  }
  meta.available = index.size > 0;
  meta.entries = index.size;
  meta.present_on_disk = [...index.values()].filter((a) => a.local_path && fs.existsSync(a.local_path)).length;
  meta.hash_verified = [...index.values()].filter((a) => a.sha256_match === true).length;
  meta.unresolved_paths = [...index.values()].filter((a) => !a.local_path).length;
  meta.video_usable = [...index.values()].filter((a) => a.usable_as_video === true).length;
  meta.non_video_paths = [...index.values()].filter((a) => a.local_path && a.media_kind !== 'video').length;
  return { index, meta };
}

const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|tiff?)$/i;
export function mediaKindOf(p) {
  if (!p) return 'unknown';
  if (VIDEO_EXT.test(p)) return 'video';
  if (IMAGE_EXT.test(p)) return 'image';
  return 'unknown';
}

// ---- 4. 价值标签（可解释；不使用数值阈值） ---------------------------------------
export function deriveValueLabels(rec) {
  const labels = [];
  const hasMetric = rec.metrics.some((m) => ENGAGEMENT_FIELDS.has(m.field)
    && (m.status === OBSERVATION_STATUS.VALUE || m.status === OBSERVATION_STATUS.OBSERVED_ZERO));
  if (hasMetric) {
    labels.push({
      category: 'performance_reference',
      reason: '存在同平台同观测的可用互动计量；可在同平台同口径可比集合内作描述性比较（非跨平台全局排名）。',
      evidence: rec.metrics.filter((m) => ENGAGEMENT_FIELDS.has(m.field) && m.status !== OBSERVATION_STATUS.ABSENT).map((m) => m.field),
    });
  }
  if (rec.assets.length > 0) {
    labels.push({
      category: 'creative_reference',
      reason: '本地已有可播放原媒体与该来源的既有分析卡；可用于看表达结构。',
      evidence: rec.assets.map((a) => a.asset_id),
    });
  }
  const prodEvidence = rec.metrics.filter((m) => (m.field === 'product_linked_identity' || m.field === 'product_tag_or_eligibility')
    && m.status !== OBSERVATION_STATUS.ABSENT
    && !(m.status === OBSERVATION_STATUS.OBSERVED_ZERO));
  if (prodEvidence.length > 0) {
    labels.push({
      category: 'product_demand_clue',
      reason: '来源留存了商品关联/资格标记；仅表示该条视频挂有商品线索，**不**证明销量或需求规模。',
      evidence: prodEvidence.map((m) => m.field),
    });
  }
  return labels;
}

// ---- 5. 比率计算（同观测、分母>0；不支持即如实返回不支持） ------------------------
export function computeRatios(rec, ratioRules) {
  const out = [];
  for (const rule of Object.values(ratioRules)) {
    // 平台不适用时也显式记录一行，避免消费者把「没有该口径」误读成「值为 0」。
    if (!rule.platforms.includes(rec.platform)) {
      out.push({
        key: rule.key, status: 'not_applicable', value: null, unit: rule.unit,
        reason: `ratio_rule_not_defined_for_platform:${rec.platform}`,
        attribution: rule.attribution, source: rule.source,
      });
      continue;
    }
    // 按「同一次观测」分组：observed_at + source 必须一致
    const groups = new Map();
    for (const m of rec.metrics) {
      if (![...rule.numeratorFields, rule.denominatorField].includes(m.field)) continue;
      const gk = `${m.observed_at_epoch_s ?? 'na'}|${m.source_sha256 ?? m.source_file ?? 'na'}`;
      if (!groups.has(gk)) groups.set(gk, {});
      groups.get(gk)[m.field] = m;
    }
    let best = null;
    for (const [gk, g] of groups) {
      const denom = g[rule.denominatorField];
      const nums = rule.numeratorFields.map((f) => g[f]);
      if (!denom || nums.some((x) => !x)) continue;
      if (denom.status !== OBSERVATION_STATUS.VALUE && denom.status !== OBSERVATION_STATUS.OBSERVED_ZERO) continue;
      if (nums.some((x) => x.status !== OBSERVATION_STATUS.VALUE && x.status !== OBSERVATION_STATUS.OBSERVED_ZERO)) continue;
      const d = denom.numeric_value;
      if (d === null || !(d > 0)) continue; // 分母 0 / 缺失 → 不支持，不产生分数
      const sum = nums.reduce((a, x) => a + (x.numeric_value ?? 0), 0);
      best = {
        key: rule.key, status: 'computed', value: (sum / d) * rule.scale, unit: rule.unit,
        observation_group: gk,
        operands: Object.fromEntries([...rule.numeratorFields, rule.denominatorField].map((f) => [f, g[f].numeric_value])),
        attribution: rule.attribution, source: rule.source,
        saves: rule.savesField ?? null,
        saves_status: rule.savesField ? 'see_field' : OBSERVATION_STATUS.ABSENT,
      };
      break;
    }
    if (!best) {
      const denomObs = rec.metrics.filter((m) => m.field === rule.denominatorField);
      let why = 'no_same_observation_group_with_all_operands';
      let status = OBSERVATION_STATUS.UNKNOWN;
      if (denomObs.length === 0) { status = OBSERVATION_STATUS.ABSENT; why = 'denominator_field_absent_in_retained_evidence'; }
      else if (denomObs.every((m) => m.status === OBSERVATION_STATUS.OBSERVED_ZERO)) { status = OBSERVATION_STATUS.OBSERVED_ZERO; why = 'denominator_observed_zero_ratio_undefined'; }
      else if (denomObs.every((m) => m.status === OBSERVATION_STATUS.UNAVAILABLE_SOURCE || m.status === OBSERVATION_STATUS.UNKNOWN)) { status = OBSERVATION_STATUS.UNAVAILABLE_SOURCE; why = 'source_unavailable_for_denominator'; }
      best = { key: rule.key, status, value: null, unit: rule.unit, reason: why, attribution: rule.attribution, source: rule.source };
    }
    out.push(best);
  }
  return out;
}

// ---- 6. 单实体归一化 -------------------------------------------------------------
export function normalizeEntity(entityRaw, fieldRows, opts = {}) {
  const { mediaIndex = new Map(), ratioRules = RATIO_RULES } = opts;
  const platform = entityRaw.platform;
  const namespace = entityRaw.namespace;
  const nativeId = String(entityRaw.native_id);
  const ek = entityKey(platform, namespace, nativeId);
  const slug = slugFor(platform, namespace) ?? platform.toLowerCase();
  const branch = [...PLATFORMS, AID_BRANCH].find((p) => p.key === platform && p.namespace === namespace)?.label ?? platform;

  const metrics = (fieldRows ?? []).map(normalizeFieldObservation);
  metrics.sort((a, b) => String(a.field).localeCompare(String(b.field)) || (a.observed_at_epoch_s ?? 0) - (b.observed_at_epoch_s ?? 0));

  const byStatus = {};
  for (const m of metrics) byStatus[m.status] = (byStatus[m.status] ?? 0) + 1;

  const first = (f, pred = () => true) => metrics.find((m) => m.field === f && pred(m)) ?? null;
  const usable = (m) => m && (m.status === OBSERVATION_STATUS.VALUE || m.status === OBSERVATION_STATUS.OBSERVED_ZERO);

  const joined = fieldRows !== null && fieldRows !== undefined && fieldRows.length > 0;
  const entitySourceState = joined
    ? 'observed'
    : (JOIN_REASON_TO_SOURCE_STATE[entityRaw.fields?.reason_class] ?? OBSERVATION_STATUS.UNAVAILABLE_SOURCE);

  const pubTime = first('publication_time');
  const pubLabel = first('publication_time_label');
  const observedTimes = metrics.map((m) => m.observed_at_epoch_s).filter((x) => typeof x === 'number');

  const fingerprintInput = metrics.map((m) => [m.field, m.status, m.value, m.observed_at_epoch_s, m.source_sha256 ?? m.source_file].join('~')).sort().join('\n');

  const rec = {
    entity_key: ek,
    platform,
    platform_slug: slug,
    namespace,
    branch,
    native_id: nativeId,               // 字符串：>2^53 的 id 不失真
    aid_branch: namespace === 'aid',
    identity: {
      canonical_url: usable(first('canonical_url')) ? first('canonical_url').value : null,
      derived_permalink: usable(first('derived_permalink')) ? first('derived_permalink').value : null,
      author_id: usable(first('author_id')) ? first('author_id').value : null,
      author_display_name: usable(first('author_display_name')) ? first('author_display_name').value : null,
      author_follower_count: usable(first('author_follower_count')) ? first('author_follower_count').numeric_value : null,
      media_type: usable(first('media_type')) ? first('media_type').value : null,
      duration_seconds: usable(first('duration')) ? first('duration').numeric_value : null,
    },
    classification: {
      product_category: 'unknown',   // 普查未留存类别字段
      product_function: 'unknown',
      scene_or_need: 'unknown',
      // F4：明确这三类当前**没有来源支持**；只有人工复核可赋值，并保留来源归属/复核人/证据/状态
      product_category_origin: 'unknown_no_source',
      product_function_origin: 'unknown_no_source',
      scene_or_need_origin: 'unknown_no_source',
      product_category_reviewer: null, product_function_reviewer: null, scene_or_need_reviewer: null,
      product_category_evidence_ref: null, product_function_evidence_ref: null, scene_or_need_evidence_ref: null,
      product_category_state: null, product_function_state: null, scene_or_need_state: null,
      language: usable(first('language')) ? first('language').value : (entitySourceState === 'observed' ? 'unknown' : entitySourceState),
      platform,
      publish_date_epoch_s: usable(pubTime) ? pubTime.numeric_value : null,
      publish_date_label: usable(pubLabel) ? pubLabel.value : null,
      review_status: 'unreviewed',
      classification_basis: 'source_supported_only',
    },
    window: {
      in_window_by_decision: entityRaw.decision === DECISION_INCLUDE,
      publication_time_epoch_s: usable(pubTime) ? pubTime.numeric_value : null,
      date_basis: entityRaw.date_evidence?.basis ?? null,
      date_anchor: entityRaw.date_evidence?.anchor ?? null,
    },
    availability: {
      entity_source_state: entitySourceState,
      join_reason_class: entityRaw.fields?.reason_class ?? null,
      fields_observed: metrics.length,
      by_status: byStatus,
      observed_at_min: observedTimes.length ? Math.min(...observedTimes) : null,
      observed_at_max: observedTimes.length ? Math.max(...observedTimes) : null,
    },
    metrics,
    ratios: [],
    value_labels: [],
    assets: [],
    review: {
      status: 'unreviewed',
      reviewer: null,
      reviewed_at: null,
      notes: [],
      human_value_categories: [],
      selected_reference: false,
      stale: false,
      stale_reason: null,
    },
    provenance: {
      decision: entityRaw.decision,
      applied_correction: entityRaw.applied_correction ?? null,
      identity_confidence: entityRaw.identity?.confidence ?? null,
      observations: entityRaw.identity?.observations ?? null,
      ad_status: entityRaw.ad_status ?? null,
      provenance_class: entityRaw.provenance?.class ?? null,
      retained_path: entityRaw.provenance?.retained_path ?? null,
      sha256_verified: entityRaw.provenance?.sha256_verified ?? null,
      observation_status: entityRaw.observation_origin?.status ?? null,
      lineage: entityRaw.lineage ?? [],
    },
    evidence_fingerprint: sha256Hex(fingerprintInput),
    evidence_fingerprint_basis: { field_rows: metrics.length, rule: 'sha256(field~status~value~observed_at~source per row, sorted)' },
  };

  const asset = mediaIndex.get(ek);
  if (asset) {
    const exists = asset.local_path ? fs.existsSync(asset.local_path) : false;
    // 片段的 fact_origin 一律由 kind 重新推出，不信任上游注入值（防止把分析判断升级为来源事实）
    const segments = (asset.segments ?? []).map((s) => ({
      ...s,
      fact_origin: s.kind === 'original_fact' ? 'source_fact' : 'derived_interpretation',
    }));
    rec.assets.push({
      ...asset,
      segments,
      segment_count: segments.length,
      verified_present_locally: exists,
      verification: exists ? 'file_present_at_recorded_path' : 'recorded_path_missing_on_disk',
    });
  }
  rec.ratios = computeRatios(rec, ratioRules);
  rec.value_labels = deriveValueLabels(rec);
  return rec;
}

// ---- 7. 全量构建 + 对账 -----------------------------------------------------------
export async function buildRecords(root = DEFAULT_ROOT, { ratioRules = {}, overlayPath = null } = {}) {
  const { decisions, raw, lineCount: entityLines, overlays } = await loadEntityDecisions(root);
  const { byEntity, lineCount: fieldLines } = await loadFieldValues(root);
  const { index: mediaIndex, meta: mediaMeta } = loadMediaIndex(root);

  const records = [];
  const gaps = [];
  const seen = new Set();

  for (const [ek, decision] of decisions) {
    if (decision !== DECISION_INCLUDE) continue;
    const er = raw.get(ek);
    const rows = byEntity.get(ek) ?? [];
    seen.add(ek);
    if (rows.length === 0) {
      gaps.push({
        entity_key: ek,
        platform: er.platform, namespace: er.namespace, native_id: String(er.native_id),
        reason_class: er.fields?.reason_class ?? 'unknown',
        reason: er.fields?.reason ?? null,
        impact: 'identity retained; imported with metadata/index-only fields and explicit unavailable-source state',
      });
    }
    records.push(normalizeEntity(er, rows, { mediaIndex, ratioRules }));
  }

  // 反向检查：字段层出现但决策层未纳入的实体（不应静默丢弃）
  const orphanFieldEntities = [];
  for (const ek of byEntity.keys()) if (!decisions.has(ek)) orphanFieldEntities.push(ek);

  const perBranch = {};
  for (const r of records) {
    const b = `${r.platform}|${r.namespace}`;
    perBranch[b] = (perBranch[b] ?? 0) + 1;
  }
  // 应用人工复核覆盖层（人工字段与来源事实分开保存）
  // F5：覆盖层路径可显式指定，测试/旅程必须用隔离夹具，绝不写正式覆盖层
  const overlay = loadOverlay(root, overlayPath);
  const overlayResult = applyOverlay(records, overlay);
  const mainTotal = records.filter((r) => !r.aid_branch).length;
  const aidTotal = records.filter((r) => r.aid_branch).length;

  const mismatch = [];
  for (const p of PLATFORMS) {
    const got = perBranch[`${p.key}|${p.namespace}`] ?? 0;
    if (got !== p.expectedV) mismatch.push({ branch: `${p.key}|${p.namespace}`, expected: p.expectedV, got });
  }
  const aidGot = perBranch[`${AID_BRANCH.key}|${AID_BRANCH.namespace}`] ?? 0;
  if (aidGot !== AID_BRANCH.expectedV) mismatch.push({ branch: 'Bilibili|aid', expected: AID_BRANCH.expectedV, got: aidGot });

  // 既有媒体资产清单：与主口径分开标识；不在 V8420 队列内的资产不得被丢弃，也不得改变分母。
  const cohortKeys = new Set(records.map((r) => r.entity_key));
  const mediaAssets = [...mediaIndex.values()].map((a) => ({
    ...a,
    in_primary_cohort: cohortKeys.has(entityKey(a.platform, 'main', a.native_id)),
    cohort_label: cohortKeys.has(entityKey(a.platform, 'main', a.native_id))
      ? 'media asset whose identity is proven inside the frozen census cohort'
      : 'media asset outside the frozen census cohort (kept separately; does NOT alter V8420)',
  }));

  return {
    records, gaps, orphanFieldEntities, overlays, mediaAssets,
    human_review_overlay: overlayResult,
    reconciliation: {
      expected_main_v: EXPECTED_MAIN_V, actual_main_v: mainTotal,
      expected_aid_v: AID_BRANCH.expectedV, actual_aid_v: aidTotal,
      per_branch: perBranch, mismatches: mismatch,
      ok: mainTotal === EXPECTED_MAIN_V && aidGot === AID_BRANCH.expectedV && mismatch.length === 0,
      source_lines: { entity_decisions: entityLines, field_values: fieldLines },
      media: mediaMeta,
      note: 'aid 分支单列，永不并入合并唯一总数。',
    },
  };
}

export function summaryOf(records) {
  const byStatus = {};
  let withAssets = 0, withRatios = 0, withLabels = 0, unavailableSource = 0;
  for (const r of records) {
    for (const [k, v] of Object.entries(r.availability.by_status)) byStatus[k] = (byStatus[k] ?? 0) + v;
    if (r.assets.length) withAssets++;
    if (r.ratios.some((x) => x.status === 'computed')) withRatios++;
    if (r.value_labels.length) withLabels++;
    if (r.availability.entity_source_state !== 'observed') unavailableSource++;
  }
  return { records: records.length, with_assets: withAssets, with_computed_ratio: withRatios, with_value_labels: withLabels, unavailable_source_entities: unavailableSource, metric_observation_status_totals: byStatus };
}
