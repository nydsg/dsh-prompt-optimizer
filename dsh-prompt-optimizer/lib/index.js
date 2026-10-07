/**
 * dsh-prompt-optimizer —— Host 半。
 *
 * 职责：
 *   1. 读取并校验插件配置（配置项见 README / `resolveConfig`）。
 *   2. 通过 `ctx.llm`（DSH 自己的模型服务）执行模型优化，无需任何插件私有 API Key。
 *   3. 通过 `ctx.webServer` 暴露同源 HTTP 桥 `/plugin-prompt-optimizer/*`，
 *      供 Client 半取回优化结果；没有 webServer 时插件降级为纯本地规则模式。
 *   4. 模型不可用时自动回落到 `lib/rules.js` 的本地规则引擎，保证离线可用。
 *
 * 为什么不自己管 API Key：DSH 已经用 `ctx.llm` 抽象了模型路由与凭据，
 * 插件的默认路由取自用户在「设置 → 模型」里选定的默认模型（agentDefaultModel）。
 * 这样插件零配置即可工作，也不需要在磁盘上多存一份密钥。
 *
 * @module dsh-prompt-optimizer
 */
import { readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LONG_INPUT_THRESHOLD,
  MAX_INPUT_CHARS,
  detectLanguage,
  normalizeText,
  optimizeLocally,
} from './rules.js';

/** 路由前缀。刻意取得足够独特，避免与其他插件的同源路由冲突。 */
const ROUTE_BASE = '/plugin-prompt-optimizer';

/** 请求体上限（字节）。 */
const MAX_BODY_BYTES = 512 * 1024;

/**
 * Client 半自检报告落盘位置。
 *
 * 放在临时目录：好找、不污染 profile、也不需要任何权限。
 * 排查「按钮没出现」时直接读这个文件即可。
 */
const DIAG_PATH = join(tmpdir(), 'dsh-prompt-optimizer-diag.jsonl');

/** 配置默认值。 */
const DEFAULTS = Object.freeze({
  /** auto | model | rules —— auto 表示「有模型就用模型，失败回落规则」。 */
  mode: 'auto',
  temperature: 0.3,
  /**
   * 单次回复的 token 上限。
   *
   * 为什么默认给到 8192：**推理模型的思考 token 计入这个上限**
   * （`GenerateOptions.maxTokens` 约束的是整次输出，`TokenUsage` 里单独统计
   * `reasoningTokens`）。默认的 4096 会被 max 强度推理吃光，
   * 于是 `finish.reason` 变成 `max-tokens`、答案还没写完就断了。
   */
  maxTokens: 8192,
  /**
   * 推理强度。'auto' = 探测该模型支持的最低一档（改写任务不需要深推理）；
   * 也可显式填 minimal|low|medium|high|max。
   *
   * 注意：llm 服务对**不支持的显式强度**会直接拒绝（不做钳制或别名），
   * 所以 'auto' 只在该模型确实支持时才传。
   */
  reasoningEffort: 'auto',
  /** 撞到 max-tokens 时，是否把上限翻倍重试一次。 */
  retryOnMaxTokens: true,
  timeoutMs: 60_000,
  /** 模型连续失败多少次后，本次进程内直接走规则引擎（避免每次点击都等超时）。 */
  failureCircuitThreshold: 3,
  /** 追加「严格保真」约束，进一步压低模型自由发挥。 */
  strictPreservation: false,
  /** 会话内保留的优化历史条数（仅供 Client 撤销使用，Host 不持久化）。 */
  maxHistory: 10,
  /**
   * 排障开关：把 Client 半加载/注册/渲染的关键节点写进
   * `%TEMP%/dsh-prompt-optimizer-diag.jsonl`。
   *
   * 默认关闭 —— 它是**排障工具，不是常驻功能**。开着的时候每次启动都会写十几行，
   * 长期只增不减；客户端每个阶段还会多发一次 fetch。需要定位「按钮不出现 /
   * 插槽没触发 / 渲染异常」这类宿主侧静默的客户端问题时，临时打开它。
   */
  debug: false,
});

const MODES = new Set(['auto', 'model', 'rules']);

/** 推理强度从低到高（用于 'auto' 挑最低可用档）。 */
const EFFORT_ORDER = Object.freeze(['minimal', 'low', 'medium', 'high', 'max']);

/** 重试时 maxTokens 允许抬到的上限。 */
const MAX_TOKENS_CEILING = 32_768;

/**
 * 把任意输入收敛为有限区间内的整数。
 * @param {unknown} value - 原始值。
 * @param {number} min - 下界（含）。
 * @param {number} max - 上界（含）。
 * @param {number} fallback - 非法时的回退值。
 * @returns {number} 合法整数。
 */
function clampInt(value, min, max, fallback) {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

/**
 * 把任意输入收敛为有限区间内的浮点数。
 * @param {unknown} value - 原始值。
 * @param {number} min - 下界（含）。
 * @param {number} max - 上界（含）。
 * @param {number} fallback - 非法时的回退值。
 * @returns {number} 合法浮点数。
 */
function clampFloat(value, min, max, fallback) {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

/**
 * 解析并校验插件配置。非法值一律回落到默认值而不是抛错，
 * 因为一个配置项写错不该让整个插件在 loader 阶段挂掉。
 * @param {unknown} raw - loader 传入的配置对象。
 * @returns {typeof DEFAULTS} 归一化配置。
 */
export function resolveConfig(raw) {
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const mode = typeof input.mode === 'string' && MODES.has(input.mode) ? input.mode : DEFAULTS.mode;
  // 推理强度：'auto' 或 EFFORT_ORDER 里的某一档；其它值一律回落 'auto'。
  const effortRaw = input.reasoningEffort;
  const reasoningEffort = effortRaw === 'auto' || EFFORT_ORDER.includes(effortRaw)
    ? effortRaw
    : DEFAULTS.reasoningEffort;
  return {
    mode,
    temperature: clampFloat(input.temperature, 0, 2, DEFAULTS.temperature),
    maxTokens: clampInt(input.maxTokens, 256, MAX_TOKENS_CEILING, DEFAULTS.maxTokens),
    reasoningEffort,
    retryOnMaxTokens: input.retryOnMaxTokens === undefined ? DEFAULTS.retryOnMaxTokens : input.retryOnMaxTokens === true,
    timeoutMs: clampInt(input.timeoutMs, 5_000, 600_000, DEFAULTS.timeoutMs),
    failureCircuitThreshold: clampInt(input.failureCircuitThreshold, 1, 100, DEFAULTS.failureCircuitThreshold),
    strictPreservation: input.strictPreservation === true,
    maxHistory: clampInt(input.maxHistory, 1, 100, DEFAULTS.maxHistory),
    debug: input.debug === true,
  };
}

/**
 * 为本次改写挑一个安全的推理强度。
 *
 * 推理强度会影响成本与"思考 token 挤占输出上限"的风险；改写任务不需要深推理。
 * 但对**不支持的显式强度**，llm 服务会直接拒绝（不做钳制或别名），所以：
 *   - 显式配置了就照传（用户自己的判断优先）；
 *   - 'auto' 时先问 `resolveModelInfo` 该模型支持哪些档，取最低一档；
 *   - 问不到就**不传**，交给适配器默认值 —— 宁可用默认，也不要因为瞎传而被拒。
 *
 * @param {any} llm - llm 服务。
 * @param {string} provider - provider 路由。
 * @param {string} model - 模型 id。
 * @param {'auto'|string} setting - 配置值。
 * @param {AbortSignal} signal - 取消信号。
 * @returns {Promise<string|undefined>} 要传的推理强度，或 undefined 表示不传。
 */
async function pickReasoningEffort(llm, provider, model, setting, signal) {
  if (setting !== 'auto') return setting;
  try {
    if (typeof llm.resolveModelInfo !== 'function') return undefined;
    const info = await llm.resolveModelInfo(provider, model, signal);
    const efforts = Array.isArray(info?.reasoning?.efforts)
      ? info.reasoning.efforts.map((entry) => String(entry?.id ?? '')).filter((id) => id.length > 0)
      : [];
    if (efforts.length === 0) return undefined;
    const lowest = EFFORT_ORDER.find((id) => efforts.includes(id));
    return lowest ?? efforts[0];
  } catch {
    // 探测失败（模型不报能力、适配器不支持等）—— 不传，用适配器默认。
    return undefined;
  }
}

/**
 * 读取随包分发的系统提示词模板；读不到则回退到内置的最短版本。
 * 模板与代码分离，方便用户不改代码就调优提示词工程。
 * @param {string} name - 模板文件名。
 * @returns {string} 模板正文。
 */
function loadTemplate(name) {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return readFileSync(resolvePath(here, '..', 'prompt', name), 'utf8').trim();
  } catch {
    return 'You are a prompt engineer. Rewrite the user prompt into a clearer, more specific, more executable version. Preserve the original intent and every key detail; never invent facts. Output only the rewritten prompt in Markdown.';
  }
}

/**
 * 发送一个 JSON 响应。
 *
 * 刻意吞掉写入异常：连接可能已被浏览器关闭，此时再抛错只会污染承载层日志。
 * @param {import('node:http').ServerResponse} res - 响应对象。
 * @param {number} status - HTTP 状态码。
 * @param {unknown} payload - 将被 JSON 序列化的载荷。
 * @returns {void}
 */
function sendJson(res, status, payload) {
  try {
    if (res.writableEnded) return;
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    /* 连接已断开：没有接收方需要这个错误。 */
  }
}

/**
 * 读取并解析请求体，带大小上限。
 * @param {import('node:http').IncomingMessage} req - 请求对象。
 * @returns {Promise<{ok: true, value: any} | {ok: false, error: string, message: string}>} 解析结果。
 */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return { ok: false, error: 'body-too-large', message: `body exceeds ${MAX_BODY_BYTES} bytes` };
    chunks.push(chunk);
  }
  if (chunks.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  } catch (error) {
    return { ok: false, error: 'bad-json', message: `body is not valid JSON: ${String(error?.message ?? error)}` };
  }
}

/**
 * 取 `llm` 服务（可选依赖，不做硬依赖以免拖住插件启动）。
 * @param {any} ctx - Host 上下文。
 * @returns {any | undefined} llm 服务或 undefined。
 */
function llmService(ctx) {
  try {
    const llm = ctx.get('llm');
    return llm !== undefined && typeof llm.stream === 'function' ? llm : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 解析本次调用使用的 provider/model 路由。
 * 请求可覆盖；缺省取用户在 DSH 设置里的默认模型 —— 零配置即可工作。
 * @param {any} ctx - Host 上下文。
 * @param {{provider?: string, model?: string}} request - 归一化请求。
 * @returns {{ok: true, provider: string, model: string} | {ok: false, error: string, message: string}} 路由结果。
 */
function resolveRoute(ctx, request) {
  let fallback = {};
  try {
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.();
    if (selection !== null && typeof selection === 'object') fallback = selection;
  } catch {
    /* 没有默认模型：必须由请求自带路由。 */
  }
  const provider = String(request.provider ?? '').length > 0 ? String(request.provider) : String(fallback.provider ?? '');
  const model = String(request.model ?? '').length > 0 ? String(request.model) : String(fallback.model ?? '');
  if (provider.length === 0 || model.length === 0) {
    return {
      ok: false,
      error: 'no-route',
      message: 'no provider/model available: pass them in the request body or set a default model in DSH settings',
    };
  }
  return { ok: true, provider, model };
}

/**
 * 归一化一次优化请求。
 * @param {unknown} value - 请求体。
 * @returns {{ok: true, request: object} | {ok: false, error: string, message: string}} 归一化结果。
 */
function normalizeRequest(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'bad-request', message: 'the body must be a JSON object' };
  }
  const raw = typeof value.text === 'string' ? value.text : '';
  if (raw.trim().length === 0) {
    return { ok: false, error: 'empty-input', message: '`text` (the prompt to optimize) is required and must not be blank' };
  }
  const normalized = normalizeText(raw);
  const truncated = normalized.length > MAX_INPUT_CHARS;
  return {
    ok: true,
    request: {
      text: truncated ? normalized.slice(0, MAX_INPUT_CHARS) : normalized,
      truncated,
      originalChars: normalized.length,
      provider: typeof value.provider === 'string' ? value.provider : '',
      model: typeof value.model === 'string' ? value.model : '',
      // 语言可由 Client 指定（用户在 UI 上切换），否则由 Host 探测。
      lang: value.lang === 'zh' || value.lang === 'en' ? value.lang : detectLanguage(normalized),
      // 极端情况下允许单次请求覆盖温度/上限，但仍在配置区间内收敛。
      temperature: value.temperature,
      maxTokens: value.maxTokens,
      mode: typeof value.mode === 'string' && MODES.has(value.mode) ? value.mode : undefined,
    },
  };
}

/**
 * 拼装最终发给模型的用户消息。
 * 把用户原文放在明确的分隔符内，降低模型把「模板说明」误当成用户需求的概率。
 * @param {string} template - 系统提示词模板。
 * @param {object} request - 归一化请求。
 * @param {object} config - 归一化配置。
 * @returns {{system: string, user: string}} 两条消息。
 */
function buildMessages(template, request, config) {
  const guard = config.strictPreservation
    ? [
        '',
        '## EXTRA FIDELITY GUARD (this run)',
        '- If a fact is not in the original prompt, do not state it — use a `<PLACEHOLDER: ...>` marker instead.',
        '- Do not add technology choices, versions, file names, numbers, or requirements the user did not write.',
        '- Keep every identifier, path, URL and code fragment byte-for-byte identical.',
      ].join('\n')
    : '';
  const user = [
    'Rewrite the prompt delimited by the markers below.',
    '',
    '<<<ORIGINAL_PROMPT',
    request.text,
    'ORIGINAL_PROMPT',
    '',
    `Detected language: ${request.lang === 'zh' ? 'Chinese (zh)' : 'English (en)'}. Write the optimized prompt in that same language.`,
    'Return only the optimized prompt. Do not add commentary before or after it.',
    guard,
  ].join('\n');
  return { system: template, user };
}

/**
 * 执行一次模型优化并取回完整文本。
 *
 * `ctx.llm.stream` 把适配器/派发/迭代失败表达为终止性的 `finish` 分片，
 * 因此必须检查 finish reason，而不是把「空回复」当成成功。
 *
 * @param {any} llm - llm 服务。
 * @param {{system: string, user: string, provider: string, model: string, temperature: number, maxTokens: number, signal: AbortSignal, sessionId?: string}} options - 调用参数。
 * @returns {Promise<{text: string, usage: object | null}>} 模型回复。
 */
async function streamOptimization(llm, options) {
  /** @type {Record<string, unknown>} */
  const request = {
    provider: options.provider,
    model: options.model,
    messages: [{ role: 'user', content: [{ type: 'text', text: options.user }] }],
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    signal: options.signal,
  };
  if (typeof options.system === 'string' && options.system.length > 0) request.system = options.system;
  // 只在确实挑到一档可用强度时才传：不支持的显式强度会被 llm 服务直接拒绝。
  if (typeof options.reasoningEffort === 'string' && options.reasoningEffort.length > 0) {
    request.reasoningEffort = options.reasoningEffort;
  }

  let deltas = '';
  const blocks = [];
  let usage = null;
  let reason;
  for await (const chunk of llm.stream(request)) {
    if (chunk === null || typeof chunk !== 'object') continue;
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') deltas += chunk.text;
    else if (chunk.type === 'block-end' && typeof chunk.block?.text === 'string') blocks.push(chunk.block.text);
    else if (chunk.type === 'usage' && typeof chunk.usage === 'object') usage = chunk.usage;
    else if (chunk.type === 'finish') reason = chunk.reason;
  }
  if (reason !== null && typeof reason === 'object') {
    if (reason.kind === 'error' || reason.kind === 'aborted') {
      const failure = reason.failure ?? {};
      const error = new Error(String(failure.message ?? reason.kind));
      error.code = String(failure.code ?? reason.kind);
      error.status = failure.status;
      throw error;
    }
    if (reason.kind === 'max-tokens') {
      const error = new Error('the model hit the max-token ceiling before finishing the rewrite');
      error.code = 'max-tokens';
      throw error;
    }
  }
  const text = (deltas.trim().length > 0 ? deltas : blocks.join('')).trim();
  if (text.length === 0) {
    const error = new Error('the model returned an empty reply');
    error.code = 'empty-reply';
    throw error;
  }
  return { text, usage };
}

/**
 * Host 半入口。
 * @param {any} ctx - Host 上下文。
 * @param {unknown} rawConfig - loader 配置。
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  const template = loadTemplate('optimizer-system.md');
  const warn = (message) => ctx.logger?.warn?.(`[dsh-prompt-optimizer] ${message}`);

  /** 连续模型失败计数：达到阈值后本进程内直接走规则引擎，避免每次点击都白等一次超时。 */
  let consecutiveFailures = 0;

  const webServer = (() => {
    try {
      const service = ctx.get('webServer');
      return service !== undefined && typeof service.register === 'function' ? service : undefined;
    } catch {
      return undefined;
    }
  })();

  if (webServer === undefined) {
    warn('no webServer in this composition — the model bridge is disabled and only the offline rule engine is reachable');
  }

  /**
   * 执行一次优化：按配置与当前熔断状态选择模型路径或规则路径。
   * @param {object} request - 归一化请求。
   * @param {AbortSignal} signal - 取消信号。
   * @returns {Promise<object>} 优化结果。
   */
  async function optimize(request, signal) {
    const mode = request.mode ?? config.mode;
    const llm = llmService(ctx);
    const shouldTryModel =
      mode === 'model' || (mode === 'auto' && llm !== undefined && consecutiveFailures < config.failureCircuitThreshold);

    /** @type {string[]} */
    const notes = [];
    if (request.truncated) {
      notes.push(
        request.lang === 'zh'
          ? `原文 ${request.originalChars} 字符，超过 ${MAX_INPUT_CHARS} 上限，已截断后优化。`
          : `Input was ${request.originalChars} characters, over the ${MAX_INPUT_CHARS} limit, and was truncated.`,
      );
    }

    if (mode === 'model' && llm === undefined) {
      return {
        ok: false,
        error: 'no-llm',
        message: 'mode is "model" but this composition has no `llm` service; set mode to "auto" or "rules"',
      };
    }

    if (shouldTryModel) {
      const route = resolveRoute(ctx, request);
      if (route.ok) {
        const controller = new AbortController();
        const onAbort = () => controller.abort(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(() => controller.abort(new Error('timeout')), config.timeoutMs);
        /** 本次实际尝试过的输出上限，catch 里要用它给出可执行的建议（故声明在 try 之外）。 */
        const tried = [];
        try {
          const messages = buildMessages(template, request, config);
          const effort = await pickReasoningEffort(llm, route.provider, route.model, config.reasoningEffort, controller.signal);
          const baseMaxTokens = clampInt(request.maxTokens, 256, MAX_TOKENS_CEILING, config.maxTokens);
          let maxTokens = baseMaxTokens;
          /** @type {any} */
          let result;
          for (let attempt = 0; ; attempt += 1) {
            tried.push(maxTokens);
            try {
              result = await streamOptimization(llm, {
                ...messages,
                provider: route.provider,
                model: route.model,
                temperature: clampFloat(request.temperature, 0, 2, config.temperature),
                maxTokens,
                reasoningEffort: effort,
                signal: controller.signal,
              });
              break;
            } catch (error) {
              // 撞到输出上限时，把上限翻倍再试一次（推理 token 也计入该上限，
              // 首次给少了很常见）。只重试这一类错误，且只重试一次。
              const isMaxTokens = String(error?.code ?? '') === 'max-tokens';
              const canRetry = isMaxTokens
                && config.retryOnMaxTokens
                && attempt === 0
                && maxTokens < MAX_TOKENS_CEILING
                && !controller.signal.aborted;
              if (!canRetry) throw error;
              maxTokens = Math.min(MAX_TOKENS_CEILING, maxTokens * 2);
              notes.push(
                request.lang === 'zh'
                  ? `模型在 ${tried[0]} token 内没写完，已把上限抬到 ${maxTokens} 重试一次。`
                  : `The model did not finish within ${tried[0]} tokens; retried once with a ${maxTokens}-token ceiling.`,
              );
              warn(`max-tokens at ${tried[0]}, retrying with ${maxTokens}`);
            }
          }
          consecutiveFailures = 0;
          return {
            ok: true,
            engine: 'model',
            lang: request.lang,
            text: result.text,
            provider: route.provider,
            model: route.model,
            reasoningEffort: effort ?? null,
            usage: result.usage,
            notes,
            gaps: [],
            preserved: [],
            truncated: Boolean(request.truncated),
          };
        } catch (error) {
          const aborted = controller.signal.aborted;
          consecutiveFailures += 1;
          const message = String(error?.message ?? error);
          const code = aborted ? (signal.aborted ? 'client-aborted' : 'timeout') : String(error?.code ?? 'llm-failed');
          // 用户主动取消不该被当成「模型坏了」。
          if (signal.aborted) {
            return { ok: false, error: 'client-aborted', message: 'the request was cancelled' };
          }
          if (mode === 'model') {
            return { ok: false, error: code, message, provider: route.provider, model: route.model };
          }
          // max-tokens 是最常见且**可以自行解决**的失败：给出具体办法而不是干巴巴的英文。
          const advice = code === 'max-tokens'
            ? (request.lang === 'zh'
                ? `模型在写完之前撞到了输出上限（maxTokens=${tried.length > 0 ? tried[tried.length - 1] : config.maxTokens}）。`
                  + '注意：推理模型的**思考 token 也计入这个上限**，'
                  + '而本 profile 的默认模型配置是 reasoningEffort: max，很容易把预算吃光。'
                  + '已在失败前自动翻倍重试过一次。解决办法：把 maxTokens 调到 16384，'
                  + '或把 reasoningEffort 设为 low，或把 mode 设为 rules 直接走本地引擎。'
                : `The model hit the output ceiling (maxTokens=${tried.length > 0 ? tried[tried.length - 1] : config.maxTokens}) before finishing. `
                  + 'Note: a reasoning model counts its thinking tokens against this ceiling. '
                  + 'Raise maxTokens to 16384, set reasoningEffort to "low", or set mode to "rules".')
            : '';
          notes.push(
            request.lang === 'zh'
              ? `模型调用失败（${code}），已自动回落到本地规则引擎。原因：${message}${advice ? `\n  ↳ ${advice}` : ''}`
              : `Model call failed (${code}); fell back to the local rule engine. Reason: ${message}${advice ? `\n  ↳ ${advice}` : ''}`,
          );
          warn(`model call failed (${code}): ${message}`);
        } finally {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
        }
      } else if (mode === 'model') {
        return { ok: false, error: route.error, message: route.message };
      } else {
        notes.push(
          request.lang === 'zh'
            ? `没有可用的默认模型（${route.error}），已使用本地规则引擎。`
            : `No usable default model (${route.error}); used the local rule engine.`,
        );
      }
    } else if (mode === 'auto' && llm !== undefined && consecutiveFailures >= config.failureCircuitThreshold) {
      notes.push(
        request.lang === 'zh'
          ? `模型已连续失败 ${consecutiveFailures} 次，本次直接使用本地规则引擎。`
          : `The model failed ${consecutiveFailures} times in a row; using the local rule engine directly.`,
      );
    }

    // 规则引擎是最后一道兜底，任何情况下都不该让用户一无所获。
    const local = optimizeLocally(request.text, { lang: request.lang });
    return {
      ...local,
      engine: 'rules',
      notes: [...notes, ...local.notes],
      truncated: Boolean(request.truncated) || local.truncated,
      provider: null,
      model: null,
      usage: null,
    };
  }

  /**
   * `GET /info` —— Client 用它决定是否显示「模型/规则」指示与降级提示。
   * @param {any} ctxHost - Host 上下文。
   * @param {import('node:http').ServerResponse} res - 响应。
   */
  function handleInfo(ctxHost, res) {
    const llm = llmService(ctxHost);
    let providers = [];
    try {
      const list = llm?.listProviders?.();
      if (Array.isArray(list)) {
        providers = list.map((entry) => ({ id: String(entry?.id ?? ''), name: String(entry?.name ?? entry?.id ?? '') }));
      }
    } catch {
      providers = [];
    }
    let fallback = null;
    try {
      const selection = ctxHost.get('agentDefaultModel')?.currentSelection?.();
      if (selection !== null && typeof selection === 'object') {
        fallback = { provider: String(selection.provider ?? ''), model: String(selection.model ?? '') };
      }
    } catch {
      fallback = null;
    }
    sendJson(res, 200, {
      ok: true,
      version: 1,
      config,
      llm: llm !== undefined,
      providers,
      default: fallback,
      circuit: { consecutiveFailures, open: consecutiveFailures >= config.failureCircuitThreshold },
      limits: {
        maxInputChars: MAX_INPUT_CHARS,
        longInputThreshold: LONG_INPUT_THRESHOLD,
        maxBodyBytes: MAX_BODY_BYTES,
      },
    });
  }

  /**
   * `POST /optimize` —— 一次优化，返回结构化结果。
   * @param {any} ctxHost - Host 上下文。
   * @param {import('node:http').IncomingMessage} req - 请求。
   * @param {import('node:http').ServerResponse} res - 响应。
   * @returns {Promise<void>} 写完响应后 resolve。
   */
  async function handleOptimize(ctxHost, req, res) {
    const body = await readJsonBody(req);
    if (!body.ok) {
      sendJson(res, body.error === 'body-too-large' ? 413 : 400, body);
      return;
    }
    const normalized = normalizeRequest(body.value);
    if (!normalized.ok) {
      sendJson(res, 400, normalized);
      return;
    }
    const controller = new AbortController();
    // 连接断开意味着没人会读这个回复，立刻停止为它付费。
    res.on('close', () => controller.abort(new Error('client disconnected')));
    const startedAt = Date.now();
    try {
      const result = await optimize(normalized.request, controller.signal);
      if (controller.signal.aborted && !res.writableEnded) return;
      sendJson(res, result.ok ? 200 : 502, {
        ...result,
        elapsedMs: Date.now() - startedAt,
      });
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: 'optimizer-failed',
        message: String(error?.message ?? error),
      });
    }
  }

  if (webServer !== undefined) {
    /**
     * 注册一条同源路由，并把生命周期挂到插件上（插件卸载即摘除）。
     *
     * 承载层会 await handler，因此包装函数返回的 Promise 必须**永不 reject**：
     * 一次 reject 会变成承载层的空 500，而 Client 恰恰需要错误正文来告诉用户原因。
     *
     * @param {string} path - 精确路径。
     * @param {(req: any, res: any) => unknown} handler - 处理函数。
     */
    const route = (path, handler) => {
      const dispose = webServer.register({
        kind: 'exact',
        path,
        handler: (req, res) => {
          let result;
          try {
            result = handler(req, res);
          } catch (error) {
            warn(`${path} threw: ${String(error?.message ?? error)}`);
            sendJson(res, 500, { ok: false, error: 'bridge-failed', message: String(error?.message ?? error) });
            return Promise.resolve();
          }
          return Promise.resolve(result).catch((error) => {
            warn(`${path} failed: ${String(error?.message ?? error)}`);
            sendJson(res, 500, { ok: false, error: 'bridge-failed', message: String(error?.message ?? error) });
          });
        },
      });
      ctx.effect(() => dispose, `dsh-prompt-optimizer: ${path}`);
    };

    route(`${ROUTE_BASE}/info`, (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { ok: false, error: 'method-not-allowed', message: `GET ${ROUTE_BASE}/info` });
        return;
      }
      handleInfo(ctx, res);
    });

    route(`${ROUTE_BASE}/optimize`, (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method-not-allowed', message: `POST ${ROUTE_BASE}/optimize` });
        return;
      }
      return handleOptimize(ctx, req, res);
    });

    // 自检通道：Client 半在加载/注册/渲染的关键节点把进度写到这里，
    // 落到一个可直接读取的 JSONL 文件。之所以需要它：客户端的失败
    // （apply 抛错、插槽回调没触发、组件渲染异常）在宿主侧是静默的，
    // 只看日志看不出「按钮为什么没出现」。
    //
    // ⚠️ 默认**关闭**（config.debug = false）。它是排障工具，不是常驻功能：
    //    - 每次启动会写 16+ 行，长期不清理就是一个只增不减的文件；
    //    - 客户端每个阶段还会发一次 fetch，正常使用下纯属开销。
    // 关闭时路由仍然存在（客户端可以照常上报），但**不落盘**，直接返回 skipped。
    const diagEnabled = config.debug === true;
    route(`${ROUTE_BASE}/report`, async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method-not-allowed', message: `POST ${ROUTE_BASE}/report` });
        return;
      }
      const body = await readJsonBody(req);
      if (!body.ok) {
        sendJson(res, 400, body);
        return;
      }
      if (!diagEnabled) {
        sendJson(res, 200, { ok: true, stored: false, reason: 'debug-disabled' });
        return;
      }
      try {
        const line = `${JSON.stringify({ at: new Date().toISOString(), ...body.value })}\n`;
        appendFileSync(DIAG_PATH, line, 'utf8');
      } catch (error) {
        warn(`diag write failed: ${String(error?.message ?? error)}`);
      }
      sendJson(res, 200, { ok: true, stored: true });
    });

    ctx.logger?.info?.(`[dsh-prompt-optimizer] bridge mounted at ${ROUTE_BASE} (mode=${config.mode}, debug=${diagEnabled})`);
    if (diagEnabled) {
      try {
        appendFileSync(DIAG_PATH, `${JSON.stringify({ at: new Date().toISOString(), phase: 'host:mounted' })}\n`, 'utf8');
      } catch {
        /* 诊断本身失败不该影响插件 */
      }
    }
  }
}

/**
 * Host 半硬依赖：需要 web 承载层来挂同源桥。
 * 没有 webServer 的组合只会让插件的 host fiber 保持 pending，Client 半仍可用本地规则引擎。
 */
export const inject = ['webServer'];

export { DEFAULTS as DEFAULT_CONFIG, ROUTE_BASE, MAX_INPUT_CHARS, LONG_INPUT_THRESHOLD };
