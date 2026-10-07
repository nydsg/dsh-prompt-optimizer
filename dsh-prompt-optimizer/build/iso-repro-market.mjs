/**
 * 复现并验证修复：把「dshmarket 生成的那条坏补丁」写进**隔离** profile 的 patch 层，
 * 看合成是否失败；再写回正确形态，看是否恢复正常。
 *
 * 注意：profile 模板自带的 cordis.patch.yml 正文是 `[]`（空 YAML 数组占位）。
 * 要加条目必须**整体替换**那份正文，不能在 `[]` 后面继续追加序列项 ——
 * 那样写出来的文件本身就是非法 YAML（第一版脚本就踩了这个坑）。
 *
 * 用法：
 *   node build/iso-repro-market.mjs bad     # 写入坏补丁（预期 dump-config 失败）
 *   node build/iso-repro-market.mjs good    # 写入好补丁（预期 dump-config 成功）
 *   node build/iso-repro-market.mjs clean   # 还原成模板原样（[]）
 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const mode = process.argv[2] ?? 'bad';
const patchPath = join('D:/Codex-workspace/.dsh-iso', 'profiles', 'isotest', 'cordis.patch.yml');

/** 保留模板原有的注释头，正文一律由本脚本决定。 */
function header(text) {
  const lines = text.split('\n');
  const kept = [];
  for (const line of lines) {
    if (line.trimStart().startsWith('#')) kept.push(line);
    else break;
  }
  return kept.join('\n');
}

const original = readFileSync(patchPath, 'utf8');
const head = header(original);

/** 市场实际生成的那一行（取自 .dsh-market/log.ndjson 的报错原文）。 */
const BAD = `- id: 'mkt-'dsh-prompt-optimizer''\n  name: 'dsh-prompt-optimizer'\n`;
/** 本包修复后的裸标量形态。 */
const GOOD = `- id: mkt-dsh-prompt-optimizer\n  name: dsh-prompt-optimizer\n`;

let body;
if (mode === 'bad') body = BAD;
else if (mode === 'good') body = GOOD;
else body = '[]\n';

const next = `${head}\n${body}`;
writeFileSync(`${patchPath}.tmp`, next, 'utf8');
renameSync(`${patchPath}.tmp`, patchPath);

console.log(`[${mode}] 已写入`, patchPath);
console.log('--- 完整内容 ---');
console.log(next);
