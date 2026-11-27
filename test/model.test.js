import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {newId,dateKey,addDays,defaults,shiftEnd,nextDate,validateState,validateItem,rollTasks,complete,calendarIndicators,eventOn,eventOccurrence,eventOccurrences,agendaPage,deletionPlan,removeItem,seed} from '../src/model.js';
const task=(changes={})=>({id:'t',title:'架空タスク',type:'task',due:null,pinned:false,repeat:'none',excluded:[],...changes});
const event=(changes={})=>({id:'e',title:'架空予定',type:'event',start:'2026-11-07T12:00',end:'2026-11-07T13:00',allDay:false,repeat:'none',excluded:[],...changes});
const state=(items=[])=>({version:1,items,history:[]});
test('LAN HTTP ID fallback works without randomUUID',()=>{
  const insecureCrypto={getRandomValues:crypto.getRandomValues.bind(crypto)};
  const ids=Array.from({length:100},()=>newId(insecureCrypto));
  assert.equal(new Set(ids).size,100);
  assert.ok(ids.every(id=>/^[0-9a-f]{32}$/.test(id)));
});
test('today rounds up ten minutes and preserves one-hour duration',()=>{assert.deepEqual(defaults('2026-11-07',new Date(2026,10,7,12,3)),{start:'2026-11-07T12:10',end:'2026-11-07T13:10'});});
test('exact ten-minute boundary stays; seconds cause rounding',()=>{assert.equal(defaults('2026-11-07',new Date(2026,10,7,12,10)).start,'2026-11-07T12:10');assert.equal(defaults('2026-11-07',new Date(2026,10,7,12,10,1)).start,'2026-11-07T12:20');});
test('other day defaults to noon',()=>{assert.equal(defaults('2026-12-03',new Date(2026,10,7)).start,'2026-12-03T12:00');});
test('late night rounding crosses date',()=>{assert.deepEqual(defaults('2026-11-07',new Date(2026,10,7,23,58)),{start:'2026-11-08T00:00',end:'2026-11-08T01:00'});});
test('start change preserves duration across midnight',()=>{assert.equal(shiftEnd('2026-11-07T12:00','2026-11-07T13:30','2026-11-07T23:00'),'2026-11-08T00:30');});
test('month end recurrence returns to original day',()=>{assert.equal(nextDate('2027-01-31','monthly',31),'2027-02-28');assert.equal(nextDate('2027-02-28','monthly',31),'2027-03-31');assert.equal(nextDate('2028-01-31','monthly',31),'2028-02-29');});
test('weekly and daily rollover',()=>{assert.equal(nextDate('2026-12-31','daily'),'2027-01-01');assert.equal(nextDate('2026-12-31','weekly'),'2027-01-07');});
test('title-only task accepted, repeating task requires date',()=>{assert.doesNotThrow(()=>validateItem(task()));assert.throws(()=>validateItem(task({repeat:'weekly'})));});
test('invalid dates, times and duplicate IDs rejected',()=>{assert.throws(()=>validateItem(task({due:'2026-02-30'})));assert.throws(()=>validateItem(event({end:'2026-11-07T25:00'})));assert.throws(()=>validateItem(event({end:'2026-11-07T11:00'})));assert.throws(()=>validateState(state([task(),task()])));});
test('invalid structures and history rejected',()=>{for(const bad of [null,{}, {version:1,items:[],history:[{}]}])assert.throws(()=>validateState(bad));assert.throws(()=>validateItem(task({title:'  '})));assert.throws(()=>validateItem(task({excluded:['wrong']})));});
test('overdue repeating task becomes one latest incomplete occurrence',()=>{const s=state([task({due:'2026-11-01',repeat:'daily'})]);rollTasks(s,'2026-11-07');assert.equal(s.items.length,1);assert.equal(s.items[0].due,'2026-11-07');assert.equal(s.history.length,0);});
test('weekly rollover picks next due and leaves nonrecurring overdue intact',()=>{const s=state([task({due:'2026-10-30',repeat:'weekly'}),task({id:'once',due:'2026-10-01'})]);rollTasks(s,'2026-11-07');assert.equal(s.items[0].due,'2026-11-13');assert.equal(s.items[1].due,'2026-10-01');});
test('complete removes task and persists history after 90 days',()=>{const s=state([task()]);complete(s,'t',new Date(2026,0,1));rollTasks(s,'2026-11-07');assert.equal(s.items.length,0);assert.equal(s.history.length,1);assert.doesNotThrow(()=>validateState(JSON.parse(JSON.stringify(s))));});
test('complete recurrence advances due with one history entry',()=>{const s=state([task({due:'2026-11-07',repeat:'weekly'})]);complete(s,'t',new Date(2026,10,7));assert.equal(s.items[0].due,'2026-11-14');assert.equal(s.history[0].due,'2026-11-07');assert.equal(s.history.length,1);});
test('excluded recurring task occurrence is skipped',()=>{const s=state([task({due:'2026-11-07',repeat:'daily',excluded:['2026-11-07']})]);rollTasks(s,'2026-11-07');assert.equal(s.items[0].due,'2026-11-08');});
test('event includes selected day but not unrelated dates',()=>{assert.ok(eventOn(event(),'2026-11-07'));assert.equal(eventOn(event(),'2026-11-08'),null);});
test('all-day multi-day includes end day via exclusive next midnight',()=>{const e=event({allDay:true,start:'2026-11-07T00:00',end:'2026-11-10T00:00'});assert.ok(eventOn(e,'2026-11-09'));assert.equal(eventOn(e,'2026-11-10'),null);});
test('recurring one-only exception leaves other occurrences',()=>{const e=event({repeat:'weekly',excluded:['2026-11-14']});assert.equal(eventOn(e,'2026-11-14'),null);assert.equal(eventOn(e,'2026-11-21').start,'2026-11-21T12:00');});
test('monthly event uses anchor through short month',()=>{const e=event({repeat:'monthly',start:'2027-01-31T12:00',end:'2027-01-31T13:00',anchorDay:31});assert.ok(eventOn(e,'2027-02-28'));assert.ok(eventOn(e,'2027-03-31'));});
test('date range keeps all three overlapping daily occurrences and legacy lookup picks the newest',()=>{
  const e=Object.freeze(event({start:'2026-12-29T10:00',end:'2027-01-01T10:00',repeat:'daily',excluded:Object.freeze([])}));
  const occurrences=eventOccurrences(e,'2026-12-31','2026-12-31');
  assert.deepEqual(occurrences.map(row=>[row.id,row.occurrence]),[['e','2026-12-29'],['e','2026-12-30'],['e','2026-12-31']]);
  assert.deepEqual(eventOn(e,'2026-12-31'),occurrences[2]);
  assert.deepEqual(eventOccurrence(e,'2026-12-29'),occurrences[0]);
  assert.deepEqual(eventOccurrences(e,'2027-01-01','2027-01-01').map(row=>row.occurrence),['2026-12-29','2026-12-30','2026-12-31','2027-01-01']);
});
test('midnight ends the exclusive interval and exceptions retain their original identity when moved',()=>{
  const e=event({start:'2026-12-31T10:00',end:'2027-01-01T00:00',repeat:'daily',excluded:['2027-01-01']});
  assert.deepEqual(eventOccurrences(e,'2027-01-01','2027-01-01'),[]);
  assert.equal(eventOccurrence(e,'2027-01-01'),null);
  assert.equal(eventOccurrence(e,'2026-12-31').end,'2027-01-01T00:00');
  const moved=event({id:'moved',eventSeriesId:e.id,exceptionDate:'2027-01-01',start:'2027-01-02T11:00',end:'2027-01-02T12:00'});
  const [visible]=eventOccurrences(moved,'2027-01-02','2027-01-02');
  assert.equal(visible.occurrence,'2027-01-02');
  assert.deepEqual(eventOccurrence(moved,moved.exceptionDate),visible);
  assert.equal(eventOccurrence(moved,'2027-01-02'),null);
});
for(const [repeat,base,slot,anchors] of [
  ['weekly','2026-12-28','2027-01-04',{}],
  ['biweekly','2026-12-28','2027-01-11',{}],
  ['monthly','2027-01-31','2027-02-28',{anchorDay:31}],
  ['yearly','2024-02-29','2027-02-28',{anchorDay:29,anchorMonth:2}],
])test(repeat+' resolves the precise recurrence slot at calendar boundaries',()=>{
  const e=event({repeat,start:base+'T10:00',end:base+'T11:00',...anchors});
  const current=eventOccurrence(e,slot);
  assert.equal(current?.start,slot+'T10:00');
  assert.deepEqual(eventOccurrences(e,slot,slot),[current]);
  assert.equal(eventOccurrence(e,addDays(slot,-1)),null);
});
test('visible recurrence range is bounded and can jump from the oldest supported year',()=>{
  const e=event({start:'2000-01-01T12:00',end:'2000-01-01T13:00',repeat:'daily'});
  assert.equal(eventOccurrences(e,'2100-11-20','2100-12-31').length,42);
  assert.throws(()=>eventOccurrences(e,'2100-11-19','2100-12-31'));
});
test('exact all-day recurrence keeps an exclusive local midnight across clock changes',()=>{
  const e=event({start:'2027-03-13T00:00',end:'2027-03-14T00:00',repeat:'daily',allDay:true,excluded:['2027-03-15']});
  const last=eventOccurrence(e,'2027-03-14');
  assert.equal(last.end,'2027-03-15T00:00');
  assert.deepEqual(eventOn(e,'2027-03-14'),last);
  assert.deepEqual(eventOccurrences(e,'2027-03-15','2027-03-15'),[]);
  assert.equal(calendarIndicators([e],['2027-03-15']).get('2027-03-15').hasEvent,false);
});
test('legacy month anchor cannot expose a pre-series slot and later slots still resolve',()=>{
  const e=event({start:'2027-01-31T10:00',end:'2027-02-03T10:00',repeat:'monthly',anchorDay:29,excluded:['2027-01-29']});
  const withoutExclusion={...e,excluded:[]};
  assert.equal(eventOccurrence(withoutExclusion,'2027-01-29'),null);
  assert.equal(eventOn(withoutExclusion,'2027-01-31'),null);
  assert.deepEqual(eventOccurrences(withoutExclusion,'2027-01-31','2027-02-02'),[]);
  const later=eventOccurrence(e,'2027-02-28');
  assert.equal(later?.start,'2027-02-28T10:00');
  assert.deepEqual(eventOccurrences(e,'2027-03-01','2027-03-01'),[later]);
  const moved=event({id:'moved',eventSeriesId:e.id,exceptionDate:'2027-01-29',start:'2027-02-28T09:00',end:'2027-02-28T11:00'});
  assert.doesNotThrow(()=>validateState(state([e,moved])));
  assert.deepEqual(eventOccurrences(moved,'2027-02-28','2027-02-28'),[eventOccurrence(moved,'2027-01-29')]);
});
test('a 366-day occurrence can carry over into a 42-day view, with an exclusive end',()=>{
  const e=event({start:'2026-01-01T00:00',end:'2027-01-02T00:00',repeat:'daily'});
  assert.doesNotThrow(()=>validateItem(e));
  const original=eventOccurrence(e,'2026-01-01');
  assert.deepEqual(eventOccurrences(e,'2026-11-21','2027-01-01')[0],original);
  const afterEnd=eventOccurrences(e,'2027-01-02','2027-02-12');
  assert.equal(afterEnd[0].occurrence,'2026-01-02');
  assert.ok(!afterEnd.some(row=>row.occurrence===original.occurrence));
});
test('range lookup intersects the supported dates and leaves outside cells empty',()=>{
  const early=event({start:'2000-01-01T10:00',end:'2000-01-01T11:00'});
  const late=event({start:'2100-12-31T10:00',end:'2101-01-01T00:00'});
  assert.deepEqual(eventOccurrences(early,'1999-12-27','2000-01-02'),[eventOccurrence(early,'2000-01-01')]);
  assert.deepEqual(eventOccurrences(late,'2100-12-27','2101-01-02'),[eventOccurrence(late,'2100-12-31')]);
  assert.deepEqual(eventOccurrences(early,'1999-12-25','1999-12-31'),[]);
  assert.deepEqual(eventOccurrences(late,'2101-01-01','2101-01-07'),[]);
  assert.equal(eventOccurrence(late,'2101-01-01'),null);
});
test('agenda keeps one read-only copy of a stored legacy event and never resolves it as another slot',()=>{
  const e=event({start:'2100-12-30T00:00',end:'2101-01-01T00:00',allDay:true,repeat:'monthly',anchorDay:29});
  const before=JSON.stringify(e);
  for(const day of ['2100-12-30','2100-12-31']){
    const {rows,next}=agendaPage([e],day);
    assert.equal(next,null);
    assert.deepEqual(rows.map(row=>[row.warning,row.start,row.end]),[['anchor',e.start,e.end]]);
    assert.equal(eventOccurrence(e,'2100-12-30'),null);
    assert.equal(calendarIndicators([e],[day]).get(day).hasEvent,true);
  }
  assert.deepEqual(agendaPage([{...e,excluded:['2100-12-30']}],'2100-12-31').rows,[]);
  assert.equal(JSON.stringify(e),before);
});
test('year-end warnings remain visible on valid continuation days and across agenda pages',()=>{
  const e=event({id:'end-warning',start:'2100-12-23T10:00',end:'2100-12-28T10:00',repeat:'weekly'});
  const day='2100-12-31';
  const warningRows=date=>agendaPage([e],date).rows.map(row=>[row.warning,row.occurrence]);
  assert.deepEqual(warningRows('2100-12-29'),[]);
  assert.deepEqual(warningRows('2100-12-30'),[['end-limit','2100-12-30']]);
  assert.deepEqual(warningRows(day),[['end-limit','2100-12-30']]);
  assert.deepEqual(warningRows('2101-01-01'),[]);
  assert.equal(calendarIndicators([e],['2100-12-29','2100-12-30',day]).get(day).hasEvent,true);
  assert.equal(eventOccurrence(e,'2100-12-30'),null);
  assert.throws(()=>deletionPlan(state([e]),e.id,'one','2100-12-30'));

  const early=Array.from({length:51},(_,i)=>event({id:'early-'+i,start:'2100-12-29T10:00',end:day+'T12:00'}));
  const midnight=event({id:'midnight',start:'2100-12-30T10:00',end:day+'T00:00'});
  const late=event({id:'late',start:day+'T14:00',end:day+'T15:00'});
  const items=[e,...early,midnight,late],before=JSON.stringify(items);
  const first=agendaPage(items,day),last=agendaPage(items,day,first.next);
  assert.equal(first.rows.length,50);
  assert.deepEqual(last.rows.slice(1).map(row=>[row.id,row.warning]),[[e.id,'end-limit'],['late',undefined]]);
  assert.ok(last.rows[0].id.startsWith('early-'));
  assert.equal(last.next,null);
  const ids=[...first.rows,...last.rows].map(row=>row.id);
  assert.equal(new Set(ids).size,53);
  assert.ok(!ids.includes(midnight.id));
  assert.equal(JSON.stringify(items),before);
});
test('Apia skipped date never folds into the December 31 event slot or its page boundary',()=>{
  if(process.env.TZ!=='Pacific/Apia'){
    const child=spawnSync(process.execPath,['--test','--test-name-pattern','Apia skipped date',fileURLToPath(import.meta.url)],
      {env:{...process.env,TZ:'Pacific/Apia'},encoding:'utf8'});
    assert.equal(child.status,0,child.stdout+child.stderr);
    return;
  }
  const start='2011-12-29',missing='2011-12-30',last='2011-12-31';
  const makeDaily=id=>event({id,start:start+'T10:00',end:start+'T11:00',repeat:'daily'});
  const items=Array.from({length:51},(_,i)=>makeDaily(String(i).padStart(3,'0'))).reverse();
  const original=items[0];
  assert.deepEqual(eventOccurrences(original,start,last).map(row=>row.occurrence),[start,last]);
  assert.equal(eventOccurrence(original,missing),null);
  assert.equal(eventOccurrence(original,last).start,last+'T10:00');
  assert.deepEqual(agendaPage(items,missing),{rows:[],next:null});
  const first=agendaPage(items,last),next=agendaPage(items,last,first.next);
  assert.equal(first.rows.length,50);
  assert.deepEqual(next.rows.map(row=>[row.id,row.occurrence]),[[original.id,last]]);
  assert.equal(next.next,null);
  assert.equal(new Set([...first.rows,...next.rows].map(row=>row.id+' '+row.occurrence)).size,51);
  const copy=state(structuredClone(items));
  assert.throws(()=>removeItem(copy,original.id,'one',missing));
  assert.equal(deletionPlan(copy,original.id,'one',last).occurrence,last);
  removeItem(copy,original.id,'one',last);
  const remaining=copy.items.find(item=>item.id===original.id);
  assert.ok(eventOccurrence(remaining,start));
  assert.equal(eventOccurrence(remaining,last),null);
  assert.deepEqual(original.excluded,[]);

  // A coarser interval may hit the missing date without another nominal slot on the 31st.
  for(const [repeat,base] of [['weekly','2011-12-23'],['biweekly','2011-12-16'],['monthly','2011-11-30'],['yearly','2010-12-30']]){
    const e=event({start:base+'T10:00',end:base+'T11:00',repeat});
    assert.deepEqual(eventOccurrences(e,start,last),[]);
    assert.equal(eventOccurrence(e,last),null);
  }
});
test('New York spring gap and fall rollback are never silently normalized into editable instances',()=>{
    if(process.env.TZ!=='America/New_York'){
      const child=spawnSync(process.execPath,['--test','--test-name-pattern','New York spring gap',fileURLToPath(import.meta.url)],
        {env:{...process.env,TZ:'America/New_York'},encoding:'utf8'});
      assert.equal(child.status,0,child.stdout+child.stderr);
      return;
    }
    const spring=event({start:'2027-03-13T02:30',end:'2027-03-13T03:30',repeat:'daily'});
    assert.equal(eventOccurrence(spring,'2027-03-13').start,'2027-03-13T02:30');
    assert.equal(eventOccurrence(spring,'2027-03-14'),null);
    assert.deepEqual(agendaPage([spring],'2027-03-14').rows.map(row=>[row.warning,row.start,row.storedStart]),
      [['clock','2027-03-14T02:30',spring.start]]);
    assert.equal(eventOccurrence(spring,'2027-03-15').start,'2027-03-15T02:30');
    const longGap={...spring,end:'2027-03-15T03:30'};
    assert.ok(!agendaPage([longGap],'2027-03-15').rows.some(row=>row.occurrence==='2027-03-14'));
    const fall=event({start:'2027-11-06T01:30',end:'2027-11-06T02:00',repeat:'daily'});
    assert.equal(eventOccurrence(fall,'2027-11-07'),null);
    assert.equal(agendaPage([fall],'2027-11-07').rows[0].warning,'clock');
    assert.equal(eventOccurrence(fall,'2027-11-08').end,'2027-11-08T02:00');
    const repeatedHour={...fall,end:'2027-11-06T01:45'};
    assert.equal(eventOccurrence(repeatedHour,'2027-11-07'),null);
    assert.equal(agendaPage([repeatedHour],'2027-11-07').rows[0].warning,'clock');
});
for(const count of [50,51,161])test('agenda paginates '+count+' equal-time events in stable ID order',()=>{
  const items=Array.from({length:count},(_,i)=>event({id:String(i).padStart(3,'0')})).reverse();
  const day='2026-11-07',first=agendaPage(items,day),ids=[];
  let page=first;
  for(;;){
    assert.ok(page.rows.length<=50);
    ids.push(...page.rows.map(row=>row.id));
    if(!page.next)break;
    page=agendaPage(items,day,page.next);
  }
  assert.equal(first.rows.length,50);
  assert.deepEqual(ids,items.map(item=>item.id).reverse());
});
test('maximum-size daily agenda begins at the oldest overlap and can jump to its final page',()=>{
  const items=Array.from({length:1000},(_,i)=>event({id:String(i).padStart(4,'0'),repeat:'daily',
    start:'2026-01-01T00:00',end:'2027-01-02T00:00'}));
  const first=agendaPage(items,'2027-01-01'),second=agendaPage(items,'2027-01-01',first.next);
  assert.equal(first.rows.length,50);
  assert.equal(first.rows[0].occurrence,'2026-01-01');
  assert.equal(second.rows[0].id,'0050');
  const last=agendaPage(items,'2027-01-01',{start:'2027-01-01T00:00',id:'0979'});
  assert.equal(last.rows.length,20);
  assert.equal(last.rows[0].id,'0980');
  assert.equal(last.next,null);
});
test('seed and JSON save/load satisfy schema',()=>{const s=seed('2026-11-07');assert.doesNotThrow(()=>validateState(JSON.parse(JSON.stringify(s))));assert.equal(dateKey(new Date(2026,10,7)),'2026-11-07');assert.equal(addDays('2026-12-31',1),'2027-01-01');});
