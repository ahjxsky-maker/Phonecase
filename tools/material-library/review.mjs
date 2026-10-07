// tools/material-library/review.mjs
// P4：人工复核覆盖层。人工输入与来源事实必须分开保存：
//   - 来源派生字段由导入写出，永不写入人工结论；
//   - 人工字段只在覆盖层中由人写入，导入时**只读**应用，绝不被来源覆盖；
//   - 来源证据变化时，人工文本保留，但依赖该证据的判断被标记 stale。
// R3/F4：新增**人工产品/功能/场景分类**（来源无留存 → 保持 unknown；仅人工可填，须带复核人与证据引用）。
// R3/F5：测试身份写入的标注一律不算真实人工判断；覆盖层路径可隔离，测试不得污染正式覆盖层。
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_ROOT, sourcePaths } from './rules.mjs';

export const REVIEW_STATUSES = ['unreviewed', 'in_review', 'reviewed', 'rejected'];
export const REVIEW_CATEGORIES = ['performance_reference', 'creative_reference', 'product_demand_clue'];

// F4：人工分类字段与依据字段。来源无这三类字段，因此其值只能是 'unknown' 或人工值。
export const HUMAN_CLASSIFICATION_FIELDS = ['product_category', 'product_function', 'scene_or_need'];
export const CLASSIFICATION_STATES = ['proposed', 'reviewed', 'rejected'];

// F5：测试身份集合。这些身份写入的标注不得进入“生产样式”的有效选择。
export const TEST_REVIEWER_IDENTITIES = ['journey-selftest', 'simon-selftest', 'harness-selftest', 'selftest'];

export function isTestIdentity(reviewer) {
  return !!reviewer && TEST_REVIEWER_IDENTITIES.includes(String(reviewer));
}

export function overlayPath(root = DEFAULT_ROOT) {
  return path.join(sourcePaths(root).outRoot, 'human-review', 'review-overlay.json');
}

// F5：允许显式指定覆盖层路径（测试/旅程用隔离夹具，绝不写正式覆盖层）。
export function resolveOverlayPath({ root = DEFAULT_ROOT, overlayPath: explicit = null } = {}) {
  return explicit ?? overlayPath(root);
}

export function loadOverlay(root = DEFAULT_ROOT, explicitPath = null) {
  const p = resolveOverlayPath({ root, overlayPath: explicitPath });
  if (!fs.existsSync(p)) return { schema_version: 'human-review-overlay/1.0.0', updated_at: null, kind: null, entries: {} };
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  j.entries ??= {};
  return j;
}

export function saveOverlay(overlay, root = DEFAULT_ROOT, explicitPath = null) {
  const p = resolveOverlayPath({ root, overlayPath: explicitPath });
  fs.mkdirSync(path.dirname(p), { recursive: true });
  overlay.schema_version = 'human-review-overlay/1.0.0';
  overlay.updated_at = new Date().toISOString();
  fs.writeFileSync(p, JSON.stringify(overlay, null, 2));
  return p;
}

// 应用覆盖层到归一化记录。只写人工字段；不触碰来源派生字段。
export function applyOverlay(records, overlay) {
  let applied = 0, testIdentities = 0, classified = 0;
  const missing = [];
  const entries = overlay?.entries ?? {};
  const byKey = new Map(records.map((r) => [r.entity_key, r]));
  for (const [k, human] of Object.entries(entries)) {
    const rec = byKey.get(k);
    if (!rec) { missing.push(k); continue; }
    const isTest = isTestIdentity(human.reviewer);
    if (isTest) testIdentities++;
    rec.review = {
      status: human.status ?? 'unreviewed',
      reviewer: human.reviewer ?? null,
      reviewed_at: human.reviewed_at ?? null,
      notes: Array.isArray(human.notes) ? human.notes : (human.note ? [human.note] : []),
      human_value_categories: Array.isArray(human.value_categories) ? human.value_categories : [],
      // F5：测试身份不得算作人工精选
      selected_reference: human.selected_reference === true && !isTest,
      is_test_identity: isTest,
      ownership: isTest ? 'test_identity_excluded' : (human.ownership ?? 'human'),
      // 人工在写入时声明其所依据的证据指纹；证据变化后据此失效，而不是把批准带到新证据上
      based_on_evidence_fingerprint: human.based_on_evidence_fingerprint ?? null,
      stale: false,
      stale_reason: null,
    };
    if (rec.review.based_on_evidence_fingerprint
      && rec.review.based_on_evidence_fingerprint !== rec.evidence_fingerprint) {
      rec.review.stale = true;
      rec.review.stale_reason = `evidence_changed:${rec.review.based_on_evidence_fingerprint}->${rec.evidence_fingerprint}`;
    }
    // F4：人工分类 → 覆盖到“有效字段”，并保留来源标记（绝不冒充来源事实）
    const cls = human.classification ?? {};
    for (const f of HUMAN_CLASSIFICATION_FIELDS) {
      const v = cls[f];
      const originField = `${f}_origin`;
      const reviewerField = `${f}_reviewer`;
      const evidenceField = `${f}_evidence_ref`;
      const stateField = `${f}_state`;
      if (v !== undefined && v !== null && v !== '') {
        rec.classification[f] = String(v);
        rec.classification[originField] = 'human_review';
        rec.classification[reviewerField] = human.reviewer ?? null;
        rec.classification[evidenceField] = cls.evidence_ref ?? human.classification_evidence_ref ?? null;
        rec.classification[stateField] = cls.state ?? 'proposed';
        classified++;
      } else {
        rec.classification[originField] ??= rec.classification[f] === 'unknown' ? 'unknown_no_source' : 'source_value';
        rec.classification[reviewerField] = null;
        rec.classification[evidenceField] = null;
        rec.classification[stateField] = null;
      }
    }
    // 测试身份的分类不得作为有效分类
    if (isTest) {
      for (const f of HUMAN_CLASSIFICATION_FIELDS) if (rec.classification[`${f}_origin`] === 'human_review') rec.classification[`${f}_origin`] = 'human_review_test_identity_excluded';
    }
    applied++;
  }
  return { applied, missing, test_identity_entries: testIdentities, classification_values_applied: classified };
}

export function setReview({
  entityKey, status, reviewer, category, note, selectReference, basedOn,
  classification = null, classificationEvidenceRef = null,
}, overlay) {
  if (!entityKey) throw new Error('review_requires_entity_key');
  if (status && !REVIEW_STATUSES.includes(status)) throw new Error(`invalid_review_status:${status}`);
  if (category && !REVIEW_CATEGORIES.includes(category)) throw new Error(`invalid_review_category:${category}`);
  const cur = overlay.entries[entityKey] ?? { notes: [], value_categories: [] };
  const next = {
    ...cur,
    status: status ?? cur.status ?? 'unreviewed',
    reviewer: reviewer ?? cur.reviewer ?? null,
    reviewed_at: new Date().toISOString(),
    notes: cur.notes ? [...cur.notes] : [],
    value_categories: cur.value_categories ? [...cur.value_categories] : [],
    selected_reference: selectReference === undefined ? (cur.selected_reference ?? false) : selectReference === true,
    based_on_evidence_fingerprint: basedOn ?? cur.based_on_evidence_fingerprint ?? null,
  };
  if (note) next.notes.push(note);
  if (category && !next.value_categories.includes(category)) next.value_categories.push(category);
  if (classification) {
    const cls = { ...(cur.classification ?? {}), evidence_ref: classificationEvidenceRef ?? cur.classification?.evidence_ref ?? null };
    for (const f of HUMAN_CLASSIFICATION_FIELDS) if (classification[f] !== undefined) cls[f] = classification[f];
    cls.state = classification.state ?? cls.state ?? 'proposed';
    // 分类必须能追溯到复核人与证据引用
    if (!next.reviewer) throw new Error('human_classification_requires_reviewer');
    if (!cls.evidence_ref) throw new Error('human_classification_requires_evidence_ref');
    next.classification = cls;
    next.classification_reviewer = next.reviewer;
  }
  overlay.entries[entityKey] = next;
  return next;
}

// F5：把测试身份的条目从“有效覆盖层”中摘出，归档保留（不删除、不丢失）。
export function splitTestIdentities(overlay) {
  const kept = { ...overlay, entries: {} };
  const extracted = {};
  const ambiguous = {};
  for (const [k, v] of Object.entries(overlay.entries ?? {})) {
    if (isTestIdentity(v.reviewer)) extracted[k] = v;
    else if (!v.reviewer) ambiguous[k] = v; // 归属不明：保留在有效层，但标注待核
    else kept.entries[k] = v;
  }
  for (const [k, v] of Object.entries(ambiguous)) kept.entries[k] = { ...v, ownership: 'pending_review_no_reviewer' };
  return { kept, extracted, ambiguous };
}
