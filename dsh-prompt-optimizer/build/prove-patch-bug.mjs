// 用市场日志里出现的那一行，反推市场的字符串拼接方式，验证「新旧补丁」的差别。
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const yaml = require(require.resolve('js-yaml', { paths: [process.env.DSH_PROFILE_DIR] }));

// 市场日志里真实出现过的崩溃产物：
const observed = "- id: 'mkt-'dsh-prompt-optimizer''";
console.log('日志中的崩溃行:', observed);
try {
  yaml.load(observed);
  console.log('  -> 居然解析成功？');
} catch (e) {
  console.log('  -> js-yaml 报错:', e.message.split('\n')[0]);
}

// 反推：市场把补丁里 name/id 的 REAL 值做了 replace(value, `mkt-${value}`) 式拼接，
// 如果原文是带引号的 'dsh-prompt-optimizer'，把 value 替换进带引号的模板就会产生上面的形态。
const OLD = `- insert:\n    - id: 'dsh-prompt-optimizer'\n      name: 'dsh-prompt-optimizer'\n`;
const NEW = `- insert:\n    - id: dsh-prompt-optimizer\n      name: dsh-prompt-optimizer\n`;

for (const [label, text] of [['旧补丁（带引号+注释+config 块）', OLD], ['新补丁（裸标量，3 行）', NEW]]) {
  const id = yaml.load(text)[0].insert[0].id;
  // 市场加前缀：模拟它把 id 文本整体替换为 `mkt-${id}`
  const rebuilt = text.replace(id, `mkt-${id}`);
  const line = rebuilt.split('\n').find((l) => l.includes('id:'));
  let verdict;
  try { yaml.load(rebuilt); verdict = '合法'; } catch (e) { verdict = `非法 -> ${e.message.split('\n')[0]}`; }
  console.log(`\n${label}`);
  console.log('  解析出的 id   :', JSON.stringify(id));
  console.log('  加前缀后的行  :', JSON.stringify(line.trim()));
  console.log('  重新解析      :', verdict);
}
