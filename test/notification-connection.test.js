import test from 'node:test';
import assert from 'node:assert/strict';
import {ScheduleStore} from '../src/storage.js';
import {seed,serializeState,STORAGE_KEY} from '../src/model.js';
import {createBackup,readBackupFile} from '../src/backup.js';
import {V3_ORIGIN,V3_LIST,V3_READY,V3_SHORTCUT,evaluateNativePlan} from '../src/notification-v3.js';
import {NotificationConnection,CONNECTION_ITEM_ID,CONNECTION_TITLE,CONNECTION_SHORTCUT,READBACK_SHORTCUT,CONNECTION_INITIAL_MEMO,parseResult,resultFromFragment,bootNotificationStore,refreshNotificationStore,MAX_RESULT_BYTES,RESULT_PREFIX} from '../src/notification-connection.js';
const now=new Date('2026-11-22T03:00:00.000Z');
async function setup({empty=false}={}){
  const map=new Map(empty?[]:[[STORAGE_KEY,serializeState(seed('2026-11-22'))]]),hooks={},writes=[];
  const storage={getItem:key=>hooks.read?hooks.read(key,map):map.get(key)??null,setItem(key,value){if(hooks.write)hooks.write(key,value,map);else map.set(key,value);writes.push(key);}};
  const locks={request:async(name,options,fn)=>fn()},store=new ScheduleStore({storage,locks,now:()=>now});await store.refresh();
  let origin=V3_ORIGIN;const connection=new NotificationConnection({store,origin:()=>origin,now:()=>now});
  return {map,hooks,writes,store,connection,setOrigin(value){origin=value;}};
}
const rec=f=>f.store.state.notificationLink.records.find(r=>r.itemId===CONNECTION_ITEM_ID);
function receiptFor(f,{inspection=false,outcome='applied'}={}){
  const r=rec(f),p=r.pending;
  const result={format:'my-schedule-notification-result',formatVersion:1,kind:inspection?'inspection':'operation',itemId:r.itemId,operationId:p.operationId,operation:inspection?'inspect':p.operation,expectedGenerationId:r.generationId,generationId:inspection?'bootstrap-generation':p.generationId,outcome:inspection?'observed':outcome,observed:null};
  if(inspection||['applied','already-applied'].includes(outcome))result.observed={listName:V3_LIST,title:CONNECTION_TITLE,notifyAt:inspection?null:p.notifyAt,completed:inspection||p.operation==='deactivate',state:inspection||p.operation==='deactivate'?'inactive':'active',phase:'confirmed',pending:null,generationId:result.generationId,previousGenerationId:inspection?null:p.expectedGenerationId,operationId:inspection?'bootstrap-operation':p.operationId};
  return result;
}
async function paired(){const f=await setup();assert.equal((await f.connection.createFixture(true)).ok,true);await f.connection.prepareInspection(true);assert.equal((await f.connection.accept(JSON.stringify(receiptFor(f,{inspection:true})),{consent:true,inspectionConfirmed:true})).reported,true);return f;}
async function enable(f){return f.store.mutate(d=>{d.items.find(item=>item.id===CONNECTION_ITEM_ID).notification={enabled:true,notifyAt:'2026-11-23T03:00:00.000Z'};},f.store.token(),{notificationV3:true});}
test('fixture creation is additive and cannot reset existing data or overwrite its own ID',async()=>{
  const f=await setup(),before=f.store.state;assert.equal((await f.connection.createFixture(true)).ok,true);assert.deepEqual(f.store.state.items.filter(item=>item.id!==CONNECTION_ITEM_ID),before.items);assert.deepEqual(f.store.state.history,before.history);
  const raw=f.map.get(STORAGE_KEY);await assert.rejects(f.connection.createFixture(true));assert.equal(f.map.get(STORAGE_KEY),raw);assert.equal(V3_READY,false);
});
test('inspection requires explicit fresh-state consent and binds the stored request nonce',async()=>{
  const f=await setup();await f.connection.createFixture(true);await f.connection.prepareInspection(true);const r=receiptFor(f,{inspection:true}),raw=f.map.get(STORAGE_KEY);
  await assert.rejects(f.connection.accept(JSON.stringify(r),{consent:true}));assert.equal(f.map.get(STORAGE_KEY),raw);
  await assert.rejects(f.connection.accept(JSON.stringify({...r,operationId:'wrong'}),{consent:true,inspectionConfirmed:true}));
  assert.equal((await f.connection.accept(JSON.stringify(r),{consent:true,inspectionConfirmed:true})).reported,true);assert.equal(rec(f).status,'inactive');assert.equal(rec(f).pending,null);
});
test('prepare persists unknown snapshot before a separate synchronous launch and encodes JSON',async()=>{
  const f=await paired();await enable(f);const p=structuredClone(rec(f).pending),result=await f.connection.prepare(true);assert.equal(result.ok,true);assert.equal(rec(f).pending.status,'unknown');assert.equal(rec(f).status,'unknown');
  const navigations=[];f.connection.launch(result.ticket,true,url=>navigations.push(url));const url=new URL(navigations[0]);assert.equal(url.searchParams.get('name'),CONNECTION_SHORTCUT);assert.equal(V3_SHORTCUT,'マイスケジュール通知連携v3テスト');assert.notEqual(CONNECTION_SHORTCUT,V3_SHORTCUT);assert.equal(url.searchParams.get('input'),'text');assert.equal(JSON.parse(url.searchParams.get('text')).operationId,p.operationId);
  assert.deepEqual([...url.searchParams.keys()],['name','input','text']);assert.equal(f.writes.filter(key=>key===STORAGE_KEY).length>0,true);
  assert.throws(()=>f.connection.launch(result.ticket,true,()=>assert.fail('double navigation')));await assert.rejects(f.connection.prepare(true));
});
test('pre-send write failure and readback uncertainty never yield a launch ticket',async()=>{
  for(const mode of ['write','readback']){
    const f=await paired();await enable(f);let written=false;
    f.hooks.write=(key,value,map)=>{if(key===STORAGE_KEY&&mode==='write')throw Error('denied');map.set(key,value);if(key===STORAGE_KEY)written=true;};
    f.hooks.read=(key,map)=>{if(key===STORAGE_KEY&&written&&mode==='readback')throw Error('denied');return map.get(key)??null;};
    const result=await f.connection.prepare(true);assert.equal(result.ok,false);assert.equal(result.ticket,undefined);assert.throws(()=>f.connection.launch(undefined,true,()=>assert.fail('navigation')));
  }
});
test('page reload, context change and changed storage cannot reuse a launch ticket',async()=>{
  const f=await paired();await enable(f);const result=await f.connection.prepare(true);
  const reloaded=new NotificationConnection({store:f.store,origin:()=>V3_ORIGIN});assert.throws(()=>reloaded.launch(result.ticket,true,()=>assert.fail('reload navigation')));
  f.setOrigin('https://example.invalid');assert.throws(()=>f.connection.launch(result.ticket,true,()=>assert.fail('origin navigation')));f.setOrigin(V3_ORIGIN);
  f.map.set(STORAGE_KEY,'changed');assert.throws(()=>f.connection.launch(result.ticket,true,()=>assert.fail('stale navigation')));
});
test('valid result updates confirmed generation only after verified save and rejects duplication',async()=>{
  const f=await paired();await enable(f);await f.connection.prepare(true);const result=receiptFor(f),text=JSON.stringify(result);
  const saved=await f.connection.accept(text,{consent:true});assert.equal(saved.reported,true);assert.equal(rec(f).generationId,result.generationId);assert.equal(rec(f).operationId,result.operationId);assert.equal(rec(f).pending,null);
  const raw=f.map.get(STORAGE_KEY);await assert.rejects(f.connection.accept(text,{consent:true}));assert.equal(f.map.get(STORAGE_KEY),raw);
});
test('result before dispatch, wrong IDs/operations/generations and inconsistent readback are rejected',async()=>{
  const f=await paired();await enable(f);const unlaunched=receiptFor(f);await assert.rejects(f.connection.accept(JSON.stringify(unlaunched),{consent:true}));await f.connection.prepare(true);
  const r=receiptFor(f),raw=f.map.get(STORAGE_KEY);
  for(const changed of [{...r,itemId:'wrong'},{...r,operationId:'wrong'},{...r,generationId:'wrong'},{...r,expectedGenerationId:'wrong'},{...r,operation:'deactivate'},{...r,observed:{...r.observed,title:'wrong'}},{...r,observed:{...r.observed,notifyAt:'2026-11-23T04:00:00.000Z'}}]){await assert.rejects(f.connection.accept(JSON.stringify(changed),{consent:true}));assert.equal(f.map.get(STORAGE_KEY),raw);}
});
test('malformed receipts reject missing/extra keys, types, size, non-final metadata and bad URL encoding',async()=>{
  const f=await paired();await enable(f);await f.connection.prepare(true);const r=receiptFor(f);
  for(const changed of [{...r,formatVersion:'1'},{...r,extra:1},{...r,observed:{...r.observed,extra:1}},{...r,observed:{...r.observed,completed:'false'}},{...r,observed:{...r.observed,phase:'processing'}},{...r,observed:{...r.observed,pending:{}}},{...r,observed:{...r.observed,listName:'別のリスト'}}])assert.throws(()=>parseResult(JSON.stringify(changed)));
  for(const key of Object.keys(r)){const changed=structuredClone(r);delete changed[key];assert.throws(()=>parseResult(JSON.stringify(changed)));}
  for(const text of ['', '{broken', ' '.repeat(MAX_RESULT_BYTES+1)])assert.throws(()=>parseResult(text));assert.throws(()=>resultFromFragment(RESULT_PREFIX+'%ZZ'));
});
test('result save failure and concurrent external update do not report success',async()=>{
  for(const mode of ['write','concurrent']){
    const f=await paired();await enable(f);await f.connection.prepare(true);const text=JSON.stringify(receiptFor(f)),raw=f.map.get(STORAGE_KEY);
    if(mode==='write')f.hooks.write=()=>{throw Error('denied');};else f.map.set(STORAGE_KEY,serializeState(seed('2026-11-22')));
    const result=await f.connection.accept(text,{consent:true});assert.equal(result.ok,false);assert.equal(result.reported,false);
    if(mode==='write')assert.equal(f.map.get(STORAGE_KEY),raw);
  }
});
test('result readback failure keeps protection and never reports a verified receipt',async()=>{
  const f=await paired();await enable(f);await f.connection.prepare(true);const text=JSON.stringify(receiptFor(f));let written=false;
  f.hooks.write=(key,value,map)=>{map.set(key,value);if(key===STORAGE_KEY)written=true;};f.hooks.read=(key,map)=>{if(key===STORAGE_KEY&&written)throw Error('denied');return map.get(key)??null;};
  const result=await f.connection.accept(text,{consent:true});assert.equal(result.ok,false);assert.equal(result.reported,false);assert.equal(result.committed,null);assert.equal(f.store.status,'unverified');await assert.rejects(f.connection.accept(text,{consent:true}));
});
test('changed desired state is preserved when an older in-flight request reports success',async()=>{
  const f=await paired();await enable(f);await f.connection.prepare(true);const text=JSON.stringify(receiptFor(f));
  await f.store.mutate(d=>{d.items.find(item=>item.id===CONNECTION_ITEM_ID).notification={enabled:false,notifyAt:null};},f.store.token(),{notificationV3:true});
  assert.equal((await f.connection.accept(text,{consent:true})).reported,true);assert.equal(rec(f).status,'active');assert.equal(rec(f).desired.enabled,false);assert.equal(rec(f).pending.operation,'deactivate');assert.equal(rec(f).pending.status,'pending');
});
test('cancelled/rejected/unknown reports retain IDs and require inspection without automatic resend',async()=>{
  for(const outcome of ['cancelled','rejected','unknown']){const f=await paired();await enable(f);await f.connection.prepare(true);const text=JSON.stringify(receiptFor(f,{outcome})),id=rec(f).pending.operationId;
    const result=await f.connection.accept(text,{consent:true});assert.equal(result.reported,false);assert.equal(rec(f).pending.operationId,id);assert.equal(rec(f).pending.status,'suspended');await assert.rejects(f.connection.prepare(true));await assert.rejects(f.connection.accept(text,{consent:true}));
  }
});
test('callback in an empty or different Safari/PWA partition cannot seed, merge or mutate data',async()=>{
  const source=await paired();await enable(source);await source.connection.prepare(true);const text=JSON.stringify(receiptFor(source)),hash=RESULT_PREFIX+encodeURIComponent(text);
  const empty=await setup({empty:true});await bootNotificationStore(empty.store,hash);assert.equal(empty.map.size,0);await assert.rejects(empty.connection.accept(text,{consent:true}));assert.equal(empty.map.size,0);
  const different=await paired();await enable(different);await different.connection.prepare(true);const raw=different.map.get(STORAGE_KEY);await assert.rejects(different.connection.accept(text,{consent:true}));assert.equal(different.map.get(STORAGE_KEY),raw);
});
test('v1-v3 backups still decode, restored unknown requests are suspended and cannot accept stale results',async()=>{
  const f=await paired();await enable(f);await f.connection.prepare(true);const text=JSON.stringify(receiptFor(f));
  const source=await readBackupFile((await createBackup(f.store.state,now)).file);await f.store.restore(f.store.preview(source),{replace:true});assert.equal(rec(f).pending.status,'suspended');await assert.rejects(f.connection.accept(text,{consent:true}));await assert.rejects(f.connection.prepare(true));
  for(const version of [1,2]){const old=seed('2026-11-22');old.version=version;assert.equal((await readBackupFile((await createBackup(old,now)).file)).data.version,version);}
});
test('connection test cannot operate normal user records or consent-free requests',async()=>{
  const f=await setup();await assert.rejects(f.connection.createFixture(false));await assert.rejects(f.connection.prepare(true));await f.connection.createFixture(true);await assert.rejects(f.connection.prepare(false));
  await f.store.mutate(d=>{d.items.find(item=>item.id===CONNECTION_ITEM_ID).title='個人情報を含むかもしれない名称';},f.store.token(),{notificationV3:true});await assert.rejects(f.connection.prepareInspection(true));
});

test('inspection launch is read-only, separately persisted, one-use and never reconstructed on reload',async()=>{
  const f=await setup();await f.connection.createFixture(true);
  const prepared=await f.connection.prepareInspection(true);assert.equal(prepared.verified,true);
  assert.deepEqual(Object.keys(prepared.request),['format','formatVersion','purpose','itemId','operationId']);
  assert.equal(prepared.request.purpose,'initial');
  assert.equal(prepared.request.operationId,rec(f).pending.operationId);
  assert.equal(rec(f).pending.status,'suspended');
  const calls=[];f.connection.launch(prepared.ticket,true,url=>calls.push(url));
  const url=new URL(calls[0]);assert.equal(url.searchParams.get('name'),READBACK_SHORTCUT);
  assert.deepEqual(JSON.parse(url.searchParams.get('text')),prepared.request);
  assert.equal(url.searchParams.get('input'),'text');
  assert.throws(()=>f.connection.launch(prepared.ticket,true,()=>calls.push('duplicate')));
  const fresh=new NotificationConnection({store:f.store,origin:()=>V3_ORIGIN});
  assert.throws(()=>fresh.launch(prepared.ticket,true,()=>calls.push('reload')));assert.equal(calls.length,1);
});

test('inspection write/readback failure or concurrent change cannot launch',async()=>{
  for(const mode of ['write','readback','concurrent']){
    const f=await setup();await f.connection.createFixture(true);let written=false;
    f.hooks.write=(key,value,map)=>{if(key===STORAGE_KEY&&mode==='write')throw Error('denied');map.set(key,value);if(key===STORAGE_KEY)written=true;};
    f.hooks.read=(key,map)=>{if(key===STORAGE_KEY&&written&&mode==='readback')throw Error('denied');return map.get(key)??null;};
    if(mode==='concurrent')f.map.set(STORAGE_KEY,serializeState(seed('2026-11-22')));
    const result=await f.connection.prepareInspection(true);assert.equal(result.ok,false);assert.equal(result.ticket,undefined);
    assert.throws(()=>f.connection.launch(result.ticket,true,()=>assert.fail('navigation')));
  }
});

test('a new inspection preparation invalidates old launch tickets and checks the source at launch',async()=>{
  const f=await setup();await f.connection.createFixture(true);
  const first=await f.connection.prepareInspection(true),second=await f.connection.prepareInspection(true);
  assert.throws(()=>f.connection.launch(first.ticket,true,()=>assert.fail('old ticket')));
  f.map.set(STORAGE_KEY,'changed');assert.throws(()=>f.connection.launch(second.ticket,true,()=>assert.fail('changed source')));
});

test('formal non-null bootstrap memo supports inspection, first upsert and deactivate without changing other reminders',async()=>{
  const f=await setup();await f.connection.createFixture(true);await f.connection.prepareInspection(true);
  const memo=CONNECTION_INITIAL_MEMO;
  assert.match(memo.previousGenerationId,/^[A-Za-z0-9_-]{1,128}$/);assert.notEqual(memo.generationId,memo.previousGenerationId);
  const initial=receiptFor(f,{inspection:true});initial.generationId=memo.generationId;
  Object.assign(initial.observed,{generationId:memo.generationId,previousGenerationId:memo.previousGenerationId,operationId:memo.operationId});
  assert.equal((await f.connection.accept(JSON.stringify(initial),{consent:true,inspectionConfirmed:true})).reported,true);
  let native={nativeId:'connection-native-1',listName:V3_LIST,title:CONNECTION_TITLE,completed:true,notifyAt:null,notes:JSON.stringify(memo)};
  const unrelated={...native,nativeId:'existing-native-1',notes:JSON.stringify({...memo,itemId:'v3-test-event-001',generationId:'generation-003',operationId:'operation-003'})},unrelatedBefore=JSON.stringify(unrelated);
  await enable(f);
  for(const operation of ['upsert','deactivate']){
    if(operation==='deactivate')await f.store.mutate(d=>{d.items.find(i=>i.id===CONNECTION_ITEM_ID).notification={enabled:false,notifyAt:null};},f.store.token(),{notificationV3:true});
    const oldGeneration=JSON.parse(native.notes).generationId,prepared=await f.connection.prepare(true),payload=prepared.ticket.payload;
    assert.equal(payload.operation,operation);assert.equal(payload.expectedGenerationId,oldGeneration);
    const plan=evaluateNativePlan(payload,[native,unrelated],now);assert.equal(plan.nativeId,native.nativeId);assert.equal(plan.metadata.previousGenerationId,oldGeneration);
    native={...native,title:plan.title,notifyAt:plan.notifyAt,completed:plan.completed,notes:JSON.stringify(plan.metadata)};
    assert.equal((await f.connection.accept(JSON.stringify(receiptFor(f)),{consent:true})).reported,true);
    assert.equal(rec(f).generationId,plan.metadata.generationId);assert.equal(rec(f).status,operation==='upsert'?'active':'inactive');
  }
  assert.equal(JSON.stringify(unrelated),unrelatedBefore);
});

test('invalid initial readback and null previous generation in normal results are refused without writes',async()=>{
  const f=await setup();await f.connection.createFixture(true);await f.connection.prepareInspection(true);const initial=receiptFor(f,{inspection:true}),raw=f.map.get(STORAGE_KEY);
  for(const changes of [{previousGenerationId:''},{previousGenerationId:initial.generationId},{phase:'processing'},{completed:false},{pending:{}},{generationId:'different'}]){
    await assert.rejects(f.connection.accept(JSON.stringify({...initial,observed:{...initial.observed,...changes}}),{consent:true,inspectionConfirmed:true}));assert.equal(f.map.get(STORAGE_KEY),raw);
  }
  const pairedFixture=await paired();await enable(pairedFixture);await pairedFixture.connection.prepare(true);const result=receiptFor(pairedFixture);result.observed.previousGenerationId=null;
  await assert.rejects(pairedFixture.connection.accept(JSON.stringify(result),{consent:true}));
});

async function overdue(f){const state=structuredClone(f.store.state);state.items.push({id:'overdue-callback-task',type:'task',title:'架空繰り越し対象',due:'2026-11-01',pinned:false,repeat:'daily',excluded:[]});f.map.set(STORAGE_KEY,serializeState(state));await f.store.refresh();}
test('all result landings defer rollover including normal result, invalid result, failed save and another nonempty partition',async()=>{
  for(const mode of ['valid','invalid','save-failure','other-partition']){
    const source=await paired();await enable(source);await source.connection.prepare(true);const text=JSON.stringify(receiptFor(source));
    const f=mode==='other-partition'?await paired():source;await overdue(f);const raw=f.map.get(STORAGE_KEY),hash=mode==='invalid'?RESULT_PREFIX+'%ZZ':RESULT_PREFIX+encodeURIComponent(text),writeCount=f.writes.length;
    await bootNotificationStore(f.store,()=>hash);await refreshNotificationStore(f.store,()=>hash);
    assert.equal(f.map.get(STORAGE_KEY),raw);assert.equal(f.writes.length,writeCount);
    if(mode==='save-failure')f.hooks.write=()=>{throw Error('denied');};
    if(mode==='invalid')assert.throws(()=>resultFromFragment(hash));
    else if(mode==='other-partition')await assert.rejects(f.connection.accept(text,{consent:true}));
    else {const result=await f.connection.accept(text,{consent:true});assert.equal(result.ok,mode==='valid');}
    assert.equal(f.store.state.items.find(i=>i.id==='overdue-callback-task').due,'2026-11-01');
    if(mode!=='valid')assert.equal(f.map.get(STORAGE_KEY),raw);
  }
});

test('ordinary boot still rolls overdue tasks and a callback arriving during refresh is latched',async()=>{
  const f=await setup();await overdue(f);await bootNotificationStore(f.store,()=> '');
  assert.equal(f.store.state.items.find(i=>i.id==='overdue-callback-task').due,'2026-11-22');
  const calls=[];let hash='';const stub={status:'ready',locks:{request(){}},async refresh(){calls.push('refresh');hash=RESULT_PREFIX+'%ZZ';},async rollover(){calls.push('rollover');}};
  assert.equal((await refreshNotificationStore(stub,()=>hash)).deferred,true);assert.deepEqual(calls,['refresh']);
  hash=RESULT_PREFIX+'%ZZ';stub.refresh=async()=>{calls.push('refresh');hash='';};await refreshNotificationStore(stub,()=>hash);assert.equal(calls.includes('rollover'),false);
});

function readback(f,{initial=false}={}){
  const r=rec(f),p=r.pending,memo=initial?CONNECTION_INITIAL_MEMO:{...CONNECTION_INITIAL_MEMO,generationId:p.generationId,previousGenerationId:p.expectedGenerationId,operationId:p.operationId,state:p.operation==='upsert'?'active':'inactive'};
  return {format:'my-schedule-notification-readback',formatVersion:1,purpose:initial?'initial':'verification',itemId:r.itemId,operationId:p.operationId,reminder:{listName:V3_LIST,title:CONNECTION_TITLE,notifyAtText:initial?'':p.notifyAt??'',completed:initial||p.operation==='deactivate',notesText:JSON.stringify(memo)}};
}
const verifyOptions={consent:true,verificationConfirmed:true};
async function inFlight(){const f=await paired();await enable(f);await f.connection.prepare(true);return f;}

test('compact initial report and post-change report are distinct; upsert and deactivate verify actual memo',async()=>{
  const f=await setup();await f.connection.createFixture(true);await f.connection.prepareInspection(true);
  const first=JSON.stringify(readback(f,{initial:true}));await assert.rejects(f.connection.accept(first,verifyOptions));
  assert.equal((await f.connection.accept(first,{consent:true,inspectionConfirmed:true})).reported,true);
  await enable(f);
  for(const operation of ['upsert','deactivate']){
    if(operation==='deactivate')await f.store.mutate(d=>{d.items.find(i=>i.id===CONNECTION_ITEM_ID).notification={enabled:false,notifyAt:null};},f.store.token(),{notificationV3:true});
    await f.connection.prepare(true);const data=readback(f),text=JSON.stringify(data),pending=structuredClone(rec(f).pending),raw=f.map.get(STORAGE_KEY);
    await assert.rejects(f.connection.accept(text,{consent:true,inspectionConfirmed:true}));assert.equal(f.map.get(STORAGE_KEY),raw);
    assert.equal((await f.connection.accept(text,verifyOptions)).reported,true);assert.equal(rec(f).generationId,pending.generationId);assert.equal(rec(f).pending,null);
    await assert.rejects(f.connection.accept(text,verifyOptions));
  }
});

test('read-only verification preparation keeps exact pending IDs, never sends mutation and is one-use',async()=>{
  const f=await inFlight(),raw=f.map.get(STORAGE_KEY),pending=structuredClone(rec(f).pending),prepared=await f.connection.prepareVerification(true);
  assert.equal(prepared.verified,true);assert.equal(f.map.get(STORAGE_KEY),raw);assert.deepEqual(rec(f).pending,pending);
  assert.equal(prepared.request.purpose,'verification');assert.deepEqual(Object.keys(prepared.request),['format','formatVersion','purpose','itemId','operationId']);
  const calls=[];f.connection.launch(prepared.ticket,true,url=>calls.push(url));assert.equal(new URL(calls[0]).searchParams.get('name'),READBACK_SHORTCUT);
  assert.throws(()=>f.connection.launch(prepared.ticket,true,()=>assert.fail('duplicate')));assert.equal(calls.length,1);
  await assert.rejects(f.connection.prepareInspection(true));await assert.rejects(f.connection.prepare(true));
  const initial=readback(f,{initial:true});await assert.rejects(f.connection.accept(JSON.stringify(initial),{consent:true,inspectionConfirmed:true}));assert.deepEqual(rec(f).pending,pending);
});

test('every actual readback mismatch is rejected without altering pending or saved data',async()=>{
  const f=await inFlight(),good=readback(f),raw=f.map.get(STORAGE_KEY);
  const memo=JSON.parse(good.reminder.notesText);
  const variants=[{...good,itemId:'other'},{...good,operationId:'old'},...[
    {itemId:'other'},{operationId:'old'},{generationId:'old'},{previousGenerationId:'old'},
    {previousGenerationId:null},{phase:'processing'},{pending:{}},{state:'inactive'},{app:'other'},{metadataVersion:1},{extra:1}
  ].map(change=>({...good,reminder:{...good.reminder,notesText:JSON.stringify({...memo,...change})}})),
    ...[{listName:'別のリスト'},{title:'other'},{notifyAtText:'2026-11-23T04:00:00.000Z'},{notifyAtText:''},{completed:true},{completed:'false'},{notesText:'broken'},{extra:1}].map(change=>({...good,reminder:{...good.reminder,...change}})),
    {...good,extra:1},{...good,formatVersion:'1'},{...good,purpose:'unknown'}];
  for(const changed of variants){await assert.rejects(f.connection.accept(JSON.stringify(changed),verifyOptions));assert.equal(f.map.get(STORAGE_KEY),raw);}
  for(const key of Object.keys(good)){const bad=structuredClone(good);delete bad[key];await assert.rejects(f.connection.accept(JSON.stringify(bad),verifyOptions));}
  for(const key of Object.keys(good.reminder)){const bad=structuredClone(good);delete bad.reminder[key];assert.throws(()=>parseResult(JSON.stringify(bad)));}
  assert.throws(()=>parseResult(' '.repeat(MAX_RESULT_BYTES+1)));
});

test('old native state or interruption cannot verify; repeated preparation never resends a change',async()=>{
  const f=await inFlight(),raw=f.map.get(STORAGE_KEY),report=readback(f),memo=JSON.parse(report.reminder.notesText);
  report.reminder.notesText=JSON.stringify({...memo,generationId:rec(f).generationId,operationId:'old-operation'});
  await assert.rejects(f.connection.accept(JSON.stringify(report),verifyOptions));
  await f.connection.prepareVerification(true);await f.connection.prepareVerification(true);await f.store.refresh();
  assert.equal(f.map.get(STORAGE_KEY),raw);assert.equal(rec(f).pending.status,'unknown');
  const reload=new NotificationConnection({store:f.store,origin:()=>V3_ORIGIN});await assert.rejects(reload.prepare(true));
});

test('verification save failure, readback uncertainty and lock-time conflict never confirm success',async()=>{
  for(const mode of ['write','readback','concurrent']){
    const f=await inFlight(),text=JSON.stringify(readback(f)),raw=f.map.get(STORAGE_KEY);let written=false;
    f.hooks.write=(key,value,map)=>{if(mode==='write')throw Error('denied');map.set(key,value);written=true;};
    f.hooks.read=(key,map)=>{if(mode==='readback'&&written)throw Error('denied');return map.get(key)??null;};
    if(mode==='concurrent')f.store.locks.request=async(name,options,action)=>{f.map.set(STORAGE_KEY,serializeState(seed('2026-11-22')));return action();};
    const saved=await f.connection.accept(text,verifyOptions);assert.equal(saved.ok,false);assert.equal(saved.reported,false);
    if(mode==='write')assert.equal(f.map.get(STORAGE_KEY),raw);
    if(mode==='readback'){assert.equal(f.store.status,'unverified');await assert.rejects(f.connection.prepareVerification(true));}
  }
});

test('read-only preparation read failure or source conflict cannot issue an executable ticket',async()=>{
  for(const mode of ['read','conflict']){
    const f=await inFlight();if(mode==='read')f.hooks.read=()=>{throw Error('denied');};else f.map.set(STORAGE_KEY,serializeState(seed('2026-11-22')));
    const saved=await f.connection.prepareVerification(true);assert.equal(saved.ok,false);assert.equal(saved.ticket,undefined);
  }
});

test('verification result preserves newer desired state and creates only an unsent next request',async()=>{
  const f=await inFlight(),text=JSON.stringify(readback(f));await f.store.mutate(d=>{d.items.find(i=>i.id===CONNECTION_ITEM_ID).notification={enabled:false,notifyAt:null};},f.store.token(),{notificationV3:true});
  assert.equal((await f.connection.accept(text,verifyOptions)).reported,true);assert.equal(rec(f).status,'active');assert.equal(rec(f).desired.enabled,false);assert.equal(rec(f).pending.operation,'deactivate');assert.equal(rec(f).pending.status,'pending');
  await assert.rejects(f.connection.accept(text,verifyOptions));
});

test('empty or another storage partition cannot import verification and restored v3 requires reconnection',async()=>{
  const f=await inFlight(),text=JSON.stringify(readback(f)),hash=RESULT_PREFIX+encodeURIComponent(text);
  for(const other of [await setup({empty:true}),await inFlight()]){const raw=other.map.get(STORAGE_KEY);await bootNotificationStore(other.store,hash);await assert.rejects(other.connection.accept(text,verifyOptions));assert.equal(other.map.get(STORAGE_KEY),raw);}
  const backup=await createBackup(f.store.state,now),source=await readBackupFile(backup.file);assert.equal(source.data.version,3);
  await f.store.restore(f.store.preview(source),{replace:true});await assert.rejects(f.connection.accept(text,verifyOptions));await assert.rejects(f.connection.prepareVerification(true));assert.equal(rec(f).pending.status,'suspended');
});
