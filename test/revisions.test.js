import test from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, MIN_DATE, MAX_DATE, addDays, nextDate, eventOn, validateItem, validateState, parseState, serializeState, rollTasks, complete, restore, removeItem, dueGroups } from '../src/model.js';
const task=(changes={})=>({id:'task',type:'task',title:'架空のタスク',due:null,pinned:false,repeat:'none',excluded:[],...changes});
const event=(changes={})=>({id:'event',type:'event',title:'架空の予定',start:'2026-11-07T12:00',end:'2026-11-07T13:00',allDay:false,repeat:'none',excluded:[],...changes});
const state=(items=[])=>({version:1,items,history:[]});
const now=new Date(2026,10,7,12);

test('biweekly crosses month, leap day and year boundaries',()=>{
  assert.equal(nextDate('2026-12-25','biweekly'),'2027-01-08');
  assert.equal(nextDate('2028-02-20','biweekly'),'2028-03-05');
  assert.equal(nextDate('2027-01-31','biweekly'),'2027-02-14');
});
test('yearly leap anchor returns to February 29 after clipped years',()=>{
  let due='2024-02-29';
  for(const expected of ['2025-02-28','2026-02-28','2027-02-28','2028-02-29']){
    due=nextDate(due,'yearly',29,2);assert.equal(due,expected);
  }
  assert.equal(nextDate('2026-12-31','yearly',31,12),'2027-12-31');
  assert.equal(nextDate('2096-02-29','yearly',29,2),'2097-02-28');
  assert.equal(nextDate('2099-02-28','yearly',29,2),'2100-02-28');
});
test('yearly event preserves leap-day recurrence and biweekly event skips intervening week',()=>{
  const yearly=event({start:'2024-02-29T12:00',end:'2024-02-29T13:00',repeat:'yearly',anchorDay:29,anchorMonth:2});
  assert.ok(eventOn(yearly,'2025-02-28'));assert.ok(eventOn(yearly,'2028-02-29'));assert.equal(eventOn(yearly,'2028-02-28'),null);
  const fortnight=event({repeat:'biweekly'});
  assert.equal(eventOn(fortnight,'2026-11-14'),null);assert.ok(eventOn(fortnight,'2026-11-21'));
});
test('yearly and monthly task rollover preserve anchors across long gaps',()=>{
  const s=state([task({due:'2024-02-29',repeat:'yearly'}),task({id:'monthly',due:'2027-01-31',repeat:'monthly'})]);
  rollTasks(s,'2027-02-28');assert.equal(s.items[0].due,'2027-02-28');
  rollTasks(s,'2028-02-29');assert.equal(s.items[0].due,'2028-02-29');assert.equal(s.items[1].due,'2028-02-29');
  rollTasks(s,'2028-03-01');assert.equal(s.items[1].due,'2028-03-31');
});
test('title-only task roundtrips complete, restore and complete with audit retained',()=>{
  const s=state([task()]);complete(s,'task',now);const id=s.history[0].id;
  restore(s,id,now);assert.equal(s.items.length,1);assert.equal(s.items[0].due,null);assert.ok(s.history[0].restoredAt);
  complete(s,'task',now);assert.equal(s.items.length,0);assert.equal(s.history.length,2);assert.doesNotThrow(()=>parseState(serializeState(s)));
});
test('double restoration fails atomically',()=>{
  const s=state([task()]);complete(s,'task',now);restore(s,s.history[0].id,now);const before=serializeState(s);
  assert.throws(()=>restore(s,s.history[0].id,now),/復元済み/);assert.equal(serializeState(s),before);
});
test('restoring recurring completion merges into the existing next occurrence without rewinding edits',()=>{
  const s=state([task({due:'2026-11-07',repeat:'daily'})]);complete(s,'task',now);
  s.items[0].title='編集した架空タスク';restore(s,s.history[0].id,now);
  assert.equal(s.items.length,1);assert.equal(s.items[0].due,'2026-11-08');assert.equal(s.items[0].title,'編集した架空タスク');
});
test('restoring an older recurrence leaves other completion records untouched',()=>{
  const s=state([task({due:'2026-11-07',repeat:'daily'})]);complete(s,'task',now);complete(s,'task',now);
  const second=structuredClone(s.history[1]);restore(s,s.history[0].id,now);
  assert.equal(s.items.length,1);assert.equal(s.items[0].due,'2026-11-09');assert.deepEqual(s.history[1],second);
});
test('restored deleted series skips other already-completed occurrences on subsequent completion',()=>{
  const s=state([task({due:'2026-11-07',repeat:'daily'})]);complete(s,'task',now);complete(s,'task',now);
  removeItem(s,'task','all');restore(s,s.history[0].id,now);assert.equal(s.items[0].due,'2026-11-07');
  complete(s,'task',now);assert.equal(s.items[0].due,'2026-11-09');
  assert.equal(s.history.filter(h=>h.due==='2026-11-08'&&!h.restoredAt).length,1);
});
test('restoring several completions after deletion creates just one pending series',()=>{
  const s=state([task({due:'2026-11-07',repeat:'weekly'})]);complete(s,'task',now);complete(s,'task',now);removeItem(s,'task');
  restore(s,s.history[1].id,now);restore(s,s.history[0].id,now);assert.equal(s.items.length,1);assert.equal(s.items[0].due,'2026-11-14');
});
test('restoring after recurrence was disabled respects the existing task settings',()=>{
  const s=state([task({due:'2026-11-07',repeat:'daily'})]);complete(s,'task',now);s.items[0].repeat='none';
  restore(s,s.history[0].id,now);assert.equal(s.items.length,1);assert.equal(s.items[0].repeat,'none');
});
test('legacy completion remains readable; unsafe restore is rejected without loss',()=>{
  const s=state();s.history.push({id:'legacy',title:'架空の旧履歴',due:null,completedAt:now.toISOString()});
  assert.doesNotThrow(()=>validateState(s));const before=serializeState(s);assert.throws(()=>restore(s,'legacy',now),/旧形式/);assert.equal(serializeState(s),before);
});
test('tampered restore snapshot and duplicate history/series IDs are rejected',()=>{
  const s=state([task()]);complete(s,'task',now);s.history[0].task.title='不一致';assert.throws(()=>validateState(s));
  const duplicates=state([task({due:'2026-11-07',repeat:'daily',seriesId:'same'}),task({id:'other',due:'2026-11-08',repeat:'daily',seriesId:'same'})]);assert.throws(()=>validateState(duplicates));
  s.history[0].task.title=s.history[0].title;s.history.push(structuredClone(s.history[0]));assert.throws(()=>validateState(s));
});
test('failed completion and restoration transactions preserve original state',()=>{
  const s=state([task({due:'2026-11-07',repeat:'daily'})]);const before=serializeState(s);
  assert.throws(()=>complete(s,'task',new Date(2200,0,1)));assert.equal(serializeState(s),before);
  complete(s,'task',now);const completed=serializeState(s);assert.throws(()=>restore(s,s.history[0].id,new Date(2200,0,1)));assert.equal(serializeState(s),completed);
});
test('one-only event deletion excludes that occurrence and leaves future dates',()=>{
  const s=state([event({repeat:'biweekly'})]);removeItem(s,'event','one','2026-11-21');
  assert.ok(eventOn(s.items[0],'2026-11-07'));assert.equal(eventOn(s.items[0],'2026-11-21'),null);assert.ok(eventOn(s.items[0],'2026-12-05'));
});
test('all-series deletion removes the series without deleting completion history',()=>{
  const s=state([task({due:'2026-11-07',repeat:'weekly'})]);complete(s,'task',now);removeItem(s,'task','all');assert.equal(s.items.length,0);assert.equal(s.history.length,1);
});
test('invalid deletion scope/date leaves source unchanged',()=>{
  const s=state([event({repeat:'weekly'})]);const before=serializeState(s);
  assert.throws(()=>removeItem(s,'event','one','2026-11-08'));assert.equal(serializeState(s),before);
  assert.throws(()=>removeItem(s,'event','invalid'));assert.equal(serializeState(s),before);
});
test('one-only task deletion advances fortnightly and preserves year/month anchors',()=>{
  const s=state([task({due:'2026-12-25',repeat:'biweekly'})]);removeItem(s,'task','one');assert.equal(s.items[0].due,'2027-01-08');
});
test('four deadline groups use tomorrow through today+7 inclusive',()=>{
  const tasks=[-1,0,1,7,8].map(n=>task({id:String(n),due:addDays('2026-12-28',n)}));tasks.push(task({id:'someday'}));
  const groups=dueGroups(tasks,'2026-12-28');assert.deepEqual([...groups.keys()],['期限超過','今日','今後7日以内','それ以降']);
  assert.deepEqual([...groups.values()].map(list=>list.map(t=>t.id)),[['-1'],['0'],['1','7'],['8']]);
});
test('date bounds reject malformed/out-of-range dates; upper-bound recurrence terminates',()=>{
  for(const due of ['0000-01-01','1999-12-31','2101-01-01','2026-02-29','999999-01-01'])assert.throws(()=>validateItem(task({due})));
  assert.doesNotThrow(()=>validateItem(task({due:MIN_DATE})));assert.doesNotThrow(()=>validateItem(task({due:MAX_DATE})));
  assert.equal(nextDate(MAX_DATE,'daily'),null);assert.throws(()=>nextDate('2026-11-07','invalid'));
});
test('366-day duration cap and end-exclusive final midnight are enforced',()=>{
  assert.throws(()=>validateItem(event({start:'2026-01-01T00:00',end:'2028-01-01T00:00'})));
  assert.doesNotThrow(()=>validateItem(event({allDay:true,start:'2100-12-31T00:00',end:'2101-01-01T00:00'})));
  assert.throws(()=>validateItem(event({allDay:true,start:'2026-11-07T12:00'})));
});
test('oversized input, arrays, exclusions and unknown nested fields fail before processing',()=>{
  assert.throws(()=>parseState(' '.repeat(LIMITS.storageChars+1)),/大きすぎ/);
  assert.throws(()=>validateState(state(Array.from({length:LIMITS.items+1},(_,i)=>task({id:String(i)})))));
  const s=state();s.history=Array(LIMITS.history+1).fill(null);assert.throws(()=>validateState(s));
  assert.throws(()=>validateItem(task({excluded:Array.from({length:LIMITS.excluded+1},(_,i)=>addDays(MIN_DATE,i))})));
  assert.throws(()=>parseState(JSON.stringify({...state(),extra:{deep:{}}})));
});
test('long-gap rollover uses bounded date reads instead of daily iteration',()=>{
  const t=task({due:MIN_DATE,repeat:'daily'});let value=t.due,reads=0;
  Object.defineProperty(t,'due',{enumerable:true,get(){reads++;return value;},set(next){value=next;}});
  rollTasks(state([t]),MAX_DATE);assert.equal(value,MAX_DATE);assert.ok(reads<100,`unbounded reads: ${reads}`);
});
test('long-gap event lookup checks only nearby occurrences',()=>{
  const exclusions=[];let calls=0;
  Object.defineProperty(exclusions,'includes',{value(date){calls++;return Array.prototype.includes.call(this,date);}});
  const e=event({start:MIN_DATE+'T12:00',end:MIN_DATE+'T13:00',repeat:'daily',excluded:exclusions});
  assert.ok(eventOn(e,MAX_DATE));assert.ok(calls<=2);
});
test('excluded upper-limit task exhausts safely',()=>{
  const s=state([task({due:MAX_DATE,repeat:'daily',excluded:[MAX_DATE]})]);rollTasks(s,MAX_DATE);assert.equal(s.items.length,0);
});
test('auxiliary fields cannot hide unknown nested data',()=>{
  assert.throws(()=>validateItem(event({due:{nested:{}}})));
  const s=state();s.history.push({id:'legacy',title:'架空の旧履歴',due:null,completedAt:now.toISOString(),sourceId:{nested:{}}});
  assert.throws(()=>validateState(s));
});
test('history capacity rejects completion without dropping any existing record',()=>{
  const s=state([task()]);
  s.history=Array.from({length:LIMITS.history},(_,i)=>({id:'history-'+i,title:'架空の履歴',due:null,completedAt:now.toISOString()}));
  const before=serializeState(s);assert.throws(()=>complete(s,'task',now),/上限/);assert.equal(serializeState(s),before);
});
