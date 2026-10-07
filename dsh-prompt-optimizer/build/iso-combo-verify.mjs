/**
 * 决定性验证：把服务器真实吐出的 combo script 当成**经典脚本**解析。
 *
 * 这就是用户那次崩溃的复现路径 —— 浏览器把多个插件的 client.js 拼成一个
 * combo script 用 <script> 加载，任何一个 bundle 里有顶层 return，
 * 整段脚本都会 `SyntaxError: Illegal return statement`，
 * 于是 `web boot: 1 entry did not activate`，界面起不来。
 *
 * 本脚本：
 *   1. 用 token 握手拿首页，解析 boot graph；
 *   2. 找**包含本插件**的那条 combo URL，整段抓下来；
 *   3. 用 vm.Script（脚本模式）解析 —— 必须成功；
 *   4. 在带 window.__ModuleLoader__ 的沙箱里真正执行它，
 *      断言多个插件都完成注册、且本插件的 factory 能返回 exports；
 *   5. 再对「本插件单独一条 combo」重复一遍。
 *
 * 用法：node build/iso-combo-verify.mjs <token> [port]
 */
import vm from 'node:vm';

const PORT = process.argv[3] ?? '19901';
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = process.argv[2] ?? '';

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

// ---- 1. 握手 + boot graph ----
const handshake = await fetch(`${BASE}/?token=${encodeURIComponent(TOKEN)}`, { redirect: 'manual' });
const jar = (handshake.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
const page = await fetch(`${BASE}/`, { headers: { cookie: jar } });
const html = await page.text();
check(page.status === 200, '首页可访问', `HTTP ${page.status}, ${html.length} 字节`);

const at = html.indexOf('__DSH_BOOT__');
const start = html.indexOf('{', at);
let depth = 0; let end = -1; let inStr = false; let esc = false;
for (let i = start; i < html.length; i += 1) {
  const ch = html[i];
  if (esc) { esc = false; continue; }
  if (ch === '\\') { esc = true; continue; }
  if (ch === '"') { inStr = !inStr; continue; }
  if (inStr) continue;
  if (ch === '{') depth += 1;
  else if (ch === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
}
const graph = JSON.parse(html.slice(start, end));
check(Array.isArray(graph.entries), 'boot graph 可解析');

// ---- 2. 找含本插件的 combo ----
const combos = [...new Set([...html.matchAll(/plugins\/\?\?[^"'\s]*?&(?:amp;)?rev=[0-9a-f]+/g)].map((m) => m[0].replace(/&amp;/g, '&')))];
console.log(`  页面里共 ${combos.length} 条 combo`);
const mine = combos.filter((u) => u.includes('dsh-prompt-optimizer'));
check(mine.length >= 1, '存在包含本插件的 combo', mine[0] ?? '(无)');

/**
 * 抓一条 combo 并当经典脚本解析 + 执行。
 * @param {string} url - combo 路径。
 * @param {string} label - 用例名。
 */
async function verifyCombo(url, label) {
  console.log(`\n--- ${label} ---`);
  console.log('  URL:', url.length > 160 ? `${url.slice(0, 160)}…` : url);
  const response = await fetch(`${BASE}/${url}`, { headers: { cookie: jar } });
  const text = await response.text();
  check(response.status === 200, 'combo 返回 200', `HTTP ${response.status}, ${text.length} 字节`);

  // 关键：脚本模式解析（顶层 return 会在这里炸）
  let parseError = null;
  try {
    new vm.Script(text, { filename: url });
  } catch (error) {
    parseError = error;
  }
  check(parseError === null, 'combo 作为经典脚本可解析', parseError ? parseError.message : '');

  // 真正执行：沙箱里放 window.__ModuleLoader__
  const registered = [];
  const sandbox = {
    console,
    window: { __ModuleLoader__: { load: (definition) => registered.push(definition) } },
    document: undefined,
    navigator: undefined,
  };
  sandbox.globalThis = sandbox;
  let runError = null;
  try {
    new vm.Script(text, { filename: url }).runInContext(vm.createContext(sandbox));
  } catch (error) {
    runError = error;
  }
  check(runError === null, 'combo 可执行', runError ? runError.message : '');
  check(registered.length > 0, `注册了 ${registered.length} 个插件定义`);
  const ids = registered.map((r) => r.id);
  check(ids.includes('dsh-prompt-optimizer'), '其中包含本插件', ids.slice(0, 6).join(', '));

  // 本插件的 factory 必须能返回 exports
  const def = registered.find((r) => r.id === 'dsh-prompt-optimizer');
  if (def !== undefined) {
    const reactStub = {
      createElement: (...a) => ({ t: a[0] }),
      Fragment: Symbol('F'),
      useState: (i) => [i, () => {}],
      useEffect: () => {},
      useRef: (i) => ({ current: i }),
      useMemo: (f) => f(),
      memo: (c) => c,
    };
    let exports = null;
    let factoryError = null;
    try {
      exports = def.factory((spec) => {
        if (spec === 'react') return reactStub;
        throw new Error(`unexpected require: ${spec}`);
      });
    } catch (error) {
      factoryError = error;
    }
    check(factoryError === null, 'factory 调用成功', factoryError ? factoryError.message : '');
    check(exports !== null && typeof exports.apply === 'function', 'factory 返回了 apply');
    check(exports !== null && Array.isArray(exports.inject), 'factory 返回了 inject', JSON.stringify(exports?.inject));
  }
  return { count: registered.length, ids };
}

// ---- 3. 逐条验证 ----
if (mine.length > 0) await verifyCombo(mine[0], '包含本插件的 combo（与其它插件同批加载）');
const alone = combos.find((u) => u.includes('dsh-prompt-optimizer') && (u.match(/client\.js/g) ?? []).length === 1);
if (alone !== undefined && alone !== mine[0]) await verifyCombo(alone, '本插件单独一条 combo');
else if (mine.length > 0) console.log('\n（本插件没有单条 combo，它只出现在组合批次里）');

console.log(failures === 0
  ? '\n== COMBO VERIFY: ALL PASS —— 修好的 bundle 在真实 combo script 里可解析、可执行、可注册 =='
  : `\n== COMBO VERIFY: ${failures} 项失败 ==`);
process.exitCode = failures === 0 ? 0 : 1;
