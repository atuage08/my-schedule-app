import test from 'node:test';
import assert from 'node:assert/strict';
import {ScheduleStore,MIGRATION_KEY,MIGRATION_LIMITS,META_KEY} from '../src/storage.js';
import {seed,serializeState,parseState,STORAGE_KEY} from '../src/model.js';
import {createBackup,readBackupFile} from '../src/backup.js';
const now=new Date('2026-11-17T03:00:00.000Z');
const setting={enabled:true,notifyAt:'2026-11-18T03:00:00.000Z'};
async function fixture(){
  const data=seed('2026-11-17');data.history.push({id:'legacy',title:'旧形式の架空履歴',due:null,completedAt:'2020-01-01T00:00:00Z'});
  // Preserve even original whitespace, not merely a reserialized equivalent.
  const raw=JSON.stringify(data,null,2),map=new Map([[STORAGE_KEY,raw]]),writes=[];
  const hooks={};const storage={getItem(key){return hooks.read?hooks.read(key,map):map.get(key)??null;},setItem(key,value){if(hooks.write)hooks.write(key,value,map);else map.set(key,value);writes.push(key);}};
  const store=new ScheduleStore({storage,locks:{request:async(name,options,action)=>action()},now:()=>now});await store.refresh();
  return {store,map,raw,data,hooks,writes};
}
const migrate=store=>store.mutate(data=>{data.version=2;data.items[0].notification={...setting};});
test('migration preserves exact v1 preimage first and changes no unrelated items or history',async()=>{
  const f=await fixture();assert.equal((await migrate(f.store)).ok,true);
  const archive=JSON.parse(f.map.get(MIGRATION_KEY));assert.equal(archive.entries[0].raw,f.raw);
  assert.ok(f.writes.indexOf(MIGRATION_KEY)<f.writes.indexOf(STORAGE_KEY));
  const migrated=parseState(f.map.get(STORAGE_KEY));delete migrated.items[0].notification;migrated.version=1;assert.deepEqual(migrated,f.data);
});
test('archive read, write and verification failures stop before the primary v2 write',async()=>{
  for(const mode of ['read','write','readback','mismatch']){
    const f=await fixture();let archived=false;
    f.hooks.read=(key,map)=>{if(key===MIGRATION_KEY&&(mode==='read'||archived&&mode==='readback'))throw Error('denied');if(key===MIGRATION_KEY&&archived&&mode==='mismatch')return null;return map.get(key)??null;};
    f.hooks.write=(key,value,map)=>{if(key===MIGRATION_KEY&&mode==='write')throw Error('quota');map.set(key,value);if(key===MIGRATION_KEY)archived=true;};
    const result=await migrate(f.store);assert.equal(result.ok,false);assert.equal(result.reason,'migration');assert.equal(f.map.get(STORAGE_KEY),f.raw);assert.equal(f.writes.includes(STORAGE_KEY),false);
  }
});
test('primary write failure retains both old primary and verified preimage; a retry does not duplicate it',async()=>{
  const f=await fixture();f.hooks.write=(key,value,map)=>{if(key===STORAGE_KEY)throw Error('denied');map.set(key,value);};
  assert.equal((await migrate(f.store)).ok,false);assert.equal(f.map.get(STORAGE_KEY),f.raw);assert.equal(JSON.parse(f.map.get(MIGRATION_KEY)).entries.length,1);
  delete f.hooks.write;assert.equal((await migrate(f.store)).ok,true);assert.equal(JSON.parse(f.map.get(MIGRATION_KEY)).entries.length,1);
});
test('primary readback failure remains uncertain, protects writes, and leaves v1 export available',async()=>{
  const f=await fixture();let written=false;
  f.hooks.write=(key,value,map)=>{map.set(key,value);if(key===STORAGE_KEY)written=true;};
  f.hooks.read=(key,map)=>{if(key===STORAGE_KEY&&written)throw Error('denied');return map.get(key)??null;};
  const result=await migrate(f.store);assert.equal(result.committed,null);assert.equal(f.store.status,'unverified');
  await f.store.refresh();assert.equal((await f.store.mutate(()=>{})).ok,false);
  const backup=await f.store.migrationBackup(0);assert.deepEqual((await readBackupFile(backup.file)).data,f.data);assert.equal(backup.purpose,'migration');
});
test('malformed or full archive is never replaced or evicted to permit migration',async()=>{
  for(const raw of ['broken',JSON.stringify({version:1,entries:Array.from({length:MIGRATION_LIMITS.entries},(_,i)=>{const data=seed('2026-11-17');data.items[0].title='以前の架空原本'+i;return {raw:serializeState(data),capturedAt:now.toISOString()};})})]){
    const f=await fixture();f.map.set(MIGRATION_KEY,raw);assert.equal((await migrate(f.store)).ok,false);assert.equal(f.map.get(MIGRATION_KEY),raw);assert.equal(f.map.get(STORAGE_KEY),f.raw);
  }
});
test('stale baseline or intervening primary change during archive I/O is never overwritten',async()=>{
  for(const duringArchive of [false,true]){
    const f=await fixture(),other=seed('2026-11-17');other.items[0].title='別画面の変更';const changed=serializeState(other);
    if(duringArchive)f.hooks.write=(key,value,map)=>{map.set(key,value);if(key===MIGRATION_KEY)map.set(STORAGE_KEY,changed);};else f.map.set(STORAGE_KEY,changed);
    assert.equal((await migrate(f.store)).ok,false);assert.equal(f.map.get(STORAGE_KEY),changed);
  }
});
test('retained v1 exports as v1, can be explicitly restored, and does not change backup metadata',async()=>{
  const f=await fixture();await migrate(f.store);const meta=f.map.get(META_KEY),active=f.map.get(STORAGE_KEY);
  const artifact=await f.store.migrationBackup(0);assert.equal(f.map.get(STORAGE_KEY),active);assert.equal(f.map.get(META_KEY),meta);
  const source=await readBackupFile(artifact.file);assert.equal(source.data.version,1);assert.deepEqual(source.data,f.data);
  const preview=f.store.preview(source);assert.equal((await f.store.restore(preview,{replace:false})).ok,false);assert.equal(f.map.get(STORAGE_KEY),active);
  assert.equal((await f.store.restore(preview,{replace:true})).ok,true);assert.equal(f.store.state.version,1);assert.deepEqual(f.store.state.history,f.data.history);assert.ok(f.map.has(MIGRATION_KEY));
});
test('restoring a v2 backup over healthy v1 also preserves its preimage',async()=>{
  const f=await fixture(),data=seed('2026-11-17');data.version=2;data.items[0].notification={...setting};
  const source=await readBackupFile((await createBackup(data,now)).file);
  assert.equal((await f.store.restore(f.store.preview(source),{replace:true})).ok,true);assert.equal(JSON.parse(f.map.get(MIGRATION_KEY)).entries[0].raw,f.raw);
});
test('normal v2 edits and reloads do not replace earlier archive snapshots',async()=>{
  const f=await fixture();await migrate(f.store);const archive=f.map.get(MIGRATION_KEY);
  await f.store.mutate(d=>{d.items[0].title='移行後の架空変更';});await f.store.refresh();assert.equal(f.map.get(MIGRATION_KEY),archive);
  const data=seed('2026-11-17');data.items[0].title='別のv1';f.map.set(STORAGE_KEY,serializeState(data));await f.store.refresh();assert.equal((await migrate(f.store)).ok,true);
  const entries=JSON.parse(f.map.get(MIGRATION_KEY)).entries;assert.equal(entries.length,2);assert.equal(entries[0].raw,f.raw);
});
