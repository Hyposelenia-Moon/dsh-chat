import {spawnSync} from 'node:child_process';
import path from 'node:path';
const result = spawnSync(process.execPath,['--test','test/runtime.test.js','test/mcp.test.js'],{cwd:path.resolve(import.meta.dirname,'..'),stdio:'inherit',windowsHide:true});
process.exitCode = result.status ?? 1;
