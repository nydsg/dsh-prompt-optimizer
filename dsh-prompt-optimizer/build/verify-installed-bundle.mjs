/**
 * 确认装进 profile 的 client bundle 是**修好的形态**。
 * 单独放文件里跑，避免行内 node -e 的引号被 PowerShell 吃掉。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveProfileDir } from './profile-path.mjs';

const profileDir = resolveProfileDir();
const file = join(profileDir, 'node_modules', 'dsh-prompt-optimizer', 'lib', 'client.js');
const source = readFileSync(file, 'utf8');

const checks = [
  ['顶层没有 return（经典脚本必须如此）', /^return\s/m.test(source) === false],
  ['含 window.__ModuleLoader__.load 自注册', source.includes('window.__ModuleLoader__.load(')],
  ['注册 id 为 dsh-prompt-optimizer', source.includes("id: 'dsh-prompt-optimizer'")],
  ['factory 内 return module.exports', source.includes('return module.exports;')],
  ['含按钮文案「优化提示词」', source.includes('优化提示词')],
  ['注册了输入框工具条插槽', source.includes('conversation.input.right')],
  ['注册了结果面板插槽', source.includes('conversation.input.dock')],
];

let bad = 0;
console.log('检查文件:', file);
for (const [label, ok] of checks) {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`);
  if (!ok) bad += 1;
}
console.log(bad === 0 ? '\nOK: 装进去的是修好的 bundle' : `\n${bad} 项未通过`);
process.exitCode = bad === 0 ? 0 : 1;
