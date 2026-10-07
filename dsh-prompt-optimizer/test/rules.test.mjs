/**
 * 本地规则引擎的行为测试。
 *
 * 只依赖 node:test / node:assert，零第三方依赖，可直接 `node --test` 或 `npm test`。
 * 覆盖：语言探测、受保护片段保留（代码/变量/URL/公式）、九段骨架完整性、
 * 三段式输出格式（优化后的提示词 / 主要优化点 / 使用建议）、
 * 事实依赖段的「只标注不编造」、短输入扩展、超长输入截断。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CANONICAL_SECTIONS,
  MAX_INPUT_CHARS,
  SHORT_INPUT_THRESHOLD,
  classifyUnit,
  detectLanguage,
  extractProtectedSpans,
  extractSubject,
  normalizeText,
  optimizeLocally,
  splitUnits,
  stripSectionLabel,
} from '../lib/rules.js';

test('normalizeText 统一换行、去掉控制字符、收敛空行', () => {
  assert.equal(normalizeText('a\r\nb'), 'a\nb');
  assert.equal(normalizeText('a\rb'), 'a\nb');
  assert.equal(normalizeText('a\u0000b'), 'ab');
  assert.equal(normalizeText('a\n\n\n\n\nb'), 'a\n\n\nb');
  assert.equal(normalizeText('a   \nb'), 'a\nb');
  assert.equal(normalizeText(null), '');
  assert.equal(normalizeText(undefined), '');
  assert.equal(normalizeText(42), '');
});

test('detectLanguage 区分中英文', () => {
  assert.equal(detectLanguage('帮我写一个排序函数'), 'zh');
  assert.equal(detectLanguage('Write me a sorting function'), 'en');
  assert.equal(detectLanguage('把这段 JSON 转成 CSV'), 'zh');
  assert.equal(detectLanguage(''), 'en');
  assert.equal(detectLanguage('??'), 'en');
});

test('extractProtectedSpans 抓住代码块、行内代码、URL 与路径', () => {
  const input = [
    '修复这个函数：',
    '```js',
    'const a = 1;',
    '```',
    '参考 `useDraft` 钩子与 https://example.com/docs',
    '以及 D:\\Codex-workspace\\src\\a.ts',
  ].join('\n');
  const { spans, fences } = extractProtectedSpans(input);
  assert.equal(fences.length, 1);
  assert.ok(spans.some((s) => s.includes('const a = 1;')));
  assert.ok(spans.includes('`useDraft`'));
  assert.ok(spans.includes('https://example.com/docs'));
  assert.ok(spans.some((s) => s.includes('Codex-workspace')));
});

test('splitUnits 不切断围栏代码块', () => {
  const units = splitUnits(['先做 A。', '```js', 'x();', 'y();', '```', '再做 B。'].join('\n'));
  const fence = units.find((u) => u.startsWith('```'));
  assert.ok(fence !== undefined, '代码块应作为一个整体单元');
  assert.ok(fence.includes('x();') && fence.includes('y();'));
  assert.ok(units.includes('先做 A。'));
  assert.ok(units.includes('再做 B。'));
});

test('classifyUnit 按关键词归类', () => {
  assert.equal(classifyUnit('背景：我们用的是 Node 20'), 'background');
  assert.equal(classifyUnit('不要使用 any 类型'), 'constraints');
  assert.equal(classifyUnit('例如输入 1 输出 2'), 'example', '「例如」优先级必须高于「输出」');
  assert.equal(classifyUnit('验收标准：单测全绿'), 'acceptance');
  assert.equal(classifyUnit('步骤：先解析再渲染'), 'steps');
  assert.equal(classifyUnit('请用 JSON 输出'), 'output');
  assert.equal(classifyUnit('需要支持批量导入'), 'requirements');
  assert.equal(classifyUnit('帮我写个爬虫'), 'goal');
});

test('stripSectionLabel 去掉段落标签，避免与标题重复', () => {
  assert.equal(stripSectionLabel('验收标准：能跑通 10 万行'), '能跑通 10 万行');
  assert.equal(stripSectionLabel('背景：我们用的是 Node 20'), '我们用的是 Node 20');
  assert.equal(stripSectionLabel('Constraints: no pandas'), 'no pandas');
  assert.equal(stripSectionLabel('没有标签的一句话'), '没有标签的一句话');
});

test('optimizeLocally 严格按标准输出三段式', () => {
  const result = optimizeLocally('帮我写一个 Python 脚本，读取 CSV 并统计每列缺失率。不要用 pandas。验收标准：能跑通 10 万行。');
  assert.equal(result.ok, true);
  assert.equal(result.lang, 'zh');
  assert.equal(result.engine, 'rules');

  // 三段式外壳（标准里写死的标题）
  assert.match(result.text, /^## 优化后的提示词$/m);
  assert.match(result.text, /^## 主要优化点$/m);
  assert.match(result.text, /^## 使用建议$/m);
  const order = ['## 优化后的提示词', '## 主要优化点', '## 使用建议'].map((h) => result.text.indexOf(h));
  assert.deepEqual([...order].sort((a, b) => a - b), order, '三段顺序不可乱');

  // 九段骨架齐备；「示例」原文没给就不该出现
  for (const key of CANONICAL_SECTIONS) {
    assert.ok(result.sections.some((section) => section.key === key), `缺少段落 ${key}`);
  }
  assert.equal(result.sections.some((s) => s.key === 'example'), false, '原文没给示例就不该造一个');

  // 保真：约束/验收标准/专有名词原样保留，且段内不再重复标签
  assert.ok(result.optimized.includes('不要用 pandas'));
  assert.ok(result.optimized.includes('能跑通 10 万行'));
  assert.equal(result.optimized.includes('验收标准：能跑通'), false, '段标题已说明，正文不该再带标签');
  assert.ok(result.optimized.includes('Python'));

  // 事实依赖段缺失时只标注、不编造
  assert.ok(result.gaps.includes('背景'));
  assert.ok(result.optimized.includes('原文未提供'));
  assert.ok(result.optimized.includes('请先向我提问'), '有缺口时应带「先提问」指令');

  // optimized 是纯提示词本体，不含三段式外壳；本体用三级标题
  assert.equal(result.optimized.includes('## 主要优化点'), false);
  assert.equal(result.optimized.startsWith('### '), true);
});

test('optimizeLocally 保留代码块与专有名词原样', () => {
  const code = '```ts\nconst x: number = 1;\n```';
  const result = optimizeLocally(`重构这段代码，保持 API 签名不变：\n${code}\n必须兼容 useDraft 钩子。`);
  assert.ok(result.text.includes('const x: number = 1;'), '代码块必须逐字保留');
  assert.ok(result.text.includes('useDraft'), '专有名词必须保留');
  assert.ok(result.preserved.some((s) => s.includes('const x: number = 1;')));
});

test('optimizeLocally 短输入给出扩展说明且不编造事实', () => {
  const result = optimizeLocally('写个登录页');
  assert.ok(result.notes.some((note) => note.includes('很短')));
  assert.ok(result.gaps.length > 0, '短输入应报告需要用户补充的段落');
  // 不得凭空出现原文没有的技术选型
  for (const invented of ['React', 'Vue', 'Django', 'MySQL', 'JWT']) {
    assert.ok(!result.text.includes(invented), `不应编造事实：${invented}`);
  }
});

test('optimizeLocally 空输入不抛异常', () => {
  const result = optimizeLocally('');
  assert.equal(result.ok, true);
  assert.equal(typeof result.text, 'string');
  assert.ok(result.text.length > 0);
});

test('optimizeLocally 英文输入走英文骨架', () => {
  const result = optimizeLocally('Write a function that parses CSV files. Do not use pandas. Acceptance: handles 100k rows.');
  assert.equal(result.lang, 'en');
  assert.match(result.text, /^## Optimized prompt$/m);
  assert.match(result.text, /^## Key changes$/m);
  assert.match(result.text, /^## How to use$/m);
  assert.ok(result.sections.some((section) => section.title === 'Acceptance criteria'));
  assert.ok(result.optimized.includes('Do not use pandas'));
});

test('optimizeLocally 超长输入截断并告知', () => {
  // 纯 ASCII 输入会被判为英文，因此提示文案也是英文；断言与语言无关的事实。
  const result = optimizeLocally('x'.repeat(MAX_INPUT_CHARS + 500));
  assert.equal(result.truncated, true);
  assert.ok(result.notes.some((note) => /truncated/i.test(note)), '主要优化点里要说明截断');
  assert.ok(result.text.includes('## How to use'), '截断建议落在使用建议里');

  // 中文超长输入必须给中文提示（7 字 × 4000 = 28000 字符 > 上限）。
  const zh = optimizeLocally('需要处理的文本。'.repeat(4000));
  assert.equal(zh.truncated, true);
  assert.ok(zh.notes.some((note) => note.includes('截断')));
});

test('optimizeLocally 可关闭占位骨架', () => {
  const result = optimizeLocally('写个登录页', { includeSkeletonExtras: false });
  assert.equal(result.sections.some((section) => section.key === 'example'), false);
});

test('optimizeLocally 输出可被再次优化且不崩溃（幂等性下限）', () => {
  const once = optimizeLocally('把这段 JSON 转成 CSV，必须保留表头顺序。');
  const twice = optimizeLocally(once.text);
  assert.equal(twice.ok, true);
  assert.ok(twice.text.includes('表头顺序'));
});

test('extractSubject 收敛到短语且不返回空', () => {
  assert.ok(extractSubject('帮我写一个 Python 脚本，读取 CSV。', 'zh').length > 0);
  assert.ok(extractSubject('', 'zh').length > 0);
  assert.ok(extractSubject('', 'en').length > 0);
  const long = extractSubject('x'.repeat(500), 'en');
  assert.ok(long.length <= 81, `主题应被裁剪，实际 ${long.length}`);
});

test('SHORT_INPUT_THRESHOLD 是正数常量', () => {
  assert.ok(Number.isFinite(SHORT_INPUT_THRESHOLD) && SHORT_INPUT_THRESHOLD > 0);
});
