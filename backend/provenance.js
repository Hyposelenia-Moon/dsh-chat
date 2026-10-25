import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
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
export function verifySource(root) {
  const commit = git(root, ['rev-parse', 'HEAD']);
  if (commit !== PIN.commit) throw new Error(`fork commit 必须固定为 ${PIN.commit}`);
  const origin = git(root, ['remote', 'get-url', 'origin']).replace(/\.git$/, '').replace(/\/$/, '');
  if (origin !== PIN.repository && origin !== 'git@github.com:Hyposelenia-Moon/deepseek-harness')
    throw new Error('origin 不是指定的 Hyposelenia-Moon fork');
  if (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version !== PIN.version)
    throw new Error('fork package version 不一致');
  if (git(root, ['status', '--porcelain', '--untracked-files=no'])) throw new Error('fork 有未提交的 tracked 修改');
  return commit;
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

/** Verify the explicit local build. This code never fetches or installs anything. */
export function verifyBackend(input) {
  const config = input.backend ?? input;
  if (!config.path || !isAbsolute(config.path)) throw new Error('backend.path 必须是 fork 构建启动器的绝对路径');
  if (config.expectedCommit !== PIN.commit) throw new Error(`backend.expectedCommit 请设置为 ${PIN.commit}`);
  if ((config.profile ?? 'qq') !== 'qq') throw new Error('此版本只支持经过校验的 qq profile');
  const dshHome = validateHome(config.dshHome);
  const executable = realpathSync(config.path);
  const root = dirname(executable);
  const manifest = JSON.parse(readFileSync(join(root, 'dsh-chat-backend.json'), 'utf8'));
  if (manifest.repository !== PIN.repository || manifest.commit !== PIN.commit || manifest.version !== PIN.version)
    throw new Error('当前指向的不是固定 fork 构建');
  if (resolve(manifest.dshHome).toLowerCase() !== dshHome.toLowerCase()) throw new Error('DSH_HOME 与已准备的 qq profile 不一致');
  verifySource(root);
  if (relative(root, executable) !== manifest.launcher) throw new Error('启动器与构建清单不一致');
  if (!manifest.files || Object.keys(manifest.files).length < 2) throw new Error('fork 构建文件清单缺失');
  for (const [name, hash] of Object.entries(manifest.files)) {
    const file = inside(root, name);
    if (!statSync(file).isFile() || sha256(file) !== hash) throw new Error(`fork 构建文件校验失败：${name}`);
  }
  const profileDir = join(dshHome, 'profiles', 'qq');
  for (const [name, hash] of Object.entries(manifest.profileFiles ?? {})) {
    if (sha256(inside(profileDir, name)) !== hash) throw new Error(`qq profile 校验失败：${name}`);
  }
  if (!manifest.profileFiles?.['cordis.patch.yml']) throw new Error('qq profile 缺少组合校验');
  // Invoke JavaScript directly: .cmd wrappers are never interpreted by cmd.exe.
  const entry = inside(root, manifest.entry);
  return { command: process.execPath, args: [entry, '--profile', 'qq'], cwd: root,
    env: { ...process.env, DSH_HOME: dshHome, DSH_TELEMETRY_DISABLED: '1' }, manifest };
}
