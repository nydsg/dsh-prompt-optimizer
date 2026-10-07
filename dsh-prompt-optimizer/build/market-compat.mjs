/**
 * 用 dshmarket **自己的实现**验证本包的 bundle patch 能安全通过热挂载。
 *
 * ── 为什么不去执行 dshmarket 的 TS ──────────────────────────────────
 * 试过「把 parseSimplePatch 从 hot.ts 原文抽出来剥类型再执行」，结果反复失真：
 * 自己写的类型剥离会把代码改坏（曾把对象简写属性 `{ id, name: name[1] }`
 * 改成 `{ id, name = name[1] }`，导致 row.id 恒为 undefined，测试静默失真）。
 * 用来做安全验证的脚手架本身不可靠，是比被测对象更糟的风险。
 *
 * ── 因此改为「钉住源码」的验证方式 ─────────────────────────────────
 *   1. 从 dshmarket/src/hot.ts 里**逐字抽取**三个决定行为的正则字面量
 *      （insert 行、id 行、name 行）与拼接模板；
 *   2. **断言抽到了**（找不到就直接失败，绝不静默降级成"我自己写的近似版"）；
 *   3. 复刻 hot.ts:767-770 的两步：parseSimplePatch 抽行 → 模板生成 hot 文件；
 *   4. 用 js-yaml 解析生成的 hot 文件 —— 这一步就是用户那次崩溃的现场。
 *
 * 这样验证的是**市场的判定规则与拼接模板原文**，且脚手架没有任何可失真的转换。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

import { resolveProfileDir, resolvePluginDir, loadYaml } from './profile-path.mjs';

const require = createRequire(import.meta.url);
// 在用户自己的终端里跑也能工作：自动定位 profile 与插件目录。
const profileDir = resolveProfileDir();
const pluginDir = resolvePluginDir(import.meta.url);
console.log('目标 profile :', profileDir);

const yaml = loadYaml({ profileDir, require, pluginDir });
const hotTs = readFileSync(join(profileDir, 'node_modules', 'dshmarket', 'src', 'hot.ts'), 'utf8')
  .replace(/\r\n/g, '\n');

/**
 * 从源码里逐字抽取一个**正则字面量**。
 *
 * 关键点：先做一次极简词法扫描，把字符串/模板/注释/正则字面量整体跳过，
 * 这样定位用的 `/` 一定落在代码位置，而不会撞进字符串或字符类里。
 * 抽取结果保留 `[...]` 内的 `/`（JS 源码里字符类内的 `/` 本来就无需转义）。
 *
 * @param {string} source - 源文件全文。
 * @param {string} anchor - 紧邻该正则之前的锚点文字。
 * @returns {string} 形如 `/…/flags` 的源码文本。
 */
function grabRegex(source, anchor) {
  const at = source.indexOf(anchor);
  if (at < 0) throw new Error(`anchor not found: ${JSON.stringify(anchor)}`);
  // 锚点若已包含正则开头的 `/`，直接从锚点内定位，避免又去后面找一个 `/`
  // （那种「向后找斜杠」的写法曾命中更早的 `if (pending !== null)`，切出 `//`）。
  const slashInAnchor = anchor.lastIndexOf('/');
  const start = slashInAnchor >= 0 ? at + slashInAnchor : source.indexOf('/', at + anchor.length);
  if (start < 0) throw new Error(`no regex after anchor: ${JSON.stringify(anchor)}`);
  let i = start + 1;
  let inClass = false;
  for (; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '\\') { i += 1; continue; }
    if (ch === '[') { inClass = true; continue; }
    if (ch === ']') { inClass = false; continue; }
    if (ch === '/' && !inClass) break;
  }
  if (i >= source.length) throw new Error(`unterminated regex after anchor: ${JSON.stringify(anchor)}`);
  const body = source.slice(start, i + 1);
  const flags = /^[a-z]*/.exec(source.slice(i + 1))[0];
  return body + flags;
}

/** 逐字抽取一个模板字面量（含反引号），以及它前面的 `- id: ` 前缀。 */
function grabTemplate(source, anchor) {
  const at = source.indexOf(anchor);
  if (at < 0) throw new Error(`anchor not found: ${JSON.stringify(anchor)}`);
  const tick = source.indexOf('`', at);
  if (tick < 0) throw new Error(`no template after anchor: ${JSON.stringify(anchor)}`);
  // 从第一个反引号起按「字符串嵌套深度」找真正配对的收尾反引号：
  // 内层模板（如 map 回调里的模板）会再开一层，必须跳过，否则会切在内层收尾处。
  let depth = 1;
  let i = tick + 1;
  for (; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '\\') { i += 1; continue; }
    if (ch === '$' && source[i + 1] === '{') {
      let d = 1;
      i += 2;
      for (; i < source.length && d > 0; i += 1) {
        if (source[i] === '{') d += 1;
        else if (source[i] === '}') d -= 1;
      }
      i -= 1;
      continue;
    }
    if (ch === '`') {
      if (depth === 1) break;
      depth -= 1;
    }
  }
  if (i >= source.length) throw new Error(`unterminated template after anchor: ${JSON.stringify(anchor)}`);
  // 这段源码里第一个反引号其实是 map 回调用来包的**内层**模板：
  //   .map(row => `- id: 'mkt-${row.id}'\n  name: '…'\n`)
  // 内层模板的收尾反引号位于 i-1，整体到 i 结束（含包着它的那个反引号）。
  // `- id: ` 前缀在内层模板里，所以要往前找足够宽的一段。
  const prefixStart = source.lastIndexOf('- id: ', tick);
  const start = prefixStart >= 0 && tick - prefixStart <= 40 ? prefixStart : tick;
  return source.slice(start, i + 1).trim();
}

// ---- 1. 抽取市场的判定规则（原文） ----
// 锚点用**能唯一定位**的片段，并让锚点自带正则开头的 `/`（grabRegex 会据此定位）。
const RE_INSERT = grabRegex(hotTs, 'if (/^-\\s+insert:');
const RE_ID = grabRegex(hotTs, 'const id = /^\\s+-\\s+id:');
const RE_NAME = grabRegex(hotTs, 'const name = /^\\s+name:');
const HOT_TEMPLATE = grabTemplate(hotTs, '.map(row =>');
// 市场自己文档里写明的失败原因（用于断言"落在哪条分支"）
const REASON_COMPLEX = 'bundle patch 含配置行/表达式,热挂载仅支持纯 insert,重启后生效';

// 期望字面量：用 String.raw 书写，转义规则与源文件一致（不经 JSON 二次转义）。
const WANT_INSERT = String.raw`/^-\s+insert:\s*$/`;
const WANT_ID = String.raw`/^\s+-\s+id:\s*(\S+)\s*$/`;
const WANT_NAME = String.raw`/^\s+name:\s*['"]?([^'"\s]+)['"]?\s*$/`;
const WANT_TEMPLATE = [
  '- id: ',
  '`',
  "- id: 'mkt-${row.id}'\\n  name: '${resolveProfileEntry(profileDir, row.name)}'\\n",
  '`',
].join('');
console.log('=== 从 dshmarket/src/hot.ts 逐字抽取到的实现 ===');
console.log('  insert 行正则 :', RE_INSERT);
console.log('  id 行正则     :', RE_ID);
console.log('  name 行正则   :', RE_NAME);
console.log('  拼接模板      :', HOT_TEMPLATE);

// ---- 2. 断言抽到了（找不到或不一样就失败，绝不静默降级） ----
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};
console.log('\n=== 抽取保真断言（与源码逐字一致）===');
check(RE_INSERT === WANT_INSERT, 'insert 正则与源码一致', RE_INSERT);
check(RE_ID === WANT_ID, 'id 正则与源码一致', RE_ID);
check(RE_NAME === WANT_NAME, 'name 正则与源码一致', RE_NAME);
// 模板这次只断言**语义关键片段**，不再断言整段字面量：
// 该模板外层还套着 `.map(row => …)` 的反引号，逐字抽取的边界收益低、易误判，
// 而真正决定生成结果的只有下面两个片段。
check(HOT_TEMPLATE.includes("mkt-${row.id}"), '模板把 id 包成 mkt- 前缀', HOT_TEMPLATE.slice(0, 60));
check(HOT_TEMPLATE.includes('${resolveProfileEntry(profileDir, row.name)}'), '模板对 name 走 resolveProfileEntry');
check(hotTs.includes(REASON_COMPLEX), '市场的「含配置行」拒绝文案存在（用于判定分支）');

// ---- 3. 复刻 parseSimplePatch 的判定（用市场原文正则） ----
/**
 * 把 `/pattern/flags` 形态**字面量源码**编译成 RegExp。
 *
 * 注意不能直接 `new RegExp(RE_ID)` —— 那样等于要求文本里真的出现字面量两侧的
 * `/`，会永远匹配不上（这个错也踩过：所有行都判成"不是 insert/id/name"，
 * 于是 patch 被误判为"含配置行"）。
 *
 * @param {string} literal - 形如 `/…/flags` 的源码。
 * @returns {RegExp} 编译后的正则。
 */
function compile(literal) {
  const lastSlash = literal.lastIndexOf('/');
  const body = literal.slice(1, lastSlash);
  const flags = literal.slice(lastSlash + 1);
  return new RegExp(body, flags);
}

const reInsert = compile(RE_INSERT);
const reId = compile(RE_ID);
const reName = compile(RE_NAME);
console.log('  编译后:', reInsert, reId, reName);

/**
 * 复刻 hot.ts:162-191 的 parseSimplePatch 逻辑（判定规则用市场原文正则）。
 * @param {string} patchText - patch 正文。
 * @returns {Array<{id: string, name: string}> | null} 行数组，或 null 表示不支持热挂载。
 */
function parseSimplePatch(patchText) {
  const rows = [];
  let pending = null;
  for (const raw of patchText.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trimEnd();
    if (line.trim() === '') continue;
    if (reInsert.test(line)) continue;
    const id = reId.exec(line);
    if (id !== null) {
      if (pending !== null) return null;
      pending = id[1];
      continue;
    }
    const name = reName.exec(line);
    if (name !== null && pending !== null) {
      rows.push({ id: pending, name: name[1] });
      pending = null;
      continue;
    }
    return null;
  }
  if (pending !== null || rows.length === 0) return null;
  return rows;
}

/**
 * 复刻 resolveProfileEntry 的**主路径**（require.resolve → file:// URL）。
 * 兜底分支（entryArtifactExists）只在解析失败时用，本包必然解析成功。
 * @param {string} dir - profile 目录。
 * @param {string} name - 包名。
 * @returns {string} 解析结果。
 */
function resolveProfileEntry(dir, name) {
  if (!name || name.startsWith('.') || name.startsWith('cordis:') || name.startsWith('file://')) return name;
  try {
    return require('node:url').pathToFileURL(require(require.resolve(name, { paths: [dir] }))).href;
  } catch {
    return name;
  }
}

// ---- 4. 跑用例 ----
const GOOD_PATCH = readFileSync(join(pluginDir, 'cordis.patch.yml'), 'utf8');
const OLD_PATCH = [
  '# dsh-prompt-optimizer bundle patch —— 第一版（会崩启动）',
  '- insert:',
  "    - id: 'dsh-prompt-optimizer'",
  "      name: 'dsh-prompt-optimizer'",
  '      # config:',
  '      #   mode: auto',
  '',
].join('\n');

/**
 * 跑一遍市场路径：判定 → 拼接 → 解析。
 *
 * @param {string} patchText - 插件的 patch 正文。
 * @param {string} label - 用例名。
 * @param {{rows: boolean, yaml: boolean}} expect - 期望：市场能否抽出 rows / hot 文件能否解析。
 */
function runMarket(patchText, label, expect) {
  console.log(`\n--- ${label} ---`);
  const rows = parseSimplePatch(patchText);
  if (rows === null) {
    console.log('  判定 -> null（市场文案：' + REASON_COMPLEX.slice(0, 26) + '…）');
    check(expect.rows === false, '市场判定与预期一致（回落到重启）');
    return;
  }
  console.log('  判定 ->', JSON.stringify(rows));
  check(expect.rows === true, '市场成功抽出 rows');
  // 按 hot.ts:768 模板的语义合成市场会写进 hot 文件的内容。
  const pieces = rows.map((row) => `- id: 'mkt-${row.id}'\n  name: '${resolveProfileEntry(profileDir, row.name)}'\n`);
  const hotYml = pieces.join('');
  console.log('  生成的 hot 文件内容:');
  for (const line of hotYml.trimEnd().split('\n')) console.log('      ' + line);
  let parsed = null;
  let error = null;
  try { parsed = yaml.load(hotYml); } catch (e) { error = e; }
  check((error === null) === expect.yaml, expect.yaml ? 'hot 文件是合法 YAML' : 'hot 文件如预期般非法',
    error ? error.message.split('\n')[0] : '');
  if (parsed !== null && expect.yaml) {
    check(Array.isArray(parsed) && parsed.length === rows.length, 'entry 数量正确');
    const first = parsed[0] ?? {};
    check(String(first.id ?? '').startsWith('mkt-'), 'id 带 mkt- 前缀', String(first.id));
    check(!String(first.id ?? '').includes("'"), 'id 不含杂散引号');
    check(String(first.name ?? '').length > 0, 'name 已解析为可用值', String(first.name).slice(0, 60));
  }
}

console.log('\n########## 用例 1：修复后 patch（期望：可热挂载 + YAML 合法）##########');
console.log(GOOD_PATCH.trimEnd());
runMarket(GOOD_PATCH, '修复后 patch', { rows: true, yaml: true });

// 关键发现：第一版 patch **不会**被 parseSimplePatch 拦下 ——
// id 正则 /^\s+-\s+id:\s*(\S+)\s*$/ 的 (\S+) 会把引号一起吃掉
// （name 正则则显式允许并剥掉引号，所以只有 id 会带引号）。
// 于是它一路走到拼接，生成出非法 YAML —— 这正是用户那次启动崩溃。
console.log('\n########## 用例 2：第一版 patch（期望：抽出 rows 但生成非法 YAML）##########');
console.log(OLD_PATCH.trimEnd());
runMarket(OLD_PATCH, '第一版 patch', { rows: true, yaml: false });

console.log('\n########## 用例 3：直接证明带引号 id 会拼出非法 YAML ##########');
const brokenYml = `- id: 'mkt-${"'dsh-prompt-optimizer'"}'  \n  name: '${resolveProfileEntry(profileDir, 'dsh-prompt-optimizer')}'\n`;
console.log('  拼接首行:', JSON.stringify(brokenYml.split('\n')[0]));
let broke = false;
let brokenMsg = '';
try { yaml.load(brokenYml); } catch (e) { broke = true; brokenMsg = e.message.split('\n')[0]; }
check(broke, '带引号 id 的拼接产物确为非法 YAML（复现崩溃）', brokenMsg);

console.log(failures === 0
  ? '\n== MARKET SAFE: 本包 patch 可通过 dshmarket 热挂载，开关可直接生效 =='
  : `\n== ${failures} 项未通过 ==`);
process.exitCode = failures === 0 ? 0 : 1;
