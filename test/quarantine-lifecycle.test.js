import test from 'node:test';
import assert from 'node:assert/strict';
import {ScheduleStore} from '../src/storage.js';
import {STORAGE_KEY,seed,complete,serializeState} from '../src/model.js';
const A='corrupt-A\ud800\u0000',B='corrupt-B\udfff';
const approval={replace:true,emergency:true,quarantine:'skip'};
const source={data:seed('2026-11-09'),exportedAt:'2026-11-09T03:00:00.000Z'};
async function fixture(){
  const values=new Map([[STORAGE_KEY,A]]);let failWrite=false,failRead=false,failReadback=false,writes=0;
  const storage={getItem(key){if(key===STORAGE_KEY&&failRead)throw Error('read denied');return values.get(key)??null;},setItem(key,value){
    if(key===STORAGE_KEY){if(failWrite)throw Error('write denied');writes++;}values.set(key,value);if(key===STORAGE_KEY&&failReadback)failRead=true;
  }};
  const locks={request:async(name,options,action)=>action()},store=new ScheduleStore({storage,locks,now:()=>new Date('2026-11-09T03:00:00Z')});await store.refresh();
  return {store,values,storage,get writes(){return writes;},writeFail(value=true){failWrite=value;},readFail(value=true){failRead=value;},readbackFail(value=true){failReadback=value;},preview(){return store.preview(source);}};
}
async function raw(file){const bytes=new Uint8Array(await file.arrayBuffer());let text='';for(let i=0;i<bytes.length;i+=2)text+=String.fromCharCode(bytes[i]|bytes[i+1]<<8);return text;}

test('review reproduction: A -> verified recovery -> B exports B, never stale A',async()=>{
  const f=await fixture();assert.equal((await f.store.restore(f.preview(),approval)).ok,true);
  assert.equal(f.store.currentCorruption,null);assert.equal(f.store.retainedQuarantineInfo().length,0);
  f.values.set(STORAGE_KEY,B);await f.store.refresh();const artifact=f.store.quarantine();
  assert.equal(artifact.source,'current');assert.equal(await raw(artifact.file),B);assert.equal(artifact.currentMatch,true);
  assert.ok(artifact.capturedAt&&artifact.checkedAt);assert.ok(artifact.file.name.includes('current'));
});

test('review reproduction: failed recovery of A -> observed B exports B and labels retained A separately',async()=>{
  const f=await fixture();f.writeFail();assert.equal((await f.store.restore(f.preview(),approval)).reason,'save');
  const target=f.store.retainedQuarantineInfo()[0];assert.ok(target);
  f.values.set(STORAGE_KEY,B);await f.store.refresh();const current=f.store.quarantine(),retained=f.store.retainedQuarantine(target.id);
  assert.equal(await raw(current.file),B);assert.equal(current.source,'current');
  assert.equal(await raw(retained.file),A);assert.equal(retained.source,'retained');assert.equal(retained.currentMatch,false);
  assert.notEqual(current.file.name,retained.file.name);assert.equal(f.values.get(STORAGE_KEY),B);
});

test('changed storage without a refresh blocks stale current export before producing any artifact',async()=>{
  const f=await fixture();f.writeFail();await f.store.restore(f.preview(),approval);f.values.set(STORAGE_KEY,B);
  assert.throws(()=>f.store.quarantine(),error=>error.reason==='quarantine-conflict');
  assert.equal(f.store.currentCorruption.raw,B);assert.equal(await raw(f.store.quarantine().file),B);
});

test('unverified A retains A while newly observed B is a distinct current snapshot',async()=>{
  const f=await fixture();f.readbackFail();assert.equal((await f.store.restore(f.preview(),approval)).committed,null);
  assert.equal(f.store.status,'unverified');assert.equal(f.store.currentCorruption,null);
  f.readFail(false);f.values.set(STORAGE_KEY,B);await f.store.refresh();
  assert.equal(f.store.status,'unverified');assert.equal(f.store.writable,false);
  assert.equal(await raw(f.store.quarantine().file),B);const retained=f.store.retainedQuarantine();
  assert.equal(await raw(retained.file),A);assert.equal(retained.source,'retained');assert.equal(retained.currentMatch,false);assert.equal(f.writes,1);
});

test('unreadable storage blocks current export but permits explicitly historical A with unknown currentness',async()=>{
  const f=await fixture();f.writeFail();await f.store.restore(f.preview(),approval);const target=f.store.retainedQuarantineInfo()[0];
  f.readFail();assert.throws(()=>f.store.quarantine(),error=>error.reason==='quarantine-unreadable');
  const retained=f.store.retainedQuarantine(target.id);assert.equal(retained.currentMatch,null);assert.equal(retained.source,'retained');assert.equal(await raw(retained.file),A);
});

test('prepared current file must be rechecked immediately before share/download and receipt',async()=>{
  const f=await fixture(),artifact=f.store.quarantine();f.values.set(STORAGE_KEY,B);
  assert.throws(()=>f.store.verifyQuarantine(artifact),error=>error.reason==='quarantine-conflict');
  assert.equal(f.store.currentCorruption.raw,B);assert.equal(f.values.get(STORAGE_KEY),B);
  const replacement=f.store.quarantine();assert.doesNotThrow(()=>f.store.verifyQuarantine(replacement));
});

for(const replacement of ['valid','missing'])test('current export stops if corruption is no longer current: '+replacement,async()=>{
  const f=await fixture();if(replacement==='valid')f.values.set(STORAGE_KEY,serializeState(source.data));else f.values.delete(STORAGE_KEY);
  assert.throws(()=>f.store.quarantine(),error=>error.reason==='quarantine-conflict');assert.equal(f.store.currentCorruption,null);
  assert.throws(()=>f.store.quarantine(),error=>error.reason==='quarantine-missing');
});

test('verified recovery retires failed-attempt targets and expires their prepared historical artifacts',async()=>{
  const f=await fixture();f.writeFail();await f.store.restore(f.preview(),approval);const target=f.store.retainedQuarantineInfo()[0],artifact=f.store.retainedQuarantine(target.id);
  f.writeFail(false);assert.equal((await f.store.restore(f.preview(),approval)).ok,true);
  assert.equal(f.store.retainedQuarantineInfo().length,0);assert.equal(f.store.currentCorruption,null);
  assert.throws(()=>f.store.verifyQuarantine(artifact),error=>error.reason==='quarantine-expired');
});

test('multiple failed episodes retain distinct preimages without marking any of them current',async()=>{
  const f=await fixture();f.writeFail();await f.store.restore(f.preview(),approval);
  f.values.set(STORAGE_KEY,B);await f.store.refresh();await f.store.restore(f.preview(),approval);
  const retained=f.store.retainedQuarantineInfo();assert.equal(retained.length,2);assert.equal(await raw(f.store.quarantine().file),B);
  assert.deepEqual(retained.map(target=>f.store.retainedQuarantine(target.id).source),['retained','retained']);
  assert.equal(await raw(f.store.retainedQuarantine(retained[0].id).file),A);assert.equal(await raw(f.store.retainedQuarantine(retained[1].id).file),B);
});

test('retention exhaustion refuses a new write rather than silently evicting old preimages',async()=>{
  const f=await fixture();f.writeFail();
  for(let i=0;i<8;i++){f.values.set(STORAGE_KEY,'corrupt-'+i);await f.store.refresh();assert.equal((await f.store.restore(f.preview(),approval)).reason,'save');}
  const retained=f.store.retainedQuarantineInfo();f.values.set(STORAGE_KEY,'corrupt-new');await f.store.refresh();f.writeFail(false);
  assert.equal((await f.store.restore(f.preview(),approval)).ok,false);assert.equal(f.values.get(STORAGE_KEY),'corrupt-new');assert.deepEqual(f.store.retainedQuarantineInfo(),retained);
});

test('successful recovery still permits ordinary completion and a subsequent normal restore',async()=>{
  const f=await fixture();assert.equal((await f.store.restore(f.preview(),approval)).ok,true);
  assert.equal((await f.store.mutate(data=>complete(data,'sample-task-1'))).ok,true);assert.equal(f.store.state.history.length,1);
  assert.equal((await f.store.restore(f.store.preview(source),approval)).ok,true);assert.equal(f.store.state.history.length,0);assert.equal(f.store.protection,null);
});

test('backup and redraw observations cannot release protection or discard a retained preimage',async()=>{
  const f=await fixture();f.readbackFail();await f.store.restore(f.preview(),approval);f.readFail(false);
  await f.store.refresh();await f.store.backup();const info=f.store.retainedQuarantineInfo();
  assert.equal(f.store.status,'unverified');assert.equal(f.store.currentCorruption,null);assert.equal(await raw(f.store.retainedQuarantine().file),A);
  assert.deepEqual(f.store.retainedQuarantineInfo(),info);assert.equal((await f.store.mutate(d=>{d.items=[];})).ok,false);assert.equal(f.writes,1);
});

test('verified emergency recovery of a deleted key also ends prior failed episodes',async()=>{
  const f=await fixture();f.writeFail();await f.store.restore(f.preview(),approval);assert.equal(f.store.retainedQuarantineInfo().length,1);
  f.values.delete(STORAGE_KEY);await f.store.refresh();f.writeFail(false);assert.equal((await f.store.restore(f.preview(),approval)).ok,true);assert.equal(f.store.retainedQuarantineInfo().length,0);
});

test('historical exports recheck currentness at save time without changing frozen file bytes',async()=>{
  const f=await fixture();f.writeFail();await f.store.restore(f.preview(),approval);const artifact=f.store.retainedQuarantine(f.store.retainedQuarantineInfo()[0].id);
  assert.equal(artifact.currentMatch,true);f.values.set(STORAGE_KEY,B);assert.equal(f.store.verifyQuarantine(artifact).currentMatch,false);
  f.readFail();assert.equal(f.store.verifyQuarantine(artifact).currentMatch,null);assert.equal(await raw(artifact.file),A);assert.equal(artifact.source,'retained');
});
