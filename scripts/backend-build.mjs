import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { PIN, verifySource } from '../backend/provenance.js';
import { prepareBackend } from './backend-prepare.mjs';

const { values } = parseArgs({ options: { source: { type: 'string' }, home: { type: 'string' }, pnpm: { type: 'string' } } });
if (!values.source || !values.home || !values.pnpm) throw new Error('用法：node scripts/backend-build.mjs --source <fork目录> --home <独立DSH_HOME> --pnpm <已安装pnpm的bin/pnpm.mjs>');
const source = resolve(values.source), pnpm = resolve(values.pnpm);
verifySource(source);
const version = spawnSync(process.execPath, [pnpm, '--version'], { encoding: 'utf8', windowsHide: true, shell: false });
if (version.status !== 0 || version.stdout.trim() !== '11.28.5') throw new Error('此固定 fork 构建要求本地已安装 pnpm 11.28.5');
// Dependencies must already have been installed by the owner. No fetching,
// package-manager bootstrap, npx, dlx, or upstream fallback happens here.
const build = spawnSync(process.execPath, [pnpm, '--offline', 'run', 'build:artifacts'],
  { cwd: source, stdio: 'inherit', windowsHide: true, shell: false, env: { ...process.env, DSH_TELEMETRY_DISABLED: '1' } });
if (build.status !== 0) throw new Error(`fork ${PIN.commit} 构建失败`);
console.log(JSON.stringify(prepareBackend(source, values.home), null, 2));
