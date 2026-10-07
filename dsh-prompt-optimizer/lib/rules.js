/**
 * dsh-prompt-optimizer —— 共享本地规则优化引擎。
 *
 * ## 优化标准（本项目唯一权威口径）
 * 本文件与 `prompt/optimizer-system.md` 共同实现同一套标准：
 *
 *   优化原则：
 *     1. 保留用户原始意图，不改变核心需求。
 *     2. 不编造用户没有提供的事实、数据或背景。
 *     3. 自动补全必要结构：角色、目标、背景、任务、要求、约束、步骤、输出格式、验收标准。
 *     4. 原文太短可合理扩展，但必须保持原意。
 *     5. 代码、变量、专有名词、URL、公式必须原样保留。
 *     6. 信息不足不要胡乱假设 —— 写成「如信息不足，请先提问」或显式标注。
 *     7. 支持中英文，默认与原文同语言输出。
 *     8. 优化后要具体、可执行、少歧义，适合直接交给大模型使用。
 *
 *   输出格式（严格三段）：
 *     ## 优化后的提示词
 *     ## 主要优化点
 *     ## 使用建议
 *
 * ## 为什么是「共享」的
 * dsh 的 Client 半运行在浏览器里，其 `require` 只能解析已注册的包，不能 require
 * 同包的兄弟文件，所以 Client 半必须是单文件自包含 bundle。本文件因此被
 * build/build-client.mjs 的 `//#region rules` 标记整段内联进 src/client.main.js，
 * 再由 lib/client.js 输出；Host 半则直接 import。两边**字面同一份代码**。
 *
 * ## 约束
 * 纯函数、零依赖、零 IO、不触碰 window / document / process / node:*。
 * 不使用 Unicode 属性转义（\p{...}），以免宿主 JS 引擎版本差异影响解析。
 *
 * @module dsh-prompt-optimizer/rules
 */

//#region rules

/**
 * 优化后提示词的骨架顺序（对应标准里的 9 项）。
 * 其中 `background` / `requirements` / `constraints` 属于**事实依赖段**：
 * 原文没给就不编造，只标注待补。
 */
export const CANONICAL_SECTIONS = Object.freeze([
  'role',
  'goal',
  'background',
  'task',
  'requirements',
  'constraints',
  'steps',
  'output',
  'acceptance',
]);

/** 事实依赖段：没有原文依据时只标注「原文未提供」，绝不生成看似具体的内容。 */
export const FACT_DEPENDENT_SECTIONS = Object.freeze(['background', 'requirements', 'constraints']);

/** 每一段的中英文标题。 */
export const SECTION_TITLES = Object.freeze({
  role: Object.freeze({ zh: '角色', en: 'Role' }),
  goal: Object.freeze({ zh: '目标', en: 'Goal' }),
  background: Object.freeze({ zh: '背景', en: 'Context' }),
  task: Object.freeze({ zh: '任务', en: 'Task' }),
  requirements: Object.freeze({ zh: '要求', en: 'Requirements' }),
  constraints: Object.freeze({ zh: '约束', en: 'Constraints' }),
  steps: Object.freeze({ zh: '步骤', en: 'Steps' }),
  output: Object.freeze({ zh: '输出格式', en: 'Output format' }),
  example: Object.freeze({ zh: '示例', en: 'Example' }),
  acceptance: Object.freeze({ zh: '验收标准', en: 'Acceptance criteria' }),
});

/** 三段式输出的固定标题（与标准一致，中英各一套）。 */
export const OUTPUT_HEADINGS = Object.freeze({
  zh: Object.freeze({
    optimized: '优化后的提示词',
    notes: '主要优化点',
    advice: '使用建议',
  }),
  en: Object.freeze({
    optimized: 'Optimized prompt',
    notes: 'Key changes',
    advice: 'How to use',
  }),
});

/** 信息不足时放进提示词里的收尾指令（标准里的第 6 条原则）。 */
const INSUFFICIENT_HINT = Object.freeze({
  zh: '（若上述信息不足，请先向我提问确认，不要自行假设。）',
  en: '(If the information above is insufficient, ask me before assuming anything.)',
});

/** 事实依赖段的缺省占位说明。 */
const MISSING_MARK = Object.freeze({
  zh: '（原文未提供，未作假设；如信息不足请先提问。）',
  en: '(Not provided in the original; nothing assumed — ask first if this matters.)',
});

/**
 * 结构性默认文本。`{subject}` / `{first}` 会被替换为从原文抽取的内容。
 * 这些默认值**只声明结构与预期，不编造任何具体事实**。
 */
const SECTION_DEFAULTS = Object.freeze({
  role: Object.freeze({
    zh: '你是该领域的资深专家，熟悉这类任务的常见做法、边界条件与失败模式，并能主动指出需求中的歧义与风险。',
    en: 'You are a senior expert in this domain, familiar with common practice, edge cases and failure modes, and proactive about flagging ambiguity and risk.',
  }),
  goal: Object.freeze({
    zh: '交付可直接使用、无需返工的 {subject} 成果。',
    en: 'Deliver a ready-to-use {subject} result that needs no rework.',
  }),
  task: Object.freeze({
    zh: '围绕「{subject}」完成下列工作：\n1. {first}\n2. （按需补充剩余要点）',
    en: 'For "{subject}", carry out the following:\n1. {first}\n2. (add the remaining points as needed)',
  }),
  steps: Object.freeze({
    zh: '1. 复述需求与不确定点；\n2. 给出方案与取舍理由；\n3. 实现；\n4. 自检并给出验证方式。',
    en: '1. Restate the request and the open questions;\n2. Present the approach with trade-offs;\n3. Implement;\n4. Self-check and give a way to verify.',
  }),
  output: Object.freeze({
    zh: '用 Markdown 输出：先给结论或可用产物，再给必要说明；代码用带语言标注的围栏代码块并保持可运行。',
    en: 'Answer in Markdown: conclusion or usable artifact first, then the necessary explanation; put code in fenced blocks with a language tag and keep it runnable.',
  }),
  acceptance: Object.freeze({
    zh: '逐条给出可客观判定的验收标准，每条都能用「是/否」或具体数值回答。',
    en: 'List objectively checkable acceptance criteria, each answerable with yes/no or a concrete number.',
  }),
});

/** 分类关键词。数组顺序即优先级；`goal` 为兜底。 */
const CATEGORY_KEYWORDS = Object.freeze({
  acceptance: Object.freeze([
    '验收', '通过条件', '完成定义', '测试通过', '验收标准',
    'acceptance', 'definition of done', 'must pass', 'test pass',
  ]),
  output: Object.freeze([
    '输出', '格式', '返回', '写成', '用 json', '用 markdown', '表格输出',
    'output', 'format', 'as json', 'as markdown', 'output format',
  ]),
  steps: Object.freeze([
    '步骤', '流程', '第一步', '先做', '然后再', '接着', '最后',
    'step by step', 'steps', 'workflow', 'procedure', 'first,', 'then,',
  ]),
  requirements: Object.freeze([
    '要求', '需求', '支持', '包含', '包括', '需要实现', '应支持', '功能',
    'requirement', 'requirements', 'should support', 'must support', 'needs to include', 'feature',
  ]),
  constraints: Object.freeze([
    '不要', '禁止', '不得', '不能', '只能', '必须', '限制', '约束', '保持', '兼容',
    'do not', "don't", 'must not', 'never', 'only', 'limit', 'constraint', 'keep', 'compatib', 'performance',
  ]),
  background: Object.freeze([
    '背景', '场景', '现状', '目前', '现在', '因为', '由于', '目的是', '我们公司', '我们的项目',
    'background', 'scenario', 'currently', 'we are', 'our project', 'because', 'since',
  ]),
  example: Object.freeze([
    '例如', '比如', '示例', '举例', 'for example', 'for instance', 'e.g.', 'such as',
  ]),
  goal: Object.freeze([
    '目标', '希望', '想要', '帮我', '请', '我要', '需要',
    'goal', 'i want', 'i need', 'help me', 'please', 'objective',
  ]),
});

/** 判定「太短」的阈值（去空白后的字符数）。 */
export const SHORT_INPUT_THRESHOLD = 12;

/** 判定「很长」的阈值（字符数），超过则在使用建议里提示。 */
export const LONG_INPUT_THRESHOLD = 12000;

/** 单次优化允许处理的最大正文字符数（超出会被截断并告知）。 */
export const MAX_INPUT_CHARS = 20000;

/**
 * 归一化换行与空白，但保留段落分隔，避免破坏代码块与列表缩进。
 * @param {string} text - 原始文本。
 * @returns {string} 归一化结果。
 */
export function normalizeText(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

/**
 * 探测提示词主体语言。
 * @param {string} text - 任意文本。
 * @returns {'zh'|'en'} 语言标记。
 */
export function detectLanguage(text) {
  const source = typeof text === 'string' ? text : '';
  const han = (source.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) ?? []).length;
  const latin = (source.match(/[A-Za-z]/g) ?? []).length;
  if (han === 0 && latin === 0) return 'en';
  return han >= 4 || han >= latin / 4 ? 'zh' : 'en';
}

/**
 * 抽取文中需要原样保留的片段：围栏代码块、行内代码、URL、文件路径、公式。
 *
 * 对应标准第 5 条：代码、变量、专有名词、URL、公式必须原样保留。
 *
 * @param {string} text - 原始文本。
 * @returns {{spans: string[], fences: string[], formulas: string[]}} 受保护片段。
 */
export function extractProtectedSpans(text) {
  const source = typeof text === 'string' ? text : '';
  const fences = source.match(/```[\s\S]*?```|~~~[\s\S]*?~~~/g) ?? [];
  const inline = source.match(/`[^`\n]+`/g) ?? [];
  const urls = source.match(/\bhttps?:\/\/[^\s)>\]}"']+/g) ?? [];
  const paths = source.match(/(?:[A-Za-z]:\\[^\s"'<>|]+|\/(?:[\w.-]+\/)+[\w.-]+)/g) ?? [];
  // 行间公式 $$...$$、块内 $...$、LaTeX 常见命令
  const formulas = source.match(/\$\$[\s\S]*?\$\$|\$[^$\n]+\$|\\\[[\s\S]*?\\\]|\\[a-zA-Z]+(?:\{[^}]*\})*/g) ?? [];
  const spans = [...new Set([...fences, ...inline, ...urls, ...paths, ...formulas])];
  return { spans, fences, formulas };
}

/**
 * 判断一行是否应当原样保留（代码、列表、引用、纯路径等）。
 * @param {string} line - 单行文本。
 * @returns {boolean} 是否原样保留。
 */
function isProtectedLine(line) {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  if (/^(?:```|~~~)/.test(trimmed)) return true;
  if (/^(?:`[^`]+`|[A-Za-z]:\\|\/|https?:\/\/)/.test(trimmed) && !/[\u4e00-\u9fff]/.test(trimmed)) return true;
  if (/^[|>#*+-]\s/.test(trimmed)) return true;
  return false;
}

/**
 * 把原文切分为可归类的最小单元：先按行，再按中英文句读切句。
 * @param {string} text - 归一化后的文本。
 * @returns {string[]} 单元列表（已去空、保序）。
 */
export function splitUnits(text) {
  const source = typeof text === 'string' ? text : '';
  const units = [];
  const lines = source.split('\n');
  let fenceBuffer = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(?:```|~~~)/.test(trimmed)) {
      if (fenceBuffer === null) fenceBuffer = [line];
      else {
        fenceBuffer.push(line);
        units.push(fenceBuffer.join('\n'));
        fenceBuffer = null;
      }
      continue;
    }
    if (fenceBuffer !== null) {
      fenceBuffer.push(line);
      continue;
    }
    if (trimmed.length === 0) continue;
    if (isProtectedLine(line)) {
      units.push(trimmed);
      continue;
    }
    const parts = trimmed.split(/(?<=[。！？；!?;])\s*|(?<=[.!?])\s+(?=[A-Z0-9])/);
    for (const part of parts) {
      const value = part.trim();
      if (value.length > 0) units.push(value);
    }
  }
  if (fenceBuffer !== null && fenceBuffer.length > 0) units.push(fenceBuffer.join('\n'));
  return units;
}

/**
 * 按要求把一句话归入骨架中的一段。
 * @param {string} unit - 单个文本单元。
 * @returns {string} 段落键。
 */
export function classifyUnit(unit) {
  const lower = String(unit ?? '').toLowerCase();
  // `example` 必须最先判：『例如输入 1 输出 2』同时含「输出」，
  // 若先判 output 就会被误归为「输出格式」。
  for (const key of ['example', 'acceptance', 'output', 'steps', 'requirements', 'constraints', 'background']) {
    for (const word of CATEGORY_KEYWORDS[key]) {
      if (lower.includes(word)) return key;
    }
  }
  return 'goal';
}

/**
 * 去掉单元开头的段落标签（「验收标准：」「背景:」等）。
 *
 * 分类时标签是有用信号，但正文里再写一遍就成了重复 ——
 * 段落标题已经说明了它是什么，例如「### 验收标准」下面是
 * 「验收标准：能跑通 10 万行」就很啰嗦。
 *
 * @param {string} unit - 原始单元。
 * @returns {string} 去掉标签后的正文。
 */
export function stripSectionLabel(unit) {
  const source = String(unit ?? '');
  const labels = [
    '角色', '目标', '背景', '任务', '要求', '需求', '约束', '步骤', '输出格式', '输出', '示例', '验收标准', '验收',
    'role', 'goal', 'objective', 'context', 'background', 'task', 'requirements', 'requirement',
    'constraints', 'constraint', 'steps', 'output format', 'output', 'example', 'acceptance criteria', 'acceptance',
  ];
  const escaped = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp(`^\\s*(?:${escaped})\\s*[:：]\\s*`, 'i');
  const stripped = source.replace(re, '').trim();
  return stripped.length > 0 ? stripped : source;
}

/**
 * 抽取一个简短的主题短语，用于填充骨架里的 {subject}。
 * @param {string} text - 原始文本。
 * @param {'zh'|'en'} lang - 语言标记。
 * @returns {string} 主题短语。
 */
export function extractSubject(text, lang) {
  const source = normalizeText(text);
  const firstLine = source.split('\n').find((line) => line.trim().length > 0 && !isProtectedLine(line));
  const base = (firstLine ?? source).trim();
  const clipped = base.split(/[。！？；!?;\n]/)[0]?.trim() ?? base;
  const limit = lang === 'zh' ? 40 : 80;
  const cut = clipped.length > limit ? `${clipped.slice(0, limit)}…` : clipped;
  return cut.replace(/^[#>\-*\s]+/, '').replace(/[。．.,;；:：]+$/, '').trim() || (lang === 'zh' ? '该任务' : 'the task');
}

/**
 * 取主题的短形态，用于「角色」这类内联短语的位置。
 * 整句塞进去会读成「熟悉 帮我写一个 Python 脚本，读取 CSV… 的常见做法」，很拗口。
 *
 * @param {string} subject - extractSubject 的结果。
 * @param {'zh'|'en'} lang - 语言标记。
 * @returns {string} 短语化主题。
 */
export function shortenSubject(subject, lang) {
  const source = String(subject ?? '').trim();
  if (source.length === 0) return lang === 'zh' ? '该任务' : 'the task';
  const limit = lang === 'zh' ? 14 : 28;
  if (source.length <= limit) return source;
  // 优先在第一个标点/空格处断开
  const head = source.slice(0, limit);
  const cut = head.search(/[，,、\s（(]/);
  return `${cut > 3 ? head.slice(0, cut) : head}…`;
}

/**
 * 本地规则优化：把提示词重排为九段骨架，并按标准输出三段式结果。
 *
 * 它不调用任何模型，因此离线可用；但它**不会新增用户没给的事实** ——
 * 事实依赖段（背景/要求/约束）缺失时只标注，并在「使用建议」里列出。
 *
 * @param {string} rawInput - 用户输入框中的原始提示词。
 * @param {object} [options] - 可选项。
 * @param {'zh'|'en'} [options.lang] - 强制语言；缺省自动探测。
 * @param {boolean} [options.includeSkeletonExtras] - 是否输出缺失段的占位（默认 true）。
 * @returns {{
 *   ok: true, text: string, lang: 'zh'|'en', engine: 'rules',
 *   gaps: string[], preserved: string[], truncated: boolean, notes: string[],
 *   sections: Array<{key: string, title: string, body: string, placeholder: boolean}>,
 *   optimized: string
 * }} 优化结果；`optimized` 是纯提示词正文，`text` 是含三段式外壳的完整输出。
 */
export function optimizeLocally(rawInput, options = {}) {
  /** 「使用建议」里的补充提示（截断、扩展等）。 */
  const adviceExtras = [];
  const normalized = normalizeText(rawInput);
  const lang = options.lang === 'zh' || options.lang === 'en' ? options.lang : detectLanguage(normalized);
  const includeExtras = options.includeSkeletonExtras !== false;
  const heading = OUTPUT_HEADINGS[lang];
  const t = (key) => SECTION_TITLES[key][lang];

  let source = normalized;
  let truncated = false;
  if (source.length > MAX_INPUT_CHARS) {
    source = source.slice(0, MAX_INPUT_CHARS);
    truncated = true;
    adviceExtras.push(
      lang === 'zh'
        ? `原文超过 ${MAX_INPUT_CHARS} 字符，已截断后优化；截断部分未参与重组，建议分段处理。`
        : `The input exceeded ${MAX_INPUT_CHARS} characters and was truncated before restructuring; consider splitting it.`,
    );
  }

  const { spans } = extractProtectedSpans(source);
  const units = splitUnits(source);
  const subject = extractSubject(source, lang);
  const subjectShort = shortenSubject(subject, lang);

  /** @type {Record<string, string[]>} */
  const buckets = {
    role: [], goal: [], background: [], task: [], requirements: [],
    constraints: [], steps: [], output: [], example: [], acceptance: [],
  };
  for (const unit of units) {
    // 先用**带标签的原文**分类（标签本身是强信号），再剥掉标签作为正文。
    const key = classifyUnit(unit);
    const body = stripSectionLabel(unit);
    if (key === 'goal' && buckets.goal.length === 0) {
      // 第一句自由文本通常是真·目标，先占住 goal；其余归 task。
      buckets.goal.push(body);
    } else if (key === 'goal') {
      buckets.task.push(body);
    } else {
      buckets[key].push(body);
    }
  }
  if (buckets.goal.length === 0 && buckets.task.length > 0) buckets.goal.push(buckets.task.shift());

  // 去重：任务段里与目标逐字相同的句子不必再写一遍。
  const goalSet = new Set(buckets.goal.map((g) => g.trim()));
  buckets.task = buckets.task.filter((item) => !goalSet.has(item.trim()));

  const charCount = normalized.replace(/\s+/g, '').length;
  const shortInput = charCount < SHORT_INPUT_THRESHOLD;

  /** @type {Array<{key: string, title: string, body: string, placeholder: boolean}>} */
  const sections = [];
  for (const key of CANONICAL_SECTIONS) {
    const collected = buckets[key].filter((unit) => unit.trim().length > 0).join('\n');
    let body = collected;
    let placeholder = false;

    if (key === 'task' && body.length === 0) {
      // 任务段的正文若与目标重复已被剔除，这里给一条不重复目标的执行指令。
      body = lang === 'zh'
        ? `围绕「${subject}」执行上述目标；开始前先列出你理解的要点与不确定处。`
        : `Carry out the goal above for "${subject}"; list your understanding and open questions first.`;
    }

    if (body.length === 0 && FACT_DEPENDENT_SECTIONS.includes(key)) {
      // 事实依赖段：宁可标注，也不编造。
      body = MISSING_MARK[lang];
      placeholder = true;
    } else if (body.length === 0 && includeExtras && SECTION_DEFAULTS[key] !== undefined) {
      // 「角色」用短语化主题，避免把整句需求内联进去。
      body = SECTION_DEFAULTS[key][lang].replace(/\{subject\}/g, key === 'role' ? subjectShort : subject);
    }

    if (body.length === 0) continue;
    sections.push({ key, title: t(key), body, placeholder });
  }
  // 示例段只在原文真的给了例子时出现，绝不占位。
  if (buckets.example.length > 0) {
    sections.push({ key: 'example', title: t('example'), body: buckets.example.join('\n'), placeholder: false });
  }

  const gaps = sections.filter((section) => section.placeholder).map((section) => section.title);

  // ---- 组装纯提示词正文 ----
  const bodyText = sections.map((section) => `### ${section.title}\n${section.body}`).join('\n\n');
  const optimized = gaps.length > 0 ? `${bodyText}\n\n${INSUFFICIENT_HINT[lang]}` : bodyText;

  // ---- 主要优化点：只写**确实发生过**的事 ----
  const notes = [];
  const filledKeys = sections.filter((s) => !s.placeholder && s.key !== 'example').map((s) => s.title);
  const defaultedKeys = sections
    .filter((s) => !s.placeholder && SECTION_DEFAULTS[s.key] !== undefined && buckets[s.key].length === 0)
    .map((s) => s.title);

  notes.push(
    lang === 'zh'
      ? `按标准九段骨架重组：原文内容已归入 ${filledKeys.length} 段（${filledKeys.join('、')}）。`
      : `Restructured into the standard skeleton: original content filed into ${filledKeys.length} sections (${filledKeys.join(', ')}).`,
  );
  if (defaultedKeys.length > 0) {
    notes.push(
      lang === 'zh'
        ? `自动补全必要结构：${defaultedKeys.join('、')} —— 只补结构与预期，未新增任何事实。`
        : `Filled in required structure: ${defaultedKeys.join(', ')} — structure and expectations only, no invented facts.`,
    );
  }
  if (spans.length > 0) {
    notes.push(
      lang === 'zh'
        ? `原样保留 ${spans.length} 处代码/变量/URL/路径/公式，未改写、未翻译。`
        : `Kept ${spans.length} code/variable/URL/path/formula span(s) byte-for-byte, untranslated.`,
    );
  }
  if (gaps.length > 0) {
    notes.push(
      lang === 'zh'
        ? `标注 ${gaps.length} 处原文未提供的信息（${gaps.join('、')}），未作假设。`
        : `Marked ${gaps.length} item(s) absent from the original (${gaps.join(', ')}); nothing assumed.`,
    );
  }
  notes.push(
    lang === 'zh'
      ? `去除了重复与模糊表述；输出语言保持为${lang === 'zh' ? '中文' : '英文'}。`
      : 'Removed duplicated and vague wording; output language kept as English.',
  );
  notes.push(
    lang === 'zh'
      ? `篇幅：原文 ${charCount} 字 → 优化后 ${optimized.replace(/\s+/g, '').length} 字。`
      : `Length: ${charCount} chars → ${optimized.replace(/\s+/g, '').length} chars after optimization.`,
  );
  if (shortInput) {
    notes.push(
      lang === 'zh'
        ? '原文很短，已按最小可用骨架扩展；扩展内容仅为结构与预期。'
        : 'The input was very short; expanded into a minimal usable skeleton containing structure only.',
    );
  }
  if (truncated) {
    notes.push(lang === 'zh' ? '原文超长，已截断后再优化。' : 'The input was truncated before optimization.');
  }

  // 「示例」段只在原文真的给了例子时出现，也不该漏报。
  if (buckets.example.length > 0) {
    notes.push(
      lang === 'zh'
        ? `保留了原文提供的 ${buckets.example.length} 条示例，未新增样例。`
        : `Kept the ${buckets.example.length} example(s) the original provided; none were invented.`,
    );
  }

  // ---- 使用建议 ----
  const advice = [];
  advice.push(
    lang === 'zh'
      ? '把上面「优化后的提示词」整段复制给大模型即可；它已包含执行所需的全部结构。'
      : 'Copy the whole "Optimized prompt" block to your model — it carries every structure the task needs.',
  );
  if (gaps.length > 0) {
    advice.push(
      lang === 'zh'
        ? `其中 ${gaps.join('、')} 标注了「原文未提供」：若这些信息影响结果，请先补上（或直接让模型先提问）。`
        : `${gaps.join(', ')} are marked "not provided": fill them in first if they matter, or let the model ask.`,
    );
  } else {
    advice.push(
      lang === 'zh'
        ? '九段信息齐全，可直接执行；如需更严格的控制，可再补充示例或边界样例。'
        : 'All nine sections are populated — ready to run. Add examples or edge cases for tighter control.',
    );
  }
  advice.push(
    lang === 'zh'
      ? '本次由本地规则引擎完成（无需联网、不调用模型）：它只做结构重排与标注，不会替你做创作性改写。'
      : 'Produced by the local rule engine (offline, no model call): it restructures and annotates only — it never rewrites creatively.',
  );
  advice.push(...adviceExtras);

  const rendered = [
    `## ${heading.optimized}`,
    '',
    optimized,
    '',
    `## ${heading.notes}`,
    '',
    ...notes.map((note) => `- ${note}`),
    '',
    `## ${heading.advice}`,
    '',
    ...advice.map((item) => `- ${item}`),
  ].join('\n');

  return {
    ok: true,
    lang,
    engine: 'rules',
    text: rendered,
    optimized,
    gaps,
    preserved: spans,
    truncated,
    notes,
    sections,
  };
}

//#endregion rules
