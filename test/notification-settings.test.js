import test from 'node:test';
import assert from 'node:assert/strict';
import {seed,serializeState,parseState,notificationSettings,notificationFromLocal,validateNotification,complete,restore,removeItem,STORAGE_KEY,stamp} from '../src/model.js';
import {createBackup,readBackupFile,decodeBackup,dataDigest,prepareRestore} from '../src/backup.js';
import {ScheduleStore} from '../src/storage.js';

const now=new Date('2026-11-17T03:00:00.000Z');
const enabled=()=>({enabled:true,notifyAt:'2026-11-18T03:00:00.000Z'});
function v2(){const state=seed('2026-11-17');state.version=2;state.items[0].notification=enabled();return state;}
async function storeFixture(){
  const map=new Map([[STORAGE_KEY,serializeState(seed('2026-11-17'))]]);let fail=false;
  const storage={getItem:key=>map.get(key)??null,setItem(key,value){if(fail&&key===STORAGE_KEY)throw Error('write denied');map.set(key,value);}};
  const locks={request:async(name,options,action)=>action()};const store=new ScheduleStore({storage,locks,now:()=>now});await store.refresh();
  return {store,map,setFail(value){fail=value;}};
}
test('legacy v1 reads as notifications off without changing stored bytes or backup version',async()=>{
  const state=seed('2026-11-17'),raw=serializeState(state);assert.deepEqual(notificationSettings(parseState(raw).items[0]),{enabled:false,notifyAt:null});assert.equal(serializeState(parseState(raw)),raw);
  const backup=await createBackup(state,now);assert.equal(JSON.parse(await backup.file.text()).formatVersion,1);assert.equal(serializeState((await readBackupFile(backup.file)).data),raw);
});
test('v2 backup roundtrip retains settings and all legacy history, and changes digest',async()=>{
  const state=v2();state.history.push({id:'old',title:'旧履歴',due:null,completedAt:'2020-01-01T00:00:00Z'});
  const raw=serializeState(state),backup=await createBackup(state,now),decoded=await readBackupFile(backup.file);
  assert.equal(JSON.parse(await backup.file.text()).formatVersion,2);assert.equal(serializeState(decoded.data),raw);
  const off=structuredClone(state);off.items[0].notification={enabled:false,notifyAt:null};assert.notEqual(await dataDigest(state),await dataDigest(off));
  assert.deepEqual(prepareRestore(decoded.data,'2026-11-17').candidate.items[0].notification,enabled());
});
test('v1 cannot contain v2 fields and backup outer/inner versions must match',async()=>{
  const data=v2();data.version=1;assert.throws(()=>serializeState(data));
  const envelope=JSON.parse(await (await createBackup(v2(),now)).file.text());
  for(const formatVersion of [0,1,3,'2'])assert.throws(()=>decodeBackup(new TextEncoder().encode(JSON.stringify({...envelope,formatVersion}))));
});
test('notification fields reject malformed, contradictory and unsupported target data',()=>{
  for(const notification of [null,[],{}, {enabled:'true',notifyAt:null},{enabled:false,notifyAt:'2026-11-18T03:00:00.000Z'},{...enabled(),extra:1},{enabled:true,notifyAt:'2026-02-30T03:00:00.000Z'},{enabled:true,notifyAt:'2026-11-18T03:00'},{enabled:true,notifyAt:'2026-11-18T03:00:01.000Z'}])assert.throws(()=>validateNotification(notification));
  for(const change of [{repeat:'daily'},{eventSeriesId:'family'},{type:'task',due:null,pinned:false}]){const state=v2();Object.assign(state.items[0],change);assert.throws(()=>serializeState(state));}
});
test('local input converts to UTC, keeps unchanged past settings editable, rejects newly past or invalid times',()=>{
  const local=stamp(new Date('2026-11-18T03:00:00.000Z'));assert.deepEqual(notificationFromLocal(true,local,undefined,now),enabled());
  const previous={enabled:true,notifyAt:'2026-11-16T03:00:00.000Z'},past=stamp(new Date(previous.notifyAt));
  assert.deepEqual(notificationFromLocal(true,past,previous,now),previous);assert.throws(()=>notificationFromLocal(true,past,undefined,now));
  for(const value of ['', '2026-02-30T12:00','2026-11-18T25:00','2026-11-18T03:00Z'])assert.throws(()=>notificationFromLocal(true,value,undefined,now));
  assert.deepEqual(notificationFromLocal(false,'',undefined,now),{enabled:false,notifyAt:null});
});
test('normal save migrates only explicitly, retains ID, reopens with settings and can turn off',async()=>{
  const f=await storeFixture(),id=f.store.state.items[0].id;assert.equal(f.store.state.version,1);
  await f.store.rollover();assert.equal(f.store.state.version,1);
  const result=await f.store.mutate(d=>{d.version=2;d.items[0].notification=enabled();});assert.equal(result.ok,true);assert.equal(result.verified,true);
  await f.store.refresh();assert.equal(f.store.state.items[0].id,id);assert.deepEqual(notificationSettings(f.store.state.items[0]),enabled());
  assert.equal((await f.store.mutate(d=>{d.items[0].notification={enabled:false,notifyAt:null};})).ok,true);
  assert.equal(parseState(f.map.get(STORAGE_KEY)).items[0].notification.enabled,false);
});
test('failed v2 save and invalid backup restore preserve v1 raw data',async()=>{
  const f=await storeFixture(),raw=f.map.get(STORAGE_KEY);f.setFail(true);
  assert.equal((await f.store.mutate(d=>{d.version=2;d.items[0].notification=enabled();})).ok,false);assert.equal(f.map.get(STORAGE_KEY),raw);assert.equal(f.store.state.version,1);
  assert.throws(()=>decodeBackup(new TextEncoder().encode('{"formatVersion":2}')));assert.equal(f.map.get(STORAGE_KEY),raw);
});
test('normal restoration and emergency recovery retain v2 settings, with v1 restoration still supported',async()=>{
  const backup=await readBackupFile((await createBackup(v2(),now)).file),f=await storeFixture();
  let preview=await f.store.preview(backup);
  assert.equal((await f.store.restore(preview,{replace:true})).ok,true);assert.deepEqual(f.store.state.items[0].notification,enabled());
  f.map.set(STORAGE_KEY,'broken');await f.store.refresh();preview=await f.store.preview(backup);
  assert.equal((await f.store.restore(preview,{replace:true,emergency:true,quarantine:'skip'})).ok,true);assert.equal(f.store.state.version,2);
  const old=await readBackupFile((await createBackup(seed('2026-11-17'),now)).file);preview=await f.store.preview(old);
  assert.equal((await f.store.restore(preview,{replace:true})).ok,true);assert.equal(f.store.state.version,1);
});
test('task completion undo and event deletion preserve v2 validity and notification history policy',()=>{
  const data=v2();complete(data,data.items[2].id,now);restore(data,data.history[0].id,now);assert.equal(data.version,2);assert.deepEqual(data.items[0].notification,enabled());
  removeItem(data,data.items[0].id);assert.equal(data.history.length,1);assert.doesNotThrow(()=>serializeState(data));
});
