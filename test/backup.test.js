import test from 'node:test';
import assert from 'node:assert/strict';
import {seed,serializeState,complete,restore,editEventOccurrence} from '../src/model.js';
import {createBackup,decodeBackup,readBackupFile,createQuarantine,prepareRestore,canonicalData,MAX_FILE_BYTES} from '../src/backup.js';
const now=new Date('2026-11-09T03:00:00Z');
const encode=(data,extra={})=>new TextEncoder().encode(JSON.stringify({format:'my-schedule-backup',formatVersion:1,exportedAt:now.toISOString(),data,...extra}));
function rich(){
  const data=seed('2026-11-09');
  data.items[0].repeat='monthly';
  editEventOccurrence(data,data.items[0].id,{...data.items[0],title:'変更した架空予定',start:'2026-11-10T10:00',end:'2026-11-10T11:00'},'2026-11-09');
  data.items[2].repeat='yearly';data.items[2].anchorDay=9;data.items[2].anchorMonth=11;
  complete(data,data.items[2].id,now);
  data.history.push({id:'legacy',title:'旧形式の架空履歴',due:null,completedAt:'2020-01-01T00:00:00Z'});
  return data;
}
test('backup roundtrip preserves all histories, recurrence, exceptions and auxiliary fields without rollover',async()=>{
  const data=rich(),before=serializeState(data),file=await createBackup(data,now),decoded=await readBackupFile(file.file);
  assert.equal(serializeState(decoded.data),before);assert.equal(serializeState(data),before);
  assert.equal(decoded.data.history.length,2);assert.equal(Object.isFrozen(file.data.items),true);
  assert.equal(file.file.type,'application/json');assert.ok(file.file.size<=MAX_FILE_BYTES);
});
test('a prepared backup is independent of subsequent changes and timestamps do not alter its data digest',async()=>{
  const data=rich(),first=await createBackup(data,now),same=await createBackup(data,new Date('2026-11-10T03:00:00Z'));
  data.items[0].title='後の変更';
  assert.equal(first.digest,same.digest);assert.notEqual(first.exportedAt,same.exportedAt);
  assert.notEqual((await readBackupFile(first.file)).data.items[0].title,data.items[0].title);
});
test('restored modern and legacy history remains valid after completion undo and completion',async()=>{
  const decoded=await readBackupFile((await createBackup(rich(),now)).file),state=structuredClone(decoded.data);
  restore(state,state.history[0].id,now);complete(state,state.items.find(item=>item.type==='task'&&item.repeat==='yearly').id,now);
  assert.equal(state.history.find(h=>h.id==='legacy').task,undefined);assert.doesNotThrow(()=>serializeState(state));
});
test('history snapshots are not rejected merely because the original item was deleted',async()=>{
  const data=rich();data.items=data.items.filter(item=>item.type!=='task');
  assert.equal((await readBackupFile((await createBackup(data,now)).file)).data.history.length,2);
});
test('rollover plan is separate and reports due changes and exhausted tasks by name and reason',()=>{
  const data=seed('2026-11-09');data.items[2].repeat='weekly';
  data.items[3].repeat='yearly';data.items[3].due='2100-11-01';
  const before=serializeState(data),plan=prepareRestore(data,'2100-12-31');
  assert.equal(serializeState(data),before);assert.equal(plan.changes.length,2);
  assert.ok(plan.changes.some(change=>change.after===null&&change.title===data.items[3].title&&change.reason));
  assert.equal(plan.candidate.history.length,data.history.length);
});
test('canonical data ignores object key order while preserving array order and optional field presence',()=>{
  const data=seed('2026-11-09'),reordered={history:data.history,items:data.items,version:1};
  assert.equal(canonicalData(data),canonicalData(reordered));
  reordered.items=[...data.items].reverse();assert.notEqual(canonicalData(data),canonicalData(reordered));
});
test('strict UTF-8 rejects replacement-producing byte sequences',()=>{
  for(const bytes of [[0xc0,0xaf],[0xed,0xa0,0x80],[0xff],[0xe3,0x81]])assert.throws(()=>decodeBackup(Uint8Array.from(bytes)),error=>error.code==='encoding');
});
test('one leading UTF-8 BOM is accepted but duplicate BOM is rejected',()=>{
  const raw=encode(seed('2026-11-09')),bom=Uint8Array.from([0xef,0xbb,0xbf]);
  assert.equal(decodeBackup(Buffer.concat([bom,raw])).data.items.length,6);
  assert.throws(()=>decodeBackup(Buffer.concat([bom,bom,raw])),error=>error.code==='encoding');
});
test('empty, oversized, unreadable and inconsistent file sizes are rejected before import',async()=>{
  assert.throws(()=>decodeBackup(new Uint8Array()),error=>error.code==='size');
  let read=false;await assert.rejects(readBackupFile({size:MAX_FILE_BYTES+1,arrayBuffer(){read=true;}}));assert.equal(read,false);
  await assert.rejects(readBackupFile({size:2,arrayBuffer:async()=>new ArrayBuffer(1)}));
  await assert.rejects(readBackupFile({size:2,arrayBuffer:async()=>{throw Error('private contents');}}),error=>!error.message.includes('private'));
});
test('unknown formats, versions, keys and invalid dates are rejected',()=>{
  for(const extra of [{format:'other-app'},{formatVersion:2},{exportedAt:'not-a-date'},{unexpected:1}])assert.throws(()=>decodeBackup(encode(seed('2026-11-09'),extra)));
  assert.throws(()=>decodeBackup(new TextEncoder().encode('{broken')));
  const data=seed('2026-11-09');data.items[0].start='2026-02-30T00:00';assert.throws(()=>decodeBackup(encode(data)));
});
test('deep JSON is rejected before parsing and quoted braces do not count as containers',()=>{
  assert.throws(()=>decodeBackup(new TextEncoder().encode('['.repeat(9)+'0'+']'.repeat(9))),error=>error.code==='structure');
  const data=seed('2026-11-09');data.items[0].title='[\\"{{{{{{{{{{{{{{{{{{{{';assert.equal(decodeBackup(encode(data)).data.items[0].title,data.items[0].title);
});
test('object, array and prototype-like structural violations are refused',()=>{
  const data=seed('2026-11-09');
  assert.throws(()=>decodeBackup(encode(data,{extra:Array(10001).fill(null)})),error=>error.code==='structure');
  assert.throws(()=>decodeBackup(encode(data,Object.fromEntries(Array.from({length:33},(_,i)=>['k'+i,0])))),error=>error.code==='structure');
  const text=new TextDecoder().decode(encode(data)).replace('"format":','"__proto__":{"polluted":true},"format":');
  assert.throws(()=>decodeBackup(new TextEncoder().encode(text)));assert.equal({}.polluted,undefined);
});
test('internal serialized limit is enforced even when the outer file fits 8MiB',()=>{
  const data=seed('2026-11-09');data.history=Array.from({length:10000},(_,i)=>({id:'h'+i,title:'架'.repeat(160),due:null,completedAt:'2020-01-01T00:00:00Z'}));
  const bytes=encode(data);assert.ok(bytes.length<MAX_FILE_BYTES);assert.throws(()=>decodeBackup(bytes),error=>error.code==='data');
});
test('a large valid export satisfies its own import conditions',async()=>{
  const data=seed('2026-11-09');data.history=Array.from({length:7000},(_,i)=>({id:'h'+i,title:'架'.repeat(120),due:null,completedAt:'2020-01-01T00:00:00Z'}));
  const artifact=await createBackup(data,now);assert.equal((await readBackupFile(artifact.file)).data.history.length,7000);
});
test('special and hostile text survives literally and does not execute',async()=>{
  const data=seed('2026-11-09');data.items[0].title='<script>globalThis.backupExecuted=true</script> & 日本語';
  const read=await readBackupFile((await createBackup(data,now)).file);
  assert.equal(read.data.items[0].title,data.items[0].title);assert.equal(globalThis.backupExecuted,undefined);
});
test('quarantine retains UTF-16 code units including lone surrogates and cannot import as backup',async()=>{
  const raw='broken\ud800\u0000\udfff日本語',artifact=createQuarantine(raw,now),bytes=new Uint8Array(await artifact.file.arrayBuffer());
  let restored='';for(let i=0;i<bytes.length;i+=2)restored+=String.fromCharCode(bytes[i]|bytes[i+1]<<8);
  assert.equal(restored,raw);assert.equal(artifact.file.type,'application/octet-stream');assert.throws(()=>decodeBackup(bytes));
  assert.throws(()=>createQuarantine('x'.repeat(MAX_FILE_BYTES/2+1),now));assert.throws(()=>createQuarantine(null,now));
});

test('outer byte limit accepts exactly 8MiB and refuses the next byte',()=>{
  const raw=encode(seed('2026-11-09')),bytes=new Uint8Array(MAX_FILE_BYTES);bytes.fill(32);bytes.set(raw);
  assert.equal(decodeBackup(bytes).data.items.length,6);
  assert.throws(()=>decodeBackup(new Uint8Array(MAX_FILE_BYTES+1)),error=>error.code==='size');
});

test('internal character limit roundtrips exactly 2000000 characters and refuses the next character',async()=>{
  const data=seed('2026-11-09');data.history=Array.from({length:9000},(_,i)=>({id:'h'+i,title:'架'.repeat(100),due:null,completedAt:'2020-01-01T00:00:00Z'}));
  let remaining=2000000-serializeState(data).length;
  for(const record of data.history){const count=Math.min(60,remaining);record.title+='架'.repeat(count);remaining-=count;if(!remaining)break;}
  assert.equal(remaining,0);assert.equal(serializeState(data).length,2000000);
  assert.equal(serializeState((await readBackupFile((await createBackup(data,now)).file)).data).length,2000000);
  data.history.find(record=>record.title.length<160).title+='架';assert.throws(()=>decodeBackup(encode(data)),error=>error.code==='data');
});
