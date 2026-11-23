import test from 'node:test';
import assert from 'node:assert/strict';
import {ScheduleStore} from '../src/storage.js';
import {seed,serializeState,STORAGE_KEY,removeItem} from '../src/model.js';
import {REMOVAL_KEY,REMOVAL_READY,REMOVAL_SHORTCUT,readRemovals,removalEligible,removalPayload,removalURL} from '../src/notification-removals.js';
const now=new Date('2026-11-17T03:00:00.000Z');
async function fixture(){
  const data=seed('2026-11-17');data.version=2;data.items[0].notification={enabled:true,notifyAt:'2026-11-18T03:00:00.000Z'};
  const map=new Map([[STORAGE_KEY,serializeState(data)]]),hooks={};
  const storage={getItem:key=>hooks.read?hooks.read(key,map):map.get(key)??null,setItem(key,value){if(hooks.write)hooks.write(key,value,map);else map.set(key,value);}};
  const store=new ScheduleStore({storage,locks:{request:async(name,options,action)=>action()},now:()=>now});await store.refresh();
  return {store,map,hooks,id:data.items[0].id};
}
const off=d=>{d.items[0].notification={enabled:false,notifyAt:null};};
const save=(store,action)=>store.mutate(action,store.token(),{queueRemovals:true});
test('notification OFF retains ID, title and stable deletion operation ID before committing app data',async()=>{
  const f=await fixture();assert.equal((await save(f.store,off)).ok,true);
  const [entry]=f.store.removalStatus().entries;assert.equal(entry.itemId,f.id);assert.equal(entry.phase,'pending');assert.equal(entry.reason,'off');assert.equal(removalEligible(entry,f.store.state),true);
  assert.equal(removalPayload(entry).operation,'delete');assert.equal(removalPayload(entry).notifyAt,null);assert.equal(removalPayload(entry).operationId,removalPayload(entry).operationId);
  assert.equal(f.store.state.items[0].notification.enabled,false);
});
test('event deletion retains its ID even after the event is absent; unrelated task/history survive',async()=>{
  const f=await fixture(),tasks=f.store.state.items.filter(item=>item.type==='task');
  assert.equal((await save(f.store,d=>removeItem(d,f.id))).ok,true);
  const [entry]=f.store.removalStatus().entries;assert.equal(entry.reason,'deleted');assert.equal(entry.itemId,f.id);assert.equal(removalEligible(entry,f.store.state),true);
  assert.deepEqual(f.store.state.items.filter(item=>item.type==='task'),tasks);assert.deepEqual(f.store.state.history,[]);
  await f.store.refresh();assert.equal(f.store.removalStatus().entries[0].operationId,entry.operationId);
});
test('legacy ordinary event deletion also retains ID without assuming it was never linked',async()=>{
  const f=await fixture();assert.equal((await save(f.store,d=>removeItem(d,'sample-event-2'))).ok,true);assert.equal(f.store.removalStatus().entries[0].itemId,'sample-event-2');
});
test('queue creation failure prevents OFF/deletion and preserves existing application data',async()=>{
  for(const mode of ['write','read','readback']){
    const f=await fixture(),raw=f.map.get(STORAGE_KEY);let queued=false;
    f.hooks.write=(key,value,map)=>{if(key===REMOVAL_KEY&&mode==='write')throw Error('denied');map.set(key,value);if(key===REMOVAL_KEY)queued=true;};
    f.hooks.read=(key,map)=>{if(key===REMOVAL_KEY&&(mode==='read'||queued&&mode==='readback'))throw Error('denied');return map.get(key)??null;};
    assert.equal((await save(f.store,off)).ok,false);assert.equal(f.map.get(STORAGE_KEY),raw);
  }
});
test('primary write failure keeps a prepared ID but does not authorize native deletion',async()=>{
  const f=await fixture(),raw=f.map.get(STORAGE_KEY);f.hooks.write=(key,value,map)=>{if(key===STORAGE_KEY)throw Error('denied');map.set(key,value);};
  assert.equal((await save(f.store,off)).ok,false);assert.equal(f.map.get(STORAGE_KEY),raw);const [entry]=f.store.removalStatus().entries;assert.equal(entry.itemId,f.id);assert.equal(entry.phase,'prepared');assert.equal(removalEligible(entry,f.store.state),false);
});
test('post-write queue finalization failure reports app save separately and retains the ID',async()=>{
  const f=await fixture();let queueWrites=0;
  f.hooks.write=(key,value,map)=>{if(key===REMOVAL_KEY&&++queueWrites===2)throw Error('denied');map.set(key,value);};
  const result=await save(f.store,off);assert.equal(result.ok,true);assert.match(result.warning,/確定を確認できません/);assert.equal(f.store.state.items[0].notification.enabled,false);assert.equal(f.store.removalStatus().entries[0].phase,'prepared');
});
test('primary readback failure retains prepared ID and existing write-outcome protection',async()=>{
  const f=await fixture();let written=false;
  f.hooks.write=(key,value,map)=>{map.set(key,value);if(key===STORAGE_KEY)written=true;};f.hooks.read=(key,map)=>{if(key===STORAGE_KEY&&written)throw Error('denied');return map.get(key)??null;};
  const result=await save(f.store,off);assert.equal(result.committed,null);assert.equal(f.store.status,'unverified');assert.equal(f.store.removalStatus().entries[0].itemId,f.id);assert.equal(f.store.removalStatus().entries[0].phase,'prepared');
});
test('concurrent data modification during queue I/O is not overwritten or authorized',async()=>{
  const f=await fixture(),other=seed('2026-11-17');other.items[0].title='別画面';const raw=serializeState(other);
  f.hooks.write=(key,value,map)=>{map.set(key,value);if(key===REMOVAL_KEY)map.set(STORAGE_KEY,raw);};
  assert.equal((await save(f.store,off)).ok,false);assert.equal(f.map.get(STORAGE_KEY),raw);assert.equal(f.store.removalStatus().entries[0].phase,'prepared');
});
test('corrupt queue is never replaced and unrelated saves do not need queue access',async()=>{
  const f=await fixture(),raw=f.map.get(STORAGE_KEY);f.map.set(REMOVAL_KEY,'corrupt');assert.equal((await save(f.store,off)).ok,false);assert.equal(f.map.get(STORAGE_KEY),raw);assert.equal(f.map.get(REMOVAL_KEY),'corrupt');
  assert.equal((await save(f.store,d=>{d.items[0].title='架空変更';})).ok,true);assert.equal(f.map.get(REMOVAL_KEY),'corrupt');assert.equal(f.store.removalStatus().unavailable,true);
});
test('restored/re-enabled targets are ineligible and queue does not claim Apple reflection',async()=>{
  const f=await fixture();await save(f.store,off);const entry=f.store.removalStatus().entries[0];
  await f.store.mutate(d=>{d.items[0].notification={enabled:true,notifyAt:'2026-11-18T03:00:00.000Z'};});assert.equal(removalEligible(entry,f.store.state),false);assert.equal(f.store.removalStatus().entries.length,1);
});
test('deletion transport is disabled and can never use the existing upsert shortcut',async()=>{
  const f=await fixture();await save(f.store,off);const entry=f.store.removalStatus().entries[0];assert.equal(REMOVAL_READY,false);assert.equal(REMOVAL_SHORTCUT,'マイスケジュール通知解除テスト');
  for(let i=0;i<2;i++)assert.throws(()=>removalURL({origin:'https://my-schedule-test.pages.dev',store:f.store,operationId:entry.operationId}),/検証が終わるまで/);
  assert.equal(f.store.removalStatus().entries[0].operationId,entry.operationId);
});
test('queue tracking is opt-in; tasks and recurring events never create removal jobs',async()=>{
  const f=await fixture();await f.store.mutate(off);assert.equal(f.map.has(REMOVAL_KEY),false);
  await save(f.store,d=>{d.items=d.items.filter(item=>item.type!=='task');});assert.equal(f.map.has(REMOVAL_KEY),false);
});
test('bounded queue is not silently evicted and malformed or ambiguous queue entries are refused',async()=>{
  const f=await fixture();await save(f.store,off);const original=JSON.parse(f.map.get(REMOVAL_KEY)),entry=original.entries[0];
  for(const changed of [{...original,entries:[entry,entry]},{...original,extra:1},{...original,entries:[{...entry,itemId:''}]},{...original,entries:[{...entry,phase:'done'}]}]){
    f.map.set(REMOVAL_KEY,JSON.stringify(changed));assert.throws(()=>readRemovals(f.store.storage));
  }
  const g=await fixture(),entries=Array.from({length:100},(_,i)=>({...entry,operationId:'op-'+i})),raw=JSON.stringify({version:1,entries});g.map.set(REMOVAL_KEY,raw);const primary=g.map.get(STORAGE_KEY);
  assert.equal((await save(g.store,off)).ok,false);assert.equal(g.map.get(REMOVAL_KEY),raw);assert.equal(g.map.get(STORAGE_KEY),primary);
});
test('deletion payload refuses empty IDs, URL metacharacters and unsupported title data',async()=>{
  const f=await fixture();await save(f.store,off);const entry=f.store.removalStatus().entries[0];
  for(const change of [{itemId:''},{itemId:'a&text=b'},{operationId:''},{title:''},{title:'bad\ntext'}])assert.throws(()=>removalPayload({...entry,...change}));
  const payload=removalPayload(entry);assert.deepEqual(Object.keys(payload),['formatVersion','itemId','operationId','operation','title','notifyAt']);
});
