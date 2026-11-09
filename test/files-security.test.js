import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,lstat,symlink,link,unlink,rm} from 'node:fs/promises';
import {join,dirname,basename,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {Worker} from 'node:worker_threads';
import {readSource,reviewFiles} from '../scripts/files.mjs';
import {protectedSource,MAX_SOURCE_BYTES} from '../scripts/secure-source.mjs';
import {raceSession} from './fixtures/race-session.js';
import {createTestLink} from './fixtures/link-capability.js';

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
  const {root,outside}=await fixture(t);if(!await createTestLink(t,()=>link(join(outside,'source.txt'),join(root,'hard.txt')),{kind:'hard link'}))return;
  await assert.rejects(readSource(root,'hard.txt'));
});
test('parent directory links/junctions cannot escape the project',async t=>{
  const {root,outside}=await fixture(t);if(!await createTestLink(t,()=>symlink(outside,join(root,'linked'),process.platform==='win32'?'junction':'dir'),{kind:'parent junction/symlink'}))return;
  await assert.rejects(readSource(root,'linked/source.txt'));await assert.rejects(protectedSource(root,'linked',{listing:true}));
});
test('a project-root link is rejected rather than silently canonicalized outside',async t=>{
  const {base,root}=await fixture(t);const alias=join(base,'alias');if(!await createTestLink(t,()=>symlink(root,alias,process.platform==='win32'?'junction':'dir'),{kind:'root junction/symlink'}))return;
  await assert.rejects(readSource(alias,'sub/source.txt'));
});
test('leaf symlinks are rejected when the OS permits their creation',async t=>{
  const {root,outside}=await fixture(t);
  if(!await createTestLink(t,()=>symlink(join(outside,'source.txt'),join(root,'leaf.txt'),'file'),{kind:'leaf file symlink'}))return;
  await assert.rejects(readSource(root,'leaf.txt'));
});
test('concurrent parent replacement never reads an outside source',async t=>{
  const {base,root,outside}=await fixture(t);
  const probe=join(base,'capability-link');
  if(!await createTestLink(t,()=>symlink(outside,probe,process.platform==='win32'?'junction':'dir'),{kind:'real concurrent replacement junction/symlink'}))return;
  await unlink(probe); // Cleanup failures are not permission-skipped.
  const original=await lstat(join(root,'sub'),{bigint:true});
  const worker=new Worker(new URL('./fixtures/fs-race.js',import.meta.url),{workerData:{base}});
  const session=raceSession(worker);let reads=0,linkedRounds=0,result;
  async function inspect(){
    reads++;
    try{return {bytes:await readSource(root,'sub/source.txt')};}
    catch(error){return {error};}
  }
  function trustedOrRefused(outcome){
    if(outcome.bytes)assert.equal(outcome.bytes.toString(),'trusted source');
    else assert.ok(outcome.error instanceof Error);
  }
  try{
    for(let round=0;round<10;round++){
      // Fully create the junction away from the read path before allowing reads.
      await session.exchange('arm','armed',round);
      // Round zero requires a real replacement before any read starts. Later
      // rounds overlap reads and attacks; Windows may block the replacement.
      const inFlight=round===0?[]:Array.from({length:3},inspect);
      let outcomes,prepared;
      try{
        prepared=await session.exchange('attack','prepared',round);
        const during=Array.from({length:round===0?6:3},inspect);
        const settled=await Promise.all([...inFlight,...during]);
        outcomes={settled,during:settled.slice(inFlight.length)};
      }finally{
        await Promise.all(inFlight);
        if(prepared)await session.exchange('release','restored',round);
      }
      // Assert only after cleanup so a failed assertion cannot strand a worker
      // at its release barrier or cause fixture removal during restoration.
      outcomes.settled.forEach(trustedOrRefused);
      assert.ok(prepared.linked||prepared.blocked,'attack must link or be blocked by the OS');
      if(round===0)assert.equal(prepared.linked,true,'a real replacement is mandatory');
      if(prepared.linked){linkedRounds++;for(const outcome of outcomes.during)assert.ok(outcome.error,'reads while the attack link is held must be refused');}
    }
    result=await session.finish();
  }finally{await session.dispose();}
  assert.equal(reads,60);assert.equal(result.swaps,linkedRounds);assert.ok(result.swaps>0);
  assert.equal(result.rounds,10);assert.equal(result.restored,true);
  const restored=await lstat(join(root,'sub'),{bigint:true});
  assert.equal(restored.isSymbolicLink(),false);assert.equal(restored.dev,original.dev);assert.equal(restored.ino,original.ino);
  for(const path of [join(root,'parked'),join(base,'attack-link')])await assert.rejects(lstat(path),error=>error.code==='ENOENT');
  assert.equal(await readFile(join(outside,'source.txt'),'utf8'),'outside fixture');
  assert.equal((await readSource(root,'sub/source.txt')).toString(),'trusted source');
});
test('the source adapter contains no path-based stat-then-read fallback',async()=>{
  const source=await readFile(new URL('../scripts/files.mjs',import.meta.url),'utf8');
  assert.ok(!/\b(?:lstat|readFile|realpath)\s*\(/.test(source));
});
