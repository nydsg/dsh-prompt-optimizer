/**
 * 只把插件**安装**进 profile，但**不启用**它 —— 目的是让 dshmarket 的
 * 「已安装」列表里出现这一行，从而给出「启用」开关交给市场去开。
 *
 * 与 install-profile.mjs 的区别：
 *   install-profile.mjs  → dependencies + dsh.profile.bundles（装好即生效）
 *   本脚本 install-only  → **只写 dependencies**，不碰 bundles
 *
 * 为什么不写 bundles：bundles 里挂着却缺 loader entry 时，市场会显示
 * 「⚠️ 下次启动会失败」(orphanBundle)；而不在 bundles 里，重启时 DSH 根本不会
 * 去加载它，本次重启绝对安全 —— 之后由市场开关负责加 loader entry。
 *
 * 用法：node build/install-only.mjs
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
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
console.log('护栏通过。\n');

console.log('=== 1/3 复制包到 profile node_modules ===');
const target = join(profileDir, 'node_modules', NAME);
if (existsSync(target)) {
  try {
    rmSync(target, { recursive: true, force: true });
  } catch (error) {
    // 目标可能被占用（运行中的 DSH 少见于 node_modules，但 Windows 上删除失败很常见）。
    console.log('  清理旧目录失败（继续尝试覆盖）:', String(error?.code ?? error));
  }
}
mkdirSync(target, { recursive: true });

/**
 * 复制一个文件或目录。优先 Node 的 cpSync；在 Windows 上遇到
 * `EIO, Access is denied`（cpSync 复制目录时的已知毛病）就退回 robocopy。
 *
 * @param {string} from - 源路径。
 * @param {string} to - 目标路径。
 */
function copyItem(from, to) {
  try {
    cpSync(from, to, { recursive: true, force: true });
    return;
  } catch (error) {
    if (process.platform !== 'win32') throw error;
    console.log(`  cpSync 失败（${String(error?.code ?? error)}），改用 robocopy: ${from}`);
    // robocopy 的退出码 < 8 都算成功（0=无变化 1=已复制 2=多余文件 …）
    const result = spawnSync('robocopy', [from, to, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/R:2', '/W:1'], {
      stdio: 'ignore',
    });
    if (result.status === null || result.status >= 8) {
      throw new Error(`robocopy 复制失败（退出码 ${result.status}）: ${from} -> ${to}`);
    }
  }
}

for (const item of ['package.json', 'cordis.patch.yml', 'README.md', 'INTRO.md', 'lib', 'prompt', 'src', 'build', 'test']) {
  const from = join(pluginDir, item);
  if (existsSync(from)) copyItem(from, join(target, item));
}

// 复制结果自检：关键文件必须到位，否则宁可失败也不要留下半成品。
const required = ['package.json', 'cordis.patch.yml', 'INTRO.md', 'lib/index.js', 'lib/client.js', 'lib/rules.js', 'prompt/optimizer-system.md'];
const missing = required.filter((rel) => !existsSync(join(target, ...rel.split('/'))));
if (missing.length > 0) throw new Error(`复制不完整，缺少: ${missing.join(', ')}`);
console.log('  已复制到', target, '（关键文件校验通过）');

console.log('=== 2/3 只登记 dependencies（不动 dsh.profile.bundles）===');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.dependencies ??= {};
pkg.dependencies[NAME] = `file:${pluginDir.replace(/\\/g, '/')}`;
const next = `${JSON.stringify(pkg, null, 2)}\n`;
JSON.parse(next);
const tmp = `${pkgPath}.dpo-tmp`;
writeFileSync(tmp, next, 'utf8');
renameSync(tmp, pkgPath);

console.log('=== 3/3 校验 ===');
const check = JSON.parse(readFileSync(pkgPath, 'utf8'));
const inDeps = Object.hasOwn(check.dependencies, NAME);
const inBundles = (check.dsh?.profile?.bundles ?? []).includes(NAME);
console.log('  dependencies 已登记 :', inDeps);
console.log('  bundles 已登记      :', inBundles);
console.log('  包目录存在          :', existsSync(target));
// 只断言「装好了」。bundles 是否含本包取决于当前处于哪一步：
//   false = 还没在市场里启用（重启后由开关启用，重启本身绝对安全）
//   true  = 已经启用过（比如用户已经在市场里打开了开关），同样正常
if (!inDeps || !existsSync(target)) {
  console.error('\n结果不符合预期：依赖未登记或包目录不完整，请检查 profile。');
  process.exitCode = 1;
} else {
  console.log('\n完成。');
  if (inBundles) {
    console.log('  本插件已在 dsh.profile.bundles 中（你已启用过）—— 重启 DSH 即加载新版本。');
  } else {
    console.log('  尚未启用。接下来：');
    console.log('  1) 重启 DSH');
    console.log('  2) 「设置 → 插件」→「已安装」找到 dsh-prompt-optimizer');
    console.log('  3) 打开它的开关（若提示需重启，再重启一次即可）');
  }
  console.log('\n回滚：node build/uninstall-profile.mjs');
}
