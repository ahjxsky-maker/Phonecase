// tools/material-library/tests/fixture-root.mjs
// R6 建立、R7 修正：测试的临时/夹具目录必须落在**授权子树**内，且**在创建任何目录之前**完成校验。
//
// R7 指出的缺陷：旧实现先 `mkdirSync` 再校验，而且校验的是整个 W（比授权根更宽）。
// 现在：候选路径先解析（含 junction）到真实路径 → 再判断是否位于 envelope 的四个授权子树上
// → 通过后才创建。解析用到最近的存在祖先，因此候选自身不存在也能得到正确真实路径。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));            // .../tools/material-library/tests
export const W_ROOT = path.resolve(HERE, '..', '..', '..');            // D:/Codex-local/harness-workspaces/Phonecase
export const O_ROOT = path.join(W_ROOT, 'outputs', 'product-material-library-phase1-20261006');
const DEFAULT_ROOT = path.join(O_ROOT, 'tests-tmp');

// envelope（material-library-R7-env-v1）的四个授权根
export const AUTHORIZED_SUBTREES = [
  path.join(W_ROOT, 'tools', 'material-library'),
  path.join(W_ROOT, 'docs', 'product-material-library'),
  O_ROOT,
  path.join(W_ROOT, 'harness-reports'),
];

function canonical(p) {
  try { return (fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p)).replace(/\\/g, '/'); }
  catch { return path.resolve(p).replace(/\\/g, '/'); }
}

/** 解析到真实路径：向上找到最近的存在祖先并 realpath，再把缺失的尾段拼回（此时**不创建**任何目录）。 */
export function resolveRealPath(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (;;) {
    if (fs.existsSync(cur)) break;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    tail.unshift(path.basename(cur));
    cur = parent;
  }
  const real = canonical(cur);
  return tail.length ? path.join(real, ...tail).replace(/\\/g, '/') : real;
}

export function authorizedSubtreeFor(p) {
  const real = resolveRealPath(p).toLowerCase();
  return AUTHORIZED_SUBTREES.find((root) => {
    const r = canonical(root).toLowerCase().replace(/\/+$/, '');
    return real === r || real.startsWith(`${r}/`);
  }) ?? null;
}

export function assertFixturePathAllowed(p) {
  const root = authorizedSubtreeFor(p);
  if (!root) {
    throw new Error(`fixture_path_outside_authorized_roots:${resolveRealPath(p)}（允许：${AUTHORIZED_SUBTREES.map((x) => canonical(x)).join(' | ')}）`);
  }
  return root;
}

export function fixtureRoot() {
  const raw = process.env.ML_TEST_ROOT || DEFAULT_ROOT;
  const resolvedReal = resolveRealPath(raw);
  assertFixturePathAllowed(resolvedReal);          // 校验先于创建
  fs.mkdirSync(resolvedReal, { recursive: true }); // 只有通过校验才会创建
  return resolvedReal;
}

/** 在授权根内创建唯一夹具目录并返回真实路径（同样先校验后创建）。 */
export function mkFixtureDir(prefix = 'case-') {
  const root = fixtureRoot();
  const candidate = path.join(root, prefix + Math.random().toString(36).slice(2, 8));
  assertFixturePathAllowed(candidate);
  fs.mkdirSync(candidate, { recursive: true });
  const real = canonical(candidate);
  assertFixturePathAllowed(real);
  return real;
}

export function describeFixtureRoot() {
  const root = fixtureRoot();
  return {
    ml_test_root_env: process.env.ML_TEST_ROOT ?? null,
    resolved_root: root,
    workspace: canonical(W_ROOT),
    authorized_subtrees: AUTHORIZED_SUBTREES.map((x) => canonical(x)),
    inside_workspace: canonical(root).toLowerCase().startsWith(`${canonical(W_ROOT).toLowerCase()}/`),
    inside_authorized_subtree: authorizedSubtreeFor(root) !== null,
  };
}
