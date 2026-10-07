/**
 * 解析目标 DSH profile 目录 —— 让脚本在**用户自己的终端**里也能跑。
 *
 * 背景：`DSH_PROFILE_DIR` / `DSH_HOME` 是 DSH 进程注入的环境变量，
 * 只在 DSH 内部（比如 agent 的工具调用）存在。用户直接在 PowerShell 里
 * `npm run profile:install-only` 时它们并不存在，脚本若硬依赖就会
 * `Error: DSH_PROFILE_DIR is not set` —— 这是真实踩过的坑。
 *
 * 解析顺序：
 *   1. `--profile <名称或路径>` 命令行参数
 *   2. `DSH_PROFILE_DIR`（已是完整目录路径）
 *   3. `<DSH_HOME 或 ~/.dsh>/profiles/<DSH_PROFILE 或 desktop>`
 * 命中条件：该目录下存在 `package.json`（profile 的清单）。
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * 读取 `--profile <value>` 形式的命令行参数。
 * @returns {string | undefined} 参数值。
 */
export function profileArg() {
  const at = process.argv.findIndex((a) => a === '--profile' || a.startsWith('--profile='));
  if (at < 0) return undefined;
  const token = process.argv[at];
  if (token.includes('=')) return token.slice(token.indexOf('=') + 1);
  return process.argv[at + 1];
}

/**
 * DSH 主目录（含 profiles 的那一层）。
 * @returns {string} 绝对路径。
 */
export function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}

/**
 * 列出 DSH_HOME 下已存在的 profile 名称，用于报错时提示。
 * @returns {string[]} profile 名称列表。
 */
export function listProfiles() {
  try {
    return readdirSync(join(dshHome(), 'profiles'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => existsSync(join(dshHome(), 'profiles', name, 'package.json')));
  } catch {
    return [];
  }
}

/**
 * 解析目标 profile 目录。
 *
 * @param {object} [options] - 可选项。
 * @param {string} [options.explicit] - 显式指定的 profile 名称或目录。
 * @returns {string} profile 目录的绝对路径。
 * @throws {Error} 找不到时抛出，附带已尝试路径与可用 profile 列表。
 */
export function resolveProfileDir(options = {}) {
  const home = dshHome();
  const explicit = options.explicit ?? profileArg();
  /** @type {Array<{label: string, path: string}>} */
  const attempts = [];

  if (explicit !== undefined && explicit !== '') {
    // 既接受完整路径，也接受 profile 名
    attempts.push({ label: `--profile ${explicit}`, path: isAbsolute(explicit) ? explicit : join(home, 'profiles', explicit) });
  }
  if (process.env.DSH_PROFILE_DIR) {
    attempts.push({ label: 'DSH_PROFILE_DIR', path: process.env.DSH_PROFILE_DIR });
  }
  const byName = process.env.DSH_PROFILE ?? 'desktop';
  attempts.push({ label: `profiles/${byName}`, path: join(home, 'profiles', byName) });
  // 兜底：只有一个 profile 时就用它（避免用户还得记名字）
  const available = listProfiles();
  if (available.length === 1) {
    attempts.push({ label: `唯一存在的 profile ${available[0]}`, path: join(home, 'profiles', available[0]) });
  }

  for (const attempt of attempts) {
    if (attempt.path !== undefined && attempt.path !== '' && existsSync(join(attempt.path, 'package.json'))) {
      return resolve(attempt.path);
    }
  }

  const tried = attempts.filter((a) => a.path).map((a) => `    - ${a.label}: ${a.path}`).join('\n');
  throw new Error(
    '找不到 DSH profile 目录（该目录下应有 package.json）。\n' +
    `  已尝试：\n${tried}\n` +
    `  DSH_HOME = ${home}\n` +
    `  可用 profile：${available.length > 0 ? available.join(', ') : '(一个都没找到)'}\n` +
    '  指定方式：npm run <脚本> -- --profile <profile 名或完整路径>',
  );
}

/**
 * 定位本插件包目录（脚本所在 build/ 的上一级）。
 *
 * 不硬编码任何绝对路径 —— 用户把包挪到别处也照样成立。
 *
 * @param {string} importMetaUrl - 调用方的 `import.meta.url`。
 * @returns {string} 插件根目录绝对路径。
 */
export function resolvePluginDir(importMetaUrl) {
  const here = resolve(new URL('.', importMetaUrl).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  return resolve(here, '..');
}

/**
 * 借用一个可用的 js-yaml（DSH 自己带的那份）。
 *
 * 搜索顺序：目标 profile → DSH_HOME → 主 profile → 插件目录 → 当前工作目录。
 *
 * @param {object} options - 参数。
 * @param {string} options.profileDir - 目标 profile 目录。
 * @param {Function} options.require - createRequire 得到的 require。
 * @param {string} options.pluginDir - 插件根目录。
 * @returns {any} js-yaml 模块。
 */
export function loadYaml({ profileDir, require, pluginDir }) {
  const candidates = [
    profileDir,
    dshHome(),
    join(dshHome(), 'profiles', 'desktop'),
    pluginDir,
    process.cwd(),
  ].filter((p) => typeof p === 'string' && p.length > 0);
  for (const base of candidates) {
    try {
      return require(require.resolve('js-yaml', { paths: [base] }));
    } catch {
      /* 试下一个 */
    }
  }
  throw new Error(
    `找不到 js-yaml（用于以宿主同款解析器校验 YAML）。已尝试：${candidates.join(', ')}\n` +
    '请在某个装有 DSH 依赖的环境中运行本脚本。',
  );
}
