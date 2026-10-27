import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { AcpClient, redactStderr } from '../lib/acp-client.js';
import { inside, validateHome, verifyBackend } from '../backend/provenance.js';
import { homedir } from 'node:os';

const fixture = `
import readline from 'node:readline';
const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
let permissionPrompt;
readline.createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line); const reply=result=>send({id:m.id,result});
 if(m.method==='initialize') return reply({protocolVersion:1,agentCapabilities:{sessionCapabilities:{resume:{}}}});
 if(m.method==='session/new' && m.params.mode==='hang') return;
 if(m.method==='echo') return setTimeout(()=>reply(m.params),m.params.delay||0);
 if(m.method==='session/prompt') {
   if(m.params.mode==='permission') {permissionPrompt=m.id; return send({id:'ask-1',method:'session/request_permission',params:{sessionId:m.params.sessionId,options:[{optionId:'yes',kind:'allow_once'},{optionId:'no',kind:'reject_once'}]}});}
   if(m.params.mode==='hang') return;
   send({method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'ok'}}}});
   return reply({stopReason:'end_turn'});
 }
 if(m.id==='ask-1') return send({id:permissionPrompt,result:m.result});
 if(m.method==='session/close') return setTimeout(()=>reply({}),60);
 if(m.method==='session/cancel') return;
 if(m.method==='die') return process.exit(7);
 if(m.method==='bad') return process.stdout.write('not-json\\n');
 if(m.method==='logs') {process.stderr.write('token=very-secret\\nBearer abc');setTimeout(()=>{process.stderr.write('def\\n');reply({});},10);return;}
 reply({});
});
`;

function client(t, options = {}, config = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh chat acp '));
  const script = join(directory, 'mock server.mjs'); writeFileSync(script, fixture);
  const client = new AcpClient({requestTimeoutMs:1000,startupTimeoutMs:1000,...config}, {
    verifyBackend: () => ({command:process.execPath,args:[script],cwd:directory,env:process.env}),
    logger: { warn() {} }, ...options });
  t.after(async()=>{await client.stop();rmSync(directory,{recursive:true,force:true});});
  return client;
}

test('initialize once, concurrent request ids, updates and paths with spaces', async t => {
  const acp=client(t); const starts=await Promise.all([acp.start(),acp.start()]);
  assert.equal(starts[0].protocolVersion,1);
  const [a,b]=await Promise.all([acp.request('echo',{n:1,delay:30}),acp.request('echo',{n:2})]);
  assert.equal(a.n,1);assert.equal(b.n,2);
  const update=once(acp,'update');
  await acp.request('session/prompt',{sessionId:'s'});
  assert.equal((await update)[0].update.content.text,'ok');
});

test('permission fails closed, policy can select an offered one-shot choice', async t => {
  const acp=client(t);await acp.start();
  let result=await acp.request('session/prompt',{sessionId:'s',mode:'permission'});
  assert.deepEqual(result,{outcome:{outcome:'selected',optionId:'no'}});
  acp.onPermission=()=>true;
  result=await acp.request('session/prompt',{sessionId:'s',mode:'permission'});
  assert.equal(result.outcome.optionId,'yes');
});

test('permission policy timeout returns cancelled and does not block prompt', async t => {
  const acp=client(t,{onPermission:()=>new Promise(()=>{})},{permissionTimeoutMs:20});await acp.start();
  const result=await acp.request('session/prompt',{sessionId:'s',mode:'permission'});
  assert.equal(result.outcome.outcome,'cancelled');
});

test('timeout quarantines a session until acknowledged close has drained', async t => {
  const acp=client(t);await acp.start();
  const invalidated=once(acp,'session-invalidated');
  await assert.rejects(acp.request('session/prompt',{sessionId:'s',mode:'hang'},{timeoutMs:25}),{code:'ACP_TIMEOUT'});
  const [{draining}]=await invalidated;
  await assert.rejects(acp.request('session/prompt',{sessionId:'s'}),{code:'ACP_DRAINING'});
  await draining;
  assert.equal((await acp.request('session/prompt',{sessionId:'s'})).stopReason,'end_turn');
});

test('AbortSignal cancels the prompt and exit rejects every pending request', async t => {
  const acp=client(t);await acp.start();
  const controller=new AbortController();
  const pending=acp.request('session/prompt',{sessionId:'s',mode:'hang'},{signal:controller.signal});
  controller.abort();await assert.rejects(pending,{code:'ABORT_ERR'});
  const pendingEcho=acp.request('echo',{delay:500});
  const rejection=assert.rejects(pendingEcho,{code:'ACP_EXIT'});
  await assert.rejects(acp.request('die'),{code:'ACP_EXIT'});await rejection;
});

test('invalid stdout fails protocol rather than being displayed as QQ text', async t => {
  const acp=client(t);await acp.start();
  await assert.rejects(acp.request('bad'),{code:'ACP_PROTOCOL'});
});

test('lost session/new keeps in-flight requests alive, then reconnects', async t => {
  const acp=client(t);await acp.start();
  const exit=once(acp,'exit');
  const inFlight=acp.request('echo',{delay:100});
  await assert.rejects(acp.request('session/new',{mode:'hang'},{timeoutMs:20}),{code:'ACP_TIMEOUT'});
  assert.equal(acp.active,false);
  // New work is refused while the connection is degraded...
  await assert.rejects(acp.request('echo',{}),{code:'ACP_DEGRADED'});
  // ...but the request already on the wire is not aborted.
  assert.deepEqual(await inFlight,{delay:100});
  await exit;
  assert.equal(acp.child,null);
  assert.equal(acp.degraded,null);
  await assert.rejects(acp.request('echo',{}),{code:'ACP_OFFLINE'});
});

test('stderr credentials are redacted across partial chunks', async t => {
  const logs=[];const acp=client(t,{logger:{warn:line=>logs.push(line)}});await acp.start();
  await acp.request('logs');
  assert.ok(logs.length>=2);assert.doesNotMatch(logs.join('\n'),/very-secret|abcdef/);
  assert.doesNotMatch(redactStderr('https://alice:password@example.test/path api_key=secret'),/alice|password@|=secret/);
});

test('provenance accepts any local build with a qq profile and no longer pins a commit', t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh backend '));
  const home = mkdtempSync(join(tmpdir(), 'dsh home '));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
  mkdirSync(join(root, 'apps', 'cli', 'lib'), { recursive: true });
  writeFileSync(join(root, 'apps', 'cli', 'lib', 'bin.js'), '');
  writeFileSync(join(root, 'dsh.cmd'), '');
  mkdirSync(join(home, 'profiles', 'qq'), { recursive: true });
  writeFileSync(join(home, 'profiles', 'qq', 'package.json'), '{}');
  const spec = verifyBackend({ path: join(root, 'dsh.cmd'), dshHome: home, profile: 'qq', expectedCommit: 'deadbeef' });
  assert.equal(spec.args[0], join(root, 'apps', 'cli', 'lib', 'bin.js'));
  assert.deepEqual(spec.warnings, []);
  assert.throws(() => verifyBackend({ path: 'dsh', dshHome: home }), /绝对路径/);
  assert.throws(() => verifyBackend({ path: join(root, 'missing.cmd'), dshHome: home }), /不存在/);
  assert.throws(() => verifyBackend({ path: join(root, 'dsh.cmd'), dshHome: mkdtempSync(join(tmpdir(), 'empty home ')) }), /qq profile/);
  assert.throws(() => inside(tmpdir(), '../outside'), /越界/);
  assert.throws(() => validateHome(join(homedir(), '.dsh')), /独立/);
});

test('a global home patch added after preparation is rejected at every startup', t => {
  const directory=mkdtempSync(join(tmpdir(),'dsh-home-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  assert.equal(validateHome(directory),directory);
  writeFileSync(join(directory,'cordis.patch.yml'),'- id: tool-fs\n  disabled: false\n');
  assert.throws(()=>validateHome(directory),/全局 patch/);
});
