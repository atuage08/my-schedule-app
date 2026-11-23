import test from 'node:test';
import assert from 'node:assert/strict';
import {ScheduleStore,MIGRATION_V3_KEY} from '../src/storage.js';
import {seed,serializeState,parseState,STORAGE_KEY,removeItem} from '../src/model.js';
import {REMOVAL_KEY} from '../src/notification-removals.js';
import {V3_READY,stageV3,validateLink,v3URL,v3Payload} from '../src/notification-v3.js';
import {createBackup,readBackupFile,prepareRestore} from '../src/backup.js';
const now=new Date('2026-11-18T03:00:00.000Z');
async function fixture(){
  const data=seed('2026-11-18');data.version=2;data.items[0].notification={enabled:true,notifyAt:'2026-11-19T03:00:00.000Z'};data.history.push({id:'legacy',title:'旧履歴',due:null,completedAt:'2020-01-01T00:00:00Z'});
  const raw=serializeState(data),map=new Map([[STORAGE_KEY,raw]]),hooks={};
  const storage={getItem:key=>hooks.read?hooks.read(key,map):map.get(key)??null,setItem(key,value){if(hooks.write)hooks.write(key,value,map);else map.set(key,value);}};
  const store=new ScheduleStore({storage,locks:{request:async(name,options,fn)=>fn()},now:()=>now});await store.refresh();return {store,map,hooks,raw,data};
}
const save=(store,fn)=>store.mutate(fn,store.token(),{notificationV3:true,queueRemovals:true});
const pause=state=>{state.items[0].notification={enabled:false,notifyAt:null};};
test('v2 pause migrates atomically with desired inactive, pending generation and pre-v3 archive',async()=>{
  const f=await fixture();assert.equal((await save(f.store,pause)).ok,true);assert.equal(f.store.state.version,3);
  const r=f.store.state.notificationLink.records[0];assert.equal(r.itemId,'sample-event-1');assert.equal(r.desired.enabled,false);assert.equal(r.pending.operation,'deactivate');assert.equal(r.generationId,null);assert.equal(r.status,'unverified');assert.equal(f.store.state.notificationLink.mode,'review');
  assert.equal(JSON.parse(f.map.get(MIGRATION_V3_KEY)).entries[0].raw,f.raw);assert.deepEqual(f.store.state.history,f.data.history);assert.deepEqual(f.store.state.items.slice(1),f.data.items.slice(1));
});
test('resume keeps item ID; an unsent pending intent can be replaced but unknown request survives',async()=>{
  const f=await fixture();await save(f.store,pause);const id=f.store.state.items[0].id,first=f.store.state.notificationLink.records[0].pending.operationId;
  await save(f.store,d=>{d.items[0].notification={enabled:true,notifyAt:'2026-11-19T04:00:00.000Z'};});
  const r=f.store.state.notificationLink.records[0];assert.equal(r.itemId,id);assert.equal(r.pending.operation,'upsert');assert.notEqual(r.pending.operationId,first);
  await f.store.mutate(d=>{d.notificationLink.records[0].pending.status='unknown';d.notificationLink.records[0].status='unknown';});
  const pending=f.store.state.notificationLink.records[0].pending;await save(f.store,pause);assert.deepEqual(f.store.state.notificationLink.records[0].pending,pending);assert.equal(f.store.state.notificationLink.records[0].desired.enabled,false);
});
test('deleting a v3 active event retains target and deactivation intent without deleting history',async()=>{
  const f=await fixture();await save(f.store,d=>{d.items[0].title='架空変更';});
  await save(f.store,d=>removeItem(d,'sample-event-1'));assert.equal(f.store.state.items.some(item=>item.id==='sample-event-1'),false);
  const r=f.store.state.notificationLink.records[0];assert.equal(r.desired.enabled,false);assert.equal(r.pending.operation,'deactivate');assert.equal(f.store.state.history.length,1);
});
test('legacy removal IDs are copied into the same backup data without clearing the old source',async()=>{
  const f=await fixture(),legacy={version:1,entries:[{itemId:'deleted-old',title:'旧解除',operationId:'old-op',phase:'prepared',reason:'deleted',createdAt:now.toISOString()}]},raw=JSON.stringify(legacy);f.map.set(REMOVAL_KEY,raw);
  await save(f.store,pause);assert.deepEqual(f.store.state.notificationLink.legacyRemovals,legacy.entries);assert.equal(f.map.get(REMOVAL_KEY),raw);
  const decoded=await readBackupFile((await createBackup(f.store.state,now)).file);assert.deepEqual(decoded.data.notificationLink.legacyRemovals,legacy.entries);
});
test('v3 backup roundtrip is exact; restore candidates suspend all saved requests',async()=>{
  const f=await fixture();await save(f.store,pause);const raw=serializeState(f.store.state),backup=await createBackup(f.store.state,now),decoded=await readBackupFile(backup.file);
  assert.equal(JSON.parse(await backup.file.text()).formatVersion,3);assert.equal(serializeState(decoded.data),raw);
  const preview=f.store.preview(decoded);assert.equal(preview.plan.candidate.notificationLink.records[0].pending.status,'suspended');assert.equal(serializeState(decoded.data),raw);
  assert.equal((await f.store.restore(preview,{replace:false})).ok,false);assert.equal(serializeState(f.store.state),raw);
  assert.equal((await f.store.restore(preview,{replace:true})).ok,true);assert.equal(f.store.state.notificationLink.mode,'review');assert.equal(f.store.state.notificationLink.records[0].pending.status,'suspended');
});
test('v3 restores through emergency recovery and legacy v1/v2 restores still work',async()=>{
  const f=await fixture();await save(f.store,pause);const source=await readBackupFile((await createBackup(f.store.state,now)).file);
  f.map.set(STORAGE_KEY,'broken');await f.store.refresh();assert.equal((await f.store.restore(f.store.preview(source),{replace:true,emergency:true,quarantine:'skip'})).ok,true);assert.equal(f.store.state.notificationLink.records[0].pending.status,'suspended');
  const old=await readBackupFile((await createBackup(f.data,now)).file);assert.equal((await f.store.restore(f.store.preview(old),{replace:true})).ok,true);assert.equal(f.store.state.version,2);
});
test('v3 archive failure or primary failure leaves v2 unchanged',async()=>{
  for(const keyToFail of [MIGRATION_V3_KEY,STORAGE_KEY]){
    const f=await fixture();f.hooks.write=(key,value,map)=>{if(key===keyToFail)throw Error('denied');map.set(key,value);};assert.equal((await save(f.store,pause)).ok,false);assert.equal(f.map.get(STORAGE_KEY),f.raw);assert.equal(f.store.state.version,2);
  }
});
test('primary readback uncertainty remains protected and pre-v3 source is exportable',async()=>{
  const f=await fixture();let written=false;f.hooks.write=(key,value,map)=>{map.set(key,value);if(key===STORAGE_KEY)written=true;};f.hooks.read=(key,map)=>{if(key===STORAGE_KEY&&written)throw Error('denied');return map.get(key)??null;};
  const result=await save(f.store,pause);assert.equal(result.committed,null);assert.equal(f.store.status,'unverified');assert.equal((await save(f.store,()=>{})).ok,false);
  const backup=await f.store.migrationBackup(0,true);assert.equal((await readBackupFile(backup.file)).data.version,2);
});
test('invalid or contradictory v3 metadata is refused without relaxing older schemas',async()=>{
  const f=await fixture(),after=structuredClone(f.data);pause(after);stageV3(f.data,after);assert.doesNotThrow(()=>serializeState(after));
  for(const mutate of [d=>{d.notificationLink.extra=1;},d=>{d.notificationLink.records.push(d.notificationLink.records[0]);},d=>{d.notificationLink.records[0].pending.expectedGenerationId='wrong';},d=>{d.items[0].notification={enabled:true,notifyAt:'2026-11-19T03:00:00.000Z'};},d=>{d.version=2;}]){const bad=structuredClone(after);mutate(bad);assert.throws(()=>serializeState(bad));}
});
test('no-op v3 edits do not regenerate request IDs; unrelated v1 edit does not migrate',async()=>{
  const f=await fixture();await save(f.store,pause);const operationId=f.store.state.notificationLink.records[0].pending.operationId;await save(f.store,()=>{});assert.equal(f.store.state.notificationLink.records[0].pending.operationId,operationId);
  const before=seed('2026-11-18'),after=structuredClone(before);after.items[0].title='架空変更';stageV3(before,after);assert.equal(after.version,1);
});
test('v3 wire cannot send through old or unverified shortcut, even when a record looks paired',async()=>{
  const f=await fixture();await save(f.store,pause);assert.equal(V3_READY,false);
  assert.throws(()=>v3Payload(f.store.state.notificationLink.records[0]));
  assert.throws(()=>v3URL({origin:'https://my-schedule-test.pages.dev',store:f.store,itemId:'sample-event-1'}),/実機検証/);
});
test('corrupt legacy queue stops migration but does not block unrelated ordinary edits',async()=>{
  const f=await fixture();f.map.set(REMOVAL_KEY,'broken');assert.equal((await save(f.store,pause)).ok,false);assert.equal(f.map.get(STORAGE_KEY),f.raw);
  const legacy=seed('2026-11-18');f.map.set(STORAGE_KEY,serializeState(legacy));await f.store.refresh();assert.equal((await save(f.store,d=>{d.items[0].title='通知なしの架空変更';})).ok,true);assert.equal(f.store.state.version,1);assert.equal(f.map.get(REMOVAL_KEY),'broken');
});
test('two v3 writers cannot overwrite a saved pause or its pending ID using a stale editor',async()=>{
  const f=await fixture(),second=new ScheduleStore({storage:f.store.storage,locks:f.store.locks,now:()=>now});await second.refresh();
  const results=await Promise.all([save(f.store,pause),save(second,d=>{d.items[0].notification={enabled:true,notifyAt:'2026-11-19T04:00:00.000Z'};})]);
  assert.equal(results.filter(result=>result.ok).length,1);assert.equal(results.filter(result=>!result.ok).length,1);
  const saved=parseState(f.map.get(STORAGE_KEY));assert.equal(saved.version,3);assert.equal(saved.notificationLink.records.length,1);assert.ok(saved.notificationLink.records[0].pending.operationId);
});
