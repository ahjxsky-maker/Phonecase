// tools/material-library/tests/baserow-double.mjs
// R8：**只替代不可用的 Baserow 传输**的最小回环替身（严格按 2.4.0 形状），状态落在 JSON 文件里，
// 使**多个 CLI 调用**共享同一个目标存储（这正是不满足“同一持久目标”时的真实缺口）。
//
// 边界（必须如实标注）：
//   · 只在 127.0.0.1 监听；**不是 Baserow**、不提供 UI、不实现权限/版本语义；
//   · 行以 **API 形状**存放（single_select={id,value}、link_row=[{id}]），未知字段名 → 400（与真实 Baserow 同向）；
//   · 结构路由（表/字段/视图/过滤/排序）只为让交付代码的 ensureSchemaAndViews 走**真实**代码路径；
//   · 任何回执都必须标 baserow_verified=false 且说明“传输被替代”。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { planSchema } from '../baserow.mjs';

const DEFAULT_TYPES = Object.fromEntries(planSchema().tables.map((t) => [t.name, Object.fromEntries(t.fields.map((f) => [f.name, f.type]))]));

const EMPTY = { v: 1, database_id: 1, seq: { table: 0, field: 0, view: 0, row: 0 }, tables: [], fields: [], views: [], filters: {}, sorts: {}, rows: {} };

function loadStore(storePath) {
  if (!fs.existsSync(storePath)) return structuredClone(EMPTY);
  const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  return { ...structuredClone(EMPTY), ...parsed };
}

export function startBaserowDouble({ storePath, databaseId = 1, host = '127.0.0.1', port = 0, schemaTypes = DEFAULT_TYPES, logRequests = false } = {}) {
  if (host !== '127.0.0.1') throw new Error(`baserow_double_is_loopback_only:${host}`);
  const requestLog = [];
  const state = loadStore(storePath);
  state.database_id = Number(databaseId);
  const save = () => fs.writeFileSync(storePath, JSON.stringify(state, null, 1), 'utf8');
  const idOfTable = (tableId) => state.tables.find((t) => Number(t.id) === Number(tableId)) ?? null;
  const nameOfTable = (tableId) => idOfTable(tableId)?.name ?? null;
  const typeMap = (tableName) => (schemaTypes?.[tableName] ?? DEFAULT_TYPES[tableName] ?? {});
  const fieldsOf = (tableId) => state.fields.filter((f) => Number(f.table_id) === Number(tableId));

  const toApiShape = (tableName, payload) => {
    const types = typeMap(tableName);
    const out = {};
    for (const [k, v] of Object.entries(payload ?? {})) {
      const t = types[k];
      if (t === undefined) { const e = new Error(`unknown_field:${tableName}.${k}`); e.status = 400; throw e; }
      if (t === 'single_select') {
        const table = state.tables.find((x) => x.name === tableName);
        const f = table ? fieldsOf(table.id).find((x) => x.name === k) : null;
        if (v === null || v === undefined) { out[k] = { id: null, value: null }; continue; }
        let opt = (f?.select_options ?? []).find((o) => String(o.id) === String(v) || o.value === v);
        if (!opt && f) {
          // 与真实 Baserow 同向：写入一个尚不存在的选项值 → 该选项被创建
          const opts = f.select_options ?? [];
          const nextId = opts.reduce((m, o) => Math.max(m, Number(o.id) || 0), 8999) + 1;
          opt = { id: nextId, value: String(v), color: 'light-blue' };
          f.select_options = [...opts, opt];
          save();
        }
        out[k] = { id: opt ? Number(opt.id) : null, value: opt ? opt.value : null };
      } else if (t === 'link_row') out[k] = (Array.isArray(v) ? v : []).map((x) => ({ id: Number(x && typeof x === 'object' ? x.id : x) }));
      else out[k] = v;
    }
    return out;
  };

  const server = http.createServer((req, res) => {
    if (logRequests) requestLog.push({ at: Date.now(), method: req.method, url: req.url });
    const send = (code, body) => { const text = JSON.stringify(body); res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) }); res.end(text); };
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const u = new URL(req.url, `http://${req.headers.host}`);
      const p = u.pathname;
      let payload = null;
      if (body) { try { payload = JSON.parse(body); } catch { return send(400, { error: 'ERROR_REQUEST_BODY_VALIDATION' }); } }
      const method = req.method.toUpperCase();
      try {
        if (method === 'GET' && p === '/api/settings/') return send(200, { version: '2.4.0-double' });
        let m;
        if ((m = p.match(/^\/api\/database\/tables\/database\/(\d+)\/$/))) {
          if (method === 'GET') return send(200, state.tables.filter((t) => Number(t.database_id) === Number(m[1])));
          if (method === 'POST') {
            const id = ++state.seq.table;
            const table = { id, name: payload.name, database_id: Number(m[1]) };
            state.tables.push(table);
            state.rows[id] = [];
            // 真实 Baserow 建表自带一个 primary 字段（text, primary）
            state.fields.push({ id: ++state.seq.field, table_id: id, name: 'Name', type: 'text', primary: true, select_options: null });
            save();
            return send(200, table);
          }
        }
        if ((m = p.match(/^\/api\/database\/fields\/table\/(\d+)\/$/))) {
          if (method === 'GET') return send(200, fieldsOf(m[1]));
          if (method === 'POST') {
            const tableId = Number(m[1]);
            const id = ++state.seq.field;
            const opts = (payload.select_options ?? []).map((o, i) => ({ id: 9000 + i, value: o.value ?? o, color: o.color ?? 'light-blue' }));
            const field = {
              id, table_id: tableId, name: payload.name, type: payload.type, primary: false,
              select_options: opts.length ? opts : null,
              link_row_table_id: payload.link_row_table_id ?? null,
            };
            state.fields.push(field);
            save();
            return send(200, field);
          }
        }
        if ((m = p.match(/^\/api\/database\/fields\/(\d+)\/$/))) {
          const f = state.fields.find((x) => Number(x.id) === Number(m[1]));
          if (!f) return send(404, { error: 'FIELD_DOES_NOT_EXIST' });
          if (method === 'PATCH') { if (payload?.name) f.name = payload.name; save(); return send(200, f); }
        }
        if ((m = p.match(/^\/api\/database\/views\/table\/(\d+)\/$/))) {
          if (method === 'GET') return send(200, state.views.filter((v) => Number(v.table_id) === Number(m[1])));
          if (method === 'POST') {
            const view = { id: ++state.seq.view, table_id: Number(m[1]), name: payload.name, type: payload.type ?? 'grid' };
            state.views.push(view); state.filters[view.id] = []; state.sorts[view.id] = [];
            save();
            return send(200, view);
          }
        }
        if ((m = p.match(/^\/api\/database\/views\/(\d+)\/$/))) {
          const v = state.views.find((x) => Number(x.id) === Number(m[1]));
          if (!v) return send(404, { error: 'VIEW_DOES_NOT_EXIST' });
          if (method === 'PATCH') { Object.assign(v, payload ?? {}); save(); return send(200, v); }
        }
        if ((m = p.match(/^\/api\/database\/views\/(\d+)\/filters\/$/))) {
          state.filters[m[1]] ??= [];
          if (method === 'GET') return send(200, state.filters[m[1]]);
          if (method === 'POST') { const f = { id: state.filters[m[1]].length + 1, ...payload }; state.filters[m[1]].push(f); save(); return send(200, f); }
        }
        if ((m = p.match(/^\/api\/database\/views\/(\d+)\/sortings\/$/))) {
          state.sorts[m[1]] ??= [];
          if (method === 'GET') return send(200, state.sorts[m[1]]);
          if (method === 'POST') { const s = { id: state.sorts[m[1]].length + 1, ...payload }; state.sorts[m[1]].push(s); save(); return send(200, s); }
        }
        if ((m = p.match(/^\/api\/database\/rows\/table\/(\d+)\/(?:row\/)?(\d+)?\/?$/))) {
          const tableId = Number(m[1]);
          const tableName = nameOfTable(tableId);
          if (!tableName) return send(404, { error: 'TABLE_DOES_NOT_EXIST' });
          const rows = (state.rows[tableId] ??= []);
          if (method === 'GET') {
            const page = Number(u.searchParams.get('page') ?? 1);
            const size = Number(u.searchParams.get('size') ?? 100);
            const slice = rows.slice((page - 1) * size, page * size);
            return send(200, { count: rows.length, next: page * size < rows.length ? 'x' : null, previous: null, results: slice });
          }
          if (method === 'POST') {
            const api = toApiShape(tableName, payload);
            const id = ++state.seq.row;
            const rec = { id, order: String(id), ...api };
            rows.push(rec);
            save();
            return send(200, rec);
          }
          if (method === 'PATCH') {
            const rowId = Number(m[2]);
            const idx = rows.findIndex((r) => Number(r.id) === rowId);
            if (idx < 0) return send(404, { error: 'ROW_DOES_NOT_EXIST' });
            const api = toApiShape(tableName, payload);
            rows[idx] = { ...rows[idx], ...api };
            save();
            return send(200, rows[idx]);
          }
        }
        return send(404, { error: 'NOT_FOUND', path: p, method });
      } catch (e) {
        return send(e.status ?? 500, { error: 'DOUBLE_ERROR', detail: String(e.message) });
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        port: addr.port,
        storePath,
        reads: () => JSON.parse(fs.readFileSync(storePath, 'utf8')),
        requests: requestLog,
        /** 测试用：在替身**内存状态**上注入（直接改文件不会影响已启动的替身）。 */
        mutateState: (fn) => { fn(state); save(); return state; },
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/** 供测试直接读取替身存储（CLI 之间的“同一目标”证据）。 */
export function readStore(storePath) { return JSON.parse(fs.readFileSync(storePath, 'utf8')); }
export function storeBytes(storePath) { return fs.readFileSync(storePath); }
export function resetStore(storePath) { fs.mkdirSync(path.dirname(storePath), { recursive: true }); fs.writeFileSync(storePath, JSON.stringify(EMPTY, null, 1), 'utf8'); }
