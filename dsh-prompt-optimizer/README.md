# dsh-prompt-optimizer（提示词优化）

在 DSH 输入框工具条注入一个「优化提示词」按钮：读取你当前写下的草稿，按
**角色 / 目标 / 背景 / 任务 / 要求 / 约束 / 步骤 / 输出格式 / 验收标准** 九段骨架
重写为更清晰、更具体、更可执行的提示词，并支持**替换原文 / 追加 / 复制 / 撤销 / 对比**。

模型不可用时自动回落到内置的**本地规则引擎**，因此离线也能用。

---

## 1. 安装

> ### 先说清楚：为什么市场里找不到开关
>
> dshmarket 的「已安装」列表由 `readInstalled()` 驱动，它读的是 **profile 的
> `dependencies`**（只过滤掉 in-box 的 `@deepseek-ai/dsh-base` 等）。
> 本插件既不在你的 `dependencies` 里、也不在线上精选目录里，
> **所以「发现」和「已安装」两个页签都不会有它** —— 不是开关藏起来了，是它还没装。
>
> 市场只对**已声明的依赖**提供开关。因此顺序必须是：**先安装 → 再出现开关 → 用开关启用**。

### 方式 A：装好但先不启用，然后用市场开关启用（推荐）

```powershell
cd D:\Codex-workspace\dsh-prompt-optimizer
npm run profile:install-only   # 只写 dependencies，**不写** dsh.profile.bundles
```

> **在你自己终端的 PowerShell 里直接跑即可**（不需要 DSH 的进程内环境变量）。
> 脚本会自动定位 profile：优先 `--profile <名称或路径>`，其次 `DSH_PROFILE_DIR`，
> 最后回落到 `<DSH_HOME 或 ~/.dsh>/profiles/desktop`；找不到时会列出可用 profile。
> 例如 profile 名不叫 desktop 时：
> `npm run profile:install-only -- --profile 你的profile名`

然后：

1. **重启 DSH**。这次重启**绝对安全**：插件不在 `bundles` 里，DSH 根本不会去加载它
   （已用 `dsh --dump-config` 在整份 profile 的复刻上验证 EXIT=0，输出里没有本插件）。
2. 打开「设置 → 插件」→「**已安装**」，应该能看到 `dsh-prompt-optimizer`。
3. 打开它的开关。若提示需要重启，再重启一次即可。

### 方式 B：装好并立即启用（少一次操作）

```powershell
npm run profile:on      # dependencies + dsh.profile.bundles，装完即生效
```

### 回滚（任何时候都可执行）

```powershell
npm run profile:off     # 从 bundles / dependencies / node_modules 彻底移除
npm run profile:check   # 体检：确认 profile 里所有依赖与 patch 都能解析
```

### 让插件生效

Host 半（路由、模型调用）在 DSH 启动时装配，**必须重启 DSH**；
只改了 Client 半（`lib/client.js`）时，刷新页面即可。

---

## 1.1 历史事故与修复（重要背景）

本插件出过**三次**问题，原因各不相同，都已在 0.1.0 修掉。

### 事故三：组件 `return null` → 按钮不出现、且不报错（已修）

**症状**：插件在市场里启用成功（`on ok=true`、`hot-mount live`），bundle 也能正常
加载注册，但输入框工具条里**什么都没有**，控制台也没有任何报错。

**原因**：组件内部按 `part` 取渲染分支，但两边键名不一致：

```js
const seats = { right: …, dock: … };   // 写的是插槽名
return seats[part] ?? null;            // part 是 'button' / 'panel' → 恒为 undefined
```

于是组件永远返回 `null`。**槽位注册、inject、样式全都正确**，只是什么都不画。

**修复与护栏**：键名统一为 `button` / `panel`；新增 `build/render-test.mjs` ——
用**真 React**（`react-dom/server` 的 `renderToString`）把两个条目真的渲染一遍，断言：

- 按钮条目输出**非空**、含 `dpo-btn` 类名；
- 不传 `t` 时（走内置词典回退）输出里必须出现「优化提示词」；
- `apply` 不抛错、两个插槽都注册成功。

同一测试还顺带抓出第二个 bug：组件里 `t` 只在部分位置有回退，缺 `t` 时
会 `TypeError: t is not a function` 直接渲染失败 —— 现已统一成单一翻译入口。

```powershell
npm run render:test                        # 测源目录的 lib/client.js
node build/render-test.mjs <reactDir> --bundle <已安装的 client.js 路径>
```

> 教训：此前所有测试都只验证到「factory 返回了 apply/inject」，
> **从没真正渲染过组件** —— 于是「注册全对但什么都不显示」这类问题
> 一路漏到用户面前。UI 插件必须有一个真的渲染断言。

### 事故二：client bundle 顶层 `return` → 整个 Web 起不来（已修）

**症状**（`%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-web-boot.log`）：

```
Error: web boot: 1 entry did not activate
dsh-prompt-optimizer: import failed (see console for the import error)

--- renderer console (error level) ---
…/plugins/??…,dsh-prompt-optimizer/client.js,…:15005 Uncaught SyntaxError: Illegal return statement
…/plugins/??dsh-prompt-optimizer/client.js&rev=…:1251 Uncaught SyntaxError: Illegal return statement
```

**原因**：浏览器把 client bundle 当**普通 script** 加载，而且会把多个插件拼成
**一条 combo script** 一起加载。经典脚本里顶层 `return` 是语法错误 ——
我为了保证「工厂返回 exports」在脚本顶层写了 `return __bundleExports;`，
于是整段 combo 解析失败，**连累同批次另外 57 个插件**，
`web boot` 报「1 entry did not activate」，界面直接起不来。

**正确形态**（照抄 dsh-ppt / dsh-mindmap / dshmarket 的实际产物）：

```js
window.__ModuleLoader__.load({ id: 'dsh-prompt-optimizer', factory: (require) => {
  const module = { exports: {} };
  const exports = module.exports;
  const React = require('react');
  // …插件体…
  return module.exports;   // ← return 在 factory 里，不在脚本顶层
} });
```

**修复与护栏**：`lib/client.js` 改为上述形态；`test/client.test.mjs` 新增两组用例 ——
「bundle 是合法经典脚本（顶层不得有 return）」用 `vm.Script` 按脚本解析，
以及「combo script 拼接后依然合法且各自注册」（两个 bundle 首尾拼接后整体求值，
双向顺序都测）。`npm run iso:combo` 还能从真实服务器抓下 10 MB 级 combo 复验。

> 教训：当时我确实看到 `node --check` 报 `Illegal return statement`，
> 却把它解释成「这是工厂体、本来就该这样」而放过了。
> **语法检查报错就是真错误，不该被解释掉。**

### 事故一：bundle patch 带引号 id → 市场重写后 YAML 非法（已修）

第一版曾在市场启用时**让整个 DSH 打不开**。根因已定位到 dshmarket 源码
（`node_modules/dshmarket/src/hot.ts:768`）：

```ts
.map(row => `- id: 'mkt-${row.id}'\n  name: '${resolveProfileEntry(profileDir, row.name)}'\n`)
```

配合它上面两行的解析正则：

```ts
const id   = /^\s+-\s+id:\s*(\S+)\s*$/                 // (\S+) 会把引号一起吃掉！
const name = /^\s+name:\s*['"]?([^'"\s]+)['"]?\s*$/   // name 则显式允许并剥掉引号
```

第一版 patch 把 id 写成 `id: 'dsh-prompt-optimizer'`（带引号），于是：

1. `(\S+)` 捕获到 **`'dsh-prompt-optimizer'`（含引号）**；
2. 模板再包一层引号 → `- id: 'mkt-'dsh-prompt-optimizer''`（引号套引号）；
3. 该文本写进 profile 的 patch 层 → js-yaml 抛
   `bad indentation of a mapping entry`；
4. `prepareProfile` 阶段直接失败 → **DSH 起不来**。

注意 `name` 正则允许并剥掉引号，**只有 id 会带引号** —— 这正是"给 id 加引号"
这个看似更规范的写法反而出事的原因。

修复：patch 改为裸标量（`id: dsh-prompt-optimizer`，无引号、无注释、无 config 块）。
`npm run market:compat` 会用市场**源码里的原始正则与模板**复跑这条路径，断言修复版
产出合法 YAML、旧版产出与线上完全一致的报错。

### 手动安装（等价做法）

```powershell
$src = "D:\Codex-workspace\dsh-prompt-optimizer"
$dst = "$env:DSH_PROFILE_DIR\node_modules\dsh-prompt-optimizer"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item "$src\*" $dst -Recurse -Force
# 然后在 $env:DSH_PROFILE_DIR\package.json 里：
#   dependencies 增加 "dsh-prompt-optimizer": "file:D:/Codex-workspace/dsh-prompt-optimizer"
#   dsh.profile.bundles 追加 "dsh-prompt-optimizer"
```

> 也可以不用 `dsh.profile.bundles`，改为在 profile 的 `cordis.patch.yml` 里手动加一条
> entry：`- id: dsh-prompt-optimizer` + `name: dsh-prompt-optimizer`。
> 这条路完全不被市场管理，代价是市场的插件页不会显示它。

---

## 2. 使用

1. 在输入框写下你的提示词（中英文都支持）。
2. 点击输入框工具条右侧的 **「优化提示词」**。
3. 按钮依次显示 `优化中…` → `再优化`，输入框上方出现结果面板。
4. 在面板里：

| 操作 | 说明 |
| --- | --- |
| **替换原文** | 用优化结果整体替换输入框内容（记住撤销点） |
| **追加** | 把优化结果追加到草稿末尾，便于对照后手动取舍 |
| **复制** | 复制优化结果到剪贴板 |
| **撤销** | 还原到上一次替换/追加之前的草稿 |
| **优化后 / 原文 / 对比** | 三个视图；「对比」用字符级 diff 标出新增（绿）与删除（红） |

空输入会提示「请先在输入框中写下提示词」；失败会显示原因并提供 **重试**。

---

## 3. 配置

配置写在 profile 的 `cordis.patch.yml` 里，按 loader entry id 定向覆盖：

```yaml
- id: 'dsh-prompt-optimizer'
  name: 'dsh-prompt-optimizer'
  config:
    mode: auto                  # auto | model | rules
    temperature: 0.3
    maxTokens: 8192
    reasoningEffort: auto       # auto | minimal | low | medium | high | max
    retryOnMaxTokens: true
    timeoutMs: 60000
    failureCircuitThreshold: 3
    strictPreservation: false
    maxHistory: 10
```

| 配置项 | 类型 | 默认 | 含义 |
| --- | --- | --- | --- |
| `mode` | `auto\|model\|rules` | `auto` | `auto`：有模型就用模型、失败回落规则；`model`：只用模型，失败即报错；`rules`：纯本地规则引擎，不联网 |
| `temperature` | number `0–2` | `0.3` | 采样温度。改写任务建议偏低，避免模型自由发挥 |
| `maxTokens` | int `256–32768` | `8192` | 单次输出上限。**推理模型的思考 token 也计入这个上限**，所以别给太小 |
| `reasoningEffort` | `auto\|minimal\|low\|medium\|high\|max` | `auto` | 推理强度。`auto` 会探测该模型支持的档位并取**最低一档**（改写任务不需要深推理）。**不支持显式强度的模型会被服务端直接拒绝**，所以 `auto` 只在该模型确实支持时才传；探测不到就不传，交给适配器默认 |
| `retryOnMaxTokens` | boolean | `true` | 撞到输出上限时，把上限**翻倍重试一次**（封顶 32768） |
| `timeoutMs` | int `5000–600000` | `60000` | 单次模型调用超时 |
| `failureCircuitThreshold` | int `1–100` | `3` | 连续失败达到该次数后，本进程内直接走规则引擎，避免每次点击都白等一次超时 |
| `strictPreservation` | boolean | `false` | 追加「严格保真」约束：未提供的事实一律用 `<PLACEHOLDER: …>`，标识符/路径/URL 逐字保留 |
| `maxHistory` | int `1–100` | `10` | 预留：会话内优化历史上限 |
| `debug` | boolean | `false` | 排障开关：把 Client 半加载/注册/渲染的关键节点写进 `%TEMP%/dsh-prompt-optimizer-diag.jsonl` |

### 关于自检日志（默认关闭）

`debug: true` 时插件会把客户端的关键节点落到：

```
%TEMP%\dsh-prompt-optimizer-diag.jsonl
```

这个通道用来定位**宿主侧静默的客户端问题** —— 比如「按钮不出现」「插槽回调没触发」
「组件渲染异常」，这些在宿主日志里什么都看不到。它确实帮上过忙（详见 §1.1）。

但它**默认关闭**，因为它是排障工具而不是常驻功能：

- 每次启动会写十几行（`host:mounted` + 客户端各阶段），长期只增不减；
- 客户端每个阶段还会多发一次 fetch，正常使用下纯属开销。

关闭时 `/report` 路由依然存在（客户端照常上报，不会因此报错），但**不落盘**，
直接返回 `{"ok":true,"stored":false,"reason":"debug-disabled"}`。
因此那个 JSONL **不会再增长**，可以随时删掉。

需要排障时临时打开、用完关掉：

```yaml
- id: 'dsh-prompt-optimizer'
  name: 'dsh-prompt-optimizer'
  config:
    debug: true
```

> 插件**不产生任何其他缓存**：无 `node_modules`、无 lock 文件、无覆盖率产物、
> 不写日志、不做持久化。优化结果只存在会话内存里。

### 遇到 `max-tokens` 怎么办

报错形如：

```
模型调用失败（max-tokens），已自动回落到本地规则引擎。
原因：the model hit the max-token ceiling before finishing the rewrite
```

**含义**：模型在把提示词改写完之前就撞到了输出上限（`maxTokens`）。
插件按设计**回落到本地规则引擎**（所以你仍然拿得到结果，不会白点），并在「主要优化点」里写明。

**为什么容易撞上**：`GenerateOptions.maxTokens` 约束的是**整次输出**，而推理模型
（如本 profile 默认的 `reasoningEffort: max`）**思考 token 也计入这个上限**。
4096 的预算会被 max 强度推理吃光，答案还没开始写就断了。

**插件现在会自动做的事**（0.1.0 起）：

1. `reasoningEffort: auto` —— 探测模型能力，取**最低可用档**，不再吃满预算；
2. `maxTokens` 默认由 4096 提到 **8192**；
3. 撞到上限时**自动翻倍重试一次**（4096 → 8192），并在「主要优化点」里告诉你；
4. 若仍失败，报错里直接给出可执行的建议（调大 maxTokens / 降 reasoningEffort / 改用 rules）。

**你要做的（可选）**：多数情况下不用管，插件会自己处理。若你的提示词特别长、
希望一次就成功，在 profile 的 `cordis.patch.yml` 里显式调大：

```yaml
- id: 'dsh-prompt-optimizer'
  name: 'dsh-prompt-optimizer'
  config:
    maxTokens: 16384
    reasoningEffort: low
```


### 权限与凭据

- **不需要插件私有 API Key。** 模型调用走 DSH 自己的 `ctx.llm` 服务，
  默认路由取自你在「设置 → 模型」里选定的默认模型（`agentDefaultModel`）。
  凭据由 DSH 的 credentials 服务管理，插件不再落一份密钥到磁盘。
- Host 半声明 `inject: ['webServer']`（硬依赖）以挂载同源路由。
- Client 半声明 `inject: ['slots', 'sessions', 'locale']`：插槽、会话作用域、词典。
- 客户端请求 `/plugin-prompt-optimizer/*` 时由浏览器自动携带 Cookie，因此天然满足
  `dsh web` 的鉴权；插件不额外要求任何网络权限。

---

## 4. 目录结构

```
dsh-prompt-optimizer/
├── package.json              # manifest：main / exports["./client"] / dsh.bundle / dsh.client
├── cordis.patch.yml          # bundle 自挂载补丁（insert 一行 loader entry）
├── lib/
│   ├── index.js              # Host 半：配置、ctx.llm 调用、HTTP 桥、回落策略
│   ├── rules.js              # 共享本地规则引擎（纯函数、零依赖）
│   └── client.js             # Client 半【生成物】：自包含 bundle
├── src/
│   └── client.main.js        # Client 半【源文件】：改这里，然后重新 build
├── build/
│   └── build-client.mjs      # 由 src/client.main.js + lib/rules.js 生成 lib/client.js
├── prompt/
│   └── optimizer-system.md   # 模型优化用的系统提示词模板
└── test/
    ├── rules.test.mjs        # 规则引擎行为
    ├── client.test.mjs       # bundle 契约、零漂移、diff、插槽注册
    └── host.test.mjs         # 配置收敛、两条路由、模型成功/失败/回落
```

### 为什么 `lib/client.js` 是生成物

dsh 客户端模块系统交给每个 bundle 的 `require` 只能解析「平台 seed 词 / 已注册包工厂 /
已 materialize 的模块」，**不能 require 同包的兄弟文件**，所以 client bundle 必须单文件自包含。
为了不手抄一份规则引擎（必然漂移），`build/build-client.mjs` 把 `lib/rules.js` 的
`//#region rules` 段**逐字内联**进 bundle；`test/client.test.mjs` 再用同一批夹具
对比两侧输出，锁死「零漂移」。

改 Client 半的正确流程：

```powershell
# 改 src/client.main.js（或 lib/rules.js）
npm run build     # 重新生成 lib/client.js
npm test          # 45 个测试，含零漂移检查
```

---

## 5. 工作原理

```
输入框草稿 ──readDraft──┐
                        │  Client 半（浏览器）
   「优化提示词」按钮 ──► │  fetch POST /plugin-prompt-optimizer/optimize
                        │
                        ▼  同源 HTTP（自动带 Cookie）
   Host 半（Node）  ──► ctx.llm.stream()  ──► 模型
                        │        ↘ 失败/不可用
                        └──► lib/rules.js 本地规则引擎
                        │
   结果 JSON ◄──────────┘
   （text / engine / notes / gaps / provider / model / usage / elapsedMs）
```

- **读草稿**：`ctx.sessions.scope(sessionId) → ctx.get('conversation') → .input.for(actx)`
  取到会话输入 shell，读 `snapshot.draft`。
- **回填**：`shell.actions.setDraft(text)`。
- **内联提示**：`shell.notify(level, text)`。
- **生命周期**：样式与词典注册都挂在 `ctx.effect` 上，插件卸载时自动清理；
  两个插槽条目通过 `ctx.slots.inject(key, …)` 注册，声明消失时自动撤销。

### 双引擎

| | 模型引擎 | 规则引擎 |
| --- | --- | --- |
| 触发 | `mode: model`，或 `auto` 且模型可用 | `mode: rules`，或模型不可用/失败 |
| 优点 | 真正理解语义，改写质量高 | 零延迟、零成本、离线可用、可预测 |
| 保真 | 由系统提示词约束，可能仍有轻微发挥 | 结构重排 + 受保护片段逐字保留，不新增事实 |
| 结果标记 | `engine: "model"`（面板显示「模型」徽标） | `engine: "rules"`（面板显示「规则」徽标） |

模型路径失败时**不会假装成功**：`mode: auto` 会回落规则并在 `notes` 里带上失败原因
（面板顶部显示），`mode: model` 则直接报错并提供重试。

---

## 6. 优化标准与保真策略

### 6.1 优化标准（唯一权威口径）

`prompt/optimizer-system.md`（模型路径）与 `lib/rules.js`（本地规则引擎）实现**同一套标准**：

**优化原则**

1. **保留用户原始意图，不改变核心需求。**
2. **不编造用户没有提供的事实、数据或背景。**
3. **自动补全必要结构**：角色、目标、背景、任务、要求、约束、步骤、输出格式、验收标准。
   其中「角色 / 步骤 / 输出格式 / 验收标准」是**结构性**内容，可给通用默认；
   「背景 / 要求 / 约束」是**事实依赖**内容，原文没给就只标注、不编造。
4. 原文太短可合理扩展，但必须保持原意。
5. **代码、变量、专有名词、URL、公式原样保留**（逐字，不翻译不改写）。
6. 信息不足不胡乱假设 —— 写「（原文未提供，未作假设；如信息不足请先提问。）」，
   或在本体末尾附「（若上述信息不足，请先向我提问确认，不要自行假设。）」。
7. 中英文均支持，默认与原文同语言输出。
8. 输出要具体、可执行、少歧义，适合直接交给大模型。

**输出格式（严格三段，标题原样）**

```
## 优化后的提示词
（提示词本体，用 ### 分节）

## 主要优化点
- （只列确实做过的改动）

## 使用建议
- （怎么用 / 还需补什么 / 需要你拍板的矛盾在此提问）
```

API 里对应的字段：`text` 是含三段式外壳的完整输出；`optimized` 是**纯提示词本体**；
`notes` 即「主要优化点」的条目；`gaps` 是标注为待补的段落。

### 6.2 保真策略

1. **保留原始意图** —— 只把话说明白，不替用户改需求。
2. **绝不编造事实** —— 未提供的技术栈、版本、路径、数值一律不写入；
   事实依赖段缺失时只标注，并在「使用建议」里集中列出（结果里的 `gaps`）。
3. **原样保留关键内容** —— 代码块、行内代码、变量/函数/类名、命令、文件路径、URL、
   报错信息、公式、专有名词逐字保留，不翻译、不改写。
4. **不改变语言** —— 中文进中文出，英文进英文出。
5. **去除重复** —— 段内不再重复「验收标准：」这类标签（标题已说明）；
   与「目标」逐字相同的句子不会在「任务」里再写一遍。
6. **示例不伪造** —— 只有原文真的给了例子才出现「示例」段，绝不凭空造样例。
7. **短输入** —— 扩展为最小可用骨架，并说明「扩展内容仅为结构与预期」。
8. **超长输入** —— 超过 20000 字符先截断再优化，并在「主要优化点」与「使用建议」里告知。

> **热挂载 vs 重启**：只改 `lib/client.js`（客户端）时刷新页面即可；
> 改 `lib/rules.js`、`lib/index.js` 或 `prompt/`（Host 侧）则**需要重启 DSH**。

---

## 7. 排障

### 🚨 DSH 打不开了 / 启动直接报错

> **本包已修复该问题（版本 0.1.0 起）**，正常安装不会再触发。本节保留，用于
> 万一遇到同类症状时快速定位与恢复 —— 也适用于**其它**插件造成的同样故障，
> 因为根因在市场侧，不在本包。

**症状**：DSH 启动即失败，界面报 YAML 相关错误；`%DSH_PROFILE_DIR%\.dsh-market\log.ndjson`
里能看到类似：

```json
{"event":"hot-mount","level":"warn","detail":"…: fell back to restart — bad indentation of a mapping entry (1:13) 1 | - id: 'mkt-'…''"}
{"event":"toggle","level":"warn","detail":"…: enable failed; leaving it disabled rather than persisting a state that crashes at boot (#575)"}
```

命令行下则是：

```
Error: dsh: failed to parse overlay <profile>\cordis.patch.yml: YAMLException: bad indentation of a mapping entry
```

**根因**：dshmarket 启用一个插件时会读取该插件的 `dsh.bundle.patch`，用
`hot.ts` 的两条正则抽行、再用一个模板加 `mkt-` 前缀重新生成 loader entry：

```ts
const id   = /^\s+-\s+id:\s*(\S+)\s*$/                 // (\S+) 连引号一起吃
const name = /^\s+name:\s*['"]?([^'"\s]+)['"]?\s*$/   // name 允许并剥掉引号
// …
.map(row => `- id: 'mkt-${row.id}'\n  name: '${resolveProfileEntry(profileDir, row.name)}'\n`)
```

**只要插件的 patch 把 id 写成带引号的 `id: 'pkg'`**，`(\S+)` 就会捕获到含引号的
`'pkg'`，模板再包一层引号 → `- id: 'mkt-'pkg''` → js-yaml 报
`bad indentation of a mapping entry`。该文本被写进 profile 的 patch 层，
`prepareProfile` 阶段就失败，于是整个 DSH 起不来。

**恢复步骤**（按顺序）：

```powershell
cd D:\Codex-workspace\dsh-prompt-optimizer
npm run profile:off      # 1. 把本插件从 profile 彻底移除（幂等，随时可跑）
npm run profile:check    # 2. 确认 profile 里所有依赖仍能解析
```

3. 检查 `$env:DSH_PROFILE_DIR\cordis.patch.yml` 是合法 YAML
   （常见后果是市场重写该文件时丢掉了若干 entry，例如
   `agent-default-model`、`permission`、`ui-conversation`、`locale`、`pet`）；
   缺了就按需补回，然后重启 DSH。

### 其它

| 现象 | 原因与处理 |
| --- | --- |
| 看不到按钮 | 只改了 `lib/client.js` 时刷新页面即可；改了 Host 半需重启 DSH。确认包已加进 `dsh.profile.bundles` |
| 面板提示「本地模型服务不可用」 | 该组合没有 `llm` 服务，或未设置默认模型。到「设置 → 模型」选一个默认模型，或把 `mode` 设为 `rules` 明确使用离线引擎 |
| 每次都要等很久才回落 | 模型超时。调小 `timeoutMs`，或把 `mode` 设为 `rules`。连续失败 `failureCircuitThreshold` 次后会熔断，不再尝试模型 |
| 优化结果里出现了你没写过的内容 | 把 `strictPreservation` 设为 `true`；仍不满意就把 `mode` 设为 `rules`，规则引擎不会新增事实 |
| 提示 `无法写回输入框` | 该会话的输入 shell 不可用（例如无会话的空白态）。结果仍可手动复制 |

> **本插件的设计原则：绝不阻断 DSH 启动。** Host 半对 `webServer` 是硬依赖，
> 但缺服务时只告警、插件保持 pending；所有异常都被收敛成路由内的 JSON 错误，
> 不会向上冒泡到 loader。唯一能让启动失败的是**配置文件本身写坏** ——
> 这也是上面那道 `verify:patch` 护栏存在的原因。

---

## 8. 开发

```powershell
npm run build        # 生成 lib/client.js（改 src/ 或 lib/rules.js 后必须跑）
npm test             # 47 个单元测试（零第三方依赖）
npm run verify:patch # bundle patch 的市场往返安全门
npm run market:compat# 用 dshmarket 源码里的原始正则/模板复跑热挂载路径
npm run profile:check# 体检 profile 依赖与 patch
npm run render:test  # 真 React 渲染两个插槽条目（需下面的 react 目录）
```

### 渲染测试需要一份 react

`npm run render:test` 会用 `react-dom/server` 的 `renderToString` **真的渲染**组件，
断言按钮条目输出非空、含 `dpo-btn`、且内置词典产出「优化提示词」。
这是唯一能抓住「注册全对但组件什么都不画」这类问题的测试（详见 §1.1 事故三）。

DSH 把 React 打包在自己的界面包里，profile 里**没有**独立的 `react` 包，
所以它需要一个自己的 react 目录（一次性，约 5 MB，用完可随时删）：

```powershell
mkdir D:\Codex-workspace\.dpo-react
cd D:\Codex-workspace\.dpo-react
npm init -y
npm i react@18 react-dom@18
```

目录不存在时脚本会打印上面这段提示并以退出码 2 结束（**那是缺依赖，不是插件故障**）。
也可以用别的目录，或直接指定要测的 bundle：

```powershell
node build/render-test.mjs D:\path\to\react-dir
node build/render-test.mjs D:\path\to\react-dir --bundle "<已安装的 client.js 路径>"
```

### 单元测试覆盖

规则引擎行为与边界、bundle 作为经典脚本的合法性、**combo script 拼接后仍合法**、
工厂契约、两侧规则引擎零漂移、词典中英键一致、diff 还原性、
插槽注册与降级、配置收敛、HTTP 路由成功/失败/回落/截断/405/400 全路径。

## 9. 许可

MIT
