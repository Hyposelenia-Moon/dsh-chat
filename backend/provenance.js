import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

export const PIN = JSON.parse(readFileSync(new URL('./pin.json', import.meta.url), 'utf8'));
export const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
export function inside(root, name) {
  const path = resolve(root, name), rel = relative(root, path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('构建清单路径越界');
  return path;
}
export function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * Describe the local build. A trimmed checkout is expected, so this records what
 * is actually there instead of demanding a pinned upstream commit or a clean tree.
 * The result only feeds the build manifest; it never blocks startup.
 */
export function verifySource(root) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  let commit = 'local';
  try { commit = git(root, ['rev-parse', 'HEAD']); } catch { /* not a git checkout */ }
  let repository = PIN.repository;
  try {
    const origin = git(root, ['remote', 'get-url', 'origin']).replace(/\.git$/, '').replace(/\/$/, '');
    if (origin) repository = origin;
  } catch { /* no origin */ }
  return { commit, version: pkg.version, repository };
}

export function validateHome(homePath) {
  if (!homePath || !isAbsolute(homePath)) throw new Error('backend.dshHome 必须是独立的绝对路径');
  const dshHome = resolve(homePath);
  const actualHome = existsSync(dshHome) ? realpathSync(dshHome) : dshHome;
  const defaultHome = existsSync(join(homedir(), '.dsh')) ? realpathSync(join(homedir(), '.dsh')) : resolve(homedir(), '.dsh');
  if (actualHome.toLowerCase() === defaultHome.toLowerCase()) throw new Error('请为 QQ 后端配置独立 DSH_HOME');
  if (existsSync(join(dshHome, 'cordis.patch.yml'))) throw new Error('独立 DSH_HOME 存在未经校验的全局 patch');
  return dshHome;
}

/**
 * Verify an explicit local build. Never fetches, installs, or compares file sets:
 * update flow is "git pull the plugin, rebuild the backend when its source moves",
 * the same as any other Yunzai plugin. Only "this is a runnable QQ backend" is checked.
 */
export function verifyBackend(input) {
  const config = input.backend ?? input;
  if (!config.path || !isAbsolute(config.path)) throw new Error('backend.path 必须是 DSH 启动器的绝对路径');
  if ((config.profile ?? 'qq') !== 'qq') throw new Error('此版本只支持 qq profile');
  const dshHome = validateHome(config.dshHome);
  let executable;
  try { executable = realpathSync(config.path); } catch { throw new Error(`backend.path 不存在：${config.path}`); }
  const root = dirname(executable);
  const manifestPath = join(root, 'dsh-chat-backend.json');
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
  const entry = inside(root, manifest?.entry ?? 'apps/cli/lib/bin.js');
  if (!existsSync(entry)) throw new Error('未找到 DSH 入口 apps/cli/lib/bin.js，请先构建后端');
  if (!existsSync(join(dshHome, 'profiles', 'qq', 'package.json')))
    throw new Error('DSH_HOME 缺少 qq profile，请先运行 backend-prepare');
  const warnings = [];
  if (config.expectedCommit && manifest?.commit && manifest.commit !== config.expectedCommit) {
    warnings.push(`后端构建 commit 为 ${manifest.commit}，与 expectedCommit ${config.expectedCommit} 不同（不阻断）`);
  }
  if (manifest?.dshHome && resolve(manifest.dshHome).toLowerCase() !== dshHome.toLowerCase()) {
    warnings.push('后端构建清单记录的 DSH_HOME 与当前配置不同（不阻断）');
  }
  return { command: process.execPath, args: [entry, '--profile', 'qq'], cwd: root,
    env: { ...process.env, DSH_HOME: dshHome, DSH_TELEMETRY_DISABLED: '1' }, manifest, warnings, commit: manifest?.commit ?? null };
}
