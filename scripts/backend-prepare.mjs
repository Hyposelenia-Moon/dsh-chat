import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { sha256, validateHome, verifySource } from '../backend/provenance.js';

export function validateQqOverlay(baseText, acpText, overlayText, extraText) {
  // This is a static composition check, not DSH's mounted dump-config. Keeping
  // !!js values as strings is sufficient because safety disables are literal true.
  const parsePatch = text => parse(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] });
  const rows = new Map();
  const layers = [...parsePatch(baseText), ...parsePatch(acpText), ...parsePatch(overlayText)];
  if (extraText) layers.push(...parsePatch(extraText));
  for (const patch of layers) {
    for (const row of patch.insert ?? []) rows.set(row.id, row);
    if (patch.id) {
      if (!rows.has(patch.id)) throw new Error(`qq overlay 指向不存在的 row：${patch.id}`);
      rows.set(patch.id, { ...rows.get(patch.id), ...patch });
    }
  }
  const localTools = [...rows.values()].filter(row => row.id.startsWith('tool-')
    && !row.id.startsWith('tool-executor-') && row.id !== 'tool-result-pruner' && row.disabled !== true);
  if (localTools.length) throw new Error(`qq profile 仍有本地工具：${localTools.map(row => row.id).join(', ')}`);
  for (const id of ['plugin-manager', 'hmr', 'session-telemetry-otel', 'subagent', 'workflow-ptc', 'goal'])
    if (rows.get(id)?.disabled !== true) throw new Error(`qq profile 未禁用 ${id}`);
  if (rows.get('system-prompt')?.config?.includeRuntimeContext !== false) throw new Error('qq persona 缺少隔离的上下文配置');
  return { toolRows: localTools.map(row => row.id), composition: 'static-checked; runtime-smoke-required' };
}

export function prepareBackend(sourcePath, homePath) {
  const source = resolve(sourcePath), home = validateHome(resolve(homePath));
  const { commit, version, repository } = verifySource(source);
  const entry = 'apps/cli/lib/bin.js';
  if (!existsSync(join(source, entry))) throw new Error('请先构建 fork：pnpm install --frozen-lockfile; pnpm run build:artifacts');
  const profileDir = join(home, 'profiles', 'qq');
  if (existsSync(profileDir) && readdirSync(profileDir).length) throw new Error('qq profile 非空，准备脚本不会覆盖；请使用新的独立 DSH_HOME');
  const patch = readFileSync(new URL('../backend/qq.patch.yml', import.meta.url), 'utf8');
  const vendorDir = fileURLToPath(new URL('../backend/vendor/dsh-our-free-model/', import.meta.url));
  const vendor = existsSync(join(vendorDir, 'package.json'))
    ? JSON.parse(readFileSync(join(vendorDir, 'package.json'), 'utf8')) : null;
  const vendorPatch = vendor ? readFileSync(join(vendorDir, 'cordis.patch.yml'), 'utf8') : '';
  const composition = validateQqOverlay(readFileSync(join(source, 'packages/bundle/base/cordis.patch.yml'), 'utf8'),
    readFileSync(join(source, 'packages/bundle/acp-app/cordis.patch.yml'), 'utf8'), patch, vendorPatch);
  mkdirSync(profileDir, { recursive: true });
  const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'];
  const dependencies = {};
  if (vendor) {
    // Integrate the provider as part of the prepared profile instead of asking
    // the operator to install it as an extra plugin from a registry.
    cpSync(vendorDir, join(profileDir, 'node_modules', vendor.name), { recursive: true });
    dependencies[vendor.name] = vendor.version;
    bundles.push(vendor.name);
  }
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies,
    dsh: { profile: { bundles } } }, null, 2) + '\n');
  writeFileSync(join(profileDir, 'cordis.patch.yml'), patch);
  writeFileSync(join(source, 'dsh.cmd'), '@echo off\r\nnode "%~dp0apps\\cli\\lib\\bin.js" %*\r\n');
  writeFileSync(join(source, 'dsh-chat.mjs'), "import './apps/cli/lib/bin.js';\n");
  const files = {};
  const walk = dir => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (item.name === 'node_modules' || item.name === '.git') continue;
      const full = join(dir, item.name);
      if (item.isDirectory()) walk(full);
      else if (item.isFile() && ((/(?:^|[\\/])lib[\\/]/.test(full) && !/\.d\.[cm]?ts$/.test(item.name)) || /\.node$/.test(item.name)))
        files[relative(source, full).replaceAll('\\', '/')] = sha256(full);
    }
  };
  walk(join(source, 'packages')); walk(join(source, 'apps', 'cli'));
  for (const name of ['vendor', 'native']) if (existsSync(join(source, name))) walk(join(source, name));
  for (const name of ['package.json', 'pnpm-lock.yaml', 'dsh.cmd', 'dsh-chat.mjs',
    'packages/bundle/base/cordis.patch.yml', 'packages/bundle/acp-app/cordis.patch.yml']) files[name] = sha256(join(source, name));
  const manifest = { format: 2, repository, commit, version,
    builtAt: new Date().toISOString(), dshHome: home, entry, launcher: process.platform === 'win32' ? 'dsh.cmd' : 'dsh-chat.mjs', files, composition,
    provider: vendor ? `${vendor.name}@${vendor.version}` : null,
    profileFiles: Object.fromEntries(['package.json', 'cordis.patch.yml'].map(name => [name, sha256(join(profileDir, name))])) };
  writeFileSync(join(source, 'dsh-chat-backend.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { path: join(source, manifest.launcher), profile: 'qq', expectedCommit: commit, dshHome: home, patchPath: '' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { source: { type: 'string' }, home: { type: 'string' } } });
  if (!values.source || !values.home) throw new Error('用法：node scripts/backend-prepare.mjs --source <fork目录> --home <独立DSH_HOME>');
  console.log(JSON.stringify(prepareBackend(values.source, values.home), null, 2));
}
