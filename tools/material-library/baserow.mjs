// tools/material-library/baserow.mjs
// P2/P3/P4：本地 Baserow 适配器（REST）+ 可离线验证的合并语义。
//
// 重要边界：
//  - 本模块的 HTTP 路径按 Baserow 官方 REST API 编写，但在本机**没有**容器运行时，
//    因此 HTTP 路径未对真实实例执行过；不得据此声称“Baserow 已验证”。
//  - createMemoryBackend() 只用于验证**本适配器的合并/保留/去重语义**，它不是 Baserow，
//    也不能作为 Baserow 验收证据。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { absoluteViewUrl } from './media.mjs';

export const ADAPTER_VERSION = 'material-library-baserow/1.0.0';
export const BASEROW_PINNED_IMAGE = 'baserow/baserow:2.4.0';

export const HUMAN_FIELDS = [
  'review_status', 'review_reviewer', 'review_reviewed_at', 'review_notes',
  'review_value_categories', 'selected_reference', 'review_stale', 'review_stale_reason', 'human_note',
  // F4：人工分类与其归属必须受保护，来源导入永不覆盖
  'product_category', 'product_function', 'scene_or_need',
  'product_category_origin', 'product_function_origin', 'scene_or_need_origin',
  'product_category_reviewer', 'product_function_reviewer', 'scene_or_need_reviewer',
  'product_category_evidence_ref', 'product_function_evidence_ref', 'scene_or_need_evidence_ref',
  'product_category_state', 'product_function_state', 'scene_or_need_state',
];

// F4：人工分类字段族（有效值 + 来源归属 + 复核人 + 证据引用 + 状态）
export const CLASSIFICATION_FIELD_SUFFIXES = ['', '_origin', '_reviewer', '_evidence_ref', '_state'];
export const CLASSIFICATION_BASE_FIELDS = ['product_category', 'product_function', 'scene_or_need'];
export function classificationFieldNames() {
  const out = [];
  for (const base of CLASSIFICATION_BASE_FIELDS) for (const s of CLASSIFICATION_FIELD_SUFFIXES) out.push(`${base}${s}`);
  return out;
}

export function sha256Hex(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

// ---------------------------------------------------------------- schema plan
export const TABLE_VIDEOS = 'Videos';
export const TABLE_METRICS = 'Metric observations';
export const TABLE_ASSETS = 'Assets';
export const TABLE_RATIOS = 'Ratios';
export const TABLE_SEGMENTS = 'Segments';

export function planSchema() {
  return {
    version: ADAPTER_VERSION,
    tables: [
      {
        name: TABLE_VIDEOS,
        note: '稳定视频身份 + 来源事实 + 人工复核字段（人工字段导入时永不覆盖）',
        fields: [
          { name: 'entity_key', type: 'text', primary: true, note: 'platform|namespace|native_id' },
          { name: 'platform', type: 'text' },
          { name: 'namespace', type: 'text', note: 'main | aid（aid 单列，永不合并且不参与合并唯一总数）' },
          { name: 'native_id', type: 'text', note: '字符串保存；>2^53 的 id 不经 Number()' },
          { name: 'branch', type: 'text' },
          { name: 'canonical_url', type: 'url' },
          { name: 'derived_permalink', type: 'url' },
          { name: 'author_id', type: 'text' },
          { name: 'author_display_name', type: 'text' },
          { name: 'author_follower_count', type: 'number' },
          { name: 'media_type', type: 'text' },
          { name: 'duration_seconds', type: 'number' },
          { name: 'publish_date_epoch_s', type: 'number' },
          { name: 'publish_date_label', type: 'text' },
          { name: 'language', type: 'text', note: '未知保持 unknown，不填 0' },
          { name: 'product_category', type: 'text', note: '有效值：来源无留存 → unknown；人工可填（见 *_origin 标明来源）' },
          { name: 'product_function', type: 'text' },
          { name: 'scene_or_need', type: 'text' },
          ...CLASSIFICATION_BASE_FIELDS.flatMap((b) => [
            { name: `${b}_origin`, type: 'single_select', options: ['source_value', 'human_review', 'human_review_test_identity_excluded', 'unknown_no_source'], human: true, note: 'F4：标明该有效值来自来源还是人工复核' },
            { name: `${b}_reviewer`, type: 'text', human: true },
            { name: `${b}_evidence_ref`, type: 'text', human: true, note: 'F4：人工分类必须可追溯到证据' },
            { name: `${b}_state`, type: 'single_select', options: ['proposed', 'reviewed', 'rejected'], human: true },
          ]),
          { name: 'entity_source_state', type: 'single_select', options: ['observed', 'source_unavailable', 'unknown'] },
          { name: 'join_reason_class', type: 'text' },
          { name: 'decision', type: 'text' },
          { name: 'identity_confidence', type: 'text' },
          { name: 'provenance_class', type: 'text' },
          { name: 'retained_path', type: 'text' },
          { name: 'evidence_fingerprint', type: 'text', note: '来源证据指纹；变化时使依赖判断失效' },
          { name: 'aid_branch', type: 'boolean' },
          { name: 'metrics_observed', type: 'number' },
          // ---- 人工字段（导入永不覆盖；证据变化时只标 stale）----
          { name: 'review_status', type: 'single_select', options: ['unreviewed', 'in_review', 'reviewed', 'rejected'], human: true },
          { name: 'review_reviewer', type: 'text', human: true },
          { name: 'review_reviewed_at', type: 'date', human: true },
          { name: 'review_notes', type: 'long_text', human: true },
          { name: 'review_value_categories', type: 'text', human: true },
          { name: 'selected_reference', type: 'boolean', human: true },
          { name: 'review_stale', type: 'boolean', human: false, note: '由导入在证据变化时置位，人工可清' },
          { name: 'review_stale_reason', type: 'text', human: false },
        ],
      },
      {
        name: TABLE_SEGMENTS,
        note: '既有时间片段引用（来自既有分析卡，带来源与种类）。稀疏抽样，不代表全片已看/已听。',
        fields: [
          { name: 'segment_id', type: 'text', primary: true },
          { name: 'entity_key', type: 'text' },
          { name: 'asset_id', type: 'text' },
          { name: 'video_link', type: 'link_row', linkTo: TABLE_VIDEOS, note: 'F2：原生关联到 Videos' },
          { name: 'asset_link', type: 'link_row', linkTo: TABLE_ASSETS, note: 'F2：原生关联到 Assets' },
          { name: 'index', type: 'number' },
          { name: 't_label', type: 'text' },
          { name: 'start_seconds', type: 'number' },
          { name: 'observed', type: 'long_text' },
          { name: 'onscreen_text', type: 'text' },
          { name: 'speech', type: 'long_text' },
          { name: 'kind', type: 'single_select', options: ['original_fact', 'interpretation', 'suggestion', 'unknown'] },
          { name: 'fact_origin', type: 'single_select', options: ['source_fact', 'derived_interpretation'] },
          { name: 'origin_card', type: 'text', note: '片段引用来自哪张既有卡（来源可追溯）' },
          { name: 'origin_method', type: 'text' },
          { name: 'time_accuracy_note', type: 'long_text' },
          { name: 'coverage', type: 'text', note: '稀疏抽样：只覆盖被采样时刻' },
          { name: 'view_path', type: 'text', note: 'R5：/viewer?asset=<asset_id>&t=<start_seconds> —— 记录→asset→segment→可定位播放入口' },
          { name: 'view_url', type: 'url', note: 'R6：**绝对**定位播放入口（含非零 t），可直接点击' },
          { name: 'media_service_state', type: 'single_select', options: ['published', 'not_published'], note: 'R6：观看服务是否已发布' },
          { name: 'human_note', type: 'long_text', human: true },
          { name: 'review_status', type: 'single_select', options: ['unreviewed', 'in_review', 'reviewed', 'rejected'], human: true },
          { name: 'selected_reference', type: 'boolean', human: true },
        ],
      },
      {
        name: TABLE_METRICS,
        note: '按次观测的指标（身份/时间/来源一体），保留观测历史，不覆盖历史采集时刻',
        fields: [
          { name: 'observation_id', type: 'text', primary: true, note: 'platform|namespace|native_id|field|observed_at|source' },
          { name: 'video_link', type: 'link_row', linkTo: TABLE_VIDEOS, note: 'F2：原生关联到 Videos' },
          { name: 'entity_key', type: 'text' },
          { name: 'field', type: 'text' },
          { name: 'status', type: 'single_select', options: ['value', 'observed_zero', 'absent', 'source_unavailable', 'unusable', 'unknown', 'error'] },
          { name: 'fact_origin', type: 'single_select', options: ['source_fact', 'derived'], note: '来源事实 vs 派生值；人工复核在 Videos 层，不混入观测层' },
          { name: 'error_reason', type: 'text', note: 'status=error 时的具体校验原因' },
          { name: 'validation_rule', type: 'text', note: '本库对该字段施加的类型/单位校验规则' },
          { name: 'metric_definition', type: 'text', note: '该指标是什么（口径定义）' },
          { name: 'metric_caveat', type: 'text', note: '口径边界/不得升级的解释' },
          { name: 'comparable_across_platforms', type: 'boolean', note: '普查已明确跨平台可比性未建立 → 恒为 false' },
          { name: 'value_text', type: 'text', note: '原值（字符串）' },
          { name: 'numeric_value', type: 'number' },
          { name: 'unit', type: 'text' },
          { name: 'observed_at_epoch_s', type: 'number' },
          { name: 'observation_basis', type: 'text' },
          { name: 'identity_basis', type: 'text' },
          { name: 'retention_grade', type: 'text' },
          { name: 'locator', type: 'text' },
          { name: 'source_file', type: 'text' },
          { name: 'source_sha256', type: 'text' },
        ],
      },
      {
        name: TABLE_RATIOS,
        note: '可解释比率；不支持/分母为 0 时 status 如实记录，不产生分数',
        fields: [
          { name: 'ratio_id', type: 'text', primary: true },
          { name: 'video_link', type: 'link_row', linkTo: TABLE_VIDEOS, note: 'F2：原生关联到 Videos' },
          { name: 'entity_key', type: 'text' },
          { name: 'ratio_key', type: 'text' },
          { name: 'status', type: 'text' },
          { name: 'value', type: 'number' },
          { name: 'unit', type: 'text' },
          { name: 'reason', type: 'text' },
          { name: 'attribution', type: 'text' },
        ],
      },
      {
        name: TABLE_ASSETS,
        note: '本地已有媒体与片段引用（仅身份可证的既有资产；缺媒体如实为空；图像绝不当作视频）',
        fields: [
          { name: 'asset_id', type: 'text', primary: true },
          { name: 'entity_key', type: 'text' },
          { name: 'video_link', type: 'link_row', linkTo: TABLE_VIDEOS, note: 'F2：原生关联到 Videos，可在 UI 点击跳转' },
          { name: 'media_file', type: 'file', note: 'F2：原生文件字段（媒体查看/补充播放路径）' },
          // R5 STEP4：把「既有媒体 → 可操作本地点播/定位入口」的链接落到**同一批 asset/segment 记录**里。
          // 路由是相对路径，绝对地址（host:port）由 `cli.mjs media --serve` 发布，避免把随机端口写进数据。
          { name: 'media_view_path', type: 'text', note: 'R5：本地点播入口相对路由 /viewer?asset=<asset_id>' },
          { name: 'media_view_url', type: 'url', note: 'R6：**绝对**点播链接（实际发布的 host:port + 该相对路由），可直接点击' },
          { name: 'media_service_state', type: 'single_select', options: ['published', 'not_published'], note: 'R6：观看服务是否已发布；未发布时不得伪装成可用链接' },
          { name: 'media_seek_seconds', type: 'number', note: 'R5：首个片段的起始秒（非零即定位点；缺失为 null，不写 0 冒充）' },
          { name: 'cohort', type: 'text' },
          { name: 'local_path', type: 'text', note: '绝对路径（相对路径依赖 cwd，不作交付）' },
          { name: 'local_path_recorded', type: 'text', note: '来源记录中的原样路径' },
          { name: 'path_source', type: 'text', note: 'manifest.media.file | card.media_evidence.file' },
          { name: 'media_kind', type: 'single_select', options: ['video', 'image', 'unknown'] },
          { name: 'usable_as_video', type: 'boolean' },
          { name: 'kind_reject_reason', type: 'text', note: '卡媒体指向图像时的显式拒绝原因' },
          { name: 'sha256', type: 'text' },
          { name: 'sha256_match', type: 'boolean' },
          { name: 'bytes', type: 'number' },
          { name: 'actual_bytes', type: 'number' },
          { name: 'duration_seconds', type: 'number' },
          { name: 'resolution', type: 'text' },
          { name: 'contact_sheet', type: 'text' },
          { name: 'card_file', type: 'text' },
          { name: 'timeline_entries', type: 'number' },
          { name: 'rights_status', type: 'text' },
          { name: 'verified_present_locally', type: 'boolean' },
        ],
      },
    ],
  };
}

// P4 视图计划：中文名称；unknown 必须保持可见。
export function planViews() {
  return [
    {
      table: TABLE_VIDEOS, name: '全部记录', type: 'grid',
      note: '无过滤：unknown/缺失同样可见',
    },
    {
      table: TABLE_VIDEOS, name: '待补证据', type: 'grid',
      filters: [
        { field: 'entity_source_state', type: 'single_select_not_equal', value: 'observed' },
      ],
      note: '来源不可用的成员仍然列出，缺口可见',
    },
    {
      table: TABLE_VIDEOS, name: '研究候选', type: 'grid',
      filters: [
        { field: 'entity_source_state', type: 'single_select_equal', value: 'observed' },
      ],
      sorts: [{ field: 'metrics_observed', direction: 'DESC' }],
      note: '证据可用者；排序仅按证据条数，不做跨平台表现排名',
    },
    {
      table: TABLE_VIDEOS, name: '人工精选参考', type: 'grid',
      // F5：精选视图必须排除失效（stale）审批，不能把过期判断当成当前有效选择
      filters: [
        { field: 'selected_reference', type: 'boolean', value: true },
        { field: 'review_stale', type: 'boolean', value: false },
      ],
      note: '仅人工勾选且未失效；不得由热度自动填充',
    },
    {
      table: TABLE_VIDEOS, name: '按产品类别检索（人工分类）', type: 'grid',
      // F4：产品/功能/场景的来源值为 unknown；本视图呈现**已有有效值**（来源或人工）的记录
      filters: [{ field: 'product_category', type: 'not_equal', value: 'unknown' }],
      note: 'F4：产品/功能/场景来源无留存 → 缺省 unknown；本视图只显示已由人工复核（或来源）赋予有效值的记录，并在 *_origin 列标明来源，不冒充来源事实。',
    },
    {
      table: TABLE_VIDEOS, name: '人工分类：待复核提案', type: 'grid',
      filters: [{ field: 'product_category_state', type: 'single_select_equal', value: 'proposed' }],
      note: 'F4：执行端提出的分类（proposed）≠ Simon 已复核（reviewed）；本视图供人工确认或驳回。',
    },
    {
      table: TABLE_VIDEOS, name: '证据变化待复核', type: 'grid',
      filters: [{ field: 'review_stale', type: 'boolean', value: true }],
      note: '来源证据变化后依赖判断失效的对象',
    },
    {
      table: TABLE_METRICS, name: '缺失与不可用', type: 'grid',
      filters: [
        { field: 'status', type: 'single_select_equal', value: 'source_unavailable' },
      ],
    },
    {
      table: TABLE_SEGMENTS, name: '片段参考（按时间）', type: 'grid',
      sorts: [{ field: 'start_seconds', direction: 'ASC' }],
      note: '既有片段引用，带来源卡与种类；稀疏抽样，不代表全片已看/已听',
    },
    {
      table: TABLE_SEGMENTS, name: '未复核片段', type: 'grid',
      filters: [{ field: 'review_status', type: 'single_select_equal', value: 'unreviewed' }],
      note: '人工复核入口；不得由热度自动填充',
    },
    // R2 STEP5 要求的筛选维度：platform / language / date / review-status（product·function 无来源支持 → 见「分类待补」）
    {
      table: TABLE_VIDEOS, name: '按平台：TikTok（可切换）', type: 'grid',
      filters: [{ field: 'platform', type: 'equal', value: 'TikTok' }],
      note: '平台筛选示例。改成其它平台只需把该视图的 platform 过滤值改为 Instagram/YouTube/Douyin/Kuaishou/Xiaohongshu/Bilibili/WeChat Channels；本库不提供跨平台合并排名。',
    },
    {
      table: TABLE_VIDEOS, name: '语言已明示', type: 'grid',
      filters: [{ field: 'language', type: 'not_empty', value: '' }],
      note: '语言筛选。**未**被来源明示语言的记录不在本视图内，但在「全部记录」中仍然可见（unknown 不被隐藏）。',
    },
    {
      table: TABLE_VIDEOS, name: '发布日期已明示', type: 'grid',
      filters: [{ field: 'publish_date_epoch_s', type: 'higher_than', value: 0 }],
      sorts: [{ field: 'publish_date_epoch_s', direction: 'DESC' }],
      note: '日期筛选/排序。缺失发布的记录仍保留在「全部记录」。',
    },
    {
      table: TABLE_VIDEOS, name: '未复核记录', type: 'grid',
      filters: [{ field: 'review_status', type: 'single_select_equal', value: 'unreviewed' }],
      note: '复核状态筛选（人工标注入口）。',
    },
    {
      table: TABLE_VIDEOS, name: '分类待补（unknown 可见）', type: 'grid',
      filters: [{ field: 'product_category', type: 'equal', value: 'unknown' }],
      note: '产品类别/功能/场景无来源支持 → 全部 unknown。本视图让缺口保持可见，**不**用推断填充以满足数量要求。',
    },
  ];
}

// ---------------------------------------------------------------- HTTP client
// F2 修复：按**官方 2.4.0 OpenAPI**（`https://api.baserow.io/api/schema.json`，info.version=2.4.0）逐条校正路由。
// 初版有 4 条路由与 2.4.0 不符，已改（证据：evidence/baserow-openapi-schema.json + verify-openapi-routes.mjs）。
export const HTTP_ROUTES = {
  ping: ['GET', '/api/settings/'],
  // R4-F2a：官方 2.4.0 规范里 all-tables 的 operationId=list_all_token_tables，security 仅 **Database token**；
  // 它按“令牌可见范围”列出表，**不能**证明表属于指定 database_id。结构工作（建表/建字段/视图）必须用
  // 库作用域的 list_database_tables（security 仅 **JWT**）。
  listTablesTokenScope: ['GET', '/api/database/tables/all-tables/'],
  listTablesInDatabase: ['GET', '/api/database/tables/database/{database_id}/'],
  createTable: ['POST', '/api/database/tables/database/{database_id}/'],      // body: TableCreate(name…) required
  listFields: ['GET', '/api/database/fields/table/{table_id}/'],
  createField: ['POST', '/api/database/fields/table/{table_id}/'],
  updateField: ['PATCH', '/api/database/fields/{field_id}/'],
  listRows: ['GET', '/api/database/rows/table/{table_id}/'],
  createRow: ['POST', '/api/database/rows/table/{table_id}/'],
  updateRow: ['PATCH', '/api/database/rows/table/{table_id}/{row_id}/'],
  listViews: ['GET', '/api/database/views/table/{table_id}/'],
  createView: ['POST', '/api/database/views/table/{table_id}/'],
  updateView: ['PATCH', '/api/database/views/{view_id}/'],
  // R4-F2b：既有视图必须可**补齐**过滤/排序，所以需要 GET 侧端点做差异对账（规范：两者 security 均仅 JWT）
  listViewFilters: ['GET', '/api/database/views/{view_id}/filters/'],
  createViewFilter: ['POST', '/api/database/views/{view_id}/filters/'],       // body: field(字段ID), type, value, group
  listViewSortings: ['GET', '/api/database/views/{view_id}/sortings/'],
  createViewSort: ['POST', '/api/database/views/{view_id}/sortings/'],        // body: field, order, type
  exportWorkspace: ['POST', '/api/workspaces/{workspace_id}/export/async/'],
  importWorkspace: ['POST', '/api/workspaces/{workspace_id}/import/async/'],
};

// F2 修复：**区分两种鉴权**。官方两页一致：数据库 Token 只能读写**数据行**；
// 「create, update or delete the structure of the table」需要 **用户 JWT**。
//   来源：https://baserow.io/user-docs/personal-api-tokens 与 https://baserow.io/docs/apis%2Frest-api
//   JWT 获取端点：POST /api/user/token-auth/（username+password）。
//   两页对 JWT 有效期表述不一致（一页 7 分钟、另一页 60 分钟）→ 本库按“短时效”处理：
//   不缓存、不落盘，401/403 时给出明确的重新取用指引。
// 凭据一律来自调用方参数；本模块不读取、不打印、不落盘任何密钥。
export function createHttpClient({ baseUrl, token, mgmtToken = null, fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
  if (!baseUrl) throw new Error('baserow_client_requires_base_url');
  const base = baseUrl.replace(/\/+$/, '');
  const authHeader = (mode) => {
    if (mode === 'mgmt') return mgmtToken ? `JWT ${mgmtToken}` : (token ? `Token ${token}` : null);
    return token ? `Token ${token}` : (mgmtToken ? `JWT ${mgmtToken}` : null);
  };
  const authUsed = { mgmt: mgmtToken ? 'JWT' : (token ? 'Token(fallback)' : null), data: token ? 'Token' : (mgmtToken ? 'JWT(fallback)' : null) };
  async function req(method, path, body, mode = 'data') {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const auth = authHeader(mode);
    try {
      const res = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(auth ? { Authorization: auth } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal,
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
      if (!res.ok) {
        const err = new Error(`baserow_http_${res.status}:${method} ${path}`);
        err.status = res.status; err.body = json;
        if ((res.status === 401 || res.status === 403) && mode === 'mgmt') {
          err.hint = 'JWT 可能已过期（官方两页分别记 7 / 60 分钟）或权限不足；用 POST /api/user/token-auth/ 重新取得后立即 apply。';
        }
        throw err;
      }
      return json;
    } finally { clearTimeout(t); }
  }
  const P = (key, repl) => {
    let [m, p] = HTTP_ROUTES[key];
    for (const [k, v] of Object.entries(repl)) p = p.replace(`{${k}}`, String(v));
    return [m, p];
  };
  return {
    baseUrl: base,
    auth_used: authUsed,
    ping: () => req(HTTP_ROUTES.ping[0], HTTP_ROUTES.ping[1], undefined, 'data'),
    // R4-F2a：列出表有两条**不同鉴权**的路径，绝不混用凭据。
    //  - 库作用域（结构工作）：GET /api/database/tables/database/{database_id}/ —— 官方 2.4.0 security 仅 JWT。
    //  - 令牌作用域（只读自查）：GET /api/database/tables/all-tables/ —— security 仅 Database token。
    listTablesInDatabase: (databaseId) => {
      if (!databaseId) throw new Error('list_tables_in_database_requires_database_id');
      if (!mgmtToken) throw new Error('list_tables_in_database_requires_jwt：官方 2.4.0 该端点的 security 仅 JWT（数据库 Token 不足以做结构核对）');
      const [m, p] = P('listTablesInDatabase', { database_id: databaseId });
      return req(m, p, undefined, 'mgmt');
    },
    listTablesTokenScope: () => {
      if (!token) throw new Error('list_tables_token_scope_requires_database_token');
      const [m, p] = HTTP_ROUTES.listTablesTokenScope;
      return req(m, p, undefined, 'data');
    },
    createTable: (name, databaseId) => {
      if (!databaseId) throw new Error('create_table_requires_database_id：2.4.0 为 POST /api/database/tables/database/{database_id}/');
      const [m, p] = P('createTable', { database_id: databaseId });
      return req(m, p, { name }, 'mgmt');
    },
    listFields: (tableId) => { const [m, p] = P('listFields', { table_id: tableId }); return req(m, p, undefined, 'mgmt'); },
    createField: (tableId, field) => { const [m, p] = P('createField', { table_id: tableId }); return req(m, p, field, 'mgmt'); },
    updateField: (fieldId, patch) => { const [m, p] = P('updateField', { field_id: fieldId }); return req(m, p, patch, 'mgmt'); },
    deleteField: (fieldId) => { const [, p] = P('updateField', { field_id: fieldId }); return req('DELETE', p, undefined, 'mgmt'); },
    listRows: (tableId, params = '') => { const [, p] = P('listRows', { table_id: tableId }); return req('GET', `${p}?user_field_names=true${params}`, undefined, 'data'); },
    createRow: (tableId, row) => { const [, p] = P('createRow', { table_id: tableId }); return req('POST', `${p}?user_field_names=true`, row, 'data'); },
    updateRow: (tableId, rowId, row) => { const [, p] = P('updateRow', { table_id: tableId, row_id: rowId }); return req('PATCH', `${p}?user_field_names=true`, row, 'data'); },
    batchRows: (tableId, items) => req('POST', `/api/database/rows/table/${tableId}/batch/?user_field_names=true`, { items }, 'data'),
    listViews: (tableId) => { const [m, p] = P('listViews', { table_id: tableId }); return req(m, p, undefined, 'mgmt'); },
    createView: (tableId, view) => { const [m, p] = P('createView', { table_id: tableId }); return req(m, p, view, 'mgmt'); },
    updateView: (viewId, patch) => { const [m, p] = P('updateView', { view_id: viewId }); return req(m, p, patch, 'mgmt'); },
    // F2/R4-F2b：过滤器必须传**字段 ID**（不是字段名）；排序走 /sortings/；两者都要能**读回**做差异对账
    listViewFilters: (viewId) => { const [m, p] = P('listViewFilters', { view_id: viewId }); return req(m, p, undefined, 'mgmt'); },
    createViewFilter: (viewId, filter) => { const [m, p] = P('createViewFilter', { view_id: viewId }); return req(m, p, filter, 'mgmt'); },
    listViewSortings: (viewId) => { const [m, p] = P('listViewSortings', { view_id: viewId }); return req(m, p, undefined, 'mgmt'); },
    createViewSort: (viewId, sort) => { const [m, p] = P('createViewSort', { view_id: viewId }); return req(m, p, sort, 'mgmt'); },
    exportWorkspace: (workspaceId) => { const [m, p] = P('exportWorkspace', { workspace_id: workspaceId }); return req(m, p, {}, 'mgmt'); },
    importWorkspace: (workspaceId, payload) => { const [m, p] = P('importWorkspace', { workspace_id: workspaceId }); return req(m, p, payload, 'mgmt'); },
    _req: req,
  };
}

// F2：幂等的 schema + 视图落地。重复调用必须复用既有表/字段/视图，不得重复创建。
export async function ensureSchemaAndViews(client, { schema = planSchema(), views = planViews(), databaseId = null, existingTables = null } = {}) {
  const log = {
    scope: { database_id: databaseId ? Number(databaseId) : null, listing: existingTables ? 'caller_supplied' : 'list_tables_in_database', auth: 'JWT' },
    tables_created: [], tables_reused: [], primary_field_renamed: [], fields_created: [], fields_reused: [],
    type_mismatches: [], views_created: [], views_reused: [], views_repaired: [],
    filters_created: 0, filters_reused: 0, sorts_created: 0, sorts_reused: 0,
    filter_value_encodings: [], scope_errors: [],
  };
  // R4-F2a：结构工作必须在**具名 database** 内进行；没有 database_id 时 fail-closed（建表路由本身也要求它）
  if (!databaseId) throw new Error('ensure_schema_requires_database_id：需要建表，但未提供 --database-id（2.4.0 路由 /api/database/tables/database/{database_id}/）');

  let tables;
  if (existingTables) {
    // 调用方注入的表清单必须**自证**属于该 database：不允许靠全局同名匹配复用别库的同名表
    const list = Array.isArray(existingTables) ? existingTables : [];
    const foreign = list.filter((t) => t.database_id !== undefined && t.database_id !== null && Number(t.database_id) !== Number(databaseId));
    const unscoped = list.filter((t) => t.database_id === undefined || t.database_id === null);
    if (foreign.length || unscoped.length) {
      const scope_error = {
        reason: foreign.length ? 'existing_tables_belong_to_other_database' : 'existing_tables_scope_unverifiable',
        database_id: Number(databaseId),
        foreign: foreign.map((t) => ({ name: t.name, id: t.id, database_id: t.database_id })),
        unscoped_names: unscoped.map((t) => t.name),
        note: '范围不符/无法证明归属 → **零写入**（不建表、不建字段、不建视图）。',
      };
      log.scope_errors.push(scope_error);
      return { ok: false, scope_error, tableIds: {}, fieldIds: {}, fieldMeta: {}, log, scope: log.scope };
    }
    tables = list;
  } else {
    // 库作用域列出表（security 仅 JWT），而不是 all-tables（security 仅 Database token）
    tables = await client.listTablesInDatabase(databaseId);
  }
  const byName = new Map((Array.isArray(tables) ? tables : []).map((t) => [t.name, t]));
  const tableIds = {};
  const fieldIds = {};
  const fieldMeta = {};
  const schemaFieldType = {};
  for (const t of schema.tables) schemaFieldType[t.name] = Object.fromEntries(t.fields.map((f) => [f.name, f.type]));

  for (const t of schema.tables) {
    let entry = byName.get(t.name);
    if (!entry) {
      // 2.4.0 建表路由必须带 database_id；缺失时明确失败，不静默尝试不存在的路径
      if (!databaseId) throw new Error('ensure_schema_requires_database_id：需要建表，但未提供 --database-id（2.4.0 路由 /api/database/tables/database/{database_id}/）');
      entry = await client.createTable(t.name, databaseId);
      log.tables_created.push({ name: t.name, id: entry.id });
      byName.set(t.name, entry);
    } else log.tables_reused.push({ name: t.name, id: entry.id });
    tableIds[t.name] = entry.id;
  }

  for (const t of schema.tables) {
    const tableId = tableIds[t.name];
    const existingFields = await client.listFields(tableId);
    const fByName = new Map((existingFields ?? []).map((f) => [f.name, f]));
    fieldIds[t.name] = {};
    fieldMeta[t.name] = {};
    for (const f of t.fields) {
      const found = fByName.get(f.name);
      if (found) { fieldIds[t.name][f.name] = found.id; fieldMeta[t.name][f.name] = found; log.fields_reused.push({ table: t.name, name: f.name, id: found.id, type: found.type }); if (found.type !== f.type && !f.primary) log.type_mismatches.push({ table: t.name, name: f.name, expected: f.type, actual: found.type }); continue; }
      if (f.primary) {
        // Baserow 建表自带一个 primary 字段；把它改名为本表主键，而不是新建第二个 primary
        const currentPrimary = (existingFields ?? []).find((x) => x.primary);
        if (currentPrimary) {
          const renamed = await client.updateField(currentPrimary.id, { name: f.name });
          fieldIds[t.name][f.name] = renamed.id;
          fieldMeta[t.name][f.name] = { ...currentPrimary, ...renamed, name: f.name };
          log.primary_field_renamed.push({ table: t.name, from: currentPrimary.name, to: f.name, id: renamed.id });
          continue;
        }
      }
      const body = { name: f.name, type: f.type === 'link_row' ? 'link_row' : f.type };
      if (f.type === 'single_select') body.select_options = (f.options ?? []).map((o) => ({ value: o, color: 'light-blue' }));
      if (f.type === 'link_row') body.link_row_table_id = tableIds[f.linkTo];
      const created = await client.createField(tableId, body);
      fieldIds[t.name][f.name] = created.id;
      // R4-F2b：过滤值编码需要选项 ID → 保留字段元数据（建字段响应可能不回 options，用请求体兜底）
      fieldMeta[t.name][f.name] = { ...created, select_options: created.select_options ?? body.select_options ?? null };
      log.fields_created.push({ table: t.name, name: f.name, id: created.id, type: created.type });
    }
  }

  for (const v of views) {
    const tableId = tableIds[v.table];
    const existingViews = await client.listViews(tableId);
    // 同名**且**归属本表才算命中；否则视为另一个对象（不同表同名视图不得短路）
    const found = (existingViews ?? []).find((x) => x.name === v.name
      && (x.table_id === undefined || x.table_id === null || Number(x.table_id) === Number(tableId)));
    let view = found;
    if (found) log.views_reused.push({ table: v.table, name: v.name, id: found.id });
    else {
      view = await client.createView(tableId, { name: v.name, type: v.type });
      log.views_created.push({ table: v.table, name: v.name, id: view.id });
    }
    // R4-F2b：**既有视图也要对账**。原实现见到同名视图直接 continue，
    // 于是「建视图后、过滤/排序前」中断的复跑会永久跳过，视图永远配不齐。
    let createdFilters = 0, createdSorts = 0;
    const haveFilters = (await client.listViewFilters(view.id)) ?? [];
    const haveSorts = (await client.listViewSortings(view.id)) ?? [];
    for (const flt of v.filters ?? []) {
      const fid = fieldIds[v.table]?.[flt.field];
      if (!fid) { log.type_mismatches.push({ view: v.name, field: flt.field, issue: 'filter_field_not_found' }); continue; }
      const enc = encodeFilterValue({
        fieldType: schemaFieldType[v.table]?.[flt.field] ?? null,
        fieldMeta: fieldMeta[v.table]?.[flt.field] ?? null,
        filterType: flt.type, value: flt.value,
      });
      log.filter_value_encodings.push({ view: v.name, field: flt.field, filter_type: flt.type, encoding: enc.encoding, value: enc.value });
      if (enc.value === null) { log.type_mismatches.push({ view: v.name, field: flt.field, issue: enc.encoding, wanted: enc.wanted }); continue; }
      const want = { field: fid, type: flt.type, value: enc.value };
      if (haveFilters.some((h) => sameFilter(h, want))) { log.filters_reused++; continue; }
      await client.createViewFilter(view.id, want);
      haveFilters.push(want); log.filters_created++; createdFilters++;
    }
    for (const s of v.sorts ?? []) {
      const fid = fieldIds[v.table]?.[s.field];
      if (!fid) { log.type_mismatches.push({ view: v.name, field: s.field, issue: 'sort_field_not_found' }); continue; }
      const want = { field: fid, order: s.direction ?? 'ASC' };
      if (haveSorts.some((h) => sameSort(h, want))) { log.sorts_reused++; continue; }
      await client.createViewSort(view.id, want);
      haveSorts.push(want); log.sorts_created++; createdSorts++;
    }
    if (found && (createdFilters || createdSorts)) {
      log.views_repaired.push({ table: v.table, name: v.name, id: view.id, filters_created: createdFilters, sorts_created: createdSorts });
    }
  }
  return { ok: log.type_mismatches.length === 0, tableIds, fieldIds, fieldMeta, log, scope: log.scope };
}

// ---------------------------------------------------------------- 视图过滤/排序值编码（R4-F2b）
// 复审结论：过滤值原先一律 String(label)，对 single_select 是错的（该端点要**选项 ID**），
// 布尔也要 'true'/'false' 字面量。这里按字段类型显式编码；解析不到就**返回 unresolved 并记录**，
// 不猜、不静默发送 label 冒充成功。
const FILTER_VALUE_ENCODERS = {
  boolean: (v) => (v === true || v === 'true' ? 'true' : 'false'),
  single_select: (v, meta) => {
    const opt = (meta?.select_options ?? []).find((o) => o.value === v || String(o.id) === String(v));
    return opt && opt.id !== undefined && opt.id !== null && Number.isFinite(Number(opt.id)) ? String(opt.id) : null;
  },
  number: (v) => String(v),
  date: (v) => String(v),
  text: (v) => String(v),
  long_text: (v) => String(v),
  url: (v) => String(v),
  link_row: (v) => String(v),
};

export function encodeFilterValue({ fieldType, fieldMeta = null, filterType, value }) {
  if (filterType === 'not_empty' || filterType === 'empty') return { value: '', encoding: 'no_value' };
  const enc = FILTER_VALUE_ENCODERS[fieldType];
  if (!enc) return { value: String(value), encoding: 'unverified_field_type_passthrough', fieldType };
  const out = enc(value, fieldMeta);
  if (out === null) return { value: null, encoding: 'unresolved_single_select_option_id', fieldType, wanted: value };
  return { value: out, encoding: fieldType === 'single_select' ? 'single_select_option_id' : `${fieldType}_literal` };
}

export function sameFilter(a, b) {
  return String(a?.field) === String(b?.field) && String(a?.type) === String(b?.type)
    && String(a?.value ?? '') === String(b?.value ?? '');
}
export function sameSort(a, b) {
  return String(a?.field) === String(b?.field)
    && String(a?.order ?? 'ASC').toUpperCase() === String(b?.order ?? 'ASC').toUpperCase();
}

// ---------------------------------------------------------------- backend contract
// F1 修复：内存与真实 HTTP 目标共用**同一异步契约**。真实 HTTP 调用不得用同步 Map API 模拟。
// 主键：每张表按稳定源键去重；导入结果必须给出**目标行 ID**，而不是合成序号。
export const TABLE_PRIMARY_KEY = {
  [TABLE_VIDEOS]: 'entity_key',
  [TABLE_METRICS]: 'observation_id',
  [TABLE_RATIOS]: 'ratio_id',
  [TABLE_ASSETS]: 'asset_id',
  [TABLE_SEGMENTS]: 'segment_id',
};
// 写入顺序：Videos 先（被引用），Assets 次（Segments 引用它），其余随后。
// F2：表间用 **link_row 原生关联**（linkTo），而不是只留文本键。
export const ALL_TABLES = [TABLE_VIDEOS, TABLE_ASSETS, TABLE_SEGMENTS, TABLE_METRICS, TABLE_RATIOS];
// 关联字段：{ 表: { 字段名: { linkTo } } } —— 导入时用已绑定的目标行 ID 填充。
export const LINK_FIELDS = {
  [TABLE_ASSETS]: { video_link: TABLE_VIDEOS },
  [TABLE_SEGMENTS]: { video_link: TABLE_VIDEOS, asset_link: TABLE_ASSETS },
  [TABLE_METRICS]: { video_link: TABLE_VIDEOS },
  [TABLE_RATIOS]: { video_link: TABLE_VIDEOS },
};

// 内存后端：仅用于离线验证适配器语义。**不是** Baserow，不能作为 Baserow 验收证据。
export function createMemoryBackend({ failOnInsert = null, failOnTable = null } = {}) {
  const tables = new Map();
  let rowSeq = 0, tableSeq = 0;
  const ensure = (name) => { if (!tables.has(name)) tables.set(name, new Map()); return tables.get(name); };
  const stats = { inserts: 0, updates: 0, reads: 0 };
  return {
    kind: 'memory_backend_not_baserow',
    stats,
    async createTable(name) { ensure(name); return { id: ++tableSeq, name }; },
    async listTables() { return [...tables.keys()].map((n, i) => ({ id: i + 1, name: n, database_id: 1 })); },
    // R4-F2a：内存替身同样只暴露**库作用域**的表清单，避免测试掩盖“全局同名匹配”缺陷
    async listTablesInDatabase(databaseId) {
      if (!databaseId) throw new Error('list_tables_in_database_requires_database_id');
      return [...tables.keys()].map((n, i) => ({ id: i + 1, name: n, database_id: Number(databaseId) }));
    },
    async listViews() { return []; },
    async listViewFilters() { return []; },
    async listViewSortings() { return []; },
    async listAllRows(name) { stats.reads++; ensure(name); return [...ensure(name).values()]; },
    async insertRow(name, row) {
      // 故障注入：用于验证「写入失败不得给出成功回执」
      if (failOnInsert && failOnInsert(name, row)) { const e = new Error(`injected_insert_failure:${name}`); e.injected = true; throw e; }
      if (failOnTable === name) { const e = new Error(`injected_table_failure:${name}`); e.injected = true; throw e; }
      stats.inserts++;
      const rec = { id: ++rowSeq, ...row };
      ensure(name).set(row[TABLE_PRIMARY_KEY[name]], rec);
      return rec;
    },
    async updateRow(name, rowId, patch) {
      stats.updates++;
      const t = ensure(name);
      for (const [k, v] of t) if (v.id === rowId) { const next = { ...v, ...patch }; t.set(k, next); return next; }
      throw new Error(`memory_update_target_not_found:${name}#${rowId}`);
    },
    // 兼容既有测试的同步助手（import 路径一律走上面的 async 方法）
    listRows(name) { return [...ensure(name).values()]; },
    getRow(name, key) { return ensure(name).get(key) ?? null; },
    putRow(name, key, row) { ensure(name).set(key, row); return row; },
    deleteRow(name, key) { return ensure(name).delete(key); },
    tableNames() { return [...tables.keys()]; },
  };
}

// ------------------------------------------------ R4-F1b：HTTP 形状 ↔ 逻辑行的显式边界转换
// Baserow 读回形状（user_field_names=true）里：link_row → [{id,value}]、single_select → {id,value}、
// file → [{…}]，每行还带只读的 id/order；而**写入**只接受可写意图。原实现把 API 对象原样传进逻辑层、
// 又把整个 prev 原样 PATCH 回去，既产生假差异，也可能把只读字段写回目标。
const SCHEMA_FIELD_TYPES = (() => {
  const m = {};
  for (const t of planSchema().tables) m[t.name] = Object.fromEntries(t.fields.map((f) => [f.name, f.type]));
  return m;
})();
const ROW_META_FIELDS = ['id', 'order'];

export function decodeApiRow(table, row) {
  if (!row || typeof row !== 'object') return row;
  const types = SCHEMA_FIELD_TYPES[table] ?? {};
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    const t = types[k];
    if (t === 'link_row') out[k] = Array.isArray(v) ? v.map((x) => (x && typeof x === 'object' ? x.id : x)) : (v ?? []);
    else if (t === 'single_select') out[k] = (v && typeof v === 'object' && 'value' in v) ? v.value : (v ?? null);
    else out[k] = v;
  }
  out.id = row.id ?? null;                     // 行 ID 必须保留：写回与父子关联都靠它
  if ('order' in row) out.__order = row.order; // 只读元数据改名，避免被写回
  return out;
}

// 只发**可写意图**：丢掉只读元数据；file 字段不在行写入里伪造（必须走上传接口）；
// 空 link_row 不发（避免把既有关系清空）；single_select 有选项 ID 时发 ID。
export function encodeWritePayload(table, row, fieldMetaForTable = null) {
  const types = SCHEMA_FIELD_TYPES[table] ?? {};
  const meta = fieldMetaForTable ?? {};
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (ROW_META_FIELDS.includes(k) || k === '__order') continue;
    const t = types[k];
    if (t === undefined) continue;      // 不在本表 schema 内的键（含 id/order 等只读元数据）一律不发
    if (t === 'file') continue;
    if (t === 'link_row') {
      const ids = (Array.isArray(v) ? v : []).map((x) => Number(x && typeof x === 'object' ? x.id : x)).filter((n) => Number.isFinite(n));
      if (ids.length) out[k] = ids;
      continue;
    }
    if (t === 'single_select') {
      if (v === undefined) continue;
      const opt = (meta?.[k]?.select_options ?? []).find((o) => o.value === v || String(o.id) === String(v));
      out[k] = opt ? String(opt.id) : v;
      continue;
    }
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

// 真实 Baserow 后端：分页读回 + 真实写入 + 目标行 ID。读回已是**逻辑行**，写入只发可写意图。
export function createHttpBackend({ client, tableIds, fieldMeta = {}, pageSize = 100, userFieldNames = true } = {}) {
  if (!client) throw new Error('http_backend_requires_client');
  const q = userFieldNames ? '&user_field_names=true' : '';
  const idOf = (tableName) => {
    const id = tableIds?.[tableName];
    if (!id) throw new Error(`http_backend_missing_table_id:${tableName}`);
    return id;
  };
  const stats = { reads: 0, pages: 0, inserts: 0, updates: 0, decoded: 0, encoded: 0 };
  return {
    kind: 'baserow_http',
    stats,
    // 分页读回：必须消费 next 直到为 null，证明多页读取而非只取首页
    async listAllRows(tableName) {
      const tableId = idOf(tableName);
      const out = [];
      let page = 1, next = true;
      while (next) {
        stats.reads++; stats.pages++;
        const res = await client.listRows(tableId, `&page=${page}&size=${pageSize}${q}`);
        const results = res?.results ?? (Array.isArray(res) ? res : []);
        out.push(...results.map((r) => { stats.decoded++; return decodeApiRow(tableName, r); }));
        next = !!res?.next && results.length > 0;
        page++;
        if (page > 1000) throw new Error(`http_backend_pagination_runaway:${tableName}`);
      }
      return out;
    },
    async insertRow(tableName, row) {
      const tableId = idOf(tableName);
      const payload = encodeWritePayload(tableName, row, fieldMeta?.[tableName] ?? null);
      stats.encoded++;
      const res = await client.createRow(tableId, payload);
      stats.inserts++;
      return decodeApiRow(tableName, res);
    },
    async updateRow(tableName, rowId, patch) {
      const tableId = idOf(tableName);
      const payload = encodeWritePayload(tableName, patch, fieldMeta?.[tableName] ?? null);
      stats.encoded++;
      const res = await client.updateRow(tableId, rowId, payload);
      stats.updates++;
      return decodeApiRow(tableName, res);
    },
  };
}

// ---------------------------------------------------------------- import
// R6-STEP3：可选把**实际发布**的本地观看服务地址接进记录的可点击字段（绝对 URL），
// 用户/测试都不必手工拼接相对路由；未发布时显式标 `not_published`，不产生坏链接。
export function rowsOf(records, { mediaBaseUrl = null } = {}) {
  const viewUrl = (viewPath) => (mediaBaseUrl && viewPath ? absoluteViewUrl(mediaBaseUrl, viewPath) : null);
  const serviceState = mediaBaseUrl ? 'published' : 'not_published';
  const videos = [], metrics = [], ratios = [], assets = [], segments = [];
  for (const r of records) {
    videos.push({
      entity_key: r.entity_key,
      platform: r.platform,
      namespace: r.namespace,
      native_id: r.native_id,
      branch: r.branch,
      canonical_url: r.identity.canonical_url,
      derived_permalink: r.identity.derived_permalink,
      author_id: r.identity.author_id,
      author_display_name: r.identity.author_display_name,
      author_follower_count: r.identity.author_follower_count,
      media_type: r.identity.media_type,
      duration_seconds: r.identity.duration_seconds,
      publish_date_epoch_s: r.classification.publish_date_epoch_s,
      publish_date_label: r.classification.publish_date_label,
      language: r.classification.language,
      product_category: r.classification.product_category,
      product_function: r.classification.product_function,
      scene_or_need: r.classification.scene_or_need,
      // F4：有效分类附来源归属/复核人/证据/状态，UI 可直接区分「来源事实」与「人工复核」
      ...Object.fromEntries(CLASSIFICATION_BASE_FIELDS.flatMap((b) => [
        [`${b}_origin`, r.classification[`${b}_origin`] ?? 'unknown_no_source'],
        [`${b}_reviewer`, r.classification[`${b}_reviewer`] ?? null],
        [`${b}_evidence_ref`, r.classification[`${b}_evidence_ref`] ?? null],
        [`${b}_state`, r.classification[`${b}_state`] ?? null],
      ])),
      entity_source_state: r.availability.entity_source_state,
      join_reason_class: r.availability.join_reason_class,
      decision: r.provenance.decision,
      identity_confidence: r.provenance.identity_confidence,
      provenance_class: r.provenance.provenance_class,
      retained_path: r.provenance.retained_path,
      evidence_fingerprint: r.evidence_fingerprint,
      aid_branch: r.aid_branch,
      metrics_observed: r.availability.fields_observed,
      // 人工复核字段（来自人工覆盖层；导入永不覆盖既有值）
      review_status: r.review.status,
      review_reviewer: r.review.reviewer,
      review_reviewed_at: r.review.reviewed_at,
      review_notes: r.review.notes.length ? r.review.notes.join('\n') : null,
      review_value_categories: r.review.human_value_categories.length ? r.review.human_value_categories.join(',') : null,
      selected_reference: r.review.selected_reference === true,
      review_stale: r.review.stale === true,
      review_stale_reason: r.review.stale_reason,
    });
    for (const m of r.metrics) {
      metrics.push({
        // R4-F1b：观测身份必须**唯一**。原式用 `source_sha256 ?? source_file`，当两份不同留存文件
        // 内容相同（sha 相同）且观测时刻缺失时会产生同 ID → 后写覆盖前写，读回对账立刻暴露
        // 840 条 first 行丢失。这里改为把两个来源标识都纳入身份：不同留存文件 = 不同观测。
        observation_id: [r.entity_key, m.field, m.observed_at_epoch_s ?? 'na', m.source_sha256 ?? 'na', m.source_file ?? 'na'].join('|'),
        entity_key: r.entity_key, field: m.field, status: m.status, value_text: m.value,
        fact_origin: m.fact_origin ?? (m.derived ? 'derived' : 'source_fact'),
        error_reason: m.error_reason ?? null,
        validation_rule: m.validation?.rule ?? null,
        metric_definition: m.metric_definition ?? null,
        metric_caveat: m.metric_caveat ?? null,
        comparable_across_platforms: false,
        numeric_value: m.numeric_value, unit: m.unit, observed_at_epoch_s: m.observed_at_epoch_s,
        observation_basis: m.observation_basis, identity_basis: m.identity_basis,
        retention_grade: m.retention_grade, locator: m.locator,
        source_file: m.source_file, source_sha256: m.source_sha256,
      });
    }
    for (const x of r.ratios) {
      ratios.push({
        ratio_id: [r.entity_key, x.key].join('|'), entity_key: r.entity_key, ratio_key: x.key,
        status: x.status, value: x.value ?? null, unit: x.unit ?? null,
        reason: x.reason ?? null, attribution: x.attribution ?? null,
      });
    }
    for (const a of r.assets) {
      assets.push({
        asset_id: a.asset_id, entity_key: r.entity_key, cohort: a.cohort, local_path: a.local_path,
        local_path_recorded: a.local_path_recorded ?? null, path_source: a.path_source ?? null,
        media_kind: a.media_kind ?? null, usable_as_video: a.usable_as_video === true,
        // R5 STEP4：记录内直接给出可定位的本地点播入口（相对路由；绝对地址由 media --serve 发布）
        media_view_path: a.usable_as_video === true ? `/viewer?asset=${encodeURIComponent(a.asset_id)}` : null,
        media_view_url: a.usable_as_video === true ? viewUrl(`/viewer?asset=${encodeURIComponent(a.asset_id)}`) : null,
        media_seek_seconds: a.usable_as_video === true ? ((a.segments ?? [])[0]?.start_seconds ?? null) : null,
        media_service_state: serviceState,
        kind_reject_reason: a.kind_reject_reason ?? null,
        sha256: a.sha256, sha256_match: a.sha256_match === true, bytes: a.bytes,
        actual_bytes: a.actual_bytes ?? null,
        duration_seconds: a.duration_seconds, resolution: a.resolution,
        contact_sheet: a.contact_sheet, card_file: a.card_file, timeline_entries: a.timeline_entries,
        rights_status: a.rights_status, verified_present_locally: a.verified_present_locally === true,
      });
      for (const s of a.segments ?? []) {
        segments.push({
          segment_id: s.segment_id, entity_key: r.entity_key, asset_id: a.asset_id,
          index: s.index, t_label: s.t_label, start_seconds: s.start_seconds,
          observed: s.observed, onscreen_text: s.onscreen_text, speech: s.speech,
          kind: s.kind, fact_origin: s.fact_origin, origin_card: s.origin_card,
          origin_method: s.origin_method, time_accuracy_note: s.time_accuracy_note,
          coverage: s.coverage, human_note: s.human_note ?? null,
          view_path: `/viewer?asset=${encodeURIComponent(a.asset_id)}&t=${s.start_seconds ?? 0}`,
          view_url: viewUrl(`/viewer?asset=${encodeURIComponent(a.asset_id)}&t=${s.start_seconds ?? 0}`),
          media_service_state: serviceState,
          review_status: s.review_status ?? 'unreviewed',
          selected_reference: s.selected_reference === true,
        });
      }
    }
  }
  return { [TABLE_VIDEOS]: videos, [TABLE_METRICS]: metrics, [TABLE_RATIOS]: ratios, [TABLE_ASSETS]: assets, [TABLE_SEGMENTS]: segments };
}

// 计算「相对既有目标状态」的差异。人工字段永不进入更新集合。
export function planMerge(incoming, existing, { humanFields = HUMAN_FIELDS } = {}) {
  const result = { inserted: [], updated: [], unchanged: [], stale: [], rejected: [], preserved_human_fields: [] };
  const byKey = new Map(existing.map((r) => [r.entity_key, r]));
  for (const inc of incoming) {
    const prev = byKey.get(inc.entity_key);
    if (!prev) { result.inserted.push(inc.entity_key); continue; }
    if (prev.platform !== inc.platform || prev.namespace !== inc.namespace) {
      result.rejected.push({ entity_key: inc.entity_key, reason: 'namespace_or_platform_mismatch_refused' });
      continue;
    }
    if (prev.native_id !== inc.native_id) {
      result.rejected.push({ entity_key: inc.entity_key, reason: 'native_id_mismatch_refused' });
      continue;
    }
    const diff = {};
    for (const [k, v] of Object.entries(inc)) {
      if (humanFields.includes(k)) continue;
      if (JSON.stringify(prev[k] ?? null) !== JSON.stringify(v ?? null)) diff[k] = v;
    }
    const evidenceChanged = prev.evidence_fingerprint && inc.evidence_fingerprint
      && prev.evidence_fingerprint !== inc.evidence_fingerprint;
    if (evidenceChanged) {
      result.stale.push({ entity_key: inc.entity_key, from: prev.evidence_fingerprint, to: inc.evidence_fingerprint });
      for (const h of humanFields) if (prev[h] !== undefined && prev[h] !== null) result.preserved_human_fields.push({ entity_key: inc.entity_key, field: h });
      if (prev.review_notes) {
        result.preserved_human_fields.push({ entity_key: inc.entity_key, field: 'review_notes(kept_text)' });
      }
      result.updated.push({ entity_key: inc.entity_key, changed: { ...diff, review_stale: true, review_stale_reason: `evidence_changed:${prev.evidence_fingerprint}->${inc.evidence_fingerprint}` } });
    } else if (Object.keys(diff).length === 0) {
      result.unchanged.push(inc.entity_key);
    } else {
      result.updated.push({ entity_key: inc.entity_key, changed: diff });
    }
  }
  return result;
}

// ------------------------------------------------ R4-F1a/F1b：写入意图比较器
// 复审结论：原实现「update 抛错后只要旧主键还在就算 updated」会把**确定性拒绝**当成功。
// 正确判据是：读回目标行后，逐字段比对**本次写入意图**是否真的落地（关联按 ID 集合比较）。
export function logicalEqual(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    const x = Array.isArray(a) ? a : (a === undefined || a === null ? [] : [a]);
    const y = Array.isArray(b) ? b : (b === undefined || b === null ? [] : [b]);
    return x.length === y.length && x.every((v, i) => String(v) === String(y[i]));
  }
  if (a === null || a === undefined) return b === null || b === undefined || b === '';
  if (b === null || b === undefined) return a === '';
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return String(a) === String(b);
}

const READONLY_LOGICAL = ['id', 'order', '__order'];

export function compareIntent({ intent, row, ignore = [] }) {
  const mismatches = [];
  let compared = 0;
  for (const [k, want] of Object.entries(intent ?? {})) {
    if (READONLY_LOGICAL.includes(k) || ignore.includes(k)) continue;
    compared++;
    if (!logicalEqual(want, row?.[k])) mismatches.push({ field: k, wanted: want ?? null, actual: row?.[k] ?? null });
  }
  return { ok: mismatches.length === 0, mismatches, compared };
}

// R5-STEP2：目标主键重复检测。必须在把行收进 Map（后者会静默折叠成一条）**之前**调用。
// 策略：只报事实与行 ID，**不**挑赢家、**不**删除目标数据；恢复路径由人工按行 ID 处理。
export function detectDuplicateTargetKeys({ table, rows, source, receipt }) {
  const pk = TABLE_PRIMARY_KEY[table];
  const seen = new Map();
  const dups = [];
  for (const r of rows ?? []) {
    const k = String(r?.[pk]);
    if (seen.has(k)) dups.push({ key: k, row_ids: [seen.get(k)?.id ?? null, r?.id ?? null] });
    else seen.set(k, r);
  }
  if (!dups.length) return [];
  receipt.target_duplicates.push({ table, source, unique_keys: seen.size, returned_rows: (rows ?? []).length, duplicate_count: dups.length, sample: dups.slice(0, 3) });
  receipt.errors.push({
    table, op: 'reconcile', error_code: 'duplicate_target_primary_key', source,
    duplicate_count: dups.length, sample: dups.slice(0, 3),
    recovery_path: '按 sample 的行 ID 人工核对后处理；本工具不自动删除、不自动挑选赢家，也不据此声称导入成功。',
  });
  return dups;
}

// R7-STEP3：媒体**发布字段**（值由 rowsOf 的 viewUrl/serviceState 产生）。
// 语义三态：未提供选项 ≠ 显式停止发布。未提供时，已有目标行上的这些字段必须保留，
// 不得因为“本次没配发布地址”就把已发布链接清空；显式 null/'' 才表示停止发布并清除。
export const MEDIA_PUBLICATION_FIELDS = {
  [TABLE_ASSETS]: ['media_view_url', 'media_service_state'],
  [TABLE_SEGMENTS]: ['view_url', 'media_service_state'],
};

// 执行导入（对任意 backend：HTTP 或 memory）。返回回执。
// F1/F3 修复：真实写入 + 分页读回 + 目标行 ID 绑定 + 不确定写入复核，**五张表全部覆盖**。
// 连接成功不等于导入成功：任何写入失败都会使 ok=false，不得给出成功回执。
export async function importRecords({
  records, backend, mode = 'memory', dryRun = false, bindingsPath = null, humanFields = HUMAN_FIELDS, mediaBaseUrl,
} = {}) {
  // R7-STEP3：mediaBaseUrl 三态 —— undefined=未指定（保留目标现有发布字段）；字符串=发布；null/''=显式停止发布。
  const mediaSpecified = mediaBaseUrl !== undefined;
  const effectiveMediaBaseUrl = mediaSpecified ? (mediaBaseUrl || null) : null;
  const payload = rowsOf(records, { mediaBaseUrl: effectiveMediaBaseUrl });
  const receipt = {
    adapter: ADAPTER_VERSION, mode, dry_run: !!dryRun, started_at: new Date().toISOString(),
    backend_kind: backend?.kind ?? null,
    media_service: {
      base_url: effectiveMediaBaseUrl, state: effectiveMediaBaseUrl ? 'published' : 'not_published',
      option_provided: mediaSpecified,
      semantics: mediaSpecified
        ? (effectiveMediaBaseUrl ? 'explicit_publish' : 'explicit_unpublish_clears_links')
        : 'unspecified_preserve_existing_target_links',
    },
    planned: Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, v.length])),
    tables: {}, bindings: { path: bindingsPath, count: 0 },
    rejected: [], errors: [], reconciled_uncertain_writes: [],
    target_duplicates: [],   // R5-STEP2：目标主键重复（含仅最终读回可见的），非空即不得报成功
    blocked_ambiguous_writes: [],   // R6-STEP1：因歧义重复键被阻断写入的键（含依赖子行）
    ambiguous_keys: {},
    ok: false,
  };
  if (dryRun || !backend) {
    receipt.note = 'dry_run_plan_only：只给规模，不连接目标、不写入。';
    receipt.finished_at = new Date().toISOString();
    return receipt;
  }

  // 1) 分页读回全部 5 张表的现有行（**收进 Map 之前**先检测目标重复主键）
  const existing = {};
  // R6-STEP1：歧义键（目标里同一主键出现多行）在折叠进 Map **之前**保留身份，
  // 并在此后的写入中**阻断**这些键及其依赖子行 —— 不选赢家、不删除、不静默重绑。
  const ambiguousKeys = {};
  for (const t of ALL_TABLES) {
    existing[t] = await backend.listAllRows(t);
    const dups = detectDuplicateTargetKeys({ table: t, rows: existing[t], source: 'pre_write_readback', receipt });
    ambiguousKeys[t] = new Set(dups.map((d) => String(d.key)));
  }
  receipt.readback = Object.fromEntries(ALL_TABLES.map((t) => [t, { existing_rows: existing[t].length }]));
  receipt.ambiguous_keys = Object.fromEntries(ALL_TABLES.map((t) => [t, [...ambiguousKeys[t]]]));
  const isAmbiguous = (table, key) => ambiguousKeys[table]?.has(String(key)) === true;
  const blockAmbiguous = (table, key, reason, extra = {}) => {
    receipt.blocked_ambiguous_writes.push({ table, key, reason, ...extra });
    receipt.errors.push({
      table, key, op: 'blocked', error_code: 'blocked_ambiguous_duplicate_key', reason,
      recovery_path: '人工按目标行 ID 处理重复；本工具不选赢家、不删除、不重绑子行。',
      ...extra,
    });
    failedRowIds.add(`${table}|${key}`);
    bump(table, 'blocked');
  };

  // 1b) R4：计划内**主键唯一性**检查。同一批计划里出现重复主键时，后写会静默覆盖前写，
  //     读回对账会看到“字段不符”。这里先测出来并如实报缺陷，而不是让写入掩盖它。
  receipt.plan_defects = [];
  for (const t of ALL_TABLES) {
    const pk = TABLE_PRIMARY_KEY[t];
    const seen = new Map();
    const dup = [];
    for (const row of payload[t]) {
      const k = String(row[pk]);
      if (seen.has(k)) dup.push(k); else seen.set(k, row);
    }
    if (dup.length) {
      receipt.plan_defects.push({ table: t, issue: 'duplicate_primary_key_in_planned_payload', duplicate_count: dup.length, sample_keys: dup.slice(0, 3) });
      receipt.errors.push({ table: t, op: 'plan', error_code: 'duplicate_primary_key_in_planned_payload', duplicate_count: dup.length, sample_keys: dup.slice(0, 3) });
      payload[t] = [...seen.values()];   // 首次出现为准（保持可判定），并把缺陷交给调用方处置
      receipt.planned[t] = payload[t].length;
    }
  }

  const bindings = {};
  const failedRowIds = new Set();   // `${table}|${key}`：已知失败/跳过，写后对账不得把它算成“成功”
  // R7-STEP3：记录“未指定发布选项时被保留的既有发布字段”，使该语义可被回执与测试直接核对。
  const mediaPreserved = [];
  receipt.media_publication_preserved = mediaPreserved;
  // R5-STEP2：每张表记录「按写入策略算出的期望最终行」，供不确定写入复核与写后对账逐字段使用。
  const expectedFinal = {};
  for (const t of ALL_TABLES) expectedFinal[t] = new Map();
  for (const t of ALL_TABLES) receipt.tables[t] = { inserted: 0, updated: 0, unchanged: 0, rejected: 0, error: 0, unresolved: 0, skipped: 0, blocked: 0 };
  const bump = (table, status) => { const c = receipt.tables[table]; c[status] = (c[status] ?? 0) + 1; };

  // R5-STEP2：不确定写入复核**不再**整族豁免人工字段。`next` 本身就是按实际写入策略算出的
  // 「期望最终行」（既有行的人工值已按保留策略覆盖、证据变化已带 stale 及原因），因此直接按它逐字段核对。
  const writeRow = async (table, key, next, prev) => {
    const pk = TABLE_PRIMARY_KEY[table];
    const intent = Object.fromEntries(Object.entries(next).filter(([k]) => !READONLY_LOGICAL.includes(k)));
    if (prev) {
      const changed = Object.keys(next).some((k) => !READONLY_LOGICAL.includes(k) && !logicalEqual(prev[k], next[k]));
      if (!changed) return { status: 'unchanged', row_id: prev.id ?? null };
      try {
        const updated = await backend.updateRow(table, prev.id, next);
        return { status: 'updated', row_id: updated?.id ?? prev.id ?? null };
      } catch (e) {
        // 不确定写入：读回复核，但**必须比对本次写入意图**，不能“旧行还在”就算成功
        let reread = null;
        try { reread = await backend.listAllRows(table); } catch (e2) {
          receipt.errors.push({ table, key, op: 'update', error_code: 'reread_failed_after_update_error', error: String(e.message) });
          return { status: 'unresolved', row_id: null };
        }
        const found = reread.find((r) => String(r[pk]) === String(key));
        if (!found) {
          receipt.errors.push({ table, key, op: 'update', error_code: 'update_target_missing_after_error', error: String(e.message) });
          return { status: 'error', row_id: null };
        }
        const cmp = compareIntent({ intent, row: found });
        if (cmp.ok) {
          receipt.reconciled_uncertain_writes.push({ table, key, resolved: 'present_with_intended_values_after_update_error', row_id: found.id, compared_fields: cmp.compared });
          return { status: 'updated', row_id: found.id };
        }
        receipt.errors.push({
          table, key, op: 'update', error_code: 'update_not_applied_old_row_survived', error: String(e.message),
          compared_fields: cmp.compared, mismatches: cmp.mismatches.slice(0, 8),
        });
        return { status: 'error', row_id: found.id ?? null };
      }
    }
    try {
      const created = await backend.insertRow(table, next);
      return { status: 'inserted', row_id: created?.id ?? null };
    } catch (e) {
      let reread = null;
      try { reread = await backend.listAllRows(table); } catch (e2) {
        receipt.errors.push({ table, key, op: 'insert', error_code: 'reread_failed_after_insert_error', error: String(e.message) });
        return { status: 'unresolved', row_id: null };
      }
      const found = reread.find((r) => String(r[pk]) === String(key));
      if (found) {
        const cmp = compareIntent({ intent, row: found });
        if (cmp.ok) {
          receipt.reconciled_uncertain_writes.push({ table, key, resolved: 'present_with_intended_values_after_insert_error', row_id: found.id, compared_fields: cmp.compared });
          return { status: 'inserted', row_id: found.id };
        }
        receipt.errors.push({ table, key, op: 'insert', error_code: 'insert_error_row_present_but_values_differ', error: String(e.message), mismatches: cmp.mismatches.slice(0, 8) });
        return { status: 'error', row_id: found.id ?? null };
      }
      receipt.errors.push({ table, key, op: 'insert', error_code: 'insert_definitively_rejected', error: String(e.message) });
      return { status: 'error', row_id: null };
    }
  };

  // 2) Videos：先算 merge（人工字段保留 + 证据变化 stale），再按结果落库
  const merge = planMerge(payload[TABLE_VIDEOS], existing[TABLE_VIDEOS], { humanFields });
  receipt.videos = {
    inserted: merge.inserted.length, updated: merge.updated.length, unchanged: merge.unchanged.length,
    stale: merge.stale.length, rejected: merge.rejected, preserved_human_fields: merge.preserved_human_fields,
  };
  receipt.rejected = merge.rejected;
  const staleByKey = new Map(merge.stale.map((s) => [s.entity_key, s]));
  const updatedByKey = new Map(merge.updated.map((u) => [u.entity_key, u.changed]));
  const rejectedKeys = new Set(merge.rejected.map((r) => r.entity_key));
  const videoExisting = new Map(existing[TABLE_VIDEOS].map((r) => [String(r[TABLE_PRIMARY_KEY[TABLE_VIDEOS]]), r]));
  bindings[TABLE_VIDEOS] = {};
  for (const inc of payload[TABLE_VIDEOS]) {
    const key = inc[TABLE_PRIMARY_KEY[TABLE_VIDEOS]];
    if (rejectedKeys.has(key)) { bump(TABLE_VIDEOS, 'rejected'); failedRowIds.add(`${TABLE_VIDEOS}|${key}`); continue; }
    // R6-STEP1：目标里该键有多行（歧义）→ 不写、不选赢家
    if (isAmbiguous(TABLE_VIDEOS, key)) { blockAmbiguous(TABLE_VIDEOS, key, 'target_has_duplicate_primary_key', { row_ids: (receipt.target_duplicates.find((d) => d.table === TABLE_VIDEOS && d.source === 'pre_write_readback')?.sample ?? []).map((s) => s.row_ids).flat() }); continue; }
    const prev = videoExisting.get(String(key));
    let next;
    if (!prev) {
      // F5 修复：首次插入**不得**把 review_status 强改为 unreviewed；人工覆盖层的有效复核必须带入库
      next = { review_stale: false, review_stale_reason: null, ...inc };
      if (next.review_status === undefined) next.review_status = 'unreviewed';
    } else if (updatedByKey.has(key)) {
      next = { ...prev, ...updatedByKey.get(key) };
      for (const h of humanFields) if (prev[h] !== undefined && h !== 'review_stale' && h !== 'review_stale_reason') next[h] = prev[h];
      if (staleByKey.has(key)) next.review_stale = true;
    } else next = prev;
    const res = await writeRow(TABLE_VIDEOS, key, next, prev);
    if (res.status === 'error' || res.status === 'unresolved') {
      bump(TABLE_VIDEOS, res.status);
      failedRowIds.add(`${TABLE_VIDEOS}|${key}`);
      continue;
    }
    bump(TABLE_VIDEOS, res.status);
    bindings[TABLE_VIDEOS][key] = res.row_id;
    expectedFinal[TABLE_VIDEOS].set(String(key), next);   // R5-STEP2：期望最终行来自实际写入策略
    if (res.row_id == null) failedRowIds.add(`${TABLE_VIDEOS}|${key}`);
    if (!prev) videoExisting.set(String(key), { ...next, id: res.row_id });
  }

  // 3) 其余四张表（含 Segments）按主键 upsert；**父行未写入 → 子行不写并带原因**，不得静默产生孤儿成功
  for (const table of ALL_TABLES.filter((t) => t !== TABLE_VIDEOS)) {
    const pk = TABLE_PRIMARY_KEY[table];
    const byKey = new Map(existing[table].map((r) => [String(r[pk]), r]));
    bindings[table] = {};
    for (const row of payload[table]) {
      const key = String(row[pk]);
      // R6-STEP1：自身键在目标里歧义 → 阻断该子行
      if (isAmbiguous(table, key)) { blockAmbiguous(table, key, 'target_has_duplicate_primary_key'); continue; }
      const linkSpec = LINK_FIELDS[table];
      let parentFailure = null;
      if (linkSpec) {
        // F2：用已写入并绑定到的**目标行 ID** 填充原生关联字段
        for (const [fieldName, targetTable] of Object.entries(linkSpec)) {
          const targetKey = targetTable === TABLE_VIDEOS ? row.entity_key
            : targetTable === TABLE_ASSETS ? row.asset_id : null;
          if (!targetKey) continue;
          // R6-STEP1：父/目标键歧义 → 不得挑一个赢家去关联，阻断该子行
          if (isAmbiguous(targetTable, targetKey)) { parentFailure = { fieldName, targetTable, targetKey, ambiguous: true }; break; }
          const targetId = bindings[targetTable]?.[targetKey];
          if (targetId) { row[fieldName] = [targetId]; continue; }
          parentFailure = { fieldName, targetTable, targetKey, ambiguous: false };
          break;
        }
      }
      if (parentFailure) {
        if (parentFailure.ambiguous) {
          blockAmbiguous(table, key, 'dependent_row_of_ambiguous_parent', {
            parent_table: parentFailure.targetTable, parent_key: parentFailure.targetKey, field: parentFailure.fieldName,
          });
          continue;
        }
        const parentFailed = failedRowIds.has(`${parentFailure.targetTable}|${parentFailure.targetKey}`);
        receipt.errors.push({
          table, key, op: 'skip',
          error_code: parentFailed ? 'parent_row_not_written' : 'link_target_not_bound',
          parent_table: parentFailure.targetTable, parent_key: parentFailure.targetKey,
          note: '父行失败或关联目标未绑定 → 不写该子行（避免无关联的“孤儿成功”）。',
        });
        failedRowIds.add(`${table}|${key}`);
        bump(table, 'skipped');
        continue;
      }
      const prev = byKey.get(key);
      let next;
      if (!prev) next = { ...row };
      else {
        next = { ...prev, ...row };
        for (const h of humanFields) if (prev[h] !== undefined) next[h] = prev[h];
        // R7-STEP3：未显式给出发布选项时，保留目标行已有的绝对链接与发布状态（不静默撤销）。
        if (!mediaSpecified) {
          for (const f of MEDIA_PUBLICATION_FIELDS[table] ?? []) {
            if (prev[f] !== undefined) {
              if (!logicalEqual(prev[f], next[f])) mediaPreserved.push({ table, key, field: f, kept: prev[f] });
              next[f] = prev[f];
            }
          }
        }
      }
      const res = await writeRow(table, key, next, prev);
      if (res.status === 'error' || res.status === 'unresolved') { bump(table, res.status); failedRowIds.add(`${table}|${key}`); continue; }
      bump(table, res.status);
      bindings[table][key] = res.row_id;
      expectedFinal[table].set(key, next);   // R5-STEP2：期望最终行来自实际写入策略
      if (res.row_id == null) failedRowIds.add(`${table}|${key}`);
      if (!prev) byKey.set(key, { ...next, id: res.row_id });
    }
  }

  receipt.bindings.count = Object.values(bindings).reduce((a, m) => a + Object.keys(m).length, 0);
  if (bindingsPath) {
    fs.mkdirSync(path.dirname(bindingsPath), { recursive: true });
    fs.writeFileSync(bindingsPath, JSON.stringify({ at: new Date().toISOString(), backend_kind: backend.kind, bindings }, null, 2));
  }

  // 4) R5-STEP2：**写后**分页读回对账 —— 按源主键 / **期望最终字段**（含人工字段与 stale）/ 关联目标核对。
  //    期望值取自 `expectedFinal`（写入策略的真实产物），因此不再整族豁免 humanFields。
  //    同时在**收进 Map 之前**检测目标重复主键（含仅最终读回才出现的重复），不静默挑赢家。
  const post = {};
  for (const t of ALL_TABLES) {
    const pk = TABLE_PRIMARY_KEY[t];
    const rows = await backend.listAllRows(t);
    detectDuplicateTargetKeys({ table: t, rows, source: 'post_write_readback', receipt });
    const byKey = new Map(rows.map((r) => [String(r[pk]), r]));
    const missing = [], field_mismatches = [], relation_mismatches = [], verified = [];
    for (const planned of payload[t]) {
      const key = String(planned[pk]);
      if (failedRowIds.has(`${t}|${key}`)) continue;   // 已知失败/跳过：由 errors 记录，不算成功也不算“莫名缺失”
      const found = byKey.get(key);
      if (!found) { missing.push(key); continue; }
      verified.push(key);
      const expected = expectedFinal[t].get(key) ?? planned;
      const cmp = compareIntent({ intent: expected, row: found });
      if (!cmp.ok) field_mismatches.push({ key, mismatches: cmp.mismatches.slice(0, 8) });
      for (const [fieldName, targetTable] of Object.entries(LINK_FIELDS[t] ?? {})) {
        const targetKey = targetTable === TABLE_VIDEOS ? planned.entity_key
          : targetTable === TABLE_ASSETS ? planned.asset_id : null;
        const expectedId = targetKey ? bindings[targetTable]?.[targetKey] : null;
        if (!expectedId) continue;
        const actual = (found[fieldName] ?? []).map(String);
        if (!actual.includes(String(expectedId))) relation_mismatches.push({ key, field: fieldName, expected_id: expectedId, actual });
      }
    }
    post[t] = { planned: payload[t].length, verified: verified.length, missing, field_mismatches, relation_mismatches, read_back_rows: rows.length };
  }
  receipt.post_write_reconciliation = post;
  receipt.ok = receipt.errors.length === 0
    && receipt.target_duplicates.length === 0
    && ALL_TABLES.every((t) => {
      const p = post[t];
      return p.missing.length === 0 && p.field_mismatches.length === 0 && p.relation_mismatches.length === 0
        && (payload[t].length === 0 || p.verified > 0);
    });
  receipt.finished_at = new Date().toISOString();
  return receipt;
}

// 中断写入复核：读回目标状态，报告计划行中存在/缺失，供重放前去重。支持 async 后端。
export async function reconcileInterrupted({ plannedKeys, table = TABLE_VIDEOS, backend }) {
  const pk = TABLE_PRIMARY_KEY[table];
  const rows = backend ? await backend.listAllRows(table) : [];
  const existing = new Set(rows.map((r) => r[pk]));
  const present = [], missing = [];
  for (const k of plannedKeys) (existing.has(k) ? present : missing).push(k);
  return {
    table, present_count: present.length, missing_count: missing.length, present, missing,
    safe_to_replay: missing.length > 0 ? 'replay_missing_only' : 'idempotent_replay_noop',
  };
}
