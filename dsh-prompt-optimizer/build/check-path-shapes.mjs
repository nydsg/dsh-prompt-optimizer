import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const yaml = require(require.resolve('js-yaml', { paths: [process.env.DSH_PROFILE_DIR] }));
const p = process.env.DSH_PROFILE_DIR.replace(/\\/g, '/');

// 模拟：插件从当前源目录安装时，市场会解析出什么 name
const srcUrl = pathToFileURL('D:/Codex-workspace/dsh-prompt-optimizer/lib/index.js').href;
// 模拟：插件被复制进 profile 的 node_modules（含空格路径）时的 name
const inProfile = pathToFileURL(join(p, 'node_modules', 'dsh-prompt-optimizer', 'lib', 'index.js')).href;
// 模拟：link: 安装（软链到源目录）时的 name
const linkTarget = pathToFileURL('D:/Codex-workspace/dsh-prompt-optimizer/lib/index.js').href;

for (const [label, name] of [['源目录（无空格）', srcUrl], ['profile 内副本（含空格）', inProfile], ['link 到源目录', linkTarget]]) {
  const yml = `- id: 'mkt-dsh-prompt-optimizer'\n  name: '${name}'\n`;
  let verdict;
  let parsed = null;
  try { parsed = yaml.load(yml); verdict = '合法 YAML'; } catch (e) { verdict = '非法 -> ' + e.message.split('\n')[0]; }
  console.log(`\n[${label}]`);
  console.log('  name =', name);
  console.log('  ->', verdict);
  if (parsed) console.log('  解析结果 id =', parsed[0].id, '| name =', String(parsed[0].name).slice(0, 80));
}
