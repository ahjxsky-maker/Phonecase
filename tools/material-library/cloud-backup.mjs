// tools/material-library/cloud-backup.mjs —— 每日整库备份到自有桶（M6 步骤4）
//
// 设计要点：
//   * **一致快照**：用 SQLite `VACUUM INTO` 生成一致副本（不是直接拷文件，避免 WAL 半写）。
//   * **一天一份、幂等**：云端键 `phonecase/backup/<UTC 日期>.sqlite`；已存在同日备份时默认跳过（除非 force）。
//   * **绝不静默**：结果里带 key/bytes/etag/耗时与失败原因；失败不改台账、不删任何东西。
//   * **取回演练**：`restoreDrill()` 从云端取回当日备份，**再本地重做一次快照逐字节比对**，并打开取回文件读计数。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { putObject, headObject, listObjects, getObjectBuffer, readCredential, DEFAULT_BUCKET, DEFAULT_REGION } from './cloud-store.mjs';
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 小步重试：云端偶发失败（例如刚做过大量 PUT 后的短暂拒绝）不该让整次备份失败。 */
async function retry(fn, { attempts = 3, delayMs = 1500, label = 'op' } = {}) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    last = await fn();
    if (last && last.status === 200) return last;
    if (i < attempts - 1) await sleep(delayMs);
  }
  return { ...(last ?? {}), retry_label: label, retry_attempts: attempts, retry_exhausted: true };
}

/** 打开一个 sqlite 文件读计数（只读）。用于"从**快照**读行数"，避免并发写入导致元数据与快照不一致。 */
function countsOfFile(file) {
  const rdb = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      materials: rdb.prepare('SELECT COUNT(*) n FROM materials').get().n,
      segments: rdb.prepare('SELECT COUNT(*) n FROM segments').get().n,
      assets: rdb.prepare('SELECT COUNT(*) n FROM assets').get().n,
      assets_uploaded: rdb.prepare("SELECT COUNT(*) n FROM assets WHERE cloud_state='uploaded'").get().n,
    };
  } finally { rdb.close(); }
}

/** 当日是否已有**数据库对象 + 元数据**（两者齐全才算"今天备份过了"；缺元数据要补）。 */
async function existingPair({ key, metaKey, bucket, region, credential }) {
  const [dbObj, metaObj] = await Promise.all([
    headObject({ key, bucket, region, credential }),
    headObject({ key: metaKey, bucket, region, credential }),
  ]);
  return { dbObj, metaObj, complete: dbObj.status === 200 && metaObj.status === 200 };
}

/** 生成一致快照文件（VACUUM INTO），返回路径与字节。 */
export function snapshotDb(db, { dir = os.tmpdir(), tag = 'pc-backup' } = {}) {
  const out = path.join(fs.mkdtempSync(path.join(dir, `${tag}-`)), 'snapshot.sqlite');
  const escaped = out.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}'`);
  const buf = fs.readFileSync(out);
  return { path: out, bytes: buf.length, sha256: sha256(buf) };
}

/** 备份整库到云端（幂等）。`day` 只用于把备份挂到某个 UTC 日期下（默认今天），便于跨日演练与补备份。 */
export async function backupDaily(db, { bucket = DEFAULT_BUCKET, region = DEFAULT_REGION, force = false, credential = null, day = null } = {}) {
  const cred = credential ?? readCredential();
  const useDay = day ?? utcDay();
  const key = `phonecase/backup/${useDay}.sqlite`;
  const metaKey = `phonecase/backup/${useDay}.json`;
  const startedAt = new Date().toISOString();
  // 复核 B02 修复：**只有"数据库对象 + 元数据"两者都齐**才算今天备份完成；
  // 只有其一（例如上次元数据写失败）时会走上面这条重做路径补齐，而不是直接返回"今天已备份"。
  const existing = await existingPair({ key, metaKey, bucket, region, credential: cred });
  if (existing.complete && !force) {
    return {
      ok: true, action: 'already_backed_up_today', key, day: useDay,
      bytes: Number(existing.dbObj.bytes), etag: existing.dbObj.etag,
      meta_key: metaKey, meta_bytes: Number(existing.metaObj.bytes), at: startedAt,
    };
  }
  const repairingMetaOnly = existing.dbObj.status === 200 && existing.metaObj.status !== 200 && !force;

  // 复核 B02（第四轮）修复：**补齐元数据必须绑定云端已有的那份数据库**，不能用当前本地快照冒充——
  // 否则"本地已变、云端还是旧库"时会写出错误的 sha256/counts，让演练永远失败（或更糟：看似通过却对不上）。
  if (repairingMetaOnly) {
    const cloudObj = await getObjectBuffer({ key, bucket, region, credential: cred });
    if (cloudObj.status !== 200) {
      return { ok: false, action: 'failed', failure_reason: 'cannot_read_existing_cloud_object', key, day: useDay, cloud_get_status: cloudObj.status, at: startedAt, finished_at: new Date().toISOString() };
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-meta-repair-'));
    const file = path.join(dir, 'cloud-copy.sqlite');
    fs.writeFileSync(file, cloudObj.bytes);
    let counts = null; let readErr = null;
    try { counts = countsOfFile(file); } catch (e) { readErr = String(e?.message ?? e).slice(0, 200); }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    if (!counts) {
      return { ok: false, action: 'failed', failure_reason: 'cloud_object_not_openable', detail: readErr, key, day: useDay, at: startedAt, finished_at: new Date().toISOString() };
    }
    const meta = { at: startedAt, day: useDay, key, bytes: cloudObj.bytes.length, sha256: sha256(cloudObj.bytes), counts, source: 'repaired_from_existing_cloud_object', source_db: path.basename(process.env.PHONECASE_STORE_DB ?? 'store/material-library.sqlite'), note: '本文件记录**云端既有对象**的真实指纹与行数（不是本地快照）；取回演练据此核对。' };
    const metaPut = await retry(() => putObject({ key: metaKey, buf: Buffer.from(JSON.stringify(meta, null, 2), 'utf8'), contentType: 'application/json', bucket, region, credential: cred }), { label: 'put_meta_repaired' });
    const head = await headObject({ key: metaKey, bucket, region, credential: cred });
    const ok = metaPut.status === 200 && head.status === 200;
    return {
      ok, action: ok ? 'meta_repaired' : 'failed', key, day: useDay, bytes: cloudObj.bytes.length, cloud_bytes: Number(existing.dbObj.bytes) || cloudObj.bytes.length,
      etag: existing.dbObj.etag ?? null, sha256: meta.sha256, counts, meta_key: metaKey, meta_status: metaPut.status ?? null,
      meta_bound_to: 'existing_cloud_object', put_status: 200, head_status: existing.dbObj.status, at: startedAt, finished_at: new Date().toISOString(),
      failure_reason: ok ? null : 'meta_write_failed',
    };
  }

  const snap = snapshotDb(db);
  // 复核 N01 修复：行数从**快照文件**读，不从正在使用的库读（避免并发写入导致元数据与快照不一致）。
  const counts = countsOfFile(snap.path);
  try {
    const put = await retry(() => putObject({ key, buf: fs.readFileSync(snap.path), contentType: 'application/octet-stream', bucket, region, credential: cred }), { label: 'put_data' });
    const head = await headObject({ key, bucket, region, credential: cred });
    const dataOk = put.status === 200 && head.status === 200 && Number(head.bytes) === snap.bytes;
    // 备份元数据（同名 .json）：记录**上传那一刻**的 sha256 与行数。
    const meta = { at: startedAt, day: useDay, key, bytes: snap.bytes, sha256: snap.sha256, counts, source: 'fresh_snapshot', source_db: path.basename(process.env.PHONECASE_STORE_DB ?? 'store/material-library.sqlite'), note: '本文件记录上传时刻的快照指纹与行数；取回演练据此核对。' };
    const metaPut = dataOk ? await retry(() => putObject({ key: metaKey, buf: Buffer.from(JSON.stringify(meta, null, 2), 'utf8'), contentType: 'application/json', bucket, region, credential: cred }), { label: 'put_meta' }) : { status: 0 };
    // 复核 B02 修复：**元数据写失败 = 备份失败**（否则"备份成功但无法校验"，而且重试也不会发现）。
    const ok = dataOk && metaPut.status === 200;
    const action = ok ? (existing.dbObj.status === 200 ? 'overwritten' : 'uploaded') : 'failed';
    return {
      ok, action, key, day: useDay, bytes: snap.bytes, cloud_bytes: Number(head.bytes) || null, etag: head.etag ?? null,
      sha256: snap.sha256, counts, meta_key: metaKey, meta_status: metaPut.status ?? null,
      put_status: put.status, head_status: head.status, at: startedAt, finished_at: new Date().toISOString(),
      failure_reason: ok ? null : (dataOk ? 'meta_write_failed' : 'data_write_or_verify_failed'),
    };
  } finally {
    try { fs.rmSync(path.dirname(snap.path), { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响结论 */ }
  }
}

/** 取库内行数（用于备份元数据与演练核对）。 */
export function dbCounts(db) {
  return {
    materials: db.prepare('SELECT COUNT(*) n FROM materials').get().n,
    segments: db.prepare('SELECT COUNT(*) n FROM segments').get().n,
    assets: db.prepare('SELECT COUNT(*) n FROM assets').get().n,
    assets_uploaded: db.prepare("SELECT COUNT(*) n FROM assets WHERE cloud_state='uploaded'").get().n,
  };
}

/** 取回演练：云端取回备份 → 用**备份时的元数据 sha256** 核对完整性 → 打开取回文件读计数并与元数据比对。 */
export async function restoreDrill(db, { bucket = DEFAULT_BUCKET, region = DEFAULT_REGION, key = null, credential = null } = {}) {
  const cred = credential ?? readCredential();
  const day = utcDay();
  const targetKey = key ?? `phonecase/backup/${day}.sqlite`;
  const targetDay = (targetKey.match(/(\d{4}-\d{2}-\d{2})\.sqlite$/) ?? [])[1] ?? day;
  const metaKey = `phonecase/backup/${targetDay}.json`;
  const got = await getObjectBuffer({ key: targetKey, bucket, region, credential: cred });
  if (got.status !== 200) return { ok: false, key: targetKey, reason: 'cloud_get_failed', status: got.status };
  const gotMeta = await getObjectBuffer({ key: metaKey, bucket, region, credential: cred });
  let meta = null; try { meta = JSON.parse(gotMeta.bytes.toString('utf8')); } catch { /* 无元数据也如实返回 */ }
  const downloadedSha = sha256(got.bytes);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-restore-'));
  const file = path.join(dir, 'restored.sqlite');
  fs.writeFileSync(file, got.bytes);
  let counts = null; let err = null;
  try {
    const rdb = new DatabaseSync(file, { readOnly: true });
    counts = dbCounts(rdb);
    rdb.close();
  } catch (e) { err = String(e?.message ?? e).slice(0, 200); }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  // 与"现在的本地快照"是否相同只作为**参考信息**（台账会正常写入，改过就不该相同）。
  const local = snapshotDb(db, { tag: 'pc-restore-drill' });
  const localBuf = fs.readFileSync(local.path);
  try { fs.rmSync(path.dirname(local.path), { recursive: true, force: true }); } catch { /* 忽略 */ }
  const identical = Buffer.compare(got.bytes, localBuf) === 0;
  const integrityOk = !!meta?.sha256 && meta.sha256 === downloadedSha;
  const countsOk = !!meta?.counts && !!counts && memoCountsEqual(meta.counts, counts);
  return {
    ok: got.status === 200 && integrityOk && countsOk && !err && counts.materials > 0,
    key: targetKey, meta_key: metaKey, meta_found: !!meta,
    cloud_bytes: got.bytes.length, cloud_sha256: downloadedSha, meta_sha256: meta?.sha256 ?? null, integrity_ok: integrityOk,
    counts, meta_counts: meta?.counts ?? null, counts_match_meta: countsOk, open_error: err,
    identical_to_current_snapshot: identical, current_snapshot_bytes: localBuf.length,
    at: new Date().toISOString(),
    note: '完整性以**备份时的元数据 sha256** 为准；"与当前快照是否逐字节相同"只作参考（台账若有正常写入就不会相同）。',
  };
}

function memoCountsEqual(a, b) { return ['materials', 'segments', 'assets'].every((k) => Number(a?.[k]) === Number(b?.[k])); }

/** 列出云端备份清单（只读）。 */
export async function listBackups({ bucket = DEFAULT_BUCKET, region = DEFAULT_REGION, credential = null } = {}) {
  const r = await listObjects({ prefix: 'phonecase/backup/', bucket, region, credential: credential ?? readCredential() });
  return { ok: r.status === 200, count: r.count, truncated: r.truncated ?? false, keys: (r.keys ?? []).map((k) => ({ key: k.key, size: k.size, etag: k.etag, lastModified: k.lastModified })), error: r.error ?? null };
}

export { utcDay };
