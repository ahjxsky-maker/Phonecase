// tools/material-library/media.mjs
// R4 STEP4 → R5 STEP4：既有媒体的**可操作本地点播/定位入口**（只读、回环）。
//
// R4 只做到「按身份取字节 + 时间引用 JSON」，R5 复审指出：那**不是**可操作的播放/定位入口，
// 而且「起一个随机端口做一次字节自检再关掉」不能算交付的观看服务。本模块因此补上：
//   ① `/viewer?asset=<id>&t=<sec>` —— 最小可播放页面（<video> + 非零起始定位）
//   ② 资产字节支持 **HTTP Range（206）**，浏览器才能 seek
//   ③ host/端口/发布地址/进程生命周期**显式**（listen() 返回 publicBaseUrl；由 `cli media --serve` 长驻）
//   ④ 记录→asset→segment→URL 的身份连续性可测（view_path 落在记录里）
// 边界：只读、只绑 127.0.0.1、不下载、不转码、不做公网监听；**不**证明 Baserow UI 播放。
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

export const MEDIA_ADAPTER_VERSION = 'material-library-media-loopback/1.1.0';

const MIME = {
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mkv': 'video/x-matroska', '.m4v': 'video/x-m4v', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
};

/** 由真实记录构造只读索引：asset_id -> { path, bytes, sha256, kind, segments }。 */
export function createMediaIndex(records = []) {
  const byId = new Map();
  const refs = [];
  for (const r of records) {
    for (const a of r.assets ?? []) {
      if (!byId.has(a.asset_id)) {
        byId.set(a.asset_id, {
          asset_id: a.asset_id, entity_key: r.entity_key, cohort: a.cohort,
          local_path: a.local_path ?? null, media_kind: a.media_kind ?? 'unknown',
          usable_as_video: a.usable_as_video === true, bytes: a.bytes ?? null,
          sha256: a.sha256 ?? null, sha256_match: a.sha256_match === true,
          verified_present_locally: a.verified_present_locally === true,
          kind_reject_reason: a.kind_reject_reason ?? null,
          segments: (a.segments ?? []).map((s) => ({
            segment_id: s.segment_id, index: s.index, t_label: s.t_label, start_seconds: s.start_seconds,
            kind: s.kind, fact_origin: s.fact_origin, origin_card: s.origin_card, coverage: s.coverage,
            view_path: `/viewer?asset=${encodeURIComponent(a.asset_id)}&t=${s.start_seconds ?? 0}`,
          })),
        });
      }
      refs.push({ entity_key: r.entity_key, asset_id: a.asset_id });
    }
  }
  return { byId, refs };
}

/** 记录里的相对路由 → 绝对地址（同一路由，端口由实际监听决定）。 */
export function absoluteViewUrl(baseUrl, viewPath) {
  if (!viewPath) return null;
  return `${String(baseUrl).replace(/\/+$/, '')}${viewPath.startsWith('/') ? '' : '/'}${viewPath}`;
}

export function renderViewerHtml({ assetId, startSeconds = 0, asset = null, baseUrl = '' }) {
  const safeId = String(assetId).replace(/[^A-Za-z0-9._-]/g, '');
  const t = Number.isFinite(Number(startSeconds)) ? Number(startSeconds) : 0;
  const src = `/media/asset/${encodeURIComponent(assetId)}#t=${t}`;
  const segs = (asset?.segments ?? []).map((s) => `<li><a href="/viewer?asset=${encodeURIComponent(assetId)}&t=${s.start_seconds ?? 0}">${s.t_label ?? s.start_seconds}s</a> — ${s.kind ?? ''} ${s.origin_card ?? ''}</li>`).join('');
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>媒体查看 ${safeId}</title></head>
<body data-asset-id="${safeId}" data-start-seconds="${t}">
<h1>本地媒体查看（只读回环）</h1>
<p>asset_id=<code>${assetId}</code>；请求的定位起点 <strong id="requested-start">${t}</strong> 秒。</p>
<video id="player" src="${src}" controls preload="metadata" width="640" muted></video>
<p>缺失/不可播放时页面会显式说明；本入口不下载、不转码，也不代表 Baserow UI 内的播放。</p>
<h2>既有片段时间点</h2><ol>${segs}</ol>
<p>基础地址：<code>${baseUrl}</code>；路由：<code>/viewer?asset=&lt;asset_id&gt;&amp;t=&lt;seconds&gt;</code></p>
<script>
  // 请求的定位起点：浏览器用 #t= 片段跳转；这里把实际 currentTime 暴露出来便于核验。
  const v = document.getElementById('player');
  window.__mlPlayerState = () => ({ currentTime: v.currentTime, duration: v.duration, readyState: v.readyState, paused: v.paused, networkState: v.networkState, error: v.error ? v.error.code : null });
</script>
</body></html>`;
}

function sha256File(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? '').trim());
  if (!m) return null;
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  let start = a === '' ? Math.max(0, size - Number(b)) : Number(a);
  let end = a === '' || b === '' ? size - 1 : Number(b);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return { unsatisfiable: true };
  end = Math.min(end, size - 1);
  return { start, end };
}

/**
 * 只读 loopback 适配器。host 固定 127.0.0.1；`listen()` 返回**实际**端口与发布地址，
 * 进程生命周期由调用方决定（`cli media --serve` 长驻，按键/结束进程停止）。
 */
export function createMediaServer({ index, host = '127.0.0.1', port = 0, log = () => {} } = {}) {
  if (host !== '127.0.0.1' && host !== 'localhost') throw new Error('media_adapter_is_loopback_only');
  let boundPort = null;
  const server = http.createServer((req, res) => {
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj, null, 2)); };
    let url;
    try { url = new URL(req.url, `http://${host}`); } catch { return json(400, { error: 'bad_request' }); }
    const baseUrl = `http://${host}:${boundPort ?? port}`;

    if (url.pathname === '/' || url.pathname === '/viewer') {
      const assetId = url.searchParams.get('asset');
      const t = Number(url.searchParams.get('t') ?? 0);
      if (!assetId) return json(400, { error: 'viewer_requires_asset', route: '/viewer?asset=<asset_id>&t=<seconds>' });
      const asset = index.byId.get(assetId);
      if (!asset) return json(404, { error: 'asset_not_found', asset_id: assetId });
      if (asset.usable_as_video !== true) {
        return json(415, { error: 'asset_kind_not_video', asset_id: assetId, media_kind: asset.media_kind, kind_reject_reason: asset.kind_reject_reason });
      }
      if (asset.local_path && !fs.existsSync(asset.local_path)) {
        return json(410, { error: 'asset_file_missing', asset_id: assetId, note: '记录存在但本地文件不可读 → 显式缺失，不用占位内容冒充。' });
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(renderViewerHtml({ assetId, startSeconds: t, asset, baseUrl }));
    }

    if (url.pathname === '/media/index.json') {
      return json(200, {
        adapter: MEDIA_ADAPTER_VERSION, base_url: baseUrl,
        viewer_route: '/viewer?asset=<asset_id>&t=<seconds>',
        note: '只读 loopback 适配器：点播入口 + 片段定位；不证明 Baserow UI 播放，也不下载/转码。',
        assets: [...index.byId.values()].map((a) => ({
          asset_id: a.asset_id, entity_key: a.entity_key, media_kind: a.media_kind,
          usable_as_video: a.usable_as_video, bytes: a.bytes, sha256: a.sha256,
          verified_present_locally: a.verified_present_locally,
          url: `/media/asset/${encodeURIComponent(a.asset_id)}`,
          view_path: `/viewer?asset=${encodeURIComponent(a.asset_id)}`,
          segments: a.segments.length,
        })),
      });
    }

    const m = /^\/media\/asset\/([^/]+)(?:\/segment\/(\d+))?$/.exec(url.pathname);
    if (!m) return json(404, { error: 'not_found', path: url.pathname });
    const assetId = decodeURIComponent(m[1]);
    const asset = index.byId.get(assetId);
    if (!asset) return json(404, { error: 'asset_not_found', asset_id: assetId });
    if (m[2] !== undefined) {
      const seg = asset.segments.find((s) => String(s.index) === m[2]);
      if (!seg) return json(404, { error: 'segment_not_found', asset_id: assetId, index: Number(m[2]) });
      return json(200, {
        asset_id: assetId, segment: seg,
        asset_url: `/media/asset/${encodeURIComponent(assetId)}`,
        view_url: absoluteViewUrl(baseUrl, seg.view_path),
        note: '时间引用来自既有分析卡（稀疏抽样）；本响应不证明该时刻可播放或已人工复核。',
      });
    }
    if (!asset.local_path) return json(409, { error: 'asset_has_no_local_path', asset_id: assetId });
    if (asset.usable_as_video !== true && url.searchParams.get('as') === 'video') {
      return json(415, { error: 'asset_kind_not_video', asset_id: assetId, media_kind: asset.media_kind, kind_reject_reason: asset.kind_reject_reason });
    }
    let stat;
    try { stat = fs.statSync(asset.local_path); } catch { return json(410, { error: 'asset_file_missing', asset_id: assetId, note: '记录存在但本地文件不可读 → 显式缺失，不用占位内容冒充。' }); }
    if (!stat.isFile()) return json(410, { error: 'asset_path_not_a_file', asset_id: assetId });
    const ext = path.extname(asset.local_path).toLowerCase();
    const mime = MIME[ext] ?? 'application/octet-stream';
    const headers = {
      'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
      'X-Material-Library-Asset-Id': asset.asset_id, 'X-Material-Library-Bytes': String(stat.size),
    };
    const range = parseRange(req.headers.range, stat.size);
    if (range?.unsatisfiable) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
    if (range) {
      const len = range.end - range.start + 1;
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`, 'Content-Length': String(len) });
      const stream = fs.createReadStream(asset.local_path, { start: range.start, end: range.end });
      stream.on('error', () => { try { res.destroy(); } catch { /* 已断开 */ } });
      return stream.pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': String(stat.size) });
    const stream = fs.createReadStream(asset.local_path);
    stream.on('error', () => { try { res.destroy(); } catch { /* 已断开 */ } });
    stream.pipe(res);
  });
  return {
    server,
    host,
    get port() { return boundPort ?? port; },
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      boundPort = server.address().port;
      const baseUrl = `http://${host}:${boundPort}`;
      log(`media adapter listening on ${baseUrl} (loopback only; viewer ${baseUrl}/viewer?asset=<asset_id>&t=<seconds>)`);
      return { url: baseUrl, port: boundPort, host, viewer_route: '/viewer?asset=<asset_id>&t=<seconds>' };
    },
    async close() { await new Promise((resolve) => server.close(resolve)); },
  };
}

/**
 * 「实际播放消费者」检查：走 `/viewer` 页面（而不是只看字节），核对
 * ① 记录里的 view_path 能解析成真实页面 ② 页面嵌的是**同一个 asset** ③ 非零起点被页面与片段跳转携带
 * ④ 资产支持 Range(206)（浏览器 seek 的前提） ⑤ 缺文件显式 410。
 * 明确边界：这是**播放入口的 HTTP 级**证据；真实播放/seek 观测量见 report 的浏览器核验段落。
 */
export async function playerCheck({ baseUrl, assetId, startSeconds = 0, fetchImpl = globalThis.fetch } = {}) {
  const out = { check: 'viewer_entry', base_url: baseUrl, asset_id: assetId, requested_start_seconds: startSeconds, checks: [], ok: false };
  const add = (name, ok, detail) => { out.checks.push({ name, ok, detail }); return ok; };
  const viewPath = `/viewer?asset=${encodeURIComponent(assetId)}&t=${startSeconds}`;
  const res = await fetchImpl(`${baseUrl}${viewPath}`);
  const html = await res.text();
  add('viewer_route_serves_html', res.status === 200 && /text\/html/.test(res.headers.get('content-type') ?? ''), { status: res.status });
  add('viewer_identity_matches_asset', html.includes(`data-asset-id="${String(assetId).replace(/[^A-Za-z0-9._-]/g, '')}"`), { asset_id: assetId });
  add('viewer_carries_nonzero_start', html.includes(`data-start-seconds="${startSeconds}"`) && html.includes(`#t=${startSeconds}`), { start_seconds: startSeconds });
  add('viewer_embeds_same_asset_route', html.includes(`/media/asset/${encodeURIComponent(assetId)}`), { route: `/media/asset/${assetId}` });
  const rangeRes = await fetchImpl(`${baseUrl}/media/asset/${encodeURIComponent(assetId)}`, { headers: { Range: 'bytes=0-1023' } });
  add('asset_supports_byte_range_for_seek', rangeRes.status === 206 && /^bytes 0-/.test(rangeRes.headers.get('content-range') ?? ''), { status: rangeRes.status, content_range: rangeRes.headers.get('content-range') });
  out.ok = out.checks.every((c) => c.ok);
  return out;
}

/** 自检（真实 HTTP 回环请求）：索引、字节、sha256、缺失、类型拒绝、Range、viewer 身份。 */
export async function verifyMediaRoute({ url, index, fetchImpl = globalThis.fetch } = {}) {
  const out = { adapter: MEDIA_ADAPTER_VERSION, base_url: url, checks: [], ok: false, note: '只读回环自检；不证明 Baserow 原生文件字段可用，也不等于浏览器内播放观测量。' };
  const check = (name, ok, detail) => { out.checks.push({ name, ok, detail }); return ok; };
  const idxRes = await fetchImpl(`${url}/media/index.json`);
  const idx = await idxRes.json();
  const listed = idx.assets ?? [];
  check('index_lists_assets', listed.length === index.byId.size, { listed: listed.length, indexed: index.byId.size });
  check('index_publishes_base_and_viewer_route', idx.base_url === url && /\/viewer\?asset=/.test(idx.viewer_route ?? ''), { base_url: idx.base_url, route: idx.viewer_route });

  let byteOk = 0, byteFail = [], rangeOk = 0;
  for (const a of index.byId.values()) {
    if (!a.local_path || !fs.existsSync(a.local_path) || a.usable_as_video !== true) continue;
    const res = await fetchImpl(`${url}/media/asset/${encodeURIComponent(a.asset_id)}`);
    if (res.status !== 200) { byteFail.push(`${a.asset_id}:http_${res.status}`); continue; }
    const buf = Buffer.from(await res.arrayBuffer());
    const actual = crypto.createHash('sha256').update(buf).digest('hex');
    if (a.sha256 && actual !== a.sha256) { byteFail.push(`${a.asset_id}:sha256_mismatch`); continue; }
    byteOk++;
    const r = await fetchImpl(`${url}/media/asset/${encodeURIComponent(a.asset_id)}`, { headers: { Range: 'bytes=0-1023' } });
    if (r.status === 206) rangeOk++;
  }
  check('served_bytes_match_recorded_sha256', byteFail.length === 0, { matched: byteOk, failed: byteFail });
  check('assets_support_range_requests', byteOk === 0 || rangeOk === byteOk, { range_ok: rangeOk, checked: byteOk });

  const missing = await fetchImpl(`${url}/media/asset/does-not-exist`);
  check('unknown_asset_is_explicit_404', missing.status === 404, { status: missing.status });

  const nonVideo = [...index.byId.values()].find((a) => a.usable_as_video !== true);
  if (nonVideo) {
    const r = await fetchImpl(`${url}/media/asset/${encodeURIComponent(nonVideo.asset_id)}?as=video`);
    check('non_video_cannot_be_served_as_video', r.status === 415, { status: r.status, asset_id: nonVideo.asset_id });
  }
  const withSeg = [...index.byId.values()].find((a) => a.segments.length > 0 && a.usable_as_video === true);
  if (withSeg) {
    // R5：定位必须用**非零**起点验证（首个片段常为 0 秒，用它会得出无意义的“通过”）
    const nonzero = withSeg.segments.find((s) => Number(s.start_seconds) > 0) ?? withSeg.segments[0];
    const r = await fetchImpl(`${url}/media/asset/${encodeURIComponent(withSeg.asset_id)}/segment/${nonzero.index}`);
    const body = await r.json();
    check('segment_time_reference_is_available', r.status === 200 && typeof body.segment?.start_seconds === 'number', { asset_id: withSeg.asset_id, start_seconds: body.segment?.start_seconds });
    out.player = await playerCheck({ baseUrl: url, assetId: withSeg.asset_id, startSeconds: nonzero.start_seconds ?? 0, fetchImpl });
    check('viewer_entry_is_operable', out.player.ok, { checks: out.player.checks.map((c) => `${c.name}:${c.ok}`) });
    check('seek_start_is_nonzero', Number(nonzero.start_seconds) > 0, { asset_id: withSeg.asset_id, start_seconds: nonzero.start_seconds });
  }
  out.ok = out.checks.every((c) => c.ok);
  return out;
}
