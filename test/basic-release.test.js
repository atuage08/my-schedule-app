import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {NOTIFICATIONS_ENABLED,isProtectedItem,assertBasicMutation} from '../src/features.js';
import {seed,serializeState,parseState,STORAGE_KEY,removeItem,complete,restore} from '../src/model.js';
import {ScheduleStore,LOCK_NAME,META_KEY,MIGRATION_KEY,MIGRATION_V3_KEY} from '../src/storage.js';
import {createBackup,readBackupFile} from '../src/backup.js';
import * as v3 from '../src/notification-v3.js';
import * as removal from '../src/notification-removals.js';
import * as shortcut from '../src/shortcut-test.js';
import {NotificationConnection,parseResult,resultFromFragment,RESULT_PREFIX,bootNotificationStore,refreshNotificationStore} from '../src/notification-connection.js';
import {createConnectionUI} from '../src/notification-connection-ui.js';
import {PUBLIC_FILES,readSource,PROJECT_ROOT} from '../scripts/files.mjs';
const now=new Date('2026-11-23T03:00:00.000Z');
const notificationKeys=[removal.REMOVAL_KEY,MIGRATION_KEY,MIGRATION_V3_KEY];
function data(version=1){
  const s=seed('2026-11-23');s.version=version;
  if(version>=2)s.items[0].notification={enabled:true,notifyAt:'2026-11-24T03:00:00.000Z'};
  if(version===3)s.notificationLink={version:1,mode:'ready',legacyRemovals:[],records:[{itemId:s.items[0].id,generationId:'generation-1',operationId:'operation-1',status:'unknown',desired:{enabled:true,notifyAt:s.items[0].notification.notifyAt,title:s.items[0].title},pending:{operationId:'operation-2',expectedGenerationId:'generation-1',generationId:'generation-2',operation:'upsert',title:s.items[0].title,notifyAt:s.items[0].notification.notifyAt,status:'unknown'}}]};
  return s;
}
async function context({version=1,empty=false}={}){
  const map=new Map(empty?[]:[[STORAGE_KEY,serializeState(data(version))]]),hooks={},reads=[],writes=[],locksUsed=[];
  const storage={getItem(key){reads.push(key);return hooks.read?hooks.read(key,map):map.get(key)??null;},setItem(key,value){writes.push(key);if(hooks.write)hooks.write(key,value,map);else map.set(key,value);}};
  const locks={async request(name,options,action){locksUsed.push(name);if(hooks.lock)await hooks.lock();return action();}};
  const store=new ScheduleStore({storage,locks,now:()=>now});await store.refresh();return {store,map,hooks,reads,writes,locksUsed,storage,locks};
}
test('release constants cannot be enabled by URL, localStorage or caller options',()=>{
  assert.equal(NOTIFICATIONS_ENABLED,false);assert.equal(v3.V3_READY,false);assert.equal(removal.REMOVAL_READY,false);
});
test('all transport and request creation entries fail closed before touching supplied data',async()=>{
  const sensitive=new Proxy({},{get(){assert.fail('Accessed sensitive object');}});
  for(const call of [()=>shortcut.shortcutURL(sensitive),()=>shortcut.createTestPayload(now,sensitive),()=>shortcut.savedEventURL({store:sensitive}),()=>v3.v3URL({store:sensitive}),()=>v3.v3Payload(sensitive),()=>v3.stageV3(sensitive,sensitive),()=>v3.newV3Request(sensitive),()=>removal.removalURL({store:sensitive}),()=>removal.stageRemovals(sensitive,sensitive,sensitive),()=>removal.commitRemovals(sensitive,sensitive),()=>removal.removalPayload(sensitive),()=>parseResult('{broken'),()=>resultFromFragment(RESULT_PREFIX+'%ZZ')])assert.throws(call,/停止/);
  const c=new NotificationConnection({store:sensitive,origin:()=>shortcut.TEST_ORIGIN});
  for(const call of [()=>c.createFixture(true),()=>c.prepareInspection(true),()=>c.prepareVerification(true),()=>c.prepare(true),()=>c.accept('{}',{consent:true,inspectionConfirmed:true,verificationConfirmed:true})])await assert.rejects(call(),/停止/);
  assert.throws(()=>c.launch({},true,()=>assert.fail('Native navigation')),/停止/);
});
test('disabled connection UI neither creates DOM nor parses or saves incoming results',async()=>{
  const notices=[],sensitive=new Proxy({},{get(){assert.fail('Storage/DOM must not be touched');}});
  const ui=createConnectionUI({store:sensitive,onChange(){assert.fail('Changed');},notify:value=>notices.push(value)});
  ui.changed();assert.deepEqual(await ui.receiveLocation(),{disabled:true});ui.open();assert.equal(notices.length,1);
});
test('plain edits, deletion, task completion and undo do not consult notification stores',async()=>{
  for(const version of [1,2,3]){
    const f=await context({version}),before=structuredClone(f.store.state),protectedBefore=before.items[0];
    for(const key of notificationKeys)f.map.set(key,'{broken');
    f.hooks.read=(key,map)=>{if(notificationKeys.includes(key))throw Error('Notification storage denied');return map.get(key)??null;};
    const options={notificationV3:true,queueRemovals:true}; // Caller cannot bypass release policy.
    assert.equal((await f.store.mutate(d=>{d.items[1].title='架空の基本予定';},f.store.token(),options)).ok,true);
    assert.equal((await f.store.mutate(d=>removeItem(d,before.items[1].id),f.store.token(),options)).ok,true);
    const task=f.store.state.items.find(i=>i.type==='task');assert.equal((await f.store.mutate(d=>complete(d,task.id,now),f.store.token(),options)).ok,true);
    const history=f.store.state.history.at(-1);assert.equal((await f.store.mutate(d=>restore(d,history.id,now),f.store.token(),options)).ok,true);
    assert.equal(f.store.state.version,version);assert.deepEqual(f.store.state.notificationLink,before.notificationLink);
    if(version>=2)assert.deepEqual(f.store.state.items.find(i=>i.id===protectedBefore.id),protectedBefore);
    assert.equal(f.reads.some(key=>notificationKeys.includes(key)),false);assert.equal(f.writes.some(key=>notificationKeys.includes(key)),false);
    for(const key of notificationKeys)assert.equal(f.map.get(key),'{broken');assert.ok(f.locksUsed.every(name=>name===LOCK_NAME));
  }
});
test('notification-free event creation and deletion never migrate or queue',async()=>{
  const f=await context(),before=structuredClone(f.store.state);
  assert.equal((await f.store.mutate(d=>{d.items.push({...d.items[0],id:'plain-new'});},f.store.token(),{notificationV3:true,queueRemovals:true})).ok,true);
  assert.equal((await f.store.mutate(d=>removeItem(d,'plain-new'),f.store.token(),{notificationV3:true,queueRemovals:true})).ok,true);
  assert.equal(serializeState(f.store.state),serializeState(before));assert.deepEqual([...f.map.keys()].sort(),[META_KEY,STORAGE_KEY].sort());
});
test('existing notification fields and linked records are immutable in basic edits',async()=>{
  for(const version of [2,3])for(const operation of ['title','date','delete','clear','disable','link']){
    const f=await context({version}),raw=f.map.get(STORAGE_KEY),item=f.store.state.items[0];assert.equal(isProtectedItem(f.store.state,item),true);
    const saved=await f.store.mutate(d=>{const x=d.items[0];if(operation==='title')x.title='変更禁止';if(operation==='date')x.start='2026-11-23T09:00';if(operation==='delete')removeItem(d,x.id);if(operation==='clear')delete x.notification;if(operation==='disable')x.notification={enabled:false,notifyAt:null};if(operation==='link'){if(version===3)d.notificationLink.mode='review';else d.version=1;}},f.store.token(),{notificationV3:true,queueRemovals:true});
    assert.equal(saved.ok,false);assert.equal(saved.reason,'notification-protected');assert.match(saved.message,/閲覧・バックアップのみ/);assert.equal(f.map.get(STORAGE_KEY),raw);
  }
});
test('notification-off fields and linked items without a notification field stay protected',()=>{
  const s=data(2);s.items[0].notification={enabled:false,notifyAt:null};assert.equal(isProtectedItem(s,s.items[0]),true);
  const v=data(3);delete v.items[0].notification;v.notificationLink.records[0].desired={enabled:false,notifyAt:null,title:v.items[0].title};assert.equal(isProtectedItem(v,v.items[0]),true);
  v.items.shift();const reused=structuredClone(v);reused.items.push({...seed().items[0],id:'sample-event-1'});assert.throws(()=>assertBasicMutation(v,reused),/保護中/);
});
test('adding notification metadata or changing the storage version through basic mutation is rejected',async()=>{
  const f=await context(),raw=f.map.get(STORAGE_KEY);
  for(const change of [d=>{d.version=2;d.items[0].notification={enabled:false,notifyAt:null};},d=>{d.items.push({...d.items[0],id:'new-notify',notification:{enabled:false,notifyAt:null}});},d=>{d.version=3;d.notificationLink={version:1,mode:'review',records:[],legacyRemovals:[]};}]){
    assert.equal((await f.store.mutate(change,f.store.token(),{notificationV3:true})).ok,false);assert.equal(f.map.get(STORAGE_KEY),raw);
  }
});
test('v1-v3 backups retain all data; explicit restore preserves notification IDs and safety suspension',async()=>{
  for(const version of [1,2,3]){
    const f=await context({version}),before=structuredClone(f.store.state);before.history.push({id:'old-history',title:'架空の古い履歴',due:null,completedAt:'2001-01-01T00:00:00.000Z'});
    const boundary={id:'boundary',type:'task',title:'架空の次回なしタスク',due:'2100-12-31',pinned:false,repeat:'daily',excluded:['2100-12-31']};
    before.items.push(boundary);
    const artifact=await createBackup(before,now),source=await readBackupFile(artifact.file);assert.deepEqual(source.data,before);
    const preview=f.store.preview(source);
    assert.deepEqual(preview.plan.retained,[{title:boundary.title,due:boundary.due}]);
    const saved=await f.store.restore(preview,{replace:true});assert.equal(saved.ok,true);assert.equal(f.store.state.version,version);assert.deepEqual(f.store.state.items,before.items);assert.deepEqual(f.store.state.history,before.history);
    if(version===3){const r=f.store.state.notificationLink.records[0];assert.equal(r.pending.operationId,before.notificationLink.records[0].pending.operationId);assert.equal(r.pending.status,'suspended');assert.equal(f.store.state.notificationLink.mode,'review');}
    assert.equal((await f.store.backup()).data.version,version);
  }
});
test('concurrent storage change, failed save and uncertain readback keep existing protections',async()=>{
  for(const mode of ['conflict','write','readback']){
    const f=await context(),raw=f.map.get(STORAGE_KEY);let written=false;
    if(mode==='conflict')f.hooks.lock=()=>{const next=data();next.items[0].title='別画面の架空更新';f.map.set(STORAGE_KEY,serializeState(next));};
    f.hooks.write=(key,value,map)=>{if(key===STORAGE_KEY&&mode==='write')throw Error('Denied');map.set(key,value);if(key===STORAGE_KEY)written=true;};
    f.hooks.read=(key,map)=>{if(key===STORAGE_KEY&&written&&mode==='readback')throw Error('Denied');return map.get(key)??null;};
    const saved=await f.store.mutate(d=>{d.items[0].title='保存予定の架空更新';});assert.equal(saved.ok,false);
    if(mode==='write')assert.equal(f.map.get(STORAGE_KEY),raw);
    if(mode==='readback'){assert.equal(f.store.status,'unverified');assert.equal((await f.store.mutate(()=>{})).ok,false);}
  }
});
test('old or invalid notification result landings never initialize or roll over any partition',async()=>{
  for(const hash of [RESULT_PREFIX+'%ZZ',RESULT_PREFIX+encodeURIComponent('{"format":"my-schedule-notification-result"}'),'#notification-result-invalid'])for(const empty of [false,true]){
    const f=await context({empty});if(!empty){const s=data();s.items.push({id:'late',type:'task',title:'架空の繰り返し',due:'2026-11-01',pinned:false,repeat:'daily',excluded:[]});f.map.set(STORAGE_KEY,serializeState(s));await f.store.refresh();}
    const raw=f.map.get(STORAGE_KEY),writes=f.writes.length;await bootNotificationStore(f.store,()=>hash);await refreshNotificationStore(f.store,()=>hash);
    assert.equal(f.map.get(STORAGE_KEY),raw);assert.equal(f.writes.length,writes);
  }
});
test('ordinary basic boot still initializes and rolls tasks forward without notification migration',async()=>{
  const f=await context({empty:true});await bootNotificationStore(f.store,'');assert.equal(f.store.status,'ready');assert.equal(f.store.state.version,1);
  const s=data();s.items.push({id:'late',type:'task',title:'架空の繰り返し',due:'2026-11-01',pinned:false,repeat:'daily',excluded:[]});f.map.set(STORAGE_KEY,serializeState(s));await bootNotificationStore(f.store,'');assert.equal(f.store.state.items.find(i=>i.id==='late').due,'2026-11-23');assert.equal(f.map.has(MIGRATION_V3_KEY),false);
});
test('app entry points use the common gate for UI and all result events',async()=>{
  const source=await readFile(new URL('../src/app.js',import.meta.url),'utf8');
  assert.match(source,/connectionUI=NOTIFICATIONS_ENABLED\?createConnectionUI/);
  assert.match(source,/if\(NOTIFICATIONS_ENABLED\)\{\s*window.addEventListener\('hashchange'/);
  assert.match(source,/supportsNotification=NOTIFICATIONS_ENABLED&&/);
  assert.match(source,/if\(isProtectedItem\(state,original\)\)/);
  assert.match(source,/queueRemovals:NOTIFICATIONS_ENABLED&&/);
});

test('basic emergency recovery keeps corrupt original on cancel or failure and restores v3 without sending',async()=>{
  const f=await context(),source=await readBackupFile((await createBackup(data(3),now)).file);
  f.map.set(STORAGE_KEY,'broken fictional original');await f.store.refresh();const preview=f.store.preview(source),raw=f.map.get(STORAGE_KEY);
  assert.equal((await f.store.restore(preview,{replace:false})).ok,false);assert.equal(f.map.get(STORAGE_KEY),raw);
  f.hooks.write=(key)=>{if(key===STORAGE_KEY)throw Error('Denied');};
  assert.equal((await f.store.restore(preview,{replace:true,emergency:true,quarantine:'skip'})).ok,false);assert.equal(f.map.get(STORAGE_KEY),raw);
  delete f.hooks.write;assert.equal((await f.store.restore(preview,{replace:true,emergency:true,quarantine:'skip'})).ok,true);
  assert.equal(f.store.state.version,3);assert.equal(f.store.state.notificationLink.records[0].pending.status,'suspended');assert.equal(f.store.state.notificationLink.records[0].pending.operationId,'operation-2');
});

test('public allowlist includes the disabled policy but no test loaders, secrets, backups or generated review data',async()=>{
  assert.ok(PUBLIC_FILES.includes('src/features.js'));
  for(const file of PUBLIC_FILES){
    assert.match(file,/^(?:index\.html|styles\.css|apple-touch-icon-v1\.png|src\/[a-z0-9-]+\.js)$/);
    assert.doesNotMatch(file,/(?:\.env|\.git|test\/|scripts\/|artifacts\/|\.json|\.zip|\.bin)/);
    const text=(await readSource(PROJECT_ROOT,file)).toString('utf8');assert.doesNotMatch(text,/export const NOTIFICATIONS_ENABLED=true;|registerHooks\(/);
  }
});
