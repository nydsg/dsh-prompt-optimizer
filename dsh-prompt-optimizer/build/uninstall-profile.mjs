/**
 * 从 DSH profile 注销 dsh-prompt-optimizer（幂等，随时可跑）。
 *
 * 用途：任何时候怀疑本插件影响了启动，执行这一条即可把 profile 恢复到
 * 「完全没有本插件」的状态 —— 不改动其它任何插件与设置。
 *
 * 做三件事：
 *   1. 从 package.json 的 dsh.profile.bundles 移除本包。
 *   2. 从 dependencies 移除本包。
 *   3. 删除 profile 的 node_modules/dsh-prompt-optimizer。
 * 最后校验：bundles 与 dependencies 中都不再出现本包。
 */
import { readFileSync, writeFileSync, renameSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { resolveProfileDir } from './profile-path.mjs';

// 在用户自己的终端里跑也能工作：自动定位 profile（详见 profile-path.mjs）。
const profileDir = resolveProfileDir();
console.log('目标 profile :', profileDir);

const NAME = 'dsh-prompt-optimizer';
const pkgPath = join(profileDir, 'package.json');
const nodeModulesPath = join(profileDir, 'node_modules', NAME);

console.log('=== 1/3 从 profile package.json 注销 ===');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const hadDep = Object.hasOwn(pkg.dependencies ?? {}, NAME);
const hadBundle = (pkg.dsh?.profile?.bundles ?? []).includes(NAME);
if (pkg.dependencies) delete pkg.dependencies[NAME];
if (pkg.dsh?.profile?.bundles) {
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== NAME);
}
const next = `${JSON.stringify(pkg, null, 2)}\n`;
JSON.parse(next);
const tmp = `${pkgPath}.dpo-tmp`;
writeFileSync(tmp, next, 'utf8');
renameSync(tmp, pkgPath);
console.log(`  dependencies 命中：${hadDep}；bundles 命中：${hadBundle}`);

console.log('=== 2/3 删除 profile node_modules 里的包 ===');
if (existsSync(nodeModulesPath)) {
  rmSync(nodeModulesPath, { recursive: true, force: true });
  console.log('  已删除', nodeModulesPath);
} else {
  console.log('  不存在，跳过');
}

console.log('=== 3/3 校验 ===');
const check = JSON.parse(readFileSync(pkgPath, 'utf8'));
const depLeft = Object.keys(check.dependencies ?? {}).filter((k) => k.includes('prompt-optimizer'));
const bundleLeft = (check.dsh?.profile?.bundles ?? []).filter((b) => b.includes('prompt-optimizer'));
console.log('  dependencies 残留 :', depLeft.length);
console.log('  bundles 残留      :', bundleLeft.length);
console.log('  node_modules 残留 :', existsSync(nodeModulesPath));
console.log('  bundles 现有条目  :', (check.dsh?.profile?.bundles ?? []).length);
const clean = depLeft.length === 0 && bundleLeft.length === 0 && !existsSync(nodeModulesPath);
console.log(clean ? '\nCLEAN: 本插件已从 profile 完全移除' : '\nINCOMPLETE: 仍有残留');
process.exitCode = clean ? 0 : 1;
