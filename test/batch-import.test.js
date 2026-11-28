import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {createBatchImporter,parseBatchImport} from '../src/batch-import.js';
import {LIMITS,STORAGE_KEY,complete,serializeState} from '../src/model.js';
import {LOCK_NAME,META_KEY,ScheduleStore} from '../src/storage.js';

const task=(title='架空タスク',due=null,repeat='none')=>({type:'task',title,due,repeat});
const dated=(start,end,title='架空の時間指定',repeat='none')=>({type:'event',title,allDay:false,start,end,repeat});
const dayEvent=(startDate,endDate,title='架空の終日')=>({type:'event',title,allDay:true,startDate,endDate,repeat:'none'});
const scheduledTask=(id,title='保存済みのタスク',due=null,repeat='none')=>({...task(title,due,repeat),id,pinned:false,excluded:[]});
const empty=()=>({version:1,items:[],history:[]});
const json=items=>JSON.stringify({format:'my-schedule-import',formatVersion:1,items},null,2);
const parse=items=>parseBatchImport(json(items));

async function setup(initial=empty(),day='2027-02-18'){
  const before=serializeState(initial),map=new Map([[STORAGE_KEY,before]]);
  const calls={writes:[],mutations:0,locks:[]},hooks={};
  const storage={
    getItem(key){if(key===STORAGE_KEY&&hooks.unreadable)throw Error('fictional readback failure');return map.get(key)??null;},
    setItem(key,value){
      if(key===STORAGE_KEY&&hooks.quota)throw new DOMException('fictional quota','QuotaExceededError');
      calls.writes.push(key);map.set(key,value);
      if(key===STORAGE_KEY&&hooks.failReadback)hooks.unreadable=true;
    },
  };
  const locks={async request(name,options,fn){
    calls.locks.push([name,options.mode]);
    if(hooks.beforeLock)await hooks.beforeLock();
    return fn();
  }};
  const store=new ScheduleStore({storage,locks});
  await store.refresh();
  const mutate=store.mutate.bind(store);
  store.mutate=(...args)=>{calls.mutations++;return mutate(...args);};
  const importer=createBatchImporter(store,{today:()=>day});
  return {store,importer,calls,hooks,map,before,setDay(value){day=value;}};
}

test('strict envelope, original order and source lines including escaped keys and CRLF',()=>{
  const text=' {\r\n  "formatVersion":1,\r\n  "it\\u0065ms":[\r\n    '+JSON.stringify(task())+
    ',\r\n    '+JSON.stringify(task('another'))+'],\r\n "format":"my-schedule-import"\r\n}';
  const rows=parseBatchImport(text);
  assert.deepEqual(rows.map(({index,line,input})=>[index,line,input.title]),[[0,4,'架空タスク'],[1,5,'another']]);
  for(const input of [
    '{"format":"my-schedule-backup","formatVersion":1,"items":[{}]}',
    '{"format":"my-schedule-import","formatVersion":2,"items":[{}]}',
    '{"format":"my-schedule-import","formatVersion":1,"items":[{}],"history":[]}',
    'null',
  ])assert.throws(()=>parseBatchImport(input),{code:'format'});
  for(const input of ['', '\uFEFF'+text, text+'{}', text.replace('Version":1','Version":01'),
    text.replace('another','bad\\q'),text.replace('another','raw\nnewline')])
    assert.throws(()=>parseBatchImport(input),{code:'json'});
});

test('rejects duplicate decoded keys and dangerous keys at every object level',()=>{
  const wrap=row=>'{"format":"my-schedule-import","formatVersion":1,"items":['+row+']}';
  for(const input of [wrap('{"title":"a","title":"b"}'),wrap('{"title":"a","\\u0074itle":"b"}'),
    wrap('{"x":{"a":1,"\\u0061":2}}'),wrap('{}').replace('"items":','"items":[],"items":')])
    assert.throws(()=>parseBatchImport(input),{code:'duplicate-key'});
  for(const key of ['__proto__','constructor','prototype','\\u005f_proto__']){
    assert.throws(()=>parseBatchImport(wrap('{"'+key+'":{}}')),{code:'key'});
    assert.throws(()=>parseBatchImport(wrap('{"other":{"'+key+'":0}}')),{code:'key'});
  }
  assert.equal(parse([task('title: __proto__ constructor prototype')]).length,1);
});

test('byte, row and depth limits are inclusive at the boundary',()=>{
  const content=json([task('日本語')]),bytes=new TextEncoder().encode(content).byteLength;
  const limit=128*1024;
  const exact=content+' '.repeat(limit-bytes);
  assert.equal(parseBatchImport(exact).length,1);
  assert.ok((exact+' ').length<=limit);
  assert.throws(()=>parseBatchImport(exact+' '),{code:'size'});
  assert.throws(()=>parseBatchImport(' '.repeat(limit+1)),{code:'size'});
  assert.equal(parse(Array.from({length:100},()=>task())).length,100);
  assert.throws(()=>parse(Array.from({length:101},()=>task())),{code:'count'});
  assert.throws(()=>parse([]),{code:'count'});
  assert.equal(parse([{a:{b:5}}]).length,1);
  for(const item of [{a:{b:{c:5}}},[[[0]]]])assert.throws(()=>parse([item]),{code:'depth'});
});

test('normalizes four kinds, preserves literal titles, and appends all rows in one mutation',async()=>{
  const f=await setup();
  const literal='<img src="x" onerror="alert(1)"> \\ { }　constructor';
  const rows=parse([
    dated('2027-02-18T10:07','2027-02-18T10:43','  '+literal+'  '),
    dayEvent('2028-02-29','2028-02-29'),task('期限あり','2027-03-01'),task('期限なし'),
  ]);
  const plan=f.importer.prepare(rows);
  assert.deepEqual(plan.rows.map(({index,line})=>[index,line]),rows.map(({index,line})=>[index,line]));
  assert.deepEqual(plan.errors,[]);
  assert.deepEqual(plan.rows.map(({item})=>[item.title,item.start,item.end,item.due]),[
    [literal,'2027-02-18T10:07','2027-02-18T10:43',undefined],
    ['架空の終日','2028-02-29T00:00','2028-03-01T00:00',undefined],
    ['期限あり',undefined,undefined,'2027-03-01'],['期限なし',undefined,undefined,null],
  ]);
  assert.equal(new Set(plan.rows.map(row=>row.item.id)).size,4);
  assert.throws(()=>{plan.rows[0].item.title='changed';},TypeError);
  rows[0].input.title='別の未確認タイトル';
  assert.equal(f.map.get(STORAGE_KEY),f.before);
  assert.deepEqual(f.calls.writes,[]);
  const result=await f.importer.save(plan);
  assert.equal(result.verified,true);
  assert.equal(result.count,4);
  assert.equal(f.calls.mutations,1);
  assert.deepEqual(f.calls.writes,[STORAGE_KEY,META_KEY]);
  assert.deepEqual(f.calls.locks,[[LOCK_NAME,'exclusive'],[LOCK_NAME,'exclusive']]);
  assert.deepEqual(f.store.state.items,plan.rows.map(row=>row.item));
});

test('reports invalid rows and blocks the whole plan until edits are prepared again',async()=>{
  const f=await setup();
  const rows=parse([
    task('正常'),null,[],task(' '),task('x'.repeat(161)),
    task('繰り返し期限なし',null,'daily'),task('期限なしを省略'),task('未知の反復',null,'sometimes'),
    {...task(),id:'external'}, {...task(),excluded:[]}, {...task(),notification:{enabled:false}},
    {...task(),exceptionDate:'2027-01-01'}, {...task(),history:[]}, {...task(),unrelated:true},
    {...dated('2027-02-18T10:00','2027-02-18T11:00'),endDate:'2027-02-18'},
  ]);
  delete rows[6].input.due;
  const plan=f.importer.prepare(rows);
  assert.equal(plan.rows[0].error,undefined);
  assert.deepEqual(plan.rows.slice(1).map(row=>row.error.code),
    ['item','item','title','title','repeat','required','repeat',...Array(7).fill('key')]);
  assert.equal(plan.rows[6].error.field,'due');
  assert.equal(plan.rows[6].line,rows[6].line);
  assert.equal((await f.importer.save(plan)).reason,'validation');
  assert.equal(f.calls.mutations,0);
  assert.equal(f.map.get(STORAGE_KEY),f.before);
  const revised=f.importer.prepare([{...rows[3],input:task('x'.repeat(160))}]);
  assert.equal(revised.rows[0].line,rows[3].line);
  assert.equal((await f.importer.save(plan)).reason,'stale');
  assert.equal((await f.importer.save(revised)).count,1);
});

test('reports multiple field errors without integrating any invalid row',async()=>{
  const f=await setup();
  const rows=parse([task('','2026-02-30','sometimes'),
    dated('2026-02-30T10:00','2026-02-30T11:00','')]);
  const plan=f.importer.prepare(rows);
  assert.deepEqual(plan.rows.map(row=>row.errors.map(error=>error.field)),
    [['title','repeat','due'],['title','start','end']]);
  assert.ok(plan.rows.every(row=>!row.item));
  assert.equal((await f.importer.save(plan)).reason,'validation');
  assert.equal(f.calls.mutations,0);
  assert.equal(f.map.get(STORAGE_KEY),f.before);
});

test('preserves recurrence rules and rolls only new recurring tasks from original anchors',async()=>{
  const initial=empty();
  initial.items.push(scheduledTask('old','既存の過去期限','2026-01-01','daily'));
  const f=await setup(initial);
  const repeats=['none','daily','weekly','biweekly','monthly','yearly'];
  const plan=f.importer.prepare(parse(repeats.map(repeat=>task(repeat,'2027-01-31',repeat)).concat(
    task('将来期限','2027-03-05','daily'),task('うるう日','2024-02-29','yearly'),
    ...repeats.map(repeat=>dated('2027-01-31T11:00','2027-01-31T12:00',repeat,repeat)),
  )));
  assert.ok(plan.rows.every(row=>!row.error));
  assert.deepEqual(plan.rows.slice(0,6).map(row=>row.registeredDue),
    ['2027-01-31','2027-02-18','2027-02-21','2027-02-28','2027-02-28','2028-01-31']);
  assert.ok(plan.rows.slice(0,6).every(row=>row.originalDue==='2027-01-31'));
  assert.equal(plan.rows[4].item.anchorDay,31);
  assert.equal(plan.rows[4].item.anchorMonth,1);
  assert.equal(plan.rows[6].registeredDue,plan.rows[6].originalDue);
  assert.equal(plan.rows[7].registeredDue,'2027-02-28');
  assert.equal(plan.rows[7].item.anchorDay,29);
  assert.deepEqual(plan.rows.slice(8).map(row=>row.item.repeat),repeats);
  assert.equal((await f.importer.save(plan)).count,14);
  assert.deepEqual(f.store.state.items[0],initial.items[0]);
});

test('rejects impossible dates and invalid times and handles year-end boundaries',async()=>{
  const f=await setup();
  const plan=f.importer.prepare(parse([
    dayEvent('2027-02-29','2027-03-01'),task('無効期限','2027-04-31'),
    dated('2027-02-30T10:00','2027-03-03T11:00'),dated('2027-02-18T11:00','2027-02-18T10:00'),
    dayEvent('2027-02-18','2027-02-17'),dayEvent('1999-12-31','2000-01-01'),
    dated('2027-01-01T10:00','2028-01-03T10:00'),
    dated('2027-02-18T10:00Z','2027-02-18T11:00'),dated('2027-02-18T10:00:00','2027-02-18T11:00'),
    dated('2027-02-18T10:00+09:00','2027-02-18T11:00'),
    dated('2100-12-31T23:59','2101-01-01T00:01'),
    dayEvent('2026-12-31','2027-01-02'),dayEvent('2100-12-31','2100-12-31'),
    dated('2100-12-31T23:59','2101-01-01T00:00'),dayEvent('2000-01-01','2000-01-01'),
    dated('2027-01-01T10:00','2028-01-02T10:00'),
  ]));
  assert.ok(plan.rows.slice(0,11).every(row=>row.error));
  assert.deepEqual(plan.rows.slice(11).map(row=>row.item?.end),[
    '2027-01-03T00:00','2101-01-01T00:00','2101-01-01T00:00','2000-01-02T00:00','2028-01-02T10:00',
  ]);
});

test('rejects a nonexistent local DST timestamp',async()=>{
  if(process.env.TZ!=='America/New_York'){
    const result=spawnSync(process.execPath,['--test','--test-name-pattern','nonexistent local DST',fileURLToPath(import.meta.url)],
      {env:{...process.env,TZ:'America/New_York'},encoding:'utf8'});
    assert.equal(result.status,0,result.stdout+result.stderr);return;
  }
  const {importer}=await setup();
  const plan=importer.prepare(parse([
    dated('2027-03-14T02:30','2027-03-14T04:00'),dated('2027-03-14T01:30','2027-03-14T02:30'),
    dated('2027-03-13T02:30','2027-03-13T04:00'),dated('2027-03-14T03:30','2027-03-14T04:00'),
  ]));
  assert.deepEqual(plan.rows.map(row=>Boolean(row.error)),[true,true,false,false]);
});

test('Apia task import and completion skip the missing day without shifting cadence',async()=>{
  if(process.env.TZ!=='Pacific/Apia'){
    const result=spawnSync(process.execPath,['--test','--test-name-pattern','Apia task import',fileURLToPath(import.meta.url)],
      {env:{...process.env,TZ:'Pacific/Apia'},encoding:'utf8'});
    assert.equal(result.status,0,result.stdout+result.stderr);return;
  }
  const existing=scheduledTask('existing','既存の繰り返し','2011-12-23','weekly');
  const initial={...empty(),items:[existing]};
  const f=await setup(initial,'2011-12-31');
  const cases=[
    ['daily','2011-12-29','2011-12-31','2012-01-01'],
    ['weekly','2011-12-23','2012-01-06','2012-01-13'],
    ['biweekly','2011-12-16','2012-01-13','2012-01-27'],
    ['monthly','2011-11-30','2012-01-30','2012-02-29'],
    ['yearly','2010-12-30','2012-12-30','2013-12-30'],
  ];
  const plan=f.importer.prepare(parse(cases.map(([repeat,due])=>task(repeat,due,repeat))));
  assert.deepEqual(plan.rows.map(row=>[row.originalDue,row.registeredDue,row.noNext]),
    cases.map(([,original,due])=>[original,due,false]));
  assert.equal(f.map.get(STORAGE_KEY),f.before);
  assert.equal((await f.importer.save(plan)).count,5);
  const saved=JSON.parse(f.map.get(STORAGE_KEY));
  assert.deepEqual(saved,{...initial,items:[existing,...plan.rows.map(row=>row.item)]});
  for(const [index,row] of plan.rows.entries()){
    const draft=structuredClone(saved);
    const now=new Date(row.registeredDue+'T12:00:00');
    complete(draft,row.item.id,now);
    assert.equal(draft.items.find(item=>item.id===row.item.id).due,cases[index][3]);
    assert.equal(draft.history[0].due,row.registeredDue);
  }
  assert.deepEqual(JSON.parse(f.map.get(STORAGE_KEY)).items[0],existing);
  const throughGap=structuredClone(initial);
  complete(throughGap,existing.id,new Date('2011-12-23T12:00:00'));
  assert.equal(throughGap.items[0].due,'2012-01-06');
  assert.equal(throughGap.history[0].due,'2011-12-23');
});

test('New York repeating task dates retain their cadence across both DST transitions',async()=>{
  if(process.env.TZ!=='America/New_York'){
    const result=spawnSync(process.execPath,['--test','--test-name-pattern','New York repeating task dates',fileURLToPath(import.meta.url)],
      {env:{...process.env,TZ:'America/New_York'},encoding:'utf8'});
    assert.equal(result.status,0,result.stdout+result.stderr);return;
  }
  for(const [base,today,expected,following] of [
    ['2027-03-07','2027-03-14','2027-03-14','2027-03-21'],
    ['2027-10-31','2027-11-07','2027-11-07','2027-11-14'],
  ]){
    const f=await setup(empty(),today);
    const plan=f.importer.prepare(parse([task('毎週の架空タスク',base,'weekly')]));
    assert.equal(plan.rows[0].registeredDue,expected);
    assert.equal((await f.importer.save(plan)).count,1);
    const draft=JSON.parse(f.map.get(STORAGE_KEY));
    complete(draft,plan.rows[0].item.id,new Date(today+'T12:00:00'));
    assert.equal(draft.items[0].due,following);
  }
});

test('warns on stored and batch duplicates by effective fields and invalidates old approval',async()=>{
  const initial=empty();
  initial.items.push(scheduledTask('old',' 一致 ','2027-02-18','weekly'),
    {id:'event',excluded:[],...dated('2027-02-18T10:00','2027-02-18T11:00','イベント','daily')});
  const f=await setup(initial);
  const rows=parse([task('一致','2027-02-17','daily'),task(' 一致 ','2027-02-18'),
    task('一致','2027-02-19'),dated('2027-02-18T10:00','2027-02-18T11:00','イベント'),
    dated('2027-02-19T10:00','2027-02-19T11:00','イベント')]);
  const first=f.importer.prepare(rows);
  assert.deepEqual(first.duplicates.map(group=>[
    group.candidates.map(row=>[row.index,row.repeat]),group.existing
  ]),[[[[0,'daily'],[1,'none']],[{id:'old',repeat:'weekly'}]],[[[3,'none']],[{id:'event',repeat:'daily'}]]]);
  assert.equal((await f.importer.save(first)).reason,'duplicates');
  assert.equal(f.importer.approveDuplicates(first),true);
  rows[0].input.title='変更';
  const revised=f.importer.prepare(rows);
  assert.equal((await f.importer.save(first)).reason,'stale');
  assert.equal(f.importer.approveDuplicates(first),false);
  assert.equal((await f.importer.save(revised)).reason,'duplicates');
  assert.equal(f.calls.mutations,0);
  assert.ok(f.importer.approveDuplicates(revised));
  assert.equal((await f.importer.save(revised)).count,5);
  assert.deepEqual(f.store.state.items.slice(0,2),initial.items);
});

test('rejects excess final counts and serialized size before writing',async()=>{
  const state=empty();
  state.items=Array.from({length:999},(_,i)=>scheduledTask('old-'+i));
  const count=await setup(state);
  const allowed=count.importer.prepare(parse([task()]));
  assert.deepEqual(allowed.errors,[]);
  const blocked=count.importer.prepare(parse([task('新規A'),task('新規B')]));
  assert.deepEqual(blocked.errors.map(error=>error.code),['capacity']);
  assert.equal((await count.importer.save(blocked)).reason,'validation');
  assert.equal(count.map.get(STORAGE_KEY),count.before);
  assert.equal((await count.importer.save(count.importer.prepare(parse([task()])))).count,1);
  assert.equal(count.store.state.items.length,1000);
  const large=empty();
  const historyEntry=i=>({id:'history-'+i,title:'X'.repeat(160),due:null,completedAt:'2026-01-01T00:00:00Z'});
  let size=serializeState(large).length;
  while(size+500<LIMITS.storageChars){
    const entry=historyEntry(large.history.length);
    size+=JSON.stringify(entry).length+Number(large.history.length>0);
    large.history.push(entry);
  }
  const capacity=await setup(large);
  const plan=capacity.importer.prepare(parse(Array.from({length:5},(_,i)=>task(String(i).repeat(160)))));
  assert.match(plan.errors[0].message,/保存容量の上限/);
  assert.equal((await capacity.importer.save(plan)).reason,'validation');
  assert.equal(capacity.map.get(STORAGE_KEY),capacity.before);
});

test('detects stale approval, a writer in the lock queue and a date change before commit',async()=>{
  const initial=empty();initial.items.push(scheduledTask('old','架空タスク'));
  const f=await setup(initial);
  const rows=parse([task(),task('別件')]);
  const plan=f.importer.prepare(rows);assert.ok(f.importer.approveDuplicates(plan));
  const external={...initial,items:[...initial.items,scheduledTask('newer','別タブの最新')]};
  f.hooks.beforeLock=()=>f.map.set(STORAGE_KEY,serializeState(external));
  const conflict=await f.importer.save(plan);
  assert.deepEqual([conflict.reason,conflict.reusable,conflict.recheck],['conflict',false,true]);
  assert.equal(f.importer.approveDuplicates(plan),false);
  assert.equal(f.map.get(STORAGE_KEY),serializeState(external));
  assert.deepEqual(f.calls.writes,[]);
  const fresh=f.importer.prepare(rows);
  const duplicate=await f.importer.save(fresh);
  assert.deepEqual([duplicate.reason,duplicate.reusable,duplicate.recheck],['duplicates',true,false]);
  assert.ok(f.importer.approveDuplicates(fresh));
  f.hooks.beforeLock=()=>f.setDay('2027-02-19');
  const date=await f.importer.save(fresh);
  assert.deepEqual([date.reason,date.reusable,date.recheck],['date',false,true]);
  assert.match(date.message,/日付/);
  assert.deepEqual(f.calls.writes,[]);
  const stale=f.importer.prepare(rows);
  f.map.set(STORAGE_KEY,f.before);await f.store.refresh();
  assert.equal((await f.importer.save(stale)).reason,'conflict');
  assert.equal(f.map.get(STORAGE_KEY),f.before);
});

test('a timezone-only change while waiting for the lock consumes the preview without saving',async()=>{
  const previous=process.env.TZ;
  try{
    process.env.TZ='Asia/Tokyo';
    const f=await setup();
    const rows=parse([task()]);
    const plan=f.importer.prepare(rows);
    assert.equal(plan.zone,'Asia/Tokyo');
    f.hooks.beforeLock=()=>{process.env.TZ='America/New_York';};
    const result=await f.importer.save(plan);
    assert.deepEqual([result.reason,result.committed,result.reusable,result.recheck],['date',false,false,true]);
    assert.deepEqual(f.calls.writes,[]);
    assert.equal(f.map.get(STORAGE_KEY),f.before);
    const revised=f.importer.prepare(rows);
    assert.equal(revised.day,plan.day);
    assert.equal(revised.zone,'America/New_York');
    assert.equal((await f.importer.save(revised)).count,1);
  }finally{
    if(previous===undefined)delete process.env.TZ;
    else process.env.TZ=previous;
  }
});

test('quota failure leaves zero additions; uncertain readback latches with all additions possibly written',async()=>{
  for(const mode of ['quota','failReadback']){
    const f=await setup();
    const plan=f.importer.prepare(parse([task('架空A'),task('架空B')]));
    f.hooks[mode]=true;
    const result=await f.importer.save(plan);
    assert.equal(result.ok,false);
    assert.equal(result.reusable,false);
    if(mode==='quota'){
      assert.equal(result.committed,false);
      assert.equal(result.recheck,true);
      assert.equal(f.map.get(STORAGE_KEY),f.before);
      assert.equal((await f.importer.save(plan)).reason,'stale');
    }else{
      assert.deepEqual([result.reason,result.committed,result.verified],['unverified',null,false]);
      assert.equal(result.recheck,false);
      assert.equal(f.store.status,'unverified');
      assert.deepEqual(JSON.parse(f.map.get(STORAGE_KEY)).items,plan.rows.map(row=>row.item));
      assert.equal(f.store.writable,false);
      const retry=await f.importer.save(plan);
      assert.deepEqual([retry.reason,retry.reusable,retry.recheck],['unverified',false,false]);
      const fresh=f.importer.prepare(parse([task('架空A'),task('架空B')]));
      assert.equal((await f.importer.save(fresh)).reason,'unverified');
    }
    assert.equal(f.calls.mutations,1);
    if(mode==='quota'){
      f.hooks.quota=false;
      assert.equal((await f.importer.save(f.importer.prepare(parse([task('架空A'),task('架空B')])))).count,2);
    }
  }
});

test('lock rejection consumes the preview, releases busy state and requires a fresh preview',async()=>{
  const f=await setup();
  const rows=parse([task()]);
  const plan=f.importer.prepare(rows);
  f.hooks.beforeLock=()=>{throw new DOMException('fictional lock rejection','AbortError');};
  const result=await f.importer.save(plan);
  assert.deepEqual([result.reason,result.committed,result.reusable,result.recheck],['blocked',false,false,true]);
  assert.equal(f.map.get(STORAGE_KEY),f.before);
  assert.deepEqual(f.calls.writes,[]);
  assert.equal(f.store.busy,false);
  assert.equal((await f.importer.save(plan)).reason,'stale');
  assert.equal(f.calls.mutations,1);
  delete f.hooks.beforeLock;
  assert.equal((await f.importer.save(f.importer.prepare(rows))).count,1);
});

test('one in-flight save and one successful consumption preserve existing notices and history for v1–v3',async()=>{
  for(const version of [1,2,3]){
    const initial={version,items:[{id:'saved-event',excluded:[],...dated('2027-02-18T11:00','2027-02-18T12:00')}],
      history:[{id:'history',title:'架空の完了履歴',due:null,completedAt:'2027-02-17T12:00:00Z'}]};
    const notifyAt='2027-02-18T02:00:00.000Z';
    if(version>=2)initial.items[0].notification={enabled:true,notifyAt};
    if(version===3)initial.notificationLink={version:1,mode:'review',legacyRemovals:[],records:[{
      itemId:'saved-event',generationId:null,operationId:null,status:'unverified',
      desired:{enabled:true,notifyAt,title:initial.items[0].title},
      pending:{operationId:'saved-op',generationId:'saved-generation',expectedGenerationId:null,operation:'upsert',
        title:initial.items[0].title,notifyAt,status:'suspended'},
    }]};
    const f=await setup(initial);
    const rows=parse([task(),dayEvent('2027-03-05','2027-03-05')]);
    const plan=f.importer.prepare(rows);
    assert.equal((await f.importer.save(structuredClone(plan))).reason,'stale');
    let unlock;
    f.hooks.beforeLock=()=>new Promise(resolve=>{unlock=resolve;});
    const save=f.importer.save(plan);
    assert.equal((await f.importer.save(plan)).reason,'busy');
    assert.throws(()=>f.importer.prepare(rows),/完了を待って/);
    assert.equal(f.map.get(STORAGE_KEY),f.before);
    unlock();
    const saved=await save;
    assert.deepEqual([saved.count,saved.committed,saved.reusable,saved.recheck],[2,true,false,false]);
    assert.equal((await f.importer.save(plan)).reason,'stale');
    assert.equal(f.calls.mutations,1);
    assert.deepEqual(f.store.state,{...initial,items:[...initial.items,...plan.rows.map(row=>row.item)]});
  }
});
