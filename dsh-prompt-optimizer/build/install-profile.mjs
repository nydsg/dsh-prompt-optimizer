/**
 * 把 dsh-prompt-optimizer 注册进 DSH profile（幂等 + 带护栏）。
 *
 * 做三件事：
 *   0. **前置护栏**：先跑 build/verify-install.mjs 验证 bundle patch 能安全通过
 *      dshmarket 的 `mkt-` 前缀往返。不过关就直接中止 —— 一个会被市场重新生成
 *      成非法 YAML 的 patch 会让**整个 DSH 起不来**（真实踩过）。
 *   1. 把本包复制进 profile 的 node_modules（不依赖联网装包，也不用 pnpm）。
 *   2. package.json 的 dependencies + dsh.profile.bundles 各登记一次。
 * 任何一步失败都原样回滚 package.json（写临时文件 → 校验 JSON → 原子替换）。
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { resolveProfileDir, resolvePluginDir } from './profile-path.mjs';

const here = dirname(fileURLToPath(import.meta.url));
// 在用户自己的终端里跑也能工作：自动定位 profile（详见 profile-path.mjs）。
const profileDir = resolveProfileDir();
console.log('目标 profile :', profileDir);

const pluginDir = resolvePluginDir(import.meta.url);
const NAME = 'dsh-prompt-optimizer';
const pkgPath = join(profileDir, 'package.json');

console.log('=== 0/3 前置护栏：bundle patch 市场往返安全性 ===');
execFileSync(process.execPath, [join(here, 'verify-install.mjs')], { stdio: 'inherit' });
console.log('护栏通过，继续安装。\n');

console.log('=== 1/3 复制包到 profile node_modules ===');
const target = join(profileDir, 'node_modules', NAME);
if (existsSync(target)) rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const item of ['package.json', 'cordis.patch.yml', 'README.md', 'lib', 'prompt', 'src', 'build', 'test']) {
  const from = join(pluginDir, item);
  if (existsSync(from)) cpSync(from, join(target, item), { recursive: true });
}
console.log('  已复制到', target);

console.log('=== 2/3 登记 profile package.json ===');
const original = readFileSync(pkgPath, 'utf8');
const pkg = JSON.parse(original);
pkg.dependencies ??= {};
pkg.dependencies[NAME] = `file:${pluginDir.replace(/\\/g, '/')}`;
pkg.dsh ??= {};
pkg.dsh.profile ??= {};
pkg.dsh.profile.bundles ??= [];
if (!pkg.dsh.profile.bundles.includes(NAME)) pkg.dsh.profile.bundles.push(NAME);

const next = `${JSON.stringify(pkg, null, 2)}\n`;
JSON.parse(next); // 自检：绝不写坏 profile
const tmp = `${pkgPath}.dpo-tmp`;
writeFileSync(tmp, next, 'utf8');
renameSync(tmp, pkgPath);

console.log('=== 3/3 校验 ===');
const check = JSON.parse(readFileSync(pkgPath, 'utf8'));
console.log('  dependency :', check.dependencies[NAME]);
console.log('  bundles    :', check.dsh.profile.bundles.length, '项，含本包：', check.dsh.profile.bundles.includes(NAME));
console.log('\n完成。请重启 DSH 让 Host 半装配。');
console.log('回滚：node build/uninstall-profile.mjs');
