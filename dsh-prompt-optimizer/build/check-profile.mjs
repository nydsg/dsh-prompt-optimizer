/**
 * Profile 健康检查：确认 profile 声明的依赖与 bundle patch 都真的到位。
 *
 * 一次失败的装包会把 node_modules 留成半成品，从而让整个 profile 起不来 ——
 * 这个脚本就是用来排除那种情况的。
 *
 * 判定「已安装」的正确方式**不是** `require.resolve('<pkg>/package.json')`：
 * 很多包在 `exports` 里没有导出 `./package.json`，那样解析会抛
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`，把健康的安装误报成缺失
 * （本脚本第一版就这样把 @furongjun1999/dsh-memory 误报过一次）。
 *
 * 正确做法，按可靠性从高到低：
 *   1. `require.resolve(name)` —— 解析包的主入口，能成功就说明包可用；
 *   2. `node_modules/<name>/package.json` 存在 —— 覆盖「主入口解析不了但包在」的情况；
 *   3. 两者都失败才算缺失。
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { resolveProfileDir } from './profile-path.mjs';

// 在用户自己的终端里跑也能工作：自动定位 profile（详见 profile-path.mjs）。
const profileDir = resolveProfileDir();
console.log('目标 profile :', profileDir);

const pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
const require = createRequire(join(profileDir, 'package.json'));

/**
 * 判断一个包在 profile 里是否真的可用。
 * @param {string} name - 包名。
 * @returns {{ok: boolean, how: string}} 结果与判定依据。
 */
function probe(name) {
  try {
    require.resolve(name);
    return { ok: true, how: 'main' };
  } catch {
    /* 主入口解析失败，继续看目录 */
  }
  const manifest = join(profileDir, 'node_modules', ...name.split('/'), 'package.json');
  if (existsSync(manifest)) return { ok: true, how: 'dir' };
  return { ok: false, how: 'none' };
}

let bad = 0;
console.log('--- dependencies ---');
for (const name of Object.keys(pkg.dependencies ?? {})) {
  const { ok, how } = probe(name);
  if (!ok) bad += 1;
  console.log(`  ${ok ? 'OK     ' : 'MISSING'} ${name}${ok && how === 'dir' ? '  (主入口未解析，但包目录在)' : ''}`);
}

console.log('--- bundle patch files ---');
for (const b of pkg.dsh.profile.bundles) {
  // in-box bundle（@deepseek-ai/dsh-base 等）来自安装目录而非 profile 的 node_modules，
  // 在 profile 里解析不到属于正常，不计为问题。
  let manifestDir = null;
  try {
    manifestDir = join(require.resolve(`${b}/package.json`), '..');
  } catch {
    const local = join(profileDir, 'node_modules', ...b.split('/'));
    if (existsSync(join(local, 'package.json'))) manifestDir = local;
  }
  if (manifestDir === null) {
    console.log(`  skip     ${b}  (由安装目录提供，profile 内无副本 —— 正常)`);
    continue;
  }
  const json = JSON.parse(readFileSync(join(manifestDir, 'package.json'), 'utf8'));
  const patch = json.dsh?.bundle?.patch;
  if (patch === undefined) {
    console.log(`  no-patch ${b}`);
    continue;
  }
  const ok = existsSync(join(manifestDir, patch));
  if (!ok) bad += 1;
  console.log(`  ${ok ? 'OK      ' : 'MISSING '} ${b}  patch=${patch}`);
}

console.log(bad === 0 ? '\nHEALTHY: 依赖与 bundle patch 均到位' : `\nUNHEALTHY: ${bad} 个问题`);
process.exitCode = bad === 0 ? 0 : 1;
