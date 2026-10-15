// tools/material-library/plan-store.mjs —— M4（MP-08／MP-09）：拍摄计划的存储与引用追溯。
//
// 口径（每条都对应判据原文，不是自创要求）：
//   * MP-08「an operator builds and saves a shooting plan, selects references per structure node, records
//     intended expression and missing shots, and can reopen it」→ 计划可建、可存、可重开；节点带职能、
//     参考片段、**人工撰写的意图/口播/拟拍**，以及**缺口**。
//   * MP-08「Newly authored creative suggestions are separate from source facts」→ 创作字段只落在 plan_nodes；
//     引用只存身份，时间点与留存文本读取时从 `segments` **现取**，来源事实全局只有一份。
//   * MP-08「missing footage is never represented as an existing asset」→ 缺口节点**不得带引用**，且读取时
//     一律进 `gaps` 而不是 `references`。
//   * MP-09「A plan exposes the materials referenced by each node, and a material exposes which plans
//     reference it. Editing one plan does not silently alter another.」→ 双向可查；引用按
//     (plan_id, position, ref_index) 独立成行，改一份计划不触碰别份。
//
// 边界：本模块只做纯函数式读写，不含网络/凭据/外部调用；写路径由调用方（面板服务／验收脚本）决定。
import { sourceOf } from './segment-library.mjs';

/** 计划节点的职能词表＝已批准的顾小北五段 + 诚实的第六类（与 M2／M3 同一口径）。 */
export const PLAN_ROLES = ['HOOK', 'pain', 'scene', 'proof', 'CTA', 'insufficient_evidence'];

/** 结构校验规则的机器可读说明（写进接口回执，让调用方/复核方不必读代码就知道凭什么拒绝）。 */
export const PLAN_RULES = [
  'product_or_need 必填且非空：计划必须对应一个明确的产品或需求。',
  'nodes 至少 1 个；position 由数组顺序确定（1..N），不接受调用方自报的乱序 position。',
  'role 必须属于已批准的顾小北五段 + insufficient_evidence。',
  '每条引用必须能在 segments 里查到（entity_key + segment_id）；查不到就整笔拒绝 unknown_reference，绝不静默落库。',
  'missing_shot=1 的节点**不得带任何引用**（missing_shot_with_reference）：缺口不能被写成"已有素材"。',
  'missing_shot=1 必须写明 missing_reason（missing_reason_required）：缺口要说清缺什么，不能只留空。',
  'missing_shot=0 的节点必须至少 1 条引用（node_without_reference_or_gap）：要么给真实参考，要么如实标缺口。',
  '同一节点内不允许重复引用同一片段（duplicate_reference）。',
  '并发保存用 expected_rev 乐观校验；不一致整笔拒绝 stale_plan，不做静默覆盖。',
];

const nowIso = () => new Date().toISOString();
const s = (v) => (v === null || v === undefined ? null : String(v));
const trimmed = (v) => { const t = s(v); return t === null ? null : t.trim(); };

// ── 逐字段前置条件（第十五轮受影响复审定下的结构性修法）────────────────────────────────
// 起因：复审构造"库里有文本、回包给 null"的情形，客户端按回包保存就会把原文清空。
// 只比较"回包里的值"的客户端机制无法分辨这种情形——**判据必须是库，不是回包**。
// 因此：客户端提交它"以为自己读到的"每个节点内容（expected_nodes），服务端在**任何写入之前**
// 与**库内当前值**逐字段比对；不一致即整笔拒绝 stale_plan。这同时覆盖并发改动与"回包与库不一致"。
function canonNode(n, position) {
  const missing = n?.missing_shot === true || n?.missing_shot === 1 || n?.missing_shot === '1' ? 1 : 0;
  const refs = (Array.isArray(n?.references) ? n.references : [])
    .map((r) => `${trimmed(r?.entity_key) ?? ''}|${trimmed(r?.segment_id) ?? ''}`).sort();
  return {
    position,
    role: trimmed(n?.role) ?? '',
    intended_expression: trimmed(n?.intended_expression) ?? '',
    spoken_copy_note: trimmed(n?.spoken_copy_note) ?? '',
    proposed_shot: trimmed(n?.proposed_shot) ?? '',
    missing_shot: missing,
    missing_reason: trimmed(n?.missing_reason) ?? '',
    references: refs,
  };
}
const canonNodes = (arr) => (Array.isArray(arr) ? arr : []).map((n, i) => canonNode(n, i + 1));
function currentNodesCanonical(db, planId) {
  const ns = db.prepare('SELECT * FROM plan_nodes WHERE plan_id = ? ORDER BY position').all(planId);
  const rs = db.prepare('SELECT * FROM plan_references WHERE plan_id = ? ORDER BY position, ref_index').all(planId);
  const byPos = new Map();
  for (const r of rs) { if (!byPos.has(r.position)) byPos.set(r.position, []); byPos.get(r.position).push({ entity_key: r.entity_key, segment_id: r.segment_id }); }
  return ns.map((n, i) => canonNode({ ...n, references: byPos.get(n.position) ?? [] }, i + 1));
}

function nextPlanId(db) {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const n = db.prepare("SELECT COUNT(*) AS n FROM plans WHERE plan_id LIKE ?").get(`plan-${stamp}-%`).n + 1;
  return `plan-${stamp}-${String(n).padStart(3, '0')}`;
}

/**
 * 建/改一份计划（整份替换式 upsert，单事务）。
 * 返回 { ok:true, plan_id, rev, created } 或 { ok:false, error, detail?, errors? }。
 * 失败时**不产生任何写入**（校验全部在任何写之前完成）。
 */
export function savePlan(db, payload = {}) {
  const productOrNeed = trimmed(payload.product_or_need);
  const purpose = trimmed(payload.communication_purpose);
  const operator = trimmed(payload.operator) ?? 'panel';
  const humanNote = trimmed(payload.human_note);
  const status = trimmed(payload.status) ?? 'draft';
  const rawNodes = Array.isArray(payload.nodes) ? payload.nodes : null;

  // 第二十二轮受影响复审：这三条"说出来的内容是否为空"的结构性必填检查，原先排在类型严格与
  // "必须显式提交"之前 → 更新时**省略** product_or_need 报的是 product_or_need_required、传 `[]`
  // 也报不出类型错误，调用方无法按约定错误码区分"漏字段 / 类型错 / 真的是空值"。
  // 数据安全未受影响（三种都仍是拒绝、零写入），但错误码契约要对齐，故下移到两道门之后（见本函数后段）。

  // 第十七轮受影响复审：**前置条件必须是强制的**——先前写成"给了才核"，于是调用方只要**省略** `expected_plan`
  // 就能绕过计划级核对（把没读到的备注写成清空）。这里放在**结构校验之前**，保证报的是更具体的这个原因。
  const earlyId = trimmed(payload.plan_id);
  if (earlyId && db.prepare('SELECT 1 AS x FROM plans WHERE plan_id = ?').get(earlyId)) {
    if (!Array.isArray(payload.expected_nodes) || !(payload.expected_plan && typeof payload.expected_plan === 'object')) {
      return {
        ok: false, error: 'plan_precondition_required',
        detail: '更新已有计划必须同时提交 expected_plan 与 expected_nodes（即"你读到的内容"）：没有它们，服务端无法区分"用户清空"与"没读到"，会静默覆盖库内内容。',
        conflicts: [],
      };
    }
    // 第十八轮受影响复审：**漏传字段**也必须拒绝。先前 `trimmed(undefined)` → null → UPDATE 写成 NULL，
    // 于是"只改创作文本"的一次更新会把没提到的运营备注**静默清空**。更新是整份替换，必须把要写的内容说全。
    const PLAN_REQ = ['product_or_need', 'communication_purpose', 'human_note', 'status'];
    const NODE_REQ = ['role', 'intended_expression', 'spoken_copy_note', 'proposed_shot', 'missing_shot', 'missing_reason', 'references'];
    const absent = PLAN_REQ.filter((f) => payload[f] === undefined);
    const badNodes = [];
    (Array.isArray(payload.nodes) ? payload.nodes : []).forEach((n, i) => {
      const miss = NODE_REQ.filter((f) => n?.[f] === undefined);
      if (miss.length) badNodes.push({ position: i + 1, missing: miss });
    });
    // 第十九轮的类型严格校验已提升为"对所有写入生效"（见本函数开头的 badTypeAll 段）。
    // 第二十轮清理：此处曾有一份等价实现，属重复代码，已删除，避免两处规则将来各自漂移。
    if (absent.length || badNodes.length) {
      return {
        ok: false, error: 'plan_fields_required',
        detail: '更新是整份替换：计划级字段与每个节点的字段都必须**显式提交**（可以为空串/null，但不能省略）。省略会被当成"没读到"，从而把库里已有内容静默清空。',
        absent_plan_fields: absent, absent_node_fields: badNodes, conflicts: [],
      };
    }
  }

  // 第二十轮受影响复审：类型严格必须对**所有写入**生效（新建也一样）——先前把它放在"仅更新已有计划"的分支里，
  // 于是**新建**计划的 `references: null` 仍会被转成空数组，把"参考状态未知"保存成"没有参考"。
  const PLAN_STR_T = ['product_or_need', 'communication_purpose', 'human_note', 'status'];
  const NODE_STR_T = ['role', 'intended_expression', 'spoken_copy_note', 'proposed_shot', 'missing_reason'];
  const badTypeAll = [];
  for (const f of PLAN_STR_T) { const v = payload[f]; if (v !== undefined && !(v === null || typeof v === 'string')) badTypeAll.push({ field: f, got: Array.isArray(v) ? 'array' : typeof v }); }
  (Array.isArray(payload.nodes) ? payload.nodes : []).forEach((n, i) => {
    for (const f of NODE_STR_T) { const v = n?.[f]; if (v !== undefined && !(v === null || typeof v === 'string')) badTypeAll.push({ position: i + 1, field: f, got: Array.isArray(v) ? 'array' : typeof v }); }
    const ms = n?.missing_shot;
    if (ms !== undefined && !(ms === true || ms === false || ms === 0 || ms === 1)) badTypeAll.push({ position: i + 1, field: 'missing_shot', got: Array.isArray(ms) ? 'array' : typeof ms });
    if (n?.references !== undefined && !Array.isArray(n?.references)) badTypeAll.push({ position: i + 1, field: 'references', got: Array.isArray(n?.references) ? 'array' : typeof n?.references });
    else if (Array.isArray(n?.references)) n.references.forEach((r, ri) => {
      for (const f of ['entity_key', 'segment_id']) { const v = r?.[f]; if (typeof v !== 'string') badTypeAll.push({ position: i + 1, reference: ri + 1, field: f, got: Array.isArray(v) ? 'array' : typeof v }); }
    });
  });
  if (badTypeAll.length) {
    return {
      ok: false, error: 'plan_field_type_invalid',
      detail: '字段类型不合法：字符串字段只接受字符串或 null。服务端不做隐式字符串化——否则异常输入会被当成"用户清空/没有参考"，把库内内容静默改写。',
      invalid_fields: badTypeAll, conflicts: [],
    };
  }

  // 第二十一轮受影响复审：**新建**计划省略 `references` 也会被当成"没有参考"——而"没有参考"与"没读到参考"
  // 在业务上是两件事（前者是正常空数组，后者是未知）。因此 `references` 在**所有写入**里都必须显式提交。
  const missingRefs = (Array.isArray(payload.nodes) ? payload.nodes : [])
    .map((n, i) => (n && n.references === undefined ? i + 1 : null)).filter((x) => x !== null);
  if (missingRefs.length) {
    return {
      ok: false, error: 'plan_fields_required',
      detail: '每个节点必须显式提交 references（数组，可以是空数组）：省略会被当成"没有参考"，把未知状态写进库。',
      absent_node_fields: missingRefs.map((position) => ({ position, missing: ['references'] })), conflicts: [],
    };
  }

  // 第二十二轮受影响复审：结构性必填（内容为空 / 状态非法）放在最后判，保证"漏字段""类型错"
  // 各有自己的错误码，而不是被一句 product_or_need_required 盖住。判定顺序：说全了 → 说对了 → 内容非空。
  if (!productOrNeed) return { ok: false, error: 'product_or_need_required' };
  if (!rawNodes || rawNodes.length === 0) return { ok: false, error: 'nodes_required' };
  if (!['draft', 'ready', 'archived'].includes(status)) return { ok: false, error: 'invalid_status', detail: status };

  // ── 校验阶段：不写任何东西 ──
  const nodes = [];
  const errors = [];
  const segExists = db.prepare('SELECT 1 AS x FROM segments WHERE entity_key = ? AND segment_id = ?');
  for (let i = 0; i < rawNodes.length; i += 1) {
    const n = rawNodes[i] ?? {};
    const position = i + 1;
    const role = trimmed(n.role);
    if (!role || !PLAN_ROLES.includes(role)) { errors.push({ position, error: 'invalid_role', detail: s(n.role) }); continue; }
    const missing = n.missing_shot === true || n.missing_shot === 1 || n.missing_shot === '1' ? 1 : 0;
    const missingReason = trimmed(n.missing_reason);
    const rawRefs = Array.isArray(n.references) ? n.references : [];
    const refs = [];
    const seen = new Set();
    for (const r of rawRefs) {
      const entityKey = trimmed(r?.entity_key);
      const segmentId = trimmed(r?.segment_id);
      if (!entityKey || !segmentId) { errors.push({ position, error: 'invalid_reference_shape', detail: `${s(entityKey)}|${s(segmentId)}` }); continue; }
      const pair = `${entityKey}\u0000${segmentId}`;
      if (seen.has(pair)) { errors.push({ position, error: 'duplicate_reference', detail: pair.replace('\u0000', ' | ') }); continue; }
      seen.add(pair);
      if (!segExists.get(entityKey, segmentId)) { errors.push({ position, error: 'unknown_reference', detail: `${entityKey} | ${segmentId}` }); continue; }
      refs.push({ entity_key: entityKey, segment_id: segmentId, ref_index: refs.length + 1 });
    }
    if (missing && refs.length) errors.push({ position, error: 'missing_shot_with_reference', detail: `该节点标了缺口，却带了 ${refs.length} 条引用` });
    if (missing && !missingReason) errors.push({ position, error: 'missing_reason_required', detail: '标了缺口但没写缺什么' });
    if (!missing && refs.length === 0) errors.push({ position, error: 'node_without_reference_or_gap', detail: '既没有真实参考片段，也没有标缺口' });
    nodes.push({
      position, role, missing_shot: missing, missing_reason: missingReason,
      intended_expression: trimmed(n.intended_expression), spoken_copy_note: trimmed(n.spoken_copy_note),
      proposed_shot: trimmed(n.proposed_shot), references: refs,
    });
  }
  if (errors.length) return { ok: false, error: 'plan_validation_failed', errors };

  // ── 写入阶段：单事务，全成或全不成 ──
  const requestedId = trimmed(payload.plan_id);
  let planId = requestedId;
  let created = false;
  const tx = db.prepare('SELECT plan_id, rev FROM plans WHERE plan_id = ?');
  if (planId) {
    const existing = tx.get(planId);
    if (existing) {
      if (payload.expected_rev !== undefined && payload.expected_rev !== null && Number(payload.expected_rev) !== existing.rev) {
        return { ok: false, error: 'stale_plan', detail: `本页读到 rev=${existing.rev}，请求基于 rev=${Number(payload.expected_rev)}` };
      }
    } else created = true;
  } else {
    planId = nextPlanId(db);
    created = true;
  }

  // ── 逐字段前置条件：只对**已存在**的计划做，且必须在任何写入之前 ──
  // 第十六轮受影响复审补正：先前只比对了**节点**，于是**计划级字段**（产品/需求、传播目的、人工备注、状态）
  // 仍可被"回包与库不一致"绕过——库里有备注、回包给 null，保存就把备注清掉。这里把计划级字段一并纳入。
  // 第十七轮受影响复审：强制前置条件已在函数开头统一检查（早于结构校验），此处不再重复。
  if (planId && tx.get(planId) && (Array.isArray(payload.expected_nodes) || (payload.expected_plan && typeof payload.expected_plan === 'object'))) {
    const conflicts = [];
    const curPlan = db.prepare('SELECT product_or_need, communication_purpose, human_note, status FROM plans WHERE plan_id = ?').get(planId) ?? {};
    const c1 = (v) => (v === null || v === undefined ? '' : String(v).trim());
    if (payload.expected_plan && typeof payload.expected_plan === 'object') {
      for (const f of ['product_or_need', 'communication_purpose', 'human_note', 'status']) {
        if (c1(curPlan[f]) !== c1(payload.expected_plan[f])) conflicts.push({ field: f, in_store: curPlan[f] ?? null, as_read: payload.expected_plan[f] ?? null });
      }
    }
    if (Array.isArray(payload.expected_nodes)) {
      const current = currentNodesCanonical(db, planId);
      const expected = canonNodes(payload.expected_nodes);
      const n = Math.max(current.length, expected.length);
      for (let i = 0; i < n; i += 1) {
        const a = current[i]; const b = expected[i];
        if (JSON.stringify(a) !== JSON.stringify(b)) conflicts.push({ position: i + 1, in_store: a ?? null, as_read: b ?? null });
      }
    }
    if (conflicts.length) {
      return {
        ok: false, error: 'stale_plan',
        detail: '库里的计划内容与你读到的不一致（可能是别处改过，也可能这份内容没有完整读到）：本次未写入任何内容。',
        conflicts,
      };
    }
  }

  // node:sqlite 的 DatabaseSync **没有** better-sqlite3 的 .transaction()，显式用 BEGIN/COMMIT/ROLLBACK。
  // 整份替换必须全成或全不成：任一步抛错就回滚，绝不留下半个计划。
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = tx.get(planId);
    const at = nowIso();
    if (existing) {
      db.prepare('UPDATE plans SET product_or_need=?, communication_purpose=?, status=?, operator=?, human_note=?, updated_at=?, rev=rev+1 WHERE plan_id=?')
        .run(productOrNeed, purpose, status, operator, humanNote, at, planId);
    } else {
      db.prepare('INSERT INTO plans (plan_id, product_or_need, communication_purpose, status, operator, human_note, created_at, updated_at, rev) VALUES (?,?,?,?,?,?,?,?,1)')
        .run(planId, productOrNeed, purpose, status, operator, humanNote, at, at);
    }
    // 整份替换：先把本计划的节点/引用删掉再写回（只影响本 plan_id）
    db.prepare('DELETE FROM plan_references WHERE plan_id = ?').run(planId);
    db.prepare('DELETE FROM plan_nodes WHERE plan_id = ?').run(planId);
    const insNode = db.prepare(`INSERT INTO plan_nodes (plan_id, position, role, intended_expression, spoken_copy_note, proposed_shot, missing_shot, missing_reason)
      VALUES (?,?,?,?,?,?,?,?)`);
    const insRef = db.prepare('INSERT INTO plan_references (plan_id, position, ref_index, entity_key, segment_id) VALUES (?,?,?,?,?)');
    for (const n of nodes) {
      insNode.run(planId, n.position, n.role, n.intended_expression, n.spoken_copy_note, n.proposed_shot, n.missing_shot, n.missing_reason);
      for (const r of n.references) insRef.run(planId, n.position, r.ref_index, r.entity_key, r.segment_id);
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 回滚失败不再掩盖原始错误 */ }
    throw e;
  }
  const rev = tx.get(planId).rev;
  return { ok: true, plan_id: planId, rev, created, nodes: nodes.length, references: nodes.reduce((a, n) => a + n.references.length, 0) };
}

/** 列表：每条计划带节点数、引用数、缺口数（缺口与引用分开计数，不混为一谈）。 */
export function listPlans(db) {
  const plans = db.prepare(`SELECT p.*,
      (SELECT COUNT(*) FROM plan_nodes n WHERE n.plan_id = p.plan_id) AS node_count,
      (SELECT COUNT(*) FROM plan_nodes n WHERE n.plan_id = p.plan_id AND n.missing_shot = 1) AS missing_shot_count,
      (SELECT COUNT(*) FROM plan_references r WHERE r.plan_id = p.plan_id) AS reference_count,
      (SELECT COUNT(DISTINCT r.entity_key) FROM plan_references r WHERE r.plan_id = p.plan_id) AS material_count
    FROM plans p ORDER BY p.updated_at DESC, p.plan_id`).all();
  return { count: plans.length, unit: 'plans', plans };
}

/**
 * 读一份计划：节点 + **现取**的来源身份/时间点/留存文本 + 缺口清单。
 * 引用里的来源事实不落库快照，一律经 sourceOf() 从 segments/materials/assets 现读——
 * 这样"来源事实只有一份"，也让 file_missing 等不可用状态能如实反映。
 */
export function readPlan(db, planId, { mediaBase } = {}) {
  const plan = db.prepare('SELECT * FROM plans WHERE plan_id = ?').get(planId);
  if (!plan) return null;
  const nodeRows = db.prepare('SELECT * FROM plan_nodes WHERE plan_id = ? ORDER BY position').all(planId);
  const refRows = db.prepare('SELECT * FROM plan_references WHERE plan_id = ? ORDER BY position, ref_index').all(planId);
  const byPos = new Map();
  for (const r of refRows) {
    if (!byPos.has(r.position)) byPos.set(r.position, []);
    byPos.get(r.position).push(r);
  }
  const segRow = db.prepare('SELECT start_seconds, end_seconds, t_label, observed, onscreen_text, speech FROM segments WHERE entity_key = ? AND segment_id = ?');
  const gaps = [];
  const nodes = nodeRows.map((n) => {
    const refs = (byPos.get(n.position) ?? []).map((r) => {
      const src = sourceOf(db, r.entity_key, r.segment_id, mediaBase);
      const seg = segRow.get(r.entity_key, r.segment_id) ?? {};
      return {
        ref_index: r.ref_index,
        entity_key: r.entity_key,
        segment_id: r.segment_id,
        start_seconds: seg.start_seconds ?? null,
        end_seconds: seg.end_seconds ?? null,
        time_label: seg.t_label ?? (src.time_range?.start_seconds != null ? `${src.time_range.start_seconds}s` : null),
        source_identity: src.identity,
        // MP-07 的「留存文本」与 MP-08 的「来源时间点」都**从 segments 现取**，计划里不存快照。
        retained_text: { observed: seg.observed ?? null, onscreen_text: seg.onscreen_text ?? null, speech: seg.speech ?? null },
        availability: src.availability,
        playable: src.playable,
        // ★ 2026-10-15：与素材/结构中心的候选**同一口径**——引用也要能说明"为什么可播"（本机文件 / 云中转）。
        delivery: src.delivery,
        media_url: src.media_url,
        seek_url: src.seek_url,
        external_link_policy: src.external_link_policy,
      };
    });
    if (n.missing_shot) gaps.push({ position: n.position, role: n.role, reason: n.missing_reason ?? null });
    return {
      position: n.position,
      role: n.role,
      intended_expression: n.intended_expression,
      spoken_copy_note: n.spoken_copy_note,
      proposed_shot: n.proposed_shot,
      missing_shot: n.missing_shot,
      missing_reason: n.missing_reason,
      references: refs,
    };
  });
  return {
    plan_id: plan.plan_id,
    product_or_need: plan.product_or_need,
    communication_purpose: plan.communication_purpose,
    status: plan.status,
    operator: plan.operator,
    human_note: plan.human_note,
    created_at: plan.created_at,
    updated_at: plan.updated_at,
    rev: plan.rev,
    unit: 'nodes',
    node_count: nodes.length,
    reference_count: nodes.reduce((a, n) => a + n.references.length, 0),
    missing_shot_count: gaps.length,
    nodes,
    gaps,
    separation: '创作建议（intended_expression / spoken_copy_note / proposed_shot）由人工新写，只在计划里；来源身份、时间点与留存文本读取时从素材库现取，计划不存快照，因此来源事实只有一份。',
    missing_policy: 'missing_shot=1 的节点是**缺口**：它没有引用、并且必须写明缺什么。缺口不会被显示成已有素材。',
    rules: PLAN_RULES,
  };
}

/** MP-09 反向追溯：某个素材（乃至某个片段）被哪些计划、哪些节点引用。 */
export function plansByMaterial(db, entityKey, { segmentId = null } = {}) {
  const rows = db.prepare(`SELECT r.plan_id, r.position, r.ref_index, r.entity_key, r.segment_id,
      p.product_or_need, p.communication_purpose, p.status, p.updated_at,
      n.role, n.missing_shot
    FROM plan_references r
    JOIN plans p ON p.plan_id = r.plan_id
    LEFT JOIN plan_nodes n ON n.plan_id = r.plan_id AND n.position = r.position
    WHERE r.entity_key = ? ${segmentId ? 'AND r.segment_id = ?' : ''}
    ORDER BY p.updated_at DESC, r.plan_id, r.position, r.ref_index`).all(...(segmentId ? [entityKey, segmentId] : [entityKey]));
  const byPlan = new Map();
  for (const r of rows) {
    if (!byPlan.has(r.plan_id)) {
      byPlan.set(r.plan_id, {
        plan_id: r.plan_id, product_or_need: r.product_or_need, communication_purpose: r.communication_purpose,
        status: r.status, updated_at: r.updated_at, reference_count: 0, nodes: [],
      });
    }
    const p = byPlan.get(r.plan_id);
    p.reference_count += 1;
    p.nodes.push({ position: r.position, role: r.role, segment_id: r.segment_id, ref_index: r.ref_index });
  }
  const plans = [...byPlan.values()];
  return {
    entity_key: entityKey,
    segment_id: segmentId,
    unit: 'plans',
    count: plans.length,
    reference_count: rows.length,
    plans,
    note: '这是**复用追溯**：同一片段可以被多份计划的多个节点引用，引用是"指向"而不是"复制"，所以改一份计划不会改到别份。',
  };
}

/** 计划相关的规模事实（进 /api/summary，供顶部与缺口页显示；不臆造数字）。 */
export function planStats(db) {
  const plans = db.prepare('SELECT COUNT(*) AS n FROM plans').get().n;
  const nodes = db.prepare('SELECT COUNT(*) AS n FROM plan_nodes').get().n;
  const refs = db.prepare('SELECT COUNT(*) AS n FROM plan_references').get().n;
  const gaps = db.prepare('SELECT COUNT(*) AS n FROM plan_nodes WHERE missing_shot = 1').get().n;
  const plansWithSharedSegment = db.prepare(`SELECT COUNT(*) AS n FROM (
      SELECT entity_key, segment_id FROM plan_references GROUP BY entity_key, segment_id
      HAVING COUNT(DISTINCT plan_id) >= 2)`).get().n;
  return { plans, nodes, references: refs, missing_shots: gaps, segments_shared_by_multiple_plans: plansWithSharedSegment };
}
