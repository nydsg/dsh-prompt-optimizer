/**
 * 隔离实例端到端验证（权威版）。
 *
 * 在临时 DSH_HOME 里用真实 `dsh web` 启动，逐个验证：
 *   A. 鉴权握手 + 首页可开
 *   B. boot graph 里本插件被注册为一个 client bundle 条目
 *   C. 该 bundle 的**真实 URL**（从 boot graph 读出来）确实返回 200 且是本插件的代码
 *   D. Host 桥 /info 与 /optimize 真实可用（含保真断言）
 *   E. 错误路径：空输入 400 / 方法不对 405 / 非法 JSON 400
 *
 * 全程只发本地 HTTP 请求，不写用户 profile。
 *
 * 用法：node build/iso-verify.mjs <token> [port]
 */
const PORT = process.argv[3] ?? '19887';
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = process.argv[2] ?? '';

let jar = '';
/** 带会话 cookie 的请求。 */
async function request(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (jar) headers.cookie = jar;
  return fetch(`${BASE}${path}`, { ...options, headers, redirect: options.redirect ?? 'manual' });
}

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

console.log('=== A. 鉴权握手与首页 ===');
const handshake = await request(`/?token=${encodeURIComponent(TOKEN)}`);
jar = (handshake.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
check(handshake.status === 303, 'token 换取会话 cookie', `HTTP ${handshake.status}`);
const page = await request('/');
const html = await page.text();
check(page.status === 200, '首页可访问', `HTTP ${page.status}, ${html.length} 字节`);
check(html.includes('__DSH_BOOT__'), '首页含 boot graph');

console.log('\n=== B. boot graph 注册了本插件的 client bundle ===');
let graph = null;
const at = html.indexOf('__DSH_BOOT__');
if (at >= 0) {
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
  if (end > 0) { try { graph = JSON.parse(html.slice(start, end)); } catch { graph = null; } }
}
check(graph !== null && Array.isArray(graph.entries), 'boot graph 可解析且含 entries');
const entry = graph?.entries?.find((e) => e.id === 'dsh-prompt-optimizer');
check(entry !== undefined, 'entries 中存在 id=dsh-prompt-optimizer');
check(typeof entry?.url === 'string' && entry.url.length > 0, '该条目带 bundle url', String(entry?.url));
check(typeof entry?.rev === 'string' && entry.rev.length > 0, '该条目带 rev', String(entry?.rev));

console.log('\n=== C. 从 boot graph 读出的真实 URL 能取到 bundle ===');
let bundleText = '';
if (entry?.url) {
  // boot graph 里的 url 是相对文档的；`??` 组合路由要用原始形态请求
  const url = `/${entry.url.replace(/&amp;/g, '&')}`;
  console.log('  请求:', url);
  const res = await request(url);
  bundleText = await res.text();
  check(res.status === 200, 'bundle 返回 200', `HTTP ${res.status}`);
  check(bundleText.length > 10000, 'bundle 体积合理', `${bundleText.length} 字节`);
  check(bundleText.includes('createClientPlugin'), '含插件工厂 createClientPlugin');
  check(bundleText.includes('conversation.input.right'), '注册了输入框工具条插槽');
  check(bundleText.includes('conversation.input.dock'), '注册了结果面板插槽');
  check(bundleText.includes('优化提示词'), '含中文按钮文案');
  check(bundleText.includes('/plugin-prompt-optimizer'), '含 Host 桥路由前缀');
  check(bundleText.includes('return __bundleExports;'), '显式 return 导出（防 V8 完成值丢弃）');
  check(/\(\s*function\s*\(\s*require\s*\)/.test(bundleText), '是工厂形式（IIFE 立即调用）');
  check(!/^\s*export\s/m.test(bundleText), '不含 ESM export（否则工厂加载会语法报错）');
} else {
  check(false, '无法取 bundle（boot graph 没给出 url）');
}

console.log('\n=== D. Host 桥真实可用 ===');
const infoRes = await request('/plugin-prompt-optimizer/info');
const info = await infoRes.json().catch(() => null);
check(infoRes.status === 200 && info?.ok === true, 'GET /info 200 且 ok=true');
check(info?.limits?.maxInputChars === 20000, 'limits.maxInputChars=20000', String(info?.limits?.maxInputChars));
check(typeof info?.llm === 'boolean', 'llm 能力如实上报', String(info?.llm));

const text = '帮我写一个 Python 脚本，读取 CSV 并统计每列缺失率。不要用 pandas。验收标准：能跑通 10 万行。';
const optRes = await request('/plugin-prompt-optimizer/optimize', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
});
const opt = await optRes.json().catch(() => null);
check(optRes.status === 200 && opt?.ok === true, 'POST /optimize 200 且 ok=true');
check(typeof opt?.text === 'string' && opt.text.length > 100, '产出优化文本', `${opt?.text?.length} 字符`);
check(['model', 'rules'].includes(opt?.engine), 'engine 标注正确', String(opt?.engine));
check(opt?.text?.includes('不要用 pandas'), '保真：保留「不要用 pandas」');
check(opt?.text?.includes('10 万行'), '保真：保留验收标准「10 万行」');
check(opt?.text?.includes('Python'), '保真：保留专有名词 Python');
check(Array.isArray(opt?.gaps), 'gaps 为数组');
check(typeof opt?.elapsedMs === 'number', 'elapsedMs 存在', `${opt?.elapsedMs}ms`);

console.log('\n=== E. 错误路径 ===');
const emptyRes = await request('/plugin-prompt-optimizer/optimize', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '   ' }),
});
const empty = await emptyRes.json().catch(() => null);
check(emptyRes.status === 400 && empty?.error === 'empty-input', '空输入 -> 400 empty-input', `HTTP ${emptyRes.status}/${empty?.error}`);

const methodRes = await request('/plugin-prompt-optimizer/optimize');
check(methodRes.status === 405, 'GET /optimize -> 405', `HTTP ${methodRes.status}`);

const badRes = await request('/plugin-prompt-optimizer/optimize', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
});
check(badRes.status === 400, '非法 JSON -> 400', `HTTP ${badRes.status}`);

console.log(failures === 0
  ? '\n== ISO VERIFY: ALL PASS —— 隔离实例上插件 Host 桥与 Client bundle 端到端可用 =='
  : `\n== ISO VERIFY: ${failures} 项失败 ==`);
process.exitCode = failures === 0 ? 0 : 1;
