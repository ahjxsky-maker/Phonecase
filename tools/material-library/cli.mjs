#!/usr/bin/env node
// tools/material-library/cli.mjs
// 显式输入/输出/目标的编排入口。所有路径与目标由 argv 决定，无隐式默认写入。
//
// 用法（实际执行命令见 docs/product-material-library/README.md）：
//   node tools/material-library/cli.mjs normalize [--out DIR] [--limit N]
//   node tools/material-library/cli.mjs plan      [--out DIR]
//   node tools/material-library/cli.mjs import    (--dry-run | --target memory | --target http --base-url URL --token T [--mgmt-token JWT])
//   node tools/material-library/cli.mjs query     --target http --base-url URL --token T [--mgmt-token JWT] [--product-category C …] [--entity-key K | --row-id N]   # 只读：消费既有目标
//   node tools/material-library/cli.mjs edit      --target http … (--entity-key K|--row-id N) --note TEXT --reviewer OP [--product-category C --classification-evidence REF --classification-state proposed|reviewed|rejected]   # 显式编辑；--query-product-category 等用于限定命中范围
//   node tools/material-library/cli.mjs export    --target http … [--entity-key K|--row-id N] [--bundle PATH]   # 只读快照（不导入、不建结构）
//   node tools/material-library/cli.mjs restore   [--bundle PATH] [--restore-into DIR]   # 从**磁盘字节**恢复并逐项核对
//   node tools/material-library/cli.mjs verify    [--out DIR]
//   node tools/material-library/cli.mjs sample    [--out DIR] [--size N]
//   node tools/material-library/cli.mjs review    --entity-key KEY [--status S] [--note TEXT] [--category C] [--select-reference true]
//   node tools/material-library/cli.mjs apply     --base-url http://127.0.0.1:8080 --database-id N [--token T] [--mgmt-token JWT]
//   node tools/material-library/cli.mjs journey   [--target http …]（默认只读；写入须 --edit）| [--setup-fixture --edit --manual-reviewer OP --classification-state S --classification-evidence REF]
//   node tools/material-library/cli.mjs media     [--port N] [--serve]
// 注意（R4）：结构工作（建表/字段/视图）必须带 --database-id；导入/应用的真实命令与必需参数见 README。
// 注意（R8）：query/edit/export/restore 只消费**已存在的目标**；只有 import/apply 会建结构。ML_TRANSPORT=baserow-double 时回执标 baserow_verified=false（回环替身，不是 Baserow）。
// R12：baserow_verified 不再是常量 —— 真实 http 目标读取成功后才为 true（带 verification_method/at）；memory 与未打开目标的拒绝回执仍为 false。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULT_ROOT, ensureDir, loadRulesConfig, sourcePaths, v5MeaningFor, V5_FIELD_CONTRACT, V5_VALUE_SEMANTICS, DERIVED_URL_NOTE, AMBIGUOUS_MEANING_FIELDS, OBSERVATION_STATUS } from './rules.mjs';
import { buildRecords, summaryOf } from './normalize.mjs';
import { loadOverlay, overlayPath as reviewOverlayPath, saveOverlay, setReview, splitTestIdentities } from './review.mjs';
import { applyTargetEdit, lookupTarget, resolveTargetSelection, runJourney, serializeTargetRow } from './journey.mjs';
import { buildRepresentativeSample, plannedTables, resolveManifest } from './sample.mjs';
import { createMediaIndex, createMediaServer, MEDIA_ADAPTER_VERSION, verifyMediaRoute } from './media.mjs';
import {
  ADAPTER_VERSION, BASEROW_PINNED_IMAGE, HUMAN_FIELDS,
  ALL_TABLES, LINK_FIELDS, TABLE_ASSETS, TABLE_METRICS, TABLE_PRIMARY_KEY, TABLE_RATIOS, TABLE_SEGMENTS, TABLE_VIDEOS,
  createHttpBackend, createHttpClient, createMemoryBackend, ensureSchemaAndViews, HTTP_ROUTES, importRecords,
  planMerge, planSchema, planViews, reconcileInterrupted, rowsOf,
} from './baserow.mjs';
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) out[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) { out[k] = argv[++i]; }
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

// R11：**凭据输入安全**——命令行参数会被工具/会话日志记录，因此令牌不允许走 argv。
//   最小适配：--creds-file <JSON: base_url/database_id/db_token/jwt> 或 ML_BASE_URL/ML_DATABASE_ID/
//   ML_DB_TOKEN/ML_MGMT_TOKEN。只填空缺项，显式参数优先；回执只写来源与「是否存在」，绝不写值。
function applyCredentialFallbacks(a) {
  const sources = { 'base-url': null, 'database-id': null, token: null, 'mgmt-token': null };
  let fileCreds = null;
  if (typeof a['creds-file'] === 'string') {
    const p = path.isAbsolute(a['creds-file']) ? a['creds-file'] : path.resolve(a['creds-file']);
    if (!fs.existsSync(p)) throw new Error(`creds_file_not_found:${p}`);
    fileCreds = JSON.parse(fs.readFileSync(p, 'utf8'));
    sources.file = 'provided';
  }
  const pick = (argKey, fileKey, envKey) => {
    if (a[argKey] !== undefined) { sources[argKey] = 'argv'; return; }
    const fromFile = fileCreds ? fileCreds[fileKey] : undefined;
    if (fromFile !== undefined && fromFile !== null && fromFile !== '') { a[argKey] = String(fromFile); sources[argKey] = 'creds_file'; return; }
    const fromEnv = process.env[envKey];
    if (fromEnv !== undefined && fromEnv !== '') { a[argKey] = fromEnv; sources[argKey] = 'env'; return; }
    sources[argKey] = null;
  };
  pick('base-url', 'base_url', 'ML_BASE_URL');
  pick('database-id', 'database_id', 'ML_DATABASE_ID');
  pick('token', 'db_token', 'ML_DB_TOKEN');
  pick('mgmt-token', 'jwt', 'ML_MGMT_TOKEN');
  a._credentials = {
    sources,
    base_url: a['base-url'] ?? null,
    database_id: a['database-id'] ?? null,
    db_token_present: typeof a.token === 'string' && a.token.length > 0,
    mgmt_token_present: typeof a['mgmt-token'] === 'string' && a['mgmt-token'].length > 0,
    note: '令牌值不进入 argv/回执；只记录来源与是否存在。',
  };
  return a;
}

const argv = applyCredentialFallbacks(parseArgs(process.argv.slice(2)));
const cmd = argv._[0];
const root = argv.root ?? DEFAULT_ROOT;
const P = sourcePaths(root);
const OUT = argv.out ?? P.outRoot;

function writeJson(file, obj) { ensureDir(path.dirname(file)); fs.writeFileSync(file, JSON.stringify(obj, null, 2)); return file; }
function log(...a) { console.log(...a); }

function assertLoopback(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`invalid_base_url:${url}`); }
  const host = u.hostname;
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
    throw new Error(`refused_non_loopback_target:${host} — 本阶段只允许绑定回环的隔离本地实例`);
  }
  return u;
}

async function loadAll(overlayPath = undefined) {
  const rules = loadRulesConfig(root);
  // F5/R4-F4：默认使用正式覆盖层；测试/旅程传入 --overlay 隔离夹具。
  // **同一路径必须贯穿 写→读→导入→目标断言**：调用方显式传入 overlayPath 时优先于 argv。
  const effectiveOverlay = overlayPath === undefined ? (argv.overlay ?? null) : overlayPath;
  const built = await buildRecords(root, { ratioRules: rules.ratio_rules, overlayPath: effectiveOverlay });
  return { rules, ...built, overlay_path_used: effectiveOverlay };
}

async function cmdNormalize() {
  const { rules, records, gaps, orphanFieldEntities, reconciliation, overlays, mediaAssets } = await loadAll();
  const limited = argv.limit ? records.slice(0, Number(argv.limit)) : records;
  const dir = ensureDir(path.join(OUT, 'normalized'));
  const lines = limited.map((r) => JSON.stringify(r));
  fs.writeFileSync(path.join(dir, 'records.jsonl'), lines.join('\n') + '\n');
  writeJson(path.join(dir, 'gaps.json'), { count: gaps.length, gaps });
  writeJson(path.join(dir, 'media-assets.json'), {
    count: mediaAssets.length,
    in_primary_cohort: mediaAssets.filter((a) => a.in_primary_cohort).length,
    outside_primary_cohort: mediaAssets.filter((a) => !a.in_primary_cohort).length,
    note: '既有 20 条媒体按身份分开标识；不在主口径队列者不改动 V8420 分母。',
    assets: mediaAssets,
  });
  writeJson(path.join(dir, 'reconciliation.json'), reconciliation);
  writeJson(path.join(dir, 'summary.json'), { rules_version: rules.rules_version, overlays, orphan_field_entities: orphanFieldEntities.length, ...summaryOf(limited) });
  writeJson(path.join(dir, 'rules-config.json'), rules);
  log(`normalize: records=${limited.length} gaps=${gaps.length} main_v=${reconciliation.actual_main_v} aid_v=${reconciliation.actual_aid_v} reconcile_ok=${reconciliation.ok}`);
  log(`media assets: total=${mediaAssets.length} in_cohort=${mediaAssets.filter((a) => a.in_primary_cohort).length} outside=${mediaAssets.filter((a) => !a.in_primary_cohort).length}`);
  log(`wrote ${dir}`);
  if (!reconciliation.ok) { log('RECONCILIATION MISMATCH', JSON.stringify(reconciliation.mismatches)); process.exitCode = 2; }
}

async function cmdPlan() {
  const schema = planSchema();
  const views = planViews();
  const dir = ensureDir(path.join(OUT, 'plan'));
  writeJson(path.join(dir, 'baserow-schema.json'), schema);
  writeJson(path.join(dir, 'baserow-views.json'), views);
  writeJson(path.join(dir, 'rules-config.json'), loadRulesConfig(root));
  log(`plan: tables=${schema.tables.length} views=${views.length} pinned_image=${BASEROW_PINNED_IMAGE}`);
  log(`wrote ${dir}`);
}

async function cmdSample() {
  const { records } = await loadAll();
  const size = Number(argv.size ?? 25);
  // R5 STEP3：代表性 = **显式身份清单**（跨平台/长 ID/中文/媒体/片段/来源不可用优先，再轮转补齐），
  // 而不是 `records.slice(0, N)` 那种文件前缀。清单由同一 HTTP 导入通过 --manifest 消费。
  const manifest = buildRepresentativeSample(records, { size });
  const chosen = manifest.entity_keys.map((k) => records.find((r) => r.entity_key === k)).filter(Boolean);
  const dir = ensureDir(path.join(OUT, 'sample'));
  writeJson(path.join(OUT, 'representative-sample-r5.json'), manifest);
  writeJson(path.join(dir, 'sample-keys.json'), chosen.map((r) => ({
    entity_key: r.entity_key, native_id: r.native_id, has_assets: (r.assets ?? []).length > 0,
    segments: (r.assets ?? []).reduce((n, a) => n + (a.segments ?? []).length, 0),
    source_state: r.availability.entity_source_state, metrics: r.availability.fields_observed,
  })));
  writeJson(path.join(dir, 'sample-rows.json'), rowsOf(chosen));
  const backend = createMemoryBackend();
  for (const t of ALL_TABLES) await backend.createTable(t);
  const receipt = await importRecords({ records: chosen, backend, mode: 'memory_semantics_only' });
  writeJson(path.join(dir, 'sample-receipt.json'), receipt);
  const cov = manifest.coverage;
  log(`sample: records=${chosen.length} platforms=${cov.distinct_platforms} branches=${Object.keys(cov.by_platform_namespace).length} long_ids=${cov.long_id_count} chinese=${cov.chinese_text_count} media=${cov.with_media_count} segments=${cov.with_segments_count}`);
  log(`sample: planned=${JSON.stringify(plannedTables(chosen))} reconcile_ok=${receipt.ok}`);
  log(`NOTE: target=memory_semantics_only —— 这不是 Baserow，不能作为 Baserow 验收证据。`);
  log(`wrote ${path.join(OUT, 'representative-sample-r5.json')} 与 ${dir}`);
}

// R7-STEP3：**发布语义三态**由 import 与 journey（含复导入）共用，避免不同入口给出相反含义。
//   ① 显式 --media-base-url <loopback url>  → 发布（写入绝对可点击链接）
//   ② 显式 --unpublish（或 --media-base-url ""）→ 停止发布（清除链接，状态 not_published）
//   ③ 都没有 → 读 media/media-publication.json 的**显式记录**；文件不存在则 **未指定**
//      （未指定 ≠ 停止发布：导入必须保留目标行里已有的已发布链接）
function resolveMediaPublication(curArgv) {
  const hasFlag = Object.prototype.hasOwnProperty.call(curArgv, 'media-base-url');
  const flagValue = hasFlag ? String(curArgv['media-base-url'] ?? '') : null;
  const publicationPath = path.join(OUT, 'media', 'media-publication.json');
  let mediaBaseUrl;
  let receipt;
  if (curArgv.unpublish === true || (hasFlag && flagValue === '')) {
    mediaBaseUrl = null;
    receipt = {
      source: curArgv.unpublish === true ? 'cli_flag:--unpublish' : 'cli_flag:--media-base-url(empty)',
      state: 'not_published', base_url: null, option_provided: true,
      semantics: 'explicit_unpublish_clears_links',
      note: '显式停止发布：目标行的绝对链接会被清除，状态写 not_published；这不是“没配置”。',
    };
  } else if (hasFlag) {
    mediaBaseUrl = flagValue;
    receipt = { source: 'cli_flag:--media-base-url', state: 'published', base_url: mediaBaseUrl, option_provided: true, semantics: 'explicit_publish' };
  } else if (fs.existsSync(publicationPath)) {
    const pub = JSON.parse(fs.readFileSync(publicationPath, 'utf8'));
    if (pub.state === 'published' && pub.base_url) {
      mediaBaseUrl = pub.base_url;
      receipt = {
        source: 'media/media-publication.json', state: 'published', base_url: mediaBaseUrl, option_provided: true, semantics: 'explicit_publish',
        published_at: pub.published_at ?? null,
      };
    } else {
      mediaBaseUrl = null;
      receipt = {
        source: 'media/media-publication.json', state: pub.state ?? 'unknown', base_url: null, option_provided: true,
        semantics: 'explicit_unpublish_clears_links',
        not_published_reason: pub.not_published_reason ?? null,
        note: '发布记录显式声明当前未发布（例如观看服务是自检后即退的进程）→ 清除链接是**有意的**。',
      };
    }
  } else {
    mediaBaseUrl = undefined;
    receipt = {
      source: null, state: 'unspecified', base_url: null, option_provided: false,
      semantics: 'unspecified_preserve_existing_target_links',
      note: '既没有发布参数也没有发布记录：本次导入**不改动**目标行的媒体发布字段（保留既有已发布链接）。',
    };
  }
  if (mediaBaseUrl && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(mediaBaseUrl)) {
    throw new Error(`media_base_url_must_be_loopback:${mediaBaseUrl}`);
  }
  receipt.base_url = mediaBaseUrl ?? null;
  receipt.restart_note = '重启后端口可能不同（除非显式 --port）：重跑 `media --serve --port <N>`，再以 `import --media-base-url <url>` 重新发布绝对链接。';
  return { mediaBaseUrl, receipt };
}

async function cmdImport() {
  const { records } = await loadAll();
  const dir = ensureDir(path.join(OUT, 'import'));
  // R7-STEP3：发布语义统一走 resolveMediaPublication（未指定 ≠ 显式停止发布）。
  // 未指定时 mediaBaseUrl === undefined：importRecords 会**保留**目标行已有发布字段，不静默撤销。
  const resolvedPublication = resolveMediaPublication(argv);
  const mediaBaseUrl = resolvedPublication.mediaBaseUrl;
  const mediaService = resolvedPublication.receipt;
  // R5 STEP3：显式输入选择——代表样本（--manifest 身份清单）/ 有限批次（--limit N）/ 全量各是**不同命令**。
  // 清单解析失败（未知键/重复键/形状不对）必须显式报错，不合成替代、不自动扩张为全量。
  // R7-STEP5：同一语义被 export（单目标顺序验证）复用，避免两条入口对“选了哪些记录”各说各话。
  const { selected, inputSelection } = selectImportInput(records, argv);
  const payload = rowsOf(selected);
  const planned = Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, v.length]));

  if (argv['dry-run'] || !argv.target) {
    const receipt = {
      adapter: ADAPTER_VERSION, mode: 'dry_run_plan_only', baserow_verified: false,
      input_selection: inputSelection, planned,
      note: '只生成导入计划与规模；未连接任何 Baserow 实例。',
      pinned_image: BASEROW_PINNED_IMAGE,
      human_fields_never_overwritten: HUMAN_FIELDS,
    };
    writeJson(path.join(dir, 'dry-run-receipt.json'), receipt);
    log(`import --dry-run: planned=${JSON.stringify(planned)} (selected ${selected.length}/${records.length})`);
    log(`wrote ${path.join(dir, 'dry-run-receipt.json')}`);
    return;
  }

  if (argv.target === 'memory') {
    const backend = createMemoryBackend();
    for (const t of ALL_TABLES) await backend.createTable(t);
    const first = await importRecords({ records: selected, backend, mode: 'memory_semantics_only', mediaBaseUrl });
    // 复跑：同一输入必须零新增
    const second = await importRecords({ records: selected, backend, mode: 'memory_semantics_only', mediaBaseUrl });
    writeJson(path.join(dir, 'memory-receipt.json'), { input_selection: inputSelection, first, second });
    log(`import --target memory: first=${JSON.stringify(first.videos)} second=${JSON.stringify(second.videos)}`);
    log(`NOTE: target=memory_semantics_only —— 只验证适配器合并语义，不是 Baserow 验收证据。`);
    if (!first.ok || !second.ok) { log(`WARN: reconcile failed first.ok=${first.ok} second.ok=${second.ok}`); process.exitCode = 8; }
    return;
  }

  if (argv.target === 'http') {
    if (!argv['base-url']) throw new Error('http target requires --base-url');
    assertLoopback(argv['base-url']);
    // F1 修复：真实写入 + 分页读回。连接成功**不**等于导入成功。
    log(`creds: ${JSON.stringify(argv._credentials.sources)}（令牌值不回显）`);
    const client = createHttpClient({ baseUrl: argv['base-url'], token: argv.token, mgmtToken: argv['mgmt-token'] ?? null });
    const receipt = {
      adapter: ADAPTER_VERSION, mode: 'http', base_url: argv['base-url'],
      auth_used: client.auth_used, started_at: new Date().toISOString(), steps: [], ok: false,
      input_selection: inputSelection,
    };
    try {
      const ping = await client.ping();
      receipt.steps.push({ step: 'ping', ok: true, version: ping?.version ?? null });
      // R12：ping 拿到真实 Baserow 版本 → 本次导入回执可如实标 baserow_verified=true
      markBaserowVerified(`ping_real_baserow_version=${ping?.version ?? 'unknown'}`);
      Object.assign(receipt, transportInfo());

      // 结构先就位（幂等 reconcile），再写数据行
      const schemaRes = await ensureSchemaAndViews(client, {
        databaseId: argv['database-id'] ? Number(argv['database-id']) : null,
      });
      receipt.steps.push({ step: 'ensure_schema_and_views', ok: schemaRes.ok, log: schemaRes.log });
      if (!schemaRes.ok) throw new Error('schema_reconcile_reported_type_mismatch');

      const backend = createHttpBackend({ client, tableIds: schemaRes.tableIds, fieldMeta: schemaRes.fieldMeta ?? {} });
      const res = await importRecords({
        records: selected, backend, mode: 'baserow_http', mediaBaseUrl,
        bindingsPath: path.join(dir, 'source-row-bindings.json'),
      });
      receipt.import = res;
      receipt.ok = res.ok === true;
      receipt.steps.push({ step: 'import', ok: receipt.ok, tables: res.tables, errors: res.errors.length });
      if (!receipt.ok) receipt.note = '写入未全部成功：不给出成功回执（连接成功≠导入成功）。';
    } catch (e) {
      receipt.steps.push({ step: 'connect_or_schema', ok: false, error: String(e.message), status: e.status ?? null });
      receipt.note = '未取得真实可写 Baserow 实例；HTTP 导入未完成。';
    }
    writeJson(path.join(dir, 'http-receipt.json'), receipt);
    log(`import --target http: ok=${receipt.ok}${receipt.import ? ' tables=' + JSON.stringify(receipt.import.tables) : ''}`);
    if (!receipt.ok) process.exitCode = 3;
    return;
  }

  throw new Error(`unknown --target:${argv.target}`);
}

// R5 STEP3 / R7-STEP5：import 与 export 共用的输入选择语义（representative manifest / --limit / 全量）。
function selectImportInput(records, curArgv) {
  if (curArgv.manifest && curArgv.limit !== undefined) throw new Error('manifest_and_limit_are_mutually_exclusive：请只用其中一种输入选择');
  const limit = curArgv.limit === undefined ? null : Number(curArgv.limit);
  if (limit !== null && (!Number.isFinite(limit) || limit <= 0)) throw new Error(`invalid_limit:${curArgv.limit}`);
  let selected = limit === null ? records : records.slice(0, limit);
  let inputSelection = {
    source: 'normalized/records.jsonl（按文件顺序取前 N 条）',
    available_records: records.length, selected_records: selected.length, limit,
    main_branch_selected: selected.filter((r) => !r.aid_branch).length,
    aid_branch_selected: selected.filter((r) => r.aid_branch).length,
  };
  if (curArgv.manifest) {
    const manifestPath = path.isAbsolute(String(curArgv.manifest)) ? String(curArgv.manifest) : path.resolve(String(curArgv.manifest));
    if (!fs.existsSync(manifestPath)) throw new Error(`manifest_not_found:${manifestPath}`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const res = resolveManifest(records, manifest);
    if (!res.ok) throw new Error(`invalid_sample_manifest:${res.problems.join(',')}|unknown=${res.unknown_keys.slice(0, 3).join(';')}|dup=${res.duplicate_keys.slice(0, 3).join(';')}`);
    selected = res.records;
    inputSelection = {
      source: `manifest:${manifestPath}`, manifest_version: manifest.version,
      requested_keys: manifest.entity_keys.length, resolved_records: selected.length,
      available_records: records.length, coverage: manifest.coverage ?? null,
      key_order_preserved: true,
    };
  } else if (limit !== null) {
    inputSelection.source = 'normalized/records.jsonl（显式 --limit，按文件顺序取前 N 条；**不是**代表样本）';
  }
  return { selected, inputSelection, limit };
}

// ---------------------------------------------------------------- R8：目标打开与只读语义
// R8-STEP2/3：**查询/编辑/导出**只消费**已存在的目标**：绝不建表/建字段/建视图、不导入、不写覆盖层。
// 目标传输缺席时只允许用**已标注的**回环替身（ML_TRANSPORT=baserow-double），且回执必须 baserow_verified=false。
//
// R12 修复（原为硬编码 false，见 R11 报告的 OPEN 项）：`baserow_verified` 现在表示
// 「**本次运行真的对真实 Baserow 传输完成过一次读取**」，而不是一个常量：
//   - 回环形状替身（ML_TRANSPORT=baserow-double）→ 恒为 false（它不是 Baserow 实例）；
//   - memory 目标 → false（只验证适配器语义）；
//   - http 目标 → 读取到表/字段（或 import 的 ping 拿到版本）之后才置 true，并带 verification_method/at；
//   - 目标打不开的“如实拒绝回执” → false（本次什么都没验证）。
let transportVerification = { baserow_verified: false, method: null, at: null };
/** 记录“本次运行已完成一次真实 Baserow 读取”，供随后生成的回执如实标注。 */
function markBaserowVerified(method) {
  transportVerification = { baserow_verified: true, method, at: new Date().toISOString() };
}
function transportInfo() {
  const substituted = process.env.ML_TRANSPORT === 'baserow-double';
  return {
    transport: substituted ? 'baserow_shape_double_substituted' : 'baserow_http',
    baserow_verified: substituted ? false : transportVerification.baserow_verified,
    verification_method: substituted ? 'substituted_loopback_double' : (transportVerification.method ?? 'not_verified_in_this_run'),
    verification_at: substituted ? null : transportVerification.at,
    substitution_note: substituted
      ? '已用**回环 Baserow 形状替身**替代不可用的真实 Baserow 传输（严格 2.4.0 行/结构形状）；**不是** Baserow 实例，A2/A6 的真实实例部分仍为 OPEN。'
      : null,
  };
}

/** 只读查询条件（产品/功能/场景；未给维度时为空条件 = 如实返回全部行）。 */
function queryFromArgv(curArgv, prefix = '') {
  return Object.fromEntries(['product_category', 'product_function', 'scene_or_need']
    .map((k) => [k, curArgv[prefix + k.replace(/_/g, '-')] ?? null])
    .filter(([, v]) => v !== null && v !== ''));
}

/**
 * 打开**已存在**的目标（只读结构发现，绝不创建）。
 * @returns {{backend:object, target_mode:string, kind:string, transport:object, table_ids:object, missing_tables:string[]}}
 */
async function openExistingTarget({ requireAllTables = true } = {}) {
  const targetMode = argv.target ?? null;
  if (!targetMode) throw new Error('target_required：只读命令必须显式声明 --target http（既有目标）；不隐式新建目标');
  let transport = transportInfo();
  if (targetMode === 'memory') {
    // 内存目标只用于隔离测试：**空目标**，因此不建表、不导入（本命令从不改动它）
    const backend = createMemoryBackend();
    return { backend, target_mode: 'memory', kind: 'memory_semantics_only', transport, table_ids: {}, missing_tables: [...ALL_TABLES] };
  }
  if (targetMode !== 'http') throw new Error(`unsupported_target:${targetMode}（http|memory）`);
  if (!argv['base-url'] || !argv.token) throw new Error('target_http_requires_base_url_and_token：只读命令需要 --base-url 与 --token（不回落 memory）');
  assertLoopback(argv['base-url']);
  const client = createHttpClient({ baseUrl: argv['base-url'], token: argv.token, mgmtToken: argv['mgmt-token'] ?? null });
  // **只读**结构发现：库作用域列目录（JWT）优先；只有 Token 时用令牌作用域列目录。两者都不创建任何东西。
  const tables = argv['mgmt-token']
    ? (argv['database-id'] ? await client.listTablesInDatabase(Number(argv['database-id'])) : (() => { throw new Error('target_requires_database_id_for_mgmt_listing：给了 --mgmt-token 就要有 --database-id'); })())
    : await client.listTablesTokenScope();
  const byName = new Map((tables ?? []).map((t) => [t.name, t]));
  const missing_tables = ALL_TABLES.filter((t) => !byName.has(t));
  if (missing_tables.length && requireAllTables) {
    const err = new Error(`target_schema_missing:${missing_tables.join(',')}（只读命令不建表；先由显式 import 建立目标）`);
    err.missing_tables = missing_tables;
    err.tables_present = [...byName.keys()];
    throw err;
  }
  const tableIds = {};
  const fieldMeta = {};
  for (const t of ALL_TABLES) {
    if (!byName.has(t)) continue;
    tableIds[t] = byName.get(t).id;
    const fields = (await client.listFields(tableIds[t])) ?? [];
    fieldMeta[t] = Object.fromEntries(fields.map((f) => [f.name, f]));
  }
  const backend = createHttpBackend({ client, tableIds, fieldMeta });
  // R12：表 + 字段都真的读到了 → 本次运行确实对真实 Baserow 完成了一次读取，回执方可标 true。
  markBaserowVerified('read_tables_and_fields_via_http_token_scope');
  transport = transportInfo();
  return { backend, target_mode: 'http', kind: 'baserow_http', transport, table_ids: tableIds, missing_tables };
}

/** 目标描述（进回执；不含凭据）。 */
function targetDescriptor(opened) {
  return {
    target_mode: opened.target_mode, backend_kind: opened.kind,
    base_url: opened.target_mode === 'http' ? String(argv['base-url']) : null,
    database_id: argv['database-id'] ? Number(argv['database-id']) : null,
    auth_used: opened.target_mode === 'http' ? (argv['mgmt-token'] ? 'Token+JWT' : 'Token') : null,
    ...opened.transport,
  };
}

/** 目标不可用/结构缺失时给出**如实拒绝回执**（不创建结构、不写行），而不是抛出堆栈。 */
async function openTargetOrFail(command, dirName) {
  try { return { opened: await openExistingTarget(), receipt: null }; } catch (e) {
    const dir = ensureDir(path.join(OUT, dirName));
    const receipt = {
      adapter: ADAPTER_VERSION, at: new Date().toISOString(), command,
      target: { target_mode: argv.target ?? null, base_url: argv['base-url'] ?? null, ...transportInfo() },
      read_only: true, mutated: false, writes_performed: 0, ok: false,
      error: String(e.message), missing_tables: e.missing_tables ?? null, tables_present: e.tables_present ?? null,
      note: '目标不可用或结构缺失：**未创建任何结构、未写入任何行**（只读命令从不建表）。',
    };
    writeJson(path.join(dir, `${dirName}-receipt.json`), receipt);
    log(`${command}: REFUSED ${e.message}`);
    process.exitCode = 11;
    return { opened: null, receipt };
  }
}

async function cmdQuery() {
  // R8-STEP2：**只读**查询。消费既有目标行；不建结构、不导入、不写覆盖层、不加默认备注、绝不写行。
  const openRes = await openTargetOrFail('query', 'query');
  if (!openRes.opened) return openRes.receipt;
  const opened = openRes.opened;
  const query = queryFromArgv(argv);
  const resolved = await resolveTargetSelection({
    backend: opened.backend, query,
    selection: { entityKey: argv['entity-key'] ?? null, rowId: argv['row-id'] ?? null, namespace: argv['namespace'] ?? null },
  });
  const dir = ensureDir(path.join(OUT, 'query'));
  const selectionRequested = resolved.selection_requested;
  const receipt = {
    adapter: ADAPTER_VERSION, at: new Date().toISOString(), command: 'query',
    target: targetDescriptor(opened),
    query, read_only: true, mutated: false, writes_performed: 0,
    hit_count: resolved.hit_count, scanned_rows: resolved.scanned_rows,
    hits: resolved.hits.slice(0, 25),
    selection_requested: selectionRequested,
    selected_row_id: resolved.selected_row_id, selected_entity_key: resolved.selected_entity_key,
    problems: resolved.problems, duplicate_keys: resolved.duplicate_keys,
    ok: resolved.ok,
    note: '只读：命中来自目标库行；本命令不创建结构、不导入、不写行。',
  };
  writeJson(path.join(dir, 'query-receipt.json'), receipt);
  log(`query: target=${opened.target_mode} scanned=${resolved.scanned_rows} hits=${resolved.hit_count} selected=${resolved.selected_row_id ?? 'none'} problems=${JSON.stringify(resolved.problems)}`);
  log(`query: read_only=true writes=0 bundle=${path.join(dir, 'query-receipt.json')}`);
  if (!resolved.ok) process.exitCode = 11;
  return receipt;
}

async function cmdEdit({ opened: openedIn = null, query: queryIn = null, writeReceipt = true, source = 'edit' } = {}) {
  // R8-STEP2：**显式编辑**。必须给出目标身份与内容；查询本身永不触发编辑。
  let opened = openedIn;
  if (!opened) {
    const openRes = await openTargetOrFail('edit', 'edit');
    if (!openRes.opened) return openRes.receipt;
    opened = openRes.opened;
  }
  const query = queryIn ?? queryFromArgv(argv, 'query-');
  // R9-STEP2.4：目标读写异常时给出**诚实**回执（写入/读回结果未知），不让进程崩掉、也不谎称零写入
  let resolved = null;
  try {
    resolved = await resolveTargetSelection({
      backend: opened.backend, query,
      selection: { entityKey: argv['entity-key'] ?? null, rowId: argv['row-id'] ?? null, namespace: argv['namespace'] ?? null },
    });
  } catch (e) {
    const failed = {
      adapter: ADAPTER_VERSION, at: new Date().toISOString(), command: source,
      target: targetDescriptor(opened), query, read_only: false,
      mutated: null, writes_attempted: 0, writes_performed: 0, writes_confirmed: 0, uncertain_outcome: true,
      mutation: { attempted: false, write_accepted: false, confirmed: false, readback_ok: false, state: 'unknown_read_error', error: String(e.message) },
      problems: [`target_read_error:${String(e.message)}`], ok: false,
      note: '读取目标失败：未尝试写入；也不声称目标未被改动。',
    };
    if (writeReceipt) writeJson(path.join(dir, 'edit-receipt.json'), failed);
    log(`edit: READ-ERROR ${String(e.message)}`);
    process.exitCode = 13;
    return failed;
  }
  const hasClassification = !!(argv['product-category'] || argv['product-function'] || argv['scene-or-need']);
  const problems = [...resolved.problems];
  if (!resolved.selected_row_id) problems.push('edit_requires_selected_identity（--entity-key 或 --row-id，且必须命中查询结果）');
  if (!argv.note) problems.push('edit_requires_note（显式提供内容，不自动追加默认备注）');
  if (!argv.reviewer) problems.push('edit_requires_reviewer（操作者身份必须显式给出，不冒充人工复核）');
  if (hasClassification && !argv['classification-evidence']) problems.push('edit_classification_requires_evidence_ref');
  // R9-STEP2.3：分类状态/复核状态**都不是必填**——不请求就保留既有值；请求了就只接受既有契约取值。
  const wantState = argv['classification-state'] ?? null;
  if (wantState && !['proposed', 'reviewed', 'rejected'].includes(String(wantState))) problems.push(`invalid_classification_state:${wantState}`);
  const wantReviewStatus = argv['review-status'] ?? null;
  if (wantReviewStatus && !['unreviewed', 'in_review', 'reviewed', 'rejected'].includes(String(wantReviewStatus))) problems.push(`invalid_review_status:${wantReviewStatus}`);
  const reviewer = argv.reviewer ?? null;
  if (hasClassification && !wantState && !argv['classification-evidence']) problems.push('edit_classification_requires_evidence_ref');

  const dir = ensureDir(path.join(OUT, 'edit'));
  if (problems.length) {
    const refused = {
      adapter: ADAPTER_VERSION, at: new Date().toISOString(), command: source,
      target: targetDescriptor(opened), query, read_only: false, mutated: false,
      writes_attempted: 0, writes_performed: 0, writes_confirmed: 0, uncertain_outcome: false,
      mutation: { attempted: false, write_accepted: false, confirmed: false, readback_ok: false, state: 'refused' },
      selected_row_id: resolved.selected_row_id, selected_entity_key: resolved.selected_entity_key,
      problems, ok: false,
      note: '拒绝编辑：**未尝试写入**（无命中/身份不符/歧义/缺显式意图都会走到这里）——拒绝 ≠ 发生了一次写入。',
    };
    if (writeReceipt) writeJson(path.join(dir, 'edit-receipt.json'), refused);
    log(`edit: REFUSED problems=${JSON.stringify(problems)} writes=0`);
    process.exitCode = 12;
    return refused;
  }

  let beforeRow = null;
  let edit = null;
  const classification = hasClassification ? {
    product_category: argv['product-category'] ?? null,
    product_function: argv['product-function'] ?? null,
    scene_or_need: argv['scene-or-need'] ?? null,
    ...(wantState ? { state: String(wantState) } : {}),
  } : null;
  try {
    const before = await opened.backend.listAllRows(TABLE_VIDEOS);
    beforeRow = before.find((r) => String(r.id) === String(resolved.selected_row_id)) ?? null;
    edit = await applyTargetEdit({
      backend: opened.backend, table: TABLE_VIDEOS, rowId: resolved.selected_row_id,
      entityKey: resolved.selected_entity_key, note: String(argv.note), reviewer: String(reviewer),
      classification, evidenceRef: argv['classification-evidence'] ?? null,
      selectReference: String(argv['select-reference'] ?? 'true') === 'true',
      reviewStatus: wantReviewStatus,
    });
  } catch (e) {
    const failed = {
      adapter: ADAPTER_VERSION, at: new Date().toISOString(), command: source,
      target: targetDescriptor(opened), query, read_only: false,
      mutated: null, writes_attempted: null, writes_performed: null, writes_confirmed: null, uncertain_outcome: true,
      mutation: { attempted: true, write_accepted: null, confirmed: false, readback_ok: false, state: 'unknown_io_error', error: String(e.message) },
      selected_row_id: resolved.selected_row_id, selected_entity_key: resolved.selected_entity_key,
      target_row_before: beforeRow ? serializeTargetRow(beforeRow) : null,
      problems: [`target_io_error:${String(e.message)}`], ok: false,
      note: '目标读写异常：**写入是否落地未知**——既不声称成功，也不声称零写入；请按行 ID 复读核对。',
    };
    if (writeReceipt) writeJson(path.join(dir, 'edit-receipt.json'), failed);
    log(`edit: IO-ERROR ${String(e.message)}（写入结果未知）`);
    process.exitCode = 13;
    return failed;
  }
  // 最终读回：值/状态/来源/操作者逐项核对（只保留元数据却丢值必须失败）
  const verification = {
    row_present: !!edit.after,
    row_id_preserved: edit.after ? String(edit.after.id) === String(resolved.selected_row_id) : false,
    entity_key_preserved: edit.after ? String(edit.after[TABLE_PRIMARY_KEY[TABLE_VIDEOS]]) === String(resolved.selected_entity_key) : false,
    note_present: edit.after ? String(edit.after.review_notes ?? '').includes(String(argv.note)) : false,
    reviewer_matches: edit.after ? (edit.after.review_reviewer ?? null) === reviewer : false,
    // 未显式请求复核状态 → 必须**保留**既有值（不把加备注当成已复核）
    review_status_expected: edit.after
      ? (edit.after.review_status ?? null) === (wantReviewStatus ?? beforeRow?.review_status ?? null)
      : false,
  };
  if (classification) {
    for (const base of ['product_category', 'product_function', 'scene_or_need']) {
      const want = classification[base];
      if (want === null || want === undefined || want === '') continue;
      verification[`${base}_value`] = edit.after?.[base] === String(want);
      verification[`${base}_state`] = (edit.after?.[`${base}_state`] ?? null) === (wantState ?? beforeRow?.[`${base}_state`] ?? null);
      verification[`${base}_evidence_ref`] = (edit.after?.[`${base}_evidence_ref`] ?? null) === (argv['classification-evidence'] ?? null);
      verification[`${base}_reviewer`] = (edit.after?.[`${base}_reviewer`] ?? null) === reviewer;
    }
  }
  const failed = Object.entries(verification).filter(([, v]) => v !== true).map(([k]) => k);
  // R9-STEP2.4：**尝试写入 / 写入被接受 / 读回确认 / 拒绝 / 结果未知**分开记账（不与读回验证混同）
  const mutation = edit.mutation ?? { attempted: false, write_accepted: false, confirmed: false, readback_ok: false, state: 'unknown' };
  const receipt = {
    adapter: ADAPTER_VERSION, at: new Date().toISOString(), command: source,
    target: targetDescriptor(opened), query,
    read_only: false,
    mutated: mutation.write_accepted === true,                 // “目标行是否被写过”按**写入被接受**计
    writes_attempted: mutation.attempted === true ? 1 : 0,
    writes_performed: mutation.write_accepted === true ? 1 : 0, // 被接受=1；拒绝=0；未知写入时由 mutation.state 说明
    writes_confirmed: mutation.confirmed === true ? 1 : 0,
    uncertain_outcome: mutation.state === 'unknown_write' || mutation.state === 'written_unverified',
    mutation,
    selected_row_id: resolved.selected_row_id, selected_entity_key: resolved.selected_entity_key,
    identity_checks: { duplicate_keys: resolved.duplicate_keys, in_query_hits: true, namespace: argv.namespace ?? null },
    intended: {
      note: argv.note, reviewer, classification,
      evidence_ref: argv['classification-evidence'] ?? null,
      select_reference: String(argv['select-reference'] ?? 'true') === 'true',
      review_status: wantReviewStatus,
    },
    target_row_before: beforeRow ? serializeTargetRow(beforeRow) : null,
    target_row_after: edit.after ? serializeTargetRow(edit.after) : null,
    edit_checks: edit.checks, verification, verification_failed: failed,
    ok: mutation.state === 'confirmed' && failed.length === 0,
    note: '显式编辑：身份由查询命中 + 显式选择共同确定；证据/状态/操作者原样带入并复读核对；写入与读回分开记账。',
  };
  if (writeReceipt) writeJson(path.join(dir, 'edit-receipt.json'), receipt);
  log(`edit: row_id=${resolved.selected_row_id} ok=${receipt.ok} mutation=${mutation.state} accepted=${mutation.write_accepted} confirmed=${mutation.confirmed} state=${wantState ?? 'preserved'} review_status=${wantReviewStatus ?? 'preserved'} reviewer=${reviewer} failed=${JSON.stringify(failed)}`);
  if (!receipt.ok) process.exitCode = 13;
  return receipt;
}

async function cmdExport() {
  // R8-STEP3：导出是**只读快照**。它只读**已存在目标**的全部五张表最终行，写出 schema/views/rules/data
  // 契约；**不**导入、**不**建表建字段、**不**编辑、**不**复跑、**不**准备夹具。
  const { rules } = await loadAll();
  const openRes = await openTargetOrFail('export', 'portable');
  if (!openRes.opened) return openRes.receipt;
  const opened = openRes.opened;
  const dir = ensureDir(path.join(OUT, 'portable'));
  const bundlePath = argv['bundle'] ? path.resolve(String(argv['bundle'])) : path.join(dir, 'material-library-bundle.json');
  const publication = resolveMediaPublication(argv);

  const data = {};
  for (const t of ALL_TABLES) data[t] = await opened.backend.listAllRows(t);
  const keySets = Object.fromEntries(ALL_TABLES.map((t) => {
    const pk = TABLE_PRIMARY_KEY[t];
    return [t, data[t].map((r) => String(r?.[pk])).sort()];
  }));
  const counts = Object.fromEntries(ALL_TABLES.map((t) => [t, data[t].length]));

  // 可选的“选中行”声明：一旦声明就必须真的在快照里（否则显式失败，不伪造 selected-row 成功）。
  // R9-STEP3.1：row-id 与 entity-key **同时给出时必须指向同一唯一行**；冲突即拒绝。
  const wantedKey = argv['entity-key'] ?? null;
  const wantedRowId = argv['row-id'] ?? null;
  const pkVideos = TABLE_PRIMARY_KEY[TABLE_VIDEOS];
  let selectedRow = null;
  const problems = [];
  let keyMatch = null, idMatch = null;
  if (wantedKey !== null) {
    const m = data[TABLE_VIDEOS].filter((r) => String(r?.[pkVideos]) === String(wantedKey));
    if (m.length === 0) problems.push('selected_entity_key_not_in_snapshot');
    else if (m.length > 1) problems.push('selected_entity_key_ambiguous_in_snapshot');
    else keyMatch = m[0];
  }
  if (wantedRowId !== null) {
    const m = data[TABLE_VIDEOS].filter((r) => String(r.id) === String(wantedRowId));
    if (m.length === 0) problems.push('selected_row_id_not_in_snapshot');
    else if (m.length > 1) problems.push('selected_row_id_ambiguous_in_snapshot');
    else idMatch = m[0];
  }
  if (keyMatch && idMatch) {
    if (String(keyMatch.id) !== String(idMatch.id)) problems.push(`conflicting_selection:row_id=${wantedRowId}≠entity_key=${wantedKey}`);
    else selectedRow = keyMatch;
  } else {
    selectedRow = keyMatch ?? idMatch ?? null;
  }
  const selectionCheck = {
    row_id_supplied: wantedRowId !== null, entity_key_supplied: wantedKey !== null,
    both_supplied: wantedRowId !== null && wantedKey !== null,
    consistent: keyMatch && idMatch ? String(keyMatch.id) === String(idMatch.id) : null,
    resolved_row_id: selectedRow?.id ?? null, resolved_entity_key: selectedRow ? selectedRow[pkVideos] : null,
  };
  const selectedAssets = selectedRow ? data[TABLE_ASSETS].filter((a) => a.entity_key === selectedRow[TABLE_PRIMARY_KEY[TABLE_VIDEOS]]) : [];
  const selectedSegments = selectedRow ? data[TABLE_SEGMENTS].filter((s) => s.entity_key === selectedRow[TABLE_PRIMARY_KEY[TABLE_VIDEOS]]) : [];

  const bundle = {
    bundle_version: ADAPTER_VERSION,
    schema: planSchema(),
    views: planViews(),
    rules_config: rules,
    created_at: new Date().toISOString(),
    snapshot: {
      source: targetDescriptor(opened),
      read_only: true,
      counts,
      table_key_sets: keySets,
      selected_row: selectedRow ? serializeTargetRow(selectedRow) : null,
      selected_media: {
        assets: selectedAssets.map((a) => ({ asset_id: a.asset_id, media_view_url: a.media_view_url ?? null, media_view_path: a.media_view_path ?? null, media_service_state: a.media_service_state ?? null })),
        segments: selectedSegments.map((s) => ({ segment_id: s.segment_id, view_url: s.view_url ?? null, view_path: s.view_path ?? null, media_service_state: s.media_service_state ?? null })),
      },
      media_service: publication.receipt,
    },
    data,
    note: '只读快照：schema/views/rules + **从既有目标读回的全部最终行**。恢复必须从本文件的**磁盘字节**重新解析（见 restore）。',
  };
  writeJson(bundlePath, bundle);
  const bytes = fs.readFileSync(bundlePath);

  const receipt = {
    adapter: ADAPTER_VERSION, at: new Date().toISOString(), command: 'export',
    target: targetDescriptor(opened),
    read_only: true, mutated: false, writes_attempted: 0, writes_performed: 0, writes_confirmed: 0,
    bundle_path: bundlePath, bundle_bytes: bytes.length, bundle_sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    counts, table_key_sets: keySets,
    selection: selectionCheck,
    selected_row_id: selectedRow?.id ?? null, selected_entity_key: selectedRow ? selectedRow[TABLE_PRIMARY_KEY[TABLE_VIDEOS]] : null,
    media_service: publication.receipt,
    problems, ok: problems.length === 0,
    steps: [{ step: 'list_existing_rows', ok: true, tables: counts }, { step: 'write_bundle', ok: true, path: bundlePath }],
    note: '只读导出：未导入、未建结构、未编辑、未复跑；行数据来自既有目标的读回；row-id 与 entity-key 同时给出时必须指向同一行。',
  };
  writeJson(path.join(dir, 'export-receipt.json'), receipt);
  log(`export: read_only=true target=${opened.target_mode} counts=${JSON.stringify(counts)} bundle=${bytes.length}B`);
  log(`export: selected=${receipt.selected_row_id ?? 'none'} problems=${JSON.stringify(problems)} sha256=${receipt.bundle_sha256.slice(0, 12)}…`);
  log(`wrote ${bundlePath}`);
  if (!receipt.ok) process.exitCode = 14;
  return receipt;
}

/** 校验恢复目标必须落在授权根内（写前校验；默认 O/tests-tmp）。 */
function assertRestoreRoot(dir) {
  const resolved = path.resolve(dir).replace(/\\/g, '/');
  const O = path.resolve(OUT).replace(/\\/g, '/');
  const W = path.resolve(O, '..', '..').replace(/\\/g, '/');
  const allowed = [
    `${W}/tools/material-library`,
    `${W}/docs/product-material-library`,
    O,
    `${W}/harness-reports`,
  ].map((p) => p.toLowerCase());
  if (!allowed.some((a) => resolved.toLowerCase() === a || resolved.toLowerCase().startsWith(a + '/'))) {
    throw new Error(`restore_target_outside_authorized_roots:${resolved}`);
  }
  return resolved;
}

async function cmdRestore() {
  // R8-STEP3：从**磁盘字节**重新打开 bundle（不闭包复用内存数据、解析失败不回落内存），
  // 把解码后的行恢复进**隔离**内存后端（默认 O/tests-tmp/restore-<ts>），并逐项核对：
  // 五表键集合/计数、必需关联、选中行的人工/分类值·状态·来源、资产身份与片段 URL。
  const dir = ensureDir(path.join(OUT, 'restore'));
  const bundlePath = argv.bundle ? path.resolve(String(argv.bundle)) : path.join(OUT, 'portable', 'material-library-bundle.json');
  const receipt = {
    adapter: ADAPTER_VERSION, at: new Date().toISOString(), command: 'restore',
    bundle_path: bundlePath, read_only: true, mutated: false, writes_performed: 0, ok: false, findings: [],
  };
  if (!fs.existsSync(bundlePath)) {
    receipt.findings.push({ level: 'fail', id: 'bundle_missing', path: bundlePath });
    writeJson(path.join(dir, 'restore-receipt.json'), receipt);
    log(`restore: FAIL bundle_missing ${bundlePath}`);
    process.exitCode = 15;
    return receipt;
  }
  const bytes = fs.readFileSync(bundlePath);
  receipt.bundle_bytes = bytes.length;
  receipt.bundle_sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  let bundle = null;
  try { bundle = JSON.parse(bytes.toString('utf8')); } catch (e) {
    receipt.findings.push({ level: 'fail', id: 'bundle_unparseable', error: String(e.message).slice(0, 200) });
    writeJson(path.join(dir, 'restore-receipt.json'), receipt);
    log('restore: FAIL bundle_unparseable（未回落内存数据）');
    process.exitCode = 15;
    return receipt;
  }
  // 结构自证：必须是本工具写出的快照契约
  if (!bundle.snapshot || !bundle.data || !bundle.schema) {
    receipt.findings.push({ level: 'fail', id: 'bundle_contract_missing', has: Object.keys(bundle) });
  }
  const restoreRoot = assertRestoreRoot(argv['restore-into'] ?? path.join(OUT, 'tests-tmp', `restore-${Date.now()}`));
  ensureDir(restoreRoot);
  const restored = createMemoryBackend();
  for (const t of ALL_TABLES) await restored.createTable(t);
  const restoreErrors = [];
  for (const t of [TABLE_VIDEOS, TABLE_ASSETS, TABLE_SEGMENTS, TABLE_METRICS, TABLE_RATIOS]) {
    for (const row of bundle?.data?.[t] ?? []) {
      try { await restored.insertRow(t, row); } catch (e) { restoreErrors.push({ table: t, key: row?.[TABLE_PRIMARY_KEY[t]], error: String(e.message) }); }
    }
  }
  if (restoreErrors.length) receipt.findings.push({ level: 'fail', id: 'restore_insert_errors', detail: restoreErrors.slice(0, 5) });

  const restoredRows = {};
  const restoredKeys = {};
  for (const t of ALL_TABLES) {
    restoredRows[t] = await restored.listAllRows(t);
    restoredKeys[t] = restoredRows[t].map((r) => String(r?.[TABLE_PRIMARY_KEY[t]])).sort();
  }
  const expectedKeys = bundle?.snapshot?.table_key_sets ?? {};
  const expectedCounts = bundle?.snapshot?.counts ?? {};
  for (const t of ALL_TABLES) {
    const want = expectedKeys[t] ?? [];
    const got = restoredKeys[t];
    if (JSON.stringify(want) !== JSON.stringify(got)) {
      receipt.findings.push({ level: 'fail', id: 'table_key_set_mismatch', table: t, expected_count: want.length, actual_count: got.length, missing: want.filter((k) => !got.includes(k)).slice(0, 5), unexpected: got.filter((k) => !want.includes(k)).slice(0, 5) });
    }
    // R9-STEP3.3：计数也要单独核对（键集合相同但重复行折叠的情况）
    if (expectedCounts[t] !== undefined && Number(expectedCounts[t]) !== restoredRows[t].length) {
      receipt.findings.push({ level: 'fail', id: 'table_count_mismatch', table: t, expected: Number(expectedCounts[t]), actual: restoredRows[t].length });
    }
  }
  // 必需关联：link_row 指向的目标必须是**身份正确**的那一行（不是“任意存在的行 ID”）
  const videoIdByKey = new Map(restoredRows[TABLE_VIDEOS].map((r) => [String(r[TABLE_PRIMARY_KEY[TABLE_VIDEOS]]), String(r.id)]));
  const assetRowIdByAssetId = new Map(restoredRows[TABLE_ASSETS].map((r) => [String(r.asset_id), String(r.id)]));
  for (const [t, fields] of Object.entries(LINK_FIELDS)) {
    for (const row of restoredRows[t]) {
      for (const [field, targetTable] of Object.entries(fields)) {
        const ids = (row[field] ?? []).map((x) => String(x && typeof x === 'object' ? x.id : x));
        if (!ids.length) { receipt.findings.push({ level: 'fail', id: 'required_relation_missing', table: t, key: row[TABLE_PRIMARY_KEY[t]], field }); continue; }
        const expectedTargetId = targetTable === TABLE_VIDEOS
          ? videoIdByKey.get(String(row.entity_key)) ?? null
          : targetTable === TABLE_ASSETS
            ? assetRowIdByAssetId.get(String(row.asset_id)) ?? null
            : null;
        if (expectedTargetId === null) {
          receipt.findings.push({ level: 'fail', id: 'relation_expected_target_missing', table: t, key: row[TABLE_PRIMARY_KEY[t]], field, own_identity: targetTable === TABLE_VIDEOS ? row.entity_key : row.asset_id });
          continue;
        }
        if (ids.length !== 1 || ids[0] !== expectedTargetId) {
          receipt.findings.push({ level: 'fail', id: 'relation_target_identity_mismatch', table: t, key: row[TABLE_PRIMARY_KEY[t]], field, expected_target_id: expectedTargetId, actual_target_ids: ids });
        }
      }
    }
  }
  // 选中行：人工/分类值·状态·来源 + 资产身份 + 片段 URL
  const exp = bundle?.snapshot?.selected_row ?? null;
  if (exp) {
    const got = restoredRows[TABLE_VIDEOS].find((r) => String(r.id) === String(exp.row_id)) ?? null;
    if (!got) receipt.findings.push({ level: 'fail', id: 'selected_row_missing_after_restore', row_id: exp.row_id });
    else {
      const actualOf = (row, f) => (f === 'row_id' ? (row.id ?? null) : (row[f] ?? null));
      const compare = Object.keys(exp).map((f) => ({ field: f, expected: exp[f] ?? null, actual: actualOf(got, f), ok: JSON.stringify(actualOf(got, f)) === JSON.stringify(exp[f] ?? null) }));
      const bad = compare.filter((c) => !c.ok);
      if (bad.length) receipt.findings.push({ level: 'fail', id: 'selected_row_field_mismatch', detail: bad.slice(0, 8) });
      receipt.selected_row_compare = { compared: compare.length, mismatches: bad.length };
    }
    const expAssets = bundle?.snapshot?.selected_media?.assets ?? [];
    for (const a of expAssets) {
      const got = restoredRows[TABLE_ASSETS].find((r) => String(r.asset_id) === String(a.asset_id)) ?? null;
      if (!got) { receipt.findings.push({ level: 'fail', id: 'selected_asset_missing_after_restore', asset_id: a.asset_id }); continue; }
      if ((got.media_view_url ?? null) !== (a.media_view_url ?? null)) receipt.findings.push({ level: 'fail', id: 'asset_media_url_mismatch', asset_id: a.asset_id, expected: a.media_view_url ?? null, actual: got.media_view_url ?? null });
      if ((got.media_view_path ?? null) !== (a.media_view_path ?? null)) receipt.findings.push({ level: 'fail', id: 'asset_media_path_mismatch', asset_id: a.asset_id, expected: a.media_view_path ?? null, actual: got.media_view_path ?? null });
      if ((got.media_service_state ?? null) !== (a.media_service_state ?? null)) receipt.findings.push({ level: 'fail', id: 'asset_media_state_mismatch', asset_id: a.asset_id, expected: a.media_service_state ?? null, actual: got.media_service_state ?? null });
    }
    for (const s of bundle?.snapshot?.selected_media?.segments ?? []) {
      const got = restoredRows[TABLE_SEGMENTS].find((r) => String(r.segment_id) === String(s.segment_id)) ?? null;
      if (!got) { receipt.findings.push({ level: 'fail', id: 'selected_segment_missing_after_restore', segment_id: s.segment_id }); continue; }
      if ((got.view_url ?? null) !== (s.view_url ?? null)) receipt.findings.push({ level: 'fail', id: 'segment_view_url_mismatch', segment_id: s.segment_id, expected: s.view_url ?? null, actual: got.view_url ?? null });
      if ((got.view_path ?? null) !== (s.view_path ?? null)) receipt.findings.push({ level: 'fail', id: 'segment_view_path_mismatch', segment_id: s.segment_id, expected: s.view_path ?? null, actual: got.view_path ?? null });
      if ((got.media_service_state ?? null) !== (s.media_service_state ?? null)) receipt.findings.push({ level: 'fail', id: 'segment_media_state_mismatch', segment_id: s.segment_id, expected: s.media_service_state ?? null, actual: got.media_service_state ?? null });
    }
  } else {
    receipt.findings.push({ level: 'info', id: 'snapshot_has_no_selected_row', note: '快照未声明选中行 → 只核对五表键集合/计数与关联，不伪造 selected-row 成功。' });
  }
  receipt.restored_counts = Object.fromEntries(ALL_TABLES.map((t) => [t, restoredRows[t].length]));
  receipt.expected_counts = bundle?.snapshot?.counts ?? null;
  receipt.media_service_declared = bundle?.snapshot?.media_service ?? null;
  receipt.restore_root = restoreRoot;
  receipt.restore_errors = restoreErrors;
  receipt.ok = !receipt.findings.some((f) => f.level === 'fail');
  writeJson(path.join(dir, 'restore-receipt.json'), receipt);
  log(`restore: ok=${receipt.ok} findings=${receipt.findings.filter((f) => f.level === 'fail').length} counts=${JSON.stringify(receipt.restored_counts)} bundle_sha=${receipt.bundle_sha256.slice(0, 12)}…`);
  if (!receipt.ok) process.exitCode = 15;
  return receipt;
}

async function cmdVerify() {
  const { rules, records, gaps, reconciliation } = await loadAll();
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok: !!ok, detail });

  add('reconcile_main_v_8420', reconciliation.actual_main_v === 8420, `actual=${reconciliation.actual_main_v}`);
  add('reconcile_aid_v_222_separate', reconciliation.actual_aid_v === 222 && records.filter((r) => r.aid_branch).length === 222, `aid=${reconciliation.actual_aid_v}`);

  // 长 ID：超过 JS 安全整数范围的纯数字 id 必须原样字符串保留（不得经 Number 丢失精度）
  const SAFE = 9007199254740991n;
  const digitIds = records.filter((r) => /^[0-9]+$/.test(r.native_id));
  const longIds = digitIds.filter((r) => BigInt(r.native_id) > SAFE);
  const longOk = longIds.length > 0 && longIds.every((r) =>
    typeof r.native_id === 'string' && BigInt(r.native_id).toString() === r.native_id);
  const numberLossy = longIds.filter((r) => String(Number(r.native_id)) !== r.native_id).length;
  add('long_id_exceeds_2pow53_preserved_as_string', longOk,
    `digit_ids=${digitIds.length} over_2pow53=${longIds.length} sample=${longIds[0]?.native_id ?? 'n/a'} number_roundtrip_lossy=${numberLossy}/${longIds.length}`);
  const nonNumericIds = records.filter((r) => !/^[0-9]+$/.test(r.native_id));
  add('non_numeric_ids_kept_verbatim', nonNumericIds.every((r) => typeof r.native_id === 'string' && r.native_id.length > 0),
    `count=${nonNumericIds.length} sample=${nonNumericIds[0]?.native_id ?? 'n/a'}`);

  // 身份保真：归一化后的 native_id 必须与保留证据中的原始值逐字符一致
  {
    const byKey = new Map(records.map((r) => [r.entity_key, r]));
    let checked = 0, mismatchCount = 0;
    const rl = (await import('node:readline')).createInterface({ input: fs.createReadStream(P.entityDecisions, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      const rec = byKey.get(`${r.platform}|${r.namespace}|${r.native_id}`);
      if (!rec) continue;
      checked++;
      if (rec.native_id !== String(r.native_id)) mismatchCount++;
    }
    rl.close();
    add('identity_fidelity_vs_retained_evidence', mismatchCount === 0 && checked > 8000, `checked=${checked} mismatches=${mismatchCount}`);
  }

  // 命名空间隔离：同平台同 id 文本在不同 namespace 下必须是不同实体
  const keySet = new Set(records.map((r) => r.entity_key));
  add('namespace_isolation_keys_distinct', keySet.size === records.length, `unique_keys=${keySet.size}/${records.length}`);

  // 缺失 ≠ 0
  const zeroAndAbsent = records.filter((r) => r.metrics.some((m) => m.status === 'observed_zero') && r.metrics.some((m) => m.status === 'absent'));
  add('zero_and_absent_distinguishable', zeroAndAbsent.length > 0, `entities_with_both=${zeroAndAbsent.length}`);
  const absentHasValue = records.some((r) => r.metrics.some((m) => m.status === 'absent' && m.value !== null));
  add('absent_never_carries_value', !absentHasValue, `violations=${absentHasValue}`);

  // 比率：分母为 0 或不支持时不得产生分数
  const ratios = records.flatMap((r) => r.ratios);
  const badRatio = ratios.filter((x) => x.status !== 'computed' && x.value !== null);
  add('unsupported_ratio_has_no_value', badRatio.length === 0, `violations=${badRatio.length}`);
  const computed = ratios.filter((x) => x.status === 'computed');
  add('tiktok_ratio_computed_on_same_observation', computed.every((x) => x.observation_group), `computed=${computed.length}`);

  // 缺媒体显式
  add('missing_media_explicit', records.every((r) => Array.isArray(r.assets)), 'assets array always present (empty = explicit absence)');

  // 既有媒体：路径两级解析（manifest → card）后必须全部落实且哈希复核一致
  {
    const recWithAssets = records.filter((r) => r.assets.length > 0);
    const allAssets = recWithAssets.flatMap((r) => r.assets);
    const resolved = allAssets.filter((a) => a.local_path);
    const hashed = allAssets.filter((a) => a.sha256_match === true);
    const fromCard = allAssets.filter((a) => a.manifest_media_null_resolved_from_card).length;
    add('existing_media_resolved_and_hash_verified',
      allAssets.length > 0 && resolved.length === allAssets.length && hashed.length === allAssets.length,
      `linked_assets=${allAssets.length} resolved=${resolved.length} hash_verified=${hashed.length} resolved_via_card=${fromCard}`);
    // 路径必须是绝对路径：相对路径依赖 cwd，换消费者即失效
    const notAbs = allAssets.filter((a) => a.path_is_absolute !== true);
    add('asset_paths_absolute', allAssets.length > 0 && notAbs.length === 0, `assets=${allAssets.length} non_absolute=${notAbs.length}`);
    // 图像绝不当作视频（成果总览 §阅读陷阱 第2条：抖音卡 media_evidence 指向接触表）
    const badKind = allAssets.filter((a) => a.usable_as_video === true && a.media_kind !== 'video');
    const videos = allAssets.filter((a) => a.media_kind === 'video').length;
    add('image_never_used_as_video', badKind.length === 0, `assets=${allAssets.length} video_kind=${videos} misclassified=${badKind.length}`);
  }

  // 与已验收 r629 的 216 字段行逐字段对账：本导入链必须精确复现已验收基线，
  // 否则说明成员范围或可用性判定偏离了已接受的普查口径。
  {
    const cp = JSON.parse(fs.readFileSync(P.checkpointR629, 'utf8'));
    const fr = cp.field_readiness_by_branch ?? {};
    const CENSUS_TO_FIELD = {
      canonical_url_retained: 'canonical_url',
      derived_permalink_not_visited: 'derived_permalink',
      publication_time_label_only: 'publication_time_label',
      engagement_play_or_view: 'engagement_play',
      author_follower_count_not_engagement: 'author_follower_count',
      product_tag_or_eligibility_not_sales: 'product_tag_or_eligibility',
      product_price_not_sales: 'product_price',
    };
    const fieldName = (k) => CENSUS_TO_FIELD[k] ?? k;
    const usableBy = new Map();   // "branch|field" -> #V members with a usable value
    const noSourceBy = new Map(); // branch -> #V members with no retained source
    for (const r of records) {
      const b = `${r.platform}|${r.namespace}`;
      if (r.availability.entity_source_state !== 'observed') noSourceBy.set(b, (noSourceBy.get(b) ?? 0) + 1);
      const seen = new Set();
      for (const m of r.metrics) if (m.status === OBSERVATION_STATUS.VALUE || m.status === OBSERVATION_STATUS.OBSERVED_ZERO) seen.add(m.field);
      for (const f of seen) { const k = `${b}|${f}`; usableBy.set(k, (usableBy.get(k) ?? 0) + 1); }
    }
    let checked = 0; const mismatches = []; const noSourceMismatches = [];
    for (const [branch, v] of Object.entries(fr)) {
      for (const [kind, d] of Object.entries(v.fields ?? {})) {
        const expected = d.over_V?.usable ?? 0;
        const got = usableBy.get(`${branch}|${fieldName(kind)}`) ?? 0;
        checked++;
        if (expected !== got) mismatches.push({ branch, field: kind, expected, got });
      }
      const expNoSrc = v.V_denominator && v.source_unavailable_for_this_branch
        ? (Object.values(v.fields ?? {})[0]?.over_V?.unavailable_no_retained_source ?? 0) : null;
      if (expNoSrc !== null) {
        const gotNoSrc = noSourceBy.get(branch) ?? 0;
        if (expNoSrc !== gotNoSrc) noSourceMismatches.push({ branch, expected: expNoSrc, got: gotNoSrc });
      }
    }
    add('reconciled_against_r629_field_readiness', checked > 200 && mismatches.length === 0 && noSourceMismatches.length === 0,
      `field_rows_checked=${checked} field_mismatches=${mismatches.length} no_source_mismatches=${noSourceMismatches.length} sample=${JSON.stringify(mismatches.slice(0, 4))}${JSON.stringify(noSourceMismatches.slice(0, 3))}`);
  }

  // 事实来源分层 + error 状态自洽（A5：来源事实 / 派生 / 人工三者分开）
  {
    const all = records.flatMap((r) => r.metrics);
    const badOrigin = all.filter((m) => !['source_fact', 'derived'].includes(m.fact_origin));
    const errRows = all.filter((m) => m.status === OBSERVATION_STATUS.ERROR);
    const errNoReason = errRows.filter((m) => !m.error_reason);
    const reasonNotErr = all.filter((m) => m.status !== OBSERVATION_STATUS.ERROR && m.error_reason);
    const origins = all.reduce((a, m) => (a[m.fact_origin] = (a[m.fact_origin] ?? 0) + 1, a), {});
    add('fact_origin_and_error_state_consistent',
      badOrigin.length === 0 && errNoReason.length === 0 && reasonNotErr.length === 0,
      `observations=${all.length} origins=${JSON.stringify(origins)} error_rows=${errRows.length} error_without_reason=${errNoReason.length} reason_without_error=${reasonNotErr.length}`);
  }

  // 联合可用性必须**实测**，不得用边际最小值构造（r631 §1.6 明确禁止构造联合覆盖率）。
  // 扫描若干字段对，找出「实测联合 < min(边际)」的反例——这正是构造法会出错的地方。
  {
    const CANDIDATES = ['publication_time', 'engagement_like', 'engagement_play', 'engagement_comment',
      'engagement_share', 'engagement_collect', 'canonical_url', 'geography_or_region',
      'author_follower_count', 'duration', 'language'];
    const isUsable = (m) => m.status === OBSERVATION_STATUS.VALUE || m.status === OBSERVATION_STATUS.OBSERVED_ZERO;
    const main = records.filter((r) => !r.aid_branch);
    const n = main.length;
    const usableSets = new Map();
    for (const r of main) {
      const s = new Set();
      for (const m of r.metrics) if (isUsable(m)) s.add(m.field);
      usableSets.set(r.entity_key, s);
    }
    const marginal = (f) => [...usableSets.values()].filter((s) => s.has(f)).length;
    const mar = Object.fromEntries(CANDIDATES.map((f) => [f, marginal(f)]));
    let best = null;
    for (let i = 0; i < CANDIDATES.length; i++) {
      for (let j = i + 1; j < CANDIDATES.length; j++) {
        const [a, b] = [CANDIDATES[i], CANDIDATES[j]];
        if (mar[a] === 0 || mar[b] === 0) continue;
        const joint = [...usableSets.values()].filter((s) => s.has(a) && s.has(b)).length;
        const minConstructed = Math.min(mar[a], mar[b]);
        const lower = Math.max(0, mar[a] + mar[b] - n);
        const inBounds = joint <= minConstructed && joint >= lower;
        const gap = minConstructed - joint;
        if (!inBounds) { best = { a, b, joint, minConstructed, lower, gap, inBounds }; break; }
        if (!best || gap > best.gap) best = { a, b, joint, minConstructed, lower, gap, inBounds };
      }
    }
    add('joint_availability_measured_not_constructed', !!best && best.inBounds,
      `main_v=${n} most_divergent_pair=${best ? best.a + '+' + best.b : 'n/a'} marginals=${best ? best.minConstructed : 'n/a'} JOINT_MEASURED=${best?.joint} would_be_if_min_constructed=${best?.minConstructed} gap=${best?.gap} (gap>0 证明构造法会出错)`);
  }
  // 时间片段引用：必须带来源与种类，且引用时刻在本地媒体中可达（最小本地补充已实测）
  {
    const withSeg = records.filter((r) => r.assets.some((a) => (a.segments ?? []).length > 0));
    const allSeg = withSeg.flatMap((r) => r.assets.flatMap((a) => (a.segments ?? []).map((s) => ({ ...s, asset: a }))));
    const missingOrigin = allSeg.filter((s) => !s.origin_card || !s.kind || !s.fact_origin || !s.coverage);
    const noSeconds = allSeg.filter((s) => s.start_seconds === null);
    add('segment_references_carry_origin_kind_and_coverage',
      allSeg.length > 0 && missingOrigin.length === 0,
      `segments=${allSeg.length} assets_with_segments=${withSeg.length} missing_origin_or_kind=${missingOrigin.length} without_start_seconds=${noSeconds.length}`);

    const seekPath = path.join(OUT, 'segments', 'seek-verification.json');
    if (fs.existsSync(seekPath)) {
      const sv = JSON.parse(fs.readFileSync(seekPath, 'utf8'));
      // F6：退出码 0 不算证据；必须实际解出帧、解码时刻在一帧内、真实写出并通过校验的帧图
      add('segment_times_decoded_and_frames_verified',
        sv.segments_checked > 0 && sv.decoded_frame_missing === 0
        && sv.decoded_within_one_frame === sv.segments_checked
        && sv.frames_written > 0 && sv.frames_verified_png === sv.frames_written
        && sv.out_of_duration === 0,
        `checked=${sv.segments_checked} decoded=${sv.decoded_frame_observed} missing=${sv.decoded_frame_missing} within_one_frame=${sv.decoded_within_one_frame} png_ok=${sv.frames_verified_png}/${sv.frames_written} out_of_duration=${sv.out_of_duration}`);
    } else {
      add('segment_times_decoded_and_frames_verified', false, 'segments/seek-verification.json 缺失：请先运行 cli.mjs segments');
    }
  }

  // P4：筛选维度覆盖（R2 STEP5 要求 platform/language/date/review-status；product·function 无来源支持）
  {
    const views = planViews();
    const videoViews = views.filter((v) => v.table === TABLE_VIDEOS);
    const fields = new Set(videoViews.flatMap((v) => (v.filters ?? []).map((f) => f.field)));
    const required = ['platform', 'language', 'publish_date_epoch_s', 'review_status', 'product_category'];
    const missing = required.filter((f) => !fields.has(f));
    const noFilterUniverse = videoViews.some((v) => !(v.filters ?? []).length);
    add('p4_filter_views_cover_required_dimensions',
      missing.length === 0 && noFilterUniverse && views.length >= 13,
      `views=${views.length} video_views=${videoViews.length} filter_fields=[${[...fields].sort().join(',')}] missing=[${missing.join(',')}] unfiltered_universe_view=${noFilterUniverse}`);
  }

  // P4 详情：每条观测必须带指标定义（口径），否则详情无法说明「这个数是什么」
  {
    const all = records.flatMap((r) => r.metrics);
    const noDef = all.filter((m) => !m.metric_definition);
    const comparableTrue = all.filter((m) => m.comparable_across_platforms !== false);
    add('metric_definitions_present_and_not_cross_comparable',
      noDef.length === 0 && comparableTrue.length === 0,
      `observations=${all.length} without_definition=${noDef.length} claimed_cross_platform_comparable=${comparableTrue.length}`);
  }

  // P4/A5 用户旅程回执：两种**真实**形状都要核（R8 起默认路径是只读查询既有目标）：
  //  ① R8 只读形状：命中来自目标库行（scanned>0 且 hit_count>=1）、只读则 writes=0、显式编辑则编辑回执 ok；
  //  ② 隔离夹具演示形状（7 步）：沿用原有断言（第 7 步目标库只读查询 + 未命中探针）。
  {
    const jp = path.join(OUT, 'journey', 'journey-transcript.json');
    if (fs.existsSync(jp)) {
      const j = JSON.parse(fs.readFileSync(jp, 'utf8'));
      if (Array.isArray(j.steps) && j.steps.length > 0) {
        const steps = j.steps.map((s) => s.step);
        const s7 = (j.steps ?? []).find((s) => s.step === 7) ?? {};
        const lk = s7.lookup ?? {};
        const targetBacked = (lk.scanned_rows ?? 0) > 0 && lk.mutated === false && typeof lk.backend_kind === 'string';
        const honestNoMatch = s7.no_match_lookup ? s7.no_match_lookup.hit_count === 0 : false;
        const ok = (j.candidate_count ?? 0) > 0 && steps.length >= 7 && j.baserow_ui_verified === false && targetBacked && honestNoMatch;
        add('user_journey_transcript_complete', ok,
          `shape=fixture_demo candidates=${j.candidate_count} steps=${steps.join(',')} chosen=${j.chosen_entity_key} baserow_ui_verified=${j.baserow_ui_verified} lookup_scanned=${lk.scanned_rows} lookup_mutated=${lk.mutated} lookup_hits=${lk.hit_count} no_match_hits=${s7.no_match_lookup?.hit_count}`);
      } else {
        const targetBacked = (j.scanned_rows ?? 0) > 0 && (j.hit_count ?? 0) >= 1 && typeof j.target?.backend_kind === 'string';
        const writesHonest = j.read_only === true ? j.writes_performed === 0 : (j.edit_receipt?.ok === true);
        const ok = targetBacked && j.baserow_ui_verified === false && writesHonest && !!j.shown_identity && Array.isArray(j.problems) && j.problems.length === 0;
        add('user_journey_transcript_complete', ok,
          `shape=readonly_target_query target=${j.target?.target_mode}/${j.target?.backend_kind} scanned=${j.scanned_rows} hits=${j.hit_count} read_only=${j.read_only} writes=${j.writes_performed} edit_ok=${j.edit_receipt ? j.edit_receipt.ok : 'n/a'} shown=${j.shown_identity} problems=${JSON.stringify(j.problems ?? null)}`);
      }
    } else {
      add('user_journey_transcript_complete', false, 'journey/journey-transcript.json 缺失：请先运行 cli.mjs journey');
    }
  }

  // F1/F3：五张表（含 Segments）必须真的写入，且 HTTP 回执不得在无写入时声称成功
  {
    const mr = path.join(OUT, 'import', 'memory-receipt.json');
    if (fs.existsSync(mr)) {
      const j = JSON.parse(fs.readFileSync(mr, 'utf8'));
      const t = j.first?.tables ?? {};
      const missingTables = ALL_TABLES.filter((x) => !(x in t));
      add('all_five_tables_written_in_import',
        missingTables.length === 0 && (t[TABLE_SEGMENTS]?.inserted ?? 0) > 0,
        `tables=${Object.keys(t).join(',')} segments_inserted=${t[TABLE_SEGMENTS]?.inserted ?? 0} missing=[${missingTables.join(',')}]`);
    } else add('all_five_tables_written_in_import', false, 'import/memory-receipt.json 缺失');

    const hr = path.join(OUT, 'import', 'http-receipt.json');
    if (fs.existsSync(hr)) {
      const j = JSON.parse(fs.readFileSync(hr, 'utf8'));
      // 没有真实实例时：ok 必须为 false，且必须留下 import 步骤的缺失证据——不得 ping 成功即 ok
      const claimsOkWithoutImport = j.ok === true && !j.import;
      add('http_import_never_claims_success_without_writes', !claimsOkWithoutImport,
        `ok=${j.ok} has_import_block=${!!j.import} steps=${(j.steps ?? []).map((s) => s.step).join(',')}`);
    } else add('http_import_never_claims_success_without_writes', false, 'import/http-receipt.json 缺失');
  }

  // F4：人工分类受保护，且必须带来源归属/复核人/证据；F5：测试身份不得进入有效精选
  {
    const clsProtected = ['product_category', 'product_function', 'scene_or_need', 'product_category_origin']
      .every((f) => HUMAN_FIELDS.includes(f));
    const humanClassified = records.filter((r) => r.classification.product_category_origin === 'human_review');
    const wellFormed = humanClassified.every((r) => r.classification.product_category_reviewer && r.classification.product_category_evidence_ref && r.classification.product_category_state);
    add('human_classification_protected_and_evidence_bound',
      clsProtected && humanClassified.length > 0 && wellFormed,
      `protected=${clsProtected} human_classified=${humanClassified.length} all_have_reviewer_and_evidence=${wellFormed}`);

    const realOverlay = loadOverlay(root, null);
    const testEntries = Object.values(realOverlay.entries ?? {}).filter((v) => v.reviewer && ['journey-selftest', 'simon-selftest', 'harness-selftest'].includes(v.reviewer));
    const arch = path.join(OUT, 'human-review', 'selftest-archive-receipt.json');
    const archOk = fs.existsSync(arch) && JSON.parse(fs.readFileSync(arch, 'utf8')).extracted_test_entries >= 1;
    add('test_identity_annotations_excluded_from_effective_overlay',
      testEntries.length === 0 && archOk,
      `effective_test_entries=${testEntries.length} archive_receipt=${archOk}`);
  }

  // F2：路由必须存在于**已固定的 2.4.0 官方 OpenAPI** 中（离线核对；规范文件为本包只读留存）
  {
    const specPath = path.join(OUT, 'evidence', 'baserow-openapi-schema.json');
    if (fs.existsSync(specPath)) {
      const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
      const paths = spec.paths ?? {};
      const norm = (p) => p.replace(/\{[^}]+\}/g, '{x}');
      const idx = new Set(Object.keys(paths).map((p) => `${norm(p)}`));
      const missing = [];
      for (const [key, [method, tpl]] of Object.entries(HTTP_ROUTES)) {
        if (!idx.has(norm(tpl))) missing.push(`${key}:${method} ${tpl}`);
      }
      add('baserow_routes_exist_in_pinned_spec',
        spec.info?.version === '2.4.0' && missing.length === 0,
        `spec_version=${spec.info?.version} routes=${Object.keys(HTTP_ROUTES).length} missing=[${missing.join(' | ')}]`);
    } else {
      add('baserow_routes_exist_in_pinned_spec', false, 'evidence/baserow-openapi-schema.json 缺失：无法离线核对路由');
    }
  }

  // v5 字段合同对齐：每个实际出现的普查字段都必须有明确的对齐判定（不得「未映射」）
  {
    const observedFields = [...new Set(records.flatMap((r) => r.metrics.map((m) => m.field)))].sort();
    const unmapped = observedFields.filter((f) => v5MeaningFor(f).mapping === 'unmapped');
    const mapped = observedFields.filter((f) => v5MeaningFor(f).mapping === 'mapped').length;
    const noSlot = observedFields.filter((f) => v5MeaningFor(f).mapping === 'no_equivalent_slot').length;
    const ambiguous = observedFields.filter((f) => v5MeaningFor(f).mapping === 'ambiguous_multi_meaning');
    add('v5_meaning_mapping_complete', unmapped.length === 0,
      `observed_fields=${observedFields.length} mapped=${mapped} no_equivalent_slot=${noSlot} ambiguous=${ambiguous.map((f) => f).join(',') || 'none'} unmapped=${unmapped.join(',') || 'none'}`);
  }

  // 对账缺口必须有具体原因
  const gapNoReason = gaps.filter((g) => !g.reason_class);
  add('gaps_have_specific_reason', gapNoReason.length === 0, `gaps=${gaps.length} without_reason=${gapNoReason.length}`);

  // 幂等：同一输入复跑零新增
  const backend = createMemoryBackend();
  for (const t of ALL_TABLES) await backend.createTable(t);
  const subset = records.filter((r) => !r.aid_branch).slice(0, 200);
  await importRecords({ records: subset, backend, mode: 'memory_semantics_only' });
  const replay = await importRecords({ records: subset, backend, mode: 'memory_semantics_only' });
  add('idempotent_replay_zero_duplicates', replay.videos.inserted === 0 && replay.videos.updated === 0, `replay=${JSON.stringify(replay.videos)}`);

  // 人工字段保留 + 证据变化失效
  const target = subset[0];
  backend.putRow(TABLE_VIDEOS, target.entity_key, { ...backend.getRow(TABLE_VIDEOS, target.entity_key), review_notes: '人工备注：看起来是磁吸壳演示', review_status: 'reviewed' });
  const changed = { ...target, evidence_fingerprint: 'deadbeef' + target.evidence_fingerprint.slice(8) };
  const m = planMerge(rowsOf([changed])[TABLE_VIDEOS], backend.listRows(TABLE_VIDEOS));
  add('human_note_preserved_on_evidence_change', m.preserved_human_fields.some((x) => x.field === 'review_notes(kept_text)'), `preserved=${m.preserved_human_fields.length}`);
  add('evidence_change_marks_stale', m.stale.length === 1, `stale=${m.stale.length}`);
  const merged = m.updated[0]?.changed ?? {};
  add('stale_does_not_carry_approval_forward', merged.review_stale === true && merged.review_status === undefined, `stale=${merged.review_stale} review_status_touched=${merged.review_status !== undefined}`);

  // 中断恢复
  const rec = await reconcileInterrupted({ plannedKeys: subset.map((r) => r.entity_key).concat(['Fake|main|0']), backend });
  add('interrupted_write_reconciled_before_replay', rec.missing_count === 1 && rec.present_count === subset.length, `present=${rec.present_count} missing=${rec.missing_count}`);

  // 命名空间/平台不匹配拒绝
  const bad = planMerge([{ entity_key: target.entity_key, platform: target.platform, namespace: 'other', native_id: target.native_id }], backend.listRows(TABLE_VIDEOS));
  add('platform_namespace_mismatch_refused', bad.rejected.length === 1, `rejected=${JSON.stringify(bad.rejected)}`);

  const dir = ensureDir(path.join(OUT, 'verify'));
  const summary = { adapter: ADAPTER_VERSION, rules_version: rules.rules_version, checks, passed: checks.filter((c) => c.ok).length, failed: checks.filter((c) => !c.ok).length, all_passed: checks.every((c) => c.ok), baserow_verified: false,
    interpretation: '自验仅覆盖归一化/合并语义与真实源对账；Baserow 实例与 UI 未验证（本机无容器运行时）。' };
  writeJson(path.join(dir, 'self-check.json'), summary);
  for (const c of checks) log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.detail}`);
  log(`verify: passed=${summary.passed} failed=${summary.failed}`);
  if (!summary.all_passed) process.exitCode = 4;
}

async function cmdReview() {
  const { records } = await loadAll();
  const dir = ensureDir(path.join(OUT, 'human-review'));
  // F5：默认写正式覆盖层；--overlay 可指向隔离夹具（测试用），并在回执中显式区分
  const targetOverlay = argv.overlay ?? null;
  const overlay = loadOverlay(root, targetOverlay);
  const before = JSON.parse(JSON.stringify(overlay));
  const key = argv['entity-key'];
  const rec = records.find((r) => r.entity_key === key);
  if (!rec) throw new Error(`unknown_entity_key:${key}`);
  // F4：可同时写入人工产品/功能/场景分类（必须带复核人与证据引用）
  let classification = null;
  if (argv['product-category'] || argv['product-function'] || argv['scene-or-need']) {
    classification = {
      product_category: argv['product-category'],
      product_function: argv['product-function'],
      scene_or_need: argv['scene-or-need'],
      state: argv['classification-state'],
    };
  }
  const next = setReview({
    entityKey: key,
    status: argv.status,
    reviewer: argv.reviewer,
    category: argv.category,
    note: argv.note,
    selectReference: argv['select-reference'] === undefined ? undefined : String(argv['select-reference']) === 'true',
    basedOn: argv['based-on'],
    classification,
    classificationEvidenceRef: argv['classification-evidence'],
  }, overlay);
  const p = saveOverlay(overlay, root, targetOverlay);
  writeJson(path.join(dir, 'last-review-change.json'), {
    at: new Date().toISOString(), entity_key: key, before: before.entries[key] ?? null, after: next,
    evidence_fingerprint: rec.evidence_fingerprint,
    overlay_path: p, is_isolated_fixture: !!targetOverlay,
    note: '人工字段只写入本覆盖层；导入时只读应用，来源永不覆盖人工结论。',
  });
  log(`review: ${key} status=${next.status} selected_reference=${next.selected_reference} notes=${next.notes.length} classification=${JSON.stringify(next.classification ?? null)} stale=${next.based_on_evidence_fingerprint ? next.based_on_evidence_fingerprint !== rec.evidence_fingerprint : false}`);
  log(`wrote ${p}${targetOverlay ? '（隔离夹具，非正式覆盖层）' : '（正式覆盖层）'}`);
}

// F5：把测试身份条目从正式覆盖层摘出并归档（保留原文，不删除）。
async function cmdArchiveTestAnnotations() {
  const dir = ensureDir(path.join(OUT, 'human-review'));
  const real = loadOverlay(root, null);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archivePath = path.join(dir, `review-overlay-selftest-archive-${stamp}.json`);
  const { kept, extracted, ambiguous } = splitTestIdentities(real);
  fs.writeFileSync(archivePath, JSON.stringify({
    at: new Date().toISOString(),
    note: 'F5：从正式覆盖层摘出的测试身份条目（逐字保留，不删除）。归属不明者留在有效层并标注 pending。',
    extracted, ambiguous_kept_in_effective: Object.keys(ambiguous),
  }, null, 2));
  if (Object.keys(extracted).length > 0) saveOverlay(kept, root, null);
  const receipt = {
    at: new Date().toISOString(),
    real_overlay_before_entries: Object.keys(real.entries).length,
    extracted_test_entries: Object.keys(extracted).length,
    ambiguous_pending_entries: Object.keys(ambiguous).length,
    real_overlay_after_entries: Object.keys(kept.entries).length,
    archive_path: archivePath,
    changed_effective_overlay: Object.keys(extracted).length > 0,
  };
  writeJson(path.join(dir, 'selftest-archive-receipt.json'), receipt);
  log(`archive-test-annotations: before=${receipt.real_overlay_before_entries} extracted=${receipt.extracted_test_entries} ambiguous_kept=${receipt.ambiguous_pending_entries} after=${receipt.real_overlay_after_entries}`);
  log(`archive: ${archivePath}`);
}

async function cmdApply() {
  if (!argv['base-url']) throw new Error('apply requires --base-url');
  assertLoopback(argv['base-url']);
  const client = createHttpClient({ baseUrl: argv['base-url'], token: argv.token, mgmtToken: argv['mgmt-token'] ?? null });
  const dir = ensureDir(path.join(OUT, 'apply'));
  const receipt = {
    adapter: ADAPTER_VERSION, mode: 'apply_schema_and_views', base_url: argv['base-url'],
    auth_used: client.auth_used, started_at: new Date().toISOString(), ok: false, errors: [],
    note: '幂等：重复调用复用既有表/字段/视图，不重复创建。',
  };
  try {
    const ping = await client.ping();
    receipt.ping = { ok: true, version: ping?.version ?? null };
    const res = await ensureSchemaAndViews(client, { databaseId: argv['database-id'] ? Number(argv['database-id']) : null });
    receipt.tableIds = res.tableIds;
    receipt.reconcile = res.log;
    receipt.ok = res.ok === true;
  } catch (e) {
    receipt.errors.push({ error: String(e.message), status: e.status ?? null, body: e.body ?? null });
    receipt.note = '未取得真实可写 Baserow 实例；schema/视图未获执行证据（这不是 Baserow 验收）。';
  }
  writeJson(path.join(dir, 'apply-receipt.json'), receipt);
  log(`apply: ok=${receipt.ok} tables=${Object.keys(receipt.tableIds ?? {}).length} created=${receipt.reconcile?.tables_created?.length ?? 0} reused=${receipt.reconcile?.tables_reused?.length ?? 0} views_created=${receipt.reconcile?.views_created?.length ?? 0}`);
  if (!receipt.ok) process.exitCode = 5;
}

async function cmdFieldContract() {
  // P1 字段合同的可复现提取：从保留证据逐字段取出 locator / 单位 / 可用性分布，
  // 并对齐 v5 规范含义。不重跑普查、不联网。
  const readline = await import('node:readline');
  const dir = ensureDir(path.join(OUT, 'plan'));
  const byPN = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(P.fieldValues, { encoding: 'utf8' }), crlfDelay: Infinity });
  let lines = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    lines++;
    const r = JSON.parse(line);
    const pn = `${r.platform}|${r.namespace}`;
    if (!byPN.has(pn)) byPN.set(pn, new Map());
    const f = byPN.get(pn);
    if (!f.has(r.field)) {
      f.set(r.field, {
        field: r.field,
        v5: v5MeaningFor(r.field),
        units: new Set(), locators: new Set(), availability: {},
        derivations: new Set(), zero_valued: 0, present: 0,
        observed_at_min: null, observed_at_max: null, source_files: new Set(),
      });
    }
    const e = f.get(r.field);
    if (r.unit) e.units.add(r.unit);
    if (r.locator) e.locators.add(r.locator);
    if (r.derivation) e.derivations.add(r.derivation);
    e.availability[r.availability ?? 'NULL'] = (e.availability[r.availability ?? 'NULL'] ?? 0) + 1;
    if (r.zero_valued === true) e.zero_valued++;
    if (r.availability === 'present_and_usable') e.present++;
    if (typeof r.observed_at_epoch_s === 'number') {
      e.observed_at_min = e.observed_at_min === null ? r.observed_at_epoch_s : Math.min(e.observed_at_min, r.observed_at_epoch_s);
      e.observed_at_max = e.observed_at_max === null ? r.observed_at_epoch_s : Math.max(e.observed_at_max, r.observed_at_epoch_s);
    }
    if (r.source?.file) e.source_files.add(r.source.file);
  }
  rl.close();

  const contract = {};
  for (const [pn, f] of [...byPN.entries()].sort()) {
    contract[pn] = {};
    for (const [field, e] of [...f.entries()].sort()) {
      contract[pn][field] = {
        field,
        v5_meaning: e.v5,
        units: [...e.units].sort(),
        locators: [...e.locators].sort(),
        locator_count: e.locators.size,
        derivations: [...e.derivations].sort(),
        availability: e.availability,
        observed_zero_rows: e.zero_valued,
        observed_at_range: [e.observed_at_min, e.observed_at_max],
        source_file_count: e.source_files.size,
      };
    }
  }
  const out = {
    generated_from: P.fieldValues,
    lines_scanned: lines,
    rules_version: loadRulesConfig(root).rules_version,
    v5_contract: V5_FIELD_CONTRACT,
    v5_value_semantics: V5_VALUE_SEMANTICS,
    derived_url_note: DERIVED_URL_NOTE,
    ambiguous_meaning_fields: AMBIGUOUS_MEANING_FIELDS,
    note: 'locator 为保留证据中的原始 JSON 路径；同一字段可能存在多个 locator（不同路线/容器形状）。',
    branches: contract,
  };
  writeJson(path.join(dir, 'field-contract.json'), out);

  // 同时产出可读版（供 field-map.md 引用与人工核对）
  const md = ['# 逐字段 locator / 单位 / 可用性 合同（自保留证据提取）', '',
    `来源：\`${P.fieldValues}\`（扫描 ${lines} 行）`, '', '同一字段可能有多个 locator（不同路线/容器形状），全部列出。', ''];
  for (const [pn, fields] of Object.entries(contract)) {
    md.push(`## ${pn}`, '', '| 字段 | v5 含义 | 单位 | locator | 可用性分布 | 观测零 |', '| --- | --- | --- | --- | --- | --- |');
    for (const c of Object.values(fields)) {
      const v5 = c.v5_meaning.mapping === 'mapped' ? `\`${c.v5_meaning.canonical}\``
        : c.v5_meaning.mapping === 'ambiguous_multi_meaning' ? `歧义(${c.v5_meaning.candidates.join('/')})`
          : c.v5_meaning.mapping === 'no_equivalent_slot' ? '（v5 无等价槽位）' : '未映射';
      md.push(`| \`${c.field}\` | ${v5} | ${c.units.join(', ') || '—'} | ${c.locators.map((l) => `\`${l}\``).join('<br>') || '—'} | ${Object.entries(c.availability).map(([k, v]) => `${k}=${v}`).join(', ')} | ${c.observed_zero_rows} |`);
    }
    md.push('');
  }
  fs.writeFileSync(path.join(dir, 'field-contract.md'), md.join('\n'));
  const branches = Object.keys(contract).length;
  const fields = Object.values(contract).reduce((a, f) => a + Object.keys(f).length, 0);
  log(`field-contract: branches=${branches} field_rows=${fields} lines=${lines}`);
  log(`wrote ${path.join(dir, 'field-contract.json')}`);
}

const FFMPEG_DEFAULT = 'D:/Codex-local/phone-case-video/.tools/ffmpeg-9.0.1-essentials_build/bin/ffmpeg.exe';

async function cmdSegments() {
  // F6 修复：FFmpeg 退出码 0 + 丢弃输出**不能**证明请求时刻真的解出了帧。
  // 本实现：(a) 用 showinfo 读取**实际解码帧的 pts_time**，与请求时刻比对（容差 = 一帧间隔）；
  //          (b) 为每条资产真正落一张 PNG，校验 PNG 魔数/尺寸/字节数；
  //          (c) 校验请求时刻落在媒体时长范围内。
  // 说明：受限沙箱禁止管道 stdio，因此 ffmpeg 的 stderr 重定向到**文件描述符**（非管道）。
  const { spawn } = await import('node:child_process');
  const { records } = await loadAll();
  const ffmpeg = argv.ffmpeg ?? FFMPEG_DEFAULT;
  const withSeg = records.filter((r) => r.assets.some((a) => (a.segments ?? []).length > 0));
  const dir = ensureDir(path.join(OUT, 'segments'));
  const framesDir = ensureDir(path.join(dir, 'frames'));

  const runToLog = (args, logPath) => new Promise((resolve) => {
    const fd = fs.openSync(logPath, 'w');
    const p = spawn(ffmpeg, args, { stdio: ['ignore', fd, fd] });
    p.on('error', (e) => { try { fs.closeSync(fd); } catch {} resolve({ ok: false, error: String(e.message) }); });
    p.on('close', (code) => { try { fs.closeSync(fd); } catch {} resolve({ ok: code === 0, code }); });
  });

  const results = [];
  let decodedOk = 0, decodedBad = 0, outOfDuration = 0;
  const frameChecks = [];
  for (const r of withSeg) {
    for (const a of r.assets) {
      const segs = a.segments ?? [];
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        const t = s.start_seconds;
        if (t === null || !a.local_path) continue;
        // (c) 时长边界
        const withinDuration = a.duration_seconds == null ? null : t <= a.duration_seconds + 1e-6;
        if (withinDuration === false) outOfDuration++;
        // (a) 实际解码帧时间。**必须加 -copyts**：否则 ffmpeg 会把时间戳归零到 seek 点，
        //     pts_time 变成 ~0，看似「不在请求时刻」——这是上一版只用退出码时掩盖掉的坑。
        const logPath = path.join(dir, `showinfo-${a.asset_id}-${i}.log`);
        const res = await runToLog(['-hide_banner', '-ss', String(t), '-copyts', '-i', a.local_path, '-frames:v', '1', '-vf', 'showinfo', '-f', 'null', '-'], logPath);
        const log = fs.readFileSync(logPath, 'utf8');
        const pts = log.match(/pts_time:([0-9.]+)/);
        const decodedPts = pts ? Number(pts[1]) : null;
        // 帧间隔从**实际输出**推导（各资产帧率可能不同），不硬编码 30fps
        const dur = log.match(/duration_time:([0-9.]+)/);
        const frameInterval = dur ? Number(dur[1]) : (1 / 30);
        const delta = decodedPts === null ? null : Math.abs(decodedPts - t);
        const decodedWithinOneFrame = delta !== null && delta <= frameInterval + 1e-3;
        if (decodedPts !== null) decodedOk++; else decodedBad++;
        // (b) 每资产第一段真正落一张 PNG
        let frame = null;
        if (i === 0) {
          const outPng = path.join(framesDir, `${a.asset_id}.png`);
          const f = await runToLog(['-hide_banner', '-v', 'error', '-y', '-ss', String(t), '-i', a.local_path, '-frames:v', '1', outPng], path.join(dir, `frame-${a.asset_id}.log`));
          if (fs.existsSync(outPng)) {
            const buf = fs.readFileSync(outPng);
            const isPng = buf.length > 8 && buf[0] === 0x89 && buf.subarray(1, 4).toString('latin1') === 'PNG';
            const width = isPng ? buf.readUInt32BE(16) : null;
            const height = isPng ? buf.readUInt32BE(20) : null;
            frame = { path: outPng, bytes: buf.length, is_png_magic: isPng, width, height, ffmpeg_ok: f.ok };
            frameChecks.push(frame);
          } else {
            frame = { path: outPng, bytes: 0, is_png_magic: false, ffmpeg_ok: f.ok };
            frameChecks.push(frame);
          }
        }
        results.push({
          entity_key: r.entity_key, asset_id: a.asset_id, segment_id: s.segment_id,
          requested_seconds: t, decoded_pts_time: decodedPts, delta_seconds: delta,
          decoded_within_one_frame: decodedWithinOneFrame,
          duration_seconds: a.duration_seconds, within_duration: withinDuration,
          ffmpeg_exit: res.code ?? null, frame,
        });
      }
    }
  }
  const framesOk = frameChecks.filter((f) => f.is_png_magic && f.bytes > 1000 && f.width > 0 && f.height > 0).length;
  const receipt = {
    at: new Date().toISOString(), ffmpeg, ffmpeg_available: fs.existsSync(ffmpeg),
    baserow_native_seek: 'UNVERIFIED — 官方 File field 文档列出 .mp4 可生成预览，但未文档化“拖动到指定时间”',
    method: 'showinfo 读取实际解码帧 pts_time + 真实落 PNG 并校验魔数/尺寸/字节 + 时长边界',
    segments_checked: results.length, decoded_frame_observed: decodedOk, decoded_frame_missing: decodedBad,
    decoded_within_one_frame: results.filter((x) => x.decoded_within_one_frame).length,
    out_of_duration: outOfDuration,
    frames_written: frameChecks.length, frames_verified_png: framesOk,
    exit_code_zero_alone_is_not_evidence: true,
    interpretation: '证明「请求时刻在本地媒体中确实解出了帧」并给出实际 pts_time；**不**证明 Baserow 面板内可拖动播放。',
    results,
  };
  writeJson(path.join(dir, 'seek-verification.json'), receipt);
  const md = ['# 片段引用时刻的解码验证（F6）', '',
    `- FFmpeg：\`${ffmpeg}\`（存在=${receipt.ffmpeg_available}）`,
    `- 方法：${receipt.method}`,
    `- 受检片段：${receipt.segments_checked}；解出帧 ${decodedOk}；未解出 ${decodedBad}；**解码时刻在一帧容差内** ${receipt.decoded_within_one_frame}；超出时长 ${outOfDuration}`,
    `- 真实写出 PNG：${receipt.frames_written}；通过魔数/尺寸/字节校验：${framesOk}`, '',
    '| 实体 | 资产 | 请求 t(s) | 实际解码 pts(s) | 差(s) | 一帧内 | 时长 | 范围内 | PNG |', '| --- | --- | ---: | ---: | ---: | --- | ---: | --- | --- |',
    ...results.map((x) => `| \`${x.entity_key}\` | ${x.asset_id} | ${x.requested_seconds} | ${x.decoded_pts_time ?? 'n/a'} | ${x.delta_seconds ?? 'n/a'} | ${x.decoded_within_one_frame} | ${x.duration_seconds ?? 'n/a'} | ${x.within_duration ?? 'n/a'} | ${x.frame ? (x.frame.is_png_magic ? `${x.frame.width}x${x.frame.height}/${x.frame.bytes}B` : 'FAIL') : '—'} |`)];
  fs.writeFileSync(path.join(dir, 'seek-verification.md'), md.join('\n'));
  log(`segments: checked=${results.length} decoded=${decodedOk} missing=${decodedBad} within_one_frame=${receipt.decoded_within_one_frame} frames_png_ok=${framesOk}/${receipt.frames_written} out_of_duration=${outOfDuration}`);
  log(`NOTE: 已证明请求时刻确实解出帧；**Baserow 面板内拖动播放仍未验证**。`);
  log(`wrote ${path.join(dir, 'seek-verification.json')}`);
  if (decodedBad > 0 || framesOk !== receipt.frames_written || outOfDuration > 0) process.exitCode = 6;
}

async function cmdJourney() {
  // R4 STEP4（R3-F4/F5）：以「产品/功能/需求」为一等检索维度，并让**同一个隔离覆盖层**
  // 贯穿 写→读→导入→**目标行**断言。r2 的真实失败（notes_preserved=0 / target=null）根因是
  // 写 fixtures/journey-overlay.json 而读的是正式覆盖层；此处用同一个路径。
  const platform = argv.platform ?? 'TikTok';
  const wantMedia = String(argv['require-media'] ?? 'true') === 'true';
  const setupFixture = argv['setup-fixture'] === true;
  const dir = ensureDir(path.join(OUT, 'journey'));

  // ---------------------------------------------------------------- R9-STEP2.1：journey **只读**
  // 普通 journey 只做「只读查询 + 详情/媒体」；**不接受**任何写入意图：
  //   · 传 `--edit` → **在任何写入之前显式拒绝**（exit 16）并指向独立 `edit` 命令，绝不静默忽略；
  //   · 公共 journey 不再保留任何目标侧写入路径（夹具演示也只在隔离覆盖层上准备，不做目标侧编辑）。
  if (argv.edit === true) {
    const refused = {
      adapter: ADAPTER_VERSION, at: new Date().toISOString(), command: 'journey',
      read_only: true, mutated: false, writes_attempted: 0, writes_performed: 0, writes_confirmed: 0,
      error: 'journey_edit_removed',
      problems: ['journey_no_longer_writes：journey 已改为只读；改用 `cli.mjs edit --target … --entity-key/--row-id --note … --reviewer …` 做显式编辑'],
      ok: false,
      note: '显式拒绝：journey 的写入路径已移除，未尝试任何写入（也不静默忽略 --edit）。',
    };
    writeJson(path.join(dir, 'journey-transcript.json'), refused);
    log('journey: REFUSED --edit（journey 只读；请用 `edit` 命令）writes=0');
    process.exitCode = 16;
    return refused;
  }
  if (!setupFixture) {
    const openRes = await openTargetOrFail('journey', 'journey');
    if (!openRes.opened) return openRes.receipt;
    const opened = openRes.opened;
    const query = queryFromArgv(argv);
    const resolved = await resolveTargetSelection({
      backend: opened.backend, query,
      selection: { entityKey: argv['entity-key'] ?? null, rowId: argv['row-id'] ?? null, namespace: argv['namespace'] ?? null },
    });
    // 详情/媒体来自**选中的目标身份**（未显式选择时，用查询命中里被展示的那一条，仅用于展示）
    const shownKey = resolved.selected_entity_key ?? resolved.hits[0]?.entity_key ?? null;
    const videos = shownKey ? (await opened.backend.listAllRows(TABLE_VIDEOS)).filter((r) => String(r[TABLE_PRIMARY_KEY[TABLE_VIDEOS]]) === String(shownKey)) : [];
    const assets = shownKey ? (await opened.backend.listAllRows(TABLE_ASSETS)).filter((r) => r.entity_key === shownKey) : [];
    const segments = shownKey ? (await opened.backend.listAllRows(TABLE_SEGMENTS)).filter((r) => r.entity_key === shownKey) : [];
    const transcript = {
      at: new Date().toISOString(),
      order: 'R9 STEP2 用户旅程：**只读**查询既有目标（写入一律走独立 edit 命令）',
      target: targetDescriptor(opened),
      query: { platform, require_local_video: wantMedia, dimensions: query },
      read_only: true,
      mutated: false,
      writes_attempted: 0,
      writes_performed: 0,
      writes_confirmed: 0,
      hit_count: resolved.hit_count, scanned_rows: resolved.scanned_rows,
      hits: resolved.hits.slice(0, 25),
      shown_identity: shownKey,
      identity: videos[0] ? { row_id: videos[0].id, entity_key: videos[0][TABLE_PRIMARY_KEY[TABLE_VIDEOS]], namespace: videos[0].namespace ?? null, review_status: videos[0].review_status ?? null } : null,
      media: {
        assets: assets.map((a) => ({ asset_id: a.asset_id, media_view_path: a.media_view_path ?? null, media_view_url: a.media_view_url ?? null, media_service_state: a.media_service_state ?? null })),
        segments: segments.map((s) => ({ segment_id: s.segment_id, view_path: s.view_path ?? null, view_url: s.view_url ?? null, media_service_state: s.media_service_state ?? null })),
      },
      selected_row: resolved.selected, problems: resolved.problems, duplicate_keys: resolved.duplicate_keys,
      target_row_snapshot: videos[0] ? serializeTargetRow(videos[0]) : null,
      edit_receipt: null,
      ok: resolved.ok,
      baserow_ui_verified: false,
      note: '只读旅程：命中来自目标库行；详情/媒体指向被选中的目标身份；未导入、未写覆盖层、未加默认备注、无写入路径。',
    };
    writeJson(path.join(dir, 'journey-transcript.json'), transcript);
    const md = ['# 用户旅程回执（R9：只读查询既有目标）', '',
      `- 时间：${transcript.at}`, `- 目标：${transcript.target.target_mode}/${transcript.target.backend_kind} transport=${transcript.target.transport}`,
      `- 查询条件：${JSON.stringify(query)}`,
      `- 扫描 ${transcript.scanned_rows} 行；命中 ${transcript.hit_count} 条；展示身份 \`${transcript.shown_identity ?? 'none'}\``,
      `- 只读：${transcript.read_only}；写入次数：${transcript.writes_performed}`,
      `- 身份解析问题：${JSON.stringify(transcript.problems)}`, '',
      `- **Baserow UI 未验证**；本回执不构成真实实例验收。`, ''];
    fs.writeFileSync(path.join(dir, 'journey-transcript.md'), md.join('\n'));
    log(`journey: ${transcript.read_only ? 'READ-ONLY' : 'EXPLICIT-EDIT'} target=${opened.target_mode} scanned=${resolved.scanned_rows} hits=${resolved.hit_count} shown=${shownKey ?? 'none'} edit=${argv.edit === true} ok=${transcript.ok}`);
    log(`journey: problems=${JSON.stringify(resolved.problems)} writes=${transcript.writes_performed}`);
    log(`wrote ${path.join(dir, 'journey-transcript.json')}`);
    if (!transcript.ok) process.exitCode = 6;
    return;
  }

  // ---------------------------------------------------------------- 隔离夹具演示（显式 --setup-fixture）
  // 覆盖层默认值：夹具演示用隔离夹具层，绝不写正式人工复核层。
  const fixtureOverlay = argv.overlay ?? path.join(OUT, 'fixtures', 'journey-overlay.json');
  const { records } = await loadAll(fixtureOverlay);

  const hasClassification = !!(argv['product-function'] || argv['product-category'] || argv['scene-or-need']);
  const classificationEvidenceRef = argv['classification-evidence'] ?? null;
  if (hasClassification && !classificationEvidenceRef) {
    throw new Error('journey_classification_requires_evidence_ref：执行端提议的产品/功能/场景分类必须带 --classification-evidence（不得无证据制造分类）');
  }
  const classification = hasClassification ? {
    product_category: argv['product-category'] ?? null,
    product_function: argv['product-function'] ?? null,
    scene_or_need: argv['scene-or-need'] ?? null,
    state: 'proposed',
    note: '执行端提议（proposed），不等于 Simon 人工复核（reviewed）。',
  } : null;

  // R7-STEP2：夹具准备是**显式演示动作**（--setup-fixture，见上方覆盖层默认值），默认不执行。
  // 真实用户路径（已填充目标）不得自动写夹具覆盖层、不得覆盖人工状态。

  // R7-STEP2：后端必须**显式声明**；http 模式需要真实实例配置，未配置就明确拒绝（不悄悄回落 memory）
  const backendMode = argv.backend ?? 'memory_isolation';
  let httpFactory = null;
  if (backendMode === 'http') {
    if (!argv['base-url'] || !argv['database-id'] || !argv.token) {
      throw new Error('journey_http_requires_base_url_database_id_and_token：--backend http 需要 --base-url/--database-id/--token（不回落 memory）');
    }
    assertLoopback(argv['base-url']);
    httpFactory = async () => {
      const client = createHttpClient({ baseUrl: argv['base-url'], token: argv.token, mgmtToken: argv['mgmt-token'] ?? null });
      const schemaRes = await ensureSchemaAndViews(client, { databaseId: Number(argv['database-id']) });
      if (!schemaRes.ok) throw new Error(`journey_http_schema_reconcile_failed:${JSON.stringify(schemaRes.log?.type_mismatches?.slice(0, 3) ?? [])}`);
      return createHttpBackend({ client, tableIds: schemaRes.tableIds, fieldMeta: schemaRes.fieldMeta ?? {} });
    };
  }

  // R7-STEP3：媒体发布语义与 import 共用同一解析（未指定 ≠ 显式停止发布）
  const resolvedPublication = resolveMediaPublication(argv);

  // R9-STEP2.1：夹具演示**不再**做目标侧编辑（公共 journey 已无写入路径）；
  // 上面 `--edit` 分支已在任何写入之前显式拒绝，故这里不存在另一种写入入口。
  const res = await runJourney({
    records,
    loadWithOverlay: async (p) => (await loadAll(p)).records,
    overlayPath: fixtureOverlay,
    root,
    platform,
    requireMedia: wantMedia,
    classification,
    classificationEvidenceRef,
    reviewer: argv.reviewer ?? 'journey-fixture-executor',
    backendMode,
    createHttpBackend: httpFactory,
    createBackend: () => createMemoryBackend(),
    setupFixture,
    mediaBaseUrl: resolvedPublication.mediaBaseUrl,
    // 夹具演示只做「隔离覆盖层准备 + 导入 + 目标行只读断言」，不做人工编辑
    manualEdit: null,
    // R5 STEP3：明确验证“没有命中也要诚实”
    noMatchQuery: { product_category: argv['no-match-probe'] ?? '不可能存在的类别-探针' },
  });

  const transcript = {
    at: new Date().toISOString(),
    order: 'R7 STEP2 用户旅程（既有目标行上的只读查询 + 显式人工编辑；Baserow UI 段仍为阻断）',
    query: { platform, require_local_video: wantMedia, classification },
    ok: res.ok,
    failures: res.failures,
    baserow_ui_verified: false,
    overlay_path: fixtureOverlay,
    fixture_setup_executed: setupFixture,
    media_publication: resolvedPublication.receipt,
    ...res.transcript,
  };
  writeJson(path.join(dir, 'journey-transcript.json'), transcript);

  const md = ['# 用户旅程回执（真实留存记录；隔离覆盖层贯穿）', '',
    `- 时间：${transcript.at}`, `- 查询：platform=${platform}, require_local_video=${wantMedia}, classification=${JSON.stringify(classification)}`,
    `- 匹配 ${transcript.matched_count} 条；选中 \`${transcript.chosen_entity_key}\``,
    `- 结果：ok=${res.ok}${res.failures.length ? `，失败项 ${JSON.stringify(res.failures)}` : ''}`,
    `- **Baserow UI 未验证**：本旅程为交付代码上的真实数据链路执行；目标为内存语义目标。`, ''];
  for (const s of transcript.steps) md.push(`## ${s.step}. ${s.title}`, '', '```json', JSON.stringify(Object.fromEntries(Object.entries(s).filter(([k]) => !['step', 'title'].includes(k))), null, 1), '```', '');
  fs.writeFileSync(path.join(dir, 'journey-transcript.md'), md.join('\n'));

  log(`journey: query=${platform}/media=${wantMedia}/classification=${classification ? 'yes' : 'no'} candidates=${transcript.candidate_count} chosen=${transcript.chosen_entity_key}`);
  log(`journey: overlay=${fixtureOverlay} fixture_setup=${setupFixture} ok=${res.ok} failures=${JSON.stringify(res.failures)}`);
  log(setupFixture
    ? 'NOTE: 隔离夹具演示：同一覆盖层贯穿「写→读→导入→目标行」；**Baserow 面板 UI 仍未验证**。'
    : 'NOTE: 真实用户路径：**未写任何夹具覆盖层**，命中来自目标库行、人工编辑走目标 backend；**Baserow 面板 UI 仍未验证**。');
  log(`wrote ${path.join(dir, 'journey-transcript.json')}`);
  if (!res.ok) process.exitCode = 6;
}

async function cmdMedia() {
  // R5 STEP4：既有媒体 → **可操作的本地点播/定位入口**。host/端口/发布地址/生命周期都显式记录。
  const { records } = await loadAll();
  const dir = ensureDir(path.join(OUT, 'media'));
  const index = createMediaIndex(records);
  const assets = [...index.byId.values()];
  const requestedPort = argv.port === undefined ? 0 : Number(argv.port);
  if (argv.host !== undefined && !['127.0.0.1', 'localhost'].includes(String(argv.host))) {
    throw new Error(`media_host_must_be_loopback:${argv.host}`);
  }
  const server = createMediaServer({ index, host: '127.0.0.1', port: requestedPort, log: (m) => log(m) });
  const bound = await server.listen();
  let verification = null, recordUrlChecks = null;
  try {
    verification = await verifyMediaRoute({ url: bound.url, index });
    // 记录→URL 身份连续性：Assets 行里的 media_view_path 必须真的能打开同一个 asset
    const rows = rowsOf(records);
    const assetRows = rows[TABLE_ASSETS].filter((r) => r.media_view_path);
    recordUrlChecks = [];
    for (const row of assetRows) {
      const res = await fetch(`${bound.url}${row.media_view_path}&t=${row.media_seek_seconds ?? 0}`);
      const html = await res.text();
      recordUrlChecks.push({
        asset_id: row.asset_id, view_path: row.media_view_path, seek_seconds: row.media_seek_seconds ?? null,
        status: res.status, identity_ok: html.includes(`data-asset-id="${String(row.asset_id).replace(/[^A-Za-z0-9._-]/g, '')}"`),
      });
    }
  } finally { if (argv.serve !== true) await server.close(); }
  const receipt = {
    adapter: MEDIA_ADAPTER_VERSION, at: new Date().toISOString(),
    host: bound.host, port: bound.port, loopback_url: bound.url,
    viewer_route: bound.viewer_route,
    asset_route: '/media/asset/<asset_id>',
    segment_route: '/media/asset/<asset_id>/segment/<index>',
    publication: {
      base_url: bound.url,
      example: `${bound.url}/viewer?asset=${encodeURIComponent(assets[0]?.asset_id ?? '<asset_id>')}&t=${assets[0]?.segments?.[0]?.start_seconds ?? 0}`,
      note: '记录里的 media_view_path / view_path 是**相对路由**，绝对地址由本次实际监听的 host:port 发布（随机端口不进数据）。',
    },
    process_lifetime: argv.serve === true ? 'foreground_until_stopped（长驻；结束请终止该进程）' : 'self_check_then_exit（只做自检，不是交付的观看服务）',
    assets_indexed: assets.length,
    assets_usable_video: assets.filter((a) => a.usable_as_video === true).length,
    references: index.refs.length,
    segments_indexed: assets.reduce((n, a) => n + a.segments.length, 0),
    verification, record_to_url_identity: recordUrlChecks,
    native_file_field: {
      status: 'not_populated_without_live_instance',
      reason: 'Baserow 原生 file 字段需要真实实例的上传端点与凭据（multipart upload）；本机无实例，故不伪造上传，也不把本机绝对路径写成“已上传”。',
      fallback: '本机 loopback 点播入口按**同一 asset/segment 身份**提供可播放/可定位路径，并把该路由写进同一批记录。',
    },
    limits: '适配器只读、只绑回环：证明同一份本地字节可按身份与时间点取回且入口可播放（HTTP 级）；不证明 Baserow UI 内播放、不做公网监听、原始媒体未改动。',
  };
  writeJson(path.join(dir, 'media-receipt.json'), receipt);
  // R6-STEP3：只有**长驻**（--serve）才发布可点击的稳定地址；自检后即关的进程不得留下可用链接。
  const publication = {
    state: argv.serve === true ? 'published' : 'not_published',
    base_url: argv.serve === true ? bound.url : null,
    host: bound.host, port: argv.serve === true ? bound.port : null,
    published_at: argv.serve === true ? new Date().toISOString() : null,
    viewer_route: bound.viewer_route,
    asset_route: '/media/asset/<asset_id>',
    segment_route: '/media/asset/<asset_id>/segment/<index>',
    process_lifetime: receipt.process_lifetime,
    not_published_reason: argv.serve === true ? null : 'self_check_then_exit：进程随自检结束而关闭，不得作为可用观看服务地址写入记录。',
    restart_note: '重启后端口可能不同（除非显式 --port）：重跑 `media --serve --port <N>`，再以 `import --media-base-url <url>` 重新发布绝对链接。',
  };
  writeJson(path.join(dir, 'media-publication.json'), publication);
  log(`media: publication state=${publication.state}${publication.base_url ? ` base_url=${publication.base_url}` : ''}`);
  log(`media: host=${receipt.host} port=${receipt.port} assets=${receipt.assets_indexed} usable_video=${receipt.assets_usable_video} refs=${receipt.references} segments=${receipt.segments_indexed}`);
  log(`media: viewer ${receipt.publication.example}`);
  log(`media: verified=${verification?.ok} record_url_identity=${recordUrlChecks?.every((c) => c.identity_ok && c.status === 200)} lifetime=${receipt.process_lifetime}`);
  if (verification && !verification.ok) process.exitCode = 7;
  if (recordUrlChecks && !recordUrlChecks.every((c) => c.identity_ok && c.status === 200)) process.exitCode = 9;
  if (argv.serve === true) await new Promise(() => {});
}

const commands = { normalize: cmdNormalize, plan: cmdPlan, sample: cmdSample, import: cmdImport, query: cmdQuery, edit: cmdEdit, export: cmdExport, restore: cmdRestore, verify: cmdVerify, review: cmdReview, apply: cmdApply, 'field-contract': cmdFieldContract, segments: cmdSegments, journey: cmdJourney, media: cmdMedia, 'archive-test-annotations': cmdArchiveTestAnnotations };

if (!cmd || !commands[cmd]) {
  console.error(`usage: node tools/material-library/cli.mjs <${Object.keys(commands).join('|')}> [--out DIR] [--root DIR]`);
  process.exit(1);
}
await commands[cmd]();
