import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,symlink,link,rm} from 'node:fs/promises';
import {join,dirname,basename,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {Worker} from 'node:worker_threads';
import {readSource,reviewFiles} from '../scripts/files.mjs';
import {protectedSource,MAX_SOURCE_BYTES} from '../scripts/secure-source.mjs';

async function fixture(t){
  const base=await mkdtemp(join(tmpdir(),'my-schedule-security-'));
  t.after(()=>{if(dirname(resolve(base))!==resolve(tmpdir())||!basename(base).startsWith('my-schedule-security-'))throw Error('Invalid cleanup path');return rm(base,{recursive:true,force:true});});
  const root=join(base,'project'),outside=join(base,'outside');
  await mkdir(join(root,'sub'),{recursive:true});await mkdir(outside);
  await writeFile(join(root,'sub','source.txt'),'trusted source');await writeFile(join(outside,'source.txt'),'outside fixture');
  return {base,root,outside};
}
test('protected reader returns exactly the source bytes including special characters',async t=>{
  const {root}=await fixture(t);const text='<svg onload="alert(1)">& 日本語\n';await writeFile(join(root,'sub','source.txt'),text);
  assert.equal((await readSource(root,'sub/source.txt')).toString(),text);
});
test('traversal, absolute paths, ADS/device paths, nulls and ambiguous separators fail closed',async t=>{
  const {root}=await fixture(t);
  for(const name of ['../outside/source.txt','/etc/passwd','C:/outside/source.txt','sub/../source.txt','sub\\source.txt','sub//source.txt','sub/source.txt:stream','sub/source.txt\0','sub/source.txt.','sub/source.txt '])await assert.rejects(readSource(root,name));
  await assert.rejects(readSource(root,null));await assert.rejects(readSource('relative','source.txt'));
});
test('directories and oversized sources cannot be read as regular source files',async t=>{
  const {root}=await fixture(t);await assert.rejects(readSource(root,'sub'));
  await writeFile(join(root,'large.bin'),Buffer.alloc(MAX_SOURCE_BYTES+1));await assert.rejects(readSource(root,'large.bin'));
});
test('hard links to an outside file are rejected without exposing its bytes',async t=>{
  const {root,outside}=await fixture(t);await link(join(outside,'source.txt'),join(root,'hard.txt'));
  await assert.rejects(readSource(root,'hard.txt'));
});
test('parent directory links/junctions cannot escape the project',async t=>{
  const {root,outside}=await fixture(t);await symlink(outside,join(root,'linked'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(readSource(root,'linked/source.txt'));await assert.rejects(protectedSource(root,'linked',{listing:true}));
});
test('a project-root link is rejected rather than silently canonicalized outside',async t=>{
  const {base,root}=await fixture(t);const alias=join(base,'alias');await symlink(root,alias,process.platform==='win32'?'junction':'dir');
  await assert.rejects(readSource(alias,'sub/source.txt'));
});
test('leaf symlinks are rejected when the OS permits their creation',async t=>{
  const {root,outside}=await fixture(t);
  try{await symlink(join(outside,'source.txt'),join(root,'leaf.txt'),'file');}
  catch(error){if(process.platform==='win32'&&error.code==='EPERM'){t.skip('Windows file-symlink creation privilege is unavailable; junction cases run separately');return;}throw error;}
  await assert.rejects(readSource(root,'leaf.txt'));
});
test('concurrent parent replacement never reads an outside source',async t=>{
  const {base,root}=await fixture(t);const worker=new Worker(new URL('./fixtures/fs-race.js',import.meta.url),{workerData:{base}});
  let resolveReady,rejectReady,resolveDone,rejectDone,result,readySeen=false;
  const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
  const done=new Promise((resolve,reject)=>{resolveDone=resolve;rejectDone=reject;});
  // Attach handlers before the first read, including worker failure/early exit.
  ready.catch(()=>{});done.catch(()=>{});
  worker.on('message',message=>{if(message.type==='ready'){readySeen=true;resolveReady();}else if(message.type==='result')result=message;});
  worker.on('error',error=>{rejectReady(error);rejectDone(error);});
  worker.on('exit',code=>{
    if(code!==0||!readySeen||!result?.restored){const error=Error('Race worker failed before restoring its workspace');rejectReady(error);rejectDone(error);}
    else resolveDone(result);
  });
  let successes=0,failures=0;
  try{
    await ready;
    for(let i=0;i<60;i++){
      try{const bytes=await readSource(root,'sub/source.txt');assert.equal(bytes.toString(),'trusted source');successes++;}
      catch(error){if(error.code==='ERR_ASSERTION')throw error;failures++;}
    }
  }finally{worker.postMessage({type:'stop'});await done;}
  assert.ok(successes+failures===60);assert.ok(result.swaps>0,'race must actually replace the parent');
  assert.equal(result.restored,true);
  assert.equal((await readSource(root,'sub/source.txt')).toString(),'trusted source');
});
test('the source adapter contains no path-based stat-then-read fallback',async()=>{
  const source=await readFile(new URL('../scripts/files.mjs',import.meta.url),'utf8');
  assert.ok(!/\b(?:lstat|readFile|realpath)\s*\(/.test(source));
});
