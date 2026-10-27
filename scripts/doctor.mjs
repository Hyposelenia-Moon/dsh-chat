import fs from 'node:fs';
import path from 'node:path';
import {loadConfig,PLUGIN_ROOT} from '../lib/config.js';
import {verifyBackend} from '../backend/provenance.js';
import {Store} from '../model/db.js';
const config = loadConfig();
console.log(`Node ${process.versions.node}; plugin ${PLUGIN_ROOT}`);
const db = new Store({path:':memory:'}); console.log(`SQLite ready; FTS5 ${db.fts?'available':'fallback'}`); db.close();
console.log(`群白名单 ${config.permissions.groupWhitelist.length}; 主人 ${config.permissions.masters.length}; 免费模型 ${config.models.allowFree?'enabled':'disabled'}`);
try {
  const spec = verifyBackend(config.backend);
  const commit = spec.commit ? ` (${String(spec.commit).slice(0, 12)})` : '';
  console.log(`Backend verified: ${spec.cwd}${commit}`);
  for (const warning of spec.warnings) console.warn(`提示：${warning}`);
}
catch (e) { console.error(`Backend not ready: ${e.message}`); process.exitCode = 1; }
const yunzai = path.resolve(PLUGIN_ROOT,'../..','lib/plugins/plugin.js');
console.log(`Yunzai plugin base ${fs.existsSync(yunzai)?'found':'not found (source package outside Yunzai)'}`);
