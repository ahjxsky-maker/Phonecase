// tools/material-library/tests/phase1.test.mjs
// 聚焦语义测试（node:test）。用合成小样验证本适配器/归一化的**语义**，
// 不重跑普查、不联网、不连接 Baserow。
//
// 明确边界：这些测试通过**不能**证明 Baserow 可用；Baserow 验收仍为阻断（见检查点 §3）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { authorizedSubtreeFor, describeFixtureRoot, fixtureRoot, mkFixtureDir, resolveRealPath, W_ROOT } from './fixture-root.mjs';
import { startBaserowDouble, readStore } from './baserow-double.mjs';
import { runCli, runDeliveredSequence } from './r8-sequence.mjs';
import {
  OBSERVATION_STATUS, RULES_VERSION, normalizeFieldObservation,
  observationIdentity, loadRulesConfig, slugFor, v5MeaningFor,
  V5_VALUE_SEMANTICS, CENSUS_FIELD_TO_V5_MEANING,
} from '../rules.mjs';
import { mediaKindOf, normalizeEntity } from '../normalize.mjs';
import {
  KEY_METRIC_FIELDS, indexLatestRealMetrics, keyMetricsOf, countRealObservations,
  metricNumber, isRealObservation, businessTitleOf, shortKey, reviewStatusTerm,
  sourceStateTerm, formatMetricValue, sortByIndustryPriority, industryPriorityKey,
} from '../panel-metrics.mjs';
import { applyOverlay, loadOverlay, saveOverlay, setReview, splitTestIdentities } from '../review.mjs';
import { applyTargetEdit, filterByNeed, lookupTarget, runJourney } from '../journey.mjs';
import { buildRepresentativeSample, coverageOf, resolveManifest, validateManifest } from '../sample.mjs';
import { createMediaIndex, createMediaServer, playerCheck, verifyMediaRoute } from '../media.mjs';
import {
  HUMAN_FIELDS, TABLE_ASSETS, TABLE_METRICS, TABLE_PRIMARY_KEY, TABLE_RATIOS, TABLE_SEGMENTS, TABLE_VIDEOS,
  ALL_TABLES, HTTP_ROUTES, createHttpBackend, createHttpClient, createMemoryBackend,
  decodeApiRow, detectDuplicateTargetKeys, encodeFilterValue, encodeWritePayload, ensureSchemaAndViews,
  importRecords, logicalEqual, isIgnorableLinkOrderArtifact, isLinkShaped, linkFieldNames,
  LINK_FIELDS, REVERSE_LINK_FIELDS, parentRelationKeyField, reverseRelationExpectedIds,
  planMerge, planSchema, planViews, reconcileInterrupted, rowsOf,
} from '../baserow.mjs';

const entity = (over = {}) => ({
  platform: 'TikTok', namespace: 'main', native_id: '7677920051269455125',
  decision: 'INCLUDE_VIDEO',
  dimensions: { date: 'in_window_supported', type: 'video', advertising: 'no_ad_evidence', identity: 'high_single_observation', provenance: 'byte_verified_retained_copy' },
  date_evidence: { value_epoch: 1787655076, basis: 'absolute_epoch_recomputed', anchor: 'evidence/pages/tiktok.json' },
  identity: { confidence: 'high_single_observation', observations: 1, conflicts: [] },
  ad_status: { is_ad: false, conflicting: false, basis: 'page row ad_flag' },
  provenance: { class: 'byte_verified_retained_copy', retained_path: 'evidence/raw/x.txt', sha256_verified: 'a'.repeat(64), detail: null },
  fields: { joined: true, reason: null, reason_class: null },
  lineage: [],
  ...over,
});

const fieldRow = (field, availability, rawValue, over = {}) => ({
  platform: 'tiktok', namespace: 'main', native_id: '7677920051269455125',
  field, availability, raw_value: rawValue, unit: 'count', normalized_value: rawValue,
  unit_basis: null, approx_value: null, zero_valued: rawValue === 0 ? true : null,
  derived: false, derivation: null, product_ids: null, reason: null, not_engagement: false,
  source: { file: 'evidence/raw/tiktok.txt', sha256: 'b'.repeat(64) },
  locator: 'data.data.items[0].statistics.digg_count', observed_at_epoch_s: 1790011196,
  observation_basis: 'one retained response copy', identity_basis: 'one retained response copy',
  retention_grade: 'retained_response_copy',
  ...over,
});

test('rules config is versioned and marks cutoffs as unapproved proposals', () => {
  const cfg = loadRulesConfig();
  assert.equal(cfg.rules_version, RULES_VERSION);
  assert.equal(cfg.proposed_cutoffs.status, 'PROPOSED_NOT_APPROVED');
  assert.ok(cfg.proposed_cutoffs.proposals.every((p) => p.approved === false));
  assert.equal(cfg.expected_main_v, 8420);
  assert.equal(cfg.aid_branch.expectedV, 222);
});

test('observed zero is NOT absent and absent never carries a value', () => {
  const zero = normalizeFieldObservation(fieldRow('engagement_like', 'present_and_usable', 0));
  const absent = normalizeFieldObservation(fieldRow('engagement_share', 'absent_in_inspected_source', null));
  assert.equal(zero.status, OBSERVATION_STATUS.OBSERVED_ZERO);
  assert.equal(zero.value, '0');
  assert.notEqual(zero.status, OBSERVATION_STATUS.ABSENT);
  assert.equal(absent.status, OBSERVATION_STATUS.ABSENT);
  assert.equal(absent.value, null);
  // unusable 是第三种状态，既不等于缺失也不等于零
  const unusable = normalizeFieldObservation(fieldRow('engagement_play', 'present_but_ambiguous_or_unusable', 12));
  assert.equal(unusable.status, OBSERVATION_STATUS.UNUSABLE);
});

test('long numeric id beyond 2^53 stays a lossless string', () => {
  const id = '7677920051269455125';
  const rec = normalizeEntity(entity({ native_id: id }), [fieldRow('engagement_like', 'present_and_usable', 5)]);
  assert.equal(typeof rec.native_id, 'string');
  assert.equal(rec.native_id, id);
  assert.notEqual(String(Number(id)), id, 'precondition: Number() would be lossy');
  const row = rowsOf([rec])[TABLE_VIDEOS][0];
  assert.equal(row.native_id, id);
});

test('same platform id text in distinct namespaces are distinct entities', () => {
  const a = normalizeEntity(entity({ platform: 'Bilibili', namespace: 'main', native_id: '116383866165406' }), []);
  const b = normalizeEntity(entity({ platform: 'Bilibili', namespace: 'aid', native_id: '116383866165406' }), []);
  assert.notEqual(a.entity_key, b.entity_key);
  assert.equal(a.aid_branch, false);
  assert.equal(b.aid_branch, true);
  assert.equal(slugFor('Bilibili', 'aid'), 'bilibili');
});

test('TikTok ratio requires the same observation and a positive denominator', () => {
  const rows = [
    fieldRow('engagement_like', 'present_and_usable', 10),
    fieldRow('engagement_comment', 'present_and_usable', 5),
    fieldRow('engagement_share', 'present_and_usable', 5),
    fieldRow('engagement_play', 'present_and_usable', 1000),
  ];
  const rec = normalizeEntity(entity(), rows);
  const r = rec.ratios.find((x) => x.key === 'tiktok_engagement_rate');
  assert.equal(r.status, 'computed');
  assert.equal(r.value, 2); // (10+5+5)/1000*100
  assert.equal(r.saves_status, OBSERVATION_STATUS.ABSENT); // 收藏未被留存 → absent，不填 0

  // 分子来自另一次观测 → 不得拼接计算
  const split = [
    fieldRow('engagement_like', 'present_and_usable', 10, { observed_at_epoch_s: 1 }),
    fieldRow('engagement_comment', 'present_and_usable', 5, { observed_at_epoch_s: 2 }),
    fieldRow('engagement_share', 'present_and_usable', 5, { observed_at_epoch_s: 2 }),
    fieldRow('engagement_play', 'present_and_usable', 1000, { observed_at_epoch_s: 2 }),
  ];
  const rec2 = normalizeEntity(entity(), split);
  const r2 = rec2.ratios.find((x) => x.key === 'tiktok_engagement_rate');
  assert.notEqual(r2.status, 'computed');
  assert.equal(r2.value, null);
});

test('zero denominator yields no score (not zero, not infinity)', () => {
  const rows = [
    fieldRow('engagement_like', 'present_and_usable', 0),
    fieldRow('engagement_comment', 'present_and_usable', 0),
    fieldRow('engagement_share', 'present_and_usable', 0),
    fieldRow('engagement_play', 'present_and_usable', 0),
  ];
  const rec = normalizeEntity(entity(), rows);
  const r = rec.ratios.find((x) => x.key === 'tiktok_engagement_rate');
  assert.equal(r.status, OBSERVATION_STATUS.OBSERVED_ZERO);
  assert.equal(r.value, null);
});

test('unsupported platform ratio returns absent rather than a fabricated score', () => {
  const rec = normalizeEntity(entity({ platform: 'Douyin', native_id: '7123456789012345678' }), [fieldRow('engagement_like', 'present_and_usable', 3)]);
  const r = rec.ratios.find((x) => x.key === 'tiktok_engagement_rate');
  assert.notEqual(r.status, 'computed');
  assert.equal(r.value, null);
});

test('missing retained source is explicit and still produces an importable row', () => {
  const rec = normalizeEntity(entity({
    native_id: '9999999999999999999',
    fields: { joined: false, reason: 'no retained response copy exists for TikTok at all (source_unavailable)', reason_class: 'no_retained_copy_for_platform' },
  }), []);
  assert.equal(rec.availability.entity_source_state, OBSERVATION_STATUS.UNAVAILABLE_SOURCE);
  assert.equal(rec.metrics.length, 0);
  assert.deepEqual(rec.assets, []);
  const row = rowsOf([rec])[TABLE_VIDEOS][0];
  assert.equal(row.entity_source_state, 'source_unavailable');
});

test('event-driven identity includes platform, namespace, time and source continuity', () => {
  const o = { platform: 'TikTok', namespace: 'main', native_id: '1', field: 'engagement_like', observed_at_epoch_s: 111, source_sha256: 'abc' };
  assert.equal(observationIdentity(o), 'TikTok|main|1|engagement_like|111|abc');
  const o2 = { ...o, namespace: 'aid' };
  assert.notEqual(observationIdentity(o), observationIdentity(o2));
});

test('identical import replay adds zero duplicates', async () => {
  const recs = [normalizeEntity(entity(), [fieldRow('engagement_like', 'present_and_usable', 7)])];
  const backend = createMemoryBackend();
  for (const t of ALL_TABLES) await backend.createTable(t);
  const first = await importRecords({ records: recs, backend, mode: 'test' });
  const second = await importRecords({ records: recs, backend, mode: 'test' });
  assert.equal(first.videos.inserted, 1);
  assert.equal(second.videos.inserted, 0);
  assert.equal(second.videos.updated, 0);
  assert.equal(second.videos.unchanged, 1);
  assert.equal(backend.listRows(TABLE_METRICS).length, first.planned[TABLE_METRICS]);
});

test('human notes survive reimport and evidence change marks stale instead of carrying approval', async () => {
  const rec = normalizeEntity(entity(), [fieldRow('engagement_like', 'present_and_usable', 7)]);
  const backend = createMemoryBackend();
  for (const t of ALL_TABLES) await backend.createTable(t);
  await importRecords({ records: [rec], backend, mode: 'test' });
  const key = rec.entity_key;
  backend.putRow(TABLE_VIDEOS, key, { ...backend.getRow(TABLE_VIDEOS, key), review_notes: '人工备注：演示开头 0-3 秒', review_status: 'reviewed', selected_reference: true });

  // 证据未变 → 复跑不动人工字段
  await importRecords({ records: [rec], backend, mode: 'test' });
  let row = backend.getRow(TABLE_VIDEOS, key);
  assert.equal(row.review_notes, '人工备注：演示开头 0-3 秒');
  assert.equal(row.review_status, 'reviewed');
  assert.equal(row.selected_reference, true);
  assert.equal(row.review_stale, false);

  // 证据变化 → 保留备注文本，但依赖判断失效
  const changed = { ...rec, evidence_fingerprint: 'f'.repeat(64) };
  await importRecords({ records: [changed], backend, mode: 'test' });
  row = backend.getRow(TABLE_VIDEOS, key);
  assert.equal(row.review_notes, '人工备注：演示开头 0-3 秒');
  assert.equal(row.review_stale, true);
  assert.match(row.review_stale_reason, /evidence_changed/);
  assert.equal(row.review_status, 'reviewed', '人工字段本身不被自动改写；由人工在复核时处理');
});

test('interrupted write is reconciled before replay without duplicating', async () => {
  const recs = [0, 1, 2].map((i) => normalizeEntity(entity({ native_id: `767792005126945512${i}` }), []));
  const backend = createMemoryBackend();
  for (const t of ALL_TABLES) await backend.createTable(t);
  // 模拟中断：只写入了前两条
  await importRecords({ records: recs.slice(0, 2), backend, mode: 'test' });
  const rec = await reconcileInterrupted({ plannedKeys: recs.map((r) => r.entity_key), backend });
  assert.equal(rec.present_count, 2);
  assert.equal(rec.missing_count, 1);
  assert.equal(rec.safe_to_replay, 'replay_missing_only');
  const replay = await importRecords({ records: recs, backend, mode: 'test' });
  assert.equal(replay.videos.inserted, 1, '只补缺失的一条');
  assert.equal(replay.videos.updated, 0, '已存在的两条不重复写入');
  assert.equal(backend.listRows(TABLE_VIDEOS).length, 3);
});

test('platform/namespace mismatch is refused rather than merged', () => {
  const rec = normalizeEntity(entity(), []);
  const incoming = rowsOf([rec])[TABLE_VIDEOS];
  const tampered = [{ ...incoming[0], namespace: 'aid' }];
  const m = planMerge(tampered, incoming);
  assert.equal(m.rejected.length, 1);
  assert.match(m.rejected[0].reason, /namespace_or_platform_mismatch_refused/);
});

test('value labels are evidence-based and never claim sales or cross-platform ranking', () => {
  const rec = normalizeEntity(entity(), [
    fieldRow('engagement_like', 'present_and_usable', 10),
    fieldRow('product_linked_identity', 'present_and_usable', 'sku-1', { unit: 'product_id_set', derived: false }),
  ]);
  const cats = rec.value_labels.map((l) => l.category);
  assert.ok(cats.includes('performance_reference'));
  assert.ok(cats.includes('product_demand_clue'));
  for (const l of rec.value_labels) {
    assert.doesNotMatch(l.reason, /销量证明|跨平台排名/, l.category);
  }
  assert.equal(rec.classification.product_category, 'unknown');
  assert.equal(rec.classification.product_function, 'unknown');
});

test('human-owned fields are declared and excluded from generated updates', () => {
  assert.ok(HUMAN_FIELDS.includes('review_notes'));
  assert.ok(HUMAN_FIELDS.includes('selected_reference'));
  assert.ok(!HUMAN_FIELDS.includes('evidence_fingerprint'));
});

test('missing media is explicit, present asset is verified on disk', () => {
  const none = normalizeEntity(entity(), []);
  assert.deepEqual(none.assets, []);
  const tmp = mkFixtureDir('ml-asset-');
  const f = path.join(tmp, 'a.mp4');
  fs.writeFileSync(f, 'x');
  const idx = new Map([['TikTok|main|7677920051269455125', {
    asset_id: 'tiktok-1', platform: 'TikTok', native_id: '7677920051269455125',
    cohort: 'test', local_path: f, sha256: 'c'.repeat(64), bytes: 1, duration_seconds: 1,
    resolution: '1x1', contact_sheet: null, card_file: null, timeline_entries: 1, rights_status: 'unknown',
  }]]);
  const rec = normalizeEntity(entity(), [], { mediaIndex: idx });
  assert.equal(rec.assets.length, 1);
  assert.equal(rec.assets[0].verified_present_locally, true);
  assert.ok(rec.value_labels.some((l) => l.category === 'creative_reference'));
});

test('media type guard: contact sheets are never classified as video', () => {
  // 成果总览「阅读陷阱」第2条：抖音卡的 media_evidence.file 指向接触表(JPG)，不是 MP4。
  assert.equal(mediaKindOf('x/y/7673474988641676657.sheet.jpg'), 'image');
  assert.equal(mediaKindOf('x/y/7673474988641676657.png'), 'image');
  assert.equal(mediaKindOf('x/y/7673474988641676657-play_addr.mp4'), 'video');
  assert.equal(mediaKindOf('x/y/clip.MOV'), 'video');
  assert.equal(mediaKindOf('x/y/blob.bin'), 'unknown');
  assert.equal(mediaKindOf(null), 'unknown');

  // 资产合同必须显式暴露媒体类型与可播放性，供消费者区分「有媒体」与「有视频」
  const assetsTable = planSchema().tables.find((t) => t.name === TABLE_ASSETS);
  const names = assetsTable.fields.map((f) => f.name);
  for (const f of ['media_kind', 'usable_as_video', 'kind_reject_reason', 'local_path_recorded', 'path_source', 'sha256_match']) {
    assert.ok(names.includes(f), `Assets 缺少字段 ${f}`);
  }
  assert.ok(names.includes('local_path'));
});

test('asset rows carry absolute path, kind and hash-verification flags', () => {
  const rec = normalizeEntity(entity(), [], {
    mediaIndex: new Map([['TikTok|main|7677920051269455125', {
      asset_id: 'tiktok-x', platform: 'TikTok', native_id: '7677920051269455125', cohort: 'test',
      local_path: 'D:/abs/a.mp4', local_path_recorded: 'outputs/a.mp4', path_source: 'card.media_evidence.file',
      path_is_absolute: true, media_kind: 'video', usable_as_video: true, kind_reject_reason: null,
      sha256: 'd'.repeat(64), sha256_match: true, bytes: 10, actual_bytes: 10,
      duration_seconds: 1, resolution: '1x1', contact_sheet: null, card_file: null,
      timeline_entries: 1, rights_status: 'unknown',
    }]]),
  });
  const row = rowsOf([rec])[TABLE_ASSETS][0];
  assert.equal(row.path_source, 'card.media_evidence.file');
  assert.equal(row.media_kind, 'video');
  assert.equal(row.usable_as_video, true);
  assert.equal(row.local_path_recorded, 'outputs/a.mp4');
  assert.equal(row.sha256_match, true);
});

test('invalid values become error, distinct from absent and observed zero', () => {
  // 安全隔离反例：普查判为 present_and_usable 但值本身不合类型/单位契约时，必须落到 error，
  // 且与 absent / observed_zero 明确不同。（真实留存数据上实测 error=0，见 verify。）
  const cases = [
    ['engagement_like', 'not-a-number', 'count_field_value_not_numeric'],
    ['engagement_like', -5, 'count_field_negative'],
    ['publication_time', 1787655076.5, 'epoch_field_not_positive_integer'],
    ['publication_time', 0, 'epoch_field_not_positive_integer'],
    ['canonical_url', 'ftp://example.com/x', 'url_field_not_http_url'],
  ];
  for (const [field, value, reason] of cases) {
    const o = normalizeFieldObservation(fieldRow(field, 'present_and_usable', value, {
      normalized_value: value, unit: null,
    }));
    assert.equal(o.status, OBSERVATION_STATUS.ERROR, `${field}=${value} 应为 error`);
    assert.equal(o.error_reason, reason, `${field}=${value} 的 error 原因`);
    assert.equal(o.source_availability, 'present_and_usable', 'error 不得抹掉来源可用性事实');
  }

  // 三者必须互相区分
  const err = normalizeFieldObservation(fieldRow('engagement_like', 'present_and_usable', 'x', { normalized_value: 'x' }));
  const zero = normalizeFieldObservation(fieldRow('engagement_like', 'present_and_usable', 0));
  const absent = normalizeFieldObservation(fieldRow('engagement_like', 'absent_in_inspected_source', null));
  const statuses = new Set([err.status, zero.status, absent.status]);
  assert.equal(statuses.size, 3, 'error / observed_zero / absent 必须三种不同状态');

  // derived_permalink 的 value 是 id、URL 在 derivation 模板里 → 不得误判为 error
  const derivedOk = normalizeFieldObservation(fieldRow('derived_permalink', 'present_and_usable', '116383866165406', {
    unit: 'derived_string', derived: true, derivation: 'https://www.bilibili.com/video/av<aid>',
  }));
  assert.notEqual(derivedOk.status, OBSERVATION_STATUS.ERROR, '合法的派生链接不得被判为 error');
  assert.equal(derivedOk.fact_origin, 'derived');
  const derivedBadTemplate = normalizeFieldObservation(fieldRow('derived_permalink', 'present_and_usable', '116383866165406', {
    unit: 'derived_string', derived: true, derivation: 'av<aid>',
  }));
  assert.equal(derivedBadTemplate.status, OBSERVATION_STATUS.ERROR);
  assert.equal(derivedBadTemplate.error_reason, 'derivation_template_not_http_url');

  // 消费方行里 error 仍然是独立状态
  const rec = normalizeEntity(entity(), [fieldRow('engagement_like', 'present_and_usable', -1, { normalized_value: -1 })]);
  const metricRow = rowsOf([rec])[TABLE_METRICS][0];
  assert.equal(metricRow.status, 'error');
  assert.equal(metricRow.value_text, '-1');
});

test('fact origin separates source facts from derived values on every observation', () => {
  const rows = [
    fieldRow('engagement_like', 'present_and_usable', 10),
    fieldRow('derived_permalink', 'present_and_usable', '116383866165406', { unit: 'derived_string', derived: true, derivation: 'https://www.bilibili.com/video/av<aid>' }),
  ];
  const rec = normalizeEntity(entity(), rows);
  for (const m of rec.metrics) {
    assert.ok(['source_fact', 'derived'].includes(m.fact_origin), `未知 fact_origin: ${m.fact_origin}`);
    assert.equal(m.fact_origin, m.derived ? 'derived' : 'source_fact');
  }
  assert.ok(rec.metrics.some((m) => m.fact_origin === 'derived'));
  const metricRows = rowsOf([rec])[TABLE_METRICS];
  assert.ok(metricRows.every((r) => ['source_fact', 'derived'].includes(r.fact_origin)));
  // 人工复核在记录层，不混进观测层
  assert.equal(rec.review.status, 'unreviewed');
});

test('segment references carry origin, kind, coverage and separate human review fields', () => {
  const seg = {
    segment_id: 'TikTok|main|1|0|0', index: 0, t_label: '00:00.000', start_seconds: 0,
    observed: '俯拍静态产品镜头', onscreen_text: '『Leoparded Cases』', speech: null,
    kind: 'original_fact', fact_origin: 'source_fact',
    origin_card: 'cards/tiktok-1.json', origin_method: 'per_tile_exact_seek',
    time_accuracy_note: '帧选取层 ≤1 帧间隔', coverage: 'sparse_sampled_tiles_only',
    review_status: 'unreviewed', selected_reference: false, human_note: null,
  };
  const rec = normalizeEntity(entity(), [], {
    mediaIndex: new Map([['TikTok|main|7677920051269455125', {
      asset_id: 'tiktok-x', platform: 'TikTok', native_id: '7677920051269455125', cohort: 'test',
      local_path: 'D:/abs/a.mp4', media_kind: 'video', usable_as_video: true,
      segments: [seg], segment_count: 1,
    }]]),
  });
  assert.equal(rec.assets[0].segments.length, 1);
  const rows = rowsOf([rec])[TABLE_SEGMENTS];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].origin_card, 'cards/tiktok-1.json');
  assert.equal(rows[0].kind, 'original_fact');
  assert.equal(rows[0].fact_origin, 'source_fact');
  assert.equal(rows[0].coverage, 'sparse_sampled_tiles_only');
  assert.equal(rows[0].review_status, 'unreviewed');
  // 人工字段必须被声明为人工所有，导入时不得覆盖
  assert.ok(HUMAN_FIELDS.includes('human_note'));
  assert.ok(HUMAN_FIELDS.includes('selected_reference'));
  // Segments 表 schema 必须存在且带人工字段
  const t = planSchema().tables.find((x) => x.name === TABLE_SEGMENTS);
  assert.ok(t, 'Segments 表缺失');
  const names = t.fields.map((f) => f.name);
  for (const f of ['origin_card', 'origin_method', 'kind', 'fact_origin', 'coverage', 'review_status', 'selected_reference', 'human_note']) {
    assert.ok(names.includes(f), `Segments 缺少字段 ${f}`);
  }
  // 解析判断不得被升级为来源事实
  const interp = normalizeEntity(entity(), [], {
    mediaIndex: new Map([['TikTok|main|7677920051269455125', {
      asset_id: 'a', platform: 'TikTok', native_id: '7677920051269455125', cohort: 't',
      local_path: 'D:/abs/a.mp4', segments: [{ ...seg, kind: 'interpretation' }],
    }]]),
  });
  assert.equal(rowsOf([interp])[TABLE_SEGMENTS][0].fact_origin, 'derived_interpretation');
});

test('P4 detail exposes metric definitions and never claims cross-platform comparability', () => {
  const rows = [
    fieldRow('engagement_play', 'present_and_usable', 1000),
    fieldRow('sales_quantity', 'absent_in_inspected_source', null),
    fieldRow('product_price', 'present_and_usable', '￥39.9', { unit: 'string', normalized_value: null }),
  ];
  const rec = normalizeEntity(entity(), rows);
  for (const m of rec.metrics) {
    assert.ok(m.metric_definition && m.metric_definition.length > 0, `${m.field} 缺少指标定义`);
    assert.equal(m.comparable_across_platforms, false, `${m.field} 不得声称跨平台可比`);
  }
  const play = rec.metrics.find((m) => m.field === 'engagement_play');
  assert.match(play.metric_definition, /views|播放/);
  assert.match(play.metric_caveat, /不可比|定义不同/);
  // 销量无留存 → 定义里必须明确不得用热度代理
  const sales = rec.metrics.find((m) => m.field === 'sales_quantity');
  assert.match(sales.metric_caveat, /无留存|不得由热度代理/);
  const metricRows = rowsOf([rec])[TABLE_METRICS];
  assert.ok(metricRows.every((r) => r.metric_definition && r.comparable_across_platforms === false));
});

test('P4 view plan covers the required filter dimensions and keeps unknowns visible', () => {
  const views = planViews();
  const video = views.filter((v) => v.table === TABLE_VIDEOS);
  const fields = new Set(video.flatMap((v) => (v.filters ?? []).map((f) => f.field)));
  for (const f of ['platform', 'language', 'publish_date_epoch_s', 'review_status', 'product_category']) {
    assert.ok(fields.has(f), `视图计划缺少 ${f} 维度的筛选`);
  }
  // 必须存在一个无过滤的「全部记录」视图，保证 unknown 不被隐藏
  assert.ok(video.some((v) => !(v.filters ?? []).length), '缺少无过滤的总览视图');
  // 分类缺口视图必须针对 unknown，而不是把它过滤掉
  const cat = video.find((v) => (v.filters ?? []).some((f) => f.field === 'product_category'));
  assert.equal(cat.filters.find((f) => f.field === 'product_category').value, 'unknown');
  // 片段视图存在
  assert.ok(views.some((v) => v.table === TABLE_SEGMENTS));
});

// ─────────────── R3 / F1–F6 修复回归（合同替身；不代表真实 Baserow 验收） ───────────────

// 最小 HTTP 合同替身：只记录调用并返回 Baserow 形状的响应。
// R4 扩展：按库作用域列目录（listTablesInDatabase）、视图过滤/排序可读回（对账需要），
// 以及可注入的字段元数据（single_select 的选项 ID 编码要用）。
function fakeClient({ pagesOf = {}, failCreateRow = false, tables = [], existingViews = {}, filters = {}, sorts = {}, fieldsOf = null } = {}) {
  const calls = [];
  const rowStore = new Map();
  const storedFilters = JSON.parse(JSON.stringify(filters));
  const storedSorts = JSON.parse(JSON.stringify(sorts));
  const viewsByTable = existingViews;
  const fieldsByTable = {};   // R4：字段清单必须**有状态**，否则复跑会重复建字段并每次拿到新 ID
  return {
    calls,
    auth_used: { mgmt: 'JWT', data: 'Token' },
    async ping() { calls.push(['ping']); return { version: '2.4.0' }; },
    async listTables() { calls.push(['listTables']); return tables; },
    async listTablesInDatabase(databaseId) {
      calls.push(['listTablesInDatabase', databaseId]);
      return tables.filter((t) => t.database_id === undefined || Number(t.database_id) === Number(databaseId));
    },
    async createTable(name, databaseId) { calls.push(['createTable', name, databaseId ?? null]); const t = { id: 900 + tables.length, name, database_id: Number(databaseId) }; tables.push(t); return t; },
    async listFields(tableId) {
      calls.push(['listFields', tableId]);
      if (fieldsOf?.[tableId]) return fieldsOf[tableId];
      fieldsByTable[tableId] ??= [{ id: 1, name: 'Name', type: 'text', primary: true }];
      return fieldsByTable[tableId];
    },
    async createField(tableId, body) {
      calls.push(['createField', tableId, body.name, body.type, body.link_row_table_id ?? null]);
      // 真实 Baserow 建字段会回带 select_options（含选项 ID）；单选项过滤值编码就靠这些 ID
      const field = {
        id: 500 + calls.length, name: body.name, type: body.type,
        select_options: (body.select_options ?? []).map((o, i) => ({ id: 1000 + i, value: o.value ?? o, color: o.color ?? 'light-blue' })),
      };
      fieldsByTable[tableId] ??= [{ id: 1, name: 'Name', type: 'text', primary: true }];
      fieldsByTable[tableId].push(field);
      return field;
    },
    async updateField(fieldId, patch) {
      calls.push(['updateField', fieldId, patch.name]);
      for (const list of Object.values(fieldsByTable)) {
        const f = list.find((x) => x.id === fieldId);
        if (f) { f.name = patch.name; return f; }
      }
      return { id: fieldId, name: patch.name };
    },
    async listRows(tableId, params) {
      calls.push(['listRows', tableId, params]);
      const page = Number((params.match(/page=(\d+)/) ?? [])[1] ?? 1);
      const pages = pagesOf[tableId] ?? [[]];
      const results = pages[page - 1] ?? [];
      return { results, next: page < pages.length ? 'x' : null, count: pages.flat().length };
    },
    async createRow(tableId, row) {
      calls.push(['createRow', tableId, row.entity_key ?? row.segment_id ?? '']);
      if (failCreateRow) { const e = new Error('simulated_http_500'); e.status = 500; throw e; }
      const rec = { id: 7000 + rowStore.size, ...row };
      rowStore.set(rec.id, rec);
      return rec;
    },
    async updateRow(tableId, rowId, patch) { calls.push(['updateRow', tableId, rowId]); return { id: rowId, ...patch }; },
    async listViews(tableId) { calls.push(['listViews', tableId]); return viewsByTable[tableId] ?? []; },
    async createView(tableId, v) {
      calls.push(['createView', tableId, v.name, v.type]);
      const view = { id: 800 + calls.length, table_id: tableId, ...v };
      (viewsByTable[tableId] ??= []).push(view);
      return view;
    },
    async listViewFilters(viewId) { calls.push(['listViewFilters', viewId]); return storedFilters[viewId] ?? []; },
    async createViewFilter(viewId, f) { calls.push(['createViewFilter', viewId, f.field, f.type, f.value]); (storedFilters[viewId] ??= []).push(f); return { id: calls.length, ...f }; },
    async listViewSortings(viewId) { calls.push(['listViewSortings', viewId]); return storedSorts[viewId] ?? []; },
    async createViewSort(viewId, s) { calls.push(['createViewSort', viewId, s.field, s.order]); (storedSorts[viewId] ??= []).push(s); return { id: calls.length, ...s }; },
  };
}

const twoRecs = () => [
  normalizeEntity(entity({ native_id: '7677920051269455125' }), [fieldRow('engagement_like', 'present_and_usable', 5)]),
  normalizeEntity(entity({ native_id: '7677920051269455126' }), [fieldRow('engagement_like', 'present_and_usable', 6)]),
];

test('F1: connectivity success with a failing row write must NOT produce a successful import receipt', async () => {
  const backend = createMemoryBackend({ failOnTable: TABLE_VIDEOS });
  await backend.createTable(TABLE_VIDEOS);
  const receipt = await importRecords({ records: twoRecs(), backend, mode: 'http_contract_double' });
  assert.equal(receipt.ok, false, '写入失败时不得给出成功回执');
  assert.ok(receipt.errors.length > 0, '必须记录写入错误');
  assert.equal(receipt.tables[TABLE_VIDEOS].inserted, 0);
});

test('F1: target readback is multi-page, not first-page-only', async () => {
  const client = fakeClient({ pagesOf: { 11: [[{ id: 1, entity_key: 'A' }], [{ id: 2, entity_key: 'B' }]] } });
  const backend = createHttpBackend({ client, tableIds: { [TABLE_VIDEOS]: 11 }, pageSize: 1 });
  const rows = await backend.listAllRows(TABLE_VIDEOS);
  assert.equal(rows.length, 2, '必须读回两页');
  assert.equal(client.calls.filter((c) => c[0] === 'listRows' && c[1] === 11).length, 2, '应请求 page=1,2 并在 next 为空时停止');
});

test('F1: uncertain write after a timeout is reconciled by readback, not duplicated', async () => {
  const inner = createMemoryBackend();
  for (const t of ALL_TABLES) await inner.createTable(t);
  let thrown = false;
  const backend = {
    kind: 'flaky_double',
    async listAllRows(t) { return inner.listAllRows(t); },
    async insertRow(t, row) { const r = await inner.insertRow(t, row); if (!thrown && t === TABLE_VIDEOS) { thrown = true; throw new Error('timeout_after_accept'); } return r; },
    async updateRow(t, id, patch) { return inner.updateRow(t, id, patch); },
  };
  const receipt = await importRecords({ records: twoRecs(), backend, mode: 'contract_double' });
  assert.equal(receipt.reconciled_uncertain_writes.length, 1, '必须读回复核不确定写入');
  assert.equal(receipt.errors.length, 0, '复核确认已写入则不算错误');
  assert.equal((await backend.listAllRows(TABLE_VIDEOS)).length, 2, '不得产生重复行');
});

test('F3: segment payload reaches the actual backend rows and links to the Videos row ID', async () => {
  const seg = {
    segment_id: 'TikTok|main|7677920051269455125|0|0', index: 0, t_label: '00:00.000', start_seconds: 0,
    observed: 'x', onscreen_text: null, speech: null, kind: 'original_fact', fact_origin: 'source_fact',
    origin_card: 'cards/a.json', origin_method: 'per_tile_exact_seek', time_accuracy_note: null,
    coverage: 'sparse_sampled_tiles_only', review_status: 'unreviewed', selected_reference: false, human_note: null,
  };
  const rec = normalizeEntity(entity(), [], {
    mediaIndex: new Map([['TikTok|main|7677920051269455125', {
      asset_id: 'tiktok-x', platform: 'TikTok', native_id: '7677920051269455125', cohort: 't',
      local_path: 'D:/abs/a.mp4', segments: [seg], segment_count: 1,
    }]]),
  });
  const backend = createMemoryBackend();
  for (const t of ALL_TABLES) await backend.createTable(t);
  const receipt = await importRecords({ records: [rec], backend, mode: 'contract_double' });
  assert.equal(receipt.tables[TABLE_SEGMENTS].inserted, 1, 'Segments 必须真的写入');
  const segRows = await backend.listAllRows(TABLE_SEGMENTS);
  assert.equal(segRows[0].origin_card, 'cards/a.json');
  const videoId = (await backend.listAllRows(TABLE_VIDEOS))[0].id;
  assert.deepEqual(segRows[0].video_link, [videoId], 'segment 必须关联到 Videos 的实际行 ID');
});

test('F2: apply renames primary, uses field IDs for filters, consumes sorts, links relations; repeat is idempotent', async () => {
  const schema = planSchema();
  const client = fakeClient({ tables: [] });
  // 2.4.0 建表必须提供 database_id：缺失时应明确失败，而不是去撞不存在的路径
  await assert.rejects(() => ensureSchemaAndViews(client, {}), /ensure_schema_requires_database_id/);
  const first = await ensureSchemaAndViews(client, { databaseId: 42 });
  assert.equal(first.ok, true);
  assert.ok(client.calls.some((c) => c[0] === 'createTable' && c[2] === 42), 'createTable 必须带上 database_id');
  const videosTableId = first.tableIds[TABLE_VIDEOS];
  const videoFieldNames = client.calls.filter((c) => c[0] === 'createField' && c[1] === videosTableId).map((c) => c[2]);
  assert.ok(!videoFieldNames.includes('entity_key'), 'primary 字段必须靠改名设置，不得再建第二个 primary');
  assert.equal(client.calls.filter((c) => c[0] === 'updateField').length, schema.tables.length, '每张表都必须把既有 primary 改名为本表主键');
  const filterCalls = client.calls.filter((c) => c[0] === 'createViewFilter');
  assert.ok(filterCalls.length > 0);
  assert.ok(filterCalls.every((c) => typeof c[2] === 'number'), `过滤器 field 必须是字段 ID，实际=${JSON.stringify(filterCalls.slice(0, 2))}`);
  assert.ok(client.calls.some((c) => c[0] === 'createViewSort'), 'sorts 必须被消费');
  const linkCalls = client.calls.filter((c) => c[0] === 'createField' && c[3] === 'link_row');
  assert.ok(linkCalls.length >= 2, '必须建立原生关联字段');
  assert.ok(linkCalls.every((c) => typeof c[4] === 'number'), 'link_row 必须带 link_row_table_id');
  assert.equal(linkCalls.find((c) => c[2] === 'video_link')[4], first.tableIds[TABLE_VIDEOS]);
  assert.equal(schema.tables.length, 5);

  // 第二次：同一实例（表已存在）→ 复用，不再重复建表。R4：注入清单必须**自证**属于该 database
  const existing = Object.entries(first.tableIds).map(([name, id]) => ({ id, name, database_id: 42 }));
  const before = client.calls.length;
  const second = await ensureSchemaAndViews(client, { databaseId: 42, existingTables: existing });
  assert.equal(client.calls.slice(before).filter((c) => c[0] === 'createTable').length, 0, '重复 apply 不得重复建表');
  assert.equal(second.log.tables_reused.length, 5);
  assert.equal(second.log.scope.auth, 'JWT', '结构工作必须用 JWT 且标注作用域');
  // R4-F2b：既有视图也要补齐过滤/排序（第二次不得重复创建）
  assert.equal(second.log.filters_created, 0, '重复 apply 不得重复创建过滤器');
  assert.equal(second.log.sorts_created, 0, '重复 apply 不得重复创建排序');
  assert.ok(second.log.filters_reused > 0, '应通过读回识别既有过滤器');
});

test('F4: human classification is evidence-bound, marked human_review, protected from source overwrite', async () => {
  const rec = normalizeEntity(entity(), [fieldRow('engagement_like', 'present_and_usable', 3)]);
  assert.equal(rec.classification.product_category, 'unknown');
  assert.equal(rec.classification.product_category_origin, 'unknown_no_source');
  // 分类必须带复核人与证据引用，否则拒绝
  assert.throws(() => setReview({ entityKey: 'x', reviewer: 'r', classification: { product_category: 'y' } }, { entries: {} }), /classification_requires_evidence_ref/);
  assert.throws(() => setReview({ entityKey: 'x', classification: { product_category: 'y' } }, { entries: {} }), /classification_requires_reviewer/);
  const overlay = { entries: {} };
  const next = setReview({
    entityKey: rec.entity_key, reviewer: 'harness-executor-proposal', status: 'in_review',
    classification: { product_category: '手机壳', product_function: '未知（未演示）', scene_or_need: '静物展示', state: 'proposed' },
    classificationEvidenceRef: 'cards/a.json#timeline[0]',
  }, overlay);
  assert.equal(next.classification.state, 'proposed');
  const res = applyOverlay([rec], overlay);
  assert.equal(res.classification_values_applied, 3);
  assert.equal(rec.classification.product_category, '手机壳');
  assert.equal(rec.classification.product_category_origin, 'human_review', '必须标明来自人工复核而非来源');
  assert.equal(rec.classification.product_category_reviewer, 'harness-executor-proposal');
  assert.equal(rec.classification.product_category_evidence_ref, 'cards/a.json#timeline[0]');
  assert.ok(HUMAN_FIELDS.includes('product_category'));
  assert.ok(HUMAN_FIELDS.includes('product_category_origin'));
  const backend = createMemoryBackend();
  for (const t of ALL_TABLES) await backend.createTable(t);
  await importRecords({ records: [rec], backend, mode: 'contract_double' });
  const row = (await backend.listAllRows(TABLE_VIDEOS))[0];
  assert.equal(row.product_category, '手机壳');
  assert.equal(row.product_category_origin, 'human_review');
});

test('F5: test-identity annotations never become human-selected references, and are archived not deleted', () => {
  const overlay = { entries: {
    'TikTok|main|1': { reviewer: 'journey-selftest', status: 'reviewed', selected_reference: true, notes: ['t'] },
    'TikTok|main|2': { reviewer: 'simon', status: 'reviewed', selected_reference: true, notes: ['real'] },
    'TikTok|main|3': { status: 'reviewed', selected_reference: true, notes: ['no reviewer'] },
  } };
  const recs = [
    normalizeEntity(entity({ native_id: '1' }), []),
    normalizeEntity(entity({ native_id: '2' }), []),
    normalizeEntity(entity({ native_id: '3' }), []),
  ];
  const res = applyOverlay(recs, overlay);
  assert.equal(res.test_identity_entries, 1);
  assert.equal(recs[0].review.selected_reference, false, '测试身份不得成为人工精选');
  assert.equal(recs[0].review.is_test_identity, true);
  assert.equal(recs[1].review.selected_reference, true, '真实人工选择保留');
  assert.equal(recs[2].review.ownership, 'human');
  const { kept, extracted, ambiguous } = splitTestIdentities(overlay);
  assert.deepEqual(Object.keys(extracted), ['TikTok|main|1'], '测试条目被摘出并保留');
  assert.equal(extracted['TikTok|main|1'].notes[0], 't', '摘出时逐字保留');
  assert.ok(kept.entries['TikTok|main|2'], '真实人工条目保留在有效层');
  assert.equal(kept.entries['TikTok|main|3'].ownership, 'pending_review_no_reviewer', '归属不明保留并标注');
  assert.equal(Object.keys(ambiguous).length, 1);
});

test('F5: first import preserves a valid review carried by the overlay instead of forcing unreviewed', async () => {
  const rec = normalizeEntity(entity(), [fieldRow('engagement_like', 'present_and_usable', 3)]);
  rec.review = { ...rec.review, status: 'reviewed', reviewer: 'simon', notes: ['人工确认'], selected_reference: true };
  const backend = createMemoryBackend();
  for (const t of ALL_TABLES) await backend.createTable(t);
  await importRecords({ records: [rec], backend, mode: 'contract_double' });
  const row = (await backend.listAllRows(TABLE_VIDEOS))[0];
  assert.equal(row.review_status, 'reviewed', '首次导入不得把有效复核重置为 unreviewed');
  assert.equal(row.review_reviewer, 'simon');
  assert.equal(row.selected_reference, true);
  assert.equal(row.review_notes, '人工确认');
});

test('deployment config keeps the local Baserow isolated (loopback + pinned image + no secret default)', () => {
  // R2 要求：隔离的项目实例、绑定回环、不得公开端口、固定版本、不得内嵌凭据。
  // 本机没有容器运行时，因此这里校验的是**配置不变量**，不是运行结果。
  const root = process.env.MATERIAL_LIBRARY_ROOT || 'D:/Codex-local/harness-workspaces/Phonecase';
  const dir = path.join(root, 'outputs/product-material-library-phase1-20261006/deploy/baserow');
  const compose = fs.readFileSync(path.join(dir, 'docker-compose.yml'), 'utf8');
  const envExample = fs.readFileSync(path.join(dir, '.env.example'), 'utf8');

  // 端口只绑回环：不得出现 "8080:80" 这类默认 0.0.0.0 绑定
  const portLines = compose.split('\n').filter((l) => /^\s*-\s*"/.test(l) && l.includes(':'));
  assert.ok(portLines.length > 0, 'compose 必须显式声明端口映射');
  for (const l of portLines) {
    assert.match(l, /127\.0\.0\.1:/, `端口未绑定回环：${l.trim()}`);
  }
  assert.ok(!/^\s*-\s*"?\d+:\d+"?\s*$/m.test(compose), '不得存在裸 <host>:<container> 端口映射');

  // 固定镜像版本，不追 latest
  const img = compose.match(/image:\s*(\S+)/)?.[1] ?? '';
  assert.match(img, /^baserow\/baserow:\d+\.\d+\.\d+$/, `镜像必须固定语义化版本，实际=${img}`);
  assert.ok(!img.endsWith(':latest'), '不得使用 latest');

  // 不默认启用外部付费/邮件/AI 供应方
  assert.match(compose, /EMAIL_SMTP:\s*"False"/);

  // 凭据不得有默认值：SECRET_KEY 必须来自环境且无明文默认
  assert.match(compose, /SECRET_KEY:\s*\$\{SECRET_KEY:\?/, 'SECRET_KEY 必须必填且无默认值');
  assert.ok(!/SECRET_KEY=\S+/.test(envExample), '.env.example 不得预置任何 SECRET_KEY 值');
  assert.ok(!/SECRET_KEY=\S+/.test(compose), 'compose 不得内嵌 SECRET_KEY 值');
});

test('v5 field contract alignment is explicit for every census field', () => {
  assert.equal(v5MeaningFor('engagement_like').canonical, 'likes');
  assert.equal(v5MeaningFor('engagement_play').canonical, 'views');
  assert.equal(v5MeaningFor('engagement_collect').canonical, 'saves');
  assert.equal(v5MeaningFor('media_type').canonical, 'entity_type');
  assert.equal(v5MeaningFor('product_linked_identity').canonical, 'product_id');
  assert.equal(v5MeaningFor('product_tag_or_eligibility').canonical, 'product_association');
  // 无等价槽位：不得硬套含义
  assert.equal(v5MeaningFor('product_price').mapping, 'no_equivalent_slot');
  assert.equal(v5MeaningFor('author_follower_count').mapping, 'no_equivalent_slot');
  // 歧义：v5 区分四个 region 语义，普查只有一个合并槽位
  const geo = v5MeaningFor('geography_or_region');
  assert.equal(geo.mapping, 'ambiguous_multi_meaning');
  assert.deepEqual(geo.candidates.sort(), ['audience_region', 'author_region', 'location_tag', 'query_region']);
  // 未映射必须是显式的、可枚举的
  for (const f of Object.keys(CENSUS_FIELD_TO_V5_MEANING)) {
    assert.notEqual(v5MeaningFor(f).mapping, 'unmapped', `${f} 未给出对齐判定`);
  }
  // v5 的零/空/缺失语义是本库状态机的依据
  assert.match(V5_VALUE_SEMANTICS.zero, /real reported zero/);
  assert.match(V5_VALUE_SEMANTICS.missing, /must not be coerced to 0 or null/);
});

// ─────────────── R4：消费者链修复回归（合同替身；仍不代表真实 Baserow 验收） ───────────────

test('R4-F2a: cross-database identically named tables are never reused by global name', async () => {
  // 库 1 已有一套同名表；本次结构工作针对库 2
  const client = fakeClient({
    tables: [
      { id: 11, name: TABLE_VIDEOS, database_id: 1 },
      { id: 12, name: TABLE_METRICS, database_id: 1 },
    ],
  });
  const res = await ensureSchemaAndViews(client, { databaseId: 2 });
  assert.ok(client.calls.some((c) => c[0] === 'listTablesInDatabase' && c[1] === 2), '必须按 database_id 列目录');
  assert.equal(client.calls.some((c) => c[0] === 'listTables'), false, '结构路径不得再走全局 all-tables 列目录');
  assert.notEqual(res.tableIds[TABLE_VIDEOS], 11, '不得复用另一个库的同名表');
  assert.ok(client.calls.some((c) => c[0] === 'createTable' && c[2] === 2), '必须在指定库内建表');
});

test('R4-F2a: caller-supplied tables from another (or unverifiable) database cause zero writes', async () => {
  const client = fakeClient();
  const foreign = await ensureSchemaAndViews(client, {
    databaseId: 2, existingTables: [{ id: 11, name: TABLE_VIDEOS, database_id: 1 }],
  });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.scope_error.reason, 'existing_tables_belong_to_other_database');
  const unscoped = await ensureSchemaAndViews(client, {
    databaseId: 2, existingTables: [{ id: 11, name: TABLE_VIDEOS }],
  });
  assert.equal(unscoped.scope_error.reason, 'existing_tables_scope_unverifiable');
  assert.equal(client.calls.filter((c) => ['createTable', 'createField', 'createView'].includes(c[0])).length, 0, '范围不符必须零写入');
});

test('R4-F2a: auth contract — DB-scoped listing is JWT-only, all-tables is Token-scope', () => {
  const noFetch = async () => { throw new Error('must_not_fetch'); };
  const dataOnly = createHttpClient({ baseUrl: 'http://127.0.0.1:9', token: 'db-token', fetchImpl: noFetch });
  assert.throws(() => dataOnly.listTablesInDatabase(7), /list_tables_in_database_requires_jwt/, '仅数据库 Token 时不得调用 JWT-only 端点');
  const mgmtOnly = createHttpClient({ baseUrl: 'http://127.0.0.1:9', mgmtToken: 'jwt-token', fetchImpl: noFetch });
  assert.throws(() => mgmtOnly.listTablesTokenScope(), /list_tables_token_scope_requires_database_token/, 'token 作用域端点不得用 JWT 冒充');
  assert.equal(HTTP_ROUTES.listTablesInDatabase[1], '/api/database/tables/database/{database_id}/');
  assert.equal(HTTP_ROUTES.listTablesTokenScope[1], '/api/database/tables/all-tables/');
  assert.equal(HTTP_ROUTES.createViewSort[1], '/api/database/views/{view_id}/sortings/');
  assert.equal(HTTP_ROUTES.listViewFilters[1], '/api/database/views/{view_id}/filters/');
});

test('R4-F2b: a view created before its filter/sort step is completed on replay (no duplicate view)', async () => {
  const views = planViews();
  const target = views.find((v) => v.table === TABLE_VIDEOS && (v.filters ?? []).length > 0);
  const client = fakeClient();
  const partial = await ensureSchemaAndViews(client, { databaseId: 42, views });
  const videosTableId = partial.tableIds[TABLE_VIDEOS];
  const existing = Object.entries(partial.tableIds).map(([name, id]) => ({ id, name, database_id: 42 }));
  // 模拟「视图已建、过滤/排序尚未完成」的中断：该视图存在但没有任何过滤/排序
  const cleared = fakeClient({
    tables: existing,
    existingViews: { [videosTableId]: [{ id: 801, table_id: videosTableId, name: target.name, type: 'grid' }] },
    filters: {}, sorts: {},
  });
  const replay = await ensureSchemaAndViews(cleared, { databaseId: 42, existingTables: existing, views });
  const createdNames = cleared.calls.filter((c) => c[0] === 'createView').map((c) => c[2]);
  assert.ok(!createdNames.includes(target.name), `已存在的视图不得重建：${JSON.stringify(createdNames.slice(0, 3))}`);
  const repaired = replay.log.views_repaired.find((v) => v.name === target.name);
  assert.ok(repaired, `复跑必须补齐「${target.name}」缺失的配置`);
  assert.ok(repaired.filters_created + repaired.sorts_created > 0, '补齐必须有实际写入');
  assert.ok(replay.log.type_mismatches.length === 0, `视图过滤/排序必须能按类型编码：${JSON.stringify(replay.log.type_mismatches.slice(0, 3))}`);
  // 再跑一次：补齐后不得重复创建
  const again = await ensureSchemaAndViews(cleared, { databaseId: 42, existingTables: existing, views });
  assert.equal(again.log.views_repaired.length, 0, '补齐完成后再跑不应再有写入');
});

test('R4-F2b: filter values are typed — single_select uses option IDs, booleans use literals, unresolved is refused', () => {
  const sel = encodeFilterValue({
    fieldType: 'single_select', fieldMeta: { select_options: [{ id: 42, value: 'observed' }] },
    filterType: 'single_select_equal', value: 'observed',
  });
  assert.deepEqual(sel, { value: '42', encoding: 'single_select_option_id' });
  assert.equal(encodeFilterValue({ fieldType: 'boolean', filterType: 'boolean', value: true }).value, 'true');
  assert.equal(encodeFilterValue({ fieldType: 'boolean', filterType: 'boolean', value: false }).value, 'false');
  assert.equal(encodeFilterValue({ fieldType: 'number', filterType: 'higher_than', value: 0 }).value, '0');
  assert.equal(encodeFilterValue({ fieldType: 'text', filterType: 'not_empty', value: '' }).encoding, 'no_value');
  const unresolved = encodeFilterValue({ fieldType: 'single_select', fieldMeta: { select_options: [] }, filterType: 'single_select_equal', value: 'nope' });
  assert.equal(unresolved.value, null, '解析不到选项 ID 时不得把 label 冒充为值');
  assert.equal(unresolved.encoding, 'unresolved_single_select_option_id');
});

test('R4-F1a: an update that was definitively rejected while the old row survives is NOT success', async () => {
  const base = createMemoryBackend();
  for (const t of ALL_TABLES) await base.createTable(t);
  const recs = twoRecs();
  await importRecords({ records: recs, backend: base, mode: 'seed' });
  const rejecting = {
    kind: 'update_rejecting_double',
    async listAllRows(t) { return base.listAllRows(t); },
    async insertRow(t, row) { return base.insertRow(t, row); },
    async updateRow() { const e = new Error('simulated_400_invalid_value'); e.status = 400; throw e; },
  };
  const changed = recs.map((r) => ({ ...r, evidence_fingerprint: `${r.evidence_fingerprint}-changed` }));
  const receipt = await importRecords({ records: changed, backend: rejecting, mode: 'update_reject_double' });
  assert.equal(receipt.ok, false, '旧行仍在但没变成期望值 → 确定性失败');
  assert.ok(receipt.errors.some((e) => e.error_code === 'update_not_applied_old_row_survived'), JSON.stringify(receipt.errors.slice(0, 2)));
  assert.equal(receipt.tables[TABLE_VIDEOS].updated, 0);
});

test('R4-F1a: a timeout AFTER the update committed is reconciled by readback, without duplicates', async () => {
  const base = createMemoryBackend();
  for (const t of ALL_TABLES) await base.createTable(t);
  const recs = twoRecs();
  await importRecords({ records: recs, backend: base, mode: 'seed' });
  let thrown = false;
  const flaky = {
    kind: 'commit_then_timeout_double',
    async listAllRows(t) { return base.listAllRows(t); },
    async insertRow(t, row) { return base.insertRow(t, row); },
    async updateRow(t, id, patch) {
      const r = await base.updateRow(t, id, patch);
      if (!thrown && t === TABLE_VIDEOS) { thrown = true; throw new Error('timeout_after_commit'); }
      return r;
    },
  };
  const changed = recs.map((r) => ({ ...r, evidence_fingerprint: `${r.evidence_fingerprint}-changed` }));
  const receipt = await importRecords({ records: changed, backend: flaky, mode: 'commit_timeout_double' });
  assert.equal(receipt.errors.length, 0, '提交后超时必须靠读回复核，而不是记成错误');
  assert.equal(receipt.reconciled_uncertain_writes.length, 1);
  const rows = await base.listAllRows(TABLE_VIDEOS);
  assert.equal(rows.length, 2, '不得重复插入');
  const row = rows.find((r) => r.entity_key === recs[0].entity_key);
  assert.match(String(row.evidence_fingerprint), /-changed$/, '读回必须证明期望值确实已落地');
});

test('R4-F1a: an unresolved update (readback also fails) is failed, never success', async () => {
  const base = createMemoryBackend();
  for (const t of ALL_TABLES) await base.createTable(t);
  const recs = twoRecs();
  await importRecords({ records: recs, backend: base, mode: 'seed' });
  let failReads = false;
  const broken = {
    kind: 'unreadable_after_update_error_double',
    // 只让“更新失败后的那次复核读”失败一次：结果**不确定** → 必须记为 unresolved
    async listAllRows(t) { if (failReads) { failReads = false; throw new Error('simulated_read_failure'); } return base.listAllRows(t); },
    async insertRow(t, row) { return base.insertRow(t, row); },
    async updateRow() { failReads = true; const e = new Error('timeout_before_update'); throw e; },
  };
  const changed = recs.map((r) => ({ ...r, evidence_fingerprint: `${r.evidence_fingerprint}-changed` }));
  const receipt = await importRecords({ records: changed, backend: broken, mode: 'unresolved_double' });
  assert.equal(receipt.ok, false, '结果不确定时必须失败，不得猜测成功');
  assert.ok(receipt.errors.some((e) => e.error_code === 'reread_failed_after_update_error'));
  assert.equal(receipt.tables[TABLE_VIDEOS].unresolved, 2);
});

test('R4-F1a: a success response whose row is missing afterwards fails post-write reconciliation', async () => {
  const base = createMemoryBackend();
  for (const t of ALL_TABLES) await base.createTable(t);
  const dropping = {
    kind: 'silent_drop_double',
    async listAllRows(t) { const rows = await base.listAllRows(t); return t === TABLE_VIDEOS ? [] : rows; },
    async insertRow(t, row) { return base.insertRow(t, row); },
    async updateRow(t, id, patch) { return base.updateRow(t, id, patch); },
  };
  const receipt = await importRecords({ records: twoRecs(), backend: dropping, mode: 'silent_drop_double' });
  assert.equal(receipt.ok, false, '写入回执成功但最终行不存在 → 写后对账必须失败');
  assert.equal(receipt.post_write_reconciliation[TABLE_VIDEOS].missing.length, 2);
  assert.equal(receipt.post_write_reconciliation[TABLE_VIDEOS].planned, 2);
});

test('R4-F1b: a rejected parent row never yields orphan child success', async () => {
  const backend = createMemoryBackend({ failOnInsert: (t) => t === TABLE_VIDEOS });
  for (const t of ALL_TABLES) await backend.createTable(t);
  const receipt = await importRecords({ records: twoRecs(), backend, mode: 'parent_fail_double' });
  assert.equal(receipt.tables[TABLE_VIDEOS].error, 2);
  assert.equal(receipt.tables[TABLE_METRICS].inserted, 0, '父行失败时不得写子行');
  assert.equal(receipt.tables[TABLE_METRICS].skipped, 2);
  assert.ok(receipt.errors.some((e) => e.error_code === 'parent_row_not_written'));
  assert.equal((await backend.listAllRows(TABLE_METRICS)).length, 0, '不得留下无关联的孤儿行');
  assert.equal(receipt.ok, false);
});

test('R4-F1b: API-shaped select/link rows decode to logical values; writes carry only writable intent', () => {
  const apiRow = {
    id: 5, order: '1.00000000000000000000', entity_key: 'TikTok|main|1', platform: 'TikTok',
    product_category: '手机壳',                                        // text 字段：API 回字符串
    product_category_origin: { id: 77, value: 'human_review' },        // single_select：API 回对象
    entity_source_state: { id: 78, value: 'observed' },
    review_status: { id: 79, value: 'reviewed' }, media_file: [{ name: 'a.mp4', url: 'http://127.0.0.1:1/a.mp4' }],
  };
  const logical = decodeApiRow(TABLE_VIDEOS, apiRow);
  assert.equal(logical.product_category_origin, 'human_review', 'single_select 必须解码为逻辑值');
  assert.equal(logical.product_category, '手机壳', 'text 字段原样保留');
  assert.equal(logical.entity_source_state, 'observed');
  assert.equal(logical.review_status, 'reviewed');
  assert.equal(logical.id, 5, '行 ID 必须保留（写回与绑定要用）');
  const payload = encodeWritePayload(TABLE_VIDEOS, { ...logical, __order: apiRow.order }, null);
  assert.equal('id' in payload, false, '不得把只读 id 写回目标');
  assert.equal('__order' in payload, false, '不得把只读 order 写回目标');
  assert.equal('media_file' in payload, false, '文件字段不得在行写入里伪造');
  assert.equal(payload.review_status, 'reviewed', '无选项元数据时按逻辑值发送，不伪造选项 ID');
  const meta = { review_status: { select_options: [{ id: 79, value: 'reviewed' }] } };
  // R11 更正（真实 2.4.0 实测）：行写入的 single_select 收**选项值**；发选项 ID 会被拒：
  // `The provided select option value '79' is not a valid select option.`（17/25 条真实身份曾因此写失败）。
  // 视图过滤仍然需要选项 ID（encodeFilterValue），两者是不同编码。
  assert.equal(encodeWritePayload(TABLE_VIDEOS, { review_status: 'reviewed' }, meta).review_status, 'reviewed', '有选项元数据时仍发选项值');
  const linkPayload = encodeWritePayload(TABLE_METRICS, { observation_id: 'o1', video_link: [11, 12], status: 'value' }, null);
  assert.deepEqual(linkPayload.video_link, [11, 12], '关联按 ID 数组写入');
  const emptyLink = encodeWritePayload(TABLE_METRICS, { observation_id: 'o1', video_link: [] }, null);
  assert.equal('video_link' in emptyLink, false, '空关联不得发空数组（避免清空既有关系）');
});

test('R4-F1b: replayed API-shaped records are idempotent through the HTTP boundary', async () => {
  const store = new Map(); let seq = 0;
  // 按**真实 schema 的字段类型**决定哪些字段在 API 形状里是对象（single_select）。
  // 不能只按字段名猜：Ratios.status 是 text，Metrics.status 才是 single_select。
  const FIELD_TYPES = Object.fromEntries(planSchema().tables.map((t) => [t.name, Object.fromEntries(t.fields.map((f) => [f.name, f.type]))]));
  const tableIdToName = { 11: TABLE_VIDEOS, 12: TABLE_METRICS, 13: TABLE_RATIOS, 14: TABLE_ASSETS, 15: TABLE_SEGMENTS };
  const toApiShape = (row) => {
    const types = FIELD_TYPES[tableIdToName[row.__table]] ?? {};
    const out = { id: row.id, order: String(row.id) };
    for (const [k, v] of Object.entries(row)) {
      if (k === 'id' || k === '__table') continue;
      out[k] = types[k] === 'single_select' && v !== null && v !== undefined ? { id: 900, value: v } : v;
    }
    return out;
  };
  const client = {
    calls: [],
    async listRows(tableId, params) {
      const page = Number((params.match(/page=(\d+)/) ?? [])[1] ?? 1);
      const rows = [...store.values()].filter((r) => r.__table === tableId).map(toApiShape);
      return { results: page === 1 ? rows : [], next: null, count: rows.length };
    },
    async createRow(tableId, row) {
      this.calls.push(['createRow', tableId, row]);
      const rec = { __table: tableId, id: ++seq, ...row };
      store.set(rec.id, rec);
      return toApiShape(rec);
    },
    async updateRow(tableId, rowId, row) {
      this.calls.push(['updateRow', tableId, rowId, row]);
      const rec = { ...store.get(rowId), ...row };
      store.set(rowId, rec);
      return toApiShape(rec);
    },
  };
  const tableIds = { [TABLE_VIDEOS]: 11, [TABLE_METRICS]: 12, [TABLE_RATIOS]: 13, [TABLE_ASSETS]: 14, [TABLE_SEGMENTS]: 15 };
  const backend = createHttpBackend({ client, tableIds });
  const first = await importRecords({ records: twoRecs(), backend, mode: 'http_shape_double' });
  const second = await importRecords({ records: twoRecs(), backend, mode: 'http_shape_double' });
  assert.equal(first.ok, true, `首次导入应对账通过：${JSON.stringify(first.post_write_reconciliation?.[TABLE_VIDEOS])}`);
  assert.equal(second.tables[TABLE_VIDEOS].inserted, 0, '复跑不得重复插入');
  assert.equal(second.tables[TABLE_VIDEOS].updated, 0, 'API 形状不得产生假差异');
  assert.equal(client.calls.filter((c) => c[0] === 'updateRow').length, 0, '无差异时不得发 PATCH');
  assert.ok(client.calls.every((c) => c[0] !== 'createRow' || (!('id' in c[2]) && !('order' in c[2]) && !('__order' in c[2]))), '写入不得带只读字段');
});

// ─────────────── R4 STEP4：旅程与媒体链（同一隔离覆盖层 / 目标行断言） ───────────────

test('R4-F4: an overlay that is written but not the one consumed is detected (retained r2 failure shape)', async () => {
  const tmpRoot = mkFixtureDir('ml-journey-');
  const isolated = path.join(tmpRoot, 'fixtures', 'journey-overlay.json');
  const recs = twoRecs();
  // 旧行为：写 isolated 覆盖层，却按别的路径读回（等价于 r2 里写 fixtures 读正式层）
  const res = await runJourney({
    records: recs,
    loadWithOverlay: async () => recs,
    overlayPath: isolated, root: tmpRoot, requireMedia: false,
    setupFixture: true,                        // R7-STEP2：夹具准备改为显式动作
    createBackend: () => createMemoryBackend(),
  });
  assert.equal(res.ok, false, '写在 A、读在 B 必须被测出，不得报成功');
  assert.ok(res.failures.some((f) => f.startsWith('overlay_not_consumed')), JSON.stringify(res.failures));
  const step7 = res.transcript.steps.find((s) => s.step === 7);
  assert.equal(step7.target_row_pre_edit.review_notes, null, '目标行没有备注 → 必须如实为 null');
});

test('R4-F4/F5: the same isolated overlay survives write→reload→import and is asserted on the TARGET row', async () => {
  const tmpRoot = mkFixtureDir('ml-journey-ok-');
  const overlayPath = path.join(tmpRoot, 'fixtures', 'journey-overlay.json');
  const base = twoRecs();
  // applyOverlay 原地改写记录并返回统计；这里显式复用**同一个**隔离覆盖层路径
  const loadWithOverlay = async (p) => { applyOverlay(base, loadOverlay(tmpRoot, p)); return base; };
  const res = await runJourney({
    records: base,
    loadWithOverlay,
    overlayPath, root: tmpRoot, requireMedia: false,
    // R5：只主张留存静态产品卡支持的部分；产品功能保持 unknown（不重复未经支持的“保护/性能”主张）
    classification: { product_category: '手机壳', scene_or_need: '静态产品展示', state: 'proposed' },
    classificationEvidenceRef: 'cards/tiktok-7679078728667778337.json#timeline[0]',
    manualEdit: { note: '隔离夹具：单独人工编辑（带原因）' },
    setupFixture: true,                        // R7-STEP2：夹具准备改为显式动作（本测试验证夹具链）
    noMatchQuery: { product_category: '不可能存在的类别-探针' },
    createBackend: () => createMemoryBackend(),
  });
  assert.equal(res.ok, true, JSON.stringify(res.failures));
  const step6 = res.transcript.steps.find((s) => s.step === 6);
  const step7 = res.transcript.steps.find((s) => s.step === 7);
  assert.equal(step6.written_classification.product_function, undefined, '未支持的功能维度不得被写入');
  // R5 STEP3：命中来自**目标库行**，不是源数组谓词
  assert.ok(step7.lookup.hit_count >= 1, JSON.stringify(step7.lookup));
  assert.equal(step7.lookup.hits[0].entity_key, res.transcript.chosen_entity_key);
  assert.equal(step7.lookup.mutated, false);
  assert.ok(step7.lookup.scanned_rows > 0);
  assert.equal(step7.no_match_lookup.hit_count, 0, '未命中必须诚实为 0');
  assert.equal(step7.target_row_pre_edit.review_status, 'reviewed');
  assert.match(String(step7.target_row_pre_edit.review_notes), /隔离夹具/);
  assert.equal(step7.target_row_pre_edit.selected_reference, true);
  assert.equal(step7.target_row_pre_edit.review_stale, false);
  assert.equal(step7.import_replay.inserted, 0, '复跑不得重复插入');
  assert.ok(step7.lookup_after_edit.hit_count >= 1, '单独人工编辑后再查询必须仍能命中');
  // R6-STEP2：人工编辑走**目标 backend**，且复导入后仍在编辑后的目标行里
  assert.equal(step7.target_side_manual_edit.ok, true, JSON.stringify(step7.target_side_manual_edit));
  assert.equal(step7.target_side_manual_edit.row_id, step7.target_row_pre_edit.row_id);
  assert.match(String(step7.target_row_after_edit.review_notes), /隔离夹具/);
  // 正式（默认）覆盖层不得被这次旅程写入
  assert.equal(fs.existsSync(path.join(tmpRoot, 'outputs', 'product-material-library-phase1-20261006', 'human-review', 'review-overlay.json')), false);
  // 隔离覆盖层确实落盘
  assert.equal(fs.existsSync(overlayPath), true);
});

test('R4-F4: need-based filtering only matches records carrying an evidence-backed value', () => {
  const recs = twoRecs();
  assert.equal(filterByNeed(recs, { productFunction: '防摔' }).length, 0, '来源无留存 → unknown 不得被当成命中');
  // applyOverlay 原地写入人工分类（来源标记为 human_review，并带证据引用）
  applyOverlay(recs, {
    entries: { [recs[0].entity_key]: { reviewer: 'r', classification: { product_function: '防摔', evidence_ref: 'cards/a.json', state: 'reviewed' } } },
  });
  assert.equal(filterByNeed(recs, { productFunction: '防摔' }).length, 1);
  assert.equal(recs[0].classification.product_function_origin, 'human_review', '有效值必须标明来自人工复核');
  assert.equal(recs[1].classification.product_function, 'unknown', '未标注的记录保持 unknown');
});

// ─────────────── R5 STEP3：目标库只读查询 + 代表身份清单 ───────────────

test('R5-STEP3: target lookup reads backend rows, reports target IDs/keys, and mutates nothing', async () => {
  const backend = createMemoryBackend();
  for (const t of ALL_TABLES) await backend.createTable(t);
  const recs = twoRecs();
  recs[0].classification = { ...recs[0].classification, product_category: '手机壳', product_category_origin: 'human_review', product_category_reviewer: 'r', product_category_evidence_ref: 'cards/x.json#t0', product_category_state: 'reviewed' };
  const receipt = await importRecords({ records: recs, backend, mode: 'r5_lookup_double' });
  assert.equal(receipt.ok, true);
  const before = JSON.stringify(await backend.listAllRows(TABLE_VIDEOS));
  const hit = await lookupTarget({ backend, query: { product_category: '手机壳' } });
  assert.equal(hit.hit_count, 1, JSON.stringify(hit));
  assert.ok(hit.hits[0].row_id !== null, '必须报告目标行 ID');
  assert.equal(hit.hits[0].entity_key, recs[0].entity_key);
  assert.equal(hit.mutated, false);
  assert.equal(hit.backend_kind, 'memory_backend_not_baserow');
  const miss = await lookupTarget({ backend, query: { product_category: '不存在的类别' } });
  assert.equal(miss.hit_count, 0, '未命中必须诚实');
  assert.equal(JSON.stringify(await backend.listAllRows(TABLE_VIDEOS)), before, '查询不得改动目标行');
  // 不受支持的检索维度必须显式拒绝，而不是静默返回 0 命中
  await assert.rejects(() => lookupTarget({ backend, query: { platform: 'TikTok' } }), /unsupported_lookup_dimension:platform/);
});

// ─────────────── R5 STEP4：可操作的本地点播/定位入口 ───────────────

test('R5-STEP4: record → asset → segment → viewer URL identity continuity, nonzero seek, explicit missing media', async () => {
  const tmp = mkFixtureDir('ml-viewer-');
  const file = path.join(tmp, 'clip.mp4');
  const bytes = Buffer.alloc(4096, 7);
  fs.writeFileSync(file, bytes);
  // 用真实生产者（normalizeEntity + mediaIndex）构造记录，确保 rowsOf 的输入是真实形状
  const seg = {
    segment_id: 'TikTok|main|7677920051269455125|3|3.056', index: 3, t_label: '00:03.056', start_seconds: 3.056,
    observed: 'x', onscreen_text: null, speech: null, kind: 'original_fact', fact_origin: 'source_fact',
    origin_card: 'cards/x.json', origin_method: 'per_tile_exact_seek', time_accuracy_note: null,
    coverage: 'sparse_sampled_tiles_only', review_status: 'unreviewed', selected_reference: false, human_note: null,
  };
  const records = [normalizeEntity(entity(), [], {
    mediaIndex: new Map([['TikTok|main|7677920051269455125', {
      asset_id: 'a-1', platform: 'TikTok', native_id: '7677920051269455125', cohort: 't',
      local_path: file, segments: [seg], segment_count: 1,
      // 与真实两级解析产物同形：媒体种类/可用性与哈希校验标记必须齐备
      media_kind: 'video', usable_as_video: true, kind_reject_reason: null,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'), sha256_match: true,
      bytes: bytes.length, actual_bytes: bytes.length,
    }]]),
  })];
  // 记录内的路由（同一批 asset/segment 记录）——记录→入口身份连续性的依据
  const assetRows = rowsOf(records)[TABLE_ASSETS];
  assert.equal(assetRows[0].media_view_path, '/viewer?asset=a-1');
  assert.equal(assetRows[0].media_seek_seconds, 3.056);
  const segRows = rowsOf(records)[TABLE_SEGMENTS];
  assert.equal(segRows[0].view_path, '/viewer?asset=a-1&t=3.056');

  const index = createMediaIndex(records);
  const srv = createMediaServer({ index, port: 0 });
  const bound = await srv.listen();
  try {
    assert.equal(bound.host, '127.0.0.1', '只允许回环绑定');
    assert.ok(bound.port > 0, '必须发布实际端口');
    // 用**记录里的相对路由**拼出绝对地址（端口由本次监听决定）
    const rec = await fetch(`${bound.url}${assetRows[0].media_view_path}&t=${assetRows[0].media_seek_seconds}`);
    assert.equal(rec.status, 200);
    assert.ok((await rec.text()).includes('data-asset-id="a-1"'), '记录里的路由必须打开同一个 asset');
    const pc = await playerCheck({ baseUrl: bound.url, assetId: 'a-1', startSeconds: 3.056 });
    assert.equal(pc.ok, true, JSON.stringify(pc.checks));
    assert.ok(pc.checks.find((c) => c.name === 'viewer_carries_nonzero_start').ok, '非零起点必须被播放入口携带');
    const rangeRes = await fetch(`${bound.url}/media/asset/a-1`, { headers: { Range: 'bytes=0-9' } });
    assert.equal(rangeRes.status, 206, '浏览器 seek 需要 Range 支持');
    assert.match(String(rangeRes.headers.get('content-range')), /^bytes 0-9\//);
    assert.equal((await fetch(`${bound.url}/viewer`)).status, 400, '缺 asset 参数必须显式报错');
    assert.equal((await fetch(`${bound.url}/viewer?asset=nope&t=3`)).status, 404);
  } finally { await srv.close(); }

  // 记录在、文件不在 → 显式缺失（410），不得当作可用播放
  const goneIndex = createMediaIndex([{ entity_key: 'x', assets: [{ asset_id: 'a-gone', local_path: path.join(tmp, 'gone.mp4'), media_kind: 'video', usable_as_video: true, segments: [] }] }]);
  const srv2 = createMediaServer({ index: goneIndex, port: 0 });
  const b2 = await srv2.listen();
  try {
    assert.equal((await fetch(`${b2.url}/viewer?asset=a-gone&t=3`)).status, 410);
    assert.equal((await fetch(`${b2.url}/media/asset/a-gone`)).status, 410);
  } finally { await srv2.close(); }
  assert.throws(() => createMediaServer({ index, host: '0.0.0.0' }), /media_adapter_is_loopback_only/, '非回环绑定必须拒绝');
});

// ─────────────── R6 STEP3：可点击的绝对媒体链接 ───────────────

test('R6-STEP3: a published loopback base becomes a clickable absolute link with the same asset and nonzero segment', async () => {
  const tmp = mkFixtureDir('ml-r6-link-');
  const file = path.join(tmp, 'clip.mp4');
  const bytes = Buffer.alloc(2048, 5);
  fs.writeFileSync(file, bytes);
  const seg = {
    segment_id: 'TikTok|main|7677920051269455125|4|4.25', index: 4, t_label: '00:04.250', start_seconds: 4.25,
    observed: 'x', onscreen_text: null, speech: null, kind: 'original_fact', fact_origin: 'source_fact',
    origin_card: 'cards/x.json', origin_method: 'per_tile_exact_seek', time_accuracy_note: null,
    coverage: 'sparse_sampled_tiles_only', review_status: 'unreviewed', selected_reference: false, human_note: null,
  };
  const records = [normalizeEntity(entity(), [], {
    mediaIndex: new Map([['TikTok|main|7677920051269455125', {
      asset_id: 'a-1', platform: 'TikTok', native_id: '7677920051269455125', cohort: 't',
      local_path: file, segments: [seg], segment_count: 1,
      media_kind: 'video', usable_as_video: true, kind_reject_reason: null,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'), sha256_match: true,
      bytes: bytes.length, actual_bytes: bytes.length,
    }]]),
  })];
  const index = createMediaIndex(records);
  const srv = createMediaServer({ index, port: 0 });
  const bound = await srv.listen();
  try {
    const rows = rowsOf(records, { mediaBaseUrl: bound.url });
    const assetRow = rows[TABLE_ASSETS][0];
    const segRow = rows[TABLE_SEGMENTS][0];
    assert.equal(assetRow.media_service_state, 'published');
    assert.equal(assetRow.media_view_url, `${bound.url}/viewer?asset=a-1`, '记录里必须是可直接点击的绝对链接');
    assert.equal(segRow.view_url, `${bound.url}/viewer?asset=a-1&t=4.25`);
    // 用户路径：直接用记录里的绝对链接（不手工拼接），必须是同一个 asset 与同一个非零时间点
    const res = await fetch(segRow.view_url);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.ok(html.includes('data-asset-id="a-1"'), '绝对链接必须打开同一个 asset');
    assert.ok(html.includes('data-start-seconds="4.25"'), '非零时间点必须被携带');
    // 未发布服务时：显式 not_published，且**不**产生坏链接
    const unpublished = rowsOf(records)[TABLE_ASSETS][0];
    assert.equal(unpublished.media_view_url, null);
    assert.equal(unpublished.media_service_state, 'not_published');
  } finally { await srv.close(); }
});

// ─────────────── R7 STEP1：夹具路径前置校验（先校验、后创建） ───────────────

test('R7-STEP1: fixture preflight rejects an out-of-envelope path BEFORE creating anything, and keeps the default usable', () => {
  const original = process.env.ML_TEST_ROOT;
  const outside = `${W_ROOT}/_r7-fixture-outside-probe`;
  try {
    assert.equal(fs.existsSync(outside), false, '前置条件：探针目录不应存在');
    process.env.ML_TEST_ROOT = outside;                  // W 之内、但不在四个授权子树内
    assert.throws(() => fixtureRoot(), /fixture_path_outside_authorized_roots/, '越界候选必须被拒绝');
    assert.equal(fs.existsSync(outside), false, '拒绝必须发生在**创建之前**（不得留下任何目录）');
    // 解析函数本身不得产生副作用
    const real = resolveRealPath(outside);
    assert.ok(real.replace(/\\/g, '/').endsWith('/_r7-fixture-outside-probe'));
    assert.equal(fs.existsSync(outside), false);
  } finally {
    if (original === undefined) delete process.env.ML_TEST_ROOT; else process.env.ML_TEST_ROOT = original;
    if (fs.existsSync(outside)) fs.rmSync(outside, { recursive: true, force: true });
  }
  // 默认根仍然可用，且确实落在授权子树内
  const info = describeFixtureRoot();
  assert.equal(info.inside_authorized_subtree, true, JSON.stringify(info));
  assert.ok(String(info.resolved_root).replace(/\\/g, '/').includes('/outputs/product-material-library-phase1-20261006/'));
  const dir = mkFixtureDir('ml-r7-preflight-');
  assert.ok(fs.existsSync(dir));
  assert.equal(authorizedSubtreeFor(dir) !== null, true);
});

// ─────────────── R6 STEP2：目标侧人工编辑与结果传播 ───────────────

test('R6-STEP2: target-side edit goes through the backend and survives an ordinary source reimport', async () => {
  const backend = createMemoryBackend();
  for (const t of ALL_TABLES) await backend.createTable(t);
  const recs = twoRecs();
  const key = recs[0].entity_key;
  await importRecords({ records: recs, backend, mode: 'r6_edit_double' });
  const row = (await backend.listAllRows(TABLE_VIDEOS)).find((r) => r.entity_key === key);
  assert.ok(row && row.id != null);

  const edit = await applyTargetEdit({
    backend, rowId: row.id, entityKey: key, reviewer: 'fixture-reviewer',
    note: 'R6 目标侧编辑：新备注（带证据）',
    classification: { product_category: '手机壳', state: 'reviewed' },
    evidenceRef: 'cards/tiktok-7679078728667778337.json#timeline[0]',
  });
  assert.equal(edit.ok, true, JSON.stringify(edit.checks));
  assert.equal(edit.after.review_reviewer, 'fixture-reviewer');
  assert.equal(edit.after.product_category, '手机壳');
  assert.equal(edit.after.product_category_origin, 'human_review');
  assert.equal(edit.after.product_category_evidence_ref, 'cards/tiktok-7679078728667778337.json#timeline[0]');
  assert.equal(edit.after.product_category_state, 'reviewed');

  // 普通来源复导入：目标人工编辑必须被保护、原样存活（不是被覆盖或丢弃）
  const replay = await importRecords({ records: recs, backend, mode: 'r6_edit_double' });
  assert.equal(replay.ok, true, JSON.stringify(replay.post_write_reconciliation[TABLE_VIDEOS]));
  const afterReplay = (await backend.listAllRows(TABLE_VIDEOS)).find((r) => r.entity_key === key);
  assert.equal(afterReplay.review_notes, edit.after.review_notes, '编辑后的备注必须存活');
  assert.equal(afterReplay.review_reviewer, 'fixture-reviewer');
  assert.equal(afterReplay.product_category, '手机壳');
  assert.equal(afterReplay.product_category_origin, 'human_review');
  assert.equal(afterReplay.product_category_reviewer, 'fixture-reviewer');
  assert.equal(replay.tables[TABLE_VIDEOS].inserted, 0);
});

test('R6-STEP2: a backend that drops the edit is detected, not reported as applied', async () => {
  const inner = createMemoryBackend();
  for (const t of ALL_TABLES) await inner.createTable(t);
  const recs = twoRecs();
  await importRecords({ records: recs, backend: inner, mode: 'r6_drop_edit_double' });
  const row = (await inner.listAllRows(TABLE_VIDEOS))[0];
  const dropping = {
    kind: 'drop_edit_double',
    async listAllRows(t) { return inner.listAllRows(t); },
    async insertRow(t, r) { return inner.insertRow(t, r); },
    // 吞掉 review_notes / selected_reference（模拟“改了但没落库”）
    async updateRow(t, id, patch) { const { review_notes, selected_reference, ...rest } = patch; return inner.updateRow(t, id, rest); },
  };
  const edit = await applyTargetEdit({ backend: dropping, rowId: row.id, entityKey: row.entity_key, reviewer: 'fixture-reviewer', note: '不应被吞掉' });
  assert.equal(edit.ok, false, '没落库就不许报成功');
  assert.ok(edit.checks.some((c) => c.name === 'review_notes_applied' && !c.ok), JSON.stringify(edit.checks));
});

test('R6-STEP2: runJourney never reports success for failed import, missing hit or a no-match probe that hits', async () => {
  const recs = twoRecs();
  const failedImport = {
    kind: 'failing_import_double',
    async listAllRows(t) { return t === TABLE_VIDEOS ? [] : []; },
    async insertRow() { throw new Error('simulated_target_unreachable'); },
    async updateRow() { throw new Error('simulated_target_unreachable'); },
  };
  const r1 = await runJourney({
    records: recs, loadWithOverlay: async () => recs, overlayPath: mkFixtureDir('ml-r6-fail-') + '/ov.json',
    root: mkFixtureDir('ml-r6-fail-root-'), requireMedia: false, backendMode: 'memory_isolation',
    createBackend: () => failedImport,
  });
  assert.equal(r1.ok, false, '导入失败不得 ok=true');
  assert.ok(r1.failures.some((f) => f.startsWith('initial_import_not_ok')), JSON.stringify(r1.failures));

  // 命中错位 / 未命中：把目标行的分类改掉 → 声明的检索必然 0 命中
  const noHit = {
    kind: 'no_hit_double',
    store: { [TABLE_VIDEOS]: [], [TABLE_METRICS]: [], [TABLE_RATIOS]: [], [TABLE_ASSETS]: [], [TABLE_SEGMENTS]: [] },
    async listAllRows(t) { return (this.store[t] ?? []).map((r) => (t === TABLE_VIDEOS ? { ...r, product_category: '被改掉的类别', scene_or_need: '被改掉的场景' } : r)); },
    async insertRow(t, r) { const rec = { id: 700 + this.store[t].length, ...r }; this.store[t].push(rec); return rec; },
    async updateRow(t, id, patch) { const r = this.store[t].find((x) => x.id === id); Object.assign(r, patch); return r; },
  };
  const r2 = await runJourney({
    records: recs, loadWithOverlay: async () => recs, overlayPath: mkFixtureDir('ml-r6-nohit-') + '/ov.json',
    root: mkFixtureDir('ml-r6-nohit-root-'), requireMedia: false, backendMode: 'memory_isolation',
    classification: { product_category: '手机壳', state: 'proposed' },
    classificationEvidenceRef: 'cards/x.json#t0',
    noMatchQuery: { product_category: '手机壳' },     // 与真实分类相同 → 探针必然命中 → 必须报失败
    createBackend: () => noHit,
  });
  assert.equal(r2.ok, false, JSON.stringify(r2.failures));
  assert.ok(r2.failures.some((f) => f.startsWith('lookup_returned_no_hit') || f.startsWith('lookup_hit_wrong_entity')), JSON.stringify(r2.failures));
});

test('R6-STEP2: unsupported journey backend modes are refused instead of falling back to memory', async () => {
  const recs = twoRecs();
  const common = { records: recs, loadWithOverlay: async () => recs, overlayPath: mkFixtureDir('ml-r6-mode-') + '/ov.json', root: mkFixtureDir('ml-r6-mode-root-'), requireMedia: false };
  await assert.rejects(() => runJourney({ ...common, backendMode: 'http' }), /journey_http_backend_not_configured/, 'http 模式缺配置必须拒绝，不得回落 memory');
  await assert.rejects(() => runJourney({ ...common, backendMode: 'sqlite' }), /unsupported_journey_backend_mode/);
  await assert.rejects(() => runJourney({ ...common }), /journey_requires_explicit_backend_mode/);
});

// ─────────────── R6 STEP1：歧义重复键阻断写入 ───────────────

test('R6-STEP1: pre-existing duplicate target key blocks writes to that key and its dependent children', async () => {
  const recs = twoRecs();
  const key0 = recs[0].entity_key;
  const payloadRow = rowsOf([recs[0]])[TABLE_VIDEOS][0];
  // 目标里预先存在**同键两行**：行 ID 不同、人工值不同（历史遗留，不由本工具产生）
  const store = {
    [TABLE_VIDEOS]: [
      { ...payloadRow, id: 501, review_notes: '人工备注-行A', review_status: 'reviewed', selected_reference: true },
      { ...payloadRow, id: 502, review_notes: '人工备注-行B', review_status: 'in_review', selected_reference: false },
    ],
    [TABLE_METRICS]: [], [TABLE_RATIOS]: [], [TABLE_ASSETS]: [], [TABLE_SEGMENTS]: [],
  };
  const backend = {
    kind: 'duplicate_holder_double',
    updates: [], inserts: [],
    async listAllRows(t) { return store[t] ?? []; },
    async insertRow(t, row) { this.inserts.push({ table: t, key: row[TABLE_PRIMARY_KEY[t]], entity_key: row.entity_key ?? null }); const rec = { id: 900 + this.inserts.length, ...row }; (store[t] ??= []).push(rec); return rec; },
    async updateRow(t, id, patch) { this.updates.push({ table: t, id, key: patch[TABLE_PRIMARY_KEY[t]] }); const r = (store[t] ?? []).find((x) => x.id === id); if (!r) throw new Error('target_row_not_found'); Object.assign(r, patch); return r; },
  };
  const changed = recs.map((r, i) => (i === 0 ? { ...r, evidence_fingerprint: `${r.evidence_fingerprint}-v2` } : r));
  const receipt = await importRecords({ records: changed, backend, mode: 'r6_ambiguous_double' });

  assert.equal(receipt.ok, false, '存在歧义键时不得报成功');
  assert.ok(receipt.ambiguous_keys[TABLE_VIDEOS].includes(key0), JSON.stringify(receipt.ambiguous_keys));
  const blocked = receipt.blocked_ambiguous_writes.filter((b) => b.table === TABLE_VIDEOS && b.key === key0);
  assert.equal(blocked.length, 1, JSON.stringify(receipt.blocked_ambiguous_writes));
  assert.equal(blocked[0].reason, 'target_has_duplicate_primary_key');
  assert.equal(receipt.tables[TABLE_VIDEOS].blocked, 1);

  // 两行都**未被更新**（不选赢家），人工值原样保留
  assert.equal(backend.updates.filter((u) => u.id === 501 || u.id === 502).length, 0, '歧义行不得被更新');
  const rowsForKey = store[TABLE_VIDEOS].filter((r) => r.entity_key === key0);
  assert.equal(rowsForKey.length, 2);
  assert.deepEqual(rowsForKey.map((r) => r.review_notes).sort(), ['人工备注-行A', '人工备注-行B']);
  assert.deepEqual(rowsForKey.map((r) => r.id).sort(), [501, 502]);

  // 依赖子行被阻断，且**没有**关联到任何一个候选赢家
  const dep = receipt.blocked_ambiguous_writes.filter((b) => b.table === TABLE_METRICS && b.reason === 'dependent_row_of_ambiguous_parent');
  assert.ok(dep.length >= 1, JSON.stringify(receipt.blocked_ambiguous_writes));
  assert.equal(store[TABLE_METRICS].filter((m) => m.entity_key === key0).length, 0, '歧义父键的子行不得写入');
  assert.equal(backend.inserts.filter((i) => i.table === TABLE_METRICS && i.entity_key === key0).length, 0, '不得为歧义父键写入任何子行');

  // 不受影响的独立键照常写入
  assert.ok(receipt.tables[TABLE_VIDEOS].inserted >= 1, `独立键应继续处理：${JSON.stringify(receipt.tables[TABLE_VIDEOS])} errors=${JSON.stringify(receipt.errors.slice(0, 3))}`);
});

test('R6-STEP1: test fixtures are written inside the authorized workspace, verified by realpath', () => {
  const info = describeFixtureRoot();
  assert.equal(info.inside_workspace, true, JSON.stringify(info));
  assert.ok(String(info.resolved_root).replace(/\\/g, '/').includes('/outputs/product-material-library-phase1-20261006/'), JSON.stringify(info));
  const dir = mkFixtureDir('ml-preflight-');
  const real = (fs.realpathSync.native ? fs.realpathSync.native(dir) : fs.realpathSync(dir)).replace(/\\/g, '/');
  assert.ok(real.startsWith(String(info.workspace).replace(/\\/g, '/')), real);
});

// ─────────────── R5 STEP2：最终人工状态与目标唯一性 ───────────────

test('R5-STEP3: representative manifest is consumed unchanged by the same importer, is not a prefix, and rejects bad keys', async () => {
  const recs = twoRecs();
  const manifest = buildRepresentativeSample(recs, { size: 2 });
  assert.equal(manifest.version, 1);
  assert.equal(manifest.entity_keys.length, 2);
  assert.deepEqual(manifest.entity_keys, [recs[0].entity_key, recs[1].entity_key].slice(0, manifest.entity_keys.length));
  const resolved = resolveManifest(recs, manifest);
  assert.equal(resolved.ok, true, JSON.stringify(resolved.problems));
  // 清单顺序被保留，且身份与源记录逐字节相同（不是索引/序号）
  assert.deepEqual(resolved.records.map((r) => r.entity_key), manifest.entity_keys);
  const receipt = await (async () => {
    const backend = createMemoryBackend();
    for (const t of ALL_TABLES) await backend.createTable(t);
    return importRecords({ records: resolved.records, backend, mode: 'r5_manifest_double' });
  })();
  assert.equal(receipt.planned[TABLE_VIDEOS], resolved.records.length, '清单选择必须原样到达导入器');
  // 未知键 / 重复键必须显式拒绝，且不合成替代
  const unknown = resolveManifest(recs, { version: 1, entity_keys: [recs[0].entity_key, 'TikTok|main|99999999999999999999'], coverage: {} });
  assert.equal(unknown.ok, false);
  assert.deepEqual(unknown.unknown_keys, ['TikTok|main|99999999999999999999']);
  assert.equal(unknown.records.length, 1, '不存在的键不得被替代或扩张');
  const dup = resolveManifest(recs, { version: 1, entity_keys: [recs[0].entity_key, recs[0].entity_key], coverage: {} });
  assert.equal(dup.ok, false);
  assert.deepEqual(dup.duplicate_keys, [recs[0].entity_key]);
  assert.equal(validateManifest({ version: 2, entity_keys: [] }).ok, false);
  assert.equal(validateManifest({ version: 1, entity_keys: 'nope' }).ok, false);
});

test('R5-STEP3: a prefix slice is demonstrably not representative while the manifest is', async () => {
  const recs = twoRecs();
  const prefix = recs.slice(0, 1);
  const manifest = buildRepresentativeSample(recs, { size: 2 });
  const covPrefix = coverageOf(prefix);
  const covManifest = coverageOf(resolveManifest(recs, manifest).records);
  assert.ok(covManifest.chosen >= covPrefix.chosen);
  // 覆盖说明必须来自真实选中身份（chosen 与实际条数一致）
  assert.equal(covManifest.chosen, manifest.entity_keys.length);
  assert.equal(covPrefix.chosen, prefix.length);
  assert.ok(Object.keys(covManifest.by_platform_namespace).length >= Object.keys(covPrefix.by_platform_namespace).length);
});

test('R5-STEP2: first human values persist on insert; changed evidence preserves them and sets stale with reason', async () => {
  const backend = createMemoryBackend();
  for (const t of ALL_TABLES) await backend.createTable(t);
  const base = twoRecs();
  const key = base[0].entity_key;
  // 隔离夹具的人工值（非 Simon 审批）：状态/备注/精选/分类 + 来源归属
  base[0].review = { ...base[0].review, status: 'reviewed', reviewer: 'fixture-reviewer', notes: ['必须保留的人工备注 A'], human_value_categories: ['creative_reference'], selected_reference: true };
  base[0].classification = {
    ...base[0].classification,
    product_function: '防摔', product_function_origin: 'human_review', product_function_reviewer: 'fixture-reviewer',
    product_function_evidence_ref: 'cards/tiktok-7679078728667778337.json#timeline[0]', product_function_state: 'reviewed',
  };
  const first = await importRecords({ records: base, backend, mode: 'r5_double' });
  assert.equal(first.ok, true, JSON.stringify(first.post_write_reconciliation[TABLE_VIDEOS]));
  const row0 = (await backend.listAllRows(TABLE_VIDEOS)).find((r) => r.entity_key === key);
  assert.equal(row0.review_status, 'reviewed', '首次插入必须落人工状态');
  assert.match(String(row0.review_notes), /必须保留的人工备注 A/);
  assert.equal(row0.selected_reference, true);
  assert.equal(row0.product_function, '防摔');
  assert.equal(row0.product_function_origin, 'human_review');
  assert.equal(row0.product_function_state, 'reviewed');

  // 来源证据变化：人工值保留，且 stale 与原因必须真的落库（逐字段核对，不整族豁免）
  const changed = base.map((r, i) => (i === 0 ? { ...r, evidence_fingerprint: `${r.evidence_fingerprint}-v2` } : r));
  const second = await importRecords({ records: changed, backend, mode: 'r5_double' });
  assert.equal(second.ok, true, JSON.stringify(second.post_write_reconciliation[TABLE_VIDEOS].field_mismatches.slice(0, 2)));
  const row1 = (await backend.listAllRows(TABLE_VIDEOS)).find((r) => r.entity_key === key);
  assert.equal(row1.review_status, 'reviewed');
  assert.match(String(row1.review_notes), /必须保留的人工备注 A/);
  assert.equal(row1.selected_reference, true);
  assert.equal(row1.product_function, '防摔');
  assert.match(String(row1.product_function_evidence_ref), /cards\/tiktok/);
  assert.equal(row1.review_stale, true, '证据变化必须置 stale');
  assert.match(String(row1.review_stale_reason), /evidence_changed/);
});

test('R5-STEP2: a backend that drops human notes cannot report successful reconciliation', async () => {
  const base = createMemoryBackend();
  for (const t of ALL_TABLES) await base.createTable(t);
  const swallowing = {
    kind: 'swallow_human_fields_double',
    async listAllRows(t) {
      const rows = await base.listAllRows(t);
      return t === TABLE_VIDEOS ? rows.map((r) => ({ ...r, review_notes: null, review_stale: false })) : rows;
    },
    async insertRow(t, row) { return base.insertRow(t, row); },
    async updateRow(t, id, patch) { return base.updateRow(t, id, patch); },
  };
  const recs = twoRecs();
  recs[0].review = { ...recs[0].review, status: 'reviewed', reviewer: 'fixture-reviewer', notes: ['必须保留的人工备注 B'], selected_reference: true };
  const receipt = await importRecords({ records: recs, backend: swallowing, mode: 'r5_swallow_double' });
  assert.equal(receipt.ok, false, '人工字段没有真正落库时不得报成功');
  const fm = receipt.post_write_reconciliation[TABLE_VIDEOS].field_mismatches;
  assert.ok(fm.length > 0);
  assert.ok(fm.some((m) => m.mismatches.some((x) => x.field === 'review_notes')), JSON.stringify(fm.slice(0, 2)));
});

test('R5-STEP2: a target duplicate key visible only on final readback is detected, never collapsed or deleted', async () => {
  const base = createMemoryBackend();
  for (const t of ALL_TABLES) await base.createTable(t);
  let inserts = 0;
  const dupOnFinal = {
    kind: 'duplicate_on_final_readback_double',
    async listAllRows(t) {
      const rows = await base.listAllRows(t);
      if (t !== TABLE_VIDEOS || inserts === 0) return rows;   // 预写读回干净；写后才出现重复
      return rows.length ? [...rows, { ...rows[0], id: 99999 }] : rows;
    },
    async insertRow(t, row) { inserts++; return base.insertRow(t, row); },
    async updateRow(t, id, patch) { return base.updateRow(t, id, patch); },
  };
  const receipt = await importRecords({ records: twoRecs(), backend: dupOnFinal, mode: 'r5_dup_double' });
  assert.equal(receipt.ok, false, '目标重复主键不得被 Map 静默折叠成成功');
  const d = receipt.target_duplicates.find((x) => x.table === TABLE_VIDEOS);
  assert.ok(d, JSON.stringify(receipt.target_duplicates));
  assert.equal(d.source, 'post_write_readback');
  assert.ok(d.duplicate_count >= 1);
  assert.ok(d.sample[0].row_ids.every((x) => x !== null), '必须同时报告两条目标行 ID');
  const err = receipt.errors.find((e) => e.error_code === 'duplicate_target_primary_key');
  assert.ok(err && /人工核对/.test(err.recovery_path), '必须给出非破坏性恢复路径');
  assert.equal((await base.listAllRows(TABLE_VIDEOS)).length, 2, '目标数据不得被删除');
});
test('R4-F6: loopback media adapter serves identical bytes; missing and non-video are explicit', async () => {
  const tmp = mkFixtureDir('ml-media-');
  const file = path.join(tmp, 'clip.mp4');
  const bytes = Buffer.from('material-library-test-bytes-0123456789');
  fs.writeFileSync(file, bytes);
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const records = [
    {
      entity_key: 'TikTok|main|1',
      assets: [{
        asset_id: 'a-video', local_path: file, media_kind: 'video', usable_as_video: true,
        bytes: bytes.length, sha256: sha, verified_present_locally: true,
        segments: [{ segment_id: 's1', index: 0, t_label: '00:03.000', start_seconds: 3, kind: 'original_fact', fact_origin: 'source_fact', origin_card: 'cards/a.json', coverage: 'sparse' }],
      }],
    },
    { entity_key: 'TikTok|main|2', assets: [{ asset_id: 'a-image', local_path: path.join(tmp, 'sheet.jpg'), media_kind: 'image', usable_as_video: false, kind_reject_reason: 'contact_sheet_is_image', segments: [] }] },
    { entity_key: 'TikTok|main|3', assets: [{ asset_id: 'a-gone', local_path: path.join(tmp, 'gone.mp4'), media_kind: 'video', usable_as_video: true, segments: [] }] },
  ];
  const index = createMediaIndex(records);
  const srv = createMediaServer({ index });
  const { url } = await srv.listen();
  try {
    const check = await verifyMediaRoute({ url, index });
    assert.equal(check.ok, true, JSON.stringify(check.checks));
    assert.equal((await fetch(`${url}/media/asset/a-gone`)).status, 410, '记录在、文件不在 → 显式缺失');
    assert.equal((await fetch(`${url}/media/asset/a-image?as=video`)).status, 415, '图像不得按视频提供');
    const seg = await (await fetch(`${url}/media/asset/a-video/segment/0`)).json();
    assert.equal(seg.segment.start_seconds, 3);
    assert.equal((await fetch(`${url}/media/asset/unknown`)).status, 404);
  } finally { await srv.close(); }
  assert.throws(() => createMediaServer({ index, host: '0.0.0.0' }), /media_adapter_is_loopback_only/);
});

// ─────────────── R7 STEP2：既有目标行上的真实查询/编辑 + HTTP 契约保真 ───────────────

const withClassification = (recs, over) => recs.map((r) => ({ ...r, classification: { ...r.classification, ...over } }));

/** 带一段**真实存在**的可用媒体与片段的记录（usable_as_video 需要文件真的存在）。 */
function mediaRecs() {
  const dir = mkFixtureDir('ml-r7-media-');
  const file = path.join(dir, 'a.mp4');
  const bytes = Buffer.from('r7-media-bytes-0123456789');
  fs.writeFileSync(file, bytes);
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const seg = {
    segment_id: 's-a', index: 0, t_label: '00:04.250', start_seconds: 4.25, observed: 'x',
    onscreen_text: null, speech: null, kind: 'original_fact', fact_origin: 'source_fact',
    origin_card: 'cards/a.json', origin_method: 'per_tile_exact_seek', time_accuracy_note: null,
    coverage: 'sparse', review_status: 'unreviewed', selected_reference: false, human_note: null,
  };
  return [normalizeEntity(entity(), [fieldRow('engagement_like', 'present_and_usable', 5)], {
    mediaIndex: new Map([['TikTok|main|7677920051269455125', {
      asset_id: 'a-1', platform: 'TikTok', native_id: '7677920051269455125', cohort: 't',
      local_path: file, media_kind: 'video', bytes: bytes.length, sha256: sha,
      usable_as_video: true, verified_present_locally: true, segments: [seg], segment_count: 1,
    }]]),
  })];
}

/**
 * 只 mock **外部传输**：按 Baserow REST 的**严格 API 形状**在内存里存行
 * （single_select = {id,value}、link_row = [{id}]、未知字段名 → 400 拒绝）。
 * 交付代码的 createHttpClient/createHttpBackend/decodeApiRow/encodeWritePayload 全部真实执行。
 */
function httpContractTransport({ tableIds, fieldMeta }) {
  const typesByTable = {};
  for (const t of planSchema().tables) typesByTable[t.name] = Object.fromEntries(t.fields.map((f) => [f.name, f.type]));
  const store = new Map();
  const requests = [];
  let nextId = 1000;
  const jsonRes = (status, obj) => ({ ok: status < 400, status, text: async () => JSON.stringify(obj) });
  const nameOfTableId = (id) => Object.entries(tableIds).find(([, v]) => Number(v) === Number(id))?.[0] ?? null;
  const selectValue = (table, field, id) => {
    const opts = fieldMeta?.[table]?.[field]?.select_options ?? [];
    return opts.find((o) => Number(o.id) === Number(id))?.value ?? id;
  };
  const toApiShape = (table, patch) => {
    const types = typesByTable[table] ?? {};
    const out = {};
    for (const [k, v] of Object.entries(patch)) {
      const t = types[k];
      if (t === undefined) { const e = new Error(`unknown_field:${table}.${k}`); e.status = 400; throw e; }
      if (t === 'single_select') out[k] = { id: Number(v), value: selectValue(table, k, v) };
      else if (t === 'link_row') out[k] = (Array.isArray(v) ? v : []).map((x) => ({ id: Number(x) }));
      else out[k] = v;
    }
    return out;
  };
  const fetchImpl = async (url, init = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    const path = new URL(url).pathname;
    requests.push({ method, path, body });
    const m = path.match(/^\/api\/database\/rows\/table\/(\d+)\/(?:row\/)?(\d+)?\/?$/);
    if (!m) return jsonRes(404, { error: 'NOT_FOUND', path });
    const tableId = Number(m[1]);
    const rowId = m[2] ? Number(m[2]) : null;
    const table = nameOfTableId(tableId);
    const rows = store.get(tableId) ?? new Map();
    if (method === 'GET') return jsonRes(200, { results: [...rows.values()], next: null, count: rows.size });
    let api;
    try { api = toApiShape(table, body ?? {}); } catch (e) { return jsonRes(e.status ?? 400, { error: 'ERROR_REQUEST_BODY_VALIDATION', detail: String(e.message) }); }
    if (method === 'POST') {
      const id = nextId++;
      const rec = { id, order: String(id), ...api };
      rows.set(id, rec); store.set(tableId, rows);
      return jsonRes(200, rec);
    }
    if (method === 'PATCH') {
      const cur = rows.get(rowId);
      if (!cur) return jsonRes(404, { error: 'ROW_DOES_NOT_EXIST' });
      const rec = { ...cur, ...api };
      rows.set(rowId, rec); store.set(tableId, rows);
      return jsonRes(200, rec);
    }
    return jsonRes(405, { error: 'METHOD_NOT_ALLOWED' });
  };
  return { fetchImpl, store, requests, apiRows: (tableId) => [...(store.get(tableId)?.values() ?? [])] };
}

function httpContractHarness() {
  const tableIds = Object.fromEntries(ALL_TABLES.map((t, i) => [t, 20 + i]));
  const fieldMeta = Object.fromEntries(planSchema().tables.map((t) => [t.name, Object.fromEntries(
    t.fields.filter((f) => f.type === 'single_select')
      .map((f) => [f.name, { select_options: (f.options ?? []).map((o, i) => ({ id: 9000 + i, value: o })) }]),
  )]));
  const transport = httpContractTransport({ tableIds, fieldMeta });
  const makeBackend = () => createHttpBackend({
    client: createHttpClient({ baseUrl: 'http://127.0.0.1:1', token: 'r7-test-token', fetchImpl: transport.fetchImpl }),
    tableIds, fieldMeta,
  });
  return { tableIds, fieldMeta, transport, makeBackend };
}

test('R7-STEP2: classification VALUE, state and provenance all survive the real HTTP encode/decode boundary', async () => {
  const { tableIds, transport, makeBackend } = httpContractHarness();
  const recs = withClassification(mediaRecs(), { product_category: '手机壳', scene_or_need: '静态产品展示' });
  const first = await importRecords({ records: recs, backend: makeBackend(), mode: 'baserow_http', mediaBaseUrl: 'http://127.0.0.1:8420' });
  assert.equal(first.ok, true, JSON.stringify(first.errors.slice(0, 3)));
  assert.equal(first.media_service.state, 'published');

  const backend = makeBackend();
  const row = (await backend.listAllRows(TABLE_VIDEOS)).find((r) => r.entity_key === recs[0].entity_key);
  assert.ok(row, '导入后必须能从目标读回该行');
  const edit = await applyTargetEdit({
    backend, rowId: row.id, entityKey: row.entity_key, note: 'R7 边界编辑（带原因）', reviewer: 'r7-boundary-reviewer',
    classification: { product_category: '手机壳配件', scene_or_need: '静态产品展示', state: 'reviewed', not_a_schema_field: 'x' },
    evidenceRef: 'cards/a.json#t0',
  });
  assert.equal(edit.ok, true, JSON.stringify(edit.checks.filter((c) => !c.ok)));
  assert.deepEqual(edit.ignored_classification_keys, ['not_a_schema_field'], '非契约键必须是元数据，不得当成字段');
  const after = (await backend.listAllRows(TABLE_VIDEOS)).find((r) => r.entity_key === recs[0].entity_key);
  assert.equal(after.product_category, '手机壳配件', '值必须真的落地（仅有 origin/reviewer 不算）');
  assert.equal(after.product_category_state, 'reviewed', '状态必须落在既有 *_state 契约字段上');
  assert.equal(after.product_category_reviewer, 'r7-boundary-reviewer');
  assert.equal(after.product_category_evidence_ref, 'cards/a.json#t0');
  assert.equal(Object.prototype.hasOwnProperty.call(after, 'state'), false, '不得把 state 当字段写进行');
  assert.equal(Object.prototype.hasOwnProperty.call(after, 'state_origin'), false, '不得产生 state_origin 之类非 schema 垃圾');
  // 传输层（严格形状）从未见到非 schema 字段；API 行里 single_select 仍是 {id,value}
  assert.ok(transport.requests.every((q) => !q.body || !Object.keys(q.body).some((k) => k === 'state' || k === 'state_origin')), '编码阶段就必须丢掉非 schema 键');
  const apiRow = transport.apiRows(tableIds[TABLE_VIDEOS]).find((r) => r.entity_key === recs[0].entity_key);
  assert.equal(apiRow.product_category_state.value, 'reviewed');
  assert.equal(apiRow.product_category, '手机壳配件');
});

test('R7-STEP2: a backend that keeps provenance but drops the classification VALUE must fail', async () => {
  const inner = createMemoryBackend();
  for (const t of ALL_TABLES) await inner.createTable(t);
  await importRecords({ records: twoRecs(), backend: inner, mode: 'r7_value_drop_seed' });
  const row = (await inner.listAllRows(TABLE_VIDEOS))[0];
  const valueDropping = {
    kind: 'value_dropping_double',
    async listAllRows(t) { return inner.listAllRows(t); },
    async insertRow(t, r) { return inner.insertRow(t, r); },
    async updateRow(t, id, patch) {
      const { product_category, ...rest } = patch;   // 只吞掉**值**，保留 origin/reviewer/state
      return inner.updateRow(t, id, rest);
    },
  };
  const edit = await applyTargetEdit({
    backend: valueDropping, rowId: row.id, entityKey: row.entity_key, reviewer: 'r7-reviewer', note: '值被吞掉',
    classification: { product_category: '手机壳', state: 'reviewed' }, evidenceRef: 'cards/x.json#t0',
  });
  assert.equal(edit.ok, false, '值没落地就不许报成功');
  const failed = edit.checks.filter((c) => !c.ok).map((c) => c.name);
  assert.ok(failed.includes('product_category_value_applied'), JSON.stringify(edit.checks));
  assert.ok(!failed.includes('product_category_provenance_applied'), '元数据确实落地了 → 只有“值”这一项失败，才说明检查真的区分二者');
});

test('R7-STEP2: an unconfigured media import never revokes an already published link; explicit unpublish does', async () => {
  const { makeBackend, transport, tableIds } = httpContractHarness();
  const recs = mediaRecs();
  const published = await importRecords({ records: recs, backend: makeBackend(), mode: 'baserow_http', mediaBaseUrl: 'http://127.0.0.1:8420' });
  assert.equal(published.ok, true, JSON.stringify(published.errors.slice(0, 3)));
  const url0 = (await makeBackend().listAllRows(TABLE_ASSETS))[0].media_view_url;
  assert.equal(url0, 'http://127.0.0.1:8420/viewer?asset=a-1');

  // 第二次调用：**新的后端实例**（等价于第二个进程）且**未提供**发布选项 → 必须保留
  const unspecified = await importRecords({ records: recs, backend: makeBackend(), mode: 'baserow_http' });
  assert.equal(unspecified.media_service.option_provided, false);
  assert.equal(unspecified.media_service.semantics, 'unspecified_preserve_existing_target_links');
  const assetAfter = (await makeBackend().listAllRows(TABLE_ASSETS))[0];
  assert.equal(assetAfter.media_view_url, url0, '未配置发布 ≠ 撤销既有已发布链接');
  assert.equal(assetAfter.media_service_state, 'published');
  assert.equal((await makeBackend().listAllRows(TABLE_SEGMENTS))[0].view_url, 'http://127.0.0.1:8420/viewer?asset=a-1&t=4.25');
  assert.ok(unspecified.media_publication_preserved.some((x) => x.table === TABLE_ASSETS && x.field === 'media_view_url' && x.kept === url0),
    '未指定发布时必须**记录**“本次载荷本会撤销该链接、但被保留”，不能静默');

  // 显式停止发布：清除链接并如实标 not_published
  const cleared = await importRecords({ records: recs, backend: makeBackend(), mode: 'baserow_http', mediaBaseUrl: null });
  assert.equal(cleared.media_service.semantics, 'explicit_unpublish_clears_links');
  const assetCleared = (await makeBackend().listAllRows(TABLE_ASSETS))[0];
  assert.equal(assetCleared.media_view_url, null);
  assert.equal(assetCleared.media_service_state, 'not_published');
  assert.ok(transport.apiRows(tableIds[TABLE_ASSETS]).length === 1, '整个过程只应有一条资产行（不是重建目标）');
});

test('R7-STEP2: the real user path never prepares fixtures and preserves pre-existing target state', async () => {
  const recs = twoRecs();
  const tmpRoot = mkFixtureDir('ml-r7-realpath-');
  const overlayPath = path.join(tmpRoot, 'fixtures', 'journey-overlay.json');
  const backend = createMemoryBackend();
  for (const t of ALL_TABLES) await backend.createTable(t);
  // 目标**先**被填充，并且带着**R7 之前就存在**的人工状态
  await importRecords({ records: recs, backend, mode: 'r7_prefill' });
  const pre = (await backend.listAllRows(TABLE_VIDEOS))[0];
  const prior = await applyTargetEdit({
    backend, rowId: pre.id, entityKey: pre.entity_key, note: '既有目标侧人工备注（本包之前就存在）',
    reviewer: 'prior-human', classification: { product_category: '手机壳', scene_or_need: '静态产品展示', state: 'reviewed' },
    evidenceRef: 'cards/prior.json#t0',
    // R9-STEP2.3：复核状态必须**显式请求**才会写；这里显式请求 reviewed（不再是“加备注即 reviewed”）
    reviewStatus: 'reviewed',
  });
  assert.equal(prior.ok, true, JSON.stringify(prior.checks.filter((c) => !c.ok)));

  const res = await runJourney({
    records: recs, loadWithOverlay: async () => recs, overlayPath, root: tmpRoot, requireMedia: false,
    backendMode: 'memory_isolation', createBackend: () => backend,
    classification: { product_category: '手机壳' },
    noMatchQuery: { product_category: '不可能存在的类别-探针' },
  });
  assert.equal(res.ok, true, JSON.stringify(res.failures));
  assert.equal(res.transcript.fixture_setup_executed, false, '真实用户路径不得自动准备夹具');
  assert.equal(fs.existsSync(overlayPath), false, '真实用户路径不得写夹具覆盖层文件');
  const step6 = res.transcript.steps.find((s) => s.step === 6);
  assert.equal(step6.isolated_fixture, false);
  const step7 = res.transcript.steps.find((s) => s.step === 7);
  assert.equal(step7.prepopulated_target_row, true, '必须承认目标行本来就在');
  assert.equal(step7.pre_import_row.row_id, pre.id);
  assert.match(String(step7.pre_import_row.review_notes), /本包之前就存在/);
  assert.equal(step7.pre_import_row.review_status, 'reviewed');
  assert.ok(step7.lookup.hit_count >= 1, JSON.stringify(step7.lookup));
  // 导入之后目标侧既有状态原样保留（行 ID/命名空间/人工值）
  const after = (await backend.listAllRows(TABLE_VIDEOS)).find((r) => r.entity_key === pre.entity_key);
  assert.equal(after.id, pre.id, '行 ID 不得变化');
  assert.match(String(after.review_notes), /本包之前就存在/);
  assert.equal(after.review_reviewer, 'prior-human');
  assert.equal(after.product_category, '手机壳');
  assert.equal(after.product_category_state, 'reviewed');
});

test('R7-STEP2: a second journey invocation on the same populated backend keeps the prior edit (no rebuild, no memory fallback)', async () => {
  const recs = twoRecs();
  const backend = createMemoryBackend();
  for (const t of ALL_TABLES) await backend.createTable(t);
  const tmpRootA = mkFixtureDir('ml-r7-seq1-');
  const tmpRootB = mkFixtureDir('ml-r7-seq2-');
  const common = {
    records: recs, loadWithOverlay: async () => recs, requireMedia: false,
    backendMode: 'memory_isolation', createBackend: () => backend,
    classification: { product_category: '手机壳', scene_or_need: '静态产品展示' },
  };
  // 目标**先**被填充并带既有分类（模拟“已经用过的库”，不是本次旅程新建的）
  await importRecords({ records: recs, backend, mode: 'r7_seq_seed' });
  const seeded = (await backend.listAllRows(TABLE_VIDEOS))[0];
  const seededEdit = await applyTargetEdit({
    backend, rowId: seeded.id, entityKey: seeded.entity_key, note: '库中既有备注（第二次调用之前）',
    reviewer: 'prior-human', classification: { product_category: '手机壳', scene_or_need: '静态产品展示', state: 'reviewed' },
    evidenceRef: 'cards/seed.json#t0',
  });
  assert.equal(seededEdit.ok, true, JSON.stringify(seededEdit.checks.filter((c) => !c.ok)));

  // 第一次调用：显式人工编辑（走目标 backend）
  const first = await runJourney({
    ...common, overlayPath: path.join(tmpRootA, 'ov.json'), root: tmpRootA,
    manualEdit: {
      note: '第一次调用的显式编辑', reviewer: 'r7-first', evidenceRef: 'cards/first.json#t0',
      classification: { product_category: '手机壳', scene_or_need: '静态产品展示', state: 'reviewed' },
    },
  });
  assert.equal(first.ok, true, JSON.stringify(first.failures));
  const s7a = first.transcript.steps.find((s) => s.step === 7);
  const rowId = s7a.target_row_after_edit.row_id;
  assert.match(String(s7a.target_row_after_edit.review_notes), /第一次调用的显式编辑/);

  // 第二次调用：**同一个已填充 backend**（不重建、不清空），只读查询 + 复导入
  const second = await runJourney({ ...common, overlayPath: path.join(tmpRootB, 'ov.json'), root: tmpRootB });
  assert.equal(second.ok, true, JSON.stringify(second.failures));
  const s7b = second.transcript.steps.find((s) => s.step === 7);
  assert.equal(s7b.prepopulated_target_row, true, '第二次调用必须看到已填充目标，而不是新建库');
  assert.equal(s7b.pre_import_row.row_id, rowId, '目标行 ID 必须保持（不得重建）');
  assert.match(String(s7b.pre_import_row.review_notes), /第一次调用的显式编辑/, '上一次的人工备注必须还在');
  assert.equal(s7b.pre_import_row.product_category, '手机壳');
  assert.ok(s7b.lookup.hit_count >= 1);
  const rows = await backend.listAllRows(TABLE_VIDEOS);
  assert.equal(rows.length, 2, '两次调用合计仍只有两行（没有重建也没有重复插入）');
  assert.equal(rows.find((r) => r.id === rowId).review_reviewer, 'r7-first');
});

test('R7-STEP3: one sequential media regression on the same populated target — publish, journey reimport, consumer fetch, restart, explicit unpublish', async () => {
  const recs = mediaRecs();
  const index = createMediaIndex(recs);
  const srv = createMediaServer({ index });
  const { url: base } = await srv.listen();
  const tmp = mkFixtureDir('ml-r7-media-seq-');
  const { makeBackend } = httpContractHarness();
  try {
    // 1) 发布 + 首次导入（真实 HTTP 编解码边界；发布地址来自**实际监听**的端口）
    const published = await importRecords({ records: recs, backend: makeBackend(), mode: 'baserow_http', mediaBaseUrl: base });
    assert.equal(published.ok, true, JSON.stringify(published.errors.slice(0, 3)));
    const url0 = (await makeBackend().listAllRows(TABLE_ASSETS))[0].media_view_url;
    assert.equal(url0, `${base}/viewer?asset=a-1`);
    assert.equal((await makeBackend().listAllRows(TABLE_SEGMENTS))[0].view_url, `${base}/viewer?asset=a-1&t=4.25`);

    // 2) 用户旅程（只读查询 + 显式编辑 + 普通复导入），**未指定**发布选项
    const res = await runJourney({
      records: recs, loadWithOverlay: async () => recs, overlayPath: path.join(tmp, 'ov.json'),
      root: tmp, requireMedia: true, backendMode: 'http', createHttpBackend: async () => makeBackend(),
      manualEdit: {
        note: 'R7 媒体顺序回归：人工备注', reviewer: 'r7-media-reviewer',
        classification: { product_category: '手机壳', scene_or_need: '静态产品展示', state: 'reviewed' },
        evidenceRef: 'cards/a.json#t0',
      },
    });
    assert.equal(res.ok, true, JSON.stringify(res.failures));
    const s7 = res.transcript.steps.find((s) => s.step === 7);
    assert.equal(s7.prepopulated_target_row, true, '第二次导入前目标本就有行');
    // 3) 复导入后目标侧仍持有**同一个 asset 的同一条完整链接与状态**
    const assetRow = (await makeBackend().listAllRows(TABLE_ASSETS))[0];
    assert.equal(assetRow.asset_id, 'a-1');
    assert.equal(assetRow.media_view_url, url0, '复导入不得撤销已发布链接');
    assert.equal(assetRow.media_service_state, 'published');
    const segRow = (await makeBackend().listAllRows(TABLE_SEGMENTS))[0];
    assert.equal(segRow.view_url, `${base}/viewer?asset=a-1&t=4.25`, '非零片段时刻必须仍在链接里');
    assert.ok(Number(segRow.view_url.match(/t=([\d.]+)/)[1]) > 0, '片段时刻必须非零');
    assert.equal(s7.media_publication_after.assets[0].media_view_url, url0);

    // 4) 消费端（浏览器/播放器同一入口）真的能取回：链接 → 页面 → 同一 asset
    const pageRes = await fetch(assetRow.media_view_url);
    const html = await pageRes.text();
    assert.equal(pageRes.status, 200);
    assert.ok(html.includes('data-asset-id="a-1"'), '记录里的绝对链接必须打开同一个 asset');
    assert.equal((await fetch(segRow.view_url)).status, 200, '带非零 t 的片段入口必须可打开');

    // 5) 重启/端口变化：旧地址失效 → 用新端口重新发布后链接更新且仍可消费
    const oldUrl = assetRow.media_view_url;
    await srv.close();
    let oldFailed = false;
    try { const r = await fetch(oldUrl); oldFailed = r.status >= 400; } catch { oldFailed = true; }
    assert.equal(oldFailed, true, '服务停止后旧地址不得继续“可用”');
    const srv2 = createMediaServer({ index });
    const { url: base2 } = await srv2.listen();
    try {
      const republished = await importRecords({ records: recs, backend: makeBackend(), mode: 'baserow_http', mediaBaseUrl: base2 });
      assert.equal(republished.ok, true, JSON.stringify(republished.errors.slice(0, 3)));
      const afterRestart = (await makeBackend().listAllRows(TABLE_ASSETS))[0];
      assert.equal(afterRestart.media_view_url, `${base2}/viewer?asset=a-1`, '重新发布必须把链接改到新端口');
      assert.equal((await fetch(afterRestart.media_view_url)).status, 200, '新链接必须立刻可用');

      // 6) 显式停止发布：清除链接、如实标 not_published（不是“没配置”）
      const cleared = await importRecords({ records: recs, backend: makeBackend(), mode: 'baserow_http', mediaBaseUrl: null });
      assert.equal(cleared.media_service.semantics, 'explicit_unpublish_clears_links');
      const afterClear = (await makeBackend().listAllRows(TABLE_ASSETS))[0];
      assert.equal(afterClear.media_view_url, null);
      assert.equal(afterClear.media_service_state, 'not_published');
      assert.equal((await makeBackend().listAllRows(TABLE_SEGMENTS))[0].view_url, null);
      // 清除之后**仍不再“未指定即恢复”**：未指定导入不会凭空造出链接
      await importRecords({ records: recs, backend: makeBackend(), mode: 'baserow_http' });
      assert.equal((await makeBackend().listAllRows(TABLE_ASSETS))[0].media_view_url, null, '未指定 ≠ 自动发布');
    } finally { await srv2.close(); }
  } finally {
    try { await srv.close(); } catch { /* 已关闭 */ }
  }
});

// ─────────────── R8：只读查询 / 身份绑定显式编辑 / 只读导出 / 磁盘消费恢复（走真实 CLI） ───────────────

const R8_CLI = path.join(W_ROOT, 'tools', 'material-library', 'cli.mjs');
const R8_MANIFEST = path.join(W_ROOT, 'outputs', 'product-material-library-phase1-20261006', 'representative-sample-r5.json');
const r8Base = (d) => ['--target', 'http', '--base-url', d.url, '--database-id', '1', '--token', 'r8-token', '--mgmt-token', 'r8-jwt'];

/** 每个用例一个隔离替身目标（同一 store 文件被多次 CLI 调用共享）。 */
async function withR8Target(name, fn) {
  const storePath = path.join(mkFixtureDir('ml-r8-'), `${name}-store.json`);
  const out = path.join(path.dirname(storePath), `${name}-out`);
  fs.mkdirSync(out, { recursive: true });
  const d = await startBaserowDouble({ storePath });
  const cli = (args, extra = {}) => runCli({ cliPath: R8_CLI, root: W_ROOT, args: [...args, '--out', extra.out ?? out], env: { ML_TRANSPORT: 'baserow-double', ...(extra.env ?? {}) } });
  try { return await fn({ d, storePath, out, cli }); } finally { await d.close(); }
}
const storeHashOf = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : 'ABSENT');
const receiptOf = (out, rel) => JSON.parse(fs.readFileSync(path.join(out, rel), 'utf8'));

test('R8-STEP2: a read-only query on an empty target refuses instead of creating schema', async () => {
  await withR8Target('empty', async ({ d, storePath, out, cli }) => {
    const before = storeHashOf(storePath);
    const r = await cli(['query', ...r8Base(d)]);
    assert.equal(r.code, 11, `空目标查询必须如实拒绝（exit 11），实际 ${r.code}: ${r.stderr}`);
    const receipt = receiptOf(out, 'query/query-receipt.json');
    assert.equal(receipt.ok, false);
    assert.equal(receipt.read_only, true);
    assert.equal(receipt.writes_performed, 0);
    assert.match(String(receipt.error), /target_schema_missing/, JSON.stringify(receipt.error));
    assert.equal(storeHashOf(storePath), before, '只读查询不得改动目标存储');
    assert.equal(fs.existsSync(storePath) ? readStore(storePath).tables.length : 0, 0, '只读查询不得创建任何表（存储文件都未被写入）');
  });
});

test('R8-STEP2: query on a populated target writes nothing and adds no default note', async () => {
  await withR8Target('readonly', async ({ d, storePath, out, cli }) => {
    const imp = await cli(['import', ...r8Base(d), '--limit', '3']);
    assert.equal(imp.code, 0, imp.stderr);
    const before = storeHashOf(storePath);
    const notesBefore = readStore(storePath).rows[readStore(storePath).tables.find((t) => t.name === 'Videos').id].map((r) => r.review_notes ?? null);
    const r = await cli(['query', ...r8Base(d)]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const receipt = receiptOf(out, 'query/query-receipt.json');
    assert.equal(receipt.read_only, true);
    assert.equal(receipt.mutated, false);
    assert.equal(receipt.writes_performed, 0);
    assert.ok(receipt.hit_count >= 1, `应命中既有目标行：${JSON.stringify(receipt)}`);
    assert.equal(storeHashOf(storePath), before, '查询不得改动目标存储');
    const notesAfter = readStore(storePath).rows[readStore(storePath).tables.find((t) => t.name === 'Videos').id].map((r) => r.review_notes ?? null);
    assert.deepEqual(notesAfter, notesBefore, '只读查询不得追加任何默认人工备注');
  });
});

test('R8-STEP2: identity is resolved from the actual hit; wrong/ambiguous/empty selections are refused', async () => {
  await withR8Target('identity', async ({ d, storePath, out, cli }) => {
    assert.equal((await cli(['import', ...r8Base(d), '--limit', '3'])).code, 0);
    const videos = readStore(storePath).rows[readStore(storePath).tables.find((t) => t.name === 'Videos').id];
    assert.ok(videos.length >= 3, '需要至少 3 行来区分“第一行不匹配、别的行匹配”');
    const firstKey = videos[0].entity_key;
    const thirdKey = videos[2].entity_key;
    const CAT = 'R8测试类别-只读身份';
    const REF = 'cards/r8.json#timeline[0].observed';

    // 先对**第 3 行**做一次显式编辑（身份由 --entity-key 给出，且必须在查询命中里）
    const edit3 = await cli(['edit', ...r8Base(d), '--entity-key', thirdKey, '--note', 'R8 身份用例', '--reviewer', 'r8-op', '--product-category', CAT, '--classification-state', 'proposed', '--classification-evidence', REF]);
    assert.equal(edit3.code, 0, edit3.stdout + edit3.stderr);
    const e3 = receiptOf(out, 'edit/edit-receipt.json');
    assert.equal(e3.ok, true, JSON.stringify(e3.verification_failed));
    assert.equal(e3.selected_entity_key, thirdKey);
    assert.equal(e3.verification.product_category_evidence_ref, true, '证据引用必须原样落地');
    assert.equal(e3.verification.product_category_state, true, '状态必须原样落地（不得被代填 reviewed）');
    assert.equal(e3.verification.reviewer_matches, true, '操作者必须原样落地');
    assert.equal(e3.target_row_after.product_category_state, 'proposed');

    // 第一行不匹配、第三行匹配 → 用 --query-product-category 限定命中（内容标志与之分离）
    const q = await cli(['query', ...r8Base(d), '--product-category', CAT]);
    assert.equal(q.code, 0);
    const qr = receiptOf(out, 'query/query-receipt.json');
    assert.equal(qr.hit_count, 1, JSON.stringify(qr.hits));
    assert.equal(qr.hits[0].entity_key, thirdKey);
    assert.notEqual(qr.hits[0].entity_key, firstKey);
    // edit 的**查询维度**用 --query-*，内容仍用 --product-category（二者不得混用）
    const editFiltered = await cli(['edit', ...r8Base(d), '--query-product-category', CAT, '--entity-key', thirdKey, '--note', 'R8 过滤身份用例', '--reviewer', 'r8-op']);
    assert.equal(editFiltered.code, 0, editFiltered.stdout + editFiltered.stderr);
    assert.equal(receiptOf(out, 'edit/edit-receipt.json').selected_entity_key, thirdKey);

    // 显式给出**不在命中里**的身份 → 拒绝且零写入
    const beforeWrong = storeHashOf(storePath);
    const wrong = await cli(['edit', ...r8Base(d), '--query-product-category', CAT, '--entity-key', firstKey, '--note', '不应写入', '--reviewer', 'r8-op']);
    assert.equal(wrong.code, 12, wrong.stdout);
    const wr = receiptOf(out, 'edit/edit-receipt.json');
    assert.equal(wr.ok, false);
    assert.equal(wr.writes_performed, 0);
    assert.ok(wr.problems.some((p) => String(p).startsWith('selected_not_in_query_hits')), JSON.stringify(wr.problems));
    assert.equal(storeHashOf(storePath), beforeWrong, '错误身份不得产生任何写入');

    // 零命中 → 拒绝且零写入
    const beforeZero = storeHashOf(storePath);
    const zero = await cli(['edit', ...r8Base(d), '--query-product-category', '分类-不存在于目标', '--entity-key', thirdKey, '--note', '不应写入', '--reviewer', 'r8-op']);
    assert.equal(zero.code, 12);
    assert.equal(receiptOf(out, 'edit/edit-receipt.json').writes_performed, 0);
    assert.equal(storeHashOf(storePath), beforeZero, '零命中不得产生任何写入');

    // 目标里出现重复主键（歧义）→ 拒绝，且两行都不许被改动（注入到**替身内存状态**，不是改文件）
    d.mutateState((s) => {
      const tid = s.tables.find((t) => t.name === 'Videos').id;
      s.rows[tid].push({ ...s.rows[tid][2], id: 99999, order: '99999', review_notes: '重复行（未被改动）' });
    });
    const beforeDup = storeHashOf(storePath);
    const dupEdit = await cli(['edit', ...r8Base(d), '--entity-key', thirdKey, '--note', '不应写入', '--reviewer', 'r8-op']);
    assert.equal(dupEdit.code, 12, dupEdit.stdout);
    const dr = receiptOf(out, 'edit/edit-receipt.json');
    assert.equal(dr.ok, false);
    assert.ok(dr.problems.some((p) => String(p).includes('ambiguous')), JSON.stringify(dr.problems));
    assert.equal(storeHashOf(storePath), beforeDup, '歧义身份不得改动任何一行');
    const dupTableId = readStore(storePath).tables.find((t) => t.name === 'Videos').id;
    const dupAfter = readStore(storePath).rows[dupTableId].filter((r) => r.entity_key === thirdKey);
    assert.equal(dupAfter.length, 2);
    assert.equal(dupAfter[0].review_notes === '不应写入', false);
    assert.equal(dupAfter[1].review_notes, '重复行（未被改动）');
  });
});

test('R8-STEP2: an explicit edit survives encoding, edit and an ordinary source reimport', async () => {
  await withR8Target('survive', async ({ d, storePath, out, cli }) => {
    assert.equal((await cli(['import', ...r8Base(d), '--limit', '2'])).code, 0);
    const tableId = readStore(storePath).tables.find((t) => t.name === 'Videos').id;
    const key = readStore(storePath).rows[tableId][1].entity_key;
    const CAT = 'R8测试类别-存活';
    const REF = 'cards/r8-survive.json#timeline[2].observed';
    const e = await cli(['edit', ...r8Base(d), '--entity-key', key, '--note', 'R8 存活用例', '--reviewer', 'r8-survive-op', '--product-category', CAT, '--classification-state', 'proposed', '--classification-evidence', REF]);
    assert.equal(e.code, 0, e.stdout + e.stderr);
    assert.equal(receiptOf(out, 'edit/edit-receipt.json').ok, true);
    // 普通来源复导入（同一输入）
    assert.equal((await cli(['import', ...r8Base(d), '--limit', '2'])).code, 0);
    const replay = receiptOf(out, 'import/http-receipt.json');
    assert.equal(replay.import.tables.Videos.inserted, 0, '复导入不得新增');
    // 复导入后编辑仍在（值/状态/证据/操作者）
    const row = readStore(storePath).rows[tableId].find((r) => r.entity_key === key);
    assert.equal(row.product_category, CAT);
    assert.equal(row.product_category_state.value, 'proposed');
    assert.equal(row.product_category_evidence_ref, REF);
    assert.equal(row.product_category_reviewer, 'r8-survive-op');
    assert.match(String(row.review_notes), /R8 存活用例/);
  });
});

test('R8-STEP3: export is read-only and restore consumes the changed disk bytes (positive + 4 negatives)', async () => {
  await withR8Target('export', async ({ d, storePath, out, cli }) => {
    assert.equal((await cli(['import', ...r8Base(d), '--limit', '5'])).code, 0);
    const store0 = readStore(storePath);
    const tableId = store0.tables.find((t) => t.name === 'Videos').id;
    const segTableId = store0.tables.find((t) => t.name === 'Segments').id;
    const keysWithSegments = new Set(store0.rows[segTableId].map((s) => s.entity_key));
    // 选中一个**确实带片段**的身份，否则“改动片段链接”的负例根本碰不到被核对的数据
    const key = (store0.rows[tableId].find((r) => keysWithSegments.has(r.entity_key)) ?? store0.rows[tableId][0]).entity_key;
    const CAT = 'R8测试类别-导出';
    assert.equal((await cli(['edit', ...r8Base(d), '--entity-key', key, '--note', 'R8 导出用例', '--reviewer', 'r8-exp-op', '--product-category', CAT, '--classification-state', 'proposed', '--classification-evidence', 'cards/r8-exp.json#t0'])).code, 0);

    const beforeExport = storeHashOf(storePath);
    const ex = await cli(['export', ...r8Base(d), '--entity-key', key]);
    assert.equal(ex.code, 0, ex.stdout + ex.stderr);
    const exr = receiptOf(out, 'portable/export-receipt.json');
    assert.equal(exr.read_only, true);
    assert.equal(exr.mutated, false);
    assert.equal(exr.writes_performed, 0);
    assert.equal(exr.selected_entity_key, key);
    assert.equal(storeHashOf(storePath), beforeExport, '导出不得改动目标存储');

    const bundlePath = exr.bundle_path;
    const originalBundle = fs.readFileSync(bundlePath);
    const originalSha = crypto.createHash('sha256').update(originalBundle).digest('hex');
    assert.equal(exr.bundle_sha256, originalSha);

    // 正例：从磁盘字节恢复并逐项核对
    const restoreDir = path.join(out, 'restore-ok');
    const ok = await cli(['restore', '--bundle', bundlePath, '--restore-into', restoreDir]);
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    const okr = receiptOf(out, 'restore/restore-receipt.json');
    assert.equal(okr.ok, true, JSON.stringify(okr.findings));
    assert.equal(okr.bundle_sha256, originalSha, '恢复必须消费被声明的那份磁盘字节');
    assert.equal(okr.selected_row_compare.mismatches, 0, '选中行的人工/分类值·状态·来源必须逐项一致');

    // 负例：改动磁盘字节后恢复必须显式失败（且证明消费的是改动后的字节）
    const mutate = (name, fn) => {
      const p = path.join(out, `bundle-${name}.json`);
      const b = JSON.parse(originalBundle.toString('utf8'));
      fn(b);
      fs.writeFileSync(p, JSON.stringify(b, null, 1), 'utf8');
      return p;
    };
    const truncated = path.join(out, 'bundle-truncated.json');
    fs.writeFileSync(truncated, originalBundle.subarray(0, originalBundle.length - 80));   // 按**字节**截断
    const cases = [
      ['truncated', truncated, 'bundle_unparseable'],
      ['missing_row', mutate('missing_row', (b) => { b.data.Videos = b.data.Videos.filter((r) => r.entity_key !== key); }), 'selected_row_missing_after_restore'],
      ['changed_value', mutate('changed_value', (b) => { const r = b.data.Videos.find((x) => x.entity_key === key); r.product_category = '被改过的值'; }), 'selected_row_field_mismatch'],
      ['altered_link', mutate('altered_link', (b) => { const s = (b.data.Segments ?? []).find((x) => x.entity_key === key); if (s) s.view_url = 'http://127.0.0.1:9/viewer?asset=changed&t=0'; }), 'segment_view_url_mismatch'],
    ];
    for (const [name, p, expectedId] of cases) {
      const mutatedSha = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
      assert.notEqual(mutatedSha, originalSha, `${name}: 负例必须用**改动后**的字节`);
      const r = await cli(['restore', '--bundle', p, '--restore-into', path.join(out, `restore-${name}`)]);
      assert.equal(r.code, 15, `${name}: 恢复应显式失败，实际 ${r.code}`);
      const rr = receiptOf(out, 'restore/restore-receipt.json');
      assert.equal(rr.ok, false, `${name}: 不得报成功`);
      assert.equal(rr.bundle_sha256, mutatedSha, `${name}: 必须报告消费的改动后哈希`);
      assert.ok(rr.findings.some((f) => f.id === expectedId) || (name === 'altered_link' && rr.findings.some((f) => f.level === 'fail')),
        `${name}: 期望发现 ${expectedId}，实际 ${JSON.stringify(rr.findings.map((f) => f.id))}`);
    }
  });
});

test('R8-STEP4: the delivered CLI runs the whole sequence on ONE persistent isolated target', async () => {
  const storePath = path.join(mkFixtureDir('ml-r8-seq-'), 'sequence-store.json');
  const outRoot = path.join(path.dirname(storePath), 'out');
  const res = await runDeliveredSequence({
    root: W_ROOT, cliPath: R8_CLI, storePath, outRoot, manifestPath: R8_MANIFEST,
    entityKey: 'TikTok|main|7679078728667778337', classification: '手机壳（豹纹压纹背板）',
    evidenceRef: 'outputs/material-analysis-20-20260920/cards/tiktok-7679078728667778337.json#timeline[0].observed',
    restoreInto: path.join(outRoot, 'restore-dir'),
  });
  assert.equal(res.ok, true, JSON.stringify({ assertions: res.assertions, steps: res.steps.map((s) => [s.name, s.code, s.stderr.slice(0, 200)]) }));
  assert.equal(res.assertions.all_steps_exit_zero, true);
  assert.equal(res.assertions.query_store_unchanged, true, '两次只读查询都不得改动目标存储');
  assert.equal(res.assertions.replay_zero_inserts, true, '普通复导入零新增');
  assert.equal(res.assertions.export_read_only, true);
  assert.equal(res.assertions.restore_ok, true);
  // 同一 store 文件确实被 8 次 CLI 调用共享
  const store = readStore(storePath);
  assert.equal(store.rows[store.tables.find((t) => t.name === 'Videos').id].length, 25);
});

// ─────────────── R9：单一写路径 / 诚实写入回执 / 完整快照契约 / 失败即停 ───────────────

test('R9-STEP2: journey is read-only and refuses its legacy --edit before any write', async () => {
  await withR8Target('r9-journey', async ({ d, storePath, out, cli }) => {
    assert.equal((await cli(['import', ...r8Base(d), '--limit', '3'])).code, 0);
    const tableId = readStore(storePath).tables.find((t) => t.name === 'Videos').id;
    const key = readStore(storePath).rows[tableId][0].entity_key;
    const before = storeHashOf(storePath);

    // 普通 journey：只读，零写入
    const ro = await cli(['journey', ...r8Base(d), '--entity-key', key]);
    assert.equal(ro.code, 0, ro.stdout + ro.stderr);
    const rt = receiptOf(out, 'journey/journey-transcript.json');
    assert.equal(rt.read_only, true);
    assert.equal(rt.writes_performed, 0);
    assert.equal(rt.writes_attempted, 0);
    assert.equal(rt.edit_receipt, null);
    assert.equal(storeHashOf(storePath), before, '只读旅程不得改动目标');

    // 旧 `--edit`：必须在任何写入之前显式拒绝，并指向独立 edit 命令
    const legacy = await cli(['journey', ...r8Base(d), '--edit', '--entity-key', key, '--note', 'x', '--reviewer', 'op', '--manual-reviewer', 'op']);
    assert.equal(legacy.code, 16, `legacy --edit 必须被显式拒绝（exit 16），实际 ${legacy.code}: ${legacy.stdout}`);
    const lr = receiptOf(out, 'journey/journey-transcript.json');
    assert.equal(lr.ok, false);
    assert.equal(lr.error, 'journey_edit_removed');
    assert.equal(lr.writes_attempted, 0);
    assert.equal(lr.writes_performed, 0);
    assert.match(JSON.stringify(lr.problems), /journey_no_longer_writes/);
    assert.equal(storeHashOf(storePath), before, '拒绝路径不得产生任何写入');
  });
});

test('R9-STEP2: a note or a proposed classification never claims "reviewed"', async () => {
  await withR8Target('r9-review', async ({ d, storePath, out, cli }) => {
    assert.equal((await cli(['import', ...r8Base(d), '--limit', '2'])).code, 0);
    const tableId = readStore(storePath).tables.find((t) => t.name === 'Videos').id;
    const key = readStore(storePath).rows[tableId][0].entity_key;
    const CAT = 'R9类别-不冒充复核';

    // ① 只加备注 + proposed 分类、**不**请求复核状态 → 目标行复核状态保持原值（unreviewed）
    const e1 = await cli(['edit', ...r8Base(d), '--entity-key', key, '--note', 'R9 备注（不请求复核）', '--reviewer', 'r9-fixture-operator',
      '--product-category', CAT, '--classification-state', 'proposed', '--classification-evidence', 'cards/r9.json#t0']);
    assert.equal(e1.code, 0, e1.stdout + e1.stderr);
    const r1 = receiptOf(out, 'edit/edit-receipt.json');
    assert.equal(r1.target_row_before.review_status, 'unreviewed');
    assert.equal(r1.target_row_after.review_status, 'unreviewed', '不得把“加备注/提案”当成已复核');
    assert.equal(r1.target_row_after.product_category_state, 'proposed', '只写显式请求的分类状态');
    assert.equal(r1.verification.review_status_expected, true);

    // ② 显式请求 reviewed → 必须落地
    const e2 = await cli(['edit', ...r8Base(d), '--entity-key', key, '--note', 'R9 显式复核', '--reviewer', 'r9-fixture-operator', '--review-status', 'reviewed']);
    assert.equal(e2.code, 0, e2.stdout + e2.stderr);
    const r2 = receiptOf(out, 'edit/edit-receipt.json');
    assert.equal(r2.target_row_after.review_status, 'reviewed');
    assert.equal(r2.intended.review_status, 'reviewed');
    // ③ 非法状态 → 拒绝且零写入
    const beforeBad = storeHashOf(storePath);
    const e3 = await cli(['edit', ...r8Base(d), '--entity-key', key, '--note', 'x', '--reviewer', 'op', '--review-status', 'approved']);
    assert.equal(e3.code, 12);
    assert.equal(receiptOf(out, 'edit/edit-receipt.json').writes_attempted, 0);
    assert.equal(storeHashOf(storePath), beforeBad);
  });
});

test('R9-STEP2: mutation receipts separate attempted / accepted / confirmed / refused / unknown', async () => {
  await withR8Target('r9-mutation', async ({ d, storePath, out, cli }) => {
    assert.equal((await cli(['import', ...r8Base(d), '--limit', '2'])).code, 0);
    const tableId = readStore(storePath).tables.find((t) => t.name === 'Videos').id;
    const key = readStore(storePath).rows[tableId][0].entity_key;

    // ① 被拒绝：不得因为“传了意图”就算一次写入
    const refused = await cli(['edit', ...r8Base(d), '--entity-key', 'TikTok|main|不存在', '--note', 'x', '--reviewer', 'op']);
    assert.equal(refused.code, 12);
    const rr = receiptOf(out, 'edit/edit-receipt.json');
    assert.equal(rr.writes_attempted, 0);
    assert.equal(rr.writes_performed, 0);
    assert.equal(rr.mutation.state, 'refused');
    assert.equal(rr.mutated, false);

    // ② 写入被接受但**读回失败**：必须如实记 uncertain，且不得声称零写入
    const beforeWrite = storeHashOf(storePath);
    d.failRowReadsAfter(4);   // 前 4 次行读取（查询/身份/编辑前快照）放行；写入后的复读（第 5 次）失败
    const unverified = await cli(['edit', ...r8Base(d), '--entity-key', key, '--note', 'R9 写入后读回失败', '--reviewer', 'r9-fixture-operator']);
    assert.equal(unverified.code, 13, unverified.stdout + unverified.stderr);
    const ur = receiptOf(out, 'edit/edit-receipt.json');
    assert.equal(ur.mutation.attempted, true);
    assert.equal(ur.mutation.write_accepted, true, '写入请求被接受');
    assert.equal(ur.mutation.readback_ok, false, '读回失败');
    assert.equal(ur.mutation.confirmed, false);
    assert.equal(ur.uncertain_outcome, true);
    assert.equal(ur.writes_performed, 1, '被接受的写入不得被记成 0');
    assert.equal(ur.ok, false, '未确认不得报成功');
    assert.notEqual(storeHashOf(storePath), beforeWrite, '该写入确实落到了目标存储（因此不能声称零写入）');
    assert.equal(readStore(storePath).rows[tableId].find((r) => r.entity_key === key).review_notes, 'R9 写入后读回失败');
  });
});

test('R9-STEP3: export rejects conflicting row-id/entity-key and keeps all three classification bases', async () => {
  await withR8Target('r9-export', async ({ d, storePath, out, cli }) => {
    assert.equal((await cli(['import', ...r8Base(d), '--limit', '4'])).code, 0);
    const store = readStore(storePath);
    const tableId = store.tables.find((t) => t.name === 'Videos').id;
    const rows = store.rows[tableId];
    const keyA = rows[0].entity_key, keyB = rows[1].entity_key;
    const REF = 'cards/r9-export.json#t0';
    // 三个分类基准各写一次（值/状态/证据/操作者都要能序列化出来）
    const e = await cli(['edit', ...r8Base(d), '--entity-key', keyB, '--note', 'R9 快照用例', '--reviewer', 'r9-fixture-operator',
      '--product-category', 'R9类别', '--product-function', 'R9功能', '--scene-or-need', 'R9场景',
      '--classification-state', 'proposed', '--classification-evidence', REF]);
    assert.equal(e.code, 0, e.stdout + e.stderr);
    const er = receiptOf(out, 'edit/edit-receipt.json');
    for (const base of ['product_category', 'product_function', 'scene_or_need']) {
      assert.equal(er.target_row_after[base], `R9${base === 'product_category' ? '类别' : base === 'product_function' ? '功能' : '场景'}`);
      assert.equal(er.target_row_after[`${base}_state`], 'proposed', `${base}_state 必须序列化`);
      assert.equal(er.target_row_after[`${base}_origin`], 'human_review', `${base}_origin 必须序列化`);
      assert.equal(er.target_row_after[`${base}_reviewer`], 'r9-fixture-operator', `${base}_reviewer 必须序列化`);
      assert.equal(er.target_row_after[`${base}_evidence_ref`], REF, `${base}_evidence_ref 必须序列化`);
    }

    // 冲突选择：row-id 指向 A、entity-key 指向 B → 拒绝，且不得声称导出成功
    const beforeExport = storeHashOf(storePath);
    const conflict = await cli(['export', ...r8Base(d), '--row-id', String(rows[0].id), '--entity-key', keyB]);
    assert.equal(conflict.code, 14, conflict.stdout + conflict.stderr);
    const cr = receiptOf(out, 'portable/export-receipt.json');
    assert.equal(cr.ok, false);
    assert.equal(cr.selected_row_id, null);
    assert.equal(cr.selection.both_supplied, true);
    assert.equal(cr.selection.consistent, false);
    assert.ok(cr.problems.some((p) => String(p).startsWith('conflicting_selection')), JSON.stringify(cr.problems));
    assert.equal(storeHashOf(storePath), beforeExport, '拒绝的导出不得改动目标');

    // 一致选择：两者指向同一行 → 通过且 selection.consistent=true
    const consistent = await cli(['export', ...r8Base(d), '--row-id', String(rows[1].id), '--entity-key', keyB]);
    assert.equal(consistent.code, 0, consistent.stdout + consistent.stderr);
    const okr = receiptOf(out, 'portable/export-receipt.json');
    assert.equal(okr.selection.consistent, true);
    assert.equal(okr.selected_entity_key, keyB);
    assert.equal(okr.selected_row_id, rows[1].id);
    // 快照里的选中行必须带全三个分类基准
    const bundle = JSON.parse(fs.readFileSync(okr.bundle_path, 'utf8'));
    for (const base of ['product_category', 'product_function', 'scene_or_need']) {
      assert.equal(bundle.snapshot.selected_row[base], `R9${base === 'product_category' ? '类别' : base === 'product_function' ? '功能' : '场景'}`);
      assert.equal(bundle.snapshot.selected_row[`${base}_evidence_ref`], REF);
    }
  });
});

test('R9-STEP3: restore fails on wrong link identity, counts mismatch and missing provenance', async () => {
  await withR8Target('r9-restore-neg', async ({ d, storePath, out, cli }) => {
    assert.equal((await cli(['import', ...r8Base(d), '--limit', '6'])).code, 0);
    const store = readStore(storePath);
    const tableId = store.tables.find((t) => t.name === 'Videos').id;
    const segTableId = store.tables.find((t) => t.name === 'Segments').id;
    const segKeys = new Set(store.rows[segTableId].map((s) => s.entity_key));
    const key = (store.rows[tableId].find((r) => segKeys.has(r.entity_key)) ?? store.rows[tableId][0]).entity_key;
    const REF = 'cards/r9-restore.json#t0';
    assert.equal((await cli(['edit', ...r8Base(d), '--entity-key', key, '--note', 'R9 恢复负例', '--reviewer', 'r9-fixture-operator',
      '--product-category', 'R9类别', '--product-function', 'R9功能', '--scene-or-need', 'R9场景',
      '--classification-state', 'proposed', '--classification-evidence', REF])).code, 0);
    assert.equal((await cli(['export', ...r8Base(d), '--entity-key', key])).code, 0);
    const okr = receiptOf(out, 'portable/export-receipt.json');
    const original = fs.readFileSync(okr.bundle_path);
    const originalSha = crypto.createHash('sha256').update(original).digest('hex');
    // 正例仍通过（且不误报）
    assert.equal((await cli(['restore', '--bundle', okr.bundle_path, '--restore-into', path.join(out, 'r9-restore-ok')])).code, 0);
    assert.equal(receiptOf(out, 'restore/restore-receipt.json').ok, true);

    const writeMutant = (name, fn) => {
      const p = path.join(out, `r9-bundle-${name}.json`);
      const b = JSON.parse(original.toString('utf8'));
      fn(b);
      fs.writeFileSync(p, JSON.stringify(b, null, 1), 'utf8');
      return p;
    };
    const otherVideoRel = store.rows[tableId].find((r) => r.entity_key !== key);
    const cases = [
      ['missing_provenance', writeMutant('missing_provenance', (b) => {
        const r = b.data.Videos.find((x) => x.entity_key === key);
        r.product_function_origin = null; r.product_function_evidence_ref = null;
      }), 'selected_row_field_mismatch'],
      ['wrong_link_identity', writeMutant('wrong_link_identity', (b) => {
        // 把选中身份某片段的 video_link 指向**另一个真实存在**的视频行 ID
        const other = b.data.Videos.find((x) => x.entity_key !== key);
        const s = b.data.Segments.find((x) => x.entity_key === key);
        if (s && other) s.video_link = [other.id];
      }), 'relation_target_identity_mismatch'],
      ['counts_mismatch', writeMutant('counts_mismatch', (b) => {
        b.data['Metric observations'] = b.data['Metric observations'].slice(0, 1);   // 键集合与计数同时变
      }), 'table_key_set_mismatch'],
      ['missing_function_value', writeMutant('missing_function_value', (b) => {
        const r = b.data.Videos.find((x) => x.entity_key === key);
        r.product_function = null;
      }), 'selected_row_field_mismatch'],
    ];
    for (const [name, p, expectedId] of cases) {
      const mutatedSha = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
      assert.notEqual(mutatedSha, originalSha, `${name}: 负例必须用改动后的磁盘字节`);
      const r = await cli(['restore', '--bundle', p, '--restore-into', path.join(out, `r9-restore-${name}`)]);
      assert.equal(r.code, 15, `${name}: 应显式失败，实际 ${r.code}`);
      const rr = receiptOf(out, 'restore/restore-receipt.json');
      assert.equal(rr.ok, false, `${name}: 不得报成功`);
      assert.equal(rr.bundle_sha256, mutatedSha, `${name}: 必须报告改动后的哈希`);
      assert.ok(rr.findings.some((f) => f.id === expectedId), `${name}: 期望 ${expectedId}，实际 ${JSON.stringify(rr.findings.map((f) => f.id))}`);
    }
  });
});

test('R9-STEP4: a failed early step blocks dependent CLI steps (fail-stop) and the journey mismatch cannot write', async () => {
  // ① 失败即停：首步导入用**不存在的 manifest** → 后续步骤不得继续执行
  const storePath = path.join(mkFixtureDir('ml-r9-failstop-'), 'store.json');
  const outRoot = path.join(path.dirname(storePath), 'out');
  const res = await runDeliveredSequence({
    root: W_ROOT, cliPath: R8_CLI, storePath, outRoot,
    manifestPath: path.join(outRoot, 'does-not-exist-manifest.json'),
    entityKey: 'TikTok|main|7679078728667778337', classification: 'R9类别', evidenceRef: 'cards/x.json#t0',
  });
  assert.equal(res.ok, false);
  assert.equal(res.assertions.all_steps_exit_zero, false);
  assert.equal(res.assertions.no_blocked_steps, false, '失败的步骤必须阻断后续步骤');
  assert.ok(res.blocked.length >= 5, `后续步骤应被标记阻断：${JSON.stringify(res.blocked)}`);
  assert.equal(fs.existsSync(path.join(outRoot, 'edit', 'edit-receipt.json')), false, '前置失败后不得产生编辑回执');
  assert.equal(fs.existsSync(path.join(outRoot, 'portable', 'export-receipt.json')), false, '前置失败后不得导出');

  // ② 原错配形状：journey 的查询**没有命中**时，也不得经由任何写路径改动目标
  await withR8Target('r9-mismatch', async ({ d, storePath: sp, out, cli }) => {
    assert.equal((await cli(['import', ...r8Base(d), '--limit', '2'])).code, 0);
    const before = storeHashOf(sp);
    const j = await cli(['journey', ...r8Base(d), '--product-category', '不可能命中的类别-R9']);
    const jr = receiptOf(out, 'journey/journey-transcript.json');
    assert.equal(jr.writes_performed, 0);
    assert.equal(jr.writes_attempted, 0);
    assert.equal(jr.hit_count, 0, '未命中必须诚实为 0');
    assert.equal(storeHashOf(sp), before, '未命中的只读旅程不得改动目标');
    // 独立 edit 的查询维度（--query-*）与写入内容分离：内容标志不会被当成查询条件
    const tableId = readStore(sp).tables.find((t) => t.name === 'Videos').id;
    const key = readStore(sp).rows[tableId][0].entity_key;
    const e = await cli(['edit', ...r8Base(d), '--entity-key', key, '--note', 'R9 内容≠查询', '--reviewer', 'r9-fixture-operator',
      '--product-category', '全新类别-R9', '--classification-evidence', 'cards/r9-content.json#t0']);
    assert.equal(e.code, 0, e.stdout + e.stderr);
    assert.equal(receiptOf(out, 'edit/edit-receipt.json').selected_entity_key, key);
  });
});

// ---------------------------------------------------------------- R11：真实 Baserow 2.4 适配的聚焦回归
// 每条都对应本轮真实实例上**实测到的**一次 400/误判，不是凭空补的断言。
test('R11-A: 行写入的 single_select 发选项值，不发选项 ID（2.4 实测：发 ID 被 400 拒绝）', () => {
  const meta = {
    review_status: { select_options: [{ id: 3919, value: 'unreviewed' }] },
    entity_source_state: { select_options: [{ id: 3916, value: 'observed' }] },
  };
  const payload = encodeWritePayload(TABLE_VIDEOS, {
    entity_key: 'P|main|1', review_status: 'unreviewed', entity_source_state: 'observed',
  }, meta);
  assert.equal(payload.review_status, 'unreviewed', '必须发选项值');
  assert.equal(payload.entity_source_state, 'observed', '必须发选项值');
  assert.equal(JSON.stringify(payload).includes('3919'), false, '不得把选项 ID 当作行写入值');
});

test('R11-B: 浮点噪声收敛到 6 位小数；url 字段只放绝对地址并原样保留来源文本', () => {
  const rec = {
    entity_key: 'P|main|1', platform: 'P', namespace: 'main', native_id: '1', branch: 'main', aid_branch: false,
    evidence_fingerprint: 'fp',
    identity: { canonical_url: 'https://e.com/a', derived_permalink: 'DddloSbTQoI', duration_seconds: 0.6110000000000001, author_follower_count: 3 },
    classification: {}, availability: { entity_source_state: 'observed', fields_observed: 1 },
    provenance: {}, metrics: [], ratios: [], assets: [],
    review: { status: 'unreviewed', notes: [], human_value_categories: [] },
  };
  const rows = rowsOf([rec]);
  assert.equal(rows[TABLE_VIDEOS][0].duration_seconds, 0.611, '浮点噪声必须收敛');
  assert.equal(rows[TABLE_VIDEOS][0].canonical_url, 'https://e.com/a', '绝对地址保留在 url 字段');
  assert.equal(rows[TABLE_VIDEOS][0].derived_permalink, null, '裸 ID 不得塞进 url 字段');
  assert.equal(rows[TABLE_VIDEOS][0].derived_permalink_recorded, 'DddloSbTQoI', '来源原样值必须保留');
});

test('R11-C: number 字段读回字符串与写入意图按数值语义比较；文本仍按字面比较', () => {
  assert.equal(logicalEqual(7.334, '7.334000'), true, '读回 "7.334000" 与意图 7.334 视为相同');
  assert.equal(logicalEqual(0.611, '0.611'), true);
  assert.equal(logicalEqual(7.334, '7.335'), false, '不同数值仍判为不同');
  assert.equal(logicalEqual('abc', 'abc'), true);
  assert.equal(logicalEqual('7.334', '7.334000'), false, '两个字符串仍按字面比较（不变更既有语义）');
  assert.equal(logicalEqual('7.334abc', 7.334), false, '含非数字字符的字符串不得按数值比较');
});

test('R11-D: 空主键占位行不参与重复判定但如实登记；真实重复仍被拦下', () => {
  const receipt = { target_duplicates: [], errors: [] };
  const dups = detectDuplicateTargetKeys({
    table: TABLE_VIDEOS, source: 'pre_write_readback', receipt,
    rows: [{ id: 1, entity_key: '' }, { id: 2, entity_key: '' }, { id: 3, entity_key: 'a' }, { id: 4, entity_key: 'b' }],
  });
  assert.equal(dups.length, 0, '空主键占位行不得触发重复告警');
  assert.equal(receipt.empty_primary_key_rows.length, 1);
  assert.equal(receipt.empty_primary_key_rows[0].row_count, 2);
  assert.deepEqual(receipt.empty_primary_key_rows[0].row_ids, [1, 2], '必须如实登记行 ID');

  const receipt2 = { target_duplicates: [], errors: [] };
  const dup2 = detectDuplicateTargetKeys({
    table: TABLE_VIDEOS, source: 'pre_write_readback', receipt: receipt2,
    rows: [{ id: 9, entity_key: 'x' }, { id: 10, entity_key: 'x' }, { id: 11, entity_key: '' }],
  });
  assert.equal(dup2.length, 1, '真实重复仍必须拦下');
  assert.equal(receipt2.errors[0].error_code, 'duplicate_target_primary_key');
});

test('R11-E: 既有字段选项不足时按真实 API 补齐（number_decimal_places / date_include_time）', async () => {
  const plan = planSchema().tables.find((t) => t.name === TABLE_VIDEOS);
  const existing = plan.fields.map((f, i) => ({
    id: i + 1, name: f.name, type: f.type, primary: f.primary === true,
    number_decimal_places: f.type === 'number' ? 0 : undefined,
    date_include_time: f.type === 'date' ? false : undefined,
  }));
  const updates = [];
  const client = {
    listTablesInDatabase: async () => [{ id: 700, name: TABLE_VIDEOS, database_id: 1 }],
    listFields: async () => existing,
    updateField: async (id, patch) => { updates.push({ id, patch }); return { ...patch, id }; },
    createField: async () => { throw new Error('r11_e_must_not_create_field'); },
    createTable: async () => { throw new Error('r11_e_must_not_create_table'); },
    listViews: async () => [],
    createView: async () => { throw new Error('r11_e_must_not_create_view'); },
    listViewFilters: async () => [],
    listViewSortings: async () => [],
  };
  const res = await ensureSchemaAndViews(client, { schema: { tables: [plan] }, views: [], databaseId: 1 });
  assert.equal(res.ok, true);
  const repaired = res.log.fields_repaired.map((r) => `${r.name}:${JSON.stringify(r.patch)}`);
  assert.ok(repaired.includes('duration_seconds:{"number_decimal_places":6}'), `应补齐小数位：${JSON.stringify(repaired)}`);
  assert.ok(repaired.includes('review_reviewed_at:{"date_include_time":true}'), `应补齐含时间：${JSON.stringify(repaired)}`);
  assert.equal(updates.length, repaired.length);
  assert.equal(repaired.some((x) => x.startsWith('publish_date_epoch_s')), false, '整数时间戳不得被无谓改写');
});

test('R11-F: CLI 凭据文件输入生效，且令牌值不进入 argv 回显/输出', async () => {
  const tmp = mkFixtureDir('ml-r11-creds-');
  const credsPath = path.join(tmp, 'creds.json');
  const DB_TOKEN = 'r11-db-token-must-not-appear';
  const MGMT = 'r11-jwt-must-not-appear';
  fs.writeFileSync(credsPath, JSON.stringify({ base_url: 'http://127.0.0.1:9', database_id: 1, db_token: DB_TOKEN, jwt: MGMT }));
  const res = await runCli({
    cliPath: R8_CLI, root: W_ROOT,
    args: ['query', '--target', 'http', '--creds-file', credsPath, '--out', path.join(tmp, 'out')],
    env: {}, timeoutMs: 60000,
  });
  const combined = `${res.stdout}\n${res.stderr}`;
  assert.equal(combined.includes(DB_TOKEN), false, '数据库令牌值不得出现在输出中');
  assert.equal(combined.includes(MGMT), false, 'JWT 值不得出现在输出中');
  assert.equal(/target_http_requires_base_url_and_token/.test(combined), false, 'base-url/token 应由凭据文件补齐');
});

// R12 第 8 批复核 R8-3 回归：子行引用的父键是**空字符串**时，旧实现直接跳过该关联字段、
// 把子行无声写成“孤儿”，写后对账又因父键为空跳过关系核对 → 最终 ok=true。
// 修复后必须**阻断该子行并报错**（link_parent_key_empty），不得算作成功。
test('R12-M3-C: 空父键不得静默写成孤儿行（R8-3）', async () => {
  const seg = {
    segment_id: 'TikTok|main|1|0|0', index: 0, t_label: '00:00.000', start_seconds: 0,
    observed: '俯拍静态产品镜头', onscreen_text: null, speech: null,
    kind: 'original_fact', fact_origin: 'source_fact',
    origin_card: 'cards/tiktok-1.json', origin_method: 'per_tile_exact_seek',
    time_accuracy_note: '帧选取层 ≤1 帧间隔', coverage: 'sparse_sampled_tiles_only',
    review_status: 'unreviewed', selected_reference: false, human_note: null,
  };
  // 资产键被置空 → 该资产无法被绑定，其片段引用的 asset_id 也是空字符串
  const rec = normalizeEntity(entity(), [], {
    mediaIndex: new Map([['TikTok|main|7677920051269455125', {
      asset_id: '', platform: 'TikTok', native_id: '7677920051269455125', cohort: 'test',
      local_path: 'D:/abs/a.mp4', media_kind: 'video', usable_as_video: true,
      segments: [seg], segment_count: 1,
    }]]),
  });
  assert.equal(rec.assets.length, 1);
  const backend = createMemoryBackend();
  for (const t of ALL_TABLES) await backend.createTable(t);
  const receipt = await importRecords({ records: [rec], backend, mode: 'test' });

  const segRows = backend.listRows(TABLE_SEGMENTS);
  assert.equal(segRows.length, 0, `空父键的子行不得被写成孤儿：${JSON.stringify(segRows.map((r) => r.asset_link ?? null))}`);
  const codes = (receipt.errors ?? []).map((e) => e.error_code);
  assert.ok(codes.includes('link_parent_key_empty'), `必须给出明确错误码 link_parent_key_empty，实际 ${JSON.stringify(codes)}`);
  assert.equal(receipt.ok, false, '存在空父键阻断时不得报 ok=true');
  // 反例另一侧：源里**本来就没有**该父键（字段不存在）→ 合法，不建立关联、也不报错
  const recNoAssetField = normalizeEntity(entity(), [], {
    mediaIndex: new Map([['TikTok|main|7677920051269455125', {
      platform: 'TikTok', native_id: '7677920051269455125', cohort: 'test',
      local_path: 'D:/abs/a.mp4', media_kind: 'video', usable_as_video: true,
      segments: [seg], segment_count: 1,
    }]]),
  });
  const backend2 = createMemoryBackend();
  for (const t of ALL_TABLES) await backend2.createTable(t);
  const receipt2 = await importRecords({ records: [recNoAssetField], backend: backend2, mode: 'test' });
  assert.equal((receipt2.errors ?? []).some((e) => e.error_code === 'link_parent_key_empty'), false, '字段缺失不等于空值，不得误报');
});


// 旧写法一律用 entity_key，会把同一视频下**其它资产**的片段也算进当前资产的反向集合 → 合法关系被误判。
test('R12-M3-B: 反向关系按父表取键（Assets 用 asset_id），同一视频的多个资产不互相串味', () => {
  assert.equal(parentRelationKeyField(TABLE_VIDEOS), 'entity_key');
  assert.equal(parentRelationKeyField(TABLE_ASSETS), 'asset_id');
  assert.equal(parentRelationKeyField(TABLE_SEGMENTS), null);

  // 同一视频 v1 下两个资产 a1/a2，各有自己的片段；bindings 记录片段行 ID
  const segments = [
    { entity_key: 'v1', asset_id: 'a1' }, { entity_key: 'v1', asset_id: 'a1' },
    { entity_key: 'v1', asset_id: 'a2' },
  ];
  const bindings = { [TABLE_SEGMENTS]: { 'v1|a1|s1': 101, 'v1|a1|s2': 102, 'v1|a2|s3': 201 } };
  const childRows = [
    { entity_key: 'v1', asset_id: 'a1', segment_id: 'v1|a1|s1' },
    { entity_key: 'v1', asset_id: 'a1', segment_id: 'v1|a1|s2' },
    { entity_key: 'v1', asset_id: 'a2', segment_id: 'v1|a2|s3' },
  ];
  const forA1 = reverseRelationExpectedIds({ parentTable: TABLE_ASSETS, parentRow: { asset_id: 'a1' }, childTable: TABLE_SEGMENTS, childRows, bindings, childPrimaryKey: 'segment_id' });
  const forA2 = reverseRelationExpectedIds({ parentTable: TABLE_ASSETS, parentRow: { asset_id: 'a2' }, childTable: TABLE_SEGMENTS, childRows, bindings, childPrimaryKey: 'segment_id' });
  assert.deepEqual(forA1, ['101', '102'], 'a1 只应包含自己的片段（旧写法会把 a2 的 201 也算进来）');
  assert.deepEqual(forA2, ['201']);

  // Videos 侧仍按 entity_key 归集（该视频下所有子行）
  const forV = reverseRelationExpectedIds({ parentTable: TABLE_VIDEOS, parentRow: { entity_key: 'v1' }, childTable: TABLE_SEGMENTS, childRows, bindings, childPrimaryKey: 'segment_id' });
  assert.deepEqual(forV, ['101', '102', '201']);
  // 父键为空 / 父表无键字段 → 不得凭空空转成“通过”
  assert.deepEqual(reverseRelationExpectedIds({ parentTable: TABLE_VIDEOS, parentRow: { entity_key: '' }, childTable: TABLE_SEGMENTS, childRows, bindings, childPrimaryKey: 'segment_id' }), []);
  assert.deepEqual(reverseRelationExpectedIds({ parentTable: TABLE_SEGMENTS, parentRow: { entity_key: 'v1' }, childTable: TABLE_METRICS, childRows, bindings, childPrimaryKey: 'segment_id' }), []);
  assert.equal(segments.length, 3);
});

// R12/M3 第 6 批复核 R6-1 回归：真实 Baserow 行接口会在父行上返回**反向** link_row 字段
// （子行写入后自动出现）。内存替身默认不模拟这一行为，故这里在**读取时**按实测字段名合成，
// 以便复现“已存在的视频行 + 本轮补齐子行 → 反向 link 从空变非空”这一原始故障场景。
const withReverseLinks = (inner) => ({
  ...inner,
  async listAllRows(name) {
    const rows = await inner.listAllRows(name);
    const reverse = REVERSE_LINK_FIELDS[name] ?? {};
    if (!Object.keys(reverse).length) return rows;
    return rows.map((r) => {
      const out = { ...r };
      const childPk = (t) => TABLE_PRIMARY_KEY[t];
      for (const [field, childTable] of Object.entries(reverse)) {
        const forward = Object.entries(LINK_FIELDS[childTable] ?? {}).find(([, target]) => target === name)?.[0];
        const kids = forward
          ? inner.listRows(childTable).filter((c) => {
            const v = c[forward];
            return Array.isArray(v) ? v.map(String).includes(String(r.id)) : String(v) === String(r.id);
          })
          : [];
        out[field] = kids.map((c) => ({ id: c.id, value: String(c[childPk(childTable)]), order: String(c.id) }));
      }
      return out;
    });
  },
});

test('R12-M3-A: 反向 link 顺序产物不判为不符（含已存在父行+本轮补齐子行），真实不符仍拦下', async () => {
  // ① 适用范围：Videos 的反向 link 字段必须被认得。
  //    旧版只查 LINK_FIELDS，而 Videos 在 LINK_FIELDS 里是空集 → 豁免从未生效（第 6 批复核 R6-1）。
  assert.deepEqual([...linkFieldNames(TABLE_VIDEOS)].sort(), ['Assets', 'Metric observations', 'Ratios', 'Segments']);
  assert.ok(linkFieldNames(TABLE_RATIOS).includes('video_link'), '正向字段仍须纳入');

  // ② 判定语义：只豁免“意图为空、实际非空”的 link 形状
  const vLinks = linkFieldNames(TABLE_VIDEOS);
  const artifact = { field: 'Ratios', wanted: [], actual: [{ id: 30, value: 'x', order: '30' }] };
  assert.equal(isIgnorableLinkOrderArtifact(artifact, vLinks), true);
  assert.equal(isIgnorableLinkOrderArtifact(artifact, []), true, '未列名但形状是 link 数组 → 兜底豁免');
  assert.equal(isIgnorableLinkOrderArtifact({ field: 'Ratios', wanted: [{ id: 30 }], actual: [{ id: 31 }] }, vLinks), false, '意图有值却对不上 → 仍计为不符');
  assert.equal(isIgnorableLinkOrderArtifact({ field: 'review_notes', wanted: null, actual: 'x' }, vLinks), false, '非 link 字段不得豁免');
  assert.equal(isIgnorableLinkOrderArtifact({ field: 'Ratios', wanted: [], actual: [] }, vLinks), false);
  assert.equal(isLinkShaped([{ id: 1 }]), true);
  assert.equal(isLinkShaped([7, 8]), true);
  assert.equal(isLinkShaped([]), false);
  assert.equal(isLinkShaped([{ foo: 1 }]), false);
  assert.equal(isLinkShaped('x'), false);

  // ③ 原始故障场景：先只写视频行（反向 link 为空），再用完整记录在本轮补齐子行
  const bare = [normalizeEntity(entity(), [])];
  const full = [normalizeEntity(entity(), [fieldRow('engagement_like', 'present_and_usable', 7)])];
  const inner = createMemoryBackend();
  for (const t of ALL_TABLES) await inner.createTable(t);
  const backend = withReverseLinks(inner);
  await importRecords({ records: bare, backend, mode: 'test' });
  const videoRowId = inner.listRows(TABLE_VIDEOS)[0].id;
  // 模拟真实中断状态（run1：Videos 50/50 已写、Ratios 0/50 未写）：删掉本轮之前写入的比率子行，
  // 使视频行的反向 link 在**本轮开始时**为空，而本轮补齐子行后会变成非空。
  for (const r of inner.listRows(TABLE_RATIOS)) inner.deleteRow(TABLE_RATIOS, String(r[TABLE_PRIMARY_KEY[TABLE_RATIOS]]));
  assert.equal(inner.listRows(TABLE_RATIOS).length, 0, '前置：本轮开始时没有比率子行');
  const before = (await backend.listAllRows(TABLE_VIDEOS))[0];
  const nonEmptyBefore = Object.keys(REVERSE_LINK_FIELDS[TABLE_VIDEOS]).filter((f) => (before[f] ?? []).length > 0);
  assert.deepEqual(nonEmptyBefore, [], `前置：视频行反向 link 应为空，实际 ${JSON.stringify(nonEmptyBefore)}`);

  const receipt = await importRecords({ records: full, backend, mode: 'test' });
  const after = (await backend.listAllRows(TABLE_VIDEOS))[0];
  const filledNow = Object.keys(REVERSE_LINK_FIELDS[TABLE_VIDEOS]).filter((f) => (after[f] ?? []).length > 0);
  assert.ok(filledNow.length > 0, `本轮补齐的子行必须在视频行上生成反向 link：${JSON.stringify(after)}`);

  const v = receipt.post_write_reconciliation[TABLE_VIDEOS];
  assert.equal(v.field_mismatches.length, 0, `反向 link 顺序产物不得计为不符：${JSON.stringify(v.field_mismatches.slice(0, 1))}`);
  assert.equal(receipt.ok, true, `已存在父行经本轮补齐后不得把 ok 判成 false：${JSON.stringify(v.field_mismatches.slice(0, 1))}`);
  assert.deepEqual([...v.link_field_names_checked].sort(), ['Assets', 'Metric observations', 'Ratios', 'Segments'], '回执须显式登记本轮核对过的 link 字段名');
  assert.deepEqual([...v.reverse_link_fields_excluded_from_field_compare].sort(), ['Assets', 'Metric observations', 'Ratios', 'Segments'], '反向字段必须显式登记为“不参与逐字段比较”');
  assert.equal(v.relation_mismatches.length, 0, `反向关系必须按目标 id 集合核对通过：${JSON.stringify(v.relation_mismatches.slice(0, 1))}`);
  assert.equal(v.relation_checks_skipped, 0, '父行已绑定时不得出现被跳过的关系核对');
  assert.equal(inner.listRows(TABLE_VIDEOS).length, 1, '不得重复插入视频行');
  assert.equal(inner.listRows(TABLE_VIDEOS)[0].id, videoRowId);
});

// ─────────────── P0：面板列表卡片化（关键数字 / 业务词 / 行业优先级排序） ───────────────
// 口径来源＝tools/material-library/panel-metrics.mjs（服务端与前端共用同一份规则）。
test('P0 列表关键数字：只认「真实观测」，缺失显示「—」而不是 0', () => {
  const obs = [
    { entity_key: 'K1', field: 'engagement_play', status: 'value', numeric_value: '1200.000000', value_text: '1200', observed_at_epoch_s: '100' },
    { entity_key: 'K1', field: 'engagement_play', status: 'value', numeric_value: '1500.000000', value_text: '1500', observed_at_epoch_s: '200' },
    { entity_key: 'K1', field: 'engagement_play', status: 'absent', numeric_value: null, value_text: '', observed_at_epoch_s: '300' },
    { entity_key: 'K1', field: 'engagement_like', status: 'observed_zero', numeric_value: '0.000000', value_text: '0', observed_at_epoch_s: '250' },
    { entity_key: 'K1', field: 'engagement_comment', status: 'unusable', numeric_value: '9.000000', value_text: '9', observed_at_epoch_s: '260' },
  ];
  assert.equal(isRealObservation(obs[2]), false, 'absent 不得算真实观测');
  assert.equal(isRealObservation(obs[3]), true, 'observed_zero 是真实观测（0 也是结论）');
  const idx = indexLatestRealMetrics(obs);
  const m = keyMetricsOf(idx, 'K1');
  assert.equal(m.engagement_play.value, 1500, '最新的真实观测（epoch 200）胜出，晚到的 absent 不得覆盖');
  assert.equal(m.engagement_play.display, '1500');
  assert.equal(m.engagement_like.value, 0);
  assert.equal(m.engagement_like.display, '0', '真实观测到的 0 必须显示 0');
  assert.equal(m.engagement_comment.value, null, 'unusable 不得当成有值');
  assert.equal(m.engagement_comment.display, '—', '缺失显示「—」，不得显示 0');
  assert.equal(keyMetricsOf(idx, '不存在的身份').engagement_play.display, '—');
  assert.equal(countRealObservations(obs, 'K1'), 3, '真实观测条数＝value/observed_zero 的条数');
  assert.equal(metricNumber({ numeric_value: null, value_text: '77' }), 77, 'numeric_value 缺失时退回 value_text');
});

test('P0 列表关键数字：显示格式（万级折算、0 与缺失区分）', () => {
  assert.equal(formatMetricValue(null), '—');
  assert.equal(formatMetricValue(0), '0');
  assert.equal(formatMetricValue(999), '999');
  assert.equal(formatMetricValue(123456), '12.3万');
  assert.equal(formatMetricValue(100000), '10万');
});

test('P0 业务词：实现词不得出现在界面词表里', () => {
  assert.equal(reviewStatusTerm('unreviewed'), '待人工复核');
  assert.equal(reviewStatusTerm('in_review'), '复核中');
  assert.equal(reviewStatusTerm('reviewed'), '通过');
  assert.equal(reviewStatusTerm('rejected'), '排除');
  assert.equal(reviewStatusTerm(''), '待人工复核');
  assert.equal(sourceStateTerm('observed'), '来源正常');
  assert.equal(sourceStateTerm('source_unavailable'), '采集不到来源');
  assert.equal(sourceStateTerm('unknown'), '来源待确认');
  assert.equal(sourceStateTerm(''), '来源待确认');
  for (const { field, label } of KEY_METRIC_FIELDS) {
    assert.ok(!/_/.test(label), `关键数字的业务词不得含下划线：${label}`);
    assert.ok(/^[a-z_]+$/.test(field), `字段名应为库内字段：${field}`);
  }
});

test('P0 标题：没有标题字段时按业务读法拼，绝不吐身份主键', () => {
  const withCat = businessTitleOf({ product_category: '磁吸功能壳', platform: 'TikTok', author_display_name: 'case_lab', publish_date_epoch_s: 1789992790 }, { key: 'TikTok|main|7687749923823013133' });
  assert.equal(withCat.title, '磁吸功能壳');
  assert.equal(withCat.basis, '人工分类');
  const unknownCat = businessTitleOf({ product_category: '未知', platform: 'Xiaohongshu', author_display_name: '土豆爱临平', publish_date_epoch_s: 1789992790 }, { key: 'Xiaohongshu|main|6ab11f5600000000340179fa' });
  assert.ok(!unknownCat.title.includes('Xiaohongshu|'), '标题里不得出现身份主键');
  assert.ok(unknownCat.title.includes('Xiaohongshu') && unknownCat.title.includes('土豆爱临平'), `应含平台与账号：${unknownCat.title}`);
  assert.equal(unknownCat.basis, '平台/账号/日期（无标题字段）');
  const empty = businessTitleOf({}, { key: 'YouTube|main|zGdPq7WhDOA' });
  assert.equal(empty.title, '素材 zGdPq7WhDOA'.replace('zGdPq7WhDOA', shortKey('YouTube|main|zGdPq7WhDOA')), '完全无信息时应给可读短编号');
  assert.equal(shortKey('TikTok|main|7687749923823013133'), 'TikTok-013133');
});

test('P0 默认排序＝行业优先级（分档 → 有本地视频 → 播放量 → 片段 → 观测数 → 时间）', () => {
  const mk = (o) => Object.assign({ key: 'k', tier: null, has_playable_media: false, segment_count: 0, metrics_observed: 0, publish_epoch_s: 0, key_metrics: { engagement_play: { value: null } } }, o);
  const t4 = mk({ key: 'T4', tier: 'T4 低信息量', key_metrics: { engagement_play: { value: 999999 } } });
  const t3 = mk({ key: 'T3', tier: 'T3 标准证据', key_metrics: { engagement_play: { value: 10 } } });
  const t2low = mk({ key: 'T2LOW', tier: 'T2 证据充分', key_metrics: { engagement_play: { value: 5 } } });
  const t2high = mk({ key: 'T2HIGH', tier: 'T2 证据充分', key_metrics: { engagement_play: { value: 500 } } });
  const t1 = mk({ key: 'T1', tier: 'T1 有本地视频', has_playable_media: true, key_metrics: { engagement_play: { value: 1 } } });
  const none = mk({ key: 'NONE' });
  const order = sortByIndustryPriority([t4, t3, t2low, t2high, t1, none]).map((x) => x.key);
  assert.deepEqual(order, ['T1', 'T2HIGH', 'T2LOW', 'T3', 'T4', 'NONE'], `排序应体现行业优先级，实际 ${order.join('>')}`);
  // 同档、同播放量时：有片段/观测多的在前
  const a = mk({ key: 'A', tier: 'T3 标准证据', segment_count: 0, metrics_observed: 3, key_metrics: { engagement_play: { value: 7 } } });
  const b = mk({ key: 'B', tier: 'T3 标准证据', segment_count: 2, metrics_observed: 9, key_metrics: { engagement_play: { value: 7 } } });
  assert.deepEqual(sortByIndustryPriority([a, b]).map((x) => x.key), ['B', 'A']);
  // 回归（P0 验收实测发现）：没有播放量 ≠ 播放量 0 —— 无量必须排在真实 0 之后
  const noData = mk({ key: 'NODATA', tier: 'T3 标准证据', key_metrics: { engagement_play: { value: null } } });
  const realZero = mk({ key: 'ZERO', tier: 'T3 标准证据', key_metrics: { engagement_play: { value: 0 } } });
  assert.deepEqual(sortByIndustryPriority([noData, realZero]).map((x) => x.key), ['ZERO', 'NODATA'], '无播放量的素材不得排在观测到的 0 前面');
  assert.deepEqual(sortByIndustryPriority([realZero, noData]).map((x) => industryPriorityKey(x)[2]), [0, Number.POSITIVE_INFINITY]);
});

test('P0 分档字段选项与代码/证据一致（防 schema 与界面漂移）', () => {
  const p = path.join(W_ROOT, 'outputs', 'product-material-library-phase1-20261006', 'evidence', 'r12-panel-p0-add-tier-field.json');
  if (!fs.existsSync(p)) return; // 证据不在时不误报（该断言只在工作区内运行时生效）
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const opts = (j.field?.options ?? []).slice().sort();
  assert.deepEqual(opts, ['T1 有本地视频', 'T2 证据充分', 'T3 标准证据', 'T4 低信息量'].sort(), '分档字段选项必须与代码使用的档位串一致');
  assert.equal(j.value_tier_present_after, true, '分档字段必须已在 Videos 表建立');
});