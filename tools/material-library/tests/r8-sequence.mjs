// tools/material-library/tests/r8-sequence.mjs
// R8-STEP4：在**一个持久隔离目标**上，用**真实 CLI 参数处理 + 真实 HTTP 编解码**跑完整顺序：
//   代表输入 → 显式首次导入 → 只读查询 → 显式选中身份编辑 → 普通来源复导入 → 第二次查询 →
//   只读导出 → 从磁盘 bundle 恢复/读回。
// 只替代**不可用的 Baserow 传输**（回环 Baserow 形状替身，ML_TRANSPORT=baserow-double）；
// 每次 CLI 调用都读同一个 store 文件，因此“多次调用看到同一目标”是被证明的，而不是断言出来的。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { startBaserowDouble } from './baserow-double.mjs';

/**
 * 跑一次真实 CLI。**必须用异步 spawn**：替身服务器与调用方在**同一个进程**里，
 * 若用 spawnSync 会阻塞事件循环 → 替身无法应答 → 子进程请求超时（这是实测过的真实坑）。
 */
export function runCli({ cliPath, root, args, env = {}, timeoutMs = 180000 }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ args, code: null, stdout: out.trim(), stderr: err.trim(), error: String(e.message) }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ args, code, stdout: out.trim().split('\n').slice(-8).join('\n'), stderr: err.trim().split('\n').slice(-8).join('\n'), error: null });
    });
  });
}

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

/**
 * @returns {{ok:boolean, steps:Array, receipts:object, store_path:string, target_url:string, assertions:object}}
 */
export async function runDeliveredSequence({
  root, cliPath, storePath, outRoot, manifestPath,
  entityKey, classification, evidenceRef, reviewer = 'r9-cli-operator', note = 'R9 顺序：目标侧显式人工编辑（带原因）',
  classificationState = 'proposed', reviewStatus = null,
  restoreInto = null, keepDoubleOpen = false,
}) {
  if (!entityKey) throw new Error('sequence_requires_entity_key');
  fs.mkdirSync(outRoot, { recursive: true });
  const bundlePath = path.join(outRoot, 'r8-bundle.json');
  const double = await startBaserowDouble({ storePath });
  const base = ['--target', 'http', '--base-url', double.url, '--database-id', '1', '--token', 'r9-token', '--mgmt-token', 'r9-jwt'];
  const env = { ML_TRANSPORT: 'baserow-double' };
  const steps = [];
  const step = async (name, args) => { const r = await runCli({ cliPath, root, args: [...args, '--out', outRoot], env }); steps.push({ name, ...r }); return r; };
  const storeHash = () => (fs.existsSync(storePath) ? crypto.createHash('sha256').update(fs.readFileSync(storePath)).digest('hex') : null);
  // R9-STEP4：**失败即停**（失败的步骤阻断依赖它的后续步骤，不盲目继续）
  const blocked = [];
  let stopped = null;
  const must = async (name, args) => {
    if (stopped) { blocked.push({ name, blocked_by: stopped }); return { name, code: null, skipped: true }; }
    const r = await step(name, args);
    if (r.code !== 0) stopped = name;
    return r;
  };

  try {
    await must('1_import_initial', ['import', ...base, '--manifest', manifestPath]);
    const storeAfterImport = await storeHash();
    await must('2_query_readonly', ['query', ...base]);
    const storeAfterQuery1 = await storeHash();
    const editArgs = ['edit', ...base, '--entity-key', entityKey, '--note', note, '--reviewer', reviewer];
    if (classification) editArgs.push('--product-category', classification, '--classification-state', classificationState, '--classification-evidence', evidenceRef);
    if (reviewStatus) editArgs.push('--review-status', reviewStatus);
    await must('3_edit_explicit', editArgs);
    const storeAfterEdit = await storeHash();
    await must('4_reimport_ordinary', ['import', ...base, '--manifest', manifestPath]);
    const storeAfterReplay = await storeHash();
    await must('5_query_second', ['query', ...base, ...(classification ? ['--product-category', classification] : [])]);
    const storeAfterQuery2 = await storeHash();
    await must('6_export_readonly', ['export', ...base, '--entity-key', entityKey, '--bundle', bundlePath]);
    const storeAfterExport = await storeHash();
    await must('7_restore_from_disk', ['restore', '--bundle', bundlePath, ...(restoreInto ? ['--restore-into', restoreInto] : [])]);
    const storeAfterRestore = await storeHash();
    await must('8_journey_readonly', ['journey', ...base, '--entity-key', entityKey]);
    const storeAfterJourney = await storeHash();

    const receipts = {
      query: readJson(path.join(outRoot, 'query', 'query-receipt.json')),
      edit: readJson(path.join(outRoot, 'edit', 'edit-receipt.json')),
      export: readJson(path.join(outRoot, 'portable', 'export-receipt.json')),
      restore: readJson(path.join(outRoot, 'restore', 'restore-receipt.json')),
      import: readJson(path.join(outRoot, 'import', 'http-receipt.json')),
      journey: readJson(path.join(outRoot, 'journey', 'journey-transcript.json')),
    };
    // R9-STEP4：断言**意图本身**落到最终行与恢复产物（不只是“没有 findings”）
    const finalRow = receipts.edit?.target_row_after ?? null;
    const snap = receipts.journey?.target_row_snapshot ?? null;
    const restoredSel = receipts.restore?.selected_row_compare ?? null;
    const intendedChecks = {
      note_in_final_row: finalRow ? String(finalRow.review_notes ?? '').includes(String(note)) : false,
      note_visible_in_readonly_journey: snap ? String(snap.review_notes ?? '').includes(String(note)) : false,
      category_value_in_final_row: classification ? finalRow?.product_category === classification : true,
      category_state_in_final_row: classification ? finalRow?.product_category_state === classificationState : true,
      category_origin_is_operator_edit: classification ? finalRow?.product_category_origin === 'human_review' : true,
      category_operator_carried: classification ? finalRow?.product_category_reviewer === reviewer : true,
      category_evidence_carried: classification ? finalRow?.product_category_evidence_ref === evidenceRef : true,
      // R9-STEP2：显式请求的**复核状态**必须落到最终行；未显式请求时（reviewStatus=null）由 preserve 语义保证不被改动
      review_status_requested_in_final_row: reviewStatus ? finalRow?.review_status === reviewStatus : true,
      review_status_visible_in_readonly_journey: reviewStatus ? snap?.review_status === reviewStatus : true,
      restored_selected_row_matches_expected: restoredSel ? restoredSel.mismatches === 0 : false,
    };
    const assertions = {
      all_steps_exit_zero: steps.every((s) => s.code === 0),
      no_blocked_steps: blocked.length === 0,
      import_ok: receipts.import?.ok === true,
      query_read_only: receipts.query?.mutated === false && receipts.query?.writes_performed === 0,
      query_store_unchanged: storeAfterImport === storeAfterQuery1 && storeAfterReplay === storeAfterQuery2,
      edit_ok: receipts.edit?.ok === true,
      edit_selected_identity: receipts.edit?.selected_entity_key === entityKey,
      edit_store_changed: storeAfterQuery1 !== storeAfterEdit,
      replay_zero_inserts: receipts.import?.import?.tables?.['Videos']?.inserted === 0 && receipts.import?.import?.tables?.['Videos']?.unchanged === 25,
      export_read_only: receipts.export?.read_only === true && receipts.export?.writes_performed === 0,
      export_store_unchanged: storeAfterReplay === storeAfterExport,
      export_selected_in_snapshot: receipts.export?.selected_entity_key === entityKey,
      journey_read_only: storeAfterRestore === storeAfterJourney && receipts.journey?.read_only === true,
      restore_ok: receipts.restore?.ok === true,
      restore_consumed_disk: receipts.restore?.bundle_sha256 === receipts.export?.bundle_sha256,
      ...intendedChecks,
    };
    return { ok: Object.values(assertions).every((v) => v === true), steps, blocked, receipts, assertions, intended_checks: intendedChecks, store_path: storePath, target_url: double.url, bundle_path: bundlePath };
  } finally {
    if (!keepDoubleOpen) await double.close();
  }
}
