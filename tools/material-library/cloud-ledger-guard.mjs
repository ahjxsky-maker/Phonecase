// tools/material-library/cloud-ledger-guard.mjs —— 台账不变式（只读，可被多次调用，不自己写任何东西）
//
// 由来（监督复核 F01/F03）："上传失败/复核不符却仍留在 uploaded" 这类问题靠逐条断言容易漏。
// 这里把**必须永远成立的不变式**集中成一处，谁都能调：
//   ① 任何 `cloud_state='uploaded'` 的行都必须有完整云登记（provider/bucket/region/key/etag/bytes/uploaded_at）；
//   ② 失败态（stale/mismatch/failed_upload/failed_local_missing）**不得**带 `uploaded_at`（避免被误读成"传成功过"）；
//   ③ 不允许出现 `uploaded` 但 `cloud_bytes<=0` 或 `cloud_etag` 为空的"空壳登记"。
export const FAILED_STATES = ['stale', 'mismatch', 'failed_upload', 'failed_local_missing'];

export function ledgerInvariants(db) {
  const rows = db.prepare('SELECT asset_id, entity_key, cloud_key, cloud_etag, cloud_bytes, cloud_state, cloud_uploaded_at, cloud_provider, cloud_bucket, cloud_region FROM assets').all();
  const violations = [];
  for (const r of rows) {
    if (r.cloud_state === 'uploaded') {
      const missing = ['cloud_provider', 'cloud_bucket', 'cloud_region', 'cloud_key', 'cloud_etag', 'cloud_uploaded_at'].filter((f) => !r[f]);
      if (missing.length) violations.push({ asset_id: r.asset_id, rule: 'uploaded_requires_full_registration', missing });
      if (!(Number(r.cloud_bytes) > 0)) violations.push({ asset_id: r.asset_id, rule: 'uploaded_requires_positive_bytes', cloud_bytes: r.cloud_bytes });
    }
    if (FAILED_STATES.includes(r.cloud_state ?? '') && r.cloud_uploaded_at) {
      violations.push({ asset_id: r.asset_id, rule: 'failed_state_must_not_look_uploaded', cloud_state: r.cloud_state, cloud_uploaded_at: r.cloud_uploaded_at });
    }
  }
  const byState = Object.fromEntries(db.prepare('SELECT COALESCE(cloud_state, \'(none)\') s, COUNT(*) n FROM assets GROUP BY s').all().map((x) => [x.s, x.n]));
  return { ok: violations.length === 0, checked: rows.length, by_state: byState, violations };
}
