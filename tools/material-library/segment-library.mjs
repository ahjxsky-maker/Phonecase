/**
 * M3 素材中心（九个入口）＋ 片段→来源溯源。
 *
 * 判据（工程单原文要点）：
 *   MP-06 片段可按**已批准的结构职能**与**有证据支撑的复用用途**被发现；**多个用途不得复制来源身份**；
 *         计数单位必须写明；九个入口中**缺证据的要有诚实空状态**；**互动计数不得造出评论/优惠/音乐内容**。
 *   MP-07 每个片段可回溯到**来源视频身份、时间范围、留存文本**；有本地可播放素材的可 seek；
 *         **不可用媒体永远不显示为可播放**；失效/未采集/未知要能区分；不承诺外链永久可用。
 *
 * 设计要点（都是为判据服务的）：
 *   * 计数**逐入口声明单位**（segments / materials），不混用。
 *   * 无留存证据的入口返回 `empty_state`（带可核原因），**不返回编造条目**。
 *   * 一个片段可同时属于多个用途，但**返回的是同一个 segment_id 与同一份来源身份**（不复制、不改写）。
 *   * `availability` 三态区分：`locally_playable` / `no_local_media` / `unknown`。
 *     `seek_url` 仅在真正本地可播放时才给；没有本地文件时**给 null**，前端不可能据此显示成可播放。
 */

import fs from 'node:fs';

export const STRUCTURE_ROLES = ['HOOK', 'pain', 'scene', 'proof', 'CTA', 'insufficient_evidence'];

/**
 * 九个入口。`roles` 为 null 表示"按素材而非按职能"。
 * `evidence` 说明该入口凭什么算"有证据"；无证据的写 `empty_state`。
 */
export const LIBRARY_ENTRIES = [
  {
    id: 'all', name: '全部素材', unit: 'materials', roles: null,
    includes: '库内可浏览范围内的全部素材；片段视图列出有分段的全部片段',
    excludes: '不在浏览范围的缺口素材（见「缺口」入口）',
    evidence: '直接来自库内素材与片段表',
  },
  {
    id: 'hooks', name: '开场钩子', unit: 'segments', roles: ['HOOK'],
    includes: 'AI 职能＝HOOK 的片段',
    excludes: '其他职能片段',
    evidence: 'AI 依据该片段自身留存文本判定，且可由人工修正（人工决定优先展示）',
  },
  {
    id: 'pain_need_scene', name: '痛点 · 需求 · 场景', unit: 'segments', roles: ['pain', 'scene'],
    includes: 'AI 职能＝pain 或 scene 的片段',
    excludes: '其他职能片段',
    evidence: '同上',
  },
  {
    id: 'notable_comments', name: '值得注意的评论', unit: 'segments', roles: [],
    includes: '需要**评论正文**作为证据',
    excludes: '仅有的平台公开评论计数**不是**评论内容',
    empty_state: {
      reason: 'no_comment_content_retained',
      detail: '库里只有平台公开的**评论计数**（metrics.engagement_comment 的 value_text 就是计数本身，长度 1–5 字符），'
        + '**没有任何一处留存评论正文**（全库无评论表）。按 MP-06，互动计数不得用来造出评论内容，因此本入口如实为空；'
        + '要填充它必须先获得授权去采集评论内容。',
    },
  },
  {
    id: 'selling_point_imagery', name: '卖点画面', unit: 'segments', roles: null,
    claimMarkers: ['10X', 'Impact', 'Corning', '®', 'Scratch', 'Protect', 'Anti', 'Drop', 'Armor', 'UltraFit', '抗', '防', '材质', '玻璃', '涂层'],
    includes: '**片段自身留存文本**里出现产品宣称/规格痕迹的片段（数字+单位、商标符、材质或防护类词）',
    excludes: '素材级复用标签（value_labels_json 的 creative_reference / performance_reference）**不是**片段级卖点证据；'
      + '本入口只说明"来源画面/字幕里出现了卖点宣称"，**不**证明该宣称本身为真',
    evidence: '按上方 claimMarkers 对**该片段自己的** onscreen_text / observed 作关键词匹配，命中词原样返回供人工核对（是检索辅助，不是判断）',
  },
  {
    id: 'social_proof', name: '社会证明', unit: 'segments', roles: [],
    includes: '需要"他人认可/销量/口碑"类的**留存内容**证据',
    excludes: 'proof（证据/实测）**不等于**社会证明；平台计数与影响力数字也不构成社会证明内容',
    empty_state: {
      reason: 'no_social_proof_content',
      detail: '库内没有留存评价、销量、口碑类正文；互动计数不能当社会证明内容。如实为空。',
    },
  },
  {
    id: 'offers', name: '优惠', unit: 'segments', roles: [],
    includes: '需要**优惠/折扣/促销**的留存内容（画面文字或口播）',
    excludes: '互动计数不得造出优惠内容',
    empty_state: {
      reason: 'no_offer_content',
      detail: '库内留存文本中没有出现优惠/折扣/促销类内容。如实为空。',
    },
  },
  {
    id: 'cta', name: 'CTA', unit: 'segments', roles: ['CTA'],
    includes: 'AI 职能＝CTA 的片段',
    excludes: '无 CTA 的片段',
    evidence: 'AI 依据该片段自身留存文本判定；本轮七条素材实测 CTA 为 0（讲解/测评型，不硬凑五段）',
  },
  {
    id: 'bgm_emotion', name: 'BGM · 情绪', unit: 'segments', roles: [],
    includes: '需要**音频/BGM/情绪**的留存证据',
    excludes: '互动计数不得造出音乐内容',
    empty_state: {
      reason: 'no_audio_or_music_evidence',
      detail: '库内没有留存 BGM、曲目或音乐情绪标注（只有语音转写文本，不含音乐信息）。如实为空；'
        + '要填充需要新的采集或音频分析授权。',
    },
  },
];

export const ENTRY_BY_ID = new Map(LIBRARY_ENTRIES.map((e) => [e.id, e]));

/** 素材级计数（单位＝materials）：库内可浏览 + 全库行数 */
function materialCounts(db, browseTiers) {
  const placeholders = browseTiers.map(() => '?').join(',');
  const browseable = db.prepare(`SELECT COUNT(*) n FROM materials WHERE value_tier IN (${placeholders})`).get(...browseTiers).n;
  const all = db.prepare('SELECT COUNT(*) n FROM materials').get().n;
  const withSegments = db.prepare('SELECT COUNT(DISTINCT entity_key) n FROM segments').get().n;
  const playable = db.prepare('SELECT COUNT(DISTINCT entity_key) n FROM assets WHERE usable_as_video = 1').get().n;
  return { browseable, all_rows: all, with_segments: withSegments, with_local_video: playable };
}

/**
 * 某个入口的片段集合（同一 segment_id 只会出现一次；跨入口复用同一身份）。
 *
 * MP-06「标签变化后检索与计数仍然一致」要有牙齿，就必须让**人工决定影响检索**：
 * 生效职能＝`COALESCE(human_role, ai_role)`（人工决定优先，AI 建议兜底）。
 * 这样操作者把某段改成 CTA 之后，它会真的从「开场钩子」移到「CTA」，计数同步变化；
 * 同时两个角色都照原样返回（`ai_role` / `human_role` / `effective_role`），
 * **不隐藏、不合并**——MP-05「AI 建议不自动成为人工通过」仍然成立。
 */
function segmentsForRole(db, roles) {
  if (!roles || !roles.length) return [];
  const ph = roles.map(() => '?').join(',');
  return db.prepare(`
    SELECT s.entity_key, s.segment_id, s.start_seconds, s.end_seconds, s.t_label, s.coverage,
           s.observed, s.onscreen_text, s.speech,
           COALESCE(l.ai_role, '(未标注)') AS ai_role, l.ai_role_reason,
           l.human_role,
           COALESCE(l.human_role, l.ai_role, '(未标注)') AS effective_role
    FROM segments s
    LEFT JOIN segment_labels l ON l.entity_key = s.entity_key AND l.segment_id = s.segment_id
    WHERE COALESCE(l.human_role, l.ai_role, '') IN (${ph})
    ORDER BY s.entity_key, COALESCE(s.start_seconds, 0)`).all(...roles);
}

/** 素材级"这个素材用哪个资产、算不算可播"的**唯一规则**（来源解析 / 结构中心 / 候选 / 路由 / 详情共用） */
export function assetRowsOf(db, entityKey) {
  return db.prepare(`SELECT asset_id, entity_key, local_path, usable_as_video, bytes, sha256, cloud_state, cloud_key, cloud_bytes
    FROM assets WHERE entity_key = ? ORDER BY asset_id`).all(entityKey);
}
/**
 * ★ 第 62 轮复核 F62-02（高）：资格判定必须**只有一处实现**，否则路由/详情/前端会各判各的
 *   （复核方实测：来源判"不可播"而云路由守卫仍放行空白 key / 零字节的资产）。
 *   `qualificationOf()` 是这一处的唯一实现，返回逐项事实与结论，供所有调用方消费。
 */
export function qualificationOf(asset) {
  const isVideo = Number(asset?.usable_as_video) === 1;
  const state = String(asset?.cloud_state ?? '').trim().toLowerCase();
  const key = String(asset?.cloud_key ?? '').trim();
  const bytes = Number(asset?.cloud_bytes ?? 0);
  // F62-02：空白 key / 零字节**不算**云上可用（此前路由只看 "非空字符串" 与 state，零字节也放行）。
  const cloudReady = isVideo && state === 'uploaded' && key !== '' && Number.isFinite(bytes) && bytes > 0;
  const localPath = String(asset?.local_path ?? '').trim();
  let localFile = false;
  if (isVideo && localPath !== '') {
    try { localFile = fs.statSync(localPath).isFile(); } catch { localFile = false; } // F62-04：目录不能算可播文件
  }
  return {
    is_video: isVideo, cloud_ready: cloudReady, local_file: localFile, local_path: localPath || null,
    cloud_state: asset?.cloud_state ?? null, cloud_bytes: asset?.cloud_bytes ?? null,
    playable: cloudReady || localFile,
    delivery: cloudReady ? 'cloud_relay' : (localFile ? 'local_file' : null),
    media_url: cloudReady ? `/api/cloud-media?asset=${encodeURIComponent(asset?.asset_id ?? '')}`
      : localFile ? `/media/asset/${encodeURIComponent(asset?.asset_id ?? '')}` : null,
    cloud_unready_reason: cloudReady ? null
      : (!isVideo ? 'asset_not_video' : state !== 'uploaded' ? 'cloud_state_not_uploaded' : key === '' ? 'cloud_key_blank' : 'cloud_bytes_not_positive'),
  };
}
/** 云上登记可用＝`qualificationOf()` 的 `cloud_ready`（保留旧函数名供既有调用方使用） */
export function isCloudReady(a) { return qualificationOf(a).cloud_ready; }
/** 本机文件真实存在且**是普通文件**（只看标记不看文件是 M3-F03 的老毛病；目录也不算） */
export function hasLocalFile(a) { return qualificationOf(a).local_file; }
/**
 * ★ 第 61 轮 F61-02：来源解析只取一行、结构中心扫全部 ⇒ 同一素材多资产时结论会相反；现在共用本函数。
 * ★ 第 62 轮 F62-03（高）：光共用还不够——**选择必须有稳定排序**，否则两条都合格的资产会因调用方
 *   排序不同而选出不同一条（复核方实测：来源按 asset_id 排序、结构中心不排序 ⇒ 选出不同资产）。
 *   排序规则写进函数本身：先按资格（云可用 > 本地文件 > 标为视频 > 其它），同档按 `asset_id` 升序。
 */
export function pickAsset(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const rank = (a) => {
    const q = qualificationOf(a);
    if (q.cloud_ready) return 0;
    if (q.local_file) return 1;
    if (q.is_video) return 2;
    return 3;
  };
  return [...list]
    // ★ 第 63 轮 F63-03（高）：`localeCompare()` 对不同 Unicode 规范形式的同一名字可能返回 0
    //   （实测 `é`(U+00E9) 与 `e\u0301`(U+0065 U+0301) 比较为 0）⇒ 仍会退回输入顺序、选择分叉。
    //   这里改用**码元全序**（`<`/`>` 比较），保证任意输入顺序都得到同一个结论。
    .sort((x, y) => {
      const dr = rank(x) - rank(y);
      if (dr !== 0) return dr;
      const a = String(x?.asset_id ?? ''); const b = String(y?.asset_id ?? '');
      return a < b ? -1 : a > b ? 1 : 0;
    })[0] ?? null;
}

/** 片段的来源身份与可用性（MP-07） */
export function sourceOf(db, entityKey, segmentId, mediaBase) {
  const mat = db.prepare(`SELECT entity_key, platform, namespace, native_id, title, canonical_url,
      product_category, product_function, scene_or_need, retained_path, review_status
    FROM materials WHERE entity_key = ?`).get(entityKey) ?? {};
  const seg = db.prepare('SELECT start_seconds, end_seconds FROM segments WHERE entity_key = ? AND segment_id = ?').get(entityKey, segmentId) ?? {};
  const rows = assetRowsOf(db, entityKey);
  const asset = pickAsset(rows);
  // M3-F03（独立复审，高）：可播放判断**不能只看库里的标记与非空路径**——必须核实文件真的存在。
  // ★ 第 62 轮 F62-02：这里**不再自己判**，一律消费 `qualificationOf()`（唯一实现），与面板两条路由同源同规则。
  const q = qualificationOf(asset);
  const rawPath = q.local_path ?? '';
  const declaredLocal = Boolean(asset && Number(asset.usable_as_video) === 1 && rawPath);
  const fileExists = q.local_file;
  const hasLocal = q.local_file;
  const cloudReady = q.cloud_ready;
  const start = seg.start_seconds;
  // MP-07：几种"不能用"要能区分——未采集到媒体 / 有记录但文件已不在 / 只有记录但标记为不可播放；云中转可播另记一态。
  const availability = cloudReady ? 'cloud_playable'
    : hasLocal ? 'locally_playable'
      : (declaredLocal && !fileExists) ? 'file_missing'
        : (asset ? 'no_local_media' : 'no_media_record');
  const playableNow = q.playable;
  const id = encodeURIComponent(asset?.asset_id ?? '');
  const localUrl = `/media/asset/${id}`;            // 面板自己提供的本机文件路由（同源，必然与被访问页面同源）
  // 播放地址由资格判定给出（云中转优先），保证"详情页/播放器看到的地址"与"来源判定"是同一份结论（F62-01）。
  const media_url = q.media_url;
  const seek_url = playableNow && start != null ? `${media_url}#t=${Number(start)}` : null;
  return {
    identity: {
      entity_key: entityKey, platform: mat.platform ?? null, namespace: mat.namespace ?? null, native_id: mat.native_id ?? null,
      title: mat.title ?? null, canonical_url: mat.canonical_url ?? null,
      product_category: mat.product_category ?? null, product_function: mat.product_function ?? null, scene_or_need: mat.scene_or_need ?? null,
    },
    time_range: { start_seconds: start ?? null, end_seconds: seg.end_seconds ?? null },
    availability,
    playable: playableNow,
    // 播放地址是怎么来的，必须能一眼看出：云端中转 / 本机文件（两条路由都由本面板同源提供）。
    delivery: q.delivery,
    media_url,
    // 本机文件存在时一并给出同源本地地址，便于"本地比中转快"的场景自取；它**不是**可播性的依据。
    media_url_local: hasLocal ? localUrl : null,
    seek_url,
    // 云上登记不可用时给出**具体原因**，供路由/详情/前端共用同一解释（F62-02）。
    cloud_unready_reason: q.cloud_unready_reason,
    asset: asset ? { asset_id: asset.asset_id, local_path: hasLocal ? rawPath : null, declared_local_path: rawPath || null, file_exists: fileExists, usable_as_video: Number(asset.usable_as_video) === 1, bytes: asset.bytes ?? null, sha256: asset.sha256 ?? null, cloud_state: asset.cloud_state ?? null, cloud_bytes: asset.cloud_bytes ?? null, asset_count: rows.length, selected: true } : null,
    external_link_policy: '本面板不承诺站外链接长期可用。能定位到秒的前提是：该素材标为视频，且**要么**云端有可取数对象（同源 `/api/cloud-media` 按 Range 中转），**要么**本机文件真实存在（同源 `/media/asset/<id>` 按 Range 流式返回）。两者都不成立时 `media_url`/`seek_url` 一律为 null。',
  };
}

/** 九个入口的清单：逐入口给出**单位明确的计数**、纳入/排除规则、以及缺证据时的诚实空状态。 */
export function buildSegmentLibrary(db, { browseTiers = [], mediaBase }) {
  const mc = materialCounts(db, browseTiers.length ? browseTiers : ['__none__']);
  const segTotal = db.prepare('SELECT COUNT(*) n FROM segments').get().n;
  const roleTally = Object.fromEntries(db.prepare(
    "SELECT COALESCE(ai_role,'(未标注)') r, COUNT(*) n FROM segment_labels GROUP BY r").all().map((r) => [r.r, r.n]));
  // 生效职能（人工决定优先）的分布——入口计数按这个口径
  const effectiveTally = Object.fromEntries(db.prepare(
    "SELECT COALESCE(human_role, ai_role, '(未标注)') r, COUNT(*) n FROM segment_labels GROUP BY r").all().map((r) => [r.r, r.n]));

  const entries = LIBRARY_ENTRIES.map((e) => {
    const isAll = e.id === 'all';
    // M3-F01：卖点画面按显式词表统计命中数——不能显示 0 又标成"有证据支撑"。
    const claimHits = e.claimMarkers ? listEntrySegments(db, e.id, { mediaBase, limit: 0 }).count : null;
    const rows = isAll || e.claimMarkers ? [] : segmentsForRole(db, e.roles);
    const count = isAll ? mc.browseable : (claimHits !== null ? claimHits : (e.roles && e.roles.length ? rows.length : 0));
    const empty = e.empty_state ? { ...e.empty_state } : null;
    // 有职能但实测为 0（如 CTA）→ 也是"如实为空"，但原因与"无留存证据"不同，必须区分
    const zeroBecauseNoMatch = !e.empty_state && e.roles && e.roles.length > 0 && count === 0;
    return {
      id: e.id, name: e.name, unit: e.unit, count,
      count_note: isAll
        ? `unit=materials：库内可浏览 ${mc.browseable} 条（全库 ${mc.all_rows} 行，其中 ${mc.with_segments} 条有片段、${mc.with_local_video} 条有本地视频）；本入口的片段视图共 ${segTotal} 个片段`
        : `unit=segments：本入口 ${count} 个片段（全库片段 ${segTotal} 个）`,
      includes: e.includes, excludes: e.excludes,
      evidence_backed: Boolean(e.evidence) && !empty,
      evidence: e.evidence ?? null,
      empty_state: empty,
      zero_reason: zeroBecauseNoMatch
        ? { reason: 'no_segment_matches_this_role', detail: `已按职能检索，库内当前没有 ${JSON.stringify(e.roles)} 的片段（实测 ${count} 条）。这不是缺证据，而是这七条素材本身没有该职能。` }
        : null,
      items_endpoint: `/api/segment-library?entry=${e.id}`,
    };
  });

  return {
    at: new Date().toISOString(),
    unit_policy: '每个入口显式声明 unit：materials＝按素材计数，segments＝按片段计数；两者不混用。',
    identity_policy: '同一片段出现在多个入口时返回**同一个 segment_id 与同一份来源身份**（用途是视图，不是副本）。',
    role_policy: '入口检索按**生效职能**＝COALESCE(human_role, ai_role)：人工决定优先、AI 建议兜底，因此人工改标签后检索与计数会同步变化；'
      + '响应里 ai_role 与 human_role **各自原样返回**，不隐藏、不合并（AI 建议不会自动变成人工通过）。',
    media_policy: '媒体可用性用一个**唯一规则**判定（`qualificationOf()` 是唯一实现，来源解析、结构中心、候选、计划引用与面板两条媒体路由共用 `pickAsset()` 的选择结果）：'
      + '`cloud_playable`（该素材标为视频**且**云端登记可用 ⇒ 面板同源 `/api/cloud-media` 按 Range 中转）、'
      + '`locally_playable`（本机文件真实存在、且**云上未登记可用** ⇒ 面板同源 `/media/asset/<id>` 按 Range 流式返回）、'
      + '`file_missing` / `no_local_media` / `no_media_record`（不可播，`media_url` 与 `seek_url` **一律为 null**）。'
      + '两类都可用时 `availability` 记 `cloud_playable`、`delivery` 记 `cloud_relay`（云中转优先），本机地址另放 `media_url_local`。'
      + '同一素材有多条资产时按**云上登记可用 > 本机文件存在 > 标为视频 > 其它**、同档按 `asset_id` 升序**稳定选中一条**（`pickAsset()` 内建排序）。'
      + '注意：素材列表的 `has_playable_media` 是**声明口径**（库里有视频资产行），与本处的可播判定不是同一件事。',
    counts_basis: { materials: mc, segments_total: segTotal, effective_role_tally: effectiveTally, ai_role_tally: roleTally },
    entries,
  };
}

/** 某入口的片段明细（含来源与 seek） */
export function listEntrySegments(db, entryId, { mediaBase, limit = 200, offset = 0 } = {}) {
  const e = ENTRY_BY_ID.get(entryId);
  if (!e) return null;
  // M3-F01（独立复审，高）：卖点画面**不能硬编码为空**——复审指出片段 `…|7|22.4` 的屏幕文字里
  // 明确留存了 "Accessory Glass by Corning" / "10X Impact Absorption"（标注为产品宣称叠字），
  // 这本身即"来源展示了什么卖点"的证据。改为按**显式词表**对该片段**自己的**留存文本做匹配，
  // 命中词原样返回供人工核对；它只说明"画面/字幕里出现了卖点宣称"，**不**证明宣称本身为真。
  if (e.claimMarkers) {
    const rows = db.prepare(`SELECT s.entity_key, s.segment_id, s.start_seconds, s.end_seconds, s.t_label, s.coverage,
        s.observed, s.onscreen_text, s.speech,
        COALESCE(l.ai_role, '(未标注)') AS ai_role, l.ai_role_reason, l.human_role,
        COALESCE(l.human_role, l.ai_role, '(未标注)') AS effective_role
      FROM segments s
      LEFT JOIN segment_labels l ON l.entity_key = s.entity_key AND l.segment_id = s.segment_id
      ORDER BY s.entity_key, COALESCE(s.start_seconds,0)`).all();
    const hits = [];
    for (const r of rows) {
      const own = [r.onscreen_text, r.observed].map((x) => String(x ?? '')).join('\n');
      const matched = e.claimMarkers.filter((m) => own.includes(m));
      if (matched.length) hits.push({ ...r, matched_claim_markers: matched });
    }
    return {
      entry: e.id, unit: 'segments', count: hits.length,
      basis: `按显式词表匹配**该片段自己的**屏幕文字/画面描述；命中词原样返回供人工核对；不代表宣称本身为真。词表：${e.claimMarkers.join('、')}`,
      items: hits.slice(offset, offset + limit).map((r) => ({ ...toItem(db, r, r.ai_role, mediaBase), matched_claim_markers: r.matched_claim_markers })),
      zero_reason: hits.length === 0 ? { reason: 'no_retained_claim_text', detail: '按上述词表在片段自己的留存文本里没有匹配到卖点宣称痕迹。' } : null,
    };
  }
  if (e.empty_state) {
    return { entry: e.id, unit: e.unit, count: 0, empty_state: e.empty_state, items: [] };
  }
  if (e.id === 'all') {
    // M3-F02（独立复审，高）："全部片段"也必须带上职能列，否则按职能查找会拿到 84 条全 NULL 的结果。
    const rows = db.prepare(`SELECT s.entity_key, s.segment_id, s.start_seconds, s.end_seconds, s.t_label, s.coverage,
        s.observed, s.onscreen_text, s.speech,
        COALESCE(l.ai_role, '(未标注)') AS ai_role, l.ai_role_reason, l.human_role,
        COALESCE(l.human_role, l.ai_role, '(未标注)') AS effective_role
      FROM segments s
      LEFT JOIN segment_labels l ON l.entity_key = s.entity_key AND l.segment_id = s.segment_id
      ORDER BY s.entity_key, COALESCE(s.start_seconds,0) LIMIT ? OFFSET ?`).all(limit, offset);
    return { entry: e.id, unit: 'segments', count: db.prepare('SELECT COUNT(*) n FROM segments').get().n, items: rows.map((r) => toItem(db, r, r.ai_role, mediaBase)), purposes: purposesOf(db, e.id) };
  }
  const rows = segmentsForRole(db, e.roles);
  const page = rows.slice(offset, offset + limit);
  return {
    entry: e.id, unit: 'segments', count: rows.length,
    items: page.map((r) => toItem(db, r, r.ai_role, mediaBase)),
    zero_reason: rows.length === 0 && e.roles.length ? { reason: 'no_segment_matches_this_role', detail: `已按职能检索，当前没有 ${JSON.stringify(e.roles)} 的片段。` } : null,
  };
}

const purposesOf = () => LIBRARY_ENTRIES.filter((x) => !x.empty_state).map((x) => x.id);

/** M3-F02：按**生效职能**列出片段（结构中心的每个职能都指向这里，不再指向"全部片段"）。 */
/**
 * ★ 2026-10-15（第 61 轮复核 F61-04 引出的真实功能缺口）：按职能取片段时**必须能按素材筛**。
 *   此前界面只按职能取前 200 条，于是"刚检索到并人工确认过的素材"很可能不在下拉里，
 *   拍计划时**根本引用不到自己正在看的那条素材**——这正是"从检索到计划引用"始终串不成一条链的根因。
 *   `q`（素材标题 / 平台编号 / entity_key 子串，大小写不敏感）与 `entityKey`（精确）都支持。
 */
export function listSegmentsByRole(db, role, { mediaBase, limit = 500, q = null, entityKey = null } = {}) {
  if (!STRUCTURE_ROLES.includes(role)) return null;
  const where = ['COALESCE(l.human_role, l.ai_role, \'(未标注)\') = ?'];
  const args = [role];
  if (entityKey) { where.push('s.entity_key = ?'); args.push(String(entityKey)); }
  if (q && String(q).trim() !== '') {
    const like = `%${String(q).trim().toLowerCase()}%`;
    where.push(`(LOWER(COALESCE(m.title,'')) LIKE ? OR LOWER(COALESCE(m.native_id,'')) LIKE ? OR LOWER(s.entity_key) LIKE ?)`);
    args.push(like, like, like);
  }
  const rows = db.prepare(`SELECT s.entity_key, s.segment_id, s.start_seconds, s.end_seconds, s.t_label, s.coverage,
      s.observed, s.onscreen_text, s.speech,
      COALESCE(l.ai_role, '(未标注)') AS ai_role, l.ai_role_reason, l.human_role,
      COALESCE(l.human_role, l.ai_role, '(未标注)') AS effective_role,
      m.title AS material_title, m.native_id AS material_native_id, m.platform AS material_platform
    FROM segments s
    LEFT JOIN segment_labels l ON l.entity_key = s.entity_key AND l.segment_id = s.segment_id
    LEFT JOIN materials m ON m.entity_key = s.entity_key
    WHERE ${where.join(' AND ')}
    ORDER BY s.entity_key, COALESCE(s.start_seconds,0)`).all(...args);
  return {
    unit: 'segments', count: rows.length, role,
    query: { q: q ?? null, entity_key: entityKey ?? null, applied: where.length > 1 },
    basis: '按**生效职能**（人工决定优先、AI 兜底）过滤；`q` 按素材标题/平台编号/entity_key 子串筛选；ai_role 与 human_role 各列原样返回。',
    items: rows.slice(0, limit).map((r) => toItem(db, r, r.ai_role, mediaBase)),
  };
}

/**
 * M3 结构中心：以**已批准的五段职能**为中心的浏览视图（素材中心是按"复用用途"，结构中心是按"叙事职能"）。
 *
 * 与素材中心**同一套口径**：
 *   * 生效职能＝`COALESCE(human_role, ai_role)`（人工决定优先），所以改标签后这里的计数同样会变；
 *   * 计数**逐项声明单位**（segments / materials）；
 *   * 缺失的职能**如实为空**，不为了凑齐五段而补。
 * 另外给出位置分布与相邻转移，供 M4 的拍摄计划选结构用（都是**统计**，不是创作建议）。
 */
export function buildStructureCenter(db, { mediaBase } = {}) {
  const segRows = db.prepare(`
    SELECT s.entity_key, s.segment_id, s.start_seconds, s.end_seconds, s.observed, s.onscreen_text, s.speech,
           l.ai_role, l.human_role, COALESCE(l.human_role, l.ai_role) AS eff
    FROM segments s
    LEFT JOIN segment_labels l ON l.entity_key = s.entity_key AND l.segment_id = s.segment_id
    ORDER BY s.entity_key, COALESCE(s.start_seconds, 0)`).all();
  const byMaterial = new Map();
  for (const r of segRows) {
    if (!byMaterial.has(r.entity_key)) byMaterial.set(r.entity_key, []);
    byMaterial.get(r.entity_key).push(r);
  }
  const formulaRows = db.prepare(`SELECT entity_key, title, structure_formula, product_category, product_function, scene_or_need
    FROM materials WHERE TRIM(COALESCE(structure_formula,'')) <> '' ORDER BY entity_key`).all();
  // M3-F03（受影响复审，高；结构中心侧）：与 sourceOf() **同一口径**——必须核实文件真的存在。
  // 此前这里只看 usable_as_video=1 且 local_path 非空，于是「库里声明了路径但文件已不在」的素材
  // 在结构中心仍显示为「可播放」，违反 MP-07「不可用媒体永远不显示为可播放」。
  // ★ 2026-10-15（第 61 轮复核 F61-02，高）：结构中心**必须复用与来源解析同一个选择函数**。
  //   此前这里扫全部资产、来源解析只取一行 ⇒ 同一素材有多条资产时会出现"来源 false / 结构中心 true"的反例。
  const assetRows = db.prepare(`SELECT entity_key, asset_id, local_path, usable_as_video, cloud_state, cloud_key, cloud_bytes FROM assets`).all();
  const rowsByMaterial = new Map();
  for (const r of assetRows) {
    if (!rowsByMaterial.has(r.entity_key)) rowsByMaterial.set(r.entity_key, []);
    rowsByMaterial.get(r.entity_key).push(r);
  }
  const chosen = new Map();
  for (const [k, rs] of rowsByMaterial) chosen.set(k, pickAsset(rs));
  const playableCloud = new Set([...chosen].filter(([, a]) => isCloudReady(a)).map(([k]) => k));
  const playableLocal = new Set([...chosen].filter(([, a]) => hasLocalFile(a)).map(([k]) => k));
  const playableCloudOnly = new Set([...playableCloud].filter((k) => !playableLocal.has(k)));
  const playable = new Set([...playableCloud, ...playableLocal]);

  // 职能分布（单位＝segments）
  const roleStat = {};
  for (const role of STRUCTURE_ROLES) roleStat[role] = { segments: 0, materials: 0, share_of_segments: 0 };
  const matHasRole = new Map();
  for (const [key, rows] of byMaterial) {
    const seen = new Set();
    for (const r of rows) {
      const eff = r.eff ?? '(未标注)';
      if (roleStat[eff]) { roleStat[eff].segments += 1; seen.add(eff); }
    }
    for (const role of seen) { roleStat[role].materials += 1; matHasRole.set(`${key}|${role}`, true); }
  }
  const totalSeg = segRows.length;
  for (const role of STRUCTURE_ROLES) roleStat[role].share_of_segments = totalSeg ? Number((roleStat[role].segments / totalSeg).toFixed(4)) : 0;

  // 逐素材：生效公式、各职能计数、缺失职能（如实列出，不补）
  const formulas = formulaRows.map((m) => {
    const rows = byMaterial.get(m.entity_key) ?? [];
    const effSeq = rows.map((r) => r.eff ?? '(未标注)');
    const counts = {};
    for (const role of STRUCTURE_ROLES) counts[role] = effSeq.filter((x) => x === role).length;
    const missing = STRUCTURE_ROLES.filter((role) => counts[role] === 0);
    return {
      entity_key: m.entity_key, title: m.title ?? null,
      formula_ai: m.structure_formula ?? null,
      formula_effective: effSeq.join(' → '),
      roles_in_order: effSeq, role_counts: counts, missing_roles: missing,
      unit: 'segments', segments: effSeq.length,
      playable: playable.has(m.entity_key),
      playable_delivery: playableCloud.has(m.entity_key) ? 'cloud_relay' : (playableLocal.has(m.entity_key) ? 'local_file' : null),
      // 旧字段名保留一个版本，避免前端/外部读方立刻断掉；语义＝"本机文件在"（不再是"能不能播"）。
      locally_playable: playableLocal.has(m.entity_key),
      product_category: m.product_category ?? null, product_function: m.product_function ?? null, scene_or_need: m.scene_or_need ?? null,
    };
  });

  // 位置分布（第 N 个片段是什么职能）——统计事实
  const positions = [];
  const maxLen = Math.max(0, ...[...byMaterial.values()].map((r) => r.length));
  for (let i = 0; i < maxLen; i += 1) {
    const dist = {};
    for (const rows of byMaterial.values()) {
      const role = rows[i]?.eff;
      if (!role) continue;
      dist[role] = (dist[role] ?? 0) + 1;
    }
    positions.push({ position: i + 1, unit: 'materials', distribution: dist });
  }

  // 相邻转移（供 M4 选结构；单位＝segments 内的相邻对）
  const transitions = {};
  for (const rows of byMaterial.values()) {
    for (let i = 0; i + 1 < rows.length; i += 1) {
      const a = rows[i].eff; const b = rows[i + 1].eff;
      if (!a || !b) continue;
      const k = `${a} → ${b}`;
      transitions[k] = (transitions[k] ?? 0) + 1;
    }
  }
  const topTransitions = Object.entries(transitions).sort((x, y) => y[1] - x[1]).slice(0, 12)
    .map(([pair, n]) => ({ pair, segments_adjacent_pairs: n }));

  return {
    at: new Date().toISOString(),
    basis: '生效职能＝COALESCE(human_role, ai_role)：人工决定优先、AI 建议兜底；与素材中心同一口径。',
    role_policy: 'AI 建议与人工决定始终分列返回（ai_role / human_role）；本视图只做检索与统计，不产生新的标签。',
    missing_policy: '缺失的职能如实列出（missing_roles），不为了凑齐五段而补；`insufficient_evidence` 是诚实的第六类，不是失败。',
    units: 'roles.segments＝片段数；roles.materials＝出现该职能的素材数；positions.unit=materials；top_transitions 的单位是相邻片段对。',
    roles: STRUCTURE_ROLES.map((role) => ({
      role, approved: true,
      segments: roleStat[role].segments, materials: roleStat[role].materials,
      share_of_segments: roleStat[role].share_of_segments,
      // M3-F02：每个职能必须指向**按该职能过滤**的片段集合，不能指到"全部片段"（那会返回 84 条全 NULL）。
      segments_endpoint: `/api/segment-library?role=${role}`,
    })),
    totals: {
      segments: totalSeg, materials_with_segments: byMaterial.size, materials_with_formula: formulaRows.length,
      playable_materials: playable.size, playable_local_materials: playableLocal.size, playable_cloud_only_materials: playableCloudOnly.size,
      // 旧字段名保留（字面含义＝本机文件在；云端可播不再混进来）。
      locally_playable_materials: playableLocal.size,
    },
    formulas,
    positions,
    top_transitions: topTransitions,
    mediaBase: mediaBase ?? null,
  };
}

function toItem(db, r, role, mediaBase) {
  const src = sourceOf(db, r.entity_key, r.segment_id, mediaBase);
  return {
    segment_id: r.segment_id,
    entity_key: r.entity_key,
    role: role ?? null,
    ai_role: role ?? null,
    human_role: r.human_role ?? null,
    effective_role: r.effective_role ?? role ?? null,
    time_label: r.t_label ?? null,
    time_range: src.time_range,
    // 留存文本＝来源事实层（只读），空就是空，不补写
    retained_text: {
      observed: r.observed ?? null, onscreen_text: r.onscreen_text ?? null, speech: r.speech ?? null,
      has_any: Boolean(String(r.observed ?? '').trim() || String(r.onscreen_text ?? '').trim() || String(r.speech ?? '').trim()),
    },
    coverage: r.coverage ?? null,
    source: src.identity,
    availability: src.availability,
    playable: src.playable,
    // 播放能力来自哪里（local_file / cloud_relay / null）——候选与计划引用用同一口径，前端据此才敢显示「打开来源并定位」。
    delivery: src.delivery,
    media_url: src.media_url,
    seek_url: src.seek_url,
    external_link_policy: src.external_link_policy,
  };
}
