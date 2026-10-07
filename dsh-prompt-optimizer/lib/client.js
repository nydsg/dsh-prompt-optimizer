/**
 * dsh-prompt-optimizer —— Client 半（自包含 bundle）。
 *
 * ⚠️ 本文件由 build/build-client.mjs 从 src/client.main.js + lib/rules.js 生成，
 *    请勿手工编辑；改源文件后重新执行 `node build/build-client.mjs`。
 *
 * 内联规则引擎与 lib/rules.js 是**同一份代码**，因此模型不可用时
 * 可以完全离线地把提示词重排为九段骨架。
 *
 * ## 加载契约（照抄官方/社区插件的实际形态）
 *
 * 浏览器把 client bundle 当**普通 script** 加载（多个插件还会被拼成一个
 * combo script 一起 load），因此：
 *
 *   1. 顶层**绝不能有 return** —— 经典脚本里顶层 return 直接
 *      `SyntaxError: Illegal return statement`，而且会污染整段 combo，
 *      连累同批次其它插件；症状是 `web boot: 1 entry did not activate`
 *      +`... import failed`，整个界面起不来。
 *   2. 注册方式是调用平台提供的 `window.__ModuleLoader__.load`，
 *      并由 `factory` 的**返回值**充当本模块的 exports：
 *
 *          window.__ModuleLoader__.load({ id, factory: (require) => { ...; return module.exports } })
 *
 *      参考：dsh-ppt / @nydsg/dsh-mindmap / dshmarket 的 lib/client.js 都是这个形态。
 *
 * 这两点由 test/client.test.mjs 的「bundle 是合法经典脚本」「combo 拼接后仍合法」
 * 两组用例锁死（含把两个 bundle 首尾拼接后整体求值的回归测试）。
 *
 * 运行时依赖：
 *   factory(require) 的 require('react')  -> React 运行时（平台 seed 词）
 *   globalThis.__DSH_STYLES__             -> 包内样式插入器（缺失时降级为 <style>）
 *   ctx.slots / ctx.sessions / ctx.locale -> 由 inject 声明的服务
 */
window.__ModuleLoader__.load({ id: 'dsh-prompt-optimizer', factory: (require) => {
  'use strict';

  const module = { exports: {} };
  const exports = module.exports;

  const React = require('react');

  const styles = (() => {
    const seat = globalThis.__DSH_STYLES__;
    if (seat !== undefined && typeof seat.insert === 'function') return seat;
    // 独立加载（测试 / 非 dsh 环境）时的安全降级：注入一次 <style>。
    return {
      insert(css) {
        if (typeof document === 'undefined') return () => {};
        const tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-prompt-optimizer';
        tag.textContent = css;
        document.head.appendChild(tag);
        return () => { tag.remove(); };
      },
    };
  })();

  /** 平台内置的包标签日志；缺失时退回 console。 */
  const logger = (() => {
    const seat = globalThis.__DSH_CONSOLE__;
    return seat !== undefined && typeof seat.warn === 'function' ? seat : console;
  })();

  /**
   * 优化后提示词的骨架顺序（对应标准里的 9 项）。
   * 其中 `background` / `requirements` / `constraints` 属于**事实依赖段**：
   * 原文没给就不编造，只标注待补。
   */
  const CANONICAL_SECTIONS = Object.freeze([
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
  const FACT_DEPENDENT_SECTIONS = Object.freeze(['background', 'requirements', 'constraints']);

  /** 每一段的中英文标题。 */
  const SECTION_TITLES = Object.freeze({
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
  const OUTPUT_HEADINGS = Object.freeze({
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
  const SHORT_INPUT_THRESHOLD = 12;

  /** 判定「很长」的阈值（字符数），超过则在使用建议里提示。 */
  const LONG_INPUT_THRESHOLD = 12000;

  /** 单次优化允许处理的最大正文字符数（超出会被截断并告知）。 */
  const MAX_INPUT_CHARS = 20000;

  /**
   * 归一化换行与空白，但保留段落分隔，避免破坏代码块与列表缩进。
   * @param {string} text - 原始文本。
   * @returns {string} 归一化结果。
   */
  function normalizeText(text) {
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
  function detectLanguage(text) {
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
  function extractProtectedSpans(text) {
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
  function splitUnits(text) {
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
  function classifyUnit(unit) {
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
  function stripSectionLabel(unit) {
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
  function extractSubject(text, lang) {
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
  function shortenSubject(subject, lang) {
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
  function optimizeLocally(rawInput, options = {}) {
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

  /** 包内样式。全部使用 dsh 主题 token，明暗主题自动适配。 */
  const CSS = `
  .dpo-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 24px;
    padding: 0 8px;
    border: none;
    border-radius: var(--dsw-radius-sm, 6px);
    background: transparent;
    color: var(--dsw-alias-label-secondary);
    font: inherit;
    font-size: 12px;
    line-height: 1;
    cursor: pointer;
    white-space: nowrap;
  }
  .dpo-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); color: var(--dsw-alias-label-primary); }
  .dpo-btn:disabled { opacity: .5; cursor: default; }
  .dpo-btn[data-state="busy"] { color: var(--dsw-alias-brand-primary); }
  .dpo-btn[data-state="done"] { color: var(--dsw-alias-state-success-primary); }
  .dpo-btn[data-state="error"] { color: var(--dsw-alias-state-error-primary); }
  .dpo-btn__dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; animation: dpo-pulse 1s ease-in-out infinite; }
  @keyframes dpo-pulse { 0%,100% { opacity: 1 } 50% { opacity: .25 } }

  .dpo-panel {
    border: 1px solid var(--dsw-alias-border-l2);
    border-radius: var(--dsw-radius-md, 8px);
    background: var(--dsw-alias-bg-layer-1);
    color: var(--dsw-alias-label-primary);
    font-size: 12px;
    line-height: 1.6;
  }
  .dpo-panel__head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--dsw-alias-border-l1);
    flex-wrap: wrap;
  }
  .dpo-panel__title { font-weight: 600; }
  .dpo-panel__meta { color: var(--dsw-alias-label-secondary); }
  .dpo-panel__spacer { flex: 1 1 auto; }
  .dpo-panel__body { padding: 10px; max-height: 320px; overflow: auto; }
  .dpo-panel__foot { display: flex; gap: 6px; padding: 8px 10px; border-top: 1px solid var(--dsw-alias-border-l1); flex-wrap: wrap; }

  .dpo-note {
    margin: 0 0 8px;
    padding: 6px 8px;
    border-radius: var(--dsw-radius-sm, 6px);
    background: var(--dsw-alias-bg-layer-2);
    color: var(--dsw-alias-label-secondary);
  }
  .dpo-note[data-level="error"] { color: var(--dsw-alias-state-error-primary); }
  .dpo-note[data-level="warn"] { color: var(--dsw-alias-state-warn-primary); }

  .dpo-pre {
    margin: 0;
    padding: 10px;
    border-radius: var(--dsw-radius-sm, 6px);
    background: var(--dsw-alias-bg-layer-2);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 280px;
    overflow: auto;
  }
  .dpo-cols { display: flex; gap: 10px; flex-wrap: wrap; }
  .dpo-col { flex: 1 1 260px; min-width: 0; }
  .dpo-col__head { color: var(--dsw-alias-label-secondary); margin-bottom: 4px; font-weight: 600; }
  .dpo-ins { background: rgba(46,160,67,.22); border-radius: 2px; }
  .dpo-del { background: rgba(248,81,73,.18); border-radius: 2px; text-decoration: line-through; opacity: .8; }

  .dpo-act {
    display: inline-flex;
    align-items: center;
    height: 26px;
    padding: 0 10px;
    border: 1px solid var(--dsw-alias-border-l2);
    border-radius: var(--dsw-radius-sm, 6px);
    background: transparent;
    color: var(--dsw-alias-label-primary);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
  }
  .dpo-act:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); }
  .dpo-act:disabled { opacity: .45; cursor: default; }
  .dpo-act[data-variant="primary"] {
    background: var(--dsw-alias-brand-primary);
    border-color: var(--dsw-alias-brand-primary);
    color: #fff;
  }
  .dpo-badge {
    display: inline-flex;
    align-items: center;
    height: 18px;
    padding: 0 6px;
    border-radius: 9px;
    background: var(--dsw-alias-bg-layer-2);
    color: var(--dsw-alias-label-secondary);
    font-size: 11px;
  }
  `;

  /** 路由前缀，必须与 Host 半的 ROUTE_BASE 保持一致。 */
  const ROUTE_BASE = '/plugin-prompt-optimizer';

  /** locale 命名空间；与插槽注册的 `locale` 字段、Host 包名保持一致。 */
  const LOCALE_NS = 'dsh-prompt-optimizer';

  /** `phase` 与 `lastRef` 共用的哨兵：同一时刻只允许一次在途请求。 */
  const PENDING = { pending: true };

  /**
   * 同源调用 Host 桥。
   *
   * 刻意**不依赖宿主注入 `host` 全局**：该全局是实现细节，不同版本可能缺席。
   * 同源 fetch 永远可用，且只有本插件注册了这个路由前缀，因此不存在歧义。
   * Cookie 由浏览器自动携带 —— dsh web 的鉴权也一并满足。
   *
   * @param {string} path - 路由后缀，如 '/info'。
   * @param {object} [body] - POST 载荷；缺省为 GET。
   * @param {AbortSignal} [signal] - 取消信号。
   * @returns {Promise<object>} 已解析的 JSON 响应体。
   */
  async function bridge(path, body, signal) {
    const init = body === undefined ? {} : {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    };
    if (signal !== undefined) init.signal = signal;
    let response;
    try {
      response = await fetch(`${ROUTE_BASE}${path}`, init);
    } catch (error) {
      if (signal?.aborted) throw Object.assign(new Error('已取消'), { code: 'client-aborted' });
      throw Object.assign(new Error(`无法连接本地优化服务（${String(error?.message ?? error)}）`), { code: 'bridge-unreachable' });
    }
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      throw Object.assign(new Error(`本地优化服务返回了非 JSON 响应（HTTP ${response.status}）`), { code: 'bridge-bad-response' });
    }
    if (payload !== null && typeof payload === 'object') return payload;
    throw Object.assign(new Error(`本地优化服务返回了意外载荷（HTTP ${response.status}）`), { code: 'bridge-bad-response' });
  }

  /**
   * 自检上报：把加载/注册/渲染的关键节点送回 Host，落到一个可直接读取的 JSONL。
   *
   * 为什么需要它：客户端一旦在某一步静默失败（apply 抛错、插槽声明回调从未触发、
   * 组件渲染异常），从宿主侧完全看不出来 —— 现象就只是「按钮没出现」。
   * 上报本身失败一律吞掉，诊断绝不能影响功能。
   *
   * @param {string} phase - 节点名。
   * @param {object} [detail] - 附加信息。
   */
  function report(phase, detail) {
    try {
      void bridge('/report', detail === undefined ? { phase } : { phase, detail }).catch(() => {});
    } catch {
      /* 诊断失败不影响功能 */
    }
  }

  /**
   * 「模型 / 规则」引擎标签。
   * @param {string} engine - 'model' | 'rules'。
   * @param {(key: string) => string} t - 翻译函数。
   * @returns {string} 展示文案。
   */
  function engineLabel(engine, t) {
    return engine === 'model' ? t('engine.model') : t('engine.rules');
  }

  /**
   * 字符级 LCS 差异。用于「对比」视图，标出新增与删除。
   *
   * 刻意采用 O(n·m) 的经典实现并在此处**硬性限制规模**：超过上限时退化为
   * 「整体视为替换」，避免一次误点让浏览器卡死。
   *
   * @param {string} before - 原文。
   * @param {string} after - 优化文。
   * @returns {Array<{text: string, mark: 'same'|'ins'|'del'}>} 逐段结果。
   */
  function diffTokens(before, after) {
    const a = String(before ?? '');
    const b = String(after ?? '');
    if (a === b) return a.length === 0 ? [] : [{ text: a, mark: 'same' }];
    if (a.length * b.length > 4_000_000) {
      return [
        ...(a.length > 0 ? [{ text: a, mark: 'del' }] : []),
        ...(b.length > 0 ? [{ text: b, mark: 'ins' }] : []),
      ];
    }
    const n = a.length;
    const m = b.length;
    // dp[i][j] = a[i..] 与 b[j..] 的最长公共子序列长度。
    const width = m + 1;
    const dp = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        dp[i * width + j] = a[i] === b[j]
          ? dp[(i + 1) * width + (j + 1)] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)]);
      }
    }
    /** @type {Array<{text: string, mark: 'same'|'ins'|'del'}>} */
    const tokens = [];
    const push = (text, mark) => {
      if (text.length === 0) return;
      const last = tokens[tokens.length - 1];
      if (last !== undefined && last.mark === mark) last.text += text;
      else tokens.push({ text, mark });
    };
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { push(a[i], 'same'); i += 1; j += 1; }
      else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) { push(a[i], 'del'); i += 1; }
      else { push(b[j], 'ins'); j += 1; }
    }
    while (i < n) { push(a[i], 'del'); i += 1; }
    while (j < m) { push(b[j], 'ins'); j += 1; }
    return tokens;
  }

  /**
   * 渲染差异结果。
   * @param {Array<{text: string, mark: string}>} tokens - diffTokens 的输出。
   * @param {any} h - React.createElement。
   * @returns {any} 元素。
   */
  function renderDiff(tokens, h) {
    return h(
      'div',
      { className: 'dpo-pre' },
      tokens.map((token, index) => (token.mark === 'same'
        ? token.text
        : h('span', { key: index, className: token.mark === 'ins' ? 'dpo-ins' : 'dpo-del' }, token.text))),
    );
  }

  /**
   * 生成 Client 半的插件体。
   *
   * 之所以包一层工厂：这样 React / styles / 翻译表都在闭包里，
   * 便于测试时注入替身，也避免污染全局。
   *
   * @param {object} deps - 运行时依赖。
   * @param {any} deps.React - React 运行时。
   * @param {{insert: (css: string) => () => void}} deps.styles - 样式注入器。
   * @param {Console} deps.console - 日志。
   * @param {object} [deps.dicts] - 词典内容（同时用于 ctx.locale 注册与本地回退）。
   * @returns {{apply: (ctx: any) => void, inject: string[]}} Client 插件定义。
   */
  function createClientPlugin(deps) {
    const { React, styles, console: logger, dicts } = deps;
    const h = React.createElement;

    /** 把一个 key 的跨语言词条取出来。 */
    const translate = (lang) => (key, vars) => {
      const table = (dicts ?? {})[lang] ?? (dicts ?? {}).zh ?? {};
      const raw = typeof table[key] === 'string' ? table[key] : key;
      if (vars === undefined) return raw;
      return raw.replace(/\{(\w+)\}/g, (match, name) => (Object.hasOwn(vars, name) ? String(vars[name]) : match));
    };

    /**
     * 一个会话的优化器面板 + 工具条按钮。
     *
     * @param {object} props - 插槽渲染出的 props。
     * @param {string} props.sessionId - 当前会话 id（session 作用域插槽提供）。
     * @param {() => string} props.readDraft - 读取当前草稿。
     * @param {(text: string) => boolean} props.writeDraft - 写回草稿。
     * @param {(level: string, text: string) => void} props.notify - 显示输入框内联提示。
     * @param {(key: string, vars?: object) => string} props.t - 翻译函数。
     * @param {'button'|'panel'} props.part - 本条目只渲染按钮或只渲染面板。
     * @returns {any} 元素。
     */
  /**
   * 跨插槽共享的每会话状态。
   *
   * ## 为什么必须有它
   * 按钮在 `conversation.input.right`、面板在 `conversation.input.dock`，
   * 两者是**两个独立的插槽条目 = 两个独立的 React 实例**。`useState` 是按实例
   * 隔离的，所以「点按钮把结果存进 state」这件事，面板那一边**永远看不到** ——
   * 结果是：优化成功后结果确实存在，但没有任何地方显示它（面板的 open 恒为 false）。
   *
   * 因此状态必须放在组件之外，按 sessionId 共享，并让两边都订阅同一份快照。
   *
   * 快照必须是**稳定引用**（只在变更时替换），否则 `useSyncExternalStore` 会无限重渲染。
   */
  const sharedStore = (() => {
    const EMPTY = Object.freeze({
      phase: 'idle',
      result: null,
      error: null,
      open: false,
      mode: 'after',
      undo: null,
      copied: false,
      info: null,
    });
    /** @type {Map<string, object>} sessionId -> 冻结的状态快照 */
    const states = new Map();
    /** @type {Map<string, Set<Function>>} sessionId -> 订阅者 */
    const listeners = new Map();

    return {
      /**
       * 读某会话的当前快照（无则返回共享的空快照）。
       * @param {string} sessionId - 会话 id。
       * @returns {object} 冻结快照。
       */
      snapshot(sessionId) {
        return states.get(sessionId) ?? EMPTY;
      },
      /**
       * 合并式更新并通知订阅者。
       * @param {string} sessionId - 会话 id。
       * @param {object} changes - 要合并的字段。
       */
      patch(sessionId, changes) {
        const prev = states.get(sessionId) ?? EMPTY;
        const next = Object.freeze({ ...prev, ...changes });
        states.set(sessionId, next);
        const set = listeners.get(sessionId);
        if (set === undefined) return;
        for (const listener of [...set]) {
          try {
            listener();
          } catch {
            /* 单个订阅者出错不影响其它订阅者 */
          }
        }
      },
      /**
       * 订阅某会话的状态变更。
       * @param {string} sessionId - 会话 id。
       * @param {Function} listener - 变更回调。
       * @returns {() => void} 退订函数。
       */
      subscribe(sessionId, listener) {
        let set = listeners.get(sessionId);
        if (set === undefined) {
          set = new Set();
          listeners.set(sessionId, set);
        }
        set.add(listener);
        return () => {
          set.delete(listener);
          if (set.size === 0) listeners.delete(sessionId);
        };
      },
      /**
       * 丢弃某会话的状态（插件卸载时清理）。
       * @param {string} sessionId - 会话 id。
       */
      drop(sessionId) {
        states.delete(sessionId);
        listeners.delete(sessionId);
      },
    };

  })();

  /** 在途请求的 AbortController，同样按会话共享（两个实例都要知道"正在忙"）。 */
  const inflight = new Map();

  /**
   * 订阅某会话的共享快照。
   * @param {string} sessionId - 会话 id。
   * @returns {object} 当前快照。
   */
  function useSharedState(sessionId) {
    return React.useSyncExternalStore(
      (listener) => sharedStore.subscribe(sessionId, listener),
      () => sharedStore.snapshot(sessionId),
      () => sharedStore.snapshot(sessionId),
    );
  }

  /**
   * 一个会话的优化器面板 + 工具条按钮。
   *
   * @param {object} props - 插槽渲染出的 props。
   * @param {string} props.sessionId - 当前会话 id（session 作用域插槽提供）。
   * @param {() => string} props.readDraft - 读取当前草稿。
   * @param {(text: string) => boolean} props.writeDraft - 写回草稿。
   * @param {(level: string, text: string) => void} props.notify - 显示输入框内联提示。
   * @param {(key: string, vars?: object) => string} props.t - 翻译函数。
   * @param {'button'|'panel'} props.part - 本条目只渲染按钮或只渲染面板。
   * @returns {any} 元素。
   */
  function OptimizerEntry(props) {
    const { sessionId, readDraft, writeDraft, notify, part } = props;
    // 统一翻译入口：`t` 由本插件 inject 提供，但**必须给回退**。
    // 曾经只有部分位置有回退、其它地方直接用 `t`，一旦 t 缺失就是
    // `TypeError: t is not a function` → 整个条目渲染失败（按钮消失）。
    const t = typeof props.t === 'function' ? props.t : translate('zh');
    const text = t;

    // 全部状态来自**跨插槽共享**的每会话快照 —— 按钮与面板因此看到同一份结果。
    const shared = useSharedState(sessionId);
    const { phase, result, error, open, mode, undo, copied, info } = shared;
    /** 局部 UI 态（不需要共享）。 */
    const [busyTick, setBusyTick] = React.useState(0);
    const busy = inflight.has(sessionId);

    /**
     * 合并式写入共享状态。
     * @param {object} changes - 要合并的字段。
     */
    const set = (changes) => sharedStore.patch(sessionId, changes);

    /** 会话切换时清理上一会话的在途请求。 */
    const sessionRef = React.useRef(sessionId);
    React.useEffect(() => {
      sessionRef.current = sessionId;
      return () => {
        // 本实例卸载：中止属于"这个会话"的在途请求（另一个实例可能还活着，
        // 所以只在没有任何订阅者时才真正丢弃状态）。
        const controller = inflight.get(sessionId);
        if (controller !== undefined) {
          controller.abort();
          inflight.delete(sessionId);
        }
      };
    }, [sessionId]);

    React.useEffect(() => {
      // 组件真的被挂载了 —— 这是「插槽注册成功 + 渲染没抛错」的直接证据。
      report('client:entry-mounted', {
        part,
        sessionId,
        hasT: typeof props.t,
        hasReadDraft: typeof readDraft,
      });
      let alive = true;
      bridge('/info')
        .then((payload) => { if (alive && payload?.ok === true) set({ info: payload }); })
        .catch(() => { if (alive) set({ info: { ok: false, llm: false, config: { mode: 'rules' } } }); });
      return () => { alive = false; };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const lang = typeof info?.lang === 'string' ? info.lang : undefined;

      /**
       * 执行优化。并发保护：同一会话已有在途请求时忽略重复点击。
       * @returns {Promise<void>} 完成后 resolve。
       */
      async function run() {
        if (inflight.has(sessionId)) return;
        const draft = readDraft();
        if (typeof draft !== 'string' || draft.trim().length === 0) {
          report('client:run-empty', { readLen: typeof draft === 'string' ? draft.length : -1 });
          notify?.('error', text('error.empty'));
          set({ error: text('error.empty'), open: true, phase: 'error' });
          return;
        }
        report('client:run-enter', { len: draft.length });
        const controller = new AbortController();
        inflight.set(sessionId, controller);
        set({ phase: 'busy', error: null, copied: false });
        // 共享状态变了要让两个实例都重渲染（busy 是从 inflight 派生的）。
        const bump = () => setBusyTick((n) => n + 1);
        bump();
        try {
          const payload = await bridge('/optimize', { text: draft, lang }, controller.signal);
          if (controller.signal.aborted) return;
          if (payload?.ok !== true) {
            const message = String(payload?.message ?? payload?.error ?? 'unknown');
            report('client:run-failed', { message });
            set({ error: message, phase: 'error', open: true });
            return;
          }
          report('client:run-ok', { engine: payload.engine, len: String(payload.text ?? '').length });
          set({
            result: {
              original: draft,
              text: String(payload.text ?? ''),
              engine: String(payload.engine ?? 'rules'),
              notes: Array.isArray(payload.notes) ? payload.notes.map(String) : [],
              gaps: Array.isArray(payload.gaps) ? payload.gaps.map(String) : [],
              provider: payload.provider ?? null,
              model: payload.model ?? null,
              elapsedMs: Number(payload.elapsedMs ?? 0),
            },
            phase: 'done',
            open: true,
          });
          if (Array.isArray(payload.notes) && payload.notes.length > 0) notify?.('info', payload.notes[0]);
        } catch (caught) {
          if (controller.signal.aborted) return;
          const message = String(caught?.message ?? caught);
          set({ error: message, phase: 'error', open: true });
          notify?.('error', message);
        } finally {
          inflight.delete(sessionId);
          bump();
          if (!controller.signal.aborted) {
            set({ phase: sharedStore.snapshot(sessionId).phase === 'busy' ? 'idle' : sharedStore.snapshot(sessionId).phase });
          }
        }
      }

      /** 用优化结果替换草稿，并记下撤销点。 */
      function replaceDraft() {
        if (result === null) return;
        const before = readDraft();
        if (typeof before === 'string' && before !== result.text) set({ undo: { text: before, at: Date.now() } });
        const ok = writeDraft(result.text);
        notify?.(ok ? 'info' : 'error', ok ? text('notice.replaced') : text('error.writeFailed'));
        if (ok) set({ open: false });
      }

      /** 把优化结果追加到草稿末尾（保留原文，便于对照）。 */
      function appendDraft() {
        if (result === null) return;
        const before = readDraft();
        const joined = before.trim().length === 0 ? result.text : `${before}\n\n${result.text}`;
        if (typeof before === 'string' && before !== joined) set({ undo: { text: before, at: Date.now() } });
        const ok = writeDraft(joined);
        notify?.(ok ? 'info' : 'error', ok ? text('notice.appended') : text('error.writeFailed'));
        if (ok) set({ open: false });
      }

      /** 撤销上一次替换/追加。 */
      function undoDraft() {
        if (undo === null) return;
        const ok = writeDraft(undo.text);
        notify?.(ok ? 'info' : 'error', ok ? text('notice.undone') : text('error.writeFailed'));
        if (ok) set({ undo: null, phase: 'done' });
      }

      /** 复制优化结果到剪贴板，带降级路径。 */
      async function copyResult() {
        if (result === null) return;
        try {
          if (navigator?.clipboard?.writeText !== undefined) {
            await navigator.clipboard.writeText(result.text);
          } else {
            const area = document.createElement('textarea');
            area.value = result.text;
            area.setAttribute('readonly', '');
            area.style.position = 'fixed';
            area.style.opacity = '0';
            document.body.appendChild(area);
            area.select();
            document.execCommand('copy');
            document.body.removeChild(area);
          }
          set({ copied: true });
          notify?.('info', text('notice.copied'));
        } catch (caught) {
          notify?.('error', `${text('error.copyFailed')}${String(caught?.message ?? caught)}`);
        }
      }

      const buttonState = busy ? 'busy' : phase === 'error' ? 'error' : result !== null ? 'done' : 'idle';
      const label = busy
        ? text('button.busy')
        : result !== null
          ? text('button.again')
          : text('button.idle');

      const button = h(
        'button',
        {
          type: 'button',
          className: 'dpo-btn',
          'data-state': buttonState,
          // 保住输入框焦点：mousedown 会先把焦点移走，导致光标位置丢失。
          onMouseDown: (event) => event.preventDefault(),
          onClick: run,
          disabled: busy,
          title: t('button.title'),
          'aria-label': t('button.title'),
          'aria-busy': busy,
        },
        busy ? h('span', { className: 'dpo-btn__dot' }) : null,
        h('span', null, label),
      );

      // 生成一对条目：按钮进工具条，面板挂在输入框上方，防止撑坏工具条布局。
      //
      // ⚠️ 键名必须与 makeInject 传入的 `part` 完全一致（'button' / 'panel'）。
      // 这里曾经写成 'right' / 'dock'（插槽名），于是 `seats[part]` 恒为 undefined、
      // 组件返回 null —— 槽位注册全部正确，按钮却**什么都不渲染**，且不报任何错。
      // 现在由 build/render-test.mjs 用真 React 渲染并断言输出非空来守住。
      const seats = {
        button: h(
          React.Fragment,
          null,
          button,
          result !== null && !open
            ? h('button', {
                type: 'button',
                className: 'dpo-btn',
                'data-state': 'done',
                onMouseDown: (event) => event.preventDefault(),
                onClick: () => set({ open: true }),
                title: t('panel.reopen'),
              }, text('button.result'))
            : null,
        ),
        panel: open ? h(Panel, {
          t, text, result, error, info, phase, mode,
          setMode: (next) => set({ mode: next }), copied,
          onCopy: copyResult, onReplace: replaceDraft, onAppend: appendDraft,
          onUndo: undoDraft, canUndo: undo !== null, onRetry: run,
          onClose: () => set({ open: false }), busy,
        }) : null,
      };

      return seats[part] ?? null;
    }

    /**
     * 结果面板：展示优化结果、对比视图与四个操作。
     *
     * @param {object} props - 面板属性。
     * @returns {any} 元素。
     */
    function Panel(props) {
      const {
        text, t, result, error, info, phase, mode, setMode, copied,
        onCopy, onReplace, onAppend, onUndo, canUndo, onRetry, onClose, busy,
      } = props;

      const notes = result?.notes ?? [];
      const body = (() => {
        if (busy) return h('p', { className: 'dpo-note' }, text('panel.busy'));
        if (error !== null && result === null) {
          return h(
            'div',
            null,
            h('p', { className: 'dpo-note', 'data-level': 'error' }, `${text('panel.failed')}${error}`),
          );
        }
        if (result === null) return h('p', { className: 'dpo-note' }, text('panel.hint'));
        if (mode === 'diff') {
          return h(
            'div',
            { className: 'dpo-cols' },
            h('div', { className: 'dpo-col' },
              h('div', { className: 'dpo-col__head' }, text('panel.original')),
              renderDiff(diffTokens(result.original, result.text), h)),
            h('div', { className: 'dpo-col' },
              h('div', { className: 'dpo-col__head' }, text('panel.optimized')),
              h('pre', { className: 'dpo-pre' }, result.text)),
          );
        }
        if (mode === 'original') return h('pre', { className: 'dpo-pre' }, result.original);
        return h('pre', { className: 'dpo-pre' }, result.text);
      })();

      const tabs = [
        ['after', text('tab.after')],
        ['original', text('tab.original')],
        ['diff', text('tab.diff')],
      ];

      return h(
        'div',
        { className: 'dpo-panel', role: 'region', 'aria-label': t('panel.title') },
        h(
          'div',
          { className: 'dpo-panel__head' },
          h('span', { className: 'dpo-panel__title' }, text('panel.title')),
          result !== null ? h('span', { className: 'dpo-badge' }, engineLabel(result.engine, text)) : null,
          result?.model != null ? h('span', { className: 'dpo-panel__meta' }, `${result.provider}/${result.model}`) : null,
          result !== null && result.elapsedMs > 0
            ? h('span', { className: 'dpo-panel__meta' }, `${(result.elapsedMs / 1000).toFixed(1)}s`)
            : null,
          result !== null && result.gaps.length > 0
            ? h('span', { className: 'dpo-panel__meta' }, text('panel.gaps', { n: result.gaps.length }))
            : null,
          h('span', { className: 'dpo-panel__spacer' }),
          ...tabs.map(([key, label]) => h('button', {
            key,
            type: 'button',
            className: 'dpo-act',
            'data-variant': mode === key ? 'primary' : undefined,
            disabled: result === null,
            onMouseDown: (event) => event.preventDefault(),
            onClick: () => setMode(key),
          }, label)),
          h('button', {
            type: 'button', className: 'dpo-act',
            onMouseDown: (event) => event.preventDefault(),
            onClick: onClose,
            title: t('panel.close'),
          }, text('panel.close')),
        ),
        h(
          'div',
          { className: 'dpo-panel__body' },
          notes.length > 0
            ? h('div', null, ...notes.map((note, index) => h('p', { key: index, className: 'dpo-note' }, note)))
            : null,
          error !== null && result !== null
            ? h('p', { className: 'dpo-note', 'data-level': 'error' }, `${text('panel.failed')}${error}`)
            : null,
          phase === 'error' && result === null && info?.llm === false
            ? h('p', { className: 'dpo-note', 'data-level': 'warn' }, text('panel.noLlm'))
            : null,
          body,
        ),
        h(
          'div',
          { className: 'dpo-panel__foot' },
          h('button', {
            type: 'button', className: 'dpo-act', 'data-variant': 'primary',
            disabled: result === null,
            onMouseDown: (event) => event.preventDefault(),
            onClick: onReplace,
          }, text('act.replace')),
          h('button', {
            type: 'button', className: 'dpo-act',
            disabled: result === null,
            onMouseDown: (event) => event.preventDefault(),
            onClick: onAppend,
          }, text('act.append')),
          h('button', {
            type: 'button', className: 'dpo-act',
            disabled: result === null,
            onMouseDown: (event) => event.preventDefault(),
            onClick: onCopy,
          }, copied ? text('act.copied') : text('act.copy')),
          h('button', {
            type: 'button', className: 'dpo-act',
            disabled: !canUndo,
            onMouseDown: (event) => event.preventDefault(),
            onClick: onUndo,
          }, text('act.undo')),
          h('span', { className: 'dpo-panel__spacer' }),
          error !== null
            ? h('button', {
                type: 'button', className: 'dpo-act',
                onMouseDown: (event) => event.preventDefault(),
                onClick: onRetry,
              }, text('act.retry'))
            : null,
        ),
      );
    }

    /**
     * 解析当前会话的草稿读写能力。
     *
     * 这条链路是 dsh 客户端会话作用域的标准接缝：
     *   ctx.sessions.scope(sessionId) -> ctx.get('conversation') -> .input.for(actx)
     * 取到的 shell 提供 snapshot.draft（读）、actions.setDraft（写）、notify（提示）。
     *
     * @param {any} ctx - Client 根上下文。
     * @param {string} sessionId - 会话 id。
     * @returns {{ok: true, shell: any, actx: any} | {ok: false, error: string}} 结果。
     */
    function resolveShell(ctx, sessionId) {
      const sessions = ctx.get('sessions');
      if (sessions === undefined || typeof sessions.scope !== 'function') return { ok: false, error: 'no-sessions' };
      const actx = sessions.scope(sessionId);
      if (actx === undefined) return { ok: false, error: 'no-scope' };
      const conversation = actx.get('conversation');
      if (conversation === undefined || conversation.input === undefined) return { ok: false, error: 'no-conversation' };
      try {
        const shell = conversation.input.for(actx);
        if (shell === undefined) return { ok: false, error: 'no-shell' };
        return { ok: true, shell, actx };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
    }

    /**
     * Client 半入口。
     * @param {any} ctx - Client 根上下文。
     */
    function apply(ctx) {
      report('client:apply-enter', {
        hasGet: typeof ctx?.get,
        hasSlots: typeof ctx?.slots?.inject,
        hasEffect: typeof ctx?.effect,
        globals: {
          styles: typeof globalThis.__DSH_STYLES__,
          moduleLoader: typeof globalThis.__ModuleLoader__,
        },
      });

      try {
        // 样式随插件卸载一起移除。
        ctx.effect(() => styles.insert(CSS), 'dsh-prompt-optimizer: stylesheet');
        report('client:styles-ok');
      } catch (error) {
        report('client:styles-threw', { message: String(error?.message ?? error) });
        throw error;
      }

      // 词典注册：优先用 locale.register（按命名空间），退化用 addLanguage（按语言）。
      const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined;
      report('client:locale-probe', { found: locale !== undefined, hasRegister: typeof locale?.register });
      if (dicts !== undefined && locale !== undefined) {
        try {
          if (typeof locale.register === 'function') {
            ctx.effect(() => locale.register(LOCALE_NS, dicts), 'dsh-prompt-optimizer: dictionaries');
          } else if (typeof locale.addLanguage === 'function') {
            ctx.effect(() => locale.addLanguage({ id: LOCALE_NS, dicts }), 'dsh-prompt-optimizer: dictionaries');
          } else {
            logger?.warn?.('[dsh-prompt-optimizer] locale service exposes neither register nor addLanguage; falling back to built-in Chinese strings');
          }
          report('client:locale-ok');
        } catch (error) {
          report('client:locale-threw', { message: String(error?.message ?? error) });
          logger?.warn?.(`[dsh-prompt-optimizer] locale registration failed: ${String(error?.message ?? error)}`);
        }
      }

      /**
       * 为一个插槽生成渲染函数：把会话草稿能力解析成 props。
       * @param {'button'|'panel'} part - 渲染哪一半。
       * @param {string} slotName - 用于日志的插槽名。
       * @returns {(sessionId: string) => object} inject 回调。
       */
      const makeInject = (part, slotName) => (sessionId) => {
        const t = translate('zh');
        /** 缓存的 shell；解析失败时保持 null，**每次调用都会重试**。 */
        let shell = null;
        let resolveError = null;

        /**
         * 惰性解析会话草稿能力，成功即缓存。
         *
         * 为什么必须惰性：inject 发生在组件挂载前后，此时会话作用域可能还没
         * materialize（`sessions.scope()` 返回 undefined）。若在 inject 时
         * 一次性解析并永久缓存，之后 readDraft 会恒返回空串 ——
         * 现象就是「点了按钮说没输入内容」/「替换原文没反应」。
         * 参考实现（@nydsg/dsh-mindmap）也是在**写入那一刻**才解析。
         *
         * @returns {any} shell 或 null。
         */
        const ensure = () => {
          if (shell !== null) return shell;
          const resolved = resolveShell(ctx, sessionId);
          if (resolved.ok) {
            shell = resolved.shell;
            resolveError = null;
          } else {
            resolveError = resolved.error;
          }
          return shell;
        };

        ensure(); // 先探一次，便于早期发现；失败不致命，调用时会重试
        report('client:inject-resolved', { part, sessionId, ok: shell !== null, error: resolveError });

        return {
          sessionId,
          part,
          t,
          readDraft: () => {
            const resolvedShell = ensure();
            try {
              const draft = resolvedShell?.snapshot?.draft;
              const ok = typeof draft === 'string';
              report('client:read-draft', {
                part,
                ok,
                len: ok ? draft.length : -1,
                shell: resolvedShell !== null,
                error: resolveError,
              });
              return ok ? draft : '';
            } catch (error) {
              report('client:read-draft-threw', { part, message: String(error?.message ?? error) });
              return '';
            }
          },
          writeDraft: (next) => {
            const resolvedShell = ensure();
            try {
              if (resolvedShell === null || typeof resolvedShell.actions?.setDraft !== 'function') {
                report('client:write-draft', {
                  part,
                  ok: false,
                  reason: resolvedShell === null ? `no-shell:${String(resolveError)}` : 'no-setDraft',
                });
                return false;
              }
              resolvedShell.actions.setDraft(String(next));
              report('client:write-draft', { part, ok: true, len: String(next).length });
              return true;
            } catch (error) {
              report('client:write-draft-threw', { part, message: String(error?.message ?? error) });
              logger?.warn?.(`[dsh-prompt-optimizer] setDraft failed: ${String(error?.message ?? error)}`);
              return false;
            }
          },
          notify: (level, message) => {
            try {
              const resolvedShell = ensure();
              if (typeof resolvedShell?.notify !== 'function') return;
              resolvedShell.notify(level === 'error' ? 'error' : 'info', String(message));
            } catch {
              /* 提示失败不影响主流程。 */
            }
          },
        };
      };

      // 按钮：输入框工具条右侧（与模型选择器同排）。等待父插槽声明后再注册，
      // 声明消失（插件被禁用）时 inject 会自动撤销注册。
      //
      // 刻意**不声明 `locale:`** —— 那会让渲染器在装配该条目时调用
      // `localeSeat(face, ns)` → `face.bind(ns)`；一旦词典命名空间此刻不可用，
      // 装配就会抛错、整个条目静默消失（现象正是「按钮没出现」）。
      // 本组件的文案由自己 inject 的 `t` 提供，不需要这条通道。
      ctx.slots.inject('conversation.input.right', () => {
        report('client:slot-declared', { slot: 'conversation.input.right' });
        return ctx.slots.register(
          {
            name: 'conversation.input.right',
            id: 'prompt-optimizer-button',
            order: 10,
            inject: makeInject('button', 'conversation.input.right'),
          },
          OptimizerEntry,
        );
      });

      // 面板：输入框上方整幅区域，空间充足且不挤压工具条。
      ctx.slots.inject('conversation.input.dock', () => {
        report('client:slot-declared', { slot: 'conversation.input.dock' });
        return ctx.slots.register(
          {
            name: 'conversation.input.dock',
            id: 'prompt-optimizer-panel',
            order: 30,
            inject: makeInject('panel', 'conversation.input.dock'),
          },
          OptimizerEntry,
        );
      });

      report('client:apply-ok');
    }

    return {
      apply,
      inject: ['slots', 'sessions', 'locale'],
      /**
       * 仅供 build/render-test.mjs 做回归测试，生产路径不读这里。
       *
       * 之所以要暴露 `sharedStore`：按钮与面板是两个独立 React 实例，
       * 「结果存进了按钮实例、面板却永远看不到」这个 bug 已经出现过一次，
       * 而它**不报任何错**（面板只是渲染 null）。只有能把状态直接种进去、
       * 再断言面板真的渲染出内容，才能守住它。
       */
      __test: { sharedStore, inflight },
    };
  }

  /** 界面词典。新增语言时同步补 key。 */
  const DICTS = {
    zh: {
      'button.idle': '优化提示词',
      'button.busy': '优化中…',
      'button.again': '再优化',
      'button.result': '查看优化结果',
      'button.title': '读取输入框中的提示词并优化',
      'panel.title': '提示词优化',
      'panel.hint': '先在输入框写下提示词，再点「优化提示词」。',
      'panel.busy': '正在优化，请稍候…',
      'panel.failed': '优化失败：',
      'panel.noLlm': '本地模型服务不可用，已使用内置规则引擎（离线可用）。',
      'panel.close': '收起',
      'panel.reopen': '重新打开结果面板',
      'panel.original': '原文',
      'panel.optimized': '优化后',
      'panel.gaps': '待补 {n} 段',
      'tab.after': '优化后',
      'tab.original': '原文',
      'tab.diff': '对比',
      'act.replace': '替换原文',
      'act.append': '追加',
      'act.copy': '复制',
      'act.copied': '已复制',
      'act.undo': '撤销',
      'act.retry': '重试',
      'engine.model': '模型',
      'engine.rules': '规则',
      'notice.replaced': '已用优化结果替换输入框内容，可用「撤销」还原。',
      'notice.appended': '已把优化结果追加到输入框末尾，可用「撤销」还原。',
      'notice.undone': '已撤销上次替换。',
      'notice.copied': '已复制优化结果。',
      'error.empty': '请先在输入框中写下提示词。',
      'error.writeFailed': '无法写回输入框，请手动复制结果。',
      'error.copyFailed': '复制失败：',
    },
    en: {
      'button.idle': 'Optimize prompt',
      'button.busy': 'Optimizing…',
      'button.again': 'Optimize again',
      'button.result': 'View result',
      'button.title': 'Read the composer draft and optimize it',
      'panel.title': 'Prompt optimizer',
      'panel.hint': 'Write a prompt in the composer, then click "Optimize prompt".',
      'panel.busy': 'Optimizing, please wait…',
      'panel.failed': 'Optimization failed: ',
      'panel.noLlm': 'No local model service; the built-in offline rule engine was used.',
      'panel.close': 'Collapse',
      'panel.reopen': 'Reopen the result panel',
      'panel.original': 'Original',
      'panel.optimized': 'Optimized',
      'panel.gaps': '{n} section(s) to fill',
      'tab.after': 'Optimized',
      'tab.original': 'Original',
      'tab.diff': 'Diff',
      'act.replace': 'Replace',
      'act.append': 'Append',
      'act.copy': 'Copy',
      'act.copied': 'Copied',
      'act.undo': 'Undo',
      'act.retry': 'Retry',
      'engine.model': 'model',
      'engine.rules': 'rules',
      'notice.replaced': 'Composer replaced with the optimized prompt; use "Undo" to restore.',
      'notice.appended': 'Optimized prompt appended to the composer; use "Undo" to restore.',
      'notice.undone': 'Last replacement undone.',
      'notice.copied': 'Optimized prompt copied.',
      'error.empty': 'Write a prompt in the composer first.',
      'error.writeFailed': 'Could not write back to the composer; copy the result manually.',
      'error.copyFailed': 'Copy failed: ',
    },
  };

  const plugin = createClientPlugin({
    React,
    styles,
    console: logger,
    dicts: DICTS,
  });

  exports.apply = plugin.apply;
  exports.inject = plugin.inject;
  // 便于单元测试与二次开发：暴露纯函数与工厂。
  exports.createClientPlugin = createClientPlugin;
  exports.diffTokens = diffTokens;
  exports.optimizeLocally = optimizeLocally;
  exports.DICTS = DICTS;
  // 跨插槽共享状态的句柄：按钮与面板是两个 React 实例，这是唯一能断言
  // 「结果能从面板看到」的入口（详见 src/client.main.js 里 sharedStore 的注释）。
  exports.__test = plugin.__test;

  // 交回加载器：工厂的返回值就是本模块的导出对象。
  return module.exports;
} });
