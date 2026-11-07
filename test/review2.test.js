import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays, calendarIndicators, complete, deletionPlan, editEventOccurrence, eventOn, LIMITS, parseState, removeItem, serializeState, validateItem, validateState } from '../src/model.js';

const event=(changes={})=>({id:'root',type:'event',title:'架空の予定',start:'2026-11-07T12:00',end:'2026-11-07T13:00',allDay:false,repeat:'weekly',excluded:[],...changes});
const task=(changes={})=>({id:'task',type:'task',title:'架空のタスク',due:'2026-11-07',repeat:'none',pinned:false,excluded:[],...changes});
const state=(items=[])=>({version:1,items,history:[]});
const moved=(changes={})=>event({start:'2026-11-09T14:00',end:'2026-11-09T15:00',...changes});
const except=(s,day='2026-11-07',replacement=moved())=>editEventOccurrence(s,'root',replacement,day);

test('one-only editing records series and original slot even when moved to another date',()=>{
  const s=state([event()]);const id=except(s);
  const root=s.items.find(x=>x.id==='root'),child=s.items.find(x=>x.id===id);
  assert.equal(root.eventSeriesId,'root');assert.deepEqual(root.excluded,['2026-11-07']);
  assert.equal(child.eventSeriesId,'root');assert.equal(child.exceptionDate,'2026-11-07');assert.equal(child.repeat,'none');
  assert.equal(child.start,'2026-11-09T14:00');assert.doesNotThrow(()=>validateState(s));
});
test('event family provenance survives serialization and subsequent exception edits',()=>{
  const s=state([event()]);const id=except(s);const loaded=parseState(serializeState(s));
  const child=loaded.items.find(x=>x.id===id);child.title='移動後の架空予定';child.start='2026-12-01T15:00';child.end='2026-12-01T16:00';
  assert.equal(child.exceptionDate,'2026-11-07');assert.doesNotThrow(()=>validateState(loaded));
  removeItem(loaded,'root','all');assert.deepEqual(loaded.items,[]);
});
test('replacing the same slot again keeps just one associated exception',()=>{
  const s=state([event()]);const old=except(s);const replacement=except(s,'2026-11-07',moved({title:'2回目の架空編集'}));
  assert.notEqual(old,replacement);assert.equal(s.items.length,2);assert.equal(s.items.filter(x=>x.exceptionDate==='2026-11-07').length,1);
  assert.deepEqual(s.items[0].excluded,['2026-11-07']);
});
test('all deletion removes moved exceptions but preserves unrelated events, tasks and every history record',()=>{
  const s=state([event(),event({id:'unrelated',title:'架空の予定',repeat:'none'}),task({seriesId:'root'}),task({id:'completed'})]);
  complete(s,'completed',new Date(2026,10,7));s.history[0].restoredAt=new Date(2026,10,7).toISOString();
  except(s);except(s,'2026-11-14',moved({start:'2027-01-02T12:00',end:'2027-01-02T13:00'}));
  const history=structuredClone(s.history);removeItem(s,'root','all');
  assert.deepEqual(s.items.map(x=>x.id).sort(),['task','unrelated']);assert.deepEqual(s.history,history);
});
test('all deletion initiated from an exception includes its root and sibling exceptions',()=>{
  const s=state([event(),event({id:'other',repeat:'none'})]);const child=except(s);except(s,'2026-11-14');
  removeItem(s,child,'all');assert.deepEqual(s.items.map(x=>x.id),['other']);
});
test('one-only deletion of the original series does not delete exceptions from other slots',()=>{
  const s=state([event()]);const child=except(s,'2026-11-14');removeItem(s,'root','one','2026-11-07');
  assert.equal(s.items.length,2);assert.ok(s.items.some(x=>x.id===child));
  assert.equal(eventOn(s.items[0],'2026-11-07'),null);assert.ok(eventOn(s.items[0],'2026-11-21'));
});
test('deleting the replaced slot removes only its replacement and leaves its exclusion in place',()=>{
  const s=state([event()]);const first=except(s),second=except(s,'2026-11-14');
  removeItem(s,'root','one','2026-11-07');assert.ok(!s.items.some(x=>x.id===first));assert.ok(s.items.some(x=>x.id===second));
  assert.equal(eventOn(s.items.find(x=>x.id==='root'),'2026-11-07'),null);
});
test('one-only deletion from a moved exception leaves root and siblings intact',()=>{
  const s=state([event()]);const first=except(s),second=except(s,'2026-11-14');removeItem(s,first,'one');
  assert.deepEqual(s.items.map(x=>x.id),['root',second]);assert.ok(eventOn(s.items[0],'2026-11-21'));
  assert.deepEqual(s.items[0].excluded,['2026-11-07','2026-11-14']);
});
test('confirmation plan identifies the exact family and counts exceptions before deletion',()=>{
  const s=state([event(),event({id:'other',repeat:'none'})]);const first=except(s),second=except(s,'2026-11-14');
  assert.deepEqual(deletionPlan(s,'root','all'),{kind:'event-series',itemIds:['root',first,second],exceptionCount:2});
  assert.deepEqual(deletionPlan(s,first,'one'),{kind:'event-exception',itemIds:[first],exceptionCount:0,occurrence:'2026-11-07'});
  assert.deepEqual(deletionPlan(s,'root','one','2026-11-14'),{kind:'event-occurrence',itemIds:[second],exceptionCount:1,occurrence:'2026-11-14'});
});
test('invalid or failed exception creation/deletion leaves all source records unchanged',()=>{
  const s=state([event()]);const before=serializeState(s);
  assert.throws(()=>except(s,'2026-11-08'));assert.equal(serializeState(s),before);
  assert.throws(()=>except(s,'2026-11-07',moved({end:'2026-11-09T13:00'})));assert.equal(serializeState(s),before);
  assert.throws(()=>removeItem(s,'root','invalid'));assert.equal(serializeState(s),before);
});
test('validation rejects orphan/cyclic links, task links and duplicate source slots',()=>{
  const s=state([event()]);const id=except(s);const child=s.items.find(x=>x.id===id);
  assert.throws(()=>validateItem({...child,repeat:'weekly'}));assert.throws(()=>validateItem(task({eventSeriesId:'root'})));
  assert.throws(()=>validateState(state([child])));
  assert.throws(()=>validateState(state([...s.items,{...child,id:'duplicate'}])));
  assert.throws(()=>validateState(state([event({eventSeriesId:'other'}),event({id:'other',eventSeriesId:'root'})])));
});
test('item capacity failure rolls back the source exclusion and its newly assigned series identity',()=>{
  const s=state([event(),...Array.from({length:LIMITS.items-1},(_,i)=>task({id:'task-'+i}))]);const before=serializeState(s);
  assert.throws(()=>except(s));assert.equal(serializeState(s),before);
});
test('unlinked legacy one-off events are not guessed into a family by matching title or dates',()=>{
  const s=state([event(),moved({id:'legacy',repeat:'none'})]);except(s);removeItem(s,'root','all');
  assert.deepEqual(s.items.map(x=>x.id),['legacy']);
});
test('disabling recurrence preserves the exception family and permits explicit all deletion',()=>{
  const s=state([event()]);const child=except(s);s.items[0].repeat='none';assert.doesNotThrow(()=>validateState(s));
  const before=serializeState(s);assert.throws(()=>removeItem(s,'root','one'));assert.equal(serializeState(s),before);
  removeItem(s,child,'all');assert.equal(s.items.length,0);
});
test('empty dates and undated tasks have no calendar markers',()=>{
  assert.deepEqual(calendarIndicators([task({due:null})],['2026-11-07']).get('2026-11-07'),{hasEvent:false,hasTask:false});
  assert.deepEqual(calendarIndicators([],['2026-11-07']).get('2026-11-07'),{hasEvent:false,hasTask:false});
});
test('event-only, deadline-only and combined days retain independent markers',()=>{
  const items=[event({repeat:'none'}),task(),task({id:'later',due:'2026-11-08'}),task({id:'someday',due:null})];
  const marks=calendarIndicators(items,['2026-11-07','2026-11-08','2026-11-09']);
  assert.deepEqual([...marks.values()],[{hasEvent:true,hasTask:true},{hasEvent:false,hasTask:true},{hasEvent:false,hasTask:false}]);
  assert.deepEqual(calendarIndicators([event({repeat:'none'})],['2026-11-07']).get('2026-11-07'),{hasEvent:true,hasTask:false});
});
test('week and month use identical marker results on their overlapping dates',()=>{
  const items=[event(),task({due:'2026-11-14'})],week=Array.from({length:7},(_,i)=>addDays('2026-11-09',i)),month=Array.from({length:42},(_,i)=>addDays('2026-10-26',i));
  const weekly=calendarIndicators(items,week),monthly=calendarIndicators(items,month);
  for(const day of week)assert.deepEqual(weekly.get(day),monthly.get(day));
  assert.throws(()=>calendarIndicators(items,[...month,'2026-12-07']));assert.throws(()=>calendarIndicators(items,['not-a-date']));
});
test('completion moves a recurring deadline marker to its next incomplete date',()=>{
  const s=state([task({repeat:'daily'})]);complete(s,'task',new Date(2026,10,7));
  const marks=calendarIndicators(s.items,['2026-11-07','2026-11-08']);
  assert.equal(marks.get('2026-11-07').hasTask,false);assert.equal(marks.get('2026-11-08').hasTask,true);
});
test('multi-day and all-day markers honor midnight-exclusive end dates',()=>{
  const marks=calendarIndicators([event({repeat:'none',allDay:true,start:'2026-11-07T00:00',end:'2026-11-10T00:00'})],['2026-11-07','2026-11-09','2026-11-10']);
  assert.deepEqual([...marks.values()].map(x=>x.hasEvent),[true,true,false]);
});
test('moved exception marks its actual day; family deletion removes only event markers',()=>{
  const s=state([event(),task({due:'2026-11-09'})]);except(s);
  let marks=calendarIndicators(s.items,['2026-11-07','2026-11-09','2026-11-14']);
  assert.deepEqual([...marks.values()],[{hasEvent:false,hasTask:false},{hasEvent:true,hasTask:true},{hasEvent:true,hasTask:false}]);
  removeItem(s,'root','all');marks=calendarIndicators(s.items,['2026-11-09']);
  assert.deepEqual(marks.get('2026-11-09'),{hasEvent:false,hasTask:true});
});
test('disabled neighboring cells outside the input range have no markers',()=>{
  const marks=calendarIndicators([],['1999-12-31','2101-01-01']);
  assert.ok([...marks.values()].every(mark=>!mark.hasEvent&&!mark.hasTask));
});
