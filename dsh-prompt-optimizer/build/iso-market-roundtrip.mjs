/**
 * 端到端验证「市场启用 → 重启」这条真实路径在**隔离** profile 里成立。
 *
 * 市场重启后会往 profile 的 cordis.patch.yml 落一条自己的 entry，形态是
 *   - id: 'mkt-<name>'
 *     name: '<resolveProfileEntry 解析出的 file:// URL>'
 * 本脚本用市场真实的解析逻辑算出那条 name，写进隔离 profile，然后跑
 * `dsh isotest --dump-config` —— 只要合成成功，用户在真实 profile 上重启也不会崩。
 *
 * 用法：node build/iso-market-roundtrip.mjs [pluginDir]
 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const isoHome = 'D:/Codex-workspace/.dsh-iso';
const profileDir = join(isoHome, 'profiles', 'isotest');
const pluginDir = process.argv[2] ?? 'D:/Codex-workspace/dsh-prompt-optimizer';

const patchPath = join(profileDir, 'cordis.patch.yml');
const raw = readFileSync(patchPath, 'utf8').replace(/\r\n/g, '\n');
// 保留模板注释头，正文整体替换（模板正文是 `[]` 占位，不能在其后追加序列项）。
const head = raw.split('\n').filter((l, i) => l.trimStart().startsWith('#') && i < 10).join('\n');

/**
 * 复刻 hot.ts 的 resolveProfileEntry 主路径。
 *
 * 注意市场用的是 `createRequire(join(profileDir,'package.json')).resolve(name)`，
 * 不是 `require.resolve(name, { paths })` —— 后者行为不同（曾报 ERR_INVALID_ARG_TYPE
 * 并让解析静默回落到裸包名）。
 *
 * @param {string} dir - profile 目录。
 * @param {string} name - 包名。
 * @returns {string} 市场会写进 patch 的 name 值。
 */
function resolveProfileEntry(dir, name) {
  if (!name || name.startsWith('.') || name.startsWith('cordis:') || name.startsWith('file://')) return name;
  try {
    const fromProfile = createRequire(join(dir, 'package.json'));
    return pathToFileURL(fromProfile.resolve(name)).href;
  } catch (error) {
    console.log('  createRequire.resolve 失败:', error.code ?? error.message);
    return name;
  }
}

const resolved = resolveProfileEntry(profileDir, 'dsh-prompt-optimizer');
console.log('市场会写入的 name =', resolved);

// 市场模板：`- id: 'mkt-${row.id}'\n  name: '${resolveProfileEntry(...)}'\n`
const body = `- id: 'mkt-dsh-prompt-optimizer'\n  name: '${resolved}'\n`;
writeFileSync(`${patchPath}.tmp`, `${head}\n${body}`, 'utf8');
renameSync(`${patchPath}.tmp`, patchPath);

console.log('\n--- 写入隔离 profile 的 cordis.patch.yml ---');
console.log(readFileSync(patchPath, 'utf8'));

// 自检：该文本必须是合法 YAML（js-yaml 从 profile 里借，避免多一份依赖）
const yaml = createRequire(join(process.env.DSH_PROFILE_DIR ?? isoHome, 'package.json'))('js-yaml');
const parsed = yaml.load(readFileSync(patchPath, 'utf8'));
console.log('YAML 解析:', Array.isArray(parsed) ? `${parsed.length} 条 entry` : '非数组');
console.log('  ', JSON.stringify(parsed));

// 追加一个自制开关：加 --bad 可写入坏形态做对照
if (process.argv.includes('--bad')) {
  const bad = `- id: 'mkt-'dsh-prompt-optimizer''\n  name: '${resolved}'\n`;
  writeFileSync(patchPath, `${head}\n${bad}`, 'utf8');
  console.log('\n[--bad] 已改写为市场的坏产物用于对照');
}
