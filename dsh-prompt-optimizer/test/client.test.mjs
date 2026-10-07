/**
 * lib/client.js 的加载与行为测试。
 *
 * 重点验证四件事：
 *   1. bundle 是**合法经典脚本**，并通过 `window.__ModuleLoader__.load` 自注册
 *      —— 浏览器就是这么加载它的（还会把多个插件拼成 combo script）。
 *   2. 注册进去的 factory 返回值就是模块 exports（apply / inject 齐备）。
 *   3. 内联的规则引擎与 lib/rules.js **逐字节同一份代码**（同一批夹具对比输出）。
 *   4. diffTokens 在边界输入下不崩、不误判。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { optimizeLocally as hostOptimize } from '../lib/rules.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const BUNDLE_PATH = resolve(root, 'lib', 'client.js');

/** 极简 React 替身：足以让模块在 Node 下完成加载，不参与渲染断言。 */
const reactStub = {
  createElement: (...args) => ({ type: args[0], props: args[1] ?? null, children: args.slice(2) }),
  Fragment: Symbol('Fragment'),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useRef: (initial) => ({ current: initial }),
  useMemo: (factory) => factory(),
  memo: (component) => component,
};

const requireShim = createRequire(import.meta.url);

/**
 * 把 bundle 当**经典 script** 求值（`vm.Script` 只接受脚本，不接受模块），
 * 收集它通过 `window.__ModuleLoader__.load` 注册的定义。
 *
 * 这一点是本项目最贵的一课：bundle 是普通 script，**顶层 return 是
 * SyntaxError: Illegal return statement**，而且会把整段 combo script 一起废掉，
 * 表现为 `web boot: N entry did not activate` + `import failed`，整个界面起不来。
 * 用 `vm.Script` 求值即可在单元测试里精确复现这一约束。
 *
 * @param {string} source - 脚本正文（可以是拼接后的 combo）。
 * @param {string} label - 报错用的来源标签。
 * @returns {Array<{id: string, factory: Function}>} 注册到的定义。
 */
function evaluateAsScript(source, label) {
  const registered = [];
  const sandbox = {
    console,
    // 平台注入的全局：window.__ModuleLoader__.load({ id, factory })
    window: { __ModuleLoader__: { load: (definition) => registered.push(definition) } },
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  new vm.Script(source, { filename: label }).runInContext(context);
  return registered;
}

/**
 * 加载 bundle：当脚本求值 → 取 factory → 用平台同款 require 调它。
 *
 * @param {string} file - bundle 路径。
 * @returns {any} bundle 的导出对象。
 */
function loadBundle(file) {
  const registered = evaluateAsScript(readFileSync(file, 'utf8'), file);
  if (registered.length !== 1) {
    throw new Error(`bundle ${file} 注册了 ${registered.length} 个定义，应恰好 1 个（window.__ModuleLoader__.load）`);
  }
  const { id, factory } = registered[0];
  if (id !== 'dsh-prompt-optimizer') throw new Error(`注册 id 不对: ${String(id)}`);
  if (typeof factory !== 'function') throw new Error('注册的 factory 不是函数');
  const exports = factory((specifier) => {
    if (specifier === 'react') return reactStub;
    return requireShim(specifier);
  });
  if (exports === undefined || exports === null) {
    throw new Error(`bundle ${file} 的 factory 没有返回 exports`);
  }
  return exports;
}

const bundle = loadBundle(BUNDLE_PATH);

/**
 * 规范化跨 realm 的值。
 *
 * bundle 是在 `vm` 上下文里求值的，它返回的对象用的是**另一个 realm 的
 * Object.prototype**；`assert/strict` 的 deepStrictEqual 会比较原型，
 * 于是「结构相同」也会判不等。做一次 JSON 往返即可比较纯数据。
 *
 * @param {unknown} value - 任意可 JSON 化的值。
 * @returns {unknown} 同构的本地 realm 值。
 */
const plain = (value) => JSON.parse(JSON.stringify(value));

test('bundle 是合法经典脚本（顶层不得有 return）', () => {
  const source = readFileSync(BUNDLE_PATH, 'utf8');
  // vm.Script 按 script 解析：顶层 return 会在这里直接抛 SyntaxError。
  assert.doesNotThrow(() => new vm.Script(source, { filename: BUNDLE_PATH }), '作为经典脚本必须可解析');
  // 再显式断言一次，避免将来有人「为了顺手」把 return 挪到顶层。
  assert.equal(/^return\s/m.test(source), false, '顶层不得出现 return（经典脚本非法）');
  assert.ok(source.includes('window.__ModuleLoader__.load('), '必须通过 __ModuleLoader__.load 自注册');
});

test('combo script 拼接后依然合法且各自注册（回归：曾因顶层 return 拖垮整批）', () => {
  const mine = readFileSync(BUNDLE_PATH, 'utf8');
  // 模拟浏览器的 combo：把两个插件的 bundle 首尾拼在一起，当作**一个**脚本加载。
  const neighbour = "window.__ModuleLoader__.load({ id: 'neighbour-plugin', factory: (require) => ({ apply() {}, inject: [] }) });\n";
  const combo = `${neighbour}\n${mine}`;
  let registered;
  assert.doesNotThrow(() => {
    registered = evaluateAsScript(combo, 'combo.js');
  }, 'combo 拼接后必须仍可解析 —— 顶层 return 会在这里炸掉整批插件');
  assert.equal(registered.length, 2, '两个插件都应完成注册');
  assert.deepEqual(registered.map((r) => r.id), ['neighbour-plugin', 'dsh-prompt-optimizer']);
  // 反向顺序也要成立（组合顺序由 boot graph 决定，不由我们选）
  const reversed = `${mine}\n${neighbour}`;
  let registeredReversed;
  assert.doesNotThrow(() => { registeredReversed = evaluateAsScript(reversed, 'combo-reversed.js'); });
  assert.deepEqual(registeredReversed.map((r) => r.id), ['dsh-prompt-optimizer', 'neighbour-plugin']);
});

test('bundle 导出 dsh 客户端插件契约', () => {
  assert.equal(typeof bundle.apply, 'function', 'apply 必须是函数');
  assert.ok(Array.isArray(bundle.inject), 'inject 必须是数组');
  for (const service of ['slots', 'sessions', 'locale']) {
    assert.ok(bundle.inject.includes(service), `inject 应声明 ${service}`);
  }
});

test('bundle 导出可测的纯函数', () => {
  assert.equal(typeof bundle.diffTokens, 'function');
  assert.equal(typeof bundle.optimizeLocally, 'function');
  assert.equal(typeof bundle.createClientPlugin, 'function');
  assert.equal(typeof bundle.DICTS, 'object');
});

test('内联规则引擎与 lib/rules.js 零漂移', () => {
  const fixtures = [
    '帮我写一个 Python 脚本，读取 CSV 并统计每列缺失率。不要用 pandas。验收标准：能跑通 10 万行。',
    'Write a function that parses CSV files. Do not use pandas. Acceptance: handles 100k rows.',
    '重构这段代码，保持 API 签名不变：\n```ts\nconst x: number = 1;\n```\n必须兼容 useDraft 钩子。',
    '写个登录页',
    '',
    '把背景：我们用的是 Node 20\n输出 JSON\n例如 {"a":1}',
    'x'.repeat(25000),
  ];
  for (const fixture of fixtures) {
    const host = hostOptimize(fixture);
    const client = bundle.optimizeLocally(fixture);
    assert.equal(client.text, host.text, `输出漂移（夹具长度 ${fixture.length}）`);
    assert.equal(client.lang, host.lang);
    assert.equal(client.engine, host.engine);
    assert.deepEqual(plain(client.gaps), plain(host.gaps));
    assert.equal(client.truncated, host.truncated);
  }
});

test('词典中英键集完全一致', () => {
  const zh = Object.keys(bundle.DICTS.zh).sort();
  const en = Object.keys(bundle.DICTS.en).sort();
  assert.deepEqual(en, zh, 'en 与 zh 的 key 必须一一对应，否则会漏译');
});

test('diffTokens 处理相同 / 空 / 纯增 / 纯删', () => {
  assert.deepEqual(plain(bundle.diffTokens('abc', 'abc')), [{ text: 'abc', mark: 'same' }]);
  assert.deepEqual(plain(bundle.diffTokens('', '')), []);
  assert.deepEqual(plain(bundle.diffTokens('', 'ab')), [{ text: 'ab', mark: 'ins' }]);
  assert.deepEqual(plain(bundle.diffTokens('ab', '')), [{ text: 'ab', mark: 'del' }]);
});

test('diffTokens 标出中间插入且保留两侧上下文', () => {
  const tokens = bundle.diffTokens('hello world', 'hello brave world');
  assert.ok(tokens.some((token) => token.mark === 'ins' && token.text.includes('brave')));
  assert.equal(tokens.filter((token) => token.mark === 'ins').map((token) => token.text).join(''), 'brave ');
  assert.ok(tokens.some((token) => token.mark === 'same' && token.text.includes('hello')));
  assert.ok(tokens.some((token) => token.mark === 'same' && token.text.includes('world')));
  assert.equal(tokens.some((token) => token.mark === 'del'), false);
});

test('diffTokens 还原性：拼接 same+ins 得到新文，拼接 same+del 得到旧文', () => {
  const before = '把这段 JSON 转成 CSV，保留表头顺序。';
  const after = '把这段 JSON 转成 CSV，必须保留表头顺序，并处理空值。';
  const tokens = bundle.diffTokens(before, after);
  const rebuiltAfter = tokens.filter((token) => token.mark !== 'del').map((token) => token.text).join('');
  const rebuiltBefore = tokens.filter((token) => token.mark !== 'ins').map((token) => token.text).join('');
  assert.equal(rebuiltAfter, after);
  assert.equal(rebuiltBefore, before);
});

test('diffTokens 在超大输入上退化为整体替换而不是卡死', () => {
  const big = 'a'.repeat(3000);
  const other = 'b'.repeat(3000);
  const tokens = bundle.diffTokens(big, other);
  assert.deepEqual(plain(tokens.map((token) => token.mark)), ['del', 'ins']);
});

test('apply 在最小 ctx 上注册两个插槽且不抛异常', () => {
  /** 记录所有插槽注册与 effect。 */
  const registrations = [];
  const injections = [];
  const effects = [];
  const ctx = {
    get: () => undefined,
    effect: (callback, label) => {
      effects.push(label);
      const disposer = callback();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    slots: {
      inject: (key, callback) => {
        injections.push(key);
        callback();
        return () => {};
      },
      register: (options, component) => {
        registrations.push({ options, component });
        return () => {};
      },
    },
    logger: { warn: () => {}, info: () => {} },
  };
  bundle.apply(ctx);

  assert.deepEqual(injections, ['conversation.input.right', 'conversation.input.dock']);
  assert.equal(registrations.length, 2);
  assert.equal(registrations[0].options.name, 'conversation.input.right');
  assert.equal(registrations[0].options.id, 'prompt-optimizer-button');
  assert.equal(registrations[1].options.name, 'conversation.input.dock');
  assert.equal(typeof registrations[0].component, 'function');
  assert.ok(effects.some((label) => String(label).includes('stylesheet')));
});

test('插槽 inject 在拿不到会话草稿能力时降级为空读、写失败、不抛', () => {
  const registrations = [];
  const ctx = {
    get: () => undefined,
    effect: (callback) => {
      const disposer = callback();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    slots: {
      inject: (_key, callback) => { callback(); return () => {}; },
      register: (options, component) => { registrations.push({ options, component }); return () => {}; },
    },
    logger: { warn: () => {}, info: () => {} },
  };
  bundle.apply(ctx);

  // 用一个没有 conversation 服务的会话 id 触发 inject。
  const inject = registrations[0].options.inject;
  const props = inject('session-unknown');
  assert.equal(typeof props.readDraft, 'function');
  assert.equal(props.readDraft(), '', '读不到草稿时应返回空串而不是抛错');
  assert.equal(props.writeDraft('x'), false, '写不进去时应返回 false 而不是抛错');
  assert.doesNotThrow(() => props.notify('error', 'hi'));
});

test('插槽 inject 能从会话作用域读到草稿并写回', () => {
  const registrations = [];
  /** 假的可变草稿。 */
  const state = { draft: '原始提示词' };
  const shell = {
    snapshot: { draft: state.draft },
    actions: { setDraft: (next) => { state.draft = next; shell.snapshot.draft = next; } },
    notify: () => {},
  };
  const conversation = { input: { for: () => shell } };
  const actx = { get: (name) => (name === 'conversation' ? conversation : undefined) };
  const ctx = {
    get: () => undefined,
    effect: (callback) => {
      const disposer = callback();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    slots: {
      inject: (_key, callback) => { callback(); return () => {}; },
      register: (options, component) => { registrations.push({ options, component }); return () => {}; },
    },
    logger: { warn: () => {}, info: () => {} },
  };
  // 让 sessions 服务可解析出会话作用域。
  ctx.get = (name) => (name === 'sessions' ? { scope: () => actx } : undefined);
  bundle.apply(ctx);

  const props = registrations[0].options.inject('session-1');
  assert.equal(props.readDraft(), '原始提示词');
  assert.equal(props.writeDraft('优化后的提示词'), true);
  assert.equal(props.readDraft(), '优化后的提示词');
});
