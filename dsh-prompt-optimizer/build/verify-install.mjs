/**
 * 校验 bundle patch 的「市场往返」安全性。
 *
 * 背景（一次真实的启动崩溃）：
 *   dshmarket 从「设置 → 插件」启用本插件时，会读取本包的 dsh.bundle.patch，
 *   给条目 id 加上自己的 `mkt-` 前缀后**重新生成**一个 loader 补丁条目。
 *   第一版 cordis.patch.yml 里带了注释和被注释掉的 config 块，
 *   市场重新生成的结果是 `- id: 'mkt-'dsh-prompt-optimizer''` ——
 *   js-yaml 直接报 `bad indentation of a mapping entry (1:13)`，
 *   该补丁又落在 profile 的 patch 层里，于是**整个 DSH 起不来**。
 *
 * 本脚本因此强制三条不变量：
 *   1. patch 文件不含注释、不含 config 块（只留 id + name 三行）。
 *   2. 本包自己的补丁解析后恰好一条 insert 行。
 *   3. 模拟市场「加 mkt- 前缀后重新生成」的往返，结果仍必须是合法 YAML
 *      且仍解析出恰好一条 entry。任何一条不满足就退出码非 0。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { resolveProfileDir, resolvePluginDir, loadYaml } from './profile-path.mjs';

const require = createRequire(import.meta.url);
// 在用户自己的终端里跑也能工作：自动定位 profile 与插件目录。
const profileDir = resolveProfileDir();
const pluginDir = resolvePluginDir(import.meta.url);

const yaml = loadYaml({ profileDir, require, pluginDir });
const text = readFileSync(join(pluginDir, 'cordis.patch.yml'), 'utf8');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'OK   ' : 'FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

console.log('--- 1. 文件卫生（市场会重新生成，注释与 config 块都可能被打乱）---');
const commentLines = text.split('\n').filter((line) => line.trimStart().startsWith('#'));
check(commentLines.length === 0, '不含注释行', `发现 ${commentLines.length} 行`);
check(!/^\s*config:/m.test(text), '不含 config 块');
check(!/id:\s*'/.test(text), 'id 不加引号（避免前缀拼接时引号套引号）');
check(!/name:\s*'/.test(text), 'name 不加引号');
const lineCount = text.trim().split('\n').length;
check(lineCount === 3, '仅 3 行（insert / id / name）', `实际 ${lineCount} 行`);

console.log('--- 2. 本包补丁自身 ---');
const parsed = yaml.load(text);
const inserted = (Array.isArray(parsed) ? parsed : []).flatMap((e) => (Array.isArray(e?.insert) ? e.insert : []));
check(Array.isArray(parsed), '顶层是数组');
check(inserted.length === 1, '恰好一条 insert 行', `实际 ${inserted.length}`);
const row = inserted[0] ?? {};
check(row.id === 'dsh-prompt-optimizer', 'id 正确', String(row.id));
check(row.name === 'dsh-prompt-optimizer', 'name 正确', String(row.name));

console.log('--- 3. 模拟市场的 mkt- 前缀往返 ---');
// 市场的行为：id 变成 `mkt-<原 id>`，name 保留为它认定的包标识。
const marketId = `mkt-${row.id}`;
const reEmitted = yaml.dump([{ id: marketId, name: row.name }], { lineWidth: -1, quotingType: '"' });
let roundTripped = null;
try {
  roundTripped = yaml.load(reEmitted);
  check(true, '重新生成后仍是合法 YAML');
} catch (error) {
  check(false, '重新生成后仍是合法 YAML', String(error.message));
}
if (roundTripped !== null) {
  check(Array.isArray(roundTripped) && roundTripped.length === 1, '往返后仍是一条 entry');
  check(roundTripped[0]?.id === marketId, '往返后 id 未被破坏', String(roundTripped[0]?.id));
  check(!String(roundTripped[0]?.id ?? '').includes("'"), '往返后 id 不含杂散引号');
}
check(!reEmitted.includes("''"), "生成文本不含 '' （崩溃特征）");
check(!/^-\s*id:\s*'[^']*'[^':]/.test(reEmitted), "不存在 `- id: 'x'y'` 形态");

console.log(failures === 0 ? '\nPATCH SAFE: bundle patch 可安全通过市场往返' : `\nPATCH UNSAFE: ${failures} 项未通过`);
process.exitCode = failures === 0 ? 0 : 1;
