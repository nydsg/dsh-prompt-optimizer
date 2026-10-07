/**
 * 用**真 React** 渲染本插件的两个插槽条目。
 *
 * 之前所有测试都只验证到「factory 返回了 apply/inject」，从没真正渲染过组件 ——
 * 而用户看到的现象恰恰是「按钮没出现」。这个测试补上那一步：
 * 把 bundle 当经典脚本求值 → 取 factory → 用真 react 调它 →
 * 用 react-dom/server 把组件渲染成字符串（renderToString 会跑 hooks 的渲染阶段，
 * 足以暴露渲染期抛错）。
 *
 * 需要 react / react-dom（脚本会告诉你路径）。
 * 用法：node build/render-test.mjs [reactDir]
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(here, '..');
const reactDir = process.argv[2] ?? 'D:/Codex-workspace/.dpo-react';
// 可选：--bundle <路径> 指定要测的 client.js（默认测本目录的 lib/client.js）。
// 用来直接验证「装进 profile 的那一份」是否真的能渲染出按钮。
const bundleArgAt = process.argv.indexOf('--bundle');
const bundlePath = bundleArgAt >= 0 && process.argv[bundleArgAt + 1] !== undefined
  ? resolve(process.argv[bundleArgAt + 1])
  : join(pluginDir, 'lib', 'client.js');

const require = createRequire(join(reactDir, 'package.json'));
let React;
let ReactDOMServer;
try {
  React = require('react');
  ReactDOMServer = require('react-dom/server');
} catch (error) {
  console.error('需要 react / react-dom 才能做渲染测试。');
  console.error('  查找目录:', reactDir);
  console.error('  原因    :', String(error?.message ?? error));
  console.error('\n一次性重建（约 5 MB，可随时删除）：');
  console.error(`  mkdir "${reactDir}"`);
  console.error(`  cd "${reactDir}" && npm init -y && npm i react@18 react-dom@18`);
  process.exit(2);
}
console.log('React', React.version);

// ---- 1. 当经典脚本求值，拿 factory ----
const source = readFileSync(bundlePath, 'utf8');
console.log('测试的 bundle:', bundlePath);
const registered = [];
const sandbox = {
  console,
  window: { __ModuleLoader__: { load: (def) => registered.push(def) } },
};
sandbox.globalThis = sandbox;
new vm.Script(source, { filename: 'client.js' }).runInContext(vm.createContext(sandbox));
if (registered.length !== 1) throw new Error(`注册数 ${registered.length}，应为 1`);
const { id, factory } = registered[0];
console.log('注册 id:', id);

// ---- 2. 调 factory（require('react') 给真 React）----
const fetchCalls = [];
sandbox.fetch = (url, init) => {
  fetchCalls.push({ url, body: init?.body });
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, llm: false, config: { mode: 'rules' } }) });
};
const exportsObj = factory((spec) => {
  if (spec === 'react') return React;
  throw new Error(`unexpected require: ${spec}`);
});
console.log('inject:', JSON.stringify(exportsObj.inject));

// ---- 3. 造一个假 ctx，跑 apply ----
const slotRegistrations = [];
const injectedBySlot = {};
const ctx = {
  get: (name) => (name === 'locale' ? { register: () => () => {}, bind: () => (k) => k } : undefined),
  effect: (cb) => {
    const dispose = cb();
    return typeof dispose === 'function' ? dispose : () => {};
  },
  slots: {
    inject: (key, callback) => {
      injectedBySlot[key] = true;
      const dispose = callback();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    register: (options, component) => {
      slotRegistrations.push({ options, component });
      return () => {};
    },
  },
  logger: { warn: () => {}, info: () => {} },
};
let applyError = null;
try {
  exportsObj.apply(ctx);
} catch (error) {
  applyError = error;
}
console.log('\n--- apply ---');
console.log('  抛错:', applyError ? String(applyError.message) : '无');
console.log('  slots.inject 调用:', JSON.stringify(Object.keys(injectedBySlot)));
console.log('  注册的条目:', slotRegistrations.map((r) => `${r.options.name}#${r.options.id}`).join(', '));

// ---- 4. 真渲染每个注册的条目 ----
let renderFailures = 0;
for (const { options, component } of slotRegistrations) {
  const part = options.id.includes('button') ? 'button' : 'panel';
  const props = {
    sessionId: 'session-test',
    part,
    t: (key) => `[${key}]`,
    readDraft: () => '原始提示词',
    writeDraft: () => true,
    notify: () => {},
  };
  console.log(`\n--- renderToString(${options.name} / part=${part}) ---`);
  try {
    const html = ReactDOMServer.renderToString(React.createElement(component, props));
    console.log('  OK，输出', html.length, '字节');
    console.log('  片段:', html.slice(0, 220));
    // 按钮条目必须真的产出 DOM —— 曾经因为 seats 的键名与 part 不一致，
    // 这里渲染出 0 字节：槽位注册全对、却什么都看不见，且不报错。
    if (part === 'button') {
      if (html.length === 0) {
        renderFailures += 1;
        console.log('  FAIL: 按钮条目渲染为空 —— 组件没有产出任何 DOM');
      } else {
        if (!html.includes('dpo-btn')) {
          renderFailures += 1;
          console.log('  FAIL: 输出里没有 dpo-btn 类名（样式不会生效）');
        } else {
          console.log('  OK: 有 dpo-btn 类名');
        }
        // 用**内置词典**再渲染一次（不传 t，走组件里的 translate('zh') 回退），
        // 断言真实可见文案就是「优化提示词」。
        const withDict = ReactDOMServer.renderToString(
          React.createElement(component, { ...props, t: undefined }),
        );
        if (!withDict.includes('优化提示词')) {
          renderFailures += 1;
          console.log('  FAIL: 内置词典没有产出「优化提示词」，实际:', withDict.slice(0, 200));
        } else {
          console.log('  OK: 内置词典产出「优化提示词」');
        }
      }
    } else {
      // 面板默认是收起的（open=false），渲染空是正确的。
      console.log('  （面板默认收起，0 字节属预期）');
    }
  } catch (error) {
    renderFailures += 1;
    console.log('  渲染抛错:', String(error?.message ?? error));
    if (error?.stack) console.log(String(error.stack).split('\n').slice(1, 5).join('\n'));
  }
}

// ---- 5. 跨插槽共享状态的回归测试 ----
//
// 按钮与面板是两个独立插槽条目 = 两个独立 React 实例。曾经状态放在组件的
// `useState` 里，于是「点按钮把结果存进按钮实例」这件事面板永远看不到：
// 优化确实成功了，但**页面上哪里都不显示结果**，而且不报任何错。
// 这里把状态直接种进共享 store，再断言面板真的把它渲染出来。
const store = exportsObj?.__test?.sharedStore;
console.log('\n--- 跨插槽共享状态（结果必须能从面板看到）---');
if (store === undefined) {
  renderFailures += 1;
  console.log('  FAIL: 拿不到 sharedStore（__test 导出缺失），无法验证按钮↔面板是否共享状态');
} else {
  const SESSION = 'session-shared';
  const OPTIMIZED = '## 优化后的提示词\n\n### 目标\n共享状态回归测试标记 OPTIMIZED_MARKER';
  store.patch(SESSION, {
    phase: 'done',
    open: true,
    error: null,
    copied: false,
    mode: 'after',
    undo: null,
    result: {
      original: '原始提示词',
      text: OPTIMIZED,
      engine: 'rules',
      notes: ['note-a'],
      gaps: ['背景'],
      provider: null,
      model: null,
      elapsedMs: 12,
    },
  });

  const panelEntry = slotRegistrations.find((r) => r.options.id.includes('panel'));
  const buttonEntry = slotRegistrations.find((r) => r.options.id.includes('button'));
  const sharedProps = {
    sessionId: SESSION,
    readDraft: () => '原始提示词',
    writeDraft: () => true,
    notify: () => {},
    t: (key) => `[${key}]`,
  };

  try {
    const panelHtml = ReactDOMServer.renderToString(
      React.createElement(panelEntry.component, { ...sharedProps, part: 'panel' }),
    );
    console.log('  面板输出', panelHtml.length, '字节');
    if (panelHtml.length === 0) {
      renderFailures += 1;
      console.log('  FAIL: 面板渲染为空 —— 两个插槽条目没有共享状态（就是用户报的那个 bug）');
    } else if (!panelHtml.includes('OPTIMIZED_MARKER')) {
      renderFailures += 1;
      console.log('  FAIL: 面板没有渲染出优化结果，实际:', panelHtml.slice(0, 300));
    } else {
      console.log('  OK: 面板渲染出了按钮那边产出的优化结果');
    }

    // 结果拿到但面板被收起时，工具条上应出现「查看优化结果」入口。
    store.patch(SESSION, { open: false });
    const collapsed = ReactDOMServer.renderToString(
      React.createElement(buttonEntry.component, { ...sharedProps, part: 'button' }),
    );
    console.log('  收起态按钮输出', collapsed.length, '字节');
    if (collapsed.length === 0) {
      renderFailures += 1;
      console.log('  FAIL: 收起态按钮渲染为空');
    } else if (!collapsed.includes('[button.result]') && !collapsed.includes('查看优化结果')) {
      renderFailures += 1;
      console.log('  FAIL: 结果存在但收起时没有「查看优化结果」入口，用户找不到结果');
    } else {
      console.log('  OK: 收起态给出「查看优化结果」入口');
    }
    store.drop(SESSION);
  } catch (error) {
    renderFailures += 1;
    console.log('  渲染抛错:', String(error?.message ?? error));
    if (error?.stack) console.log(String(error.stack).split('\n').slice(1, 4).join('\n'));
  }
}

console.log('\n--- 诊断上报（fetch 调用）---');
for (const call of fetchCalls) console.log('  ', call.url, call.body ? String(call.body).slice(0, 120) : '');

console.log(renderFailures === 0 && applyError === null
  ? '\n== RENDER OK: apply 未抛错，两个条目都能渲染 =='
  : `\n== ${renderFailures} 个条目渲染失败 / apply 抛错 ==`);
process.exitCode = renderFailures === 0 && applyError === null ? 0 : 1;
