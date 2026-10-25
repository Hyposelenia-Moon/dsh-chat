import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const root = path.resolve(import.meta.dirname,'..');
let checked = 0;
function walk(directory) {
  for (const entry of fs.readdirSync(directory,{withFileTypes:true})) {
    if (['node_modules','data','.git'].includes(entry.name)) continue;
    const file = path.join(directory,entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.(m?js)$/.test(file)) {
      const result = spawnSync(process.execPath,['--check',file],{encoding:'utf8',windowsHide:true});
      if (result.status !== 0) { process.stderr.write(result.stderr); process.exitCode = 1; }
      checked++;
    }
  }
}
walk(root); console.log(`Syntax checked ${checked} JavaScript files.`);
