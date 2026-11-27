import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {agendaPage,calendarSummary,calendarSummaryAsync,createCalendarSummaryRequests,eventOccurrence,serializeState} from '../src/model.js';

const event=(id,start,end,changes={})=>({id,type:'event',title:'架空の予定 '+id,start,end,repeat:'none',excluded:[],allDay:false,...changes});
const task=(id,due)=>({id,type:'task',title:'架空のタスク '+id,due,pinned:false,repeat:'none',excluded:[]});
const ids=day=>day.top.map(entry=>entry.id);

test('week and month grids retain nominal dates and disable cells outside the supported limits',()=>{
  for(const [length,last] of [[7,'2027-02-07'],[28,'2027-02-28'],[35,'2027-03-07'],[42,'2027-03-14']]){
    const result=calendarSummary([],'2027-02-01',last);
    assert.equal(result.days.length,length);
    assert.ok(result.days.every(day=>day.enabled&&day.totalCount===0&&day.hiddenCount===0&&!day.hasWarning&&!day.top.length));
    assert.deepEqual(result.bars,[]);
  }
  assert.throws(()=>calendarSummary([],'2027-02-01','2027-03-15'));
  assert.throws(()=>calendarSummary([],'2027-02-29','2027-03-02'));
  const first=event('first','2000-01-01T10:00','2000-01-01T11:00');
  const begin=calendarSummary([first],'1999-12-27','2000-01-02').days;
  assert.ok(begin.slice(0,5).every(day=>!day.enabled&&day.totalCount===0));
  assert.deepEqual(ids(begin[5]),['first']);
  const last=event('last','2100-12-31T10:00','2101-01-01T00:00');
  const end=calendarSummary([last],'2100-12-27','2101-01-02').days;
  assert.deepEqual(ids(end[4]),['last']);
  assert.ok(end.slice(5).every(day=>!day.enabled&&day.totalCount===0));
});

test('day counts retain only the two highest priorities and stable ties',()=>{
  const title='<img src=x onerror=alert(1)>&「架空」'.repeat(4);
  const items=[
    task('undated',null),
    event('all','2026-12-31T00:00','2027-01-01T00:00',{allDay:true}),
    task('deadline','2026-12-31'),task('task-a','2027-01-02'),task('task-b','2027-01-02'),
    event('late','2026-12-31T11:00','2026-12-31T12:00'),
    event('z','2026-12-31T09:00','2026-12-31T10:00'),
    event('a','2026-12-31T09:00','2026-12-31T10:00',{title}),
    event('span','2026-12-30T16:00','2027-01-01T00:00'),
    event('only','2027-01-01T00:00','2027-01-02T00:00',{allDay:true}),
    event('all-later','2027-01-02T00:00','2027-01-03T00:00',{allDay:true}),
  ];
  const {days}=calendarSummary(items,'2026-12-30','2027-01-05');
  assert.deepEqual(days.slice(0,5).map(day=>[day.totalCount,day.hiddenCount,ids(day)]),[
    [1,0,['span']],[6,4,['span','a']],[1,0,['only']],[3,1,['task-a','task-b']],[0,0,[]],
  ]);
  assert.equal(days[1].top[1].title,title);
  assert.deepEqual(calendarSummary(items.slice().reverse(),'2026-12-30','2027-01-05'),calendarSummary(items,'2026-12-30','2027-01-05'));
  assert.equal(calendarSummary(items.filter(item=>item.id!=='span'),'2026-12-31','2026-12-31').days[0].top[1].id,'z');
  assert.deepEqual(ids(calendarSummary(items.filter(item=>!['span','a','z','late'].includes(item.id)),'2026-12-31','2026-12-31').days[0]),['deadline','all']);
  assert.equal(days[1].hasEvent,true);
  assert.equal(days[1].hasTask,true); // The deadline is below two visible events.
  assert.ok(days[4].hasEvent===false&&days[4].hasTask===false);
});

test('sharing matches isolated projections when any scheduling field differs',()=>{
  const cases=[
    [event('base','2027-01-31T00:00','2027-02-01T00:00',{repeat:'monthly',anchorDay:31}),[
      {start:'2027-01-31T01:00'}, {end:'2027-02-01T01:00'}, {anchorDay:28},
      {excluded:['2027-02-28']}, {allDay:true},
    ]],
    [event('base','2027-02-01T00:00','2027-02-02T00:00',{eventSeriesId:'root',exceptionDate:'2027-01-29'}),[
      {exceptionDate:'2027-01-30'},
    ]],
  ];
  const priority={'multi-day':0,timed:1,task:2,'all-day':3};
  for(const [base,variants] of cases)for(const changes of variants){
    const items=[{...base,id:'y',title:'架空y'},{...base,...changes,id:'z',title:'架空z'},{...base,id:'a',title:'架空a'}];
    const first='2027-01-30',last='2027-03-04';
    const isolated=items.map(item=>calendarSummary([item],first,last).days);
    const combined=calendarSummary(items,first,last);
    for(const [index,day] of combined.days.entries()){
      const separate=isolated.map(days=>days[index]);
      const expected=separate.flatMap(result=>result.top).sort((a,b)=>priority[a.kind]-priority[b.kind]||
        a.start.localeCompare(b.start)||a.occurrenceDate.localeCompare(b.occurrenceDate)||a.id.localeCompare(b.id));
      assert.equal(day.totalCount,separate.reduce((count,result)=>count+result.totalCount,0));
      assert.deepEqual(day.top,expected.slice(0,2));
      assert.equal(day.hasWarning,separate.some(result=>result.hasWarning));
    }
  }
});

test('time-sliced summary yields to timers and matches the synchronous result exactly',async()=>{
  const items=Array.from({length:64},(_,i)=>event(String(i),
    '2026-01-01T00:'+String(i%60).padStart(2,'0'),'2027-01-02T00:'+String(i%60).padStart(2,'0'),{repeat:'daily'}));
  items.push(task('hidden-task','2027-01-02'));
  const bounds=['2027-01-01','2027-02-11'];
  const expected=calendarSummary(items,...bounds);
  let timerTurns=0;
  const timer=setInterval(()=>timerTurns++,0);
  try{
    assert.deepEqual(await calendarSummaryAsync(items,...bounds,{sliceMs:2}),expected);
    assert.ok(timerTurns>1);
  }finally{clearInterval(timer);}
  const controller=new AbortController();
  const pending=calendarSummaryAsync(items,...bounds,{signal:controller.signal});
  controller.abort();await assert.rejects(pending,{name:'AbortError'});
});

test('calendar requests reuse matching results and discard completions after a range, revision or timezone change',async()=>{
  const jobs=[];let updates=0;
  const requests=createCalendarSummaryRequests(()=>updates++,(_items,first,last,{signal})=>
    new Promise(resolve=>jobs.push({first,last,signal,resolve})));
  const week=['2027-02-01','2027-02-07'],month=['2027-02-01','2027-02-28'];
  const read=(bounds,revision=1,zone='Asia/Tokyo')=>requests.request([], ...bounds,revision,zone);
  assert.equal(read(week).status,'loading');assert.equal(read(week).status,'loading');
  assert.equal(jobs.length,1);
  read(month);assert.equal(jobs[0].signal.aborted,true);
  jobs[1].resolve('month');await Promise.resolve();
  jobs[0].resolve('stale week');await Promise.resolve();
  assert.equal(read(month).result,'month');assert.equal(updates,1);
  read(week);jobs[2].resolve('week');await Promise.resolve();
  assert.equal(read(month).result,'month');assert.equal(jobs.length,3);
  assert.equal(read(month,2).status,'loading');
  assert.equal(read(month,2,'Pacific/Apia').status,'loading');
  assert.equal(jobs[3].signal.aborted,true);
  requests.cancel(true);jobs[4].resolve('after access failure');await Promise.resolve();
  assert.equal(updates,2);
  assert.equal(read(week,2,'Pacific/Apia').status,'loading');
});

test('multi-day candidates span year and week boundaries without losing contiguous bar segments',()=>{
  const items=[
    event('A','2026-12-27T12:00','2027-01-03T00:00'),
    event('B','2026-12-30T12:00','2027-01-05T00:00'),
    event('C','2026-12-31T12:00','2027-01-06T00:00'),
  ];
  const {days,bars}=calendarSummary(items,'2026-12-28','2027-01-10');
  assert.deepEqual(ids(days[3]),['A','B']);
  assert.equal(days[3].hiddenCount,1);
  assert.deepEqual(ids(days[6]),['B','C']);
  assert.deepEqual(ids(days[8]),['C']);
  assert.deepEqual(bars.map(bar=>[bar.entry.id,bar.weekStart,bar.firstDay,bar.lastDay,bar.firstColumn,bar.lastColumn]),[
    ['A','2026-12-28','2026-12-28','2027-01-02',0,5],
    ['B','2026-12-28','2026-12-30','2027-01-03',2,6],
    ['C','2026-12-28','2027-01-03','2027-01-03',6,6],
    ['B','2027-01-04','2027-01-04','2027-01-04',0,0],
    ['C','2027-01-04','2027-01-04','2027-01-05',0,1],
  ]);
});

test('daily totals agree with the agenda through overlapping slots, moved exceptions and warning rows',()=>{
  const series=event('series','2100-12-24T10:00','2100-12-27T10:00',
    {repeat:'daily',eventSeriesId:'series',excluded:['2100-12-26']});
  const moved=event('moved','2100-12-28T10:00','2100-12-29T12:00',
    {eventSeriesId:'series',exceptionDate:'2100-12-26'});
  const old=event('old','2100-12-30T00:00','2101-01-01T00:00',{allDay:true,repeat:'monthly',anchorDay:29});
  const dated=task('due','2100-12-29'),items=[series,moved,old,dated,task('undated',null)];
  const state={version:1,items,history:[{id:'complete',title:'完了済み',due:'2100-12-29',completedAt:'2100-12-20T00:00:00.000Z'}]};
  const before=serializeState(state);
  const {days}=calendarSummary(items,'2100-12-25','2100-12-31');
  for(const day of days){
    const {rows,next}=agendaPage(items,day.date);
    assert.equal(next,null);
    assert.equal(day.totalCount,rows.length+Number(dated.due===day.date));
    assert.equal(day.hasWarning,rows.some(row=>row.warning!==undefined));
    assert.ok(rows.every(row=>row.exceptionDate!=='2100-12-26'||row.id==='moved'));
    const ordered=rows.map(row=>{
      const endDay=row.end.endsWith('T00:00')?row.end.slice(0,10):null;
      const dayAfterStart=new Date(row.start.slice(0,10)+'T00:00Z');
      dayAfterStart.setUTCDate(dayAfterStart.getUTCDate()+1);
      const multi=row.warning!=='clock'&&(endDay?endDay>dayAfterStart.toISOString().slice(0,10):row.end.slice(0,10)>row.start.slice(0,10));
      return [multi?0:row.allDay?3:1,row.start,row.exceptionDate??row.occurrence,row.id];
    });
    if(dated.due===day.date)ordered.push([2,day.date+'T00:00','',dated.id]);
    ordered.sort((a,b)=>a[0]-b[0]||a[1].localeCompare(b[1])||a[2].localeCompare(b[2])||a[3].localeCompare(b[3]));
    assert.deepEqual(day.top.map(entry=>[entry.occurrenceDate??'',entry.id]),ordered.slice(0,2).map(entry=>[entry[2],entry[3]]));
  }
  assert.ok(!agendaPage(items,'2100-12-28').rows.some(row=>row.id==='series'&&row.occurrence==='2100-12-26'));
  const exception=calendarSummary([moved],'2100-12-29','2100-12-29').days[0].top[0];
  assert.equal(exception.occurrenceDate,'2100-12-26');
  assert.equal(eventOccurrence(moved,exception.occurrenceDate).start,exception.start);
  assert.ok(days.at(-1).hasWarning);
  assert.equal(serializeState(state),before);
});

test('a warning behind the agenda page boundary still sets the day flag',()=>{
  const series=event('edge','2100-12-23T10:00','2100-12-28T10:00',{repeat:'weekly'});
  const normal=Array.from({length:51},(_,i)=>event('normal-'+i,'2100-12-29T10:00','2100-12-31T12:00'));
  const items=[series,...normal],result=calendarSummary(items,'2100-12-29','2100-12-31');
  assert.ok(agendaPage(items,'2100-12-31').rows.every(row=>!row.warning));
  assert.deepEqual(result.days.map(day=>[day.totalCount,day.hiddenCount,day.hasWarning]),[[51,49,false],[52,50,true],[52,50,true]]);
  const warning=calendarSummary([series],'2100-12-31','2100-12-31').days[0].top[0];
  assert.equal(warning.warning,'end-limit');
  assert.equal(warning.occurrenceDate,'2100-12-30');
  assert.equal(eventOccurrence(series,warning.occurrenceDate),null);
});

function inTimezone(name,pattern){
  if(process.env.TZ===name)return false;
  const result=spawnSync(process.execPath,['--test','--test-name-pattern',pattern,fileURLToPath(import.meta.url)],
    {env:{...process.env,TZ:name},encoding:'utf8'});
  assert.equal(result.status,0,result.stdout+result.stderr);
  return true;
}
test('calendar summary flags New York clock warnings without inventing durations',()=>{
  if(inTimezone('America/New_York','calendar summary flags New York'))return;
  for(const [start,end,day] of [
    ['2027-03-13T02:30','2027-03-13T03:30','2027-03-14'],
    ['2027-11-06T01:30','2027-11-06T01:45','2027-11-07'],
  ]){
    const e=event('clock',start,end,{repeat:'daily'});
    const {days,bars}=calendarSummary([e],day,day);
    const [entry]=days[0].top;
    assert.equal(days[0].totalCount,1);
    assert.equal(days[0].hasWarning,true);
    assert.equal(entry.warning,'clock');
    assert.equal(entry.end,null);
    assert.equal(entry.storedStart,start);
    assert.equal(eventOccurrence(e,entry.occurrenceDate),null);
    assert.deepEqual(bars,[]);
  }
});
test('calendar summary keeps the skipped Apia date disabled between actual dates',()=>{
  if(inTimezone('Pacific/Apia','calendar summary keeps the skipped Apia'))return;
  const e=event('daily','2011-12-29T10:00','2011-12-29T11:00',{repeat:'daily'});
  const {days}=calendarSummary([e],'2011-12-29','2011-12-31');
  assert.deepEqual(days.map(day=>[day.date,day.enabled,day.totalCount]),[
    ['2011-12-29',true,1],['2011-12-30',false,0],['2011-12-31',true,1],
  ]);
  assert.equal(days[2].top[0].occurrenceDate,'2011-12-31');
  assert.deepEqual(calendarSummary([e],'2011-12-30','2011-12-30').days[0].top,[]);
});

test('a 42-day maximum overlap has exact counts and a bounded result',()=>{
  const items=Array.from({length:1000},(_,i)=>event(String(i).padStart(4,'0'),
    '2026-01-01T00:00','2027-01-02T00:00',{repeat:'daily'}));
  const {days,bars}=calendarSummary(items,'2027-01-01','2027-02-11');
  assert.equal(days.length,42);
  for(const day of days){
    assert.equal(day.totalCount,366000);
    assert.equal(day.hiddenCount,365998);
    assert.deepEqual(ids(day),['0000','0001']);
    assert.equal(day.hasWarning,false);
  }
  assert.ok(bars.length<=84);
});
