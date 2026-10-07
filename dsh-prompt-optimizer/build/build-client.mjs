/**
 * 生成 lib/client.js（自包含的浏览器端 bundle）。
 *
 * 为什么需要这一步：dsh 客户端模块系统给每个 bundle 的 `require` 只能解析
 * 「平台 seed 词 / 已注册包工厂 / 已 materialize 的模块」，**不能 require 同包兄弟文件**。
 * 所以 client bundle 必须单文件自包含。为了不手抄一份规则引擎（那必然漂移），
 * 本脚本把 lib/rules.js 的 `//#region rules` 段**逐字内联**进 src/client.main.js 的对应段。
 *
 * 产出包装形态与 dsh 客户端模块系统约定的工厂一致：
 *   (function (require, exports) { ... return module.exports; })(...)
 * 其中 React 由平台注入（`require('react')`），styles 为平台内置的 __DSH_STYLES__ 契约。
 *
 * 用法：node build/build-client.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

/**
 * 取出源文件中一对 `//#region <name>` / `//#endregion <name>` 之间的正文。
 *
 * 标记必须**独占一行**才被承认：源文件的文档注释里会引用这些标记名，
 * 用裸 indexOf 会在注释内部命中，切出半截代码。
 *
 * @param {string} source - 源文件全文。
 * @param {string} name - 区块名。
 * @returns {string} 区块正文。
 */
function region(source, name) {
  const lines = source.split('\n');
  const startLine = lines.findIndex((line) => line.trim() === `//#region ${name}`);
  const endLine = lines.findIndex((line) => line.trim() === `//#endregion ${name}`);
  if (startLine < 0) throw new Error(`region "${name}" has no //#region ${name} marker on its own line`);
  if (endLine < 0) throw new Error(`region "${name}" has no //#endregion ${name} marker on its own line`);
  if (endLine < startLine) throw new Error(`region "${name}" end marker precedes its start marker`);
  const body = lines.slice(startLine + 1, endLine).join('\n');
  if (body.trim().length === 0) throw new Error(`region "${name}" is empty`);
  return body.replace(/^\s*\n/, '').replace(/\s*$/, '');
}

/**
 * 去掉 ES module 的 export 关键字，只保留声明本身。
 *
 * 只在**行首**匹配 `export <keyword>`，因此 JSDoc 注释里出现的
 * "直接 import 本文件" 之类文本不会被误伤（它前面有 `*`，不在行首）。
 * 匹配出错会在这里直接抛错，而不是产出一个语法坏掉的 bundle。
 *
 * @param {string} code - 源区块正文。
 * @returns {string} 去掉 export 的正文。
 */
function stripExports(code) {
  return code.replace(/^export\s+(?=(?:const|let|var|function|class|async)\b)/gm, '');
}

const rulesSource = readFileSync(resolve(root, 'lib', 'rules.js'), 'utf8');
const mainSource = readFileSync(resolve(root, 'src', 'client.main.js'), 'utf8');

const rules = stripExports(region(rulesSource, 'rules'));
const css = stripExports(region(mainSource, 'css'));
const main = stripExports(region(mainSource, 'main'));
const dicts = stripExports(region(mainSource, 'dicts'));

// 具体语言词典打平：translate() 需要 {zh: {...}, en: {...}} 形态。
const dictsFlat = dicts.replace(/^export\s+const\s+DICTS/m, 'const DICTS');

const bundle = `/**
 * dsh-prompt-optimizer —— Client 半（自包含 bundle）。
 *
 * ⚠️ 本文件由 build/build-client.mjs 从 src/client.main.js + lib/rules.js 生成，
 *    请勿手工编辑；改源文件后重新执行 \`node build/build-client.mjs\`。
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
 *      \`SyntaxError: Illegal return statement\`，而且会污染整段 combo，
 *      连累同批次其它插件；症状是 \`web boot: 1 entry did not activate\`
 *      +\`... import failed\`，整个界面起不来。
 *   2. 注册方式是调用平台提供的 \`window.__ModuleLoader__.load\`，
 *      并由 \`factory\` 的**返回值**充当本模块的 exports：
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

${indent(rules, 2)}

${indent(css, 2)}

${indent(main, 2)}

${indent(dictsFlat, 2)}

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
`;

/**
 * 给多行代码统一缩进。
 * @param {string} code - 源码。
 * @param {number} spaces - 缩进空格数。
 * @returns {string} 缩进后的代码。
 */
function indent(code, spaces) {
  const pad = ' '.repeat(spaces);
  return code
    .split('\n')
    .map((line) => (line.trim().length === 0 ? '' : pad + line))
    .join('\n');
}

mkdirSync(resolve(root, 'lib'), { recursive: true });
writeFileSync(resolve(root, 'lib', 'client.js'), bundle, 'utf8');
process.stdout.write(`lib/client.js written (${bundle.length} bytes)\n`);
