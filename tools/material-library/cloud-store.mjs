// tools/material-library/cloud-store.mjs —— 阿里云 OSS 读写接缝（M6 云存储，Simon 2026-10-10 授权）
//
// 边界与设计（都是本次任务直接要求的）：
//   * **密钥只在运行时读取**：先读环境变量 OSS_ACCESS_KEY_ID/OSS_ACCESS_KEY_SECRET，读不到再读本机
//     阿里云 CLI 配置里的独立 profile（默认 `phonecase-media-ops`）。**本模块不打印、不返回、不落盘密钥值。**
//   * **只服务自有桶**：默认 bucket `phonecase-media`、region `oss-cn-hongkong`；不碰其他桶。
//   * **私有桶**：读取一律走**短效签名 URL**（默认 15 分钟），或带签名的 HEAD/GET；不做公开读。
//   * **对象键口径**：`phonecase/<platform>/<native_id>/<role>.<ext>`（与 O/CLOUD-STORAGE-DEV-PLAN 一致）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';

export const DEFAULT_BUCKET = process.env.PHONECASE_OSS_BUCKET || 'phonecase-media';
export const DEFAULT_REGION = process.env.PHONECASE_OSS_REGION || 'oss-cn-hongkong';
export const DEFAULT_PROFILE = 'phonecase-media-ops';

// ★ 2026-10-14（Simon：「本地端打开这个视频都很慢…查询一下并修复」）：
//   实测直连 OSS(香港) 的**首字节要 0.4–1.9 秒、2MB 窗口平均只有 ~0.2–1.7 MB/s**；而每个 Range 请求原先都
//   **新建 TCP+TLS 连接**（`https.request` 未传 agent ⇒ 默认 `Connection: close`），播放器一切换/拖动就要再付一次握手 + 慢启动。
//   改为**进程级 keep-alive agent**（同一主机的连接复用），首字节与连续 Range 都会明显变快；对上游是"更少的连接、更少的握手"。
const OSS_AGENT = new https.Agent({ keepAlive: true, keepAliveMsecs: 15000, maxSockets: 8, maxFreeSockets: 4 });

// ★ 2026-10-14（Simon 批准方案①、并在控制台授权开启）：**传输加速端点**
//   · 香港/海外桶用 `oss-accelerate-overseas.aliyuncs.com`（实测该桶开启后 **206 可用**；`oss-accelerate.aliyuncs.com`（全球）当时仍返回
//     `InvalidRequest: OSS Transfer Acceleration is not configured on this bucket`，属"30 分钟内全网生效"的传播期）。
//   · OSS v1 签名**不覆盖 Host**，所以只需换主机名，其余签名逻辑不变。
//   · 开关：`PHONECASE_OSS_ACCELERATE=overseas|global`（默认关闭＝走原地域端点，可随时回退）。
const ACCEL_HOST = process.env.PHONECASE_OSS_ACCELERATE === 'overseas' ? 'oss-accelerate-overseas.aliyuncs.com'
  : process.env.PHONECASE_OSS_ACCELERATE === 'global' ? 'oss-accelerate.aliyuncs.com'
    : null;
export const ossHostFor = (bucket = DEFAULT_BUCKET, region = DEFAULT_REGION) => (ACCEL_HOST ? `${bucket}.${ACCEL_HOST}` : `${bucket}.${region}.aliyuncs.com`);
export const accelerationMode = () => ACCEL_HOST ?? 'off';

/** 读取运行时凭据（环境变量优先，其次阿里云 CLI 配置文件）。绝不外泄到日志。 */
export function readCredential({ profile = DEFAULT_PROFILE } = {}) {
  const envAk = process.env.OSS_ACCESS_KEY_ID;
  const envSk = process.env.OSS_ACCESS_KEY_SECRET;
  if (envAk && envSk) return { accessKeyId: envAk, accessKeySecret: envSk, source: 'env' };
  const cfgPath = path.join(os.homedir(), '.aliyun', 'config.json');
  if (!fs.existsSync(cfgPath)) throw new Error('cloud_credential_missing:no_env_and_no_cli_config');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const p = (cfg.profiles ?? []).find((x) => x.name === profile);
  if (!p?.access_key_id || !p?.access_key_secret) throw new Error(`cloud_credential_missing:profile ${profile}`);
  return { accessKeyId: p.access_key_id, accessKeySecret: p.access_key_secret, source: `cli_profile:${profile}` };
}

const md5B64 = (buf) => crypto.createHash('md5').update(buf).digest('base64');
const hmacSha1 = (key, str) => crypto.createHmac('sha1', key).update(str).digest('base64');
const encodeKey = (key) => String(key).split('/').map(encodeURIComponent).join('/');

/** 对象键：phonecase/<platform>/<nativeId>/<role>.<ext> */
export function objectKey({ platform = 'tiktok', nativeId, role = 'video', ext = 'mp4' }) {
  if (!nativeId) throw new Error('object_key_requires_native_id');
  return `phonecase/${String(platform).toLowerCase()}/${String(nativeId)}/${role}.${ext}`;
}

/** 带签名的请求（Header 签名，OSS v1）。bodyBuf 为 Buffer 时做 PUT。 */
export function signedRequest({ method, key, bodyBuf = null, contentType = null, bucket = DEFAULT_BUCKET, region = DEFAULT_REGION, credential = null, timeoutMs = 120000, accelerate = false } = {}) {
  const cred = credential ?? readCredential();
  // accelerate=true：强制走海外传输加速端点（仅当**源桶**已开启传输加速时可用；2026-10-14 用于香港→国内一次性迁移的取数加速）。
  const host = accelerate ? `${bucket}.oss-accelerate-overseas.aliyuncs.com` : ossHostFor(bucket, region);
  const date = new Date().toUTCString();
  const md5 = bodyBuf ? md5B64(bodyBuf) : '';
  const ctype = bodyBuf ? (contentType ?? 'application/octet-stream') : '';
  const canonical = [method, md5, ctype, date, `/${bucket}/${key}`].join('\n');
  const authorization = `OSS ${cred.accessKeyId}:${hmacSha1(cred.accessKeySecret, canonical)}`;
  const headers = { Date: date, Authorization: authorization, 'Content-Length': bodyBuf ? bodyBuf.length : 0 };
  if (bodyBuf) { headers['Content-MD5'] = md5; headers['Content-Type'] = ctype; }
  return new Promise((resolve) => {
    const req = https.request({ host, path: `/${encodeKey(key)}`, method, headers, timeout: timeoutMs, agent: OSS_AGENT }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, bytes: bodyBuf ? bodyBuf.length : Number(res.headers['content-length'] ?? 0), etag: String(res.headers.etag ?? '').replace(/"/g, ''), body: buf });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('cloud_request_timeout')); });
    req.on('error', (e) => resolve({ status: 0, error: String(e.message), etag: '', bytes: 0, body: Buffer.alloc(0) }));
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

/** 生成短效只读签名 URL（默认 900 秒）。私有桶下前端可直接给 <video src> 用。 */
export function presignedGetUrl({ key, expiresInSeconds = 900, bucket = DEFAULT_BUCKET, region = DEFAULT_REGION, credential = null } = {}) {
  if (!key) throw new Error('presign_requires_key');
  if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0 || expiresInSeconds > 604800) throw new Error('presign_bad_expiry');
  const cred = credential ?? readCredential();
  const expires = Math.floor(Date.now() / 1000) + Math.floor(expiresInSeconds);
  const canonical = ['GET', '', '', String(expires), `/${bucket}/${key}`].join('\n');
  const signature = hmacSha1(cred.accessKeySecret, canonical);
  const qs = `OSSAccessKeyId=${encodeURIComponent(cred.accessKeyId)}&Expires=${expires}&Signature=${encodeURIComponent(signature)}`;
  return { url: `https://${bucket}.${region}.aliyuncs.com/${encodeKey(key)}?${qs}`, expiresAtEpochS: expires, key };
}

export async function headObject(opts) { return signedRequest({ ...opts, method: 'HEAD' }); }
export async function putObject({ buf, ...opts }) { return signedRequest({ ...opts, method: 'PUT', bodyBuf: buf }); }
export async function deleteObject(opts) { return signedRequest({ ...opts, method: 'DELETE' }); }

/** 简易列举（最多 1000 个键；本项目单前缀用量远小于此）。返回 { keys: [{key,size,etag,lastModified}] }。 */
export async function listObjects({ prefix = '', bucket = DEFAULT_BUCKET, region = DEFAULT_REGION, credential = null, maxKeys = 1000, continuationToken = null } = {}) {
  const cred = credential ?? readCredential();
  const host = ossHostFor(bucket, region);
  const n = Math.min(Math.max(maxKeys, 1), 1000);
  const params = [['list-type', '2'], ['max-keys', String(n)]];
  if (prefix) params.push(['prefix', prefix]);
  if (continuationToken) params.push(['continuation-token', continuationToken]);
  const qs = params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  // 为什么这样签名（2026-10-14 实测定位）：OSS v1 签名对 V2 列举的子资源要求**只认 `continuation-token`**——
  // 首页把 `list-type/max-keys/prefix` 拼进 CanonicalizedResource ⇒ 403 SignatureDoesNotMatch（服务端回显的
  // StringToSign 是 `/bucket/`）；翻页时不带 `continuation-token` ⇒ 同样 403，服务端回显 `/bucket/?continuation-token=<token>`。
  // 因此：CanonicalizedResource ＝ `/{bucket}/` ＋（翻页时）`?continuation-token=<原值>`（不做 URL 编码）。
  const canon = continuationToken ? `/${bucket}/?continuation-token=${continuationToken}` : `/${bucket}/`;
  const date = new Date().toUTCString();
  const doList = (canonical) => new Promise((resolve) => {
    // 注意：签名串必须是完整的 StringToSign（方法/空行/空行/Date/资源），只签资源部分是 403 SignatureDoesNotMatch
    // —— 这是 2026-10-14 重构时的真实回归，由"首页 200 / 翻页 403"的对照实验定位。
    const sig = hmacSha1(cred.accessKeySecret, ['GET', '', '', date, canonical].join('\n'));
    const headers = { Date: date, Authorization: `OSS ${cred.accessKeyId}:${sig}` };
    const req = https.request({ host, path: `/?${qs}`, method: 'GET', headers, timeout: 60000 }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const xml = Buffer.concat(chunks).toString('utf8');
        const keys = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((m) => {
          const seg = m[1];
          const pick = (t) => { const r = new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(seg); return r ? r[1] : null; };
          return { key: pick('Key'), size: Number(pick('Size')), etag: String(pick('ETag') ?? '').replace(/&quot;|"/g, ''), lastModified: pick('LastModified') };
        });
        const nextTok = (/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml) || [])[1] ?? null;
        const errCode = (/<Code>([\s\S]*?)<\/Code>/.exec(xml) || [])[1] ?? null;
        resolve({ status: res.statusCode, count: keys.length, keys, truncated: /<IsTruncated>true<\/IsTruncated>/.test(xml), nextToken: nextTok, errCode, bodySample: res.statusCode === 200 ? null : xml.slice(0, 400) });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('cloud_list_timeout')); });
    req.on('error', (e) => resolve({ status: 0, count: 0, keys: [], error: String(e.message) }));
    req.end();
  });
  return doList(canon);
}

/** 取对象为 Buffer（备份取回演练用；大文件请改用 streamGetObject）。 */
export async function getObjectBuffer(opts) {
  const r = await signedRequest({ ...opts, method: 'GET' });
  return { status: r.status, etag: r.etag, bytes: r.body };
}

/**
 * 带回源流式的 GET（供面板做"云端中转"用）。
 * 为什么需要：本机浏览器直连 `oss-cn-hongkong` 实测被网络层关闭连接（`ERR_CONNECTION_CLOSED`，Node 侧同一签名 URL 正常 206），
 * 所以面板必须能**自己把字节中转到 127.0.0.1**，否则"本机没有文件"时播放链路在浏览器里根本走不通。
 * 只透传必要的响应头；支持 Range（拖动进度条必需），让上游自己决定 200/206。
 */
export function streamGetObject({ key, range = null, bucket = DEFAULT_BUCKET, region = DEFAULT_REGION, credential = null } = {}) {
  const cred = credential ?? readCredential();
  const host = ossHostFor(bucket, region);
  const date = new Date().toUTCString();
  const canonical = ['GET', '', '', date, `/${bucket}/${key}`].join('\n');
  const headers = { Date: date, Authorization: `OSS ${cred.accessKeyId}:${hmacSha1(cred.accessKeySecret, canonical)}` };
  if (range) headers.Range = range;
  return new Promise((resolve) => {
    const req = https.request({ host, path: `/${encodeKey(key)}`, method: 'GET', headers, timeout: 120000, agent: OSS_AGENT }, (upstream) => resolve({ status: upstream.statusCode, headers: upstream.headers, stream: upstream }));
    req.on('timeout', () => { req.destroy(new Error('cloud_stream_timeout')); });
    req.on('error', (e) => resolve({ status: 0, headers: {}, stream: null, error: String(e.message) }));
    req.end();
  });
}
