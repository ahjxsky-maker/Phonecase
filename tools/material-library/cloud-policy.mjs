// tools/material-library/cloud-policy.mjs —— "什么算有价值 / 要不要把视频传上云"的**唯一判定源**
//
// 依据：Simon 2026-10-11「只传我们现在确定有价值的素材」＋ D4「只存有价值的，180 天转冷后删除」。
// 设计要点：
//   * **一处可改**：口径只在 `outputs/product-material-library-phase1-20261006/cloud-policy.json`，本模块只读它；
//     改口径 = 改那一份文件 + 提升 policy_id（历史审计保留当时的 policy_id，不被追溯改写）。
//   * **判定可解释**：每次判定返回 `reasons`（命中哪条规则）与 `policy_id`，供审计与面板显示；不返回"黑箱布尔"。
//   * **不替人做决定**：本模块不判断素材"好不好"，只按已批准的口径把事实（有没有 AI 职能 / 在不在计划 / 是否被点名）映射成决定。
import fs from 'node:fs';

export const DEFAULT_POLICY_PATH = 'D:/Codex-local/harness-workspaces/Phonecase/outputs/product-material-library-phase1-20261006/cloud-policy.json';

const FALLBACK = {
  policy_id: 'v0-fallback',
  policy_version: 0,
  upload_video_when: ['ai_role_any', 'in_shooting_plan', 'explicit_list'],
  upload_cover: 'all_with_cover',
  skip_other_video: true,
  explicit_entity_keys: [],
};

/** 读取口径（缺文件时用内置同口径兜底，并在返回值里标注 fallback，避免"读不到就当随便传"）。 */
export function readPolicy(policyPath = process.env.PHONECASE_CLOUD_POLICY ?? DEFAULT_POLICY_PATH) {
  try {
    const raw = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
    return { ...FALLBACK, ...raw, _path: policyPath, _fallback: false };
  } catch (e) {
    return { ...FALLBACK, _path: policyPath, _fallback: true, _error: String(e?.message ?? e).slice(0, 160) };
  }
}

/**
 * 判定一条素材该不该把**视频**传上云。
 * facts: { entityKey, hasAiRole:boolean, aiRoles:string[], inShootingPlan:boolean, hasLocalFile:boolean, alreadyUploaded:boolean }
 */
export function decideVideoUpload(facts, policy = readPolicy()) {
  const reasons = [];
  const keys = new Set((policy.explicit_entity_keys ?? []).map(String));
  const rules = new Set(policy.upload_video_when ?? []);
  if (rules.has('explicit_list') && keys.has(String(facts.entityKey))) reasons.push('explicit_list');
  if (rules.has('ai_role_any') && facts.hasAiRole) reasons.push(`ai_role_any(${(facts.aiRoles ?? []).slice(0, 3).join('/') || 'n/a'})`);
  if (rules.has('in_shooting_plan') && facts.inShootingPlan) reasons.push('in_shooting_plan');
  const upload = reasons.length > 0;
  return {
    entity_key: facts.entityKey,
    upload_video: upload,
    also_upload_cover: policy.upload_cover === 'all_with_cover' ? true : (upload && policy.upload_cover === 'valuable_only'),
    reasons: reasons.length ? reasons : ['no_rule_matched'],
    policy_id: policy.policy_id,
    policy_path: policy._path,
    policy_fallback: Boolean(policy._fallback),
    decided_at: new Date().toISOString(),
    note: upload
      ? '按当前口径：这条算"有价值"，视频与封面都可上云。'
      : '按当前口径：不上传视频（只保留文字与封面）；如需上传，改 cloud-policy.json 或把该素材加入 explicit_entity_keys。',
  };
}

/** 从库里取判定所需的事实（只读）。 */
export function factsFor(db, entityKey) {
  const seg = db.prepare('SELECT COUNT(*) n FROM segment_labels WHERE entity_key = ? AND ai_role IS NOT NULL').get(entityKey).n;
  const roles = db.prepare('SELECT DISTINCT ai_role FROM segment_labels WHERE entity_key = ? AND ai_role IS NOT NULL').all(entityKey).map((r) => r.ai_role);
  const inPlan = db.prepare('SELECT COUNT(*) n FROM plan_references WHERE entity_key = ?').get(entityKey).n > 0;
  const asset = db.prepare("SELECT asset_id, local_path, cloud_state FROM assets WHERE entity_key = ? AND usable_as_video = 1").get(entityKey);
  return {
    entityKey,
    hasAiRole: seg > 0,
    aiRoles: roles,
    inShootingPlan: inPlan,
    hasLocalFile: Boolean(asset?.local_path && fs.existsSync(asset.local_path)),
    alreadyUploaded: asset?.cloud_state === 'uploaded',
    asset_id: asset?.asset_id ?? null,
  };
}
