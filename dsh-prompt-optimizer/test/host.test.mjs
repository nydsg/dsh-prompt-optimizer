/**
 * Host 半测试：配置收敛、HTTP 桥注册与端到端优化请求。
 *
 * 用假的 `webServer` / `llm` / `agentDefaultModel` 服务驱动真实代码路径，
 * 不依赖真实的 DSH 运行时，因此可以在 CI 里跑。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CONFIG, ROUTE_BASE, resolveConfig } from '../lib/index.js';
import { apply, inject } from '../lib/index.js';

/**
 * 造一个最小 Host 上下文。
 * @param {object} [options] - 服务替身。
 * @returns {{ctx: any, routes: Map<string, Function>, warnings: string[]}}
 */
function makeCtx(options = {}) {
  const routes = new Map();
  const warnings = [];
  const effects = [];
  const ctx = {
    logger: { warn: (message) => warnings.push(String(message)), info: () => {} },
    effect: (callback) => {
      effects.push(callback);
      const disposer = callback();
      return () => { if (typeof disposer === 'function') disposer(); };
    },
    get: (name) => {
      if (name === 'webServer') return { register: (route) => { routes.set(route.path, route.handler); return () => routes.delete(route.path); } };
      if (name === 'llm') return options.llm;
      if (name === 'agentDefaultModel') return options.defaultModel;
      return undefined;
    },
  };
  return { ctx, routes, warnings, effects };
}

/**
 * 构造一个假的 node 请求对象。
 * @param {string} method - HTTP 方法。
 * @param {object} [body] - JSON 请求体。
 * @returns {any} 可作为 IncomingMessage 使用的异步可迭代对象。
 */
function makeReq(method, body) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
  return {
    method,
    async *[Symbol.asyncIterator]() { for (const chunk of payload) yield chunk; },
    on: () => {},
  };
}

/**
 * 构造一个捕获响应的假 ServerResponse。
 * @returns {any} 响应替身，附带读取结果的辅助方法。
 */
function makeRes() {
  const state = { status: 0, body: '', headers: {}, written: false };
  return {
    writableEnded: false,
    on: () => {},
    writeHead(status, headers) { state.status = status; Object.assign(state.headers, headers ?? {}); },
    end(body) { state.body = String(body ?? ''); state.written = true; this.writableEnded = true; },
    json() { return JSON.parse(state.body); },
    state,
  };
}

test('inject 声明了 webServer 硬依赖', () => {
  assert.deepEqual(inject, ['webServer']);
});

test('debug 默认关闭，只有显式 true 才开', () => {
  assert.equal(DEFAULT_CONFIG.debug, false, '默认必须是关的');
  assert.equal(resolveConfig(undefined).debug, false);
  assert.equal(resolveConfig({}).debug, false);
  assert.equal(resolveConfig({ debug: 'yes' }).debug, false, 'truthy 字符串不算开启');
  assert.equal(resolveConfig({ debug: 1 }).debug, false);
  assert.equal(resolveConfig({ debug: true }).debug, true, '显式 true 才开');
});

test('/report 在 debug 关闭时不落盘', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx, {}); // 默认 debug=false
  const res = makeRes();
  await routes.get(`${ROUTE_BASE}/report`)(makeReq('POST', { phase: 'client:test-should-not-persist' }), res);
  const payload = res.json();
  assert.equal(payload.ok, true, '仍然正常应答，客户端不该因此报错');
  assert.equal(payload.stored, false);
  assert.equal(payload.reason, 'debug-disabled');

  // 真的没写进那个 JSONL —— 这是「缓存不再无限增长」的硬证据。
  const { readFileSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const diagPath = join(tmpdir(), 'dsh-prompt-optimizer-diag.jsonl');
  const content = existsSync(diagPath) ? readFileSync(diagPath, 'utf8') : '';
  assert.equal(
    content.includes('client:test-should-not-persist'),
    false,
    'debug 关闭时不该有任何内容写进自检日志',
  );
});

test('resolveConfig 收敛非法值而不抛错', () => {
  const fallback = resolveConfig(undefined);
  assert.equal(fallback.mode, DEFAULT_CONFIG.mode);
  assert.equal(fallback.temperature, DEFAULT_CONFIG.temperature);

  const bad = resolveConfig({ mode: 'nonsense', temperature: 'hot', maxTokens: -5, timeoutMs: 1, maxHistory: 0 });
  assert.equal(bad.mode, DEFAULT_CONFIG.mode, '非法 mode 回落默认');
  assert.equal(bad.temperature, DEFAULT_CONFIG.temperature, '非法 temperature 回落默认');
  assert.equal(bad.maxTokens, 256, '低于下界收敛到下界');
  assert.equal(bad.timeoutMs, 5000, '低于下界收敛到下界');
  assert.equal(bad.maxHistory, 1, '低于下界收敛到下界');

  const high = resolveConfig({ temperature: 99, maxTokens: 1e9, timeoutMs: 1e9, mode: 'rules', strictPreservation: true });
  assert.equal(high.temperature, 2);
  assert.equal(high.maxTokens, 32768);
  assert.equal(high.timeoutMs, 600000);
  assert.equal(high.mode, 'rules');
  assert.equal(high.strictPreservation, true);
});

test('apply 在无 webServer 时只告警不抛错', () => {
  const warnings = [];
  const ctx = {
    logger: { warn: (m) => warnings.push(String(m)), info: () => {} },
    effect: () => {},
    get: () => undefined,
  };
  assert.doesNotThrow(() => apply(ctx, {}));
  assert.ok(warnings.some((w) => w.includes('no webServer')), '应告警说明模型桥已禁用');
});

test('apply 注册 /info 与 /optimize 两条精确路由', () => {
  const { ctx, routes } = makeCtx();
  apply(ctx, {});
  assert.ok(routes.has(`${ROUTE_BASE}/info`), '缺少 /info 路由');
  assert.ok(routes.has(`${ROUTE_BASE}/optimize`), '缺少 /optimize 路由');
});

test('GET /info 报告能力与限额', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx, { mode: 'rules' });
  const res = makeRes();
  await routes.get(`${ROUTE_BASE}/info`)(makeReq('GET'), res);
  const payload = res.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.llm, false, '没有 llm 服务时应如实报告');
  assert.equal(payload.config.mode, 'rules');
  assert.equal(payload.limits.maxInputChars, 20000);
});

test('非 GET 访问 /info 返回 405', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx, {});
  const res = makeRes();
  await routes.get(`${ROUTE_BASE}/info`)(makeReq('POST'), res);
  assert.equal(res.state.status, 405);
});

test('非 POST 访问 /optimize 返回 405', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx, {});
  const res = makeRes();
  await routes.get(`${ROUTE_BASE}/optimize`)(makeReq('GET'), res);
  assert.equal(res.state.status, 405);
});

test('POST /optimize 空输入返回 400 与可读原因', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx, {});
  const res = makeRes();
  await routes.get(`${ROUTE_BASE}/optimize`)(makeReq('POST', { text: '   ' }), res);
  const payload = res.json();
  assert.equal(res.state.status, 400);
  assert.equal(payload.ok, false);
  assert.equal(payload.error, 'empty-input');
});

test('POST /optimize 非法 JSON 返回 400', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx, {});
  const req = {
    method: 'POST',
    async *[Symbol.asyncIterator]() { yield Buffer.from('{not json', 'utf8'); },
    on: () => {},
  };
  const res = makeRes();
  await routes.get(`${ROUTE_BASE}/optimize`)(req, res);
  assert.equal(res.state.status, 400);
  assert.equal(res.json().error, 'bad-json');
});

test('POST /optimize 在无模型时回落到规则引擎并返回可用结果', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx, { mode: 'auto' });
  const res = makeRes();
  await routes.get(`${ROUTE_BASE}/optimize`)(makeReq('POST', {
    text: '帮我写一个 Python 脚本，读取 CSV 并统计每列缺失率。不要用 pandas。验收标准：能跑通 10 万行。',
  }), res);
  const payload = res.json();
  assert.equal(res.state.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.engine, 'rules');
  assert.match(payload.text, /优化后的提示词/);
  assert.ok(payload.text.includes('不要用 pandas'));
  assert.equal(typeof payload.elapsedMs, 'number');
});

test('POST /optimize 在 mode=model 且无 llm 时明确失败而不是假装成功', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx, { mode: 'model' });
  const res = makeRes();
  await routes.get(`${ROUTE_BASE}/optimize`)(makeReq('POST', { text: '写个登录页' }), res);
  const payload = res.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.error, 'no-llm');
  assert.equal(res.state.status, 502);
});

test('POST /optimize 走模型路径：成功时返回 engine=model 与路由信息', async () => {
  /** 假的 llm 服务：产出两段文本分片并以 stop 收尾。 */
  const llm = {
    listProviders: () => [{ id: 'deepseek-account', name: 'DeepSeek' }],
    stream: async function* () {
      yield { type: 'text-delta', index: 0, text: '## 目标\n' };
      yield { type: 'text-delta', index: 0, text: '优化后的正文' };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const { ctx, routes } = makeCtx({ llm, defaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) } });
  apply(ctx, { mode: 'model', temperature: 0.2, maxTokens: 1024 });
  const res = makeRes();
  await routes.get(`${ROUTE_BASE}/optimize`)(makeReq('POST', { text: '写个登录页' }), res);
  const payload = res.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.engine, 'model');
  assert.equal(payload.text, '## 目标\n优化后的正文');
  assert.equal(payload.provider, 'deepseek-account');
  assert.equal(payload.model, 'deepseek-flash');
  assert.equal(payload.usage.outputTokens, 5);
});

test('POST /optimize 模型报错时（auto 模式）回落规则并附上失败原因', async () => {
  const llm = {
    listProviders: () => [],
    stream: async function* () {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'rate limited', code: 'rate-limit', status: 429 } } };
    },
  };
  const { ctx, routes } = makeCtx({ llm, defaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } });
  apply(ctx, { mode: 'auto' });
  const res = makeRes();
  await routes.get(`${ROUTE_BASE}/optimize`)(makeReq('POST', { text: '帮我写一个爬虫，要遵守 robots.txt' }), res);
  const payload = res.json();
  assert.equal(res.state.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.engine, 'rules', '应回落到规则引擎');
  assert.ok(payload.notes.some((note) => note.includes('rate limited')), '应把模型失败原因告知用户');
});

test('POST /optimize 模型返回空回复被当作失败', async () => {
  const llm = {
    listProviders: () => [],
    stream: async function* () { yield { type: 'finish', reason: { kind: 'stop' } }; },
  };
  const { ctx, routes } = makeCtx({ llm, defaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } });
  apply(ctx, { mode: 'model' });
  const res = makeRes();
  await routes.get(`${ROUTE_BASE}/optimize`)(makeReq('POST', { text: '写个登录页' }), res);
  const payload = res.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.error, 'empty-reply');
});

test('POST /optimize 命中 max-tokens 被当作失败而不是成功', async () => {
  const llm = {
    listProviders: () => [],
    stream: async function* () {
      yield { type: 'text-delta', index: 0, text: '半截' };
      yield { type: 'finish', reason: { kind: 'max-tokens' } };
    },
  };
  const { ctx, routes } = makeCtx({ llm, defaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } });
  apply(ctx, { mode: 'model' });
  const res = makeRes();
  await routes.get(`${ROUTE_BASE}/optimize`)(makeReq('POST', { text: '写个登录页' }), res);
  assert.equal(res.json().error, 'max-tokens');
});

test('POST /optimize 缺少默认模型时 auto 模式回落规则并说明', async () => {
  const llm = { listProviders: () => [], stream: async function* () {} };
  const { ctx, routes } = makeCtx({ llm, defaultModel: { currentSelection: () => undefined } });
  apply(ctx, { mode: 'auto' });
  const res = makeRes();
  await routes.get(`${ROUTE_BASE}/optimize`)(makeReq('POST', { text: '写一个排序算法并解释复杂度' }), res);
  const payload = res.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.engine, 'rules');
  assert.ok(payload.notes.some((note) => note.includes('no-route')), '应说明缺少路由');
});

test('POST /optimize 超长输入被截断并告知', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx, {});
  const res = makeRes();
  await routes.get(`${ROUTE_BASE}/optimize`)(makeReq('POST', { text: '需要处理的文本。'.repeat(4000) }), res);
  const payload = res.json();
  assert.equal(payload.truncated, true);
  assert.ok(payload.notes.some((note) => note.includes('截断')));
});

test('strictPreservation 会把额外保真约束放进系统提示词', async () => {
  let seenSystem = '';
  let seenUser = '';
  const llm = {
    listProviders: () => [],
    stream: async function* (options) {
      seenSystem = String(options.system ?? '');
      seenUser = String(options.messages?.[0]?.content?.[0]?.text ?? '');
      yield { type: 'text-delta', index: 0, text: 'ok' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const { ctx, routes } = makeCtx({ llm, defaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } });
  apply(ctx, { mode: 'model', strictPreservation: true });
  const res = makeRes();
  await routes.get(`${ROUTE_BASE}/optimize`)(makeReq('POST', { text: '写个登录页' }), res);
  // 系统提示词必须来自 prompt/optimizer-system.md —— 断言它确实体现了那套标准。
  assert.match(seenSystem, /不编造用户没有提供的事实/, '系统提示词应来自模板且含「不编造」原则');
  assert.match(seenSystem, /## 优化后的提示词/, '模板应规定三段式输出');
  assert.match(seenSystem, /## 主要优化点/, '模板应规定「主要优化点」');
  assert.match(seenSystem, /## 使用建议/, '模板应规定「使用建议」');
  assert.match(seenUser, /EXTRA FIDELITY GUARD/, '严格保真应追加额外约束');
  assert.match(seenUser, /<<<ORIGINAL_PROMPT/, '用户原文应放在明确分隔符内');
});

test('路由处理器永不 reject（承载层需要错误正文而不是空 500）', async () => {
  const { ctx, routes } = makeCtx();
  apply(ctx, {});
  const broken = {
    method: 'POST',
    [Symbol.asyncIterator]() { throw new Error('socket exploded'); },
    on: () => {},
  };
  const res = makeRes();
  await assert.doesNotReject(async () => {
    await routes.get(`${ROUTE_BASE}/optimize`)(broken, res);
  });
  assert.equal(res.json().ok, false);
});

// ---------------------------------------------------------------------------
// max-tokens 处理：这是实际踩过的坑 —— 推理模型的思考 token 也计入 maxTokens，
// 默认给 4096 时会被 max 强度推理吃光，答案还没写完就 finish(max-tokens)。
// ---------------------------------------------------------------------------

/** 造一个"第一次撞上限、抬上去才写完"的 llm 替身。 */
function makeMaxTokensLlm() {
  const seenMaxTokens = [];
  return {
    seenMaxTokens,
    listProviders: () => [],
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'minimal' }, { id: 'low' }, { id: 'max' }] } }),
    stream: async function* (options) {
      seenMaxTokens.push(options.maxTokens);
      if (seenMaxTokens.length === 1) {
        yield { type: 'finish', reason: { kind: 'max-tokens' } };
        return;
      }
      yield { type: 'text-delta', index: 0, text: '## 优化后的提示词\n\n### 目标\n写个登录页' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
}

test('撞到 max-tokens 时自动翻倍重试一次并成功', async () => {
  const llm = makeMaxTokensLlm();
  const { ctx, routes } = makeCtx({ llm, defaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } });
  apply(ctx, { mode: 'model', maxTokens: 4096 });
  const res = makeRes();
  await routes.get(`${ROUTE_BASE}/optimize`)(makeReq('POST', { text: '写个登录页' }), res);
  const payload = res.json();
  assert.equal(payload.ok, true, '重试后应成功');
  assert.equal(payload.engine, 'model');
  assert.deepEqual(llm.seenMaxTokens, [4096, 8192], '应先 4096 再翻倍到 8192');
  assert.ok(payload.notes.some((n) => n.includes('8192')), '应告知用户抬高了上限重试');
});

test('reasoningEffort=auto 时挑该模型支持的最低一档', async () => {
  const seenEffort = [];
  const llm = {
    listProviders: () => [],
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }, { id: 'high' }, { id: 'max' }] } }),
    stream: async function* (options) {
      seenEffort.push(options.reasoningEffort);
      yield { type: 'text-delta', index: 0, text: 'ok' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const { ctx, routes } = makeCtx({ llm, defaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } });
  apply(ctx, { mode: 'model' });
  const res = makeRes();
  await routes.get(`${ROUTE_BASE}/optimize`)(makeReq('POST', { text: '写个登录页' }), res);
  assert.equal(res.json().ok, true);
  assert.deepEqual(seenEffort, ['low'], '应选最低可用档 low，而不是 max');
});

test('模型不报推理能力时不传 reasoningEffort（避免被服务端拒绝）', async () => {
  const seenEffort = [];
  const llm = {
    listProviders: () => [],
    resolveModelInfo: async () => ({}),
    stream: async function* (options) {
      seenEffort.push(options.reasoningEffort);
      yield { type: 'text-delta', index: 0, text: 'ok' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const { ctx, routes } = makeCtx({ llm, defaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } });
  apply(ctx, { mode: 'model' });
  const res = makeRes();
  await routes.get(`${ROUTE_BASE}/optimize`)(makeReq('POST', { text: '写个登录页' }), res);
  assert.equal(res.json().ok, true);
  assert.deepEqual(seenEffort, [undefined], '不该瞎传强度');
});

test('resolveModelInfo 抛错时也不传 reasoningEffort', async () => {
  const seenEffort = [];
  const llm = {
    listProviders: () => [],
    resolveModelInfo: async () => { throw new Error('no capability info'); },
    stream: async function* (options) {
      seenEffort.push(options.reasoningEffort);
      yield { type: 'text-delta', index: 0, text: 'ok' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const { ctx, routes } = makeCtx({ llm, defaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } });
  apply(ctx, { mode: 'model' });
  const res = makeRes();
  await routes.get(`${ROUTE_BASE}/optimize`)(makeReq('POST', { text: '写个登录页' }), res);
  assert.equal(res.json().ok, true);
  assert.deepEqual(seenEffort, [undefined]);
});

test('显式 reasoningEffort 会被原样传递', async () => {
  const seenEffort = [];
  const llm = {
    listProviders: () => [],
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'max' }] } }),
    stream: async function* (options) {
      seenEffort.push(options.reasoningEffort);
      yield { type: 'text-delta', index: 0, text: 'ok' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const { ctx, routes } = makeCtx({ llm, defaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } });
  apply(ctx, { mode: 'model', reasoningEffort: 'max' });
  const res = makeRes();
  await routes.get(`${ROUTE_BASE}/optimize`)(makeReq('POST', { text: '写个登录页' }), res);
  assert.deepEqual(seenEffort, ['max'], '用户显式指定的强度优先');
});

test('一直撞 max-tokens 时回落规则引擎，并给出可执行的办法', async () => {
  const llm = {
    listProviders: () => [],
    resolveModelInfo: async () => ({}),
    stream: async function* () {
      yield { type: 'finish', reason: { kind: 'max-tokens' } };
    },
  };
  const { ctx, routes } = makeCtx({ llm, defaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } });
  apply(ctx, { mode: 'auto', maxTokens: 4096 });
  const res = makeRes();
  await routes.get(`${ROUTE_BASE}/optimize`)(makeReq('POST', { text: '帮我写一个 Python 脚本，读取 CSV 并统计每列缺失率。不要用 pandas。验收标准：能跑通 10 万行。' }), res);
  const payload = res.json();
  assert.equal(payload.ok, true, 'auto 模式应回落而不是失败');
  assert.equal(payload.engine, 'rules');
  const joined = payload.notes.join('\n');
  assert.match(joined, /max-tokens/);
  assert.match(joined, /思考 token|thinking tokens/, '要说清推理 token 也计入上限');
  assert.match(joined, /16384|reasoningEffort|rules/, '要给出可执行的解决办法');
});

test('retryOnMaxTokens=false 时不重试', async () => {
  const seen = [];
  const llm = {
    listProviders: () => [],
    resolveModelInfo: async () => ({}),
    stream: async function* (options) {
      seen.push(options.maxTokens);
      yield { type: 'finish', reason: { kind: 'max-tokens' } };
    },
  };
  const { ctx, routes } = makeCtx({ llm, defaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } });
  apply(ctx, { mode: 'auto', maxTokens: 4096, retryOnMaxTokens: false });
  const res = makeRes();
  await routes.get(`${ROUTE_BASE}/optimize`)(makeReq('POST', { text: '写个登录页' }), res);
  assert.deepEqual(seen, [4096], '关掉重试后只调一次');
  assert.equal(res.json().engine, 'rules');
});
