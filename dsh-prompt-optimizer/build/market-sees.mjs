/**
 * 用 dshmarket 自己的「已安装」分析逻辑，验证插件会被市场识别为已安装。
 *
 * 直接调用市场的 check.ts / profile.ts 编译产物里的真实函数（纯文件系统分析），
 * 而不是我猜它怎么算「已安装」。
 *
 * 用法：
 *   node build/market-sees.mjs --profile <被分析的 profile> [--market <含 dshmarket 的目录>]
 * 缺省：--profile 取 DSH_PROFILE_DIR；--market 取 DSH_PROFILE_DIR（同一 profile）。
 * 隔离 profile 里通常没有 dshmarket，所以要把 --market 指向真实 profile。
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';

/** 读一个 `--flag value` 形式参数。 */
function arg(name, fallback) {
  const at = process.argv.indexOf(name);
  return at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1] : fallback;
}

const liveProfile = process.env.DSH_PROFILE_DIR;
const profileDir = arg('--profile', liveProfile);
const marketDir = arg('--market', profileDir);
if (!profileDir || !marketDir) throw new Error('need --profile / --market (or DSH_PROFILE_DIR)');
console.log('分析目标 profile :', profileDir);
console.log('市场实现来自     :', marketDir);

const require = createRequire(import.meta.url);
const marketLib = join(marketDir, 'node_modules', 'dshmarket', 'lib');

const profileMod = await import(`file://${join(marketLib, 'profile.js').replace(/\\/g, '/')}`);
const profileKeys = Object.keys(profileMod);
console.log('\nprofile.js 里与依赖/声明相关的导出:');
console.log('  ', profileKeys.filter((k) => /depend|bundle|patch|read|list|profile/i.test(k)).join(', ') || '(none)');

// 市场判断「哪些插件被声明/安装」的入口
const readers = ['readProfileDependencies', 'dependenciesOf', 'readProfile', 'declaredDependencies'];
let deps = null;
for (const name of readers) {
  if (typeof profileMod[name] === 'function') {
    try {
      deps = profileMod[name](profileDir);
      console.log(`\n${name}(profileDir) ->`, JSON.stringify(deps, null, 2).slice(0, 800));
      break;
    } catch (error) {
      console.log(`\n${name}() 调用失败:`, error.message);
    }
  }
}
if (deps === null) {
  // 退化路径：直接把 profile package.json 读出来看市场能看到什么
  const { readFileSync } = await import('node:fs');
  deps = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
  console.log('\n(未找到读取函数，直接看 profile package.json)');
  console.log(JSON.stringify({ dependencies: deps.dependencies, bundles: deps.dsh?.profile?.bundles }, null, 2));
}

const hasMine = JSON.stringify(deps).includes('dsh-prompt-optimizer');
console.log('\n市场可见的声明中包含本插件:', hasMine);

// 再用 check.js 做一次完整 profile 体检，看它如何归类本插件
try {
  const checkMod = await import(`file://${join(marketLib, 'check.js').replace(/\\/g, '/')}`);
  const analyze = checkMod.analyzeProfile ?? checkMod.analyzeProfileDirectory;
  if (typeof analyze === 'function') {
    const result = analyze(profileDir);
    console.log('\ncheck.analyzeProfile 顶层字段:', Object.keys(result ?? {}).join(', '));
    const text = JSON.stringify(result ?? {});
    console.log('结果里提到本插件:', text.includes('prompt-optimizer'));
    for (const key of ['unaccounted', 'residuals', 'orphans', 'broken', 'layers', 'plugins']) {
      const list = result?.[key];
      if (Array.isArray(list) && list.length > 0) {
        const mine = list.filter((x) => JSON.stringify(x).includes('prompt-optimizer'));
        console.log(`  ${key}: ${list.length} 项${mine.length > 0 ? `（含本插件 ${mine.length} 项）` : ''}`);
        for (const m of mine) console.log('     ->', JSON.stringify(m).slice(0, 200));
      }
    }
  }
} catch (error) {
  console.log('\ncheck.js 分析跳过:', error.message);
}

