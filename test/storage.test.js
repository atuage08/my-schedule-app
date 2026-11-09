import test from 'node:test';
import assert from 'node:assert/strict';
import {ScheduleStore,LOCK_NAME,META_KEY,BACKUP_INTERVAL} from '../src/storage.js';
import {STORAGE_KEY,seed,serializeState,complete} from '../src/model.js';
import {createBackup,readBackupFile} from '../src/backup.js';
class Memory{
  map=new Map();failWrite=false;failMeta=false;failRead=false;afterWriteRead=false;
  getItem(key){if(this.failRead||(key===STORAGE_KEY&&this.afterWriteRead))throw Error('private read error');return this.map.get(key)??null;}
  setItem(key,value){if((key===STORAGE_KEY&&this.failWrite)||(key===META_KEY&&this.failMeta))throw Error('private write error');this.map.set(key,value);if(key===STORAGE_KEY&&this.armReadFailure)this.afterWriteRead=true;}
}
class Locks{
  tail=Promise.resolve();names=[];
  request(name,options,action){this.names.push(name);const next=this.tail.then(action);this.tail=next.catch(()=>{});return next;}
}
async function setup({raw=serializeState(seed('2026-11-09')),storage=new Memory(),locks=new Locks()}={}){
  if(raw!==null)storage.map.set(STORAGE_KEY,raw);
  let clock=new Date('2026-11-09T03:00:00Z');const store=new ScheduleStore({storage,locks,now:()=>new Date(clock)});
  await store.refresh();return {store,storage,locks,setTime(value){clock=new Date(value);},getTime(){return clock.getTime();}};
}
const approval={replace:true,emergency:true,quarantine:'skip'};
async function source(){return readBackupFile((await createBackup(seed('2026-11-09'),new Date('2026-11-09T03:00:00Z'))).file);}
test('normal mutation saves verified data and marks first user change only after success',async()=>{
  const {store,storage}=await setup();assert.equal((await store.reminder()).kind,'unknown');
  const result=await store.mutate(draft=>{draft.items[0].title='変更';});
  assert.equal(result.ok,true);assert.equal(result.verified,true);assert.equal(JSON.parse(storage.getItem(META_KEY)).engaged,true);assert.equal((await store.reminder()).kind,'first');
});
test('initial samples and automatic rollover alone do not trigger first-backup prompts',async()=>{
  const storage=new Memory(),store=new ScheduleStore({storage,locks:new Locks()});await store.initialize();await store.rollover();
  assert.equal((await store.reminder()).kind,'none');assert.equal(JSON.parse(storage.getItem(META_KEY)).engaged,false);
});
test('no-op and failed user mutations do not mark data as changed',async()=>{
  const {store,storage}=await setup();await store.mutate(()=>{});assert.equal(storage.getItem(META_KEY),null);
  storage.failWrite=true;const before=storage.getItem(STORAGE_KEY);const result=await store.mutate(draft=>{draft.items[0].title='失敗する変更';});
  assert.equal(result.ok,false);assert.equal(storage.getItem(STORAGE_KEY),before);assert.equal(storage.getItem(META_KEY),null);
});
test('cooperating simultaneous saves use one lock and the stale writer cannot overwrite',async()=>{
  const a=await setup(),b=new ScheduleStore({storage:a.storage,locks:a.locks});await b.refresh();
  const results=await Promise.all([a.store.mutate(d=>{d.items[0].title='first';}),b.mutate(d=>{d.items[0].title='second';})]);
  assert.equal(results.filter(r=>r.ok).length,1);assert.equal(results.find(r=>!r.ok).reason,'conflict');assert.equal(JSON.parse(a.storage.getItem(STORAGE_KEY)).items[0].title,'first');
  assert.ok(a.locks.names.every(name=>name===LOCK_NAME));
});
test('queued same-screen changes reject a second save and an old editor token',async()=>{
  const {store}=await setup(),base=store.token();
  const first=store.mutate(d=>{d.items[0].title='first';});const second=await store.mutate(d=>{d.items[0].title='second';});
  assert.equal(second.reason,'busy');assert.equal((await first).ok,true);assert.equal((await store.mutate(d=>{d.items[0].title='stale';},base)).reason,'conflict');
});
test('a change while waiting for the lock is detected after acquisition',async()=>{
  const {store,storage,locks}=await setup();let release;
  locks.tail=new Promise(resolve=>{release=resolve;});const pending=store.mutate(d=>{d.items[0].title='stale';});
  const newer=seed('2026-11-09');newer.items[0].title='external';storage.map.set(STORAGE_KEY,serializeState(newer));release();
  assert.equal((await pending).reason,'conflict');assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).items[0].title,'external');
});
test('delayed storage notifications reread latest content; deletion and clear never reseed',async()=>{
  const {store,storage}=await setup();const newer=seed('2026-11-09');newer.items[0].title='latest';storage.map.set(STORAGE_KEY,serializeState(newer));
  await store.refresh();await store.refresh();assert.equal(store.state.items[0].title,'latest');
  storage.map.delete(STORAGE_KEY);await store.refresh();assert.equal(store.status,'missing');assert.equal(storage.getItem(STORAGE_KEY),null);
  storage.map.clear();await store.refresh();assert.equal(store.status,'missing');assert.equal((await store.mutate(()=>{})).ok,false);
});
test('normal restore waits for approval and commits all history without resetting backup confirmation',async()=>{
  const {store,storage}=await setup(),data=seed('2026-11-09');data.history.push({id:'old',title:'架空旧履歴',due:null,completedAt:'2001-01-01T00:00:00Z'});
  const file=await createBackup(data),preview=store.preview(await readBackupFile(file.file)),before=store.raw;
  assert.equal((await store.restore(preview,{})).ok,false);assert.equal(store.raw,before);
  const result=await store.restore(preview,approval);assert.equal(result.ok,true);assert.equal(store.state.history.length,1);assert.equal(JSON.parse(storage.getItem(META_KEY)).confirmed,null);
});
test('normal restore and normal save compete and stale confirmation cannot win',async()=>{
  const a=await setup(),b=new ScheduleStore({storage:a.storage,locks:a.locks});await b.refresh();const preview=a.store.preview(await source());
  await b.mutate(d=>{d.items[0].title='newer';});const result=await a.store.restore(preview,approval);
  assert.equal(result.reason,'conflict');assert.equal(JSON.parse(a.storage.getItem(STORAGE_KEY)).items[0].title,'newer');
});
test('same-screen changes invalidate restoration and deletion while confirming is not overwritten',async()=>{
  const {store,storage}=await setup();let preview=store.preview(await source());await store.mutate(d=>{d.items[0].title='local newer';});
  assert.equal((await store.restore(preview,approval)).reason,'conflict');preview=store.preview(await source());storage.map.delete(STORAGE_KEY);
  assert.equal((await store.restore(preview,approval)).reason,'conflict');assert.equal(storage.getItem(STORAGE_KEY),null);
});
test('midnight changes require renewed approval when the rollover candidate differs',async()=>{
  const context=await setup(),data=seed('2026-11-09');data.items[2].repeat='daily';const preview=context.store.preview({data,exportedAt:'2026-11-09T03:00:00.000Z'}),before=context.storage.getItem(STORAGE_KEY);
  context.setTime('2026-11-10T03:00:00Z');const result=await context.store.restore(preview,approval);
  assert.equal(result.reason,'date');assert.equal(context.storage.getItem(STORAGE_KEY),before);assert.equal(result.preview.plan.candidate.items[2].due,'2026-11-10');
  assert.equal((await context.store.restore(result.preview,approval)).ok,true);
});
test('out-of-range clock cannot partially apply restoration',async()=>{
  const context=await setup(),preview=context.store.preview(await source()),before=context.store.raw;context.setTime('2102-01-01T03:00:00Z');
  assert.equal((await context.store.restore(preview,approval)).ok,false);assert.equal(context.storage.getItem(STORAGE_KEY),before);
});
for(const raw of ['{broken','{"version":99}', 'broken\ud800\u0000'])test('emergency recovery preserves corrupt input until final approval: variant '+raw.length,async()=>{
  const {store,storage}=await setup({raw});assert.equal(store.status,'corrupt');assert.equal((await store.mutate(()=>{})).ok,false);
  const preview=store.preview(await source());assert.equal(preview.emergency,true);assert.equal(storage.getItem(STORAGE_KEY),raw);
  assert.equal((await store.restore(preview,{replace:true})).ok,false);assert.equal(storage.getItem(STORAGE_KEY),raw);
  assert.equal((await store.restore(preview,approval)).ok,true);assert.equal(store.status,'ready');assert.equal(store.state.items.length,6);
});
for(const mode of ['normal','emergency'])test(mode+' restore failure leaves the complete original storage unchanged',async()=>{
  const raw=mode==='normal'?serializeState(seed('2026-11-09')):'{corrupt';const {store,storage}=await setup({raw});
  const preview=store.preview(await source());storage.failWrite=true;const result=await store.restore(preview,approval);
  assert.equal(result.ok,false);assert.equal(result.committed,false);assert.equal(storage.getItem(STORAGE_KEY),raw);
});
test('emergency baseline change to valid or different corrupt data aborts without overwriting',async()=>{
  for(const replacement of ['{other-corrupt',serializeState(seed('2026-11-10'))]){
    const {store,storage}=await setup({raw:'{original-corrupt'}),preview=store.preview(await source());storage.map.set(STORAGE_KEY,replacement);
    assert.equal((await store.restore(preview,approval)).reason,'conflict');assert.equal(storage.getItem(STORAGE_KEY),replacement);
  }
});
test('unreadable storage permits file validation but no replacement; original bytes stay intact',async()=>{
  const {store,storage}=await setup({raw:'broken'});storage.failRead=true;await store.refresh();assert.equal(store.status,'unavailable');
  const valid=await source();assert.equal(valid.data.items.length,6);assert.throws(()=>store.preview(valid));assert.equal(storage.map.get(STORAGE_KEY),'broken');
});
test('postwrite verification failure is distinct from save failure and blocks further writes',async()=>{
  const {store,storage}=await setup({raw:'broken'}),preview=store.preview(await source());storage.armReadFailure=true;
  const result=await store.restore(preview,approval);assert.equal(result.ok,false);assert.equal(result.committed,null);assert.equal(result.verified,false);assert.equal(store.status,'unverified');
  assert.doesNotThrow(()=>JSON.parse(storage.map.get(STORAGE_KEY)));assert.equal((await store.mutate(()=>{})).ok,false);
});
test('lock absence is read-only and never silently uses an unlocked write',async()=>{
  const {store,storage}=await setup({locks:null});const before=storage.getItem(STORAGE_KEY);
  assert.equal((await store.mutate(d=>{d.items[0].title='no lock';})).reason,'locks');assert.equal((await store.restore(store.preview(await source()),approval)).reason,'locks');
  assert.equal(storage.getItem(STORAGE_KEY),before);assert.ok((await store.backup()).file);
});
test('snapshot confirmation never marks changes made during sharing as backed up',async()=>{
  const context=await setup(),file=await context.store.backup();await context.store.mutate(d=>{d.items[0].title='after preparation';});
  await context.store.confirmBackup(file);const receipt=JSON.parse(context.storage.getItem(META_KEY)).confirmed;
  assert.equal(receipt.digest,file.digest);context.setTime(context.getTime()+BACKUP_INTERVAL);assert.equal((await context.store.reminder()).kind,'due');
});
test('336-hour boundary requires both elapsed time and changed data',async()=>{
  const context=await setup(),file=await context.store.backup();await context.store.confirmBackup(file);const at=context.getTime();
  context.setTime(at+BACKUP_INTERVAL-1);assert.equal((await context.store.reminder()).kind,'none');
  await context.store.mutate(d=>{d.items[0].title='changed';});assert.equal((await context.store.reminder()).kind,'none');
  context.setTime(at+BACKUP_INTERVAL);assert.equal((await context.store.reminder()).kind,'due');context.setTime(at+BACKUP_INTERVAL+1);assert.equal((await context.store.reminder()).kind,'due');
  const unchanged=await setup();await unchanged.store.confirmBackup(await unchanged.store.backup());unchanged.setTime(unchanged.getTime()+BACKUP_INTERVAL);assert.equal((await unchanged.store.reminder()).kind,'none');
});
test('automatic rollover counts as changed data after a saved backup',async()=>{
  const context=await setup(),data=seed('2026-11-09');data.items[2].repeat='daily';context.storage.map.set(STORAGE_KEY,serializeState(data));await context.store.refresh();
  await context.store.confirmBackup(await context.store.backup());context.setTime(context.getTime()+BACKUP_INTERVAL);await context.store.rollover();assert.equal((await context.store.reminder()).kind,'due');
});
test('other-tab confirmation is reread without adopting delayed event payloads',async()=>{
  const context=await setup();await context.store.mutate(d=>{d.items[0].title='changed';});assert.equal((await context.store.reminder()).kind,'first');
  const other=new ScheduleStore({storage:context.storage,locks:context.locks,now:()=>new Date(context.getTime())});await other.refresh();await other.confirmBackup(await other.backup());
  assert.equal((await context.store.reminder()).kind,'none');
});
test('clock rollback and future confirmation records do not produce a false elapsed-time claim',async()=>{
  const context=await setup();await context.store.confirmBackup(await context.store.backup());context.setTime(context.getTime()-1);assert.equal((await context.store.reminder()).kind,'clock');
});
test('missing and corrupt metadata are unknown; failed confirmation never reports success',async()=>{
  const {store,storage}=await setup();assert.equal((await store.reminder()).kind,'unknown');storage.map.set(META_KEY,'{broken');assert.equal((await store.reminder()).kind,'unknown');
  const before=storage.getItem(META_KEY),file=await store.backup();storage.failMeta=true;assert.equal((await store.confirmBackup(file)).ok,false);assert.equal(storage.getItem(META_KEY),before);
});
test('metadata failure does not undo a verified data save and is reported separately',async()=>{
  const {store,storage}=await setup();storage.failMeta=true;const result=await store.mutate(d=>{d.items[0].title='saved';});
  assert.equal(result.ok,true);assert.ok(result.warning);assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).items[0].title,'saved');
});
test('backups export persisted state even after failed rollover and have no hidden save confirmation',async()=>{
  const context=await setup(),data=seed('2026-11-09');data.items[2].repeat='daily';context.storage.map.set(STORAGE_KEY,serializeState(data));await context.store.refresh();
  context.setTime('2026-11-10T03:00:00Z');context.storage.failWrite=true;await context.store.rollover();
  const file=await context.store.backup();assert.equal(file.data.items[2].due,'2026-11-09');assert.equal(context.storage.getItem(META_KEY),null);
});
test('recovery readback remains usable for completion, history undo and reload',async()=>{
  const context=await setup({raw:'{broken'});assert.equal((await context.store.restore(context.store.preview(await source()),approval)).ok,true);
  const task=context.store.state.items.find(item=>item.type==='task');assert.equal((await context.store.mutate(d=>complete(d,task.id))).ok,true);
  const reload=new ScheduleStore({storage:context.storage,locks:context.locks});await reload.refresh();assert.equal(reload.state.history.length,1);
});

test('postwrite recovery verification failure retains original corrupt code units for quarantine',async()=>{
  const context=await setup({raw:'broken\ud800'}),preview=context.store.preview(await source());context.storage.armReadFailure=true;
  const result=await context.store.restore(preview,approval);assert.equal(result.reason,'unverified');assert.equal(context.store.retainedQuarantine().raw,'broken\ud800');
});

test('missing data with existing metadata is not silently replaced by new samples',async()=>{
  const storage=new Memory();storage.map.set(META_KEY,JSON.stringify({version:1,engaged:true,confirmed:null}));const store=new ScheduleStore({storage,locks:new Locks()});
  await store.initialize();assert.equal(store.status,'missing');assert.equal(storage.getItem(STORAGE_KEY),null);
});

test('normal replacement with identical data does not create a first-user-change receipt',async()=>{
  const {store,storage}=await setup();const result=await store.restore(store.preview(await source()),approval);
  assert.equal(result.ok,true);assert.equal(storage.getItem(META_KEY),null);
});

test('ordinary save verification failure also blocks writes rather than reporting success',async()=>{
  const {store,storage}=await setup();storage.armReadFailure=true;
  const result=await store.mutate(d=>{d.items[0].title='saved but unverified';});assert.equal(result.ok,false);assert.equal(result.committed,null);assert.equal(store.status,'unverified');
});

test('refresh alone cannot mutate the adopted state or ignore stale baseline tokens',async()=>{
  const {store}=await setup();assert.throws(()=>{store.state.items[0].title='untracked mutation';},TypeError);
  const token=store.token();await store.refresh();assert.equal(store.matches(token),true);
});

test('uncooperative write detected during readback is not silently rolled back over a third party',async()=>{
  const context=await setup({raw:'{original'}),preview=context.store.preview(await source()),foreign=serializeState(seed('2026-11-10'));
  const set=context.storage.setItem.bind(context.storage);context.storage.setItem=(key,value)=>{set(key,value);if(key===STORAGE_KEY)context.storage.map.set(key,foreign);};
  const result=await context.store.restore(preview,approval);assert.equal(result.reason,'unverified');assert.equal(result.committed,null);
  assert.equal(context.storage.getItem(STORAGE_KEY),foreign);assert.equal(context.store.retainedQuarantine().raw,'{original');
});

test('unchanged data on a new calendar day does not require a different restore candidate',async()=>{
  const context=await setup(),preview=context.store.preview(await source());context.setTime('2026-11-10T03:00:00Z');
  assert.equal((await context.store.restore(preview,approval)).ok,true);
});

for(const replacement of ['valid','corrupt','deleted'])test('unverified recovery remains latched after refresh: '+replacement,async()=>{
  const original='broken\ud800\u0000',context=await setup({raw:original}),preview=context.store.preview(await source());context.storage.armReadFailure=true;
  const result=await context.store.restore(preview,approval);assert.equal(result.committed,null);assert.equal(context.store.protection.kind,'recovery-unverified');
  context.storage.afterWriteRead=false;context.storage.armReadFailure=false;
  if(replacement==='corrupt')context.storage.map.set(STORAGE_KEY,'different broken data');
  if(replacement==='deleted')context.storage.map.delete(STORAGE_KEY);
  const before=context.storage.map.get(STORAGE_KEY);await context.store.refresh();await context.store.initialize();
  assert.equal(context.store.status,'unverified');assert.equal(context.store.writable,false);assert.equal(context.store.state,null);
  assert.equal(context.store.retainedQuarantine().raw,original);assert.equal(context.storage.map.get(STORAGE_KEY),before);
});

test('JSON preparation is read-only and cannot clear an unverified recovery or retarget quarantine',async()=>{
  const original='broken\udfff',context=await setup({raw:original}),preview=context.store.preview(await source());context.storage.armReadFailure=true;
  await context.store.restore(preview,approval);context.storage.armReadFailure=false;context.storage.afterWriteRead=false;
  const before=context.storage.getItem(STORAGE_KEY),snapshot=await context.store.backup();
  assert.equal(snapshot.data.items.length,6);assert.equal(context.store.status,'unverified');assert.equal(context.store.protection.kind,'recovery-unverified');
  assert.equal(context.store.retainedQuarantine().raw,original);assert.equal(context.store.retainedQuarantineInfo()[0].bytes,original.length*2);assert.equal(context.storage.getItem(STORAGE_KEY),before);
});

test('protected state rejects edits, deletions, completions, rollovers and additional restoration without writes',async()=>{
  const context=await setup({raw:'broken'}),preview=context.store.preview(await source());context.storage.armReadFailure=true;
  await context.store.restore(preview,approval);context.storage.armReadFailure=false;context.storage.afterWriteRead=false;
  let writes=0;const originalSet=context.storage.setItem.bind(context.storage);context.storage.setItem=(...args)=>{writes++;return originalSet(...args);};
  for(const action of [d=>{d.items[0].title='edit';},d=>{d.items=[];},d=>complete(d,'sample-task-1')])assert.equal((await context.store.mutate(action)).ok,false);
  assert.equal((await context.store.rollover()).ok,false);assert.equal((await context.store.restore(preview,approval)).ok,false);
  assert.equal((await context.store.confirmBackup(await context.store.backup())).ok,false);assert.equal(writes,0);assert.equal(context.store.retainedQuarantine().raw,'broken');
});

test('ordinary unverified save is distinguished from recovery and cannot be unlocked by reads',async()=>{
  const {store,storage}=await setup();storage.armReadFailure=true;await store.mutate(d=>{d.items[0].title='uncertain';});
  assert.equal(store.protection.kind,'save-unverified');assert.equal(store.quarantineInfo().capturedAt,null);
  storage.afterWriteRead=false;storage.armReadFailure=false;await store.refresh();await store.backup();assert.equal(store.status,'unverified');
});

test('a new page cannot recover the old in-memory quarantine and must validate the current stored data',async()=>{
  const context=await setup({raw:'broken'}),preview=context.store.preview(await source());context.storage.armReadFailure=true;
  await context.store.restore(preview,approval);context.storage.afterWriteRead=false;context.storage.armReadFailure=false;
  const nextPage=new ScheduleStore({storage:context.storage,locks:context.locks});await nextPage.refresh();
  assert.equal(context.store.retainedQuarantine().raw,'broken');assert.equal(nextPage.quarantineInfo().capturedAt,null);assert.throws(()=>nextPage.quarantine(),error=>error.reason==='quarantine-missing');assert.equal(nextPage.status,'ready');
});
