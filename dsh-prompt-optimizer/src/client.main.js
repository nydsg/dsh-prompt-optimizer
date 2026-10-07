/**
 * dsh-prompt-optimizer —— Client 半的**可维护源文件**（不是最终产物）。
 *
 * 最终产物是 lib/client.js，由 build/build-client.mjs 生成：
 *   * `//#region rules` 段由 lib/rules.js 的对应段**逐字内联**
 *     （浏览器端的 require 只能解析已注册包，无法 require 兄弟文件，
 *      所以 client bundle 必须自包含；内联保证两边是同一份代码）。
 *   * 其余部分原样输出，并补上 dsh 客户端模块系统要求的工厂包装。
 *
 * 依赖注入的全局（由 dsh 客户端运行时提供，见 cordis Builtin 清单）：
 *   React   —— React 运行时（无 JSX 转换，因此全部用 React.createElement）
 *   styles  —— 包内样式表插入，随插件卸载自动清理
 *   console —— 带包标签的浏览器日志
 *
 * 本文件与最终产物共享同一套 API 契约；改这里就要重新执行 build。
 */

//#region rules
// 该段由 build/build-client.mjs 用 lib/rules.js 的 `//#region rules` 段替换。
//#endregion rules

//#region css
/** 包内样式。全部使用 dsh 主题 token，明暗主题自动适配。 */
export const CSS = `
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
//#endregion css

//#region main
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
export function diffTokens(before, after) {
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
export function createClientPlugin(deps) {
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
//#endregion main

//#region dicts
/** 界面词典。新增语言时同步补 key。 */
export const DICTS = {
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
//#endregion dicts
