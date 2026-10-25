import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { AcpClient } from '../lib/acp-client.js';
import { normalizeModelOptions } from '../lib/model.js';

const { values } = parseArgs({ options: { config: { type: 'string' }, cwd: { type: 'string' } } });
if (!values.config) throw new Error('用法：node scripts/backend-smoke.mjs --config <backend-config.json> --cwd <现存绝对工作区>');
const config = JSON.parse(readFileSync(values.config, 'utf8'));
const client = new AcpClient(config);
try {
  const initialized = await client.start();
  const session = await client.request('session/new', { cwd: resolve(values.cwd ?? '.'), mcpServers: [] });
  await client.request('session/close', { sessionId: session.sessionId });
  const restored = await client.request('session/resume', { sessionId: session.sessionId, cwd: resolve(values.cwd ?? '.'), mcpServers: [] });
  await client.request('session/close', { sessionId: session.sessionId });
  console.log(JSON.stringify({ initialized, models: normalizeModelOptions(restored.configOptions),
    sessionLifecycle: 'new/close/resume/close passed', modelPrompt: 'not run; requires owner login/credentials' }, null, 2));
} finally { await client.stop(); }
