import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
test('Yunzai directory layout resolves real plugin entry and initializes local services without spawning ACP',async()=>{
  const source=path.resolve(import.meta.dirname,'..');
  const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-yunzai-layout-'));
  const target=path.join(fixture,'plugins','dsh-chat');
  let api;
  try {
    fs.mkdirSync(path.join(fixture,'lib','plugins'),{recursive:true});
    fs.writeFileSync(path.join(fixture,'package.json'),'{"type":"module"}');
    fs.writeFileSync(path.join(fixture,'lib','plugins','plugin.js'),'export default class Plugin { constructor(options) { Object.assign(this,options); } }');
    fs.cpSync(source,target,{recursive:true,filter:file=>!path.relative(source,file).split(path.sep).some(p=>['node_modules','data','.git'].includes(p))});
    fs.symlinkSync(path.join(source,'node_modules'),path.join(target,'node_modules'),process.platform==='win32'?'junction':'dir');
    const module=await import(pathToFileURL(path.join(target,'index.js')).href);
    api=await import(pathToFileURL(path.join(target,'lib','runtime.js')).href);
    assert.deepEqual(Object.keys(module.apps).sort(),['admin','chat','panel']);
    assert.equal(new module.apps.chat().event,'message');
    assert.equal(module.getRuntime().acp.child,null);
    assert.ok(module.getRuntime().scheduler.timer);
    assert.equal(module.supportGuoba().pluginInfo.name,'dsh-chat');
  } finally { await api?.stopRuntime(); fs.rmSync(fixture,{recursive:true,force:true}); }
});
